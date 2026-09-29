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

When you stop, you type one line about what went wrong. A model — Claude or Gemini,
your choice — then writes the report from **the recorded event log**, not from watching
the video. This is the whole design
bet: steps derived from recorded facts are accurate, where steps inferred from pixels
are merely plausible. You review and edit the draft, then export.

The video is still there — it's the evidence a human reviewer wants — and clicking any
step in the report seeks the video to the moment it happened.

## Status

Under construction. See [`docs/roadmap.md`](docs/roadmap.md) for what works today.

| Phase | Scope | State |
|---|---|---|
| 0 | Project scaffold, manifest | Built |
| 1 | Tab recording, playback | Done |
| 2 | Event capture, deterministic Markdown report | Built |
| 3 | Report generation — Claude or Gemini | Built |
| 4 | Review page editing, Jira export | Built |
| 5 | Redaction and hardening | Built |

Reports need an API key for one of the two providers — see
[`docs/setup.md`](docs/setup.md). Neither a Claude Pro nor a Gemini Pro subscription
includes API access, but Google's AI Studio issues a free-tier Gemini key, which is the
cheapest way to start. Everything else works without a key.

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
4. Select the `build/chrome-mv3` folder in this repo

Pin the extension to your toolbar so the recording badge is visible.

For the development loop — `npm run dev`, which profile to run in, and a smoke test that
exercises the whole pipeline — see [`docs/development.md`](docs/development.md#running-it-locally).

## Use

1. Open the tab showing the bug.
2. Click the extension icon, then **Record this tab**. A red `REC` badge appears.
3. Reproduce the bug.
4. Click **Stop and write report**, then open **Recordings**.
5. Type one line in **What went wrong?** — this becomes the expected result, and leaving
   it empty means the report says the expected behaviour is unknown rather than guessing.
6. Click **Write with Claude** (or **Write with Gemini**, depending on the provider
   you configured).
7. Read the draft against the video — clicking a step seeks to the moment it happened, and
   the step list follows the playhead as it plays. **Edit** anything that is wrong.
8. **Copy report** for Markdown, or **Create issue** to push it to Jira with the recording
   and screenshots attached.

Jira export needs a site URL, an Atlassian account email, an API token and a project key —
see [`docs/setup.md`](docs/setup.md). Everything up to step 7 works without it.

Browser-internal pages (`chrome://`, the Web Store, other extensions) cannot be
recorded — Chrome does not permit it.

## Documentation

| Document | For |
|---|---|
| [`docs/setup.md`](docs/setup.md) | API keys, providers, model, cost |
| [`docs/privacy.md`](docs/privacy.md) | What is captured, what leaves your machine |
| [`docs/architecture.md`](docs/architecture.md) | How it is built and why |
| [`docs/development.md`](docs/development.md) | Working on the extension |
| [`docs/roadmap.md`](docs/roadmap.md) | Phases and what each delivers |

## A note on what you record

Recordings capture whatever is on screen, including customer data. Typed values are
recorded as their *shape* — "14 characters" — password and card fields not at all, and
hosts you list in Settings are refused outright. **Screenshots and video are not
scrubbed**, and a Jira export uploads both. Read
[`docs/privacy.md`](docs/privacy.md) before recording against production.
