# Setup

Recording and the deterministic Markdown report need no configuration. Only
model-written reports need a key.

## An API key

Reports are written through **your own** API key. Two providers are supported, and you
need a key for exactly one of them:

| Provider | Key from | Cost |
| --- | --- | --- |
| **Claude** | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Prepaid credits, billed per report |
| **Gemini** | [aistudio.google.com](https://aistudio.google.com/apikey) | Free tier, rate-limited; paid tier available |

**A Claude Pro or Gemini Pro subscription does not include API access.** Those cover the
chat apps. API keys are billed separately — which is why Gemini is the cheaper place to
start: Google's free tier needs no card, and one bug report per few minutes sits well
inside its limits.

1. Create a key with one of the links above.
2. Open the extension → **Recordings** → **Settings**.
3. Choose the provider, paste the key, then click **Test connection**.

Both keys are kept. Switching provider does not erase the other one, so you can generate
the same report twice and compare.

`Test connection` makes the smallest real API request there is. It answers the two
questions worth answering before you spend a report: is the key accepted, and can this
extension reach the API. If it fails, generation will fail the same way.

### Where the key is stored

`chrome.storage.local` — on this machine, in this Chrome profile.

Deliberately **not** `chrome.storage.sync`, which would replicate it through your Google
account to every machine you are signed in on. Copying a credential between machines
should be your decision, not a side effect of saving a form.

The key is not hidden *from you*: anything that can open this extension's DevTools can
read it, which is also true of every other extension holding a token. It is kept off the
network and out of sync, which is the part that matters.

### Model

Defaults to `claude-opus-5` for Claude and `gemini-3.8-flash` for Gemini. The field is
editable per provider, so you can drop to a cheaper model for a noisy session — or move
to a model released after this build — without a rebuild. A model id the API does not
recognise fails with a message naming the model.

### Cost

One report is a few thousand input tokens of log, up to six screenshots, and a short
structured answer. Token counts for each generation are shown next to the button.

On Gemini's free tier that costs nothing but quota. The limits are per-minute and
per-day and are shown in AI Studio; generation fails with "Rate limited" when you cross
one, and works again shortly after.

Screenshots dominate the input. Turning them off in Settings makes generation
substantially cheaper, and the report noticeably less able to describe what was on screen.

## What leaves your machine

To whichever provider is selected, only when you press **Write with Claude** /
**Write with Gemini**, and only these:

- the environment block (URL, page title, viewport)
- your "what went wrong?" note
- the numbered step list
- console output at `warn` and `error` level, and failed requests
- up to six screenshots — **unless** you turn them off

Not the video. Not `log`/`info` console chatter. Not any field value marked sensitive,
which is never captured in the first place.

Free text is scrubbed for emails, phone numbers, card numbers and SSNs on the way out.
Screenshots are pixels and cannot be scrubbed. See [`privacy.md`](privacy.md).

To Jira, only when you press **Create issue** — and that one sends more: the full report,
**the video**, and every screenshot. It goes to your own Jira, where the ticket is as
visible as any other. See [`privacy.md`](privacy.md).

## Jira

Optional. Without it, **Copy report** still hands you the whole report as Markdown.

1. Create an API token at
   [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) →
   **Security** → **API tokens**. A Jira password will not work; Atlassian disabled
   password auth for the REST API.
2. Open **Settings** → **Jira export**.
3. Fill in the site, your Atlassian account email, the token, and the project key.
4. Click **Test connection**.

**Jira site** takes whatever you paste. A board URL, a backlog, an issue — the site
address is extracted from it, because nobody has the bare site root to hand and
`.../projects/QA/boards/1` plus an API path is a 404 that explains nothing.

**Test connection** makes two calls, not one. The first proves the site, email and token;
the second proves the project key exists and your token's account can read it. That
second failure is the more likely one and the first check says nothing about it.

### What gets created

A `Bug` (or whatever you set as the issue type) in your project, with:

- the report title as the issue summary
- the full report as the description, in Jira wiki markup — headings, numbered steps,
  and an evidence block quoted verbatim
- the recording and the screenshots attached, unless you turn either off

The description names the model that wrote the report, and states whether a human
edited it afterwards. That line is not cosmetic: a reviewer is entitled to know which
sentences a person stands behind.

### Attachment size

Jira's default limit is **10 MB per file** and a two-minute tab recording will exceed it.
Every file's size is shown before you press **Create issue**, and an over-limit video
offers **trim to last 30s**.

The trim replays the last thirty seconds through a recorder — a WebM file cannot be cut
with a byte-range slice without corrupting it — so it takes about thirty seconds, in real
time. The trimmed copy is used for the upload only; the full recording stays on this
machine untouched.

If a file is refused anyway, the issue is still created and the other attachments still
go up. The result names exactly which file is missing and why.

### Where the token is stored

`chrome.storage.local`, alongside the model API keys, and for the same reason — see above.
Revoke it from your Atlassian account page if the machine is lost; nothing else needs to
change.
