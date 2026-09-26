/**
 * Report generation: the one place this extension talks to the Anthropic API.
 *
 * ## Why this runs in the review page and not the service worker
 *
 * The roadmap planned this call for the service worker. It is not there, for the reason
 * this project already lost a day to: MV3 terminates the worker after roughly 30 seconds
 * idle, and an Opus request with adaptive thinking can run longer than that. Chrome does
 * extend a worker's life for in-flight requests, but "usually survives" is a poor
 * foundation for the one call that costs money and cannot be safely retried blind.
 *
 * The review page has no such limit. It is a normal document, it is open because the
 * tester just clicked the button in it, and it shares this extension's origin — so the
 * `api.anthropic.com` host permission still bypasses CORS, which was the part of the
 * spike that actually needed proving. Nothing is gained by routing it through the worker
 * and a message round-trip; a closed tab is a visible failure, a dead worker is not.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Session } from '@/core/session';
import type { Settings } from '@/core/settings';
import { toSteps } from './markdown';
import { ReportError, type GeneratedReport } from './report-error';
import { toInlineImages, type InlineImage } from './report-images';
import { buildLog, chooseKeyframes, SYSTEM_PROMPT } from './report-prompt';
import { groundReport, ModelReportSchema } from './report-schema';

/**
 * Room for the answer plus the thinking that precedes it.
 *
 * A report is well under 2k tokens; the headroom is for adaptive thinking, which counts
 * against this ceiling. Hitting the cap truncates mid-JSON and wastes the whole call, so
 * the limit is set where that cannot happen rather than where it is merely unlikely.
 */
const MAX_TOKENS = 16_000;

/**
 * Write a report for a recorded session.
 *
 * Throws `ReportError` with a message fit to show a tester. Everything the model returns
 * passes through `groundReport` before it becomes a `BugReport` — see `report-schema.ts`
 * for what that guarantees.
 */
export async function generateReport(
  session: Session,
  settings: Settings,
): Promise<GeneratedReport> {
  const { apiKey, model } = settings.anthropic;
  const key = apiKey.trim();
  if (!key) throw new ReportError('No Anthropic API key set. Add one in Settings.');

  const steps = toSteps(session.events);
  if (steps.length === 0 && session.console.length === 0 && session.network.length === 0) {
    throw new ReportError(
      'This recording captured no interactions, console output or failed requests, ' +
        'so there is nothing to write a report from.',
    );
  }

  const images = settings.sendScreenshots
    ? toImageBlocks(await toInlineImages(chooseKeyframes(session.keyframes)))
    : [];

  try {
    const response = await client(key).messages.parse({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // Deciding which steps matter and whether the evidence supports a cause is
      // judgement, not extraction — the work this is for.
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: zodOutputFormat(ModelReportSchema),
      },
      messages: [
        {
          role: 'user',
          content: [
            // Images before the text, so the log reads as instructions about them
            // rather than the images arriving as an afterthought.
            ...images,
            { type: 'text', text: buildLog(session, steps) },
          ],
        },
      ],
    });

    // A refusal arrives as a 200 with no usable content, so it has to be checked
    // before reading the output rather than caught as an error.
    if (response.stop_reason === 'refusal') {
      throw new ReportError(
        'Claude declined to write a report for this recording' +
          `${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`,
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new ReportError(
        'The response was cut off before it was complete. Try again, or record a ' +
          'shorter session.',
      );
    }
    if (!response.parsed_output) {
      throw new ReportError('Claude returned a response that did not match the report format.');
    }

    return {
      report: { ...groundReport(response.parsed_output, { steps, session }), writtenBy: 'Claude' },
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  } catch (error) {
    throw asReportError(error);
  }
}

/**
 * The smallest real request that proves the transport works.
 *
 * The roadmap asked for this as a day-one spike: confirm an extension page can reach
 * `api.anthropic.com` with the host permission standing in for CORS. It stayed in the
 * product as a Settings button, because the question it answers — "is the key right and
 * can we get out?" — is the one a tester has when generation fails, and a 20-token call
 * answers it without spending a report.
 */
export async function testConnection(settings: Settings): Promise<string> {
  const { apiKey, model } = settings.anthropic;
  const key = apiKey.trim();
  if (!key) throw new ReportError('No Anthropic API key set.');

  try {
    const response = await client(key).messages.create({
      model,
      // Not 16. Thinking tokens count against this ceiling, so a tight budget can be
      // spent entirely on thinking and return empty text — a transport check that
      // reports failure when the transport is fine is worse than no check.
      max_tokens: 512,
      output_config: { effort: 'low' }, // nothing here is worth thinking hard about
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    });

    // Success is having reached the API and been answered. The reply's wording is not
    // the thing under test, so nothing here depends on it.
    const tokens = response.usage.input_tokens + response.usage.output_tokens;
    return `Reached the API as ${response.model} (${tokens} tokens).`;
  } catch (error) {
    throw asReportError(error);
  }
}

function client(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    // The flag guards against shipping a developer's key to end users' browsers. That
    // is not the shape here: the key is the tester's own, they typed it into their own
    // machine, and it is read back from that machine's extension storage. There is no
    // server in this product to move the call to, and adding one to host other people's
    // keys would be strictly worse for them.
    dangerouslyAllowBrowser: true,
  });
}

/**
 * Map an SDK failure to something a tester can act on.
 *
 * Most specific first: the distinction that matters is whether to fix the key, wait, or
 * report a bug in the extension, and a single `APIError` branch answers none of those.
 */
function asReportError(error: unknown): ReportError {
  if (error instanceof ReportError) return error;

  if (error instanceof Anthropic.AuthenticationError) {
    return new ReportError('That API key was rejected. Check it in Settings.');
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ReportError('That key is not allowed to use this model.');
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ReportError(
      'The model was not found. Check the model id in Settings.',
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ReportError('Rate limited by the API. Wait a moment and try again.');
  }
  if (error instanceof Anthropic.BadRequestError) {
    // Usually ours to fix, not the tester's — so it says so, and keeps the detail.
    return new ReportError(`The API rejected the request: ${error.message}`);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ReportError(
      'Could not reach api.anthropic.com. Check the connection; if the network is ' +
        'fine, the extension may be missing its host permission.',
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new ReportError(`API error ${error.status ?? ''}: ${error.message}`.trim());
  }
  return new ReportError(error instanceof Error ? error.message : String(error));
}

/** The shared inline images, in the shape the Anthropic SDK takes. */
function toImageBlocks(images: InlineImage[]): Anthropic.ContentBlockParam[] {
  return images.flatMap((image) => [
    { type: 'text', text: image.caption },
    {
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
    },
  ]);
}
