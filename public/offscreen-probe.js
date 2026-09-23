/**
 * Load probe for the offscreen document. Deliberately a *classic* script with no
 * imports, served verbatim from `public/`.
 *
 * The recorder itself is an ES module that imports two chunks. If a module fails to
 * load — a bad specifier, a CSP rule, anything — no code in it runs and no error
 * reaches any console the tester can reach. That looks identical to the document never
 * being created at all.
 *
 * This script shares none of those dependencies, so a marker here means the document
 * loaded and executed scripts; its absence means it did not. One bit, but it splits the
 * remaining suspects cleanly in half.
 */
chrome.storage.session
  .set({ offscreenProbe: { at: Date.now(), url: location.href } })
  .catch(() => {});
