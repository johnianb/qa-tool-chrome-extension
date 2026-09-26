/**
 * Which model writes the report.
 *
 * The only module the UI imports for generation. Both providers expose the same two
 * functions and throw the same `ReportError`, so everything above this line is written
 * once and neither `Report.tsx` nor `Settings.tsx` knows which API answered.
 *
 * The grounding in `report-schema.ts` runs on both paths. That is the point of keeping
 * this seam narrow: the guarantees a reviewer relies on — step numbers that match the
 * recording, an expected result the tester actually wrote — are not a property of the
 * model, and must not become one.
 */
import type { Session } from '@/core/session';
import type { Provider, Settings } from '@/core/settings';
import * as anthropic from './claude';
import * as google from './gemini';
import type { GeneratedReport } from './report-error';

export { ReportError, type GeneratedReport } from './report-error';

interface ReportProvider {
  generateReport(session: Session, settings: Settings): Promise<GeneratedReport>;
  testConnection(settings: Settings): Promise<string>;
}

const PROVIDERS: Record<Provider, ReportProvider> = { anthropic, google };

/** Write a report for a recorded session, using the configured provider. */
export function generateReport(session: Session, settings: Settings): Promise<GeneratedReport> {
  return PROVIDERS[settings.provider].generateReport(session, settings);
}

/** Check the configured provider's key and reachability without spending a report. */
export function testConnection(settings: Settings): Promise<string> {
  return PROVIDERS[settings.provider].testConnection(settings);
}
