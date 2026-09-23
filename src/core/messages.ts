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

/** worker → offscreen document */
export type OffscreenMessage =
  | { type: 'OFFSCREEN_START'; streamId: string; sessionId: string }
  | { type: 'OFFSCREEN_STOP' };

/** offscreen document → worker */
export type OffscreenReply =
  | { type: 'RECORDING_STARTED'; sessionId: string }
  | { type: 'RECORDING_FAILED'; sessionId: string; error: string }
  | { type: 'RECORDING_DATA'; sessionId: string; video: Blob };

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
