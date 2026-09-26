import { describe, expect, it } from 'vitest';
import { escapeWiki, issueDescription, issueSummary, SUMMARY_LIMIT } from './jira-markup';
import type { BugReport, Session } from '@/core/session';

function session(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    status: 'stopped',
    startedAt: 1_000,
    stoppedAt: 91_000,
    env: {
      url: 'https://app.test/orders?q=1',
      title: 'Orders',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0',
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

function report(partial: Partial<BugReport> = {}): BugReport {
  return {
    title: 'Order total stays at ₱0 after a discount is applied',
    summary: 'The tester applied a discount and the total did not change.',
    preconditions: ['Signed in as a pharmacist'],
    stepsToReproduce: [
      { n: 1, action: "Click the 'Orders' link", atMs: 1_200 },
      { n: 2, action: "Apply the 'SAVE10' discount", atMs: 65_000 },
    ],
    expectedResult: 'The total should fall by 10%.',
    actualResult: 'The total stayed at ₱0.',
    severity: 'major',
    suspectedArea: 'POST /api/orders/total',
    evidence: ['Console error at 0:09: total is undefined'],
    edited: false,
    ...partial,
  };
}

describe('escapeWiki', () => {
  it('escapes the characters that open macros, links and table cells', () => {
    expect(escapeWiki('total{x} [see] a|b')).toBe('total\\{x\\} \\[see\\] a\\|b');
  });

  /** The backslash must be escaped first, or it escapes the escapes added after it. */
  it('escapes backslashes before adding any of its own', () => {
    expect(escapeWiki('C:\\path')).toBe('C:\\\\path');
    expect(escapeWiki('\\{')).toBe('\\\\\\{');
  });

  /**
   * Emphasis characters are left alone on purpose: they only mean anything in matched
   * pairs, and an element label carrying quotes is far commoner than a literal asterisk.
   */
  it('leaves emphasis characters alone', () => {
    expect(escapeWiki("Click the 'Submit *now*' button")).toBe("Click the 'Submit *now*' button");
  });
});

describe('issueSummary', () => {
  it('uses the written report title when there is one', () => {
    expect(issueSummary(session({ report: report() }))).toBe(
      'Order total stays at ₱0 after a discount is applied',
    );
  });

  it("falls back to the tester's note when no report has been written", () => {
    expect(issueSummary(session({ testerNote: 'The total stayed at zero.' }))).toBe(
      'The total stayed at zero.',
    );
  });

  it('collapses newlines, which Jira renders inconsistently', () => {
    expect(issueSummary(session({ report: report({ title: 'Total\nstays\tat zero' }) }))).toBe(
      'Total stays at zero',
    );
  });

  it('truncates past the field limit Jira enforces', () => {
    const summary = issueSummary(session({ report: report({ title: 'x'.repeat(400) }) }));
    expect(summary).toHaveLength(SUMMARY_LIMIT);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('issueDescription — written report', () => {
  const description = issueDescription(session({ report: report() }));

  it('uses wiki headings, not Markdown ones', () => {
    expect(description).toContain('h2. Steps to reproduce');
    expect(description).not.toContain('## Steps to reproduce');
  });

  it('numbers steps with the wiki ordered-list marker and keeps their offsets', () => {
    expect(description).toContain("# Click the 'Orders' link _(0:01)_");
    expect(description).toContain("# Apply the 'SAVE10' discount _(1:05)_");
  });

  it('puts evidence in a noformat block so Jira cannot reinterpret a stack trace', () => {
    expect(description).toContain('{noformat}\nConsole error at 0:09: total is undefined\n{noformat}');
  });

  it('renders the environment as a table with escaped values', () => {
    expect(description).toContain('|*URL*|https://app.test/orders?q=1|');
    expect(description).toContain('|*Browser*|Chrome 141 on Macintosh|');
  });

  it('records whether a human edited the report', () => {
    expect(description).toContain('and not edited');
    expect(issueDescription(session({ report: report({ edited: true }) }))).toContain(
      'then edited by hand',
    );
  });

  it('names the attachments, which Jira otherwise renders below the fold', () => {
    const withFiles = issueDescription(session({ report: report() }), {
      attachments: ['recording-s1.webm', 'screen-01-0m01s.jpg'],
    });
    expect(withFiles).toContain('h2. Attachments');
    expect(withFiles).toContain('* {{recording-s1.webm}}');
  });
});

describe('issueDescription — no written report', () => {
  const captured = session({
    testerNote: 'The total stayed at zero.',
    events: [
      { t: 1_200, type: 'click', label: "the 'Orders' link" },
      { t: 65_000, type: 'click', label: "the 'Apply discount' button" },
    ],
    console: [{ t: 9_000, level: 'error', text: 'TypeError: total is {undefined}' }],
    network: [{ t: 9_500, method: 'POST', url: '/api/orders/total', status: 502 }],
  });

  const description = issueDescription(captured);

  it('is a complete issue on its own, with no model involved', () => {
    expect(description).toContain('The total stayed at zero.');
    expect(description).toContain("# Click the 'Orders' link _(0:01)_");
    expect(description).toContain('h2. Environment');
  });

  it('quotes console text verbatim rather than letting wiki markup eat the braces', () => {
    expect(description).toContain('0:09  console error: TypeError: total is {undefined}');
    expect(description).toContain('{noformat}');
  });

  it('lists failed requests with their status', () => {
    expect(description).toContain('0:09  POST /api/orders/total → 502');
  });

  it('says the expected result is not stated rather than inventing one', () => {
    expect(description).toContain('_Not stated._');
  });

  it('says plainly that no model wrote it', () => {
    expect(description).toContain('no model was involved');
  });
});
