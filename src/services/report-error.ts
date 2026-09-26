/**
 * The vocabulary both report providers answer in.
 *
 * Lives apart from either provider so neither has to import the other — the dispatcher
 * in `ai.ts` imports both, and a class defined in one of them would close that loop.
 */
import type { BugReport } from '@/core/session';

/** A failure worth showing a tester verbatim. */
export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

export interface GeneratedReport {
  report: BugReport;
  /** What the call cost, for the tester who is paying per report. */
  usage: { inputTokens: number; outputTokens: number };
}
