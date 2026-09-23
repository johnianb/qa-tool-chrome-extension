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

/** content script → worker */
export type ContentMessage =
  | { type: 'EVENTS'; events: InteractionEvent[] }
  | { type: 'CONSOLE'; entries: ConsoleEntry[] }
  | { type: 'NETWORK'; entries: NetworkEntry[] }
  | { type: 'IS_RECORDING' };

export type ExtensionMessage = PopupMessage | OffscreenMessage | OffscreenReply | ContentMessage;

/** Shape returned for `GET_STATE`, driving the popup UI. */
export interface PopupState {
  recording: boolean;
  /** ms elapsed, when recording. */
  elapsedMs: number;
  sessionCount: number;
}
