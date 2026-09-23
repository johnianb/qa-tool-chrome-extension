# QA Bug Reporter

A Chrome extension for QA. Record the tab where a bug happens; get back a written,
evidence-backed bug report you can edit and push straight to Jira.

## Why this exists

Filing a good bug is mostly retyping. You reproduce the problem, then write out the
steps from memory, describe what actually happened, and paste in an environment block
that's usually stale. The steps get compressed into something unusable — *"clicked
around in orders, it broke"* — and the console error that would have told a developer
exactly what went wrong never makes it into the ticket at all.

This extension records what you actually did, and writes the report from that.

## How it works

While you record, the extension captures more than video:

- every interaction — clicks, typed input, form submissions, navigations
- every console error and unhandled rejection
- every failed network request
- a screenshot at each significant moment

When you stop, you type one line about what went wrong. Claude then writes the report
from **the recorded event log**, not from watching the video. This is the whole design
bet: steps derived from recorded facts are accurate, where steps inferred from pixels
are merely plausible. You review and edit the draft, then export.

The video is still there — it's the evidence a human reviewer wants — and clicking any
step in the report seeks the video to the moment it happened.

## Status

Under construction. See [`docs/roadmap.md`](docs/roadmap.md) for what works today.

| Phase | Scope | State |
|---|---|---|
| 0 | Project scaffold, manifest | Built |
| 1 | Tab recording, playback | Built, pending device check |
| 2 | Event capture, deterministic Markdown report | Not started |
| 3 | Claude report generation | Not started |
| 4 | Review page, Jira export | Not started |
| 5 | Redaction and hardening | Not started |

## Install (unpacked)

Requires Node 22+ and Chrome.

```bash
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `.output/chrome-mv3` folder in this repo

Pin the extension to your toolbar so the recording badge is visible.

## Use

1. Open the tab showing the bug.
2. Click the extension icon, then **Record this tab**. A red `REC` badge appears.
3. Reproduce the bug.
4. Click **Stop and write report**.
5. Review, edit, export.

Browser-internal pages (`chrome://`, the Web Store, other extensions) cannot be
recorded — Chrome does not permit it.

## Documentation

| Document | For |
|---|---|
| [`docs/user-guide.md`](docs/user-guide.md) | Recording and filing a bug |
| [`docs/setup.md`](docs/setup.md) | API keys and Jira configuration |
| [`docs/privacy.md`](docs/privacy.md) | What is captured, what leaves your machine |
| [`docs/architecture.md`](docs/architecture.md) | How it is built and why |
| [`docs/development.md`](docs/development.md) | Working on the extension |
| [`docs/roadmap.md`](docs/roadmap.md) | Phases and what each delivers |

## A note on what you record

Recordings capture whatever is on screen, including customer data. Redaction of typed
values is built in (Phase 5), but screenshots and video are not automatically scrubbed.
Read [`docs/privacy.md`](docs/privacy.md) before recording against production.
