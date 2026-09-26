import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_LIMIT_BYTES,
  exportToJira,
  formatBytes,
  JiraError,
  normaliseBaseUrl,
  oversized,
  planAttachments,
  testJiraConnection,
} from './jira';
import { DEFAULT_JIRA, type JiraSettings } from '@/core/settings';
import type { Session } from '@/core/session';

const JIRA: JiraSettings = {
  ...DEFAULT_JIRA,
  baseUrl: 'https://team.atlassian.net',
  email: 'qa@team.test',
  apiToken: 'token-123',
  projectKey: 'QA',
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
    events: [{ t: 1_200, type: 'click', label: "the 'Orders' link" }],
    console: [],
    network: [],
    keyframes: [],
    trace: [],
    ...partial,
  };
}

function blob(size: number, type: string): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

/** A `fetch` that answers each call from a queued list of responses. */
function mockFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('normaliseBaseUrl', () => {
  /** People paste the page they were looking at, not the site root. */
  it.each([
    ['https://team.atlassian.net', 'https://team.atlassian.net'],
    ['https://team.atlassian.net/', 'https://team.atlassian.net'],
    ['team.atlassian.net', 'https://team.atlassian.net'],
    ['  https://team.atlassian.net/jira/software/projects/QA/boards/1  ', 'https://team.atlassian.net'],
    ['https://team.atlassian.net/browse/QA-14', 'https://team.atlassian.net'],
  ])('reduces %s to the site origin', (input, expected) => {
    expect(normaliseBaseUrl(input)).toBe(expected);
  });

  it('names the empty field rather than failing later with a 404', () => {
    expect(() => normaliseBaseUrl('   ')).toThrow(JiraError);
    expect(() => normaliseBaseUrl('   ')).toThrow(/No Jira site URL/);
  });

  it('rejects something that is not a URL at all', () => {
    expect(() => normaliseBaseUrl('http://')).toThrow(/not a valid Jira site URL/);
  });
});

describe('planAttachments', () => {
  const recorded = session({
    video: blob(2048, 'video/webm'),
    keyframes: [
      { t: 1_200, blob: blob(128, 'image/jpeg'), caption: 'clicked Orders' },
      { t: 65_000, blob: blob(128, 'image/jpeg'), caption: 'applied discount' },
    ],
  });

  it('plans the video and every screenshot, named by their offsets', () => {
    const planned = planAttachments(recorded, JIRA);
    expect(planned.map((file) => file.name)).toEqual([
      'recording-s1.webm',
      'screen-01-0m01s.jpg',
      'screen-02-1m05s.jpg',
    ]);
  });

  it('honours each toggle independently', () => {
    expect(planAttachments(recorded, { ...JIRA, attachVideo: false })).toHaveLength(2);
    expect(planAttachments(recorded, { ...JIRA, attachScreenshots: false })).toHaveLength(1);
    expect(
      planAttachments(recorded, { ...JIRA, attachVideo: false, attachScreenshots: false }),
    ).toHaveLength(0);
  });

  /**
   * A session written by an older build can hold `{}` where a Blob belongs, and a
   * zero-byte video is a failed recording rather than evidence.
   */
  it('skips a video that is absent, empty, or not a Blob', () => {
    expect(planAttachments(session({ video: blob(0, 'video/webm') }), JIRA)).toHaveLength(0);
    expect(planAttachments(session({ video: {} as Blob }), JIRA)).toHaveLength(0);
    expect(planAttachments(session(), JIRA)).toHaveLength(0);
  });
});

describe('oversized', () => {
  it('reports only the files past Jira’s default limit', () => {
    const files = planAttachments(
      session({
        video: blob(ATTACHMENT_LIMIT_BYTES + 1, 'video/webm'),
        keyframes: [{ t: 0, blob: blob(64, 'image/jpeg'), caption: 'start' }],
      }),
      JIRA,
    );
    expect(oversized(files).map((file) => file.kind)).toEqual(['video']);
  });
});

describe('exportToJira', () => {
  it('creates the issue with wiki markup, then uploads each file separately', async () => {
    const calls = mockFetch([
      json({ key: 'QA-14', id: '1' }, 201),
      json([{ id: '9' }], 200),
      json([{ id: '10' }], 200),
    ]);

    const result = await exportToJira(
      session({
        video: blob(2048, 'video/webm'),
        keyframes: [{ t: 1_200, blob: blob(128, 'image/jpeg'), caption: 'clicked Orders' }],
      }),
      JIRA,
    );

    expect(result.key).toBe('QA-14');
    expect(result.url).toBe('https://team.atlassian.net/browse/QA-14');
    expect(result.attachments.every((file) => file.ok)).toBe(true);

    expect(calls[0]?.url).toBe('https://team.atlassian.net/rest/api/2/issue');
    const created = JSON.parse(calls[0]?.init.body as string);
    expect(created.fields.project.key).toBe('QA');
    expect(created.fields.issuetype.name).toBe('Bug');
    expect(created.fields.description).toContain('h2. Steps to reproduce');
    // The attachments are named in the description, so they must be planned first.
    expect(created.fields.description).toContain('recording-s1.webm');

    // One request per file, not one multipart body for all of them.
    expect(calls[1]?.url).toBe('https://team.atlassian.net/rest/api/2/issue/QA-14/attachments');
    expect(calls).toHaveLength(3);
  });

  it('sends Basic auth and the XSRF header Jira requires for uploads', async () => {
    const calls = mockFetch([json({ key: 'QA-14' }, 201), json([{ id: '9' }])]);
    await exportToJira(session({ video: blob(16, 'video/webm') }), JIRA);

    const auth = (calls[0]?.init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${btoa('qa@team.test:token-123')}`);

    const upload = calls[1]?.init.headers as Record<string, string>;
    expect(upload['X-Atlassian-Token']).toBe('no-check');
    // `fetch` must set Content-Type itself — the multipart boundary is part of the value.
    expect(upload['Content-Type']).toBeUndefined();
  });

  /**
   * The issue exists by the time attachments run. Throwing here would tell the tester
   * the export failed while a real ticket sits in the project.
   */
  it('returns attachment failures instead of throwing, and keeps going', async () => {
    mockFetch([
      json({ key: 'QA-14' }, 201),
      json({ errorMessages: ['The file is too large.'] }, 413),
      json([{ id: '10' }], 200),
    ]);

    const result = await exportToJira(
      session({
        video: blob(ATTACHMENT_LIMIT_BYTES + 1, 'video/webm'),
        keyframes: [{ t: 0, blob: blob(64, 'image/jpeg'), caption: 'start' }],
      }),
      JIRA,
    );

    expect(result.key).toBe('QA-14');
    expect(result.attachments[0]).toMatchObject({ ok: false });
    expect(result.attachments[0]?.error).toMatch(/Jira's default limit is 10 MB/);
    // The oversized video must not take the screenshot with it.
    expect(result.attachments[1]?.ok).toBe(true);
  });

  it('explains a rejected token rather than reporting a bare 401', async () => {
    mockFetch([json({ errorMessages: [] }, 401)]);
    await expect(exportToJira(session(), JIRA)).rejects.toThrow(/Check the email and API token/);
  });

  it('surfaces the field-level detail Jira puts in a 400', async () => {
    mockFetch([json({ errorMessages: [], errors: { issuetype: 'Specify an issue type' } }, 400)]);
    await expect(exportToJira(session(), JIRA)).rejects.toThrow(/issuetype: Specify an issue type/);
  });

  it('points at the site URL when the transport itself fails', async () => {
    mockFetch([new TypeError('Failed to fetch')]);
    await expect(exportToJira(session(), JIRA)).rejects.toThrow(
      /Could not reach https:\/\/team\.atlassian\.net/,
    );
  });

  it('refuses before any request when the credentials are incomplete', async () => {
    const calls = mockFetch([]);
    await expect(exportToJira(session(), { ...JIRA, apiToken: '  ' })).rejects.toThrow(
      /email and API token/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('testJiraConnection', () => {
  it('checks the credentials and the project, and names both', async () => {
    const calls = mockFetch([
      json({ displayName: 'Jane Tester' }),
      json({ key: 'QA', name: 'QA Sandbox' }),
    ]);

    await expect(testJiraConnection(JIRA)).resolves.toBe(
      'Signed in as Jane Tester — QA Sandbox (QA) is reachable.',
    );
    expect(calls[0]?.url).toContain('/rest/api/2/myself');
    expect(calls[1]?.url).toContain('/rest/api/2/project/QA');
  });

  /** A valid token against a project the tester cannot see is the likelier mistake. */
  it('distinguishes a bad project key from bad credentials', async () => {
    mockFetch([json({ displayName: 'Jane Tester' }), json({ errorMessages: ['No project.'] }, 404)]);
    await expect(testJiraConnection(JIRA)).rejects.toThrow(
      /Signed in as Jane Tester, but project QA could not be read/,
    );
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [10 * 1024 * 1024, '10 MB'],
    [9.5 * 1024 * 1024, '9.5 MB'],
    [42 * 1024 * 1024, '42 MB'],
  ])('renders %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
