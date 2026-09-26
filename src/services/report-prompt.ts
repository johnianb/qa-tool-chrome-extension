/**
 * Builds the request Claude sees: a structured log of the session, plus keyframes.
 *
 * Kept separate from the API call so the exact text sent off the device is something a
 * test can assert on, and something a reviewer can read without a network tap. When a
 * report comes back wrong, the first question is always "what did it actually see?" —
 * `buildLog()` answers it.
 */
import { formatOffset, type Session } from '@/core/session';
import { scrubText } from '@/core/events/redact';
import { EXPECTED_NOT_STATED } from './report-schema';
import type { Step } from './markdown';

/**
 * How many screenshots go with the request.
 *
 * Enough to see the shape of the flow, few enough to stay cheap and quick. Keyframes
 * fire on clicks and submissions, so a busy two-minute session can hold dozens; past
 * about half a dozen they stop adding information about *this* bug and start adding
 * cost. Sampled evenly rather than taking the first six, since a bug is usually at the
 * end of a recording and the opening clicks are navigation.
 */
export const MAX_KEYFRAMES = 6;

export const SYSTEM_PROMPT = `You write bug reports for a software team's issue tracker, from recordings made by a QA tester.

You are given a log of one recording: the environment, a numbered list of the tester's actions, console output, and failed network requests. Some frames of the screen recording are attached as images.

The log is your only evidence. Everything you write must be traceable to a line in it.

Rules that matter more than fluency:

1. Never describe an action that is not in the numbered list. To cite a step, return its number; you may reword it for clarity, but the action must stay the same one. There is no way to add a step, and inventing one would make the whole report untrustworthy.
2. Do not name a cause you cannot point at. "The POST to /api/orders returned 500" is a finding; "a race condition in the checkout service" is a guess. If the log does not identify the area, say it does not.
3. Expected result comes only from the tester's note. If the note does not say what should have happened, return exactly: ${EXPECTED_NOT_STATED}
   You have no specification for this product. A plausible-sounding expectation is worse than an admitted gap, because a reviewer will believe it.
4. Screenshots show what the page looked like; they do not tell you what the tester intended. Use them to confirm state, not to infer goals.
5. An absence of console errors and failed requests is normal, and is not itself a finding. Plenty of real bugs are purely visual. Report what the recording shows.

Write plainly, for the developer who has to reproduce this. No preamble, no restating the task, no words like "seamlessly" or "unfortunately". Prefer the specific noun over the general one — the element names in the log came from the page itself, so use them.`;

/**
 * Render the session as the log the model reads.
 *
 * Offsets are `m:ss` from the recording start, the same clock the video and the step
 * timeline use, so every timestamp the model quotes is one a reviewer can click.
 */
export function buildLog(session: Session, steps: Step[]): string {
  const lines: string[] = [];

  lines.push('# Recording');
  lines.push(`Page: ${session.env.title || '(untitled)'} — ${session.env.url}`);
  lines.push(`Viewport: ${session.env.viewport.width}×${session.env.viewport.height}`);
  lines.push(`Duration: ${formatOffset(durationOf(session))}`);
  lines.push('');

  lines.push("# Tester's note");
  lines.push(
    session.testerNote?.trim()
      ? scrubText(session.testerNote.trim())
      : '(none — the tester recorded no note, so the expected result is unknown)',
  );
  lines.push('');

  lines.push('# Actions');
  if (steps.length === 0) {
    lines.push('(no interactions were captured)');
  } else {
    lines.push('Cite these by number. This list is complete; nothing else happened.');
    for (const step of steps) {
      lines.push(`${step.n}. [${formatOffset(step.atMs)}] ${step.text}`);
    }
  }
  lines.push('');

  lines.push('# Console');
  // Warnings are included because the line before an error is often the one that
  // explains it; `log` and `info` are not, being mostly application chatter.
  const console_ = session.console.filter((c) => c.level === 'error' || c.level === 'warn');
  if (console_.length === 0) {
    lines.push('(nothing was logged at warn or error level)');
  } else {
    for (const entry of console_) {
      lines.push(`[${formatOffset(entry.t)}] ${entry.level.toUpperCase()} ${scrubText(entry.text)}`);
      if (entry.stack) lines.push(indent(scrubText(entry.stack)));
    }
  }
  lines.push('');

  lines.push('# Failed requests');
  if (session.network.length === 0) {
    lines.push('(no request failed)');
  } else {
    for (const entry of session.network) {
      const outcome = entry.status ?? entry.error ?? 'failed';
      const took = entry.durationMs === undefined ? '' : ` after ${entry.durationMs}ms`;
      lines.push(`[${formatOffset(entry.t)}] ${entry.method} ${entry.url} → ${outcome}${took}`);
    }
  }

  return lines.join('\n');
}

/**
 * Pick the keyframes to attach, evenly spaced across the recording.
 *
 * Even spacing beats "the first N": keyframes are captured on interaction, so the dense
 * cluster is wherever the tester was busy, and the frame that shows the bug is usually
 * the last one. Both ends are always kept.
 */
export function chooseKeyframes<T>(keyframes: T[], limit = MAX_KEYFRAMES): T[] {
  if (limit <= 0) return [];
  if (keyframes.length <= limit) return [...keyframes];
  // A limit of one has no interval to space over, and `(len-1)/0` would be Infinity.
  // The last frame is the one that usually shows the bug.
  if (limit === 1) return [keyframes[keyframes.length - 1]!];

  const step = (keyframes.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, i) => keyframes[Math.round(i * step)]!);
}

function durationOf(session: Session): number {
  return session.stoppedAt ? session.stoppedAt - session.startedAt : 0;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
