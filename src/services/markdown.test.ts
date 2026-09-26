import { describe, expect, it } from 'vitest';
import { toMarkdown, toSteps } from './markdown';
import type { InteractionEvent, Session } from '@/core/session';

function ev(partial: Partial<InteractionEvent> & { type: InteractionEvent['type'] }): InteractionEvent {
  return { t: 0, label: 'the button', ...partial };
}

function session(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    status: 'stopped',
    startedAt: 1_000,
    stoppedAt: 61_000,
    env: {
      url: 'https://app.test/orders',
      title: 'Orders',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36',
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

describe('toSteps', () => {
  it('numbers steps and keeps their timestamps for video seeking', () => {
    const steps = toSteps([
      ev({ type: 'click', label: "the 'Orders' link", t: 1200 }),
      ev({ type: 'click', label: "the 'New' button", t: 4300 }),
    ]);
    expect(steps).toEqual([
      { n: 1, atMs: 1200, text: "Click the 'Orders' link" },
      { n: 2, atMs: 4300, text: "Click the 'New' button" },
    ]);
  });

  it('collapses a run of scrolls into one step', () => {
    const steps = toSteps([
      ev({ type: 'scroll', t: 100 }),
      ev({ type: 'scroll', t: 200 }),
      ev({ type: 'scroll', t: 300 }),
      ev({ type: 'click', t: 400 }),
    ]);
    expect(steps.map((s) => s.text)).toEqual(['Scroll the page', 'Click the button']);
  });

  it('does not report typing and then clicking the same field twice', () => {
    const steps = toSteps([
      ev({ type: 'change', label: "the 'Quantity' text field", value: '3 characters', t: 100 }),
      ev({ type: 'click', label: "the 'Quantity' text field", t: 150 }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.text).toBe("Enter 3 characters into the 'Quantity' text field");
  });

  it('describes each interaction type in the imperative', () => {
    const steps = toSteps([
      ev({ type: 'submit', label: 'the form', t: 1 }),
      ev({ type: 'key', label: "the 'Search' field", value: 'Enter', t: 2 }),
      ev({ type: 'navigate', label: 'navigated to https://app.test/x (link)', t: 3 }),
    ]);
    expect(steps.map((s) => s.text)).toEqual([
      'Submit the form',
      "Press Enter on the 'Search' field",
      'Navigated to https://app.test/x (link)',
    ]);
  });
});

describe('toMarkdown', () => {
  it('prefers the tester note for the title', () => {
    const md = toMarkdown(session({ testerNote: 'Order total shows zero after discount.' }));
    expect(md.startsWith('# Order total shows zero after discount.')).toBe(true);
  });

  it('falls back to the failing request when there is no note', () => {
    const md = toMarkdown(
      session({ network: [{ t: 10, method: 'POST', url: 'https://api.test/orders', status: 500 }] }),
    );
    expect(md.startsWith('# POST https://api.test/orders returns 500')).toBe(true);
  });

  it('renders a readable browser rather than the raw user agent', () => {
    expect(toMarkdown(session())).toContain('Chrome 141 on Macintosh');
  });

  it('lists console errors and failed requests with timestamps', () => {
    const md = toMarkdown(
      session({
        console: [{ t: 12_000, level: 'error', text: 'TypeError: total is undefined' }],
        network: [{ t: 11_500, method: 'GET', url: 'https://api.test/total', status: 502 }],
      }),
    );
    expect(md).toContain('**1 console error:**');
    expect(md).toContain('`0:12` TypeError: total is undefined');
    expect(md).toContain('`0:11` GET https://api.test/total → 502');
  });

  it('says so plainly when nothing was captured', () => {
    const md = toMarkdown(session());
    expect(md).toContain('_No interactions were captured for this recording._');
    expect(md).toContain('_No console errors or failed requests were recorded.');
  });

  it('caps long lists rather than dumping hundreds of lines', () => {
    const md = toMarkdown(
      session({
        console: Array.from({ length: 25 }, (_, i) => ({
          t: i * 100,
          level: 'error' as const,
          text: `error ${i}`,
        })),
      }),
    );
    expect(md).toContain('_…and 15 more_');
  });

  it('leaves the expected result for a human to fill in', () => {
    // The tool must never invent what the application was supposed to do.
    expect(toMarkdown(session())).toContain('_Describe what should have happened._');
  });
});

describe('toMarkdown with a written report', () => {
  const report = {
    title: 'Order total stays at zero after a discount is applied',
    summary: 'Applying a discount left the total unchanged.',
    preconditions: ['Signed in as a pharmacist'],
    stepsToReproduce: [
      { n: 1, action: "Open the 'Orders' list", atMs: 1200 },
      { n: 2, action: 'Apply a 10% discount', atMs: 9100 },
    ],
    expectedResult: 'The total should fall by 10%.',
    actualResult: 'The total stayed at zero and the console reported a TypeError.',
    severity: 'major' as const,
    suspectedArea: 'POST /api/orders',
    evidence: ['Console error at 0:09: TypeError: total is undefined'],
    edited: false,
  };

  it('renders the written report rather than the captured fallback', () => {
    const md = toMarkdown(session({ report }));
    expect(md.startsWith(`# ${report.title}`)).toBe(true);
    expect(md).toContain('**Severity:** major');
    expect(md).toContain('**Suspected area:** POST /api/orders');
    expect(md).toContain('1. Open the \'Orders\' list _(0:01)_');
    expect(md).toContain('The total should fall by 10%.');
    expect(md).toContain('Console error at 0:09: TypeError: total is undefined');
  });

  it('still reports the environment from the record, not the prose', () => {
    const md = toMarkdown(session({ report }));
    expect(md).toContain('- **URL:** https://app.test/orders');
    expect(md).toContain('Chrome 141 on Macintosh');
  });

  /** A reviewer needs to know whether a human has been over it. */
  it('says whether the report has been edited by hand', () => {
    expect(toMarkdown(session({ report }))).toContain('and not edited');
    expect(toMarkdown(session({ report: { ...report, edited: true } }))).toContain(
      'then edited by hand',
    );
  });

  /**
   * A ticket that credits the wrong model is a small lie that a reader has no way to
   * catch. Reports written before the extension had a second provider carry no writer
   * and were all Claude's, which is what the absent case asserts.
   */
  it('credits the model that wrote the report', () => {
    expect(toMarkdown(session({ report }))).toContain('Written by Claude');
    expect(toMarkdown(session({ report: { ...report, writtenBy: 'Gemini' } }))).toContain(
      'Written by Gemini',
    );
  });

  it('ignores the tester note for the title once a report exists', () => {
    const md = toMarkdown(session({ report, testerNote: 'Discount did nothing.' }));
    expect(md.startsWith(`# ${report.title}`)).toBe(true);
  });
});
