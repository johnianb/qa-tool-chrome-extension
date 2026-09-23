/**
 * The message protocol between popup, service worker, offscreen document and
 * content scripts. One discriminated union so TypeScript catches a mismatched
 * handler rather than leaving it to fail silently at runtime.
 */
import type { ConsoleEntry, InteractionEvent, NetworkEntry } from './session';

/** popup → worker */
export type PopupMessage =
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'GET_STATE' };

/**
 * worker → offscreen document
 *
 * Start parameters do not travel by message at all — they are in the offscreen
 * document's own URL, put there when it is created. By the time `OFFSCREEN_STOP` is
 * sent the document has certainly loaded, so that one is safe to send directly.
 */
export type OffscreenMessage = { type: 'OFFSCREEN_STOP' };

/**
 * offscreen document → worker
 *
 * Note what is *not* here: the video blob. `chrome.runtime.sendMessage` serialises
 * with JSON, not structured clone, so a Blob sent through it arrives as `{}` — no
 * error, just silently empty. The offscreen document shares this extension's origin
 * and therefore its IndexedDB, so it writes the video itself and only reports that
 * it is done.
 */
export type OffscreenReply =
  | { type: 'RECORDING_STARTED'; sessionId: string }
  | { type: 'RECORDING_FAILED'; sessionId: string; error: string }
  | { type: 'RECORDING_SAVED'; sessionId: string; bytes: number }
  | { type: 'OFFSCREEN_TRACE'; sessionId: string; line: string }
  | { type: 'OFFSCREEN_PROBE'; info: { at: number; url: string; errors: string[] } };

/** worker → content script */
export type CaptureMessage =
  | { type: 'CAPTURE_START'; sessionId: string; startedAt: number }
  | { type: 'CAPTURE_STOP' };

/** content script → worker */
export type ContentMessage =
  | { type: 'EVENTS'; sessionId: string; events: InteractionEvent[] }
  | { type: 'CONSOLE'; sessionId: string; entries: ConsoleEntry[] }
  | { type: 'NETWORK'; sessionId: string; entries: NetworkEntry[] }
  /** Asked on load, because a page can navigate mid-recording. */
  | { type: 'AM_I_RECORDED' };

/** Reply to `AM_I_RECORDED`. */
export interface CaptureStatus {
  recording: boolean;
  sessionId?: string;
  startedAt?: number;
}

/**
 * MAIN-world probe → isolated content script, over `window.postMessage`.
 *
 * The probe cannot reach `chrome.*`, so the isolated script relays for it. The marker
 * distinguishes our messages from whatever else the page posts to itself.
 */
export const PROBE_MARKER = '__qaBugReporterProbe';

export type ProbeMessage =
  | { marker: typeof PROBE_MARKER; kind: 'console'; entry: Omit<ConsoleEntry, 't'> }
  | { marker: typeof PROBE_MARKER; kind: 'network'; entry: Omit<NetworkEntry, 't'> };

export type ExtensionMessage = PopupMessage | OffscreenMessage | OffscreenReply | ContentMessage;

/** Shape returned for `GET_STATE`, driving the popup UI. */
export interface PopupState {
  recording: boolean;
  /** ms elapsed, when recording. */
  elapsedMs: number;
  sessionCount: number;
}
