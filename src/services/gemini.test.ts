import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/core/settings';
import type { Session } from '@/core/session';
import { generateReport, testConnection } from './gemini';
import { ReportError } from './report-error';

/**
 * These tests stub `fetch`. The thing worth testing here is the translation either side
 * of the wire — what we send, and what we make of what comes back — and a stub is the
 * only way to exercise the failure branches at all: a 429 from the real API is not
 * something a test can ask for.
 */
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  provider: 'google',
  google: { apiKey: 'AIza-test', model: 'gemini-3.8-flash' },
  sendScreenshots: false,
};

function session(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    status: 'stopped',
    startedAt: 1_000,
    stoppedAt: 91_000,
    env: {
      url: 'https://app.test/orders',
      title: 'Orders',
      userAgent: 'Mozilla/5.0 Chrome/141.0.0.0',
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 2,
      recordedAt: '2026-09-23T08:00:00.000Z',
      extensionVersion: '0.1.0',
    },
    events: [],
    console: [{ t: 9_000, level: 'error', text: 'total is undefined' }],
    network: [],
    keyframes: [],
    trace: [],
    ...partial,
  };
}

/** A well-formed model answer, as the Interactions API delivers one. */
const MODEL_REPORT = {
  title: 'Submitting a prescription clears the total',
  summary: 'The tester submitted a prescription and the order total disappeared.',
  preconditions: ['Signed in, on the Orders page'],
  steps: [],
  expectedResult: 'The total should stay on screen.',
  actualResult: 'The total went blank and the console reported it as undefined.',
  severity: 'major',
  suspectedArea: 'The order total component',
  evidence: ['Console error at 0:08: total is undefined'],
};

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function completed(text: string, usage?: object): Response {
  return ok({
    model: 'gemini-3.8-flash',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: usage ?? { total_input_tokens: 1_200, total_output_tokens: 300, total_tokens: 1_500 },
  });
}

function failure(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The parsed body of the one request the stub received. */
function sentBody(): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[0]![1].body);
}

describe('generateReport', () => {
  it('sends the key as a header and the schema without its $schema key', async () => {
    fetchMock.mockResolvedValue(completed(JSON.stringify(MODEL_REPORT)));

    await generateReport(session(), settings);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1/interactions');
    expect(init.headers['x-goog-api-key']).toBe('AIza-test');
    // The key must not travel in the URL, where it would land in logs.
    expect(url).not.toContain('AIza-test');

    const body = sentBody();
    expect(body.model).toBe('gemini-3.8-flash');
    expect(body.system_instruction).toContain('bug reports');
    // Gemini takes a subset of JSON Schema that has no place for `$schema`.
    expect(body.response_format.schema).not.toHaveProperty('$schema');
    expect(body.response_format.schema.properties.severity.description).toContain('blocker');
  });

  it('grounds the model output and reports token usage', async () => {
    fetchMock.mockResolvedValue(completed(JSON.stringify(MODEL_REPORT)));

    const { report, usage } = await generateReport(session(), settings);

    expect(report.title).toBe('Submitting a prescription clears the total');
    expect(report.severity).toBe('major');
    // Grounding is not the provider's business, but it must still happen on this path:
    // with no tester note the expected result is replaced whatever the model wrote.
    expect(report.expectedResult).toContain('Not stated');
    expect(usage).toEqual({ inputTokens: 1_200, outputTokens: 300 });
  });

  it('sends captioned images only when screenshots are enabled', async () => {
    // A fresh Response per call: a body can only be read once, and this test calls twice.
    fetchMock.mockImplementation(() => Promise.resolve(completed(JSON.stringify(MODEL_REPORT))));
    const withFrame = session({
      keyframes: [{ t: 3_000, caption: 'after the click', blob: new Blob(['x'], { type: 'image/jpeg' }) }],
    });

    await generateReport(withFrame, { ...settings, sendScreenshots: true });

    const input = sentBody().input as { type: string; text?: string; mime_type?: string }[];
    expect(input[0]).toMatchObject({ type: 'text', text: 'Screen at 0:03 (after the click):' });
    expect(input[1]).toMatchObject({ type: 'image', mime_type: 'image/jpeg' });
    // The log goes last, so it reads as instructions about the images.
    expect(input.at(-1)!.type).toBe('text');

    fetchMock.mockClear();
    await generateReport(withFrame, { ...settings, sendScreenshots: false });
    expect(sentBody().input).toHaveLength(1);
  });

  it('refuses a recording with nothing in it before spending a request', async () => {
    const empty = session({ console: [], network: [], events: [] });

    await expect(generateReport(empty, settings)).rejects.toThrow(/nothing to write a report from/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for a key before spending a request', async () => {
    const noKey = { ...settings, google: { ...settings.google, apiKey: '  ' } };

    await expect(generateReport(session(), noKey)).rejects.toThrow(/No Gemini API key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('failures', () => {
    it('names the key when a 400 blames the key', async () => {
      fetchMock.mockResolvedValue(
        failure(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }),
      );

      await expect(generateReport(session(), settings)).rejects.toThrow(
        /That API key was rejected/,
      );
    });

    /** The same status code, a different cause — and a different thing for us to do. */
    it('keeps the detail when a 400 is our own malformed request', async () => {
      fetchMock.mockResolvedValue(
        failure(400, { error: { message: 'Invalid value at generation_config.thinking_level' } }),
      );

      await expect(generateReport(session(), settings)).rejects.toThrow(
        /rejected the request: Invalid value at generation_config/,
      );
    });

    it('says to wait on a 429', async () => {
      fetchMock.mockResolvedValue(failure(429, { error: { message: 'Quota exceeded' } }));
      await expect(generateReport(session(), settings)).rejects.toThrow(/Rate limited/);
    });

    it('points at the model id on a 404', async () => {
      fetchMock.mockResolvedValue(failure(404, { error: { message: 'models/x is not found' } }));
      await expect(generateReport(session(), settings)).rejects.toThrow(/Check the model id/);
    });

    it('survives an error body that is not JSON', async () => {
      fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
      await expect(generateReport(session(), settings)).rejects.toThrow(/API error 502/);
    });

    it('explains a truncated answer rather than the parse failure behind it', async () => {
      fetchMock.mockResolvedValue(
        ok({ status: 'incomplete', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"tit' }] }] }),
      );

      await expect(generateReport(session(), settings)).rejects.toThrow(/cut off before it was complete/);
    });

    it('reports a refusal with the reason the API gave', async () => {
      fetchMock.mockResolvedValue(
        ok({ status: 'failed', errors: [{ message: 'blocked by a safety setting' }] }),
      );

      await expect(generateReport(session(), settings)).rejects.toThrow(
        /could not write a report.*blocked by a safety setting/s,
      );
    });

    it('rejects a completed answer that does not fit the report shape', async () => {
      fetchMock.mockResolvedValue(completed(JSON.stringify({ title: 'only a title' })));

      await expect(generateReport(session(), settings)).rejects.toThrow(
        /did not match the report format/,
      );
    });

    it('turns a network failure into something a tester can act on', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      const error = await generateReport(session(), settings).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReportError);
      expect((error as Error).message).toMatch(/host permission/);
    });
  });
});

describe('testConnection', () => {
  it('reports the model and the tokens it cost', async () => {
    fetchMock.mockResolvedValue(completed('ready'));

    await expect(testConnection(settings)).resolves.toBe(
      'Reached the API as gemini-3.8-flash (1500 tokens).',
    );
  });

  /**
   * Success is having been answered at all. A check that failed because the model said
   * "Ready!" instead of "ready" would report a broken transport that is working.
   */
  it('does not depend on what the model actually said', async () => {
    fetchMock.mockResolvedValue(completed('Sure — ready when you are.'));
    await expect(testConnection(settings)).resolves.toMatch(/Reached the API/);
  });

  it('sends no schema and a small budget', async () => {
    fetchMock.mockResolvedValue(completed('ready'));

    await testConnection(settings);

    const body = sentBody();
    expect(body).not.toHaveProperty('response_format');
    expect(body.generation_config.max_output_tokens).toBe(512);
    expect(body.generation_config.thinking_level).toBe('minimal');
  });
});
