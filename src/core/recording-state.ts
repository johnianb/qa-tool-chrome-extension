/**
 * Live recording state, held in `chrome.storage.session`.
 *
 * This deliberately does not live in a service-worker module variable. MV3 terminates
 * the worker after roughly 30 seconds idle; the offscreen document carries on
 * recording regardless, so worker memory is empty by the time Stop is pressed. Every
 * read goes back to storage.
 */
import type { RecordingState } from './session';

const KEY = 'recordingState';

export async function getRecordingState(): Promise<RecordingState | null> {
  const stored = await chrome.storage.session.get(KEY);
  return (stored[KEY] as RecordingState | undefined) ?? null;
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

/**
 * Parameters for a capture the offscreen document has not picked up yet.
 *
 * These are handed over through storage rather than `chrome.runtime.sendMessage`
 * because of a race in `chrome.offscreen.createDocument()`: it resolves once the
 * document exists, but the document's module script has not necessarily executed, so
 * its `onMessage` listener may not be registered. A message sent immediately after
 * creation is dropped, the recording silently never starts, and nothing reports an
 * error. Storage has no such ordering problem — the document reads it on load,
 * whenever that happens.
 */
export interface PendingCapture {
  sessionId: string;
  streamId: string;
}

const PENDING_KEY = 'pendingCapture';

export async function setPendingCapture(pending: PendingCapture): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
}

/** Read and clear the pending capture, so it is consumed exactly once. */
export async function takePendingCapture(): Promise<PendingCapture | null> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = (stored[PENDING_KEY] as PendingCapture | undefined) ?? null;
  if (pending) await chrome.storage.session.remove(PENDING_KEY);
  return pending;
}
