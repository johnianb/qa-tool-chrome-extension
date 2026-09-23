/**
 * MAIN-world probe: sees the page's own `console`, errors and network calls.
 *
 * Content scripts run in an isolated world with a separate `console` and separate
 * `fetch`, so they cannot observe the page's. `chrome.debugger` could, via CDP, but it
 * shows the "extension is debugging this browser" infobar on every recording and
 * conflicts with DevTools being open — which QA always has open. Patching in the main
 * world costs neither.
 *
 * What this cannot see — CSP violations, subresource 404s, CORS rejections — the
 * service worker picks up with `chrome.webRequest`.
 *
 * It has no access to `chrome.*`, so everything goes out by `window.postMessage` and
 * the isolated content script relays it.
 */
import { PROBE_MARKER, type ProbeMessage } from '@/core/messages';
import type { ConsoleEntry, NetworkEntry } from '@/core/session';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    const post = (message: ProbeMessage) => {
      try {
        window.postMessage(message, '*');
      } catch {
        // A value that cannot be cloned must never break the page it came from.
      }
    };

    const send = {
      console: (entry: Omit<ConsoleEntry, 't'>) =>
        post({ marker: PROBE_MARKER, kind: 'console', entry }),
      network: (entry: Omit<NetworkEntry, 't'>) =>
        post({ marker: PROBE_MARKER, kind: 'network', entry }),
    };

    // ---- console ---------------------------------------------------------------

    const LEVELS = ['log', 'info', 'warn', 'error'] as const;
    for (const level of LEVELS) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        // Call through first: the page's own logging must behave identically whether or
        // not this extension is installed.
        original(...args);
        if (level === 'log' || level === 'info') return; // too noisy to be evidence
        send.console({ level, text: args.map(stringify).join(' ') });
      };
    }

    window.addEventListener('error', (event) => {
      send.console({
        level: 'error',
        text: event.message || 'Uncaught error',
        stack: event.error instanceof Error ? event.error.stack : undefined,
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason as unknown;
      send.console({
        level: 'error',
        text: `Unhandled rejection: ${stringify(reason)}`,
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    });

    // ---- network ---------------------------------------------------------------

    /**
     * Only failures are reported. A successful request is noise; a 500 during the step
     * that broke is the single most useful line in a bug report.
     */
    const isFailure = (status: number) => status >= 400;

    const originalFetch = window.fetch;
    window.fetch = async function patchedFetch(...args: Parameters<typeof fetch>) {
      const started = performance.now();
      const method = methodOf(args);
      const url = urlOf(args);
      try {
        const response = await originalFetch.apply(this, args);
        if (isFailure(response.status)) {
          send.network({
            method,
            url,
            status: response.status,
            durationMs: Math.round(performance.now() - started),
          });
        }
        return response;
      } catch (error) {
        send.network({
          method,
          url,
          status: null,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Math.round(performance.now() - started),
        });
        throw error; // the page's own error handling must be unaffected
      }
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string; started: number }>();

    XMLHttpRequest.prototype.open = function patchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      meta.set(this, { method, url: String(url), started: 0 });
      // eslint-disable-next-line prefer-rest-params
      return originalOpen.apply(this, arguments as never);
    } as typeof XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest, ...args: unknown[]) {
      const info = meta.get(this);
      if (info) {
        info.started = performance.now();
        this.addEventListener('loadend', () => {
          const durationMs = Math.round(performance.now() - info.started);
          if (this.status === 0) {
            send.network({ method: info.method, url: info.url, status: null, error: 'request failed', durationMs });
          } else if (isFailure(this.status)) {
            send.network({ method: info.method, url: info.url, status: this.status, durationMs });
          }
        });
      }
      // eslint-disable-next-line prefer-rest-params
      return originalSend.apply(this, arguments as never);
    } as typeof XMLHttpRequest.prototype.send;

    // ---- helpers ---------------------------------------------------------------

    function methodOf(args: Parameters<typeof fetch>): string {
      const [input, init] = args;
      if (init?.method) return init.method.toUpperCase();
      if (input instanceof Request) return input.method.toUpperCase();
      return 'GET';
    }

    function urlOf(args: Parameters<typeof fetch>): string {
      const [input] = args;
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input instanceof Request) return input.url;
      return String(input);
    }

    /** Render a logged argument without ever throwing on a hostile object. */
    function stringify(value: unknown): string {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
    }
  },
});
