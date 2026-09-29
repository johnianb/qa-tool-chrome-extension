/**
 * Live recording state, held in `chrome.storage.session`.
 *
 * This deliberately does not live in a service-worker module variable. MV3 terminates
 * the worker after roughly 30 seconds idle; the offscreen document carries on
 * recording regardless, so worker memory is empty by the time Stop is pressed. Every
 * read goes back to storage.
 */
import { DEFAULT_REDACTION } from './events/redact';
import type { RecordingState } from './session';

const KEY = 'recordingState';

export async function getRecordingState(): Promise<RecordingState | null> {
  const stored = await chrome.storage.session.get(KEY);
  const state = stored[KEY] as RecordingState | undefined;
  if (!state) return null;

  // Spread over the defaults for the same reason `getSettings` does it: a record written
  // by a build that did not have `redaction` would hand back `undefined`, and the very
  // next thing the worker does with it is `blockedHosts.some` in `isBlockedHost` — a
  // TypeError inside the navigation listener, which presents as a recording that silently
  // stops logging navigations. `chrome.storage.session` is normally cleared when the
  // extension reloads, so this is for the recording that was already in flight.
  return { ...state, redaction: { ...DEFAULT_REDACTION, ...(state.redaction ?? {}) } };
}

export async function setRecordingState(state: RecordingState): Promise<void> {
  await chrome.storage.session.set({ [KEY]: state });
}

export async function clearRecordingState(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}

export async function isRecording(): Promise<boolean> {
  return (await getRecordingState()) !== null;
}

/** True when `tabId` is the tab currently being recorded. */
export async function isRecordingTab(tabId: number): Promise<boolean> {
  const state = await getRecordingState();
  return state?.tabId === tabId;
}
