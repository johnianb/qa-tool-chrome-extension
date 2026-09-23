# Changelog

## Unreleased

### Fixed
- Recordings were saved and then silently erased. `updateSession` performed its get and
  put in separate IndexedDB transactions, so the offscreen document's video write and
  the service worker's trace append interleaved, and the later writer restored a stale
  copy — the diagnostic destroying the recording it was there to explain. Both now
  share one `readwrite` transaction.
- Capture parameters reach the offscreen document through its own URL rather than
  `chrome.storage.session`, which was unavailable in that context and failing silently.
- Recordings produced no video because `chrome.offscreen.createDocument()` resolves
  before the document's script runs, so the `OFFSCREEN_START` message was dropped with
  no listener registered and no error raised. Start parameters are now handed over
  through `chrome.storage.session` and claimed by the document on load, removing the
  race entirely.
- A failed recording now records why on the session and the review page shows it,
  instead of presenting an empty result with no explanation.
- Recordings saved no video and the review page rendered blank. The video blob was sent
  from the offscreen document to the service worker via `chrome.runtime.sendMessage`,
  which serialises as JSON and reduces a Blob to `{}` without raising — the review page
  then threw in `URL.createObjectURL` and React unmounted the root. The offscreen
  document now writes the video to IndexedDB directly and messages only a session id.
- The review page no longer blanks on a malformed record: it guards `instanceof Blob`
  and is wrapped in an error boundary that shows the failure.

### Phase 2 — Event capture and deterministic report
- Isolated-world content script capturing clicks, field changes, submissions,
  Enter/Escape/Tab, scrolling and navigation. Attaches nothing until a recording starts.
- MAIN-world probe patching `console`, `onerror`, `unhandledrejection`, `fetch` and
  `XMLHttpRequest`, reporting only failures. Chosen over `chrome.debugger`, which shows
  a debugging infobar and conflicts with DevTools being open.
- `chrome.webRequest` in the worker covers browser-level failures the page cannot see,
  deduplicated against what the probe already reported.
- Screenshot keyframes on clicks and submissions, downscaled in the worker via
  `OffscreenCanvas`, rate-limited under Chrome's capture quota.
- `labeller.ts` names elements the way a screen reader would; `selector.ts` builds
  refactor-resistant selectors; `redact.ts` describes a value's shape rather than its
  content and never records a sensitive field.
- Deterministic Markdown report, no model involved: condensed steps, environment,
  console errors and failed requests. Expected result is left for a human — the tool
  has no spec and must not invent one.
- Review page gained a step timeline where clicking a step seeks the video, and a
  "Copy report" button.

### Phase 1 — Recording
- Tab capture via `chrome.tabCapture` + an offscreen `MediaRecorder` (VP9, 720p,
  2.5 Mbps), with captured audio routed back to the speakers so recording does not
  silence the tab under test.
- Sessions persisted to IndexedDB; live recording state in `chrome.storage.session` so a
  recording survives service-worker termination.
- Popup with record/stop and an elapsed timer; REC badge on the toolbar icon.
- Review page listing recordings with video playback.
- Recording is refused on browser-internal pages, which Chrome does not permit capturing.

### Phase 0 — Scaffold
- WXT + TypeScript (strict) + React + Tailwind project.
- MV3 manifest with the capture, storage and export permission set.
- Vitest configured for the pure-logic modules.
- `README.md`, `docs/development.md`, `docs/architecture.md`, `docs/roadmap.md`.
