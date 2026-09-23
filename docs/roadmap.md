# Roadmap

Each phase leaves the tool usable. A phase is not done until its documentation is
updated and its verification steps pass on a real device.

## Phase 0 — Scaffold · **built**

WXT + TypeScript + Tailwind, manifest with the full permission set, four entrypoints
building clean.

**Verify:** `npm run compile` and `npm run build` both succeed; the extension loads
unpacked and the popup opens.

## Phase 1 — Recording · **built, pending device check**

Tab capture through an offscreen `MediaRecorder`, video into IndexedDB, REC badge,
recordings list with playback.

**Verify:**
1. Record 30s on a real page, stop, play it back from the recordings list.
2. Start a recording and leave the tab idle for 2+ minutes. Watch the service worker go
   inactive on `chrome://extensions`. Recording must survive and Stop must still produce
   a video. *(This is the MV3 worker-death test — the most important one here.)*
3. Confirm the tab's own audio is still audible while recording.
4. Confirm `chrome://` pages are refused with a clear message.

## Phase 2 — Event capture and deterministic report · not started

Content scripts capture interactions, console output and failed requests; the worker
adds navigations and keyframes. Rendered to Markdown with no model involved.

The two modules that carry the output quality:

- **`labeller.ts`** — accessible name first (`aria-label` → trimmed text → `alt` →
  `title` → `placeholder` → associated `<label>`), then role, then nearest landmark for
  context. This turns `div.css-1x2y3` into *"the 'Submit prescription' button in the
  Order Details panel"*. Everything downstream reads better because of it.
- **`selector.ts`** — `data-testid` → `id` → stable attribute path. Not needed for the
  report, but it makes the log a starting point for a regression test.

**Verify:** reproduce a known bug, then read the Markdown. Do the steps match what you
actually did? Do the element names read like a human wrote them?

**Already a working bug-report tool at this point.**

## Phase 3 — Claude report generation · not started

Structured log + keyframes → `claude-opus-5` → schema-validated report.

**Verify:** are there steps in the report you did *not* perform? Does `expected_result`
restate your note rather than inventing a spec? Trigger a deliberate console error and
confirm it lands in `evidence`.

**Spike first:** calling the Anthropic API directly from an MV3 worker. Host permissions
should bypass CORS, but confirm this on day one — before any UI is built around it.

## Phase 4 — Review page and Jira export · not started

Video beside a step timeline, every field editable, screenshot gallery with per-image
delete, copy-as-Markdown, and Jira issue creation with attachments.

Jira REST **v2**, not v3 — v3 requires Atlassian Document Format, and writing an ADF
serialiser buys nothing here.

**Verify:** click each step, confirm the video seeks correctly. Export to a Jira test
project; confirm video and screenshots attach and the description renders.

**Watch:** Jira's default attachment limit is 10MB and a two-minute recording can exceed
it. Show the file size before upload and offer "trim to last 30s".

## Phase 5 — Redaction and hardening · not started

Required scope, not polish. Recordings will contain customer data.

- Never record password or `cc-*` / `current-password` / `new-password` field values.
- Log *shape*, not content, by default: *"typed 14 characters into the 'Email' field"*.
  Values only for explicitly allowlisted fields.
- Heuristic scrub for emails, phone numbers, long digit runs.
- Per-domain blocklist — domains the extension refuses to record.
- Redaction runs **before** the IndexedDB write, so unredacted values never sit at rest.

**Verify:** record a form with a password and a fake email, then inspect the IndexedDB
record directly in DevTools. The password must be absent and the email masked *at rest*.

## Phase 6 — Stretch

- **Rolling buffer** — continuously hold the last 60s, so you can capture a bug *after*
  it happens. The single feature that would most change how this tool feels to use.
- Source-map-aware stack traces.
- Confluence export.
- Optional `chrome.debugger` deep capture.
