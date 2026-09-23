# Changelog

## Unreleased

### Fixed
- Recordings saved no video and the review page rendered blank. The video blob was sent
  from the offscreen document to the service worker via `chrome.runtime.sendMessage`,
  which serialises as JSON and reduces a Blob to `{}` without raising — the review page
  then threw in `URL.createObjectURL` and React unmounted the root. The offscreen
  document now writes the video to IndexedDB directly and messages only a session id.
- The review page no longer blanks on a malformed record: it guards `instanceof Blob`
  and is wrapped in an error boundary that shows the failure.

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
