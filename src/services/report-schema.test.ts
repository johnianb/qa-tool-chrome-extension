import { describe, expect, it } from 'vitest';
import {
  EXPECTED_NOT_STATED,
  groundReport,
  normaliseSeverity,
  type ModelReport,
} from './report-schema';
import type { Session } from '@/core/session';
import type { Step } from './markdown';

const STEPS: Step[] = [
  { n: 1, atMs: 1200, text: "Click the 'Orders' link" },
  { n: 2, atMs: 4300, text: "Enter 3 characters into the 'Quantity' field" },
  { n: 3, atMs: 9100, text: "Click the 'Submit prescription' button" },
];

function session(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    status: 'stopped',
    startedAt: 1_000,
    stoppedAt: 61_000,
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

function modelReport(partial: Partial<ModelReport> = {}): ModelReport {
  return {
    title: 'Order total stays at zero',
    summary: 'The total did not update.',
    preconditions: [],
    steps: [{ n: 1, action: "Open the 'Orders' list" }],
    expectedResult: 'The total should update.',
    actualResult: 'It stayed at zero.',
    severity: 'major',
    suspectedArea: 'POST /api/orders',
    evidence: [],
    ...partial,
  };
}

describe('groundReport — steps can only come from the captured log', () => {
  it('drops a step number the model invented', () => {
    const report = groundReport(
      modelReport({
        steps: [
          { n: 1, action: "Open the 'Orders' list" },
          { n: 99, action: 'Disable the feature flag in the admin panel' },
          { n: 3, action: "Submit the prescription" },
        ],
      }),
      { steps: STEPS, session: session() },
    );

    expect(report.stepsToReproduce.map((s) => s.action)).toEqual([
      "Open the 'Orders' list",
      'Submit the prescription',
    ]);
  });

  it('takes timestamps from the captured step, never from the model', () => {
    const report = groundReport(modelReport({ steps: [{ n: 3, action: 'Submit it' }] }), {
      steps: STEPS,
      session: session(),
    });
    expect(report.stepsToReproduce).toEqual([{ n: 1, action: 'Submit it', atMs: 9100 }]);
  });

  it('renumbers so a dropped step leaves no gap', () => {
    const report = groundReport(
      modelReport({
        steps: [
          { n: 1, action: 'first' },
          { n: 42, action: 'invented' },
          { n: 2, action: 'second' },
        ],
      }),
      { steps: STEPS, session: session() },
    );
    expect(report.stepsToReproduce.map((s) => s.n)).toEqual([1, 2]);
  });

  it('falls back to the captured steps when no returned index is usable', () => {
    const report = groundReport(modelReport({ steps: [{ n: 77, action: 'invented' }] }), {
      steps: STEPS,
      session: session(),
    });
    expect(report.stepsToReproduce.map((s) => s.action)).toEqual(STEPS.map((s) => s.text));
  });

  it('collapses the same step number returned twice', () => {
    const report = groundReport(
      modelReport({
        steps: [
          { n: 2, action: 'Enter a quantity' },
          { n: 2, action: 'Enter a quantity again' },
        ],
      }),
      { steps: STEPS, session: session() },
    );
    expect(report.stepsToReproduce).toHaveLength(1);
  });

  it('keeps the captured wording when the model returns an empty action', () => {
    const report = groundReport(modelReport({ steps: [{ n: 2, action: '   ' }] }), {
      steps: STEPS,
      session: session(),
    });
    expect(report.stepsToReproduce[0]?.action).toBe(STEPS[1]!.text);
  });
});

describe('groundReport — expected result is never invented', () => {
  it('replaces the expected result when the tester left no note', () => {
    const report = groundReport(
      modelReport({ expectedResult: 'The discount should apply to the subtotal.' }),
      { steps: STEPS, session: session() },
    );
    expect(report.expectedResult).toBe(EXPECTED_NOT_STATED);
  });

  it('keeps it when the tester did write a note', () => {
    const report = groundReport(
      modelReport({ expectedResult: 'The total should fall by 10%.' }),
      { steps: STEPS, session: session({ testerNote: 'Discount never applied.' }) },
    );
    expect(report.expectedResult).toBe('The total should fall by 10%.');
  });

  it('treats a whitespace-only note as no note', () => {
    const report = groundReport(modelReport({ expectedResult: 'Something plausible.' }), {
      steps: STEPS,
      session: session({ testerNote: '   ' }),
    });
    expect(report.expectedResult).toBe(EXPECTED_NOT_STATED);
  });
});

describe('groundReport — no evidence is lost', () => {
  it('appends a console error the model did not cite', () => {
    const report = groundReport(modelReport({ evidence: [] }), {
      steps: STEPS,
      session: session({
        console: [{ t: 9500, level: 'error', text: 'TypeError: total is undefined' }],
      }),
    });
    expect(report.evidence).toEqual([
      'Console error at 0:09: TypeError: total is undefined',
    ]);
  });

  it('appends a failed request the model did not cite', () => {
    const report = groundReport(modelReport({ evidence: [] }), {
      steps: STEPS,
      session: session({
        network: [{ t: 9600, method: 'POST', url: 'https://app.test/api/orders', status: 500 }],
      }),
    });
    expect(report.evidence).toEqual([
      'Failed request at 0:09: POST https://app.test/api/orders → 500',
    ]);
  });

  it('does not duplicate a fact the model already cited at that timestamp', () => {
    const report = groundReport(
      modelReport({ evidence: ['At 0:09 the console reported the total was undefined'] }),
      {
        steps: STEPS,
        session: session({
          console: [{ t: 9500, level: 'error', text: 'TypeError: total is undefined' }],
        }),
      },
    );
    expect(report.evidence).toHaveLength(1);
  });

  /**
   * Two errors inside the same second both render as 0:09, so a boolean "was 0:09
   * mentioned?" would let one citation hide the other — losing exactly what this is for.
   */
  it('keeps a second error that shares a timestamp with a cited one', () => {
    const report = groundReport(
      modelReport({ evidence: ['At 0:09 the total came back undefined'] }),
      {
        steps: STEPS,
        session: session({
          console: [
            { t: 9500, level: 'error', text: 'TypeError: total is undefined' },
            { t: 9600, level: 'error', text: 'Failed to render OrderSummary' },
          ],
        }),
      },
    );
    expect(report.evidence).toHaveLength(2);
    expect(report.evidence.join(' ')).toContain('Failed to render OrderSummary');
  });

  it('does not let a cited console error suppress a request that failed in the same second', () => {
    const report = groundReport(
      modelReport({ evidence: ['Console error at 0:09: TypeError: total is undefined'] }),
      {
        steps: STEPS,
        session: session({
          console: [{ t: 9500, level: 'error', text: 'TypeError: total is undefined' }],
          network: [
            { t: 9550, method: 'POST', url: 'https://app.test/api/orders', status: 500 },
          ],
        }),
      },
    );
    expect(report.evidence.join(' ')).toContain('POST https://app.test/api/orders');
  });

  it('ignores console output below error level', () => {
    const report = groundReport(modelReport({ evidence: [] }), {
      steps: STEPS,
      session: session({
        console: [
          { t: 1000, level: 'log', text: 'router: navigating' },
          { t: 2000, level: 'warn', text: 'deprecated prop' },
        ],
      }),
    });
    expect(report.evidence).toEqual([]);
  });

  it('describes a request that errored rather than returning a status', () => {
    const report = groundReport(modelReport({ evidence: [] }), {
      steps: STEPS,
      session: session({
        network: [
          {
            t: 3000,
            method: 'GET',
            url: 'https://app.test/api/price',
            status: null,
            error: 'net::ERR_CONNECTION_REFUSED',
          },
        ],
      }),
    });
    expect(report.evidence[0]).toContain('net::ERR_CONNECTION_REFUSED');
  });
});

describe('normaliseSeverity', () => {
  it('accepts the four documented values', () => {
    for (const value of ['blocker', 'major', 'minor', 'trivial'] as const) {
      expect(normaliseSeverity(value)).toBe(value);
    }
  });

  it('normalises casing and trailing commentary', () => {
    expect(normaliseSeverity('Blocker')).toBe('blocker');
    expect(normaliseSeverity('  MINOR ')).toBe('minor');
    expect(normaliseSeverity('major (data loss)')).toBe('major');
  });

  it('finds the value inside a longer phrase', () => {
    expect(normaliseSeverity('probably a trivial issue')).toBe('trivial');
  });

  /**
   * The fallback gets a human to look without claiming the product is down — the wrong
   * default in either direction is worse than a mislabelled ticket.
   */
  it('falls back to major when the value means nothing', () => {
    expect(normaliseSeverity('catastrophic')).toBe('major');
    expect(normaliseSeverity('')).toBe('major');
  });
});

describe('groundReport — bookkeeping', () => {
  it('marks a fresh report as not yet edited by a human', () => {
    const report = groundReport(modelReport(), { steps: STEPS, session: session() });
    expect(report.edited).toBe(false);
  });

  it('trims fields and drops empty preconditions', () => {
    const report = groundReport(
      modelReport({
        title: '  Order total stays at zero  ',
        preconditions: ['Signed in as a pharmacist', '  ', ''],
      }),
      { steps: STEPS, session: session() },
    );
    expect(report.title).toBe('Order total stays at zero');
    expect(report.preconditions).toEqual(['Signed in as a pharmacist']);
  });
});
