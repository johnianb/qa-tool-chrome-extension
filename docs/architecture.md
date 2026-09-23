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
│  Anthropic API call · Jira REST calls                        │
└──────────────────────────┬───────────────────────────────────┘
                           │ chrome.offscreen
┌─ Offscreen document ─────▼───────────────────────────────────┐
│  getUserMedia(tab streamId) → MediaRecorder → webm Blob      │
└──────────────────────────────────────────────────────────────┘
                           │
┌─ Review page (extension tab) ────────────────────────────────┐
│  video + step timeline (click step → seek video) · edit ·    │
│  redact screenshots · copy MD · create Jira issue            │
└──────────────────────────────────────────────────────────────┘
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

## Report generation

The worker sends the structured log plus 8–12 keyframes to `claude-opus-5` and gets back
a schema-validated object (`messages.parse()` with a zod schema — the response cannot
come back malformed).

Three guardrails live in the system prompt, and they are the difference between a report
that is trustworthy and one that merely sounds trustworthy:

- **`expected_result` may only restate the tester's own note.** The model has no spec for
  the application. Anything it invents here is fiction.
- **Every step must trace to a logged event.** No interpolating plausible-but-unrecorded
  actions to make a narrative flow.
- **`suspected_area` says so when the evidence does not support a diagnosis**, rather
  than guessing.

The tester's one-line "what went wrong?" is collected at stop time. It is one text field
and it improves output more than any amount of prompt tuning.

## Data model

`src/core/session.ts` is the single source of truth. A `Session` holds the environment
block, the video blob, four parallel time-ordered streams (`events`, `console`,
`network`, `keyframes`), the tester's note, and — once generated — the report and the
Jira key.

All four streams share the relative clock, so merging them into one timeline for the
model or the UI is a sort, not a correlation problem.
