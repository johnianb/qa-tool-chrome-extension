/**
 * Jira Cloud export: create the issue, then attach the evidence.
 *
 * ## Why REST v2
 *
 * v3's `description` is Atlassian Document Format — a JSON document tree. Writing and
 * maintaining an ADF serialiser would buy nothing here: v2 is not deprecated for Jira
 * Cloud, it accepts a wiki-markup string, and Atlassian converts it to ADF on the way
 * in. See `jira-markup.ts` for the renderer.
 *
 * ## Why this runs in the review page
 *
 * Same reason as `claude.ts`: a multi-megabyte attachment upload can outlive the MV3
 * service worker's ~30s idle timeout, and the review page has no such limit. The
 * `https://*.atlassian.net/*` host permission means an extension page's `fetch` is not
 * subject to CORS, which is what makes a browser-side Jira client possible at all —
 * Jira's own CORS policy would otherwise refuse it.
 */
import { formatOffset, type Session } from '@/core/session';
import type { JiraSettings } from '@/core/settings';
import { issueDescription, issueSummary } from './jira-markup';

/**
 * Jira Cloud's default per-file attachment limit.
 *
 * A site admin can raise it, and there is no API that reports the configured value — so
 * this is used to *warn*, never to block. A tester whose admin raised the limit should
 * not be stopped by our constant, and finding out from Jira's own rejection is a clear
 * enough failure.
 */
export const ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;

/** A file to attach, resolved before the issue is created so it can be named in the text. */
export interface PlannedAttachment {
  name: string;
  blob: Blob;
  kind: 'video' | 'screenshot';
}

export interface AttachmentResult {
  name: string;
  size: number;
  ok: boolean;
  /** Why it failed, fit to show a tester. */
  error?: string;
}

/** What the export is doing right now, for a button that must not just say "Working…". */
export type ExportStage =
  | { kind: 'creating' }
  | { kind: 'attaching'; index: number; total: number; name: string };

export interface ExportOptions {
  /** Defaults to `planAttachments`. Passed explicitly when the video has been trimmed. */
  attachments?: PlannedAttachment[];
  onStage?: (stage: ExportStage) => void;
}

export interface ExportResult {
  key: string;
  /** The human URL, for the link shown after export. */
  url: string;
  attachments: AttachmentResult[];
}

/** A failure worth showing a tester verbatim. */
export class JiraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraError';
  }
}

/**
 * Reduce whatever was pasted into the field to a site origin.
 *
 * People paste the URL they were looking at — a board, a backlog, an issue — not the
 * site root, and `https://team.atlassian.net/jira/software/projects/QA/boards/1` plus
 * `/rest/api/2/issue` is a 404 whose message explains nothing. Taking the origin makes
 * every one of those work.
 */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new JiraError('No Jira site URL set. Add one in Settings.');
  try {
    // A bare `team.atlassian.net` has no scheme and would parse as a relative URL.
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.origin;
  } catch {
    throw new JiraError(`"${raw}" is not a valid Jira site URL.`);
  }
}

/**
 * Which files go up with the issue.
 *
 * Resolved before the issue is created because `issueDescription` names them: an
 * attachment with no mention in the description is easy to miss, since Jira renders the
 * strip below the fold.
 */
export function planAttachments(session: Session, jira: JiraSettings): PlannedAttachment[] {
  const planned: PlannedAttachment[] = [];

  if (jira.attachVideo && session.video instanceof Blob && session.video.size > 0) {
    planned.push({
      name: `recording-${session.id}.webm`,
      blob: session.video,
      kind: 'video',
    });
  }

  if (jira.attachScreenshots) {
    session.keyframes.forEach((frame, index) => {
      if (!(frame.blob instanceof Blob) || frame.blob.size === 0) return;
      planned.push({
        // The offset is in the filename so an attachment strip of eight thumbnails is
        // still readable as a timeline.
        name: `screen-${String(index + 1).padStart(2, '0')}-${formatOffset(frame.t).replace(':', 'm')}s.jpg`,
        blob: frame.blob,
        kind: 'screenshot',
      });
    });
  }

  return planned;
}

/** Files Jira will probably refuse, for the warning shown before upload. */
export function oversized(attachments: PlannedAttachment[]): PlannedAttachment[] {
  return attachments.filter((file) => file.blob.size > ATTACHMENT_LIMIT_BYTES);
}

/**
 * Create the issue and attach the evidence.
 *
 * The issue is created first and attachments are uploaded after, one request each.
 * Attachment failures are returned, not thrown: by then the issue exists, and throwing
 * would leave the tester believing the export failed while a real ticket sits in the
 * project. A 40 MB video that Jira refuses must not take the six screenshots with it
 * either, which is why each file is its own request rather than one multipart body.
 */
export async function exportToJira(
  session: Session,
  jira: JiraSettings,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const base = normaliseBaseUrl(jira.baseUrl);
  requireCredentials(jira);

  const attachments = options.attachments ?? planAttachments(session, jira);
  options.onStage?.({ kind: 'creating' });

  const created = await request<{ key?: string }>(base, jira, 'POST', '/rest/api/2/issue', {
    body: JSON.stringify({
      fields: {
        project: { key: jira.projectKey.trim() },
        issuetype: { name: jira.issueType.trim() || 'Bug' },
        summary: issueSummary(session),
        description: issueDescription(session, {
          attachments: attachments.map((file) => file.name),
        }),
      },
    }),
    headers: { 'Content-Type': 'application/json' },
  });

  if (!created.key) {
    throw new JiraError('Jira accepted the issue but returned no issue key.');
  }

  const results: AttachmentResult[] = [];
  for (const [index, file] of attachments.entries()) {
    options.onStage?.({
      kind: 'attaching',
      index: index + 1,
      total: attachments.length,
      name: file.name,
    });
    results.push(await attach(base, jira, created.key, file));
  }

  return { key: created.key, url: `${base}/browse/${created.key}`, attachments: results };
}

/** Upload one file. Never throws — the caller needs the other files' outcomes. */
async function attach(
  base: string,
  jira: JiraSettings,
  issueKey: string,
  file: PlannedAttachment,
): Promise<AttachmentResult> {
  const form = new FormData();
  form.append('file', file.blob, file.name);

  try {
    await request(base, jira, 'POST', `/rest/api/2/issue/${issueKey}/attachments`, {
      body: form,
      headers: {
        // Jira's XSRF check rejects any attachment upload without this header. It is not
        // a token — the literal string `no-check` is what the API expects.
        'X-Atlassian-Token': 'no-check',
        // Content-Type is deliberately unset: `fetch` must generate it, because the
        // multipart boundary is part of the value and a hand-written header omits it.
      },
    });
    return { name: file.name, size: file.blob.size, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: file.name,
      size: file.blob.size,
      ok: false,
      error:
        file.blob.size > ATTACHMENT_LIMIT_BYTES
          ? `${message} The file is ${formatBytes(file.blob.size)}; Jira's default limit is ${formatBytes(ATTACHMENT_LIMIT_BYTES)}.`
          : message,
    };
  }
}

/**
 * Check the credentials and the project, without creating anything.
 *
 * Two calls rather than one. `/myself` proves the site, email and token; it says nothing
 * about whether the project key exists or the token's owner can see it, which is the
 * other half of what makes an export fail — and the half a tester is more likely to have
 * got wrong.
 */
export async function testJiraConnection(jira: JiraSettings): Promise<string> {
  const base = normaliseBaseUrl(jira.baseUrl);
  requireCredentials(jira);

  const me = await request<{ displayName?: string; emailAddress?: string }>(
    base,
    jira,
    'GET',
    '/rest/api/2/myself',
  );

  const key = jira.projectKey.trim();
  const project = await request<{ name?: string; key?: string }>(
    base,
    jira,
    'GET',
    `/rest/api/2/project/${encodeURIComponent(key)}`,
  ).catch((error: unknown) => {
    throw new JiraError(
      `Signed in as ${me.displayName ?? jira.email}, but project ${key} could not be read. ` +
        (error instanceof Error ? error.message : String(error)),
    );
  });

  return `Signed in as ${me.displayName ?? jira.email} — ${project.name ?? key} (${project.key ?? key}) is reachable.`;
}

function requireCredentials(jira: JiraSettings): void {
  if (!jira.email.trim() || !jira.apiToken.trim()) {
    throw new JiraError('Jira email and API token are both required. Add them in Settings.');
  }
  if (!jira.projectKey.trim()) {
    throw new JiraError('No Jira project key set. Add one in Settings.');
  }
}

/** One authenticated call, with Jira's error bodies turned into readable messages. */
async function request<T>(
  base: string,
  jira: JiraSettings,
  method: 'GET' | 'POST',
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      body: init.body,
      headers: {
        Authorization: basicAuth(jira.email, jira.apiToken),
        Accept: 'application/json',
        ...init.headers,
      },
    });
  } catch (error) {
    // `fetch` rejects only on transport failure; every HTTP status resolves.
    throw new JiraError(
      `Could not reach ${base}. Check the site URL and the connection. ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!response.ok) throw await asJiraError(response, base, jira);

  // 204 on some endpoints, and an empty body is not valid JSON.
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new JiraError(
      `${base} returned a response that was not JSON. If that URL opens a login page in ` +
        'the browser, it is not a Jira site root.',
    );
  }
}

/**
 * Map a Jira failure to something a tester can act on.
 *
 * Jira reports field-level problems in `errors` and everything else in `errorMessages`,
 * and an unrecognised field name — the commonest cause of a 400 here — appears only in
 * the former. Both are surfaced; a bare "400 Bad Request" would send someone to the
 * network tab to find what this function already has in hand.
 */
async function asJiraError(response: Response, base: string, jira: JiraSettings): Promise<JiraError> {
  const detail = await jiraErrorDetail(response);

  switch (response.status) {
    case 401:
      return new JiraError(
        `Jira rejected the credentials for ${jira.email}. Check the email and API token ` +
          '— the token must belong to that account, and a password will not work.',
      );
    case 403:
      // Seraph sets this header when repeated failures have triggered a CAPTCHA, which
      // no amount of retrying will clear.
      return new JiraError(
        response.headers.get('X-Seraph-LoginReason') === 'AUTHENTICATION_DENIED'
          ? `Jira is requiring a CAPTCHA for this account. Sign in at ${base} in a browser tab, then try again.`
          : `That account is not permitted to do this in ${jira.projectKey}. ${detail}`.trim(),
      );
    case 404:
      return new JiraError(
        `Not found at ${base}. Check the site URL and that project ${jira.projectKey} exists. ${detail}`.trim(),
      );
    case 413:
      return new JiraError(`The file is larger than this Jira site accepts. ${detail}`.trim());
    case 429:
      return new JiraError('Jira is rate limiting this account. Wait a moment and try again.');
    default:
      return new JiraError(
        detail || `Jira returned ${response.status} ${response.statusText}.`,
      );
  }
}

async function jiraErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    return [
      ...(body.errorMessages ?? []),
      ...Object.entries(body.errors ?? {}).map(([field, message]) => `${field}: ${message}`),
    ].join(' ');
  } catch {
    return '';
  }
}

/**
 * HTTP Basic, as Atlassian's API specifies.
 *
 * `btoa` is Latin-1 only and throws on any non-ASCII character, which an Atlassian
 * account email can legitimately contain. Encoding to UTF-8 bytes first is what makes
 * such an address work instead of failing with an unexplained `InvalidCharacterError`.
 */
function basicAuth(email: string, token: string): string {
  const bytes = new TextEncoder().encode(`${email.trim()}:${token.trim()}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/** Byte counts as a person reads them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
