/**
 * Renders a recorded session as a Markdown bug report, with no model involved.
 *
 * This is the Phase 2 deliverable and it is deliberately not a placeholder for the
 * Claude-written report: it costs nothing to run, works offline, and is the baseline
 * that shows whether the *capture* is good. If the steps here are wrong, no amount of
 * prompting in Phase 3 will fix it — it will only make them wrong more fluently.
 */
import { formatOffset, writerOf, type InteractionEvent, type Session } from '@/core/session';

/** A condensed, human-readable step. */
export interface Step {
  n: number;
  /** ms since the recording began; what the video seeks to. */
  atMs: number;
  text: string;
}

/**
 * Turn the raw event stream into steps worth reading.
 *
 * Raw events are too granular to be reproduction steps: a scroll fires repeatedly, and
 * typing into one field then clicking it produces two entries about the same thing. The
 * condensing here is what separates a log from instructions.
 */
export function toSteps(events: InteractionEvent[]): Step[] {
  const steps: Step[] = [];
  let previous: InteractionEvent | null = null;

  for (const event of events) {
    // Consecutive scrolls describe one act of scrolling.
    if (event.type === 'scroll' && previous?.type === 'scroll') {
      previous = event;
      continue;
    }

    // A change immediately followed by a click on the same element is one action.
    const last = steps[steps.length - 1];
    if (
      last &&
      event.type === 'click' &&
      previous?.type === 'change' &&
      previous.label === event.label
    ) {
      previous = event;
      continue;
    }

    const text = phraseFor(event);
    if (!text) {
      previous = event;
      continue;
    }

    // Identical consecutive phrases are almost always one action seen twice.
    if (last?.text === text) {
      previous = event;
      continue;
    }

    steps.push({ n: steps.length + 1, atMs: event.t, text });
    previous = event;
  }

  return steps;
}

function phraseFor(event: InteractionEvent): string | null {
  switch (event.type) {
    case 'click':
      return `Click ${event.label}`;
    case 'change':
      return `Enter ${event.value ?? 'a value'} into ${event.label}`;
    case 'submit':
      return `Submit ${event.label}`;
    case 'key':
      return `Press ${event.value} on ${event.label}`;
    case 'navigate':
      return capitalise(event.label);
    case 'scroll':
      return `Scroll the page`;
    default:
      return null;
  }
}

/**
 * Render the whole session as a Markdown bug report.
 *
 * A written report takes precedence when one exists: it is what the tester asked for and
 * what they expect Copy to hand them. Without one this falls through to the deterministic
 * rendering below, which is a complete report in its own right.
 */
export function toMarkdown(session: Session): string {
  return session.report ? writtenToMarkdown(session) : capturedToMarkdown(session);
}

/**
 * The Claude-written report, plus the captured environment.
 *
 * The environment is appended from the record rather than taken from the prose — it is
 * the first thing a developer checks and there is no reason to let a summary restate it.
 * Console errors and failed requests arrive under Evidence, where `groundReport` has
 * already guaranteed none went missing.
 */
function writtenToMarkdown(session: Session): string {
  const report = session.report!;
  const lines: string[] = [];

  lines.push(`# ${report.title}`, '');
  lines.push(`**Severity:** ${report.severity}`);
  if (report.suspectedArea) lines.push(`**Suspected area:** ${report.suspectedArea}`);
  lines.push('');

  lines.push(report.summary, '');

  if (report.preconditions.length > 0) {
    lines.push('## Preconditions', '');
    for (const item of report.preconditions) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Steps to reproduce', '');
  for (const step of report.stepsToReproduce) {
    lines.push(`${step.n}. ${step.action} _(${formatOffset(step.atMs)})_`);
  }
  lines.push('');

  lines.push('## Expected result', '', report.expectedResult, '');
  lines.push('## Actual result', '', report.actualResult, '');

  if (report.evidence.length > 0) {
    lines.push('## Evidence', '');
    for (const item of report.evidence) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push(...environmentSection(session));

  lines.push('---', '');
  lines.push(
    `_Written by ${writerOf(report)} from a QA Bug Reporter recording` +
      `${report.edited ? ', then edited by hand' : ' and not edited'}. ` +
      `Steps and timestamps come from the captured event log._`,
  );

  return lines.join('\n');
}

/** The deterministic report: no model involved. */
function capturedToMarkdown(session: Session): string {
  const steps = toSteps(session.events);
  const errors = session.console.filter((entry) => entry.level === 'error');
  const failures = session.network;

  const lines: string[] = [];

  lines.push(`# ${titleFor(session, steps)}`, '');

  if (session.testerNote) {
    lines.push('## Description', '', session.testerNote, '');
  }

  lines.push(...environmentSection(session));

  lines.push('## Steps to reproduce', '');
  if (steps.length === 0) {
    lines.push('_No interactions were captured for this recording._');
  } else {
    for (const step of steps) {
      lines.push(`${step.n}. ${step.text} _(${formatOffset(step.atMs)})_`);
    }
  }
  lines.push('');

  lines.push('## Actual result', '');
  if (errors.length === 0 && failures.length === 0) {
    lines.push(
      '_No console errors or failed requests were recorded. Describe what went wrong._',
    );
  } else {
    if (errors.length > 0) {
      lines.push(`**${errors.length} console error${plural(errors.length)}:**`, '');
      for (const error of errors.slice(0, 10)) {
        lines.push(`- \`${formatOffset(error.t)}\` ${error.text}`);
      }
      if (errors.length > 10) lines.push(`- _…and ${errors.length - 10} more_`);
      lines.push('');
    }
    if (failures.length > 0) {
      lines.push(`**${failures.length} failed request${plural(failures.length)}:**`, '');
      for (const failure of failures.slice(0, 10)) {
        const status = failure.status ?? failure.error ?? 'failed';
        lines.push(`- \`${formatOffset(failure.t)}\` ${failure.method} ${failure.url} → ${status}`);
      }
      if (failures.length > 10) lines.push(`- _…and ${failures.length - 10} more_`);
      lines.push('');
    }
  }

  lines.push('## Expected result', '');
  lines.push('_Describe what should have happened._', '');

  const duration = session.stoppedAt ? session.stoppedAt - session.startedAt : 0;
  lines.push('---', '');
  lines.push(
    `_Recorded with QA Bug Reporter — ${formatOffset(duration)} of video, ` +
      `${steps.length} step${plural(steps.length)}, ` +
      `${session.keyframes.length} screenshot${plural(session.keyframes.length)}._`,
  );

  return lines.join('\n');
}

/** Browser and page context, in the order a developer checks it. */
function environmentSection(session: Session): string[] {
  return [
    '## Environment',
    '',
    `- **URL:** ${session.env.url}`,
    `- **Page:** ${session.env.title}`,
    `- **Recorded:** ${new Date(session.env.recordedAt).toLocaleString()}`,
    `- **Viewport:** ${session.env.viewport.width}×${session.env.viewport.height}`,
    `- **Browser:** ${browserOf(session.env.userAgent)}`,
    `- **Extension:** v${session.env.extensionVersion}`,
    '',
  ];
}

/**
 * A title for the report.
 *
 * The tester's own note wins whenever there is one: they know what broke, and a
 * generated title is at best a description of what they did, not of the bug.
 *
 * Exported because `jira-markup.ts` needs the same title for the issue summary field,
 * and two renderers disagreeing about what a recording is called would be a bug in its
 * own right.
 */
export function titleFor(session: Session, steps: Step[]): string {
  if (session.testerNote) return firstSentence(session.testerNote);
  const failing = session.network[0];
  if (failing) return `${failing.method} ${failing.url} returns ${failing.status ?? 'an error'}`;
  const error = session.console.find((entry) => entry.level === 'error');
  if (error) return firstSentence(error.text);
  const last = steps[steps.length - 1];
  return last ? `Issue after: ${last.text}` : `Issue on ${session.env.title || session.env.url}`;
}

function firstSentence(text: string): string {
  const trimmed = text.trim().split(/(?<=[.!?])\s/)[0] ?? text;
  return trimmed.length > 100 ? `${trimmed.slice(0, 99)}…` : trimmed;
}

/** A readable browser name; the full user-agent string helps nobody. Shared with the
 * Jira renderer, which writes the same environment block in wiki markup. */
export function browserOf(userAgent: string): string {
  const match =
    /(Edg|OPR|Chrome|Firefox|Safari)\/(\d+)/.exec(userAgent.replace('Edg/', 'Edge/')) ?? null;
  const platform = /\(([^)]+)\)/.exec(userAgent)?.[1]?.split(';')[0]?.trim() ?? 'unknown platform';
  if (!match) return `${userAgent.slice(0, 60)} on ${platform}`;
  const name = match[1] === 'OPR' ? 'Opera' : match[1];
  return `${name} ${match[2]} on ${platform}`;
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
