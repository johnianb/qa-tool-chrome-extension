# What is captured, and what leaves your machine

Read this before recording against production. This tool is used at a healthcare company;
recordings will contain patient data.

## The short version

| | Captured | Stored on disk | Sent to the model | Attached to Jira |
|---|---|---|---|---|
| Video of the tab | yes | yes | **no** | **yes**, unless turned off |
| Screenshots (up to 6 per report) | yes | yes | yes, unless turned off | yes, **all of them**, unless turned off |
| Clicks, navigations, submissions | yes | yes | yes | yes, in the description |
| Typed values | **shape only** — "14 characters" | shape only | shape only | shape only |
| Password / card / OTP fields | **never** | never | never | never |
| Console `error` and `warn` | yes | yes | yes, scrubbed | yes, scrubbed |
| Console `log` / `info` | yes | yes | no | no |
| Failed requests | yes, path only | yes | yes | yes |
| Request/response bodies | no | no | no | no |
| Your "what went wrong?" note | yes | yes | yes, scrubbed | yes, scrubbed |

Nothing leaves the machine until you press **Write with Claude** / **Write with Gemini**
or **Create issue**. Recording, playback, editing and the deterministic Markdown report
are entirely local.

**The two buttons are not equivalent.** The model receives the log and up to six frames,
and never the video. Jira receives the video, *every* screenshot, and the whole report — and
a Jira ticket is usually visible to far more people than an API request is. Read the
attachment list shown above the **Create issue** button before pressing it; it is there
to be read.

## Typed values are described, not recorded

The default is to record a value's *shape*:

> Enter 14 characters into the 'Email' field

not the fourteen characters. This is the behaviour for every field. Values are captured
verbatim only for fields explicitly allowlisted in redaction settings.

Fields that are never captured at all, whatever the settings say:

- `type="password"`
- `autocomplete` starting `cc-`, `current-password`, `new-password`, `one-time-code`
- any field whose name or id looks like a secret — `token`, `apiKey`, `cvv`, `ssn`,
  `iban`, `accountNumber`, and others (see `SENSITIVE_NAME` in `src/core/events/redact.ts`)

## Free text is scrubbed

Console messages and your own note are free text — a page can log whatever it likes. On
the way out, these patterns are replaced: email addresses, phone numbers, card numbers,
US social security numbers.

URLs are reduced to origin + path. Query strings routinely carry tokens, session ids and
search terms; the path is what identifies a request in a bug report.

## Screenshots are the real exposure

**Redaction cannot touch a screenshot.** The event log records that you typed 14
characters; a screenshot of that screen shows the fourteen characters, the patient's name
beside them, and everything else on the page.

Up to six frames are sent with each report because they measurably improve it. If you are
recording real customer data, turn **Send screenshots with the log** off in Settings. The
report will still be written from the event log, console output and failed requests.

Screenshots and video stay on disk either way — that is what a reviewer needs, and it
never travels **unless you export to Jira**, which uploads both.

Delete a frame you should not have captured from the **Screenshots** gallery on the review
page. That removes it from the stored recording, so it is gone from the next report and
the next export alike — not merely hidden from the page.

## Where recordings live

IndexedDB, in this Chrome profile, on this machine. They are not uploaded anywhere and
there is no server in this product.

They stay until deleted. **Delete** on a recording removes it and its video permanently.

## What the model provider does with a request

Reports go to whichever provider is selected in Settings, under your own key, governed
by the terms attached to that account. If your organisation has data-retention
requirements, confirm the account you are billing to meets them before pointing this at
production.

**The two providers are not equivalent here, and the difference is the free tier.**

- **Anthropic** — a paid API account. Requests are governed by the commercial terms
  attached to it.
- **Gemini, paid tier** — the equivalent arrangement.
- **Gemini, free tier** — Google's published terms for the free tier of the Gemini API
  allow the prompts and responses to be used to improve their products, and reviewed by
  people. That is a different thing from the paid tiers, and it is the tier you get by
  default when you create a key in AI Studio without enabling billing.

This tool is used at a healthcare company. **Do not point the Gemini free tier at a
recording that contains patient data** — the screenshots are unredactable pixels and the
log carries the URLs and console output of a production system. For anything real, use a
paid account on either provider, and confirm the current terms yourself rather than
taking this paragraph's word for it.

The free tier is genuinely useful for the case it fits: recordings against staging, seed
data, and your own test accounts.

## What Jira does with an export

The issue is created by *your* account, in *your* project, through your own API token —
this extension has no server and nothing passes through anyone else in between. From
there it is an ordinary Jira issue: whoever can see the project can see the description,
play the video and open the screenshots.

That is the largest single disclosure this tool performs, and it is the one most likely
to be made by reflex. Attaching the video can be turned off in Settings, per your own
judgement about the project's audience.

## Known gaps

Honest about what is not done yet:

- Per-domain blocklist (refusing to record named hosts) is **Phase 5**, not built.
- Screenshot redaction — blurring regions before sending — is not built, and is harder
  than it sounds. The toggle is the only control today.
- Nothing prevents a recording from being started on a page showing patient data. That is
  a judgement the tester makes.
