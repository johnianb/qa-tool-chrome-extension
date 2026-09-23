/**
 * Isolated-world content script: captures what the tester does.
 *
 * Attaches nothing until the worker says a recording has started, so an idle browser
 * is untouched — this matters both for performance and because capturing interactions
 * on pages nobody asked to record is not something a QA tool should do quietly.
 *
 * Also relays messages from the MAIN-world probe, which can see the page's `console`
 * and network calls but cannot reach `chrome.*`.
 */
import {
  PROBE_MARKER,
  type CaptureMessage,
  type CaptureStatus,
  type ProbeMessage,
} from '@/core/messages';
import type { ConsoleEntry, InteractionEvent, NetworkEntry } from '@/core/session';
import { labelElement, labelToPhrase } from '@/core/events/labeller';
import { buildSelector } from '@/core/events/selector';
import { DEFAULT_REDACTION, describeValue, scrubText } from '@/core/events/redact';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',

  main() {
    let session: { id: string; startedAt: number } | null = null;
    let events: InteractionEvent[] = [];
    let consoleEntries: ConsoleEntry[] = [];
    let networkEntries: NetworkEntry[] = [];
    let flushTimer: number | undefined;
    let detach: (() => void) | null = null;

    /** ms since the recording began — the clock everything downstream shares. */
    const at = () => (session ? Math.max(0, Date.now() - session.startedAt) : 0);

    const frameUrl = () => (window.top === window ? undefined : location.href);

    function record(event: Omit<InteractionEvent, 't' | 'frameUrl'>): void {
      if (!session) return;
      events.push({ ...event, t: at(), frameUrl: frameUrl() });
      scheduleFlush();
    }

    /**
     * Batch before sending. A click can fire several listeners and a scroll fires
     * constantly; one message per event would flood the worker and, worse, cause
     * needless writes to the session record.
     */
    function scheduleFlush(): void {
      if (flushTimer !== undefined) return;
      flushTimer = window.setTimeout(flush, 1000);
    }

    function flush(): void {
      flushTimer = undefined;
      if (!session) return;
      const id = session.id;

      if (events.length > 0) {
        void chrome.runtime.sendMessage({ type: 'EVENTS', sessionId: id, events }).catch(() => {});
        events = [];
      }
      if (consoleEntries.length > 0) {
        void chrome.runtime
          .sendMessage({ type: 'CONSOLE', sessionId: id, entries: consoleEntries })
          .catch(() => {});
        consoleEntries = [];
      }
      if (networkEntries.length > 0) {
        void chrome.runtime
          .sendMessage({ type: 'NETWORK', sessionId: id, entries: networkEntries })
          .catch(() => {});
        networkEntries = [];
      }
    }

    function describe(target: EventTarget | null): { label: string; selector?: string } {
      if (!(target instanceof Element)) return { label: 'the page' };
      return {
        label: labelToPhrase(labelElement(target)),
        selector: buildSelector(target),
      };
    }

    function startCapturing(): void {
      if (detach) return;

      const onClick = (event: Event) => {
        const { label, selector } = describe(event.target);
        record({ type: 'click', label, selector });
      };

      const onChange = (event: Event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const value = 'value' in target ? String((target as HTMLInputElement).value) : '';
        const { label, selector } = describe(target);
        record({
          type: 'change',
          label,
          selector,
          value: describeValue(target, value, DEFAULT_REDACTION),
        });
      };

      const onSubmit = (event: Event) => {
        const { label, selector } = describe(event.target);
        record({ type: 'submit', label, selector });
      };

      /**
       * Only keys that change what happens, never characters.
       *
       * Logging raw keystrokes would capture passwords typed into fields this script
       * never sees as fields — a keylogger is not an acceptable failure mode for a bug
       * reporting tool, so the character case is simply absent.
       */
      const onKeyDown = (event: KeyboardEvent) => {
        if (!['Enter', 'Escape', 'Tab'].includes(event.key)) return;
        const { label, selector } = describe(event.target);
        record({ type: 'key', label, selector, value: event.key });
      };

      let scrollTimer: number | undefined;
      const onScroll = () => {
        if (scrollTimer !== undefined) return;
        scrollTimer = window.setTimeout(() => {
          scrollTimer = undefined;
          record({ type: 'scroll', label: 'the page', value: `${Math.round(window.scrollY)}px` });
        }, 700);
      };

      // Capture phase: a page that calls stopPropagation on its own handlers would
      // otherwise hide the interaction from us entirely.
      const opts = { capture: true, passive: true } as const;
      window.addEventListener('click', onClick, opts);
      window.addEventListener('change', onChange, opts);
      window.addEventListener('submit', onSubmit, opts);
      window.addEventListener('keydown', onKeyDown, opts);
      window.addEventListener('scroll', onScroll, opts);

      const onProbe = (event: MessageEvent) => {
        const data = event.data as ProbeMessage | undefined;
        if (event.source !== window || data?.marker !== PROBE_MARKER) return;
        if (data.kind === 'console') {
          consoleEntries.push({ ...data.entry, t: at(), text: scrubText(data.entry.text) });
        } else {
          networkEntries.push({ ...data.entry, t: at() });
        }
        scheduleFlush();
      };
      window.addEventListener('message', onProbe);

      detach = () => {
        window.removeEventListener('click', onClick, opts);
        window.removeEventListener('change', onChange, opts);
        window.removeEventListener('submit', onSubmit, opts);
        window.removeEventListener('keydown', onKeyDown, opts);
        window.removeEventListener('scroll', onScroll, opts);
        window.removeEventListener('message', onProbe);
        if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
      };
    }

    function stopCapturing(): void {
      flush();
      detach?.();
      detach = null;
      session = null;
    }

    chrome.runtime.onMessage.addListener((message: CaptureMessage) => {
      if (message.type === 'CAPTURE_START') {
        session = { id: message.sessionId, startedAt: message.startedAt };
        startCapturing();
      } else if (message.type === 'CAPTURE_STOP') {
        stopCapturing();
      }
      return false;
    });

    // A page navigating mid-recording gets a fresh content script, which missed the
    // CAPTURE_START message. Ask instead of waiting to be told.
    void chrome.runtime
      .sendMessage({ type: 'AM_I_RECORDED' })
      .then((status: CaptureStatus | undefined) => {
        if (!status?.recording || !status.sessionId || status.startedAt === undefined) return;
        session = { id: status.sessionId, startedAt: status.startedAt };
        startCapturing();
        record({ type: 'navigate', label: `loaded ${location.pathname}` });
      })
      .catch(() => {
        // The worker may be asleep; CAPTURE_START will arrive if a recording starts.
      });

    // Flush whatever is buffered before the page goes away.
    window.addEventListener('pagehide', flush);
  },
});
