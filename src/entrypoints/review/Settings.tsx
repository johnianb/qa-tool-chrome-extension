/**
 * Settings: the credentials, the model, and what leaves the machine.
 *
 * Lives in the review page rather than a separate options page — this is the only place
 * report generation and Jira export are triggered, so it is where someone goes when
 * either will not run. A second entrypoint to maintain buys nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_PROVIDERS,
  PROVIDER_NAMES,
  activeProvider,
  getSettings,
  saveJira,
  saveProvider,
  saveRedaction,
  saveSettings,
  type JiraSettings,
  type Provider,
  type ProviderSettings,
  type Settings,
} from '@/core/settings';
import { parseRedactionList, type RedactionSettings } from '@/core/events/redact';
import { testConnection } from '@/services/ai';
import { testJiraConnection } from '@/services/jira';

/** Where each provider's key comes from, and what it costs. */
const KEY_HINTS: Record<Provider, string> = {
  anthropic: 'Created at console.anthropic.com. Billed to you from prepaid credits.',
  google: 'Created at aistudio.google.com. Has a free tier, with rate limits.',
};

/** The result of a "Test connection" button, shared by both panels. */
type Check = { state: 'idle' | 'running' } | { state: 'ok' | 'failed'; message: string };

export function SettingsPanel({
  onSaved,
  onClose,
}: {
  onSaved: (settings: Settings) => void;
  /**
   * Omitted where the panel is the whole page — with nothing recorded there is nothing
   * behind it to go back to, and a Done button that closed onto an empty screen would
   * be a dead end rather than a way out.
   */
  onClose?: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [check, setCheck] = useState<Check>({ state: 'idle' });

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  const update = useCallback(
    async (patch: Partial<Pick<Settings, 'provider' | 'sendScreenshots'>>) => {
      const next = await saveSettings(patch);
      setSettings(next);
      onSaved(next);
      setCheck({ state: 'idle' }); // a previous pass says nothing about the new provider
    },
    [onSaved],
  );

  const updateProvider = useCallback(
    async (provider: Provider, patch: Partial<ProviderSettings>) => {
      const next = await saveProvider(provider, patch);
      setSettings(next);
      onSaved(next);
      setCheck({ state: 'idle' }); // a previous pass says nothing about the new key
    },
    [onSaved],
  );

  /**
   * Both this panel's own state and the page's must advance on every save.
   *
   * These inputs are controlled, so a child that saved through `onSaved` alone would
   * update the page while the field it was typed into kept re-rendering the old value —
   * a text box that refuses to accept typing.
   */
  const publish = useCallback(
    (next: Settings) => {
      setSettings(next);
      onSaved(next);
    },
    [onSaved],
  );

  const run = useCallback(async () => {
    if (!settings) return;
    setCheck({ state: 'running' });
    try {
      setCheck({ state: 'ok', message: await testConnection(settings) });
    } catch (error) {
      setCheck({ state: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, [settings]);

  if (!settings) return null;

  return (
    <section className="mb-5 rounded-xl border border-neutral-200 p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-sm font-semibold">Report generation</h3>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1 text-xs hover:border-neutral-500"
          >
            Done
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Reports are written by a model you pay for directly, through your own API key.
        Neither a Claude Pro nor a Gemini Pro subscription includes API access — but
        Google issues a free-tier key from{' '}
        <span className="font-medium">aistudio.google.com</span>, which is the cheapest
        way to start. Keys are stored on this machine only — never synced to your Google
        account.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Provider" hint="Both keys are kept; switching does not erase the other.">
          <select
            value={settings.provider}
            onChange={(e) => void update({ provider: e.target.value as Provider })}
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="anthropic">Claude — Anthropic API</option>
            <option value="google">Gemini — Google AI Studio</option>
          </select>
        </Field>

        <div />

        <Field label={`${PROVIDER_NAMES[settings.provider]} API key`} hint={KEY_HINTS[settings.provider]}>
          <input
            type="password"
            /*
              Keyed by provider. Without it React keeps the same input element across a
              provider switch, and a password field it considers unchanged can hold the
              browser's autofill for the previous value — one key shown under the other
              one's label.
            */
            key={settings.provider}
            value={activeProvider(settings).apiKey}
            onChange={(e) => void updateProvider(settings.provider, { apiKey: e.target.value })}
            placeholder={settings.provider === 'anthropic' ? 'sk-ant-…' : 'AIza…'}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 font-mono text-sm"
          />
        </Field>

        <Field label="Model" hint={`Default ${DEFAULT_PROVIDERS[settings.provider].model}.`}>
          <input
            type="text"
            value={activeProvider(settings).model}
            onChange={(e) => void updateProvider(settings.provider, { model: e.target.value })}
            spellCheck={false}
            className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 font-mono text-sm"
          />
        </Field>
      </div>

      <label className="mt-4 flex gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={settings.sendScreenshots}
          onChange={(e) => void update({ sendScreenshots: e.target.checked })}
          className="mt-0.5 size-4 shrink-0"
        />
        <span>
          <span className="font-medium">Send screenshots with the log</span>
          {/*
            Stated plainly because it is the one thing on this page that redaction cannot
            reach. The event log records the shape of a value — "14 characters" — but a
            screenshot is pixels, and a frame showing a patient record is legible to
            whatever receives it.
          */}
          <span className="mt-0.5 block text-neutral-500">
            Improves the report. Up to six frames of the recording are sent as images,
            unredacted — anything visible on screen goes with them. Turn this off when
            recording real customer data.
          </span>
        </span>
      </label>

      <CheckRow
        check={check}
        disabled={!activeProvider(settings).apiKey.trim()}
        onRun={() => void run()}
      />

      <RedactionSection redaction={settings.redaction} onSaved={publish} />

      <JiraSection jira={settings.jira} onSaved={publish} />

      {/*
        Repeated at the foot of the panel because the form is taller than the viewport:
        someone who has just filled in the Jira token is a long scroll away from the
        header, and every field here saves as it is typed, so leaving is all that is
        left to do.
      */}
      {onClose && (
        <div className="mt-6 border-t border-neutral-200 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500"
          >
            Done
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * What the recorder is allowed to capture.
 *
 * Above the Jira panel deliberately: this decides what is captured at all, and the two
 * below it only decide where an already-captured recording is sent. Someone reading down
 * the page should meet the narrower question first.
 */
function RedactionSection({
  redaction,
  onSaved,
}: {
  redaction: RedactionSettings;
  onSaved: (settings: Settings) => void;
}) {
  const update = useCallback(
    async (patch: Partial<RedactionSettings>) => {
      onSaved(await saveRedaction(patch));
    },
    [onSaved],
  );

  return (
    <div className="mt-6 border-t border-neutral-200 pt-4">
      <h3 className="text-sm font-semibold">Recording and redaction</h3>
      <p className="mt-1 text-sm text-neutral-500">
        Typed values are recorded as their <span className="font-medium">shape</span> —
        &ldquo;14 characters&rdquo; — and password, card and one-time-code fields are never
        recorded at all, whatever is set here. Changes apply to the{' '}
        <span className="font-medium">next</span> recording, not one in progress.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ListField
          label="Blocked hosts"
          hint="One per line. Subdomains are covered: admin.internal also blocks eu.admin.internal."
          placeholder={'admin.internal\nbilling.example.com'}
          value={redaction.blockedHosts}
          onCommit={(blockedHosts) => void update({ blockedHosts })}
        />

        <ListField
          label="Record these field values in full"
          hint="One per line: a field's name, or its id if it has no name. Everything else is a length only."
          placeholder={'orderId\nsku\nquantity'}
          value={redaction.allowValuesFor}
          onCommit={(allowValuesFor) => void update({ allowValuesFor })}
        />
      </div>

      <p className="mt-3 text-xs text-neutral-500">
        Recording a blocked host is refused, and a recording whose tab navigates onto one
        is stopped. Chrome gives an extension no way to intercept a navigation before it
        commits, so the end of that video can still show the page — the list prevents a
        recording, not a glimpse.
      </p>
    </div>
  );
}

/**
 * A newline-separated list, committed on blur.
 *
 * Parsing per keystroke and rendering the parsed list back would discard the newline the
 * tester has just pressed and move the cursor — the same "field that will not accept
 * typing" failure the two-level merge in `getSettings` exists to prevent. So the raw text
 * is local state and only the parsed result is saved.
 */
function ListField({
  label,
  hint,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  hint: string;
  placeholder: string;
  value: string[];
  onCommit: (next: string[]) => void;
}) {
  const saved = value.join('\n');
  const [text, setText] = useState(saved);

  // Re-seed only when the saved *content* changes — keyed on the joined string rather
  // than the array, whose identity is new on every settings save, including saves this
  // field did not cause.
  useEffect(() => {
    setText(saved);
  }, [saved]);

  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onCommit(parseRedactionList(text))}
        placeholder={placeholder}
        rows={3}
        spellCheck={false}
        className="w-full resize-y rounded-lg border border-neutral-300 px-3 py-1.5 font-mono text-sm"
      />
      <span className="mt-1 block text-xs text-neutral-500">{hint}</span>
    </label>
  );
}

/**
 * Jira connection details.
 *
 * Sits inside the same panel rather than beside it: a tester configuring this extension
 * for the first time is doing one job, and splitting it across two collapsible boxes
 * only makes the second one easy to miss.
 */
function JiraSection({
  jira,
  onSaved,
}: {
  jira: JiraSettings;
  onSaved: (settings: Settings) => void;
}) {
  const [check, setCheck] = useState<Check>({ state: 'idle' });

  const update = useCallback(
    async (patch: Partial<JiraSettings>) => {
      onSaved(await saveJira(patch));
      setCheck({ state: 'idle' }); // a previous pass says nothing about the new details
    },
    [onSaved],
  );

  const run = useCallback(async () => {
    setCheck({ state: 'running' });
    try {
      setCheck({ state: 'ok', message: await testJiraConnection(jira) });
    } catch (error) {
      setCheck({ state: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, [jira]);

  const incomplete = !(
    jira.baseUrl.trim() &&
    jira.email.trim() &&
    jira.apiToken.trim() &&
    jira.projectKey.trim()
  );

  return (
    <div className="mt-6 border-t border-neutral-200 pt-4">
      <h3 className="text-sm font-semibold">Jira export</h3>
      <p className="mt-1 text-sm text-neutral-500">
        Optional. Without it, <span className="font-medium">Copy report</span> still hands you
        the whole report as Markdown. Stored on this machine only, like the API key.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field
          label="Jira site"
          hint="Paste any page from your Jira — the site address is taken from it."
        >
          <input
            type="url"
            value={jira.baseUrl}
            onChange={(e) => void update({ baseUrl: e.target.value })}
            placeholder="https://yourteam.atlassian.net"
            spellCheck={false}
            className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>

        <Field label="Atlassian account email" hint="The account the API token belongs to.">
          <input
            type="email"
            value={jira.email}
            onChange={(e) => void update({ email: e.target.value })}
            placeholder="you@yourteam.com"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
          />
        </Field>

        <Field
          label="API token"
          hint="id.atlassian.com → Security → API tokens. Your Jira password will not work."
        >
          <input
            type="password"
            value={jira.apiToken}
            onChange={(e) => void update({ apiToken: e.target.value })}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 font-mono text-sm"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Project key" hint="e.g. QA.">
            <input
              type="text"
              value={jira.projectKey}
              onChange={(e) => void update({ projectKey: e.target.value.toUpperCase() })}
              placeholder="QA"
              spellCheck={false}
              className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 font-mono text-sm uppercase"
            />
          </Field>

          <Field label="Issue type" hint="Renameable per project.">
            <input
              type="text"
              value={jira.issueType}
              onChange={(e) => void update({ issueType: e.target.value })}
              placeholder="Bug"
              spellCheck={false}
              className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
            />
          </Field>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={jira.attachVideo}
            onChange={(e) => void update({ attachVideo: e.target.checked })}
            className="size-4"
          />
          Attach the recording
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={jira.attachScreenshots}
            onChange={(e) => void update({ attachScreenshots: e.target.checked })}
            className="size-4"
          />
          Attach the screenshots
        </label>
      </div>

      <CheckRow check={check} disabled={incomplete} onRun={() => void run()} />
    </div>
  );
}

/**
 * A "Test connection" button and its answer.
 *
 * Worth its own component because the question it settles — are these credentials good,
 * and can this extension reach that host — is the one a tester has when an export or a
 * generation fails, and answering it cheaply beats answering it by trying the real thing.
 */
function CheckRow({
  check,
  disabled,
  onRun,
}: {
  check: Check;
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <div className="mt-4 flex items-start gap-3">
      <button
        type="button"
        onClick={onRun}
        disabled={disabled || check.state === 'running'}
        className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500 disabled:opacity-50"
      >
        {check.state === 'running' ? 'Checking…' : 'Test connection'}
      </button>
      {'message' in check && (
        <p
          className={`min-w-0 pt-1.5 text-sm ${
            check.state === 'ok' ? 'text-green-700' : 'text-red-600'
          }`}
        >
          {check.message}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      {children}
      <span className="mt-1 block text-xs text-neutral-500">{hint}</span>
    </label>
  );
}
