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
| `npm run build` | Production build into `.output/chrome-mv3` |
| `npm run compile` | `tsc --noEmit` — typecheck only |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode |
| `npm run zip` | Package for distribution |

`npm run dev` is the normal loop. It launches its own Chrome profile, so you will need
to sign in to the app under test there once.

## Loading a production build manually

`chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.

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
