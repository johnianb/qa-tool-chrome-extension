/**
 * Popup: start and stop a recording, and reach the recordings list.
 *
 * Plain TypeScript — this is three controls and a timer, and the popup is torn down
 * every time it closes, so a framework would cost more than it saves. The review
 * page is where React earns its place.
 */
import type { PopupMessage, PopupState } from '@/core/messages';
import { formatOffset } from '@/core/session';
import { PROVIDER_NAMES, getSettings, hasApiKey, hasJira } from '@/core/settings';

const el = {
  status: document.querySelector<HTMLHeadingElement>('#status')!,
  dot: document.querySelector<HTMLSpanElement>('#dot')!,
  timer: document.querySelector<HTMLParagraphElement>('#timer')!,
  error: document.querySelector<HTMLParagraphElement>('#error')!,
  record: document.querySelector<HTMLButtonElement>('#record')!,
  sessions: document.querySelector<HTMLButtonElement>('#sessions')!,
  settings: document.querySelector<HTMLButtonElement>('#settings')!,
  config: document.querySelector<HTMLSpanElement>('#config')!,
};

let state: PopupState = { recording: false, elapsedMs: 0, sessionCount: 0 };
let ticker: number | undefined;

async function send<T>(message: PopupMessage): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

function showError(text: string): void {
  el.error.textContent = text;
  el.error.hidden = false;
}

function clearError(): void {
  el.error.hidden = true;
}

function render(): void {
  el.dot.classList.toggle('live', state.recording);
  el.status.textContent = state.recording ? 'Recording' : 'Ready';
  el.timer.hidden = !state.recording;
  el.timer.textContent = formatOffset(state.elapsedMs);

  el.record.textContent = state.recording ? 'Stop and write report' : 'Record this tab';
  el.record.classList.toggle('stop', state.recording);

  el.sessions.textContent =
    state.sessionCount > 0 ? `Recordings (${state.sessionCount})` : 'Recordings';
  el.sessions.hidden = state.sessionCount === 0;
}

/** Tick locally between refreshes so the timer reads smoothly. */
function startTicker(): void {
  stopTicker();
  ticker = window.setInterval(() => {
    if (!state.recording) return;
    state.elapsedMs += 1000;
    render();
  }, 1000);
}

function stopTicker(): void {
  if (ticker !== undefined) window.clearInterval(ticker);
  ticker = undefined;
}

async function refresh(): Promise<void> {
  state = await send<PopupState>({ type: 'GET_STATE' });
  render();
  if (state.recording) startTicker();
  else stopTicker();
}

el.record.addEventListener('click', async () => {
  clearError();
  el.record.disabled = true;
  try {
    const result = await send<{ error?: string }>({
      type: state.recording ? 'STOP_RECORDING' : 'START_RECORDING',
    });
    if (result?.error) {
      showError(result.error);
    } else if (state.recording) {
      // Stopping is the end of the popup's job; the review page takes over.
      window.close();
      return;
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    el.record.disabled = false;
    await refresh();
  }
});

/**
 * Open the review page, focusing the one that is already open rather than stacking tabs.
 *
 * Settings is a thing people click more than once — twice to check a key, again after
 * pasting a token — and `tabs.create` every time leaves a row of identical tabs. The
 * existing tab is reused and re-navigated so the hash still takes effect.
 */
async function openReview(hash = ''): Promise<void> {
  const url = chrome.runtime.getURL(`/review.html${hash}`);
  const [open] = await chrome.tabs.query({ url: chrome.runtime.getURL('/review.html') });

  if (open?.id !== undefined) {
    await chrome.tabs.update(open.id, { url, active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

el.sessions.addEventListener('click', () => void openReview());

// `#settings` tells the review page to open the panel expanded, so this lands on the
// fields rather than on a page where Settings must be found first.
el.settings.addEventListener('click', () => void openReview('#settings'));

/**
 * What is configured, in the place where "why was no report written?" gets asked.
 *
 * The model and Jira are reported separately because they fail differently: without a
 * model key nothing is written at all, while Jira being unset costs only the export —
 * Copy report still works. Saying "not configured" for both would overstate the second.
 *
 * The selected provider is named rather than "the model": a tester who has switched to
 * Gemini and sees "Claude not set up" would go looking for a key they already have.
 */
async function showConfig(): Promise<void> {
  const settings = await getSettings();
  const model = PROVIDER_NAMES[settings.provider];
  const configured = hasApiKey(settings);
  const jira = hasJira(settings);

  el.config.textContent = configured
    ? `${model} ✓ · Jira ${jira ? '✓' : 'off'}`
    : `${model} not set up`;
  el.settings.textContent = configured ? 'Settings' : 'Set up';
}

void refresh();
void showConfig();
