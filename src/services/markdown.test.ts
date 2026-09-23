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
