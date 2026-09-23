/**
 * Popup: start and stop a recording, and reach the recordings list.
 *
 * Plain TypeScript — this is three controls and a timer, and the popup is torn down
 * every time it closes, so a framework would cost more than it saves. The review
 * page is where React earns its place.
 */
import type { PopupMessage, PopupState } from '@/core/messages';
import { formatOffset } from '@/core/session';

const el = {
  status: document.querySelector<HTMLHeadingElement>('#status')!,
  dot: document.querySelector<HTMLSpanElement>('#dot')!,
  timer: document.querySelector<HTMLParagraphElement>('#timer')!,
  error: document.querySelector<HTMLParagraphElement>('#error')!,
  record: document.querySelector<HTMLButtonElement>('#record')!,
  sessions: document.querySelector<HTMLButtonElement>('#sessions')!,
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

el.sessions.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('/review.html') });
  window.close();
});

void refresh();
