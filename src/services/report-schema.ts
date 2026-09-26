/**
 * The shape Claude must return, and the grounding pass that turns it into a `BugReport`.
 *
 * ## Why the model never writes a step
 *
 * The single failure that would make this tool worse than useless is a report
 * containing steps the tester did not perform. A reviewer who finds one invented step
 * stops trusting every other line, and a bug report nobody trusts costs more than no
 * bug report at all.
 *
 * So the model is not asked to describe what happened. It is given the deterministic
 * step list from `toSteps()` and asked which of those numbered steps matter, and how to
 * word them. It returns **indices**, not events. `atMs` is then filled in from our own
 * record of the step it named.
 *
 * That makes a fabricated step structurally impossible rather than merely discouraged:
 * there is no field in which one could be expressed. An index that does not exist is
 * dropped here; it cannot become a line in the report. Prompt instructions are the
 * second line of defence, not the first.
 */
import { z } from 'zod';
import type { BugReport, Session } from '@/core/session';
import { formatOffset } from '@/core/session';
import type { Step } from './markdown';

/**
 * What `expectedResult` must say when the tester left no note.
 *
 * A bug report's expected result is a claim about the product's intended behaviour, and
 * the only person here who knows it is the tester. The tool has no spec, so when the
 * note is silent the honest output is a gap for a human to fill — not a plausible
 * sentence that a reviewer will read as authoritative. Enforced in `groundReport`, not
 * merely requested in the prompt.
 */
export const EXPECTED_NOT_STATED =
  'Not stated — the tester did not record what should have happened.';

/**
 * What the model returns.
 *
 * Field descriptions are not decoration — they reach the model as part of the JSON
 * schema, and the SDK's transform folds constraints it cannot express structurally
 * (enums, bounds) into them too. They are the per-field half of the prompt.
 */
export const ModelReportSchema = z.object({
  title: z
    .string()
    .describe(
      'One line a triager could scan in a list: what breaks, and where. No ticket ' +
        'prefix, no severity, no trailing period.',
    ),
  summary: z
    .string()
    .describe('Two or three sentences: what the tester was doing, and what went wrong.'),
  preconditions: z
    .array(z.string())
    .describe(
      'State that had to exist before step 1 and is visible in the log — the page ' +
        'reached, a signed-in user, a record already open. Empty array if the log ' +
        'shows none. Never guess at account roles, feature flags or test data.',
    ),
  steps: z
    .array(
      z.object({
        n: z
          .number()
          .describe('The number of a step from the numbered list in the prompt. Nothing else.'),
        action: z
          .string()
          .describe(
            'That same step, reworded as an imperative instruction a developer can ' +
              'follow. Same action, clearer words — never a different action.',
          ),
      }),
    )
    .describe(
      'The supplied steps that are needed to reach the bug, in the order given. Drop ' +
        'incidental ones (stray scrolls, a click that changed nothing). Add nothing.',
    ),
  expectedResult: z
    .string()
    .describe(
      "What should have happened, taken only from the tester's note. If the note does " +
        `not say, return exactly: ${EXPECTED_NOT_STATED}`,
    ),
  actualResult: z
    .string()
    .describe(
      'What the log shows happening instead: the console errors, the failed requests, ' +
        'the state the recording ended in. Describe the evidence, do not diagnose ' +
        'beyond it.',
    ),
  severity: z
    .string()
    .describe(
      'One of blocker, major, minor, trivial. blocker: the task cannot be completed ' +
        'at all. major: it can, but the result is wrong or data is lost. minor: ' +
        'visible fault with a workaround. trivial: cosmetic. When the log does not ' +
        'settle it, choose the lower severity.',
    ),
  suspectedArea: z
    .string()
    .describe(
      'Where to start looking — a failing endpoint, a named component, a file from a ' +
        'stack trace. Say "Unclear from the recording" rather than speculating.',
    ),
  evidence: z
    .array(z.string())
    .describe(
      'Quoted lines from the log that support the report: console errors, failed ' +
        'requests, timestamps. Quote them; do not paraphrase.',
    ),
});

export type ModelReport = z.infer<typeof ModelReportSchema>;

const SEVERITIES: BugReport['severity'][] = ['blocker', 'major', 'minor', 'trivial'];

/**
 * Coerce the model's severity to one of the four allowed values.
 *
 * The SDK's schema transform cannot express an enum structurally — it moves the allowed
 * values into the field description — so "Major" or "blocker (data loss)" are both
 * reachable. Throwing out an otherwise good report over capitalisation would be absurd,
 * so near misses are normalised and anything unrecognisable becomes `major`: the value
 * that gets a human to look without claiming the product is down.
 */
export function normaliseSeverity(raw: string): BugReport['severity'] {
  const text = raw.trim().toLowerCase();
  return SEVERITIES.find((s) => text.startsWith(s)) ?? SEVERITIES.find((s) => text.includes(s)) ?? 'major';
}

/**
 * Turn the model's answer into a `BugReport`, keeping every fact ours.
 *
 * Three guarantees, each enforced here rather than trusted to the prompt:
 *
 * 1. **Every step is real.** An index the model invented has no matching step and is
 *    dropped. Timestamps come from our record, so they always seek to the right moment.
 * 2. **Expected result is never invented.** With no tester note, the field is replaced
 *    with `EXPECTED_NOT_STATED` whatever the model wrote.
 * 3. **No evidence is lost.** Console errors and failed requests the model omitted are
 *    appended, so the diagnostic facts survive an unlucky summary.
 */
export function groundReport(
  raw: ModelReport,
  context: { steps: Step[]; session: Session },
): BugReport {
  const { steps, session } = context;
  const byNumber = new Map(steps.map((step) => [step.n, step]));

  // The same index twice is always a model slip, never a real repeat: a button clicked
  // twice produces two *different* captured steps.
  const seen = new Set<number>();

  const grounded = raw.steps
    .map((chosen) => {
      const real = byNumber.get(chosen.n);
      if (!real || seen.has(chosen.n)) return null; // invented or repeated index
      seen.add(chosen.n);
      return {
        // Renumbered so a dropped step does not leave a gap in the report.
        n: 0,
        action: chosen.action.trim() || real.text,
        atMs: real.atMs, // ours, never the model's
      };
    })
    .filter((step): step is { n: number; action: string; atMs: number } => step !== null)
    .map((step, index) => ({ ...step, n: index + 1 }));

  return {
    title: raw.title.trim(),
    summary: raw.summary.trim(),
    preconditions: raw.preconditions.map((p) => p.trim()).filter(Boolean),
    // A model that returned no usable index gets our own steps rather than an empty
    // report: the deterministic list was already publishable on its own.
    stepsToReproduce:
      grounded.length > 0
        ? grounded
        : steps.map((step) => ({ n: step.n, action: step.text, atMs: step.atMs })),
    expectedResult: session.testerNote?.trim() ? raw.expectedResult.trim() : EXPECTED_NOT_STATED,
    actualResult: raw.actualResult.trim(),
    severity: normaliseSeverity(raw.severity),
    suspectedArea: raw.suspectedArea.trim(),
    evidence: withMissingFacts(raw.evidence.map((e) => e.trim()).filter(Boolean), session),
    edited: false,
  };
}

/**
 * Append console errors and failed requests the model did not cite.
 *
 * A summary that quietly drops the one console error in the recording is the failure mode
 * here, and it is invisible to a reader who never saw the log.
 *
 * Matching is on the timestamp, because that is the part a paraphrase preserves — "at
 * 0:09 the console reported the total was undefined" should not produce a second copy of
 * that error.
 *
 * Each evidence line may satisfy **one** fact, and is then spent. Counting mentions of a
 * timestamp instead would let one citation cover every fact sharing that second: two
 * errors in the same second, or an error and a failed request beside it, and the second
 * one vanishes — the exact loss this function exists to prevent. Where a line is
 * genuinely ambiguous the bias is toward appending: a repeated line is untidy, a missing
 * error defeats the purpose.
 */
function withMissingFacts(evidence: string[], session: Session): string[] {
  const out = [...evidence];
  const spent = new Set<number>();

  /** Claim an unspent evidence line citing `stamp`; true if one was found. */
  const claim = (stamp: string): boolean => {
    const index = evidence.findIndex((line, i) => !spent.has(i) && line.includes(stamp));
    if (index === -1) return false;
    spent.add(index);
    return true;
  };

  for (const entry of session.console.filter((c) => c.level === 'error')) {
    const stamp = formatOffset(entry.t);
    if (!claim(stamp)) out.push(`Console error at ${stamp}: ${entry.text}`);
  }

  for (const entry of session.network) {
    const stamp = formatOffset(entry.t);
    if (!claim(stamp)) {
      const outcome = entry.status ?? entry.error ?? 'failed';
      out.push(`Failed request at ${stamp}: ${entry.method} ${entry.url} → ${outcome}`);
    }
  }

  return out;
}
