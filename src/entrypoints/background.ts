/**
 * Service worker: orchestrates a recording session.
 *
 * Holds no state of its own. MV3 terminates this worker after roughly 30 seconds
 * idle while the offscreen document keeps recording, so live state goes to
 * `chrome.storage.session` and captured data goes straight to IndexedDB.
 */
import type {
  CaptureMessage,
  CaptureStatus,
  ContentMessage,
  OffscreenReply,
  PopupMessage,
  PopupState,
} from '@/core/messages';
import { captureKeyframe, MIN_CAPTURE_INTERVAL_MS } from '@/core/keyframes';
import { isBlockedHost, scrubUrl } from '@/core/events/redact';
import { getSettings } from '@/core/settings';
import {
  clearRecordingState,
  getRecordingState,
  setRecordingState,
} from '@/core/recording-state';
import { appendTrace, listSessions, putSession, updateSession } from '@/core/storage/db';
import {
  newSessionId,
  type EnvironmentInfo,
  type InteractionEvent,
  type Session,
} from '@/core/session';

const OFFSCREEN_PATH = 'offscreen.html';

/** Probe report from the offscreen document's classic load script. */
interface ProbeInfo {
  at: number;
  url: string;
  errors: string[];
  /** Which `chrome.*` APIs that context actually had. Absent from older reports. */
  apis?: { runtime: boolean; storage: boolean; storageSession: boolean };
}

/**
 * Where the worker keeps the last probe report.
 *
 * The *worker* writes this, not the probe. An offscreen document is granted
 * `chrome.runtime` and nothing else, so its own `chrome.storage.local.set` could never
 * have worked — which meant nothing ever wrote this key and `describeProbe` reported
 * "never ran" every single time, in exactly the failure it exists to explain.
 */
const PROBE_KEY = 'offscreenProbe';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((
    message: PopupMessage | OffscreenReply | ContentMessage,
    _sender,
    sendResponse,
  ) => {
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

      case 'EVENTS':
        void onEvents(message.sessionId, message.events, _sender);
        return false;

      case 'CONSOLE':
        void updateSession(message.sessionId, (session) => {
          session.console.push(...message.entries);
        });
        return false;

      case 'NETWORK':
        void updateSession(message.sessionId, (session) => {
          session.network.push(...message.entries);
        });
        return false;

      case 'AM_I_RECORDED':
        void captureStatus(_sender).then(sendResponse);
        return true;

      case 'OFFSCREEN_PROBE':
        void onOffscreenProbe(message.info);
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

  // Navigations within the recorded tab. The content script reports its own load, but
  // only this sees a navigation that replaces the page before a script can run.
  chrome.webNavigation.onCommitted.addListener(async ({ tabId, url, frameId, transitionType }) => {
    if (frameId !== 0) return; // top frame only; subframe loads are noise
    const state = await getRecordingState();
    if (!state || state.tabId !== tabId) return;

    if (isBlockedHost(url, state.redaction)) {
      await onBlockedNavigation(state.sessionId, url);
      return;
    }

    await updateSession(state.sessionId, (session) => {
      session.events.push({
        t: Math.max(0, Date.now() - session.startedAt),
        type: 'navigate',
        label: `navigated to ${scrubUrl(url)} (${transitionType})`,
      });
    });
  });

  /**
   * Requests that failed in ways the page's own code cannot see — subresource 404s,
   * CORS rejections, blocked requests. The MAIN-world probe covers fetch and XHR; this
   * covers everything else.
   */
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.statusCode < 400) return;
      void recordNetworkFailure(details.tabId, {
        method: details.method,
        url: scrubUrl(details.url),
        status: details.statusCode,
      });
    },
    { urls: ['<all_urls>'] },
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      void recordNetworkFailure(details.tabId, {
        method: details.method,
        url: scrubUrl(details.url),
        status: null,
        error: details.error,
      });
    },
    { urls: ['<all_urls>'] },
  );
});

async function startRecording(): Promise<{ sessionId: string }> {
  const existing = await getRecordingState();
  if (existing) throw new Error('A recording is already in progress.');

  const tab = await activeTab();
  if (!tab.id) throw new Error('No active tab to record.');
  if (!tab.url || /^(chrome|edge|about|chrome-extension):/.test(tab.url)) {
    throw new Error('Browser-internal pages cannot be recorded.');
  }

  // Checked before the stream id is acquired, so a blocked host never reaches a capture
  // API at all — the refusal is the whole point of the setting, and a stream acquired
  // and then dropped is a worse implementation of it than one never asked for.
  const settings = await getSettings();
  if (isBlockedHost(tab.url, settings.redaction)) {
    throw new Error(
      `${hostOf(tab.url)} is on the blocked-hosts list in Settings, so it cannot be ` +
        'recorded. Remove it there if this was not intended.',
    );
  }

  // Must be called from the worker, and only redeemable by this extension.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const sessionId = newSessionId();
  const startedAt = Date.now();

  await putSession(blankSession(sessionId, startedAt, await environment(tab)));
  await setRecordingState({
    sessionId,
    tabId: tab.id,
    startedAt,
    streamId,
    redaction: settings.redaction,
  });
  await appendTrace(sessionId, 'worker', `stream id acquired for tab ${tab.id}`);

  // Hand the parameters over through storage *before* the document exists, so there is
  // no window in which a message could be sent to a listener that has not registered
  // yet. See the note on `setPendingCapture`.
  // Watch for the recorder's confirmation before the document exists, so a fast start
  // cannot be missed.
  const started = waitForStart(sessionId);

  // A document carrying stale parameters in its URL is useless, so always start from a
  // fresh one. They are cheap, and only one may exist at a time.
  await closeOffscreenDocument();
  await createOffscreenDocument(sessionId, streamId);
  await appendTrace(sessionId, 'worker', 'offscreen document created with capture params');

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

  // Content scripts are already loaded and idle; tell them a recording has begun.
  await tellTab(tab.id, {
    type: 'CAPTURE_START',
    sessionId,
    startedAt,
    redaction: settings.redaction,
  });

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

  // Ask the content scripts to flush whatever they have buffered before we finish.
  await tellTab(state.tabId, { type: 'CAPTURE_STOP' });

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

/**
 * Stop a recording whose tab has navigated onto a blocked host.
 *
 * **This fires on `onCommitted`, which is after the navigation has already happened.**
 * MV3 removed blocking `webRequest`, so there is no hook that runs first — the blocklist
 * can refuse to *start* a recording on a blocked host and can stop one that arrives
 * there, but it cannot promise the page was never captured. The final moments of the
 * video may show it. Said plainly here and in `docs/privacy.md`, because a redaction
 * feature that overstates itself is worse than one that does not exist.
 *
 * The recording is kept rather than deleted. The part before the navigation is the part
 * the tester wanted, and silently destroying their session is a worse outcome than the
 * one being avoided — so the reason goes on the session, where the review page already
 * knows how to show it.
 */
async function onBlockedNavigation(sessionId: string, url: string): Promise<void> {
  const host = hostOf(url);
  console.warn(`[qa-bug-reporter] stopping ${sessionId}: navigated to blocked host ${host}`);
  await appendTrace(sessionId, 'worker', `blocked host reached: ${host}`);
  await stopRecording();
  await updateSession(sessionId, (session) => {
    session.error =
      `Recording stopped: the tab navigated to ${host}, which is on the blocked-hosts ` +
      'list in Settings. Everything captured before that point has been kept — but ' +
      'because a navigation cannot be intercepted before it commits, the end of the ' +
      'video may show that page.';
  });
}

/** Hostname for a message to a tester, or the raw value if it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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
      if (message.type === 'RECORDING_STARTED' && message.sessionId === sessionId) done(true);
      else if (message.type === 'RECORDING_FAILED' && message.sessionId === sessionId) done(false);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.runtime.onMessage.addListener(listener);
  });
}

/**
 * Store a batch of interactions, and take a screenshot if one is due.
 *
 * Keyframes are tied to clicks and submissions rather than a timer: the interesting
 * moments in a bug are the ones where the tester did something.
 */
async function onEvents(
  sessionId: string,
  events: InteractionEvent[],
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  await updateSession(sessionId, (session) => {
    session.events.push(...events);
  });

  const worthShooting = events.find((e) => e.type === 'click' || e.type === 'submit');
  if (worthShooting && sender.tab?.windowId !== undefined) {
    await maybeCapture(sessionId, sender.tab.windowId, worthShooting);
  }
}

/** Timestamp of the last screenshot, to respect Chrome's capture rate limit. */
let lastCaptureAt = 0;

async function maybeCapture(
  sessionId: string,
  windowId: number,
  trigger: InteractionEvent,
): Promise<void> {
  if (Date.now() - lastCaptureAt < MIN_CAPTURE_INTERVAL_MS) return;
  lastCaptureAt = Date.now();

  const blob = await captureKeyframe(windowId);
  if (!blob) return;

  await updateSession(sessionId, (session) => {
    session.keyframes.push({ t: trigger.t, blob, caption: `${trigger.type} ${trigger.label}` });
  });
}

/**
 * Record a network failure observed by the browser rather than by the page.
 *
 * Deduplicated against what the MAIN-world probe already reported: a failed `fetch`
 * is seen by both, and the same 500 listed twice makes a report look unreliable.
 */
async function recordNetworkFailure(
  tabId: number,
  entry: { method: string; url: string; status: number | null; error?: string },
): Promise<void> {
  const state = await getRecordingState();
  if (!state || state.tabId !== tabId) return;

  await updateSession(state.sessionId, (session) => {
    const t = Math.max(0, Date.now() - session.startedAt);
    const duplicate = session.network.some(
      (existing) =>
        existing.url === entry.url &&
        existing.status === entry.status &&
        Math.abs(existing.t - t) < 2000,
    );
    if (!duplicate) session.network.push({ ...entry, t });
  });
}

/**
 * Send a message to every frame of a tab, ignoring frames with no listener.
 *
 * A tab showing a page the content script could not be injected into is normal, not an
 * error, so a rejection here is swallowed deliberately.
 */
async function tellTab(tabId: number, message: CaptureMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // No receiver in that tab; nothing to do.
  }
}

/** Tell a content script whether its tab is being recorded, and from when. */
async function captureStatus(sender: chrome.runtime.MessageSender): Promise<CaptureStatus> {
  const state = await getRecordingState();
  if (!state || sender.tab?.id !== state.tabId) return { recording: false };
  return {
    recording: true,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    redaction: state.redaction,
  };
}

/** Diagnostics forwarded from the offscreen document, which has no durable console. */
async function onOffscreenTrace(sessionId: string, line: string): Promise<void> {
  console.info(`[qa-bug-reporter] offscreen: ${line}`);
  await appendTrace(sessionId, 'offscreen', line);
}

/**
 * Persist the probe report, because the probe itself cannot.
 *
 * `chrome.runtime` is the only API an offscreen document is granted, so the message is
 * the whole channel. Storing it here is what makes `describeProbe` able to answer at
 * all — and it must survive the worker restarting between the probe arriving and a
 * failure being diagnosed, which is why it goes to `storage.local` rather than a
 * module variable.
 */
async function onOffscreenProbe(info: ProbeInfo): Promise<void> {
  console.info('[qa-bug-reporter] offscreen probe reported in', info);
  await chrome.storage.local.set({ [PROBE_KEY]: info });
}

/**
 * Whether the offscreen document's classic load probe ran.
 *
 * Present means the document loaded and executes scripts, so the fault is in the
 * recorder module rather than in the document ever existing.
 *
 * Absent is **not** proof the document ran nothing. The report arrives by runtime
 * message, so it is also absent when the message could not be delivered — a worker that
 * was asleep, or a document torn down before its first script finished. The wording says
 * what is known rather than concluding; the previous version asserted "the document
 * executed no scripts" and, because nothing ever wrote this key, said it every time.
 */
async function describeProbe(): Promise<string> {
  const local = await chrome.storage.local.get(PROBE_KEY);
  const probe = local[PROBE_KEY] as ProbeInfo | undefined;
  if (!probe) {
    return 'no report — either the document ran no scripts, or its message never arrived';
  }

  const apis = probe.apis
    ? ` apis=[runtime:${probe.apis.runtime} storage:${probe.apis.storage}]`
    : '';
  const errors = probe.errors.length > 0 ? ` errors=[${probe.errors.join('; ')}]` : '';
  return `ran ${Date.now() - probe.at}ms ago at ${probe.url}${apis}${errors}`;
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
 * Create the offscreen document, passing the capture parameters in its URL.
 *
 * The parameters ride along with the document itself rather than arriving separately by
 * message or storage read. Both of those have to happen at the right moment against an
 * API that has to be available; a query string just is.
 */
async function createOffscreenDocument(sessionId: string, streamId: string): Promise<void> {
  const url = `${OFFSCREEN_PATH}?session=${encodeURIComponent(sessionId)}&stream=${encodeURIComponent(streamId)}`;
  await chrome.offscreen.createDocument({
    url,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Recording the active tab with MediaRecorder, which the service worker cannot host.',
  });
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
