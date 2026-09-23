/**
 * Service worker: orchestrates a recording session.
 *
 * Holds no state of its own. MV3 terminates this worker after roughly 30 seconds
 * idle while the offscreen document keeps recording, so live state goes to
 * `chrome.storage.session` and captured data goes straight to IndexedDB.
 */
import type { OffscreenReply, PopupMessage, PopupState } from '@/core/messages';
import {
  clearRecordingState,
  getRecordingState,
  setRecordingState,
} from '@/core/recording-state';
import { appendTrace, listSessions, putSession, updateSession } from '@/core/storage/db';
import { newSessionId, type EnvironmentInfo, type Session } from '@/core/session';

const OFFSCREEN_PATH = 'offscreen.html';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: PopupMessage | OffscreenReply, _sender, sendResponse) => {
    switch (message.type) {
      case 'START_RECORDING':
        void startRecording().then(sendResponse, (error: unknown) =>
          sendResponse({ error: errorText(error) }),
        );
        return true; // async response

      case 'STOP_RECORDING':
        void stopRecording().then(sendResponse, (error: unknown) =>
          sendResponse({ error: errorText(error) }),
        );
        return true;

      case 'GET_STATE':
        void popupState().then(sendResponse);
        return true;

      case 'RECORDING_SAVED':
        void onRecordingSaved(message.sessionId, message.bytes);
        return false;

      case 'OFFSCREEN_TRACE':
        void onOffscreenTrace(message.sessionId, message.line);
        return false;

      case 'RECORDING_FAILED':
        void onRecordingFailed(message.sessionId, message.error);
        return false;

      default:
        return false;
    }
  });

  // A recording is bound to one tab. If that tab goes away, finish cleanly rather
  // than leaving the badge on and the offscreen document running forever.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void getRecordingState().then((state) => {
      if (state?.tabId === tabId) void stopRecording();
    });
  });
});

async function startRecording(): Promise<{ sessionId: string }> {
  const existing = await getRecordingState();
  if (existing) throw new Error('A recording is already in progress.');

  const tab = await activeTab();
  if (!tab.id) throw new Error('No active tab to record.');
  if (!tab.url || /^(chrome|edge|about|chrome-extension):/.test(tab.url)) {
    throw new Error('Browser-internal pages cannot be recorded.');
  }

  // Must be called from the worker, and only redeemable by this extension.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const sessionId = newSessionId();
  const startedAt = Date.now();

  await putSession(blankSession(sessionId, startedAt, await environment(tab)));
  await setRecordingState({ sessionId, tabId: tab.id, startedAt, streamId });
  await appendTrace(sessionId, 'worker', `stream id acquired for tab ${tab.id}`);

  // Hand the parameters over through storage *before* the document exists, so there is
  // no window in which a message could be sent to a listener that has not registered
  // yet. See the note on `setPendingCapture`.
  // Watch for the recorder's confirmation before the document exists, so a fast start
  // cannot be missed.
  const started = waitForStart(sessionId);

  const created = await ensureOffscreenDocument();
  await appendTrace(
    sessionId,
    'worker',
    created ? 'offscreen document created' : 'offscreen document already open, nudging',
  );
  if (!created) {
    // Already open from a previous recording, so it will not re-read state on its own.
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PICKUP' }).catch(() => {
      // A dropped nudge is not fatal; the document re-reads state on load.
    });
  }

  // Do not report success until the recorder actually confirms. Without this the popup
  // shows REC and the tester records a bug into a recorder that never started — which
  // is precisely the failure that wasted a day here.
  if (!(await started)) {
    // Ask Chrome directly whether the document exists. Combined with the absence of any
    // `offscreen:` trace line this separates "the document was never created" from "the
    // document exists but its script did not run" — different bugs, same symptom.
    await appendTrace(sessionId, 'worker', `offscreen contexts: ${await describeOffscreen()}`);
    await appendTrace(sessionId, 'worker', `load probe: ${await describeProbe()}`);
    await onRecordingFailed(
      sessionId,
      'The offscreen recorder never confirmed it started within 4s. The offscreen ' +
        'document has been left open — inspect it now via chrome://extensions → ' +
        'Inspect views → offscreen.html.',
      { keepOffscreen: true },
    );
    throw new Error('Recorder failed to start.');
  }

  console.info(`[qa-bug-reporter] recording ${sessionId} on tab ${tab.id}`);
  await setBadge('REC', '#d92d20');
  return { sessionId };
}

async function stopRecording(): Promise<{ sessionId: string | null }> {
  const state = await getRecordingState();
  if (!state) return { sessionId: null };

  await updateSession(state.sessionId, (session) => {
    session.status = 'stopped';
    session.stoppedAt = Date.now();
  });
  await appendTrace(state.sessionId, 'worker', 'stop requested');

  // The offscreen document writes the video to IndexedDB itself and replies
  // RECORDING_SAVED; the blob cannot travel through sendMessage (JSON serialisation).
  // A rejection here must not strand the recording state, or the next Record attempt
  // is refused as "already in progress".
  try {
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
  } catch (error) {
    await appendTrace(state.sessionId, 'worker', `stop message failed: ${errorText(error)}`);
  }
  await clearRecordingState();
  await setBadge('', '#000000');

  return { sessionId: state.sessionId };
}

async function onRecordingSaved(sessionId: string, bytes: number): Promise<void> {
  console.info(`[qa-bug-reporter] saved ${sessionId} (${(bytes / 1_048_576).toFixed(1)} MB)`);
  await closeOffscreenDocument();
}

/**
 * Resolve when the recorder confirms it started, or false if it never does.
 *
 * The listener is attached before the offscreen document is created so a fast
 * confirmation cannot arrive before anyone is watching for it.
 */
function waitForStart(sessionId: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      chrome.runtime.onMessage.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (message: OffscreenReply) => {
      if (message.sessionId !== sessionId) return;
      if (message.type === 'RECORDING_STARTED') done(true);
      else if (message.type === 'RECORDING_FAILED') done(false);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.runtime.onMessage.addListener(listener);
  });
}

/** Diagnostics forwarded from the offscreen document, which has no durable console. */
async function onOffscreenTrace(sessionId: string, line: string): Promise<void> {
  console.info(`[qa-bug-reporter] offscreen: ${line}`);
  await appendTrace(sessionId, 'offscreen', line);
}

/**
 * Whether the offscreen document's classic load probe ran.
 *
 * Present means the document loaded and executes scripts, so the fault is in the
 * recorder module. Absent means the document never ran anything at all.
 */
async function describeProbe(): Promise<string> {
  const stored = await chrome.storage.session.get('offscreenProbe');
  const probe = stored['offscreenProbe'] as { at: number; url: string } | undefined;
  if (!probe) return 'never ran — the document executed no scripts';
  return `ran ${Date.now() - probe.at}ms ago at ${probe.url}`;
}

/** What Chrome reports about the offscreen document, for the failure trace. */
async function describeOffscreen(): Promise<string> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length === 0) return 'none — the document does not exist';
    return contexts.map((c) => `${c.contextType} ${c.documentUrl}`).join(", ");
  } catch (error) {
    return `query failed: ${errorText(error)}`;
  }
}

async function onRecordingFailed(
  sessionId: string,
  error: string,
  options: { keepOffscreen?: boolean } = {},
): Promise<void> {
  console.error(`[qa-bug-reporter] recording failed for ${sessionId}: ${error}`);
  // Record the reason on the session itself, so the review page can explain the empty
  // recording rather than leaving the tester to guess.
  await updateSession(sessionId, (session) => {
    session.error = error;
    session.status = 'stopped';
    session.stoppedAt ??= Date.now();
  });
  await clearRecordingState();
  await setBadge('ERR', '#d92d20');
  // Left open deliberately on a start failure: its console is the only place the
  // module-load error would appear, and closing it destroys that evidence.
  if (!options.keepOffscreen) await closeOffscreenDocument();
}

async function popupState(): Promise<PopupState> {
  const state = await getRecordingState();
  const sessions = await listSessions();
  return {
    recording: state !== null,
    elapsedMs: state ? Date.now() - state.startedAt : 0,
    sessionCount: sessions.length,
  };
}

function blankSession(id: string, startedAt: number, env: EnvironmentInfo): Session {
  return {
    id,
    status: 'recording',
    startedAt,
    env,
    events: [],
    console: [],
    network: [],
    keyframes: [],
    trace: [],
  };
}

async function environment(tab: chrome.tabs.Tab): Promise<EnvironmentInfo> {
  return {
    url: tab.url ?? '',
    title: tab.title ?? '',
    userAgent: navigator.userAgent,
    viewport: { width: tab.width ?? 0, height: tab.height ?? 0 },
    devicePixelRatio: 1, // refined by the content script once it reports in
    recordedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  return tab;
}

/**
 * Create the offscreen document if it is not already open.
 *
 * @returns true if this call created it, false if one was already open.
 */
async function ensureOffscreenDocument(): Promise<boolean> {
  if (await chrome.offscreen.hasDocument()) return false;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Recording the active tab with MediaRecorder, which the service worker cannot host.',
  });
  return true;
}

async function closeOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

async function setBadge(text: string, color: string): Promise<void> {
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
