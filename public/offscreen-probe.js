/**
 * Load probe for the offscreen document. A *classic* script with no imports, served
 * verbatim from `public/`.
 *
 * It reports through two independent channels — `chrome.storage.local` and a runtime
 * message — and swallows nothing. An earlier version wrote only to
 * `chrome.storage.session` and caught its own errors, so a throw there was
 * indistinguishable from the script never running. That ambiguity is the whole reason
 * this file exists, so it must not reintroduce it.
 */
(function probe() {
  var info = { at: Date.now(), url: location.href, errors: [] };

  try {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_PROBE', info: info });
  } catch (error) {
    info.errors.push('sendMessage: ' + error.message);
  }

  try {
    chrome.storage.local.set({ offscreenProbe: info });
  } catch (error) {
    info.errors.push('storage.local: ' + error.message);
    console.error('[qa-bug-reporter] probe could not write storage.local', error);
  }

  // Deliberately separate: this is the API suspected of being unavailable here, and
  // the point is to learn whether it throws — not to depend on it.
  try {
    chrome.storage.session.set({ offscreenProbeSession: info });
  } catch (error) {
    console.error('[qa-bug-reporter] storage.session is NOT available here', error);
  }

  console.info('[qa-bug-reporter] offscreen probe ran', info);
})();
