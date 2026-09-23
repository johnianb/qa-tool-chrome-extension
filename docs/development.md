# Development

## Setup

Node 22+. `npm install` runs `wxt prepare` as a postinstall step, which generates
`.wxt/` — the TypeScript config and the type declarations for WXT's auto-imported
globals (`defineBackground`, `defineContentScript`, ...).

```bash
npm install
```

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Dev build with HMR; opens a fresh Chrome profile with the extension loaded |
| `npm run build` | Production build into `build/chrome-mv3` |
| `npm run compile` | `tsc --noEmit` — typecheck only |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode |
| `npm run zip` | Package for distribution |

`npm run dev` is the normal loop. It launches its own Chrome profile, so you will need
to sign in to the app under test there once.

## Loading a production build manually

`chrome://extensions` → Developer mode → Load unpacked → `build/chrome-mv3`.

After a rebuild, press the reload icon on the extension card. Changing the manifest or
the service worker sometimes needs a full **Remove** and **Load unpacked** again.

## Debugging — four separate consoles

This is the thing that wastes the most time on MV3 extensions. Each part of the
extension logs somewhere different, and none of them is the page console:

| Part | Where to find its console |
|---|---|
| Service worker (`background.ts`) | `chrome://extensions` → the extension card → **service worker** link |
| Offscreen document (the recorder) | `chrome://extensions` → **Inspect views: offscreen.html** — only listed while a recording is running |
| Content scripts | The DevTools console of the page under test |
| Popup | Right-click the popup → **Inspect** (it closes on blur otherwise; the inspector keeps it open) |
| Review page | Normal DevTools, it is just a tab |

If something appears to do nothing, check you are reading the right console before
assuming the code did not run.

## The MV3 constraint that shapes this codebase

Chrome terminates the service worker after roughly 30 seconds of inactivity. The
offscreen document keeps recording regardless. So **the worker's memory is empty by the
time Stop is pressed.**

Consequences, both load-bearing:

- Live recording state goes in `chrome.storage.session` (`src/core/recording-state.ts`),
  never in a module-level variable in the worker.
- Captured data goes to IndexedDB (`src/core/storage/db.ts`) as it arrives, not
  accumulated in memory and flushed at the end.

To verify you have not broken this: start a recording, leave the tab idle for two
minutes, and watch the service worker go inactive on the extensions page. Recording
must survive, and Stop must still produce a video.

Blobs cannot go in `chrome.storage` at all — it serialises through JSON, which silently
destroys them. That is why sessions live in IndexedDB.

## Project layout

```
src/
  entrypoints/
    background.ts       service worker — session orchestration
    popup/              record / stop controls (plain TS)
    offscreen/          MediaRecorder host
    review/             review and export page (React)
  core/
    session.ts          the data model
    messages.ts         typed message protocol between contexts
    recording-state.ts  live state in chrome.storage.session
    storage/db.ts       IndexedDB
  services/             Anthropic and Jira clients
```

All captured items carry `t` — **milliseconds relative to the session's `startedAt`**,
never wall-clock. That relative clock is what lets a step in the finished report seek
the video to the moment it happened. Keep it that way.

## Testing

Vitest covers the pure logic — the element labeller, the selector builder, the redactor,
the Markdown serialiser. These are the parts where a regression is silent and expensive.

The Chrome API surface (tabCapture, offscreen, webRequest) is verified by hand against
the checklist in [`roadmap.md`](roadmap.md); mocking it would test the mock.

Redaction tests are adversarial by policy: PII hidden in `aria-label`s, in placeholder
text, in URL query strings. Add a case whenever you find a new hiding place.

## Conventions

- TypeScript strict, including `noUncheckedIndexedAccess`.
- TSDoc on every exported function in `core/` and `services/`.
- Comments explain *why*, not *what*. The Chrome-specific workarounds each carry a note
  saying what breaks without them — those are the ones worth keeping.
- Do not override `include` in `tsconfig.json`. It extends `.wxt/tsconfig.json`, which
  includes `.wxt/wxt.d.ts`; overriding `include` drops WXT's global declarations and
  `defineBackground` stops resolving.

## Runtime messages are JSON, not structured clone

`chrome.runtime.sendMessage` serialises its payload as JSON. This is not the structured
clone algorithm that `postMessage` uses, and the difference is silent: a `Blob`, `File`,
`ArrayBuffer`, `Map` or `Set` arrives at the other end as `{}` with **no error raised**.

This cost us a blank review page once. The video blob was sent from the offscreen
document to the service worker, arrived as `{}`, was stored as the session's video, and
then `URL.createObjectURL({})` threw inside a React effect — which unmounts the React
root, so the symptom was an empty page rather than anything pointing at the cause.

Two rules follow:

- **Never put binary data in a runtime message.** Every extension context shares one
  origin and therefore one IndexedDB. Write the data where it is produced and send only
  an id. `src/entrypoints/offscreen/main.ts` does this.
- **Guard before `URL.createObjectURL`.** `src/entrypoints/review/App.tsx` checks
  `instanceof Blob`, so a record written by an older build degrades to "no video" rather
  than taking the page down with it.

`src/core/messages.test.ts` pins the behaviour.

## The offscreen document creation race

`chrome.offscreen.createDocument()` resolves when the **document** exists — not when its
script has executed. Send it a message on the next line and you are racing its module
load. Lose that race and the message is dropped: no listener, no error, and the
recording silently never starts.

So start parameters are handed over through `chrome.storage.session`
(`setPendingCapture` / `takePendingCapture` in `src/core/recording-state.ts`). The
worker writes them *before* calling `createDocument`, and the document claims them on
load. There is no ordering to get wrong.

Messages to the offscreen document are only safe once it has demonstrably loaded —
`OFFSCREEN_STOP` qualifies, because it can only follow a recording that is already
running. `OFFSCREEN_PICKUP` exists solely for the case where the document was left open
from a previous recording and so will not re-read storage on its own; a dropped pickup
is non-fatal.

The general rule: **treat the offscreen document as a worker that pulls jobs, not one
that gets pushed them.**

## Failures should land on the session

When a recording fails, the reason is written to `session.error` and the review page
renders it in place of the video player. An empty recording that explains itself is the
difference between a minute of debugging and an afternoon — the tester is holding the
only reproduction, and they should not have to open a console to learn what happened.

## Diagnosing a recording that produced nothing

The pipeline spans four contexts with four separate consoles, and the offscreen
document's console **only exists while the document is open** — it closes the moment a
recording finishes. So by the time a tester notices an empty recording, the console
evidence is already gone.

Every lifecycle step therefore writes a breadcrumb to `session.trace` in IndexedDB, and
the review page renders it (open by default when there is no video). The last line
reached is the answer to *where did it stop?*:

| Last line | Meaning |
|---|---|
| `worker: stream id acquired` | `tabCapture` worked; the offscreen document never loaded |
| `worker: pending capture written` | Document was not created — check `createDocument` |
| `offscreen: claimed capture` | `getUserMedia` hung or was rejected |
| `offscreen: stream acquired` | Stream fine; `MediaRecorder` construction failed |
| `offscreen: recorder started` | Recorder ran but produced no chunks — the track ended early |
| `offscreen: first chunk received` | Data flowed; the stop path or the IndexedDB write failed |
| `offscreen: saved N bytes` | It worked |

Add a breadcrumb whenever you add a step. They are cheap, they persist, and they are the
only durable record of a failure the tester cannot reproduce on demand.
