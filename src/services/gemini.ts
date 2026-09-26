/**
 * Report generation through the Gemini API.
 *
 * The second provider, and for most testers the first one they can actually use: a
 * Claude Pro or Gemini Pro subscription buys the chat app, not API access, but Google
 * issues a free-tier key from AI Studio. Neither provider is privileged in the code —
 * `ai.ts` picks between them and both answer in `ReportError` and `GeneratedReport`.
 *
 * ## Written against the REST API, not the SDK
 *
 * `@google/genai` would add a dependency to a bundle whose review chunk is already the
 * largest thing this extension ships, to build one request. The call here is a `fetch`
 * with a header and a JSON body, and the response is read in two places. The SDK's
 * value is in the streaming, tool-calling and file-upload surfaces this does not touch.
 *
 * Like the Anthropic call, this runs in the review page rather than the service worker
 * — see the comment at the top of `claude.ts` for why.
 */
import type { Session } from '@/core/session';
import type { Settings } from '@/core/settings';
import { z } from 'zod';
import { toSteps } from './markdown';
import { ReportError, type GeneratedReport } from './report-error';
import { toInlineImages, type InlineImage } from './report-images';
import { buildLog, chooseKeyframes, SYSTEM_PROMPT } from './report-prompt';
import { groundReport, ModelReportSchema } from './report-schema';

/**
 * The Interactions API, on `v1` rather than `v1beta`.
 *
 * Both serve this endpoint; `v1beta` carries the experimental surfaces and can change
 * under a shipped extension, which is the opposite of what the one call that writes the
 * report needs. Nothing here is outside the generally available set.
 */
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1/interactions';

/** Room for the answer plus the thinking that precedes it — see `claude.ts`. */
const MAX_TOKENS = 16_000;

/**
 * Write a report for a recorded session.
 *
 * Throws `ReportError` with a message fit to show a tester. Everything the model returns
 * passes through `groundReport` before it becomes a `BugReport` — see `report-schema.ts`
 * for what that guarantees, and note that it guarantees it identically for both
 * providers, because neither one is trusted with the numbering.
 */
export async function generateReport(
  session: Session,
  settings: Settings,
): Promise<GeneratedReport> {
  const { apiKey, model } = settings.google;
  const key = apiKey.trim();
  if (!key) throw new ReportError('No Gemini API key set. Add one in Settings.');

  const steps = toSteps(session.events);
  if (steps.length === 0 && session.console.length === 0 && session.network.length === 0) {
    throw new ReportError(
      'This recording captured no interactions, console output or failed requests, ' +
        'so there is nothing to write a report from.',
    );
  }

  const images = settings.sendScreenshots
    ? toInputImages(await toInlineImages(chooseKeyframes(session.keyframes)))
    : [];

  const body = await call(key, {
    model,
    system_instruction: SYSTEM_PROMPT,
    input: [
      // Images before the text, so the log reads as instructions about them rather
      // than the images arriving as an afterthought.
      ...images,
      { type: 'text', text: buildLog(session, steps) },
    ],
    generation_config: {
      max_output_tokens: MAX_TOKENS,
      // Deciding which steps matter and whether the evidence supports a cause is
      // judgement, not extraction — the work this is for.
      thinking_level: 'high',
    },
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: reportSchema(),
    },
  });

  if (body.status !== 'completed') {
    throw new ReportError(incompleteMessage(body));
  }

  const text = outputText(body);
  if (!text) {
    throw new ReportError('Gemini returned an empty response. Try again.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Structured output makes this unlikely rather than impossible, and a JSON parse
    // error thrown raw names a column number the tester cannot act on.
    throw new ReportError('Gemini returned a response that was not valid JSON.');
  }

  const report = ModelReportSchema.safeParse(parsed);
  if (!report.success) {
    throw new ReportError('Gemini returned a response that did not match the report format.');
  }

  return {
    report: { ...groundReport(report.data, { steps, session }), writtenBy: 'Gemini' },
    usage: {
      inputTokens: body.usage?.total_input_tokens ?? 0,
      outputTokens: body.usage?.total_output_tokens ?? 0,
    },
  };
}

/**
 * The smallest real request that proves the transport works.
 *
 * Answers the question a tester has when generation fails — "is the key right and can
 * we get out?" — without spending a report. Cheap enough on the free tier to be free.
 */
export async function testConnection(settings: Settings): Promise<string> {
  const { apiKey, model } = settings.google;
  const key = apiKey.trim();
  if (!key) throw new ReportError('No Gemini API key set.');

  const body = await call(key, {
    model,
    input: 'Reply with the single word: ready',
    generation_config: {
      // Not 16. Thinking tokens count against this ceiling, so a tight budget can be
      // spent entirely on thinking and return empty text — a transport check that
      // reports failure when the transport is fine is worse than no check.
      max_output_tokens: 512,
      thinking_level: 'minimal', // nothing here is worth thinking hard about
    },
  });

  // Success is having reached the API and been answered. The reply's wording is not
  // the thing under test, so nothing here depends on it.
  const tokens = body.usage?.total_tokens ?? 0;
  return `Reached the API as ${body.model ?? model} (${tokens} tokens).`;
}

/** POST to the Interactions API, turning every failure into a `ReportError`. */
async function call(apiKey: string, request: object): Promise<Interaction> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The key goes in a header, not the `?key=` query parameter Google's older
        // examples use: query strings are the part of a URL that ends up in logs.
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    throw new ReportError(
      'Could not reach generativelanguage.googleapis.com. Check the connection; if ' +
        'the network is fine, the extension may be missing its host permission. ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!response.ok) throw await httpError(response);

  try {
    return (await response.json()) as Interaction;
  } catch {
    throw new ReportError('The Gemini API returned a response that was not JSON.');
  }
}

/**
 * Map an HTTP failure to something a tester can act on.
 *
 * The distinction that matters is whether to fix the key, wait, or report a bug in the
 * extension. Google's status codes are not quite the obvious ones — a bad key is a 400
 * `INVALID_ARGUMENT`, not a 401 — so the message is chosen on the code and the body
 * together rather than the code alone.
 */
async function httpError(response: Response): Promise<ReportError> {
  const detail = await errorMessage(response);

  switch (response.status) {
    case 400:
      // A rejected key arrives here, alongside genuinely malformed requests.
      return /api[_ ]?key/i.test(detail)
        ? new ReportError('That API key was rejected. Check it in Settings.')
        : new ReportError(`The API rejected the request: ${detail}`);
    case 401:
    case 403:
      return new ReportError(
        'That API key was rejected, or it is not allowed to use this model. Check ' +
          `both in Settings. (${detail})`,
      );
    case 404:
      return new ReportError(`The model was not found. Check the model id in Settings. (${detail})`);
    case 429:
      return new ReportError(
        'Rate limited by the API — the free tier has per-minute and per-day limits. ' +
          'Wait a moment and try again.',
      );
    case 503:
      return new ReportError('The model is overloaded right now. Try again in a moment.');
    default:
      return new ReportError(`API error ${response.status}: ${detail}`);
  }
}

/** The human-readable half of Google's error envelope, or the raw body if it has none. */
async function errorMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    return parsed.error?.message ?? raw.slice(0, 300);
  } catch {
    return raw.slice(0, 300) || response.statusText;
  }
}

/** Why a request that returned 200 still has no report in it. */
function incompleteMessage(body: Interaction): string {
  const detail = body.errors?.map((error) => error.message).filter(Boolean).join('; ');

  if (body.status === 'incomplete') {
    return (
      'The response was cut off before it was complete. Try again, or record a ' +
      'shorter session.'
    );
  }
  if (body.status === 'failed') {
    return `Gemini could not write a report for this recording${detail ? `: ${detail}` : '.'}`;
  }
  return `Gemini returned an unfinished response (${body.status ?? 'unknown status'}).`;
}

/** The assistant's text, gathered from the model's own steps. */
function outputText(body: Interaction): string {
  return (body.steps ?? [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

/** The shared inline images, in the shape the Interactions API takes. */
function toInputImages(images: InlineImage[]): object[] {
  return images.flatMap((image) => [
    { type: 'text', text: image.caption },
    { type: 'image', data: image.base64, mime_type: image.mediaType },
  ]);
}

/**
 * `ModelReportSchema` as JSON Schema, which is how Gemini takes a response format.
 *
 * Derived from the same Zod schema the Anthropic path passes to `zodOutputFormat`, so
 * the field descriptions — the per-field half of the prompt — reach both models
 * identically and cannot drift apart. `$schema` is dropped because Gemini accepts a
 * subset of JSON Schema that does not include it; everything else this schema uses
 * (objects, arrays, strings, numbers, `required`, `description`) is in that subset.
 */
function reportSchema(): object {
  const { $schema, ...schema } = z.toJSONSchema(ModelReportSchema) as Record<string, unknown>;
  void $schema;
  return schema;
}

/** The fields of an Interactions response this code reads. */
interface Interaction {
  model?: string;
  status?: string;
  steps?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_tokens?: number;
  };
  errors?: { message?: string }[];
}
