# Architecture

## The design bet

Steps in the report come from **recorded event data**, not from a model watching the
video. Video is evidence for a human reviewer; the structured event log is what the
model reasons over.

This is the decision everything else follows from. A model shown only video will produce
a report that reads well and is wrong in specifics — it infers a click on "Submit" from
a cursor moving toward a button, it cannot read the console, and it cannot see that the
request returned 502. A model given a log of what actually fired produces steps that are
checkable against the recording. It is also an order of magnitude cheaper.

## Contexts

An MV3 extension is several isolated JavaScript contexts that can only talk by message
passing. Four of them matter here:

```
┌─ Content script (all frames, document_start) ────────────────┐
│  ISOLATED world: DOM event capture, element labelling        │
│  MAIN world:     console.*, onerror, fetch/XHR patching      │
└──────────────────────────┬───────────────────────────────────┘
                           │ batched events
┌─ Service worker (MV3) ───▼───────────────────────────────────┐
│  session lifecycle · webRequest (4xx/5xx) · webNavigation    │
│  tabs.captureVisibleTab keyframes · IndexedDB writes         │
└──────────────────────────┬───────────────────────────────────┘
                           │ chrome.offscreen
┌─ Offscreen document ─────▼───────────────────────────────────┐
│  getUserMedia(tab streamId) → MediaRecorder → webm Blob      │
└──────────────────────────────────────────────────────────────┘
                           │
┌─ Review page (extension tab) ────────────────────────────────┐
│  video + step timeline (click step → seek video) · settings  │
│  model API call · edit · copy MD · create Jira issue         │
└──────────────────────────────────────────────────────────────┘

Both outbound API calls — the model and Jira — live in the review page, not the
worker. See *Report generation* and *Jira export* below.
```

The message protocol between them is one discriminated union in `src/core/messages.ts`,
so a handler that stops matching its sender is a compile error rather than a silent
runtime no-op.

## Why an offscreen document

MV3 service workers have no DOM and therefore no `MediaRecorder`, and Chrome terminates
them after roughly 30 seconds idle. `chrome.offscreen` with reason `USER_MEDIA` is the
supported way to keep a recorder alive.

The flow: the worker calls `chrome.tabCapture.getMediaStreamId({targetTabId})` — which
must happen in the worker — and passes the resulting id to the offscreen document, which
redeems it via `getUserMedia` with Chrome's non-standard `chromeMediaSource: 'tab'`
constraint. That constraint shape is not in the standard typings and is cast through
`unknown` in `offscreen/main.ts`; it is the first thing to suspect if capture fails.

**The consequence that shapes everything:** the worker dies mid-recording as a matter of
routine. Live state lives in `chrome.storage.session`; captured data goes to IndexedDB as
it arrives. Nothing important is ever held in a worker module variable.

Tab capture also mutes the tab for the user unless the audio stream is routed back to
the speakers with an `AudioContext`. The recorder does this unconditionally — a bug tool
that silences the app under test will itself get filed as a bug.

## Why MAIN-world patching instead of `chrome.debugger`

`chrome.debugger` would deliver console messages and full network detail through CDP in
one shot. It is not worth it:

- it shows the yellow *"extension is debugging this browser"* infobar on every recording
- it **conflicts with DevTools being open** — and QA always has DevTools open

So console and page-initiated network capture happen by patching `console.*`,
`window.onerror`, `unhandledrejection`, `fetch` and `XMLHttpRequest` in a MAIN-world
script. The gap this leaves — browser-generated failures the page script cannot observe,
such as subresource 404s and CORS rejections — is filled by `chrome.webRequest` in the
worker, which is still available in MV3 for observation (only the blocking form was
removed).

Deep CDP capture stays available as an opt-in toggle for cases that genuinely need it.

## Storage

Sessions live in IndexedDB (`src/core/storage/db.ts`), keyed by session id and indexed
by start time.

`chrome.storage.local` is wrong for this on two counts: the quota is far too small for
video, and it serialises through JSON, which silently destroys `Blob`s. `chrome.storage`
is used only for settings and for the small live-recording state record.

## The relative clock

Every captured item carries `t`: **milliseconds since the session's `startedAt`**. The
only wall-clock timestamp in the model is `env.recordedAt`, for the report's environment
block.

This is what makes the report and the video one artifact rather than two. Each step in
the generated report carries the `t` of the event it came from, so clicking a step seeks
the player. It costs nothing at capture time and cannot be reconstructed afterwards.

## Redaction

`src/core/events/redact.ts` decides what a captured value is allowed to say. It was
written in Phase 2 even though it belonged to Phase 5, because the alternative is a
period during which real credentials are written to disk and "we'll redact it later" does
not un-write them.

**It runs at capture time, not on the way out.** `describeValue` and `scrubText` are
called in the content script and `scrubUrl` in the worker — both *before* the value
reaches `updateSession`, so an unredacted value never sits in IndexedDB at all. A pass
that ran at export time would leave the recording on disk as the thing it was protecting
against.

Two lists are configurable, and both default to empty:

- `allowValuesFor` — field names whose values may be stored verbatim. Opt-in, because the
  safe default has to be the one you get by not configuring anything.
- `blockedHosts` — hosts that are not recorded.

### Why the settings travel with the start message

The content script runs in **every frame** of the recorded tab, so reading
`chrome.storage` there is a read per frame. More importantly the settings have to be the
ones in force when Record was pressed: a mid-recording edit that retroactively widened
capture would make the guarantee unstatable, and a value already described as "14
characters" cannot be un-described.

So the worker reads them once in `startRecording`, freezes them into `RecordingState`, and
sends them with `CAPTURE_START`. A frame that loads later — after a mid-recording
navigation — asks `AM_I_RECORDED` and gets them back from the same record, which is the
only copy that survives the worker's routine death. The content script's own default is
`DEFAULT_REDACTION`, so a script capturing without having been told what is permitted
captures the *least*, not the most.

### What the blocklist can and cannot promise

Starting a recording on a blocked host is refused before a stream id is even acquired, and
a recording whose tab navigates onto one is stopped.

But the stop fires on `webNavigation.onCommitted`, which is *after* the navigation has
happened. MV3 removed blocking `webRequest` and there is no earlier hook, so the last
moments of the video can show the blocked page. The recording is kept rather than deleted —
the part before the navigation is the part the tester wanted — and the reason is written to
`session.error`, where the review page already knows how to show it. The blocklist prevents
a recording, not a glimpse, and both this and `docs/privacy.md` say so: a redaction feature
that overstates itself is worse than one that does not exist.

Screenshots and video are outside all of this. They are pixels, and nothing here touches
them; the only control is the **Send screenshots with the log** toggle.

## Report generation

The structured log plus up to six keyframes goes to the configured model and comes back
as a schema-validated object. The same Zod schema drives both providers — through
`zodOutputFormat` on `messages.parse()` for Claude, and as JSON Schema in
`response_format` for Gemini — so the field descriptions that make up half the prompt
cannot drift apart between them. Three modules: `report-prompt.ts` builds what is sent, `report-schema.ts`
defines what may come back and validates it, and `ai.ts` hands the call to `claude.ts`
or `gemini.ts` — both of which ground their answer through the same `report-schema.ts`,
so the guarantees a reviewer relies on are not a property of the model.

### The model never writes a step

The failure that would make this tool worse than useless is a report containing steps the
tester did not perform. One invented step and a reviewer stops trusting every other line.

So the model is not asked what happened. It receives the deterministic step list from
`toSteps()` and returns **step numbers** plus a rewording of each. `atMs` is then filled
in from our own record of the step it named. A fabricated step is not discouraged, it is
*unrepresentable* — there is no field it could go in, and an index that does not exist is
dropped in `groundReport()` before it can reach the report.

Prompt instructions are the second line of defence here, never the first. The three
guarantees all live in code:

| Guarantee | Enforced by |
|---|---|
| Every step traces to a captured event | `groundReport()` drops unknown indices; timestamps come from our record |
| `expectedResult` is never invented | With no tester note, the field is *replaced* with a fixed "not stated" sentence whatever the model wrote |
| No console error or failed request goes missing | Facts the model omitted are appended to `evidence` |

The tester's one-line "what went wrong?" is the highest-value field in the tool and the
only one no amount of capture can supply. It decides the report title, and it is the only
thing permitted to become the expected result.

### Why the call is not in the service worker

The worker is the wrong host for a request that can run a minute. MV3 terminates it after
roughly 30 seconds idle; Chrome does extend that for in-flight requests, but "usually
survives" is a poor foundation for the one call in this product that costs money.

The review page has no such limit, it is already open because the tester just clicked the
button in it, and it shares the extension's origin — so the host permission for
`api.anthropic.com` or `generativelanguage.googleapis.com` still bypasses CORS, which
was the part worth proving. A closed tab is a
visible failure; a dead worker is not.

This also keeps the SDK out of the worker bundle: `background.js` is 14 kB, and the
566 kB of SDK, React and zod loads only on the page that uses it.

## Jira export

Two modules: `jira-markup.ts` renders the issue, `jira.ts` makes the calls.

### Why v2, and why a second renderer

REST **v2** takes a wiki-markup string for `description` and Atlassian converts it on the
way in. v3 takes Atlassian Document Format — a JSON document tree — and writing an ADF
serialiser would buy nothing.

But wiki markup is not Markdown, and the differences are exactly the load-bearing ones:
headings are `h2.`, ordered lists are `#`, and `{`, `[` and `|` are structural characters
that swallow the rest of a line when unbalanced. Posting `toMarkdown()` output produces an
issue whose steps are one run-on paragraph — which reads, to everyone on the ticket, as
the tool having got the steps wrong. Hence a second renderer rather than a shared one.

Log lines go inside `{noformat}`. A stack trace containing `{` would otherwise vanish into
a malformed macro, and quoting the machine's output verbatim is the honest presentation
besides.

### Uploads are one request per file

The issue is created first, then each attachment is uploaded in its own request.

One multipart body would be fewer round trips and strictly worse: Jira's default limit is
10 MB per file, a two-minute recording exceeds it, and a single rejected body would take
the six screenshots down with the video. For the same reason attachment failures are
*returned* rather than thrown — by the time they run the issue exists, and throwing would
tell the tester the export failed while a real ticket sits in the project.

### Trimming

An over-limit recording offers a trim to its last 30 seconds. This re-encodes by replaying
the tail through a `MediaRecorder`: a WebM cannot be cut with `Blob.slice`, because the
tail alone begins mid-cluster with no keyframe and the result is a corrupt file rather than
a short one. So the trim runs in **real time**, and `playbackRate` stays at 1 — speeding it
up would change the playback speed of evidence whose timing is frequently the point.

The trimmed copy is used for the upload only. The stored recording is never overwritten.

### The edit flag

A human may edit any field, including the steps. The rule that the *model* cannot invent a
step constrains the model, not the person who performed them — and supplying the expected
result the model was forbidden to guess at is precisely what review is for.

What the tool owes the reader is which happened, so an edit that changes content sets
`report.edited`, and both the Markdown and the Jira description say so. Opening the editor
and saving without changing anything does not set it.

## Data model

`src/core/session.ts` is the single source of truth. A `Session` holds the environment
block, the video blob, four parallel time-ordered streams (`events`, `console`,
`network`, `keyframes`), the tester's note, and — once generated — the report and the
Jira key.

Settings are the one exception to "IndexedDB holds everything": they live in
`chrome.storage.local` and carry two sets of credentials. `getSettings` merges the stored
record over the defaults *two levels deep*, because a shallow merge would hand back a
`jira` object written by an older build — and a missing field there becomes `undefined` in
a controlled React input, which presents as a form that will not accept typing.

All four streams share the relative clock, so merging them into one timeline for the
model or the UI is a sort, not a correlation problem.
