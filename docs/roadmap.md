# Roadmap

Each phase leaves the tool usable. A phase is not done until its documentation is
updated and its verification steps pass on a real device.

## Phase 0 — Scaffold · **built**

WXT + TypeScript + Tailwind, manifest with the full permission set, four entrypoints
building clean.

**Verify:** `npm run compile` and `npm run build` both succeed; the extension loads
unpacked and the popup opens.

## Phase 1 — Recording · **done**

Tab capture through an offscreen `MediaRecorder`, video into IndexedDB, REC badge,
recordings list with playback.

**Verify:**
1. Record 30s on a real page, stop, play it back from the recordings list.
2. Start a recording and leave the tab idle for 2+ minutes. Watch the service worker go
   inactive on `chrome://extensions`. Recording must survive and Stop must still produce
   a video. *(This is the MV3 worker-death test — the most important one here.)*
3. Confirm the tab's own audio is still audible while recording.
4. Confirm `chrome://` pages are refused with a clear message.

## Phase 2 — Event capture and deterministic report · **built, pending device check**

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

## Phase 3 — Claude report generation · **built, pending device check**

Structured log + up to six keyframes → `claude-opus-5` → schema-validated report, written
in the review page. Settings hold the tester's own API key; a "what went wrong?" field
finally writes `session.testerNote`, which four modules already read.

**The spike came out differently.** The call is in the **review page, not the service
worker**. The worker is terminated after ~30s idle and an Opus request with adaptive
thinking can outlast that; Chrome extends the lifetime for in-flight requests, but this is
the one call that costs money, and "usually survives" is not a foundation. An extension
page shares the origin, so the host permission still bypasses CORS — which was the part
that needed proving. It is provable in one click: **Settings → Test connection**.

**Steps cannot be invented, by construction.** The model returns step *numbers* from the
deterministic list and a rewording of each; `atMs` comes from our record. There is no
field in which a fabricated step could be expressed. See `report-schema.ts`.

**Verify:**
1. Record a bug, write a note, generate. Are there steps in the report you did *not*
   perform? (`groundReport` makes this structurally impossible — this check is for
   whether a *reworded* step changed meaning.)
2. Generate with the note left **empty**. `expectedResult` must read "Not stated — …",
   never a plausible invention.
3. Trigger a deliberate console error (`throw new Error('x')` in DevTools) mid-recording
   and confirm it lands in `evidence`.
4. Set a bad API key and confirm the failure names the key rather than showing a stack.

## Phase 4 — Review page and Jira export · **built, pending device check**

Video beside a step timeline that follows the playhead, every report field editable,
screenshot gallery with per-image delete, copy-as-Markdown, and Jira issue creation with
attachments.

Jira REST **v2**, not v3 — v3 requires Atlassian Document Format, and writing an ADF
serialiser buys nothing here. v2 takes a wiki-markup string and Atlassian converts it, so
`jira-markup.ts` is a second renderer beside `markdown.ts`: handing Jira Markdown produces
an issue whose steps are one run-on paragraph, which reads to everyone on the ticket like
the tool got the steps wrong.

**Three decisions that came out differently from the plan:**

- **Attachments upload one request each**, not one multipart body. A 40 MB video that
  Jira refuses must not take the six screenshots with it.
- **Attachment failures are returned, not thrown.** By the time they run the issue
  exists, and throwing would tell the tester the export failed while a real ticket sits
  in the project.
- **A human may edit anything, including the steps.** The rule that the *model* cannot
  invent a step does not bind the person who performed them. Editing sets `report.edited`
  and every export says which happened.

**Verify:**
1. Click each step, confirm the video seeks correctly, and confirm the highlighted step
   advances on its own while the video plays.
2. Export to a Jira test project. Confirm the video and screenshots attach, and that the
   description *renders* — headings, numbered steps, and a `{noformat}` evidence block,
   not a wall of literal markup.
3. Edit a field, save, and confirm the issue description says it was edited by hand.
4. Delete a screenshot and confirm it is gone from both the next report and the next
   export — not merely hidden.
5. Point it at a bad project key and confirm the failure names the project rather than
   showing a 404.

**Watch:** Jira's default attachment limit is 10 MB and a two-minute recording exceeds it.
The size of every file is shown before upload and an over-limit video offers **trim to
last 30s**. The trim replays the tail through a `MediaRecorder` — a WebM cannot be cut
with `Blob.slice` — so it **runs in real time** and the trimmed copy is used for the
attachment only; the full recording is never overwritten.

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
