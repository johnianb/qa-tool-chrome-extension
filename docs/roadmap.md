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

## Phase 5 — Redaction and hardening · **built, pending device check**

Required scope, not polish. Recordings will contain customer data.

Most of this landed in Phase 2, deliberately: `redact.ts` had to exist before any code
captured a typed value, because a window in which real credentials are written to disk is
not closed by redacting afterwards. What this phase finished was the part that makes it
a *setting* rather than a constant.

| | |
|---|---|
| Password / `cc-*` / `current-password` / `new-password` / `one-time-code` values never recorded | `isSensitiveField`, called inside `describeValue` — not overridable by the allowlist |
| Values logged as shape — *"14 characters"* — by default | `describeValue` in `content.ts` |
| Verbatim values for allowlisted field names only | `allowValuesFor`, opt-in and empty by default |
| Emails, phones, card numbers and SSNs scrubbed from free text | `scrubText` on console output and the tester's note |
| Query strings stripped from every URL | `scrubUrl` on navigations and network entries |
| Per-domain blocklist | `isBlockedHost`, checked at record-start and on every top-frame navigation |
| Redaction runs **before** the IndexedDB write | every call site is in the content script or the worker, upstream of `updateSession` |

**The two settings are now reachable.** They were defined, tested and unused: `content.ts`
passed the hardcoded `DEFAULT_REDACTION`, so `allowValuesFor` was an unreachable branch,
and nothing called `isBlockedHost` at all. `Settings.redaction` now holds both, merged
two levels deep like `jira`, edited in **Settings → Recording and redaction**.

**They are frozen at record-start.** The worker reads them once, puts them in
`RecordingState`, and sends them with `CAPTURE_START`; a frame that loads after a
mid-recording navigation gets them back from `AM_I_RECORDED`. Reading them live would mean
a mid-recording edit could retroactively widen what a finished recording claims about
itself — and a value already described as "14 characters" cannot be un-described.

**The blocklist cannot promise the page was never on screen.** Starting on a blocked host
is refused before a stream id is acquired, and a recording that navigates onto one is
stopped — but the stop fires on `onCommitted`, which is after the fact. MV3 removed
blocking `webRequest` and there is no earlier hook, so the end of that video can show the
blocked page. The recording is kept, not deleted, with the reason on `session.error`.
Said in the UI and in `docs/privacy.md` too, because a redaction feature that overstates
itself is worse than one that does not exist.

**Still not done, and honestly out of scope here:** screenshot and video redaction. Those
are pixels; the **Send screenshots with the log** toggle remains the only control.

**Verify:**
1. Record a form with a password field and a fake email typed into a text field. Inspect
   the IndexedDB record directly in DevTools. The password must be **absent** and the
   email **masked at rest** — not masked on the way to the model.
2. Add a field's `name` to **Record these field values in full**, record, and confirm that
   field's value appears verbatim while every other field is still a character count.
3. Put a password field's name on that allowlist and confirm it is *still* not recorded.
   `isSensitiveField` must win.
4. Add a host to **Blocked hosts**, open it, and press Record. The refusal must name the
   host. Confirm on `chrome://extensions` that no offscreen document was created.
5. Start a recording on an allowed host, then navigate the tab to a blocked one. The
   recording must stop, and the review page must explain why.
6. Blocklist a bare domain and confirm a subdomain of it is blocked too.
7. Type into a list field, click away, reopen Settings, and confirm what you typed is
   still there — the commit is on blur, not per keystroke.

## Phase 6 — Stretch

- **Rolling buffer** — continuously hold the last 60s, so you can capture a bug *after*
  it happens. The single feature that would most change how this tool feels to use.
- Source-map-aware stack traces.
- Confluence export.
- Optional `chrome.debugger` deep capture.
