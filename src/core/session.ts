/**
 * The session model: one recorded bug, from Record to exported report.
 *
 * Everything the extension captures hangs off a `Session`. Timestamps on captured
 * items are **milliseconds relative to `startedAt`**, never wall-clock — that is what
 * lets a step in the finished report seek the video to the moment it happened.
 */

/** Where a session is in its lifecycle. */
export type SessionStatus =
  | 'recording'
  | 'stopped' // video + events captured, no report yet
  | 'reported' // a report has been generated
  | 'exported'; // pushed to Jira at least once

/** A single thing the tester did, as observed in the page. */
export interface InteractionEvent {
  /** ms since `Session.startedAt` */
  t: number;
  type: 'click' | 'input' | 'change' | 'submit' | 'key' | 'scroll' | 'navigate';
  /** Human-readable target, e.g. "the 'Submit prescription' button in Order Details". */
  label: string;
  /** Stable selector for the target, for later test authoring. May be absent. */
  selector?: string;
  /**
   * Redacted description of any value involved — "14 characters" rather than the
   * value itself, unless the field is explicitly allowlisted. Never raw secrets.
   */
  value?: string;
  /** Frame URL the event came from, when not the top frame. */
  frameUrl?: string;
}

/** A console message or uncaught error observed in the page. */
export interface ConsoleEntry {
  t: number;
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  /** Present for uncaught errors and rejections. */
  stack?: string;
}

/** A network request that failed or returned an error status. */
export interface NetworkEntry {
  t: number;
  method: string;
  /** Path only — query strings are stripped during redaction. */
  url: string;
  status: number | null;
  /** Populated when the request errored rather than returning a status. */
  error?: string;
  durationMs?: number;
}

/** A screenshot taken at a significant moment. */
export interface Keyframe {
  t: number;
  /** JPEG blob, downscaled. Stored in IndexedDB, never in chrome.storage. */
  blob: Blob;
  /** What the tester was doing when this was taken. */
  caption: string;
}

/** Browser and page context, captured once at recording start. */
export interface EnvironmentInfo {
  url: string;
  title: string;
  userAgent: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  /** ISO 8601, wall-clock. The only non-relative time in the model. */
  recordedAt: string;
  extensionVersion: string;
}

/** The generated (and then human-edited) bug report. */
export interface BugReport {
  title: string;
  summary: string;
  preconditions: string[];
  stepsToReproduce: Array<{ n: number; action: string; atMs: number }>;
  expectedResult: string;
  actualResult: string;
  severity: 'blocker' | 'major' | 'minor' | 'trivial';
  suspectedArea: string;
  evidence: string[];
  /** True once a human has edited any field. Exports record whether this happened. */
  edited: boolean;
}

export interface Session {
  id: string;
  status: SessionStatus;
  /** Wall-clock epoch ms at which recording began; the origin for every `t`. */
  startedAt: number;
  /** Wall-clock epoch ms at which recording stopped. Absent while recording. */
  stoppedAt?: number;
  env: EnvironmentInfo;
  /** The tester's own one-line answer to "what went wrong?". */
  testerNote?: string;
  video?: Blob;
  events: InteractionEvent[];
  console: ConsoleEntry[];
  network: NetworkEntry[];
  keyframes: Keyframe[];
  report?: BugReport;
  /** Jira issue key, once exported. */
  jiraKey?: string;
  /**
   * Why this session failed, when it did. Surfaced in the review page so a failed
   * recording explains itself instead of just appearing empty.
   */
  error?: string;
  /**
   * Lifecycle breadcrumbs, `T+mm:ss.mmm  context: what happened`.
   *
   * The recording pipeline spans four contexts that each log to a different console,
   * and the offscreen document's console only exists while it is open — so by the time
   * a tester notices an empty recording, the evidence is gone. The trace persists with
   * the session instead, which means a failure can be diagnosed from the review page
   * without reproducing it.
   */
  trace: string[];
}

/**
 * Live recording state. Lives in `chrome.storage.session`, **not** in a service-worker
 * variable: MV3 kills the worker after ~30s idle while the offscreen document keeps
 * recording, so anything held in worker memory is gone by the time Stop is pressed.
 */
export interface RecordingState {
  sessionId: string;
  tabId: number;
  startedAt: number;
  /**
   * The tabCapture stream id the offscreen document redeems.
   *
   * It lives here, in state the document can read at any time, rather than in a
   * separate key it consumes once. A one-shot handoff has exactly one failure mode —
   * the reader misses it and there is nothing left to diagnose.
   */
  streamId: string;
}

export function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Convert a wall-clock epoch ms into a session-relative offset. */
export function relativeTime(startedAt: number, at: number = Date.now()): number {
  return Math.max(0, at - startedAt);
}

/** Format a session-relative offset as `m:ss` for display. */
export function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
