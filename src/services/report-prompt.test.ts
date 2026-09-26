import { describe, expect, it } from 'vitest';
import { buildLog, chooseKeyframes, MAX_KEYFRAMES, SYSTEM_PROMPT } from './report-prompt';
import { EXPECTED_NOT_STATED } from './report-schema';
import type { Session } from '@/core/session';
import type { Step } from './markdown';

const STEPS: Step[] = [
  { n: 1, atMs: 1200, text: "Click the 'Orders' link" },
  { n: 2, atMs: 65_000, text: "Click the 'Submit prescription' button" },
];

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
    console: [],
    network: [],
    keyframes: [],
    trace: [],
    ...partial,
  };
}

describe('SYSTEM_PROMPT', () => {
  /**
   * The sentinel is enforced in `groundReport` either way, but the model has to be told
   * the exact string or it will paraphrase — and a paraphrase reads as a real finding.
   */
  it('quotes the not-stated sentinel verbatim so the model can return it', () => {
    expect(SYSTEM_PROMPT).toContain(EXPECTED_NOT_STATED);
  });

  it('tells the model it cannot add a step', () => {
    expect(SYSTEM_PROMPT).toMatch(/never describe an action that is not in the numbered list/i);
  });
});

describe('buildLog', () => {
  it('numbers the actions with offsets and states the list is complete', () => {
    const log = buildLog(session(), STEPS);
    expect(log).toContain("1. [0:01] Click the 'Orders' link");
    expect(log).toContain("2. [1:05] Click the 'Submit prescription' button");
    expect(log).toContain('This list is complete; nothing else happened.');
  });

  it('says plainly when the tester left no note', () => {
    expect(buildLog(session(), STEPS)).toContain('(none — the tester recorded no note');
  });

  it('includes the note when there is one', () => {
    const log = buildLog(session({ testerNote: 'Total stayed at zero.' }), STEPS);
    expect(log).toContain('Total stayed at zero.');
  });

  /**
   * This is the request that leaves the machine, so the scrub has to happen here and not
   * only at capture time — a console error is free text the page chose, and pages log
   * whatever they like.
   */
  it('scrubs personal data out of the note and the console before sending', () => {
    const log = buildLog(
      session({
        testerNote: 'Reported by maria.santos@clinic.test',
        console: [{ t: 2000, level: 'error', text: 'failed for user carlos@patient.test' }],
      }),
      STEPS,
    );
    expect(log).not.toContain('maria.santos@clinic.test');
    expect(log).not.toContain('carlos@patient.test');
    expect(log).toContain('[email]');
  });

  it('reports console errors and warnings, but not application chatter', () => {
    const log = buildLog(
      session({
        console: [
          { t: 1000, level: 'log', text: 'router: navigating' },
          { t: 2000, level: 'info', text: 'cache warm' },
          { t: 3000, level: 'warn', text: 'deprecated prop' },
          { t: 4000, level: 'error', text: 'TypeError: total is undefined' },
        ],
      }),
      STEPS,
    );
    expect(log).toContain('WARN deprecated prop');
    expect(log).toContain('ERROR TypeError: total is undefined');
    expect(log).not.toContain('router: navigating');
    expect(log).not.toContain('cache warm');
  });

  it('states the absence of findings rather than leaving the sections empty', () => {
    const log = buildLog(session(), STEPS);
    expect(log).toContain('(nothing was logged at warn or error level)');
    expect(log).toContain('(no request failed)');
  });

  it('renders a failed request with its outcome', () => {
    const log = buildLog(
      session({
        network: [
          {
            t: 5000,
            method: 'POST',
            url: 'https://app.test/api/orders',
            status: 500,
            durationMs: 240,
          },
        ],
      }),
      STEPS,
    );
    expect(log).toContain('[0:05] POST https://app.test/api/orders → 500 after 240ms');
  });

  it('notes when nothing was captured instead of printing an empty list', () => {
    expect(buildLog(session(), [])).toContain('(no interactions were captured)');
  });
});

describe('chooseKeyframes', () => {
  it('returns everything when under the limit', () => {
    expect(chooseKeyframes([1, 2, 3], 6)).toEqual([1, 2, 3]);
  });

  it('samples evenly and always keeps both ends', () => {
    const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const chosen = chooseKeyframes(frames, 4);
    expect(chosen).toHaveLength(4);
    expect(chosen[0]).toBe(0);
    expect(chosen.at(-1)).toBe(9);
  });

  it('never exceeds the limit on a long recording', () => {
    const frames = Array.from({ length: 60 }, (_, i) => i);
    expect(chooseKeyframes(frames)).toHaveLength(MAX_KEYFRAMES);
  });

  it('keeps the frames in recording order', () => {
    const frames = Array.from({ length: 30 }, (_, i) => i);
    const chosen = chooseKeyframes(frames);
    expect([...chosen].sort((a, b) => a - b)).toEqual(chosen);
  });
});

describe('chooseKeyframes — degenerate limits', () => {
  it('takes the last frame when only one is allowed', () => {
    // `(len-1)/(limit-1)` is Infinity at limit 1; the final frame is also the one that
    // usually shows the bug.
    expect(chooseKeyframes([0, 1, 2, 3], 1)).toEqual([3]);
  });

  it('returns nothing when no frames are allowed', () => {
    expect(chooseKeyframes([0, 1, 2], 0)).toEqual([]);
  });

  it('never yields an undefined frame', () => {
    for (let limit = 1; limit <= 8; limit++) {
      const chosen = chooseKeyframes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], limit);
      expect(chosen.every((frame) => frame !== undefined)).toBe(true);
    }
  });
});
