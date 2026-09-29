/**
 * Load probe for the offscreen document. A *classic* script with no imports, served
 * verbatim from `public/`.
 *
 * It answers one question: did this document execute scripts at all? That matters
 * because "the recorder never confirmed it started" has two very different causes — the
 * document was never created, or it was created and its module failed to load — and
 * they are indistinguishable from the worker without a signal from inside.
 *
 * **`chrome.runtime` is the only channel available here.** An earlier version of this
 * file also wrote `chrome.storage.local` and `chrome.storage.session`, on the assumption
 * that the declared `storage` permission applied. It does not: an offscreen document is
 * granted `chrome.runtime` and nothing else, so `chrome.storage` is `undefined` and both
 * writes threw. The throws were caught, but they were also logged with `console.error`,
 * which is what surfaces as a red entry on `chrome://extensions` — three of them per
 * recording, on the page QA spends its day in, all meaning "a diagnostic learned
 * something".
 *
 * So availability is now *detected and reported as a fact*, never thrown and never
 * logged as an error. The worker persists what arrives; see `onOffscreenProbe`.
 */
(function probe() {
  var info = {
    at: Date.now(),
    url: location.href,
    errors: [],
    // What this context actually has. Recorded every run rather than assumed, because
    // the set of APIs offscreen documents are granted is a Chrome policy that has
    // changed before and can change again — and a stale assumption in a diagnostic is
    // worse than no diagnostic.
    apis: {
      runtime: typeof chrome !== 'undefined' && !!chrome.runtime,
      storage: typeof chrome !== 'undefined' && !!chrome.storage,
      storageSession:
        typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.session,
    },
  };

  if (!info.apis.storage) {
    info.errors.push('chrome.storage is not available in an offscreen document');
  }

  try {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROBE', info: info });
  } catch (error) {
    // The one genuine failure left: no way to report, so the console is all there is.
    // If this fires, the document ran but cannot talk to the worker at all.
    info.errors.push('sendMessage: ' + error.message);
    console.error('[qa-bug-reporter] offscreen probe could not reach the worker', error);
  }

  console.info('[qa-bug-reporter] offscreen probe ran', info);
})();
