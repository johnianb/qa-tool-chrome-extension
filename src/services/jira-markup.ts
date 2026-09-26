/**
 * Renders a session as a Jira issue: a summary line and a wiki-markup description.
 *
 * ## Why this is not `toMarkdown`
 *
 * Jira's REST **v2** `description` field is a string of Atlassian *wiki markup*, which
 * is not Markdown and differs everywhere it matters: headings are `h2.`, ordered lists
 * are `#`, emphasis is `_text_`, and `{`, `[` and `|` are structural characters that
 * silently swallow whatever follows them. Handing Jira a Markdown string produces an
 * issue where the steps are one run-on paragraph — which looks, to everyone reading the
 * ticket, like the tool got the steps wrong.
 *
 * (v3 takes Atlassian Document Format instead: a JSON document tree. Writing an ADF
 * serialiser would buy nothing here, and v2 is not deprecated for Jira Cloud — it
 * converts wiki markup to ADF on the way in.)
 */
import { formatOffset, writerOf, type Session } from '@/core/session';
import { browserOf, titleFor, toSteps } from './markdown';

/** Jira rejects a `summary` longer than this, with a 400 that names the field. */
export const SUMMARY_LIMIT = 255;

/**
 * The issue summary — Jira's title field.
 *
 * Trimmed to one line: a newline in `summary` is accepted and then rendered as a space
 * in some views and a break in others, so it is removed here rather than left to vary.
 */
export function issueSummary(session: Session): string {
  const raw = session.report?.title?.trim() || titleFor(session, toSteps(session.events));
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > SUMMARY_LIMIT ? `${oneLine.slice(0, SUMMARY_LIMIT - 1)}…` : oneLine;
}

/**
 * The issue description, in wiki markup.
 *
 * `attachments` are the filenames about to be uploaded. They are named in the
 * description because an attachment with no reference in the text is easy to miss —
 * Jira renders them in a collapsed strip below the fold.
 */
export function issueDescription(
  session: Session,
  options: { attachments?: string[] } = {},
): string {
  const lines = session.report
    ? writtenDescription(session)
    : capturedDescription(session);

  const attachments = options.attachments ?? [];
  if (attachments.length > 0) {
    lines.push('h2. Attachments', '');
    for (const name of attachments) lines.push(`* {{${escapeWiki(name)}}}`);
    lines.push('');
  }

  lines.push('----', '');
  lines.push(footer(session));

  return lines.join('\n');
}

/** The Claude-written report. */
function writtenDescription(session: Session): string[] {
  const report = session.report!;
  const lines: string[] = [];

  lines.push(`*Severity:* ${escapeWiki(report.severity)}`);
  if (report.suspectedArea) {
    lines.push(`*Suspected area:* ${escapeWiki(report.suspectedArea)}`);
  }
  lines.push('');

  lines.push(escapeWiki(report.summary), '');

  if (report.preconditions.length > 0) {
    lines.push('h2. Preconditions', '');
    for (const item of report.preconditions) lines.push(`* ${escapeWiki(item)}`);
    lines.push('');
  }

  lines.push('h2. Steps to reproduce', '');
  for (const step of report.stepsToReproduce) {
    lines.push(`# ${escapeWiki(step.action)} _(${formatOffset(step.atMs)})_`);
  }
  lines.push('');

  lines.push('h2. Expected result', '', escapeWiki(report.expectedResult), '');
  lines.push('h2. Actual result', '', escapeWiki(report.actualResult), '');

  if (report.evidence.length > 0) {
    lines.push('h2. Evidence', '', ...verbatim(report.evidence));
  }

  lines.push(...environmentTable(session));

  return lines;
}

/** The deterministic report: no model involved. */
function capturedDescription(session: Session): string[] {
  const steps = toSteps(session.events);
  const errors = session.console.filter((entry) => entry.level === 'error');
  const failures = session.network;
  const lines: string[] = [];

  if (session.testerNote) {
    lines.push(escapeWiki(session.testerNote), '');
  }

  lines.push('h2. Steps to reproduce', '');
  if (steps.length === 0) {
    lines.push('_No interactions were captured for this recording._');
  } else {
    for (const step of steps) {
      lines.push(`# ${escapeWiki(step.text)} _(${formatOffset(step.atMs)})_`);
    }
  }
  lines.push('');

  lines.push('h2. Actual result', '');
  if (errors.length === 0 && failures.length === 0) {
    lines.push('_No console errors or failed requests were recorded._', '');
  } else {
    const facts = [
      ...errors.map((error) => `${formatOffset(error.t)}  console error: ${error.text}`),
      ...failures.map((failure) => {
        const outcome = failure.status ?? failure.error ?? 'failed';
        return `${formatOffset(failure.t)}  ${failure.method} ${failure.url} → ${outcome}`;
      }),
    ];
    lines.push(...verbatim(facts));
  }

  lines.push('h2. Expected result', '', '_Not stated._', '');
  lines.push(...environmentTable(session));

  return lines;
}

/**
 * Log lines, rendered so Jira cannot reinterpret them.
 *
 * Console text and URLs are full of the characters wiki markup reserves — a stack trace
 * containing `{` or a query string containing `|` would otherwise disappear into a
 * malformed macro. `{noformat}` suspends all parsing, which is also the honest
 * presentation: this is the machine's output, quoted, not the report's prose.
 */
function verbatim(facts: string[]): string[] {
  return ['{noformat}', ...facts.map((fact) => fact.replace(/\r?\n/g, ' ')), '{noformat}', ''];
}

/** Browser and page context, in the order a developer checks it. */
function environmentTable(session: Session): string[] {
  const { env } = session;
  const rows: Array<[string, string]> = [
    ['URL', env.url],
    ['Page', env.title],
    ['Recorded', new Date(env.recordedAt).toLocaleString()],
    ['Viewport', `${env.viewport.width}×${env.viewport.height} @${env.devicePixelRatio}x`],
    ['Browser', browserOf(env.userAgent)],
    ['Extension', `v${env.extensionVersion}`],
  ];

  return [
    'h2. Environment',
    '',
    ...rows.map(([label, value]) => `|*${label}*|${escapeWiki(value)}|`),
    '',
  ];
}

function footer(session: Session): string {
  const report = session.report;
  const duration = session.stoppedAt ? session.stoppedAt - session.startedAt : 0;
  const provenance = report
    ? `Written by ${writerOf(report)} from the recorded event log${
        report.edited ? ', then edited by hand' : ' and not edited'
      }.`
    : 'Written directly from the recorded event log; no model was involved.';

  return (
    `_${provenance} Recorded with QA Bug Reporter — ${formatOffset(duration)}, ` +
    `${toSteps(session.events).length} steps. Timestamps are offsets into the recording._`
  );
}

/**
 * Escape the characters wiki markup treats as structure.
 *
 * Deliberately a short list. `{`, `[` and `|` open macros, links and table cells and
 * will eat the rest of the line when unbalanced, so they always escape. `*` and `_` only
 * mean anything in matched pairs around a word, and escaping them would put visible
 * backslashes through ordinary prose — an element label like *"the 'Submit' button"* is
 * far more common than a literal asterisk, so they are left alone.
 *
 * The backslash goes first, or it would escape the escapes added after it.
 */
export function escapeWiki(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/[{}[\]|]/g, (char) => `\\${char}`);
}
