# Changelog

## Unreleased

### Gemini as a second report provider
- **Reports can be written by Gemini as well as Claude**, chosen in Settings. The reason
  is not model preference: neither a Claude Pro nor a Gemini Pro subscription includes
  API access, and Google's AI Studio issues a **free-tier** key while Anthropic's API
  needs prepaid credits. For a tester who has neither, that is the difference between a
  tool that works and one that does not.
- `ai.ts` is the seam. Both providers export the same two functions, throw the same
  `ReportError`, and ground their answer through the same `report-schema.ts` — the step
  numbering and the never-invented expected result are properties of this codebase, not
  of whichever model answered, and adding a provider must not make them negotiable.
- The **same Zod schema** drives both: `zodOutputFormat` for Claude, and JSON Schema in
  `response_format` for Gemini. The per-field descriptions are half the prompt, so a
  second hand-written copy of them would be a second prompt drifting quietly out of sync.
- Written against the Gemini REST API rather than `@google/genai`. It is one `fetch`
  with one header, and the review chunk is already the largest thing this extension
  ships.
- **Both keys are kept.** Switching provider does not clear the other one, so generating
  the same report twice and comparing costs a dropdown rather than a trip to a
  credentials page. Records written by the previous build — a flat `apiKey` and `model` —
  are folded into the Anthropic provider on read, and the flat fields are dropped on the
  next write so a credential is never stored twice.
- Exports now **name the model that wrote the report**. A Jira ticket that credits Claude
  for Gemini's work is a small lie a reader has no way to catch. Reports written before
  this change carry no writer and were all Claude's, which is what the fallback assumes.
- `docs/privacy.md` gains the part that matters at a healthcare company: Google's free
  tier permits prompts and responses to be used to improve their products, which the paid
  tiers do not. Screenshots are unredactable pixels — the free tier is for staging and
  seed data, not for a recording of production.

### Phase 4 — Review page editing and Jira export
- **Export to Jira.** Creates an issue through REST **v2** with the report as the
  description and the recording and screenshots attached, using the tester's own
  Atlassian API token. Runs in the review page for the same reason the Anthropic call
  does: a multi-megabyte upload outlives the MV3 worker, and an extension page's host
  permission is what makes a browser-side Jira client possible at all.
- `jira-markup.ts` is a **second renderer**, not a Markdown reuse. v2 takes Atlassian
  wiki markup, where headings are `h2.`, ordered lists are `#`, and `{`, `[` and `|`
  swallow the rest of a line. Posting Markdown produces an issue whose steps are one
  run-on paragraph — which reads, to everyone on the ticket, as the tool having got the
  steps wrong. Log lines go inside `{noformat}`, so a stack trace containing a brace
  cannot vanish into a malformed macro.
- **Attachments upload one request each.** One multipart body would be fewer round trips
  and strictly worse: Jira's default limit is 10 MB per file, a two-minute recording
  exceeds it, and a single rejected body would take the six screenshots down with the
  video. Attachment failures are *returned*, not thrown — by then the issue exists, and
  throwing would report a failed export while a real ticket sits in the project.
- Attachment sizes are shown **before** the button, not reported after a failure; the
  size is what decides what the tester does next. An over-limit video offers **trim to
  last 30s**, which re-encodes by replaying the tail through a `MediaRecorder` — a WebM
  cannot be cut with `Blob.slice`, and the corrupt file that produces is worse than no
  attachment. It therefore runs in real time, and the trimmed copy is used for the upload
  only; the stored recording is never overwritten.
- **Every report field is now editable**, including the steps. The rule that the model
  cannot invent a step constrains the model, not the person who performed them, and
  supplying the expected result the model was forbidden to guess at is what review is
  for. An edit that changes content sets `report.edited`; opening the editor and saving
  an untouched report does not, because that flag is a claim made to whoever reads the
  ticket.
- **Screenshot gallery with per-image delete.** Screenshots are the one capture redaction
  cannot touch, so deleting a frame removes it from the stored session — gone from the
  next report and the next export alike, not hidden from the page.
- The step timeline now follows the playhead, so watching the recording walks the list on
  its own.
- Jira settings live beside the Anthropic ones, with a **Test connection** that makes two
  calls: `/myself` proves the site, email and token, and `/project/{key}` proves the
  project exists and that token's account can read it — the likelier mistake, about which
  the first check says nothing. The site field accepts any Jira URL and reduces it to the
  origin, because nobody has the bare site root to hand.
- `docs/setup.md` and `docs/privacy.md` both cover Jira now. Privacy gained a column: the
  two outbound buttons are not equivalent, and a Jira ticket carrying the video is the
  largest disclosure this tool performs.

### Fixed
- `getSettings` merges the stored record over the defaults two levels deep. A shallow
  merge returned whatever nested `jira` object an older build wrote, so the first field
  added to `JiraSettings` would read `undefined` for every existing user — and
  `undefined` in a controlled React input silently switches it to uncontrolled, which
  presents as a form that will not accept typing.

### Phase 3 — Claude report generation
- Structured log + up to six keyframes → `claude-opus-5` → schema-validated report, via
  `messages.parse()` with `zodOutputFormat` so the response shape cannot be wrong.
- **The model cannot invent a step.** It receives the deterministic `toSteps()` list and
  returns step *numbers* plus a rewording of each; `atMs` is filled in from our own
  record. A fabricated step is unrepresentable rather than merely discouraged, and an
  index that does not exist is dropped in `groundReport()` before it reaches the report.
- Two further guarantees enforced in code, not in the prompt: with no tester note,
  `expectedResult` is *replaced* with a fixed "not stated" sentence whatever the model
  wrote — the tool has no spec and must not invent one; and console errors or failed
  requests the model omitted are appended to `evidence`, so a summary cannot quietly
  lose the one error in the recording.
- The API call runs in the **review page, not the service worker**, diverging from the
  roadmap. MV3 terminates the worker after ~30s idle and an Opus request with adaptive
  thinking can outlast it. An extension page shares the origin, so the
  `api.anthropic.com` host permission still bypasses CORS — the part the spike needed to
  prove — and it keeps the 531 kB of SDK out of the worker bundle, which stays at 12 kB.
- Settings panel: API key, model, and a screenshot toggle. The key lives in
  `chrome.storage.local`, never `sync` — replicating a credential across machines should
  not be a side effect of saving a form. **Test connection** makes the smallest real API
  request, answering "is the key good and can we get out?" without spending a report.
- A **What went wrong?** field, which finally writes `session.testerNote` — read in four
  places since Phase 2 and until now never set by anything, leaving the highest-value
  input to report quality unreachable.
- Free text is scrubbed on the way out: this is the first phase where data leaves the
  machine, so console text and the tester's note go through `scrubText` before sending.
  Screenshots cannot be scrubbed; the toggle is the only control, and `docs/privacy.md`
  says so plainly.
- Severity is accepted as a string and normalised. The SDK's schema transform demotes an
  enum to a field description rather than enforcing it, so "Major" is reachable — and
  discarding an otherwise good report over capitalisation would be absurd.
- `Copy report` now renders the written report when one exists, falling back to the
  deterministic rendering otherwise, and states whether a human has edited it.
- New: `docs/setup.md` and `docs/privacy.md`, both previously linked from the README and
  neither previously written.

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
