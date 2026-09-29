import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JIRA,
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  getSettings,
  hasApiKey,
  hasJira,
  saveJira,
  saveProvider,
  saveRedaction,
  saveSettings,
} from './settings';
import { DEFAULT_REDACTION } from './events/redact';

/** A minimal `chrome.storage.local` backed by a plain object. */
let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        },
      },
    },
  });
});

describe('getSettings', () => {
  it('returns the defaults when nothing has been saved', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  /**
   * The regression this file exists for. A shallow spread hands back the stored `jira`
   * object verbatim, so every field added to `JiraSettings` after a tester last saved
   * reads `undefined` — which turns a controlled React input into an uncontrolled one
   * and presents as a field that will not accept typing.
   */
  it('backfills Jira fields missing from a record written by an older build', async () => {
    store.settings = { apiKey: 'sk-ant-x', jira: { baseUrl: 'https://team.atlassian.net' } };

    const settings = await getSettings();

    expect(settings.jira.baseUrl).toBe('https://team.atlassian.net');
    expect(settings.jira.issueType).toBe(DEFAULT_JIRA.issueType);
    expect(settings.jira.attachVideo).toBe(true);
    expect(settings.anthropic.model).toBe(DEFAULT_PROVIDERS.anthropic.model);
  });

  it('backfills the whole Jira block when the record predates it', async () => {
    store.settings = { apiKey: 'sk-ant-x', model: 'claude-sonnet-5', sendScreenshots: false };
    expect((await getSettings()).jira).toEqual(DEFAULT_JIRA);
  });

  /**
   * Before report generation had a provider, the Anthropic key and model were stored
   * flat. A tester upgrading into this build must not be shown an empty key field and
   * left to wonder where their key went.
   */
  it('folds a pre-provider record into the Anthropic provider', async () => {
    store.settings = { apiKey: 'sk-ant-x', model: 'claude-sonnet-5' };

    const settings = await getSettings();

    expect(settings.anthropic).toEqual({ apiKey: 'sk-ant-x', model: 'claude-sonnet-5' });
    expect(settings.provider).toBe('anthropic');
    expect(settings.google).toEqual(DEFAULT_PROVIDERS.google);
  });

  it('backfills a provider block the stored record does not have', async () => {
    store.settings = { provider: 'google', anthropic: { apiKey: 'sk-ant-x', model: 'claude-opus-5' } };
    expect((await getSettings()).google).toEqual(DEFAULT_PROVIDERS.google);
  });
});

describe('saveSettings', () => {
  it('merges the patch and leaves the Jira block untouched', async () => {
    await saveJira({ projectKey: 'QA' });
    await saveSettings({ provider: 'google' });

    const settings = await getSettings();
    expect(settings.provider).toBe('google');
    expect(settings.jira.projectKey).toBe('QA');
  });

  /**
   * The stale-copy hazard: a migrated record that keeps its flat `apiKey` alongside
   * `anthropic.apiKey` holds the same credential twice, and the flat one is never
   * written again.
   */
  it('drops the pre-provider fields from the stored record', async () => {
    store.settings = { apiKey: 'sk-ant-x', model: 'claude-sonnet-5' };

    await saveSettings({ sendScreenshots: false });

    expect(store.settings).not.toHaveProperty('apiKey');
    expect(store.settings).not.toHaveProperty('model');
    expect((await getSettings()).anthropic.apiKey).toBe('sk-ant-x');
  });
});

describe('saveProvider', () => {
  it('patches one provider without touching the other', async () => {
    await saveProvider('anthropic', { apiKey: 'sk-ant-x' });
    await saveProvider('google', { apiKey: 'AIza-y' });

    const settings = await getSettings();
    expect(settings.anthropic.apiKey).toBe('sk-ant-x');
    expect(settings.google.apiKey).toBe('AIza-y');
    // The model each provider had is not collateral damage of setting the other's key.
    expect(settings.anthropic.model).toBe(DEFAULT_PROVIDERS.anthropic.model);
    expect(settings.google.model).toBe(DEFAULT_PROVIDERS.google.model);
  });

  it('keeps the key when only the model changes', async () => {
    await saveProvider('google', { apiKey: 'AIza-y' });
    await saveProvider('google', { model: 'gemini-3.5-flash' });

    const { google } = await getSettings();
    expect(google).toEqual({ apiKey: 'AIza-y', model: 'gemini-3.5-flash' });
  });
});

describe('saveJira', () => {
  it('patches one Jira field without clearing the others', async () => {
    await saveJira({ baseUrl: 'https://team.atlassian.net', email: 'qa@team.test' });
    await saveJira({ projectKey: 'QA' });

    const { jira } = await getSettings();
    expect(jira).toMatchObject({
      baseUrl: 'https://team.atlassian.net',
      email: 'qa@team.test',
      projectKey: 'QA',
      issueType: 'Bug',
    });
  });

  it('leaves the provider keys alone', async () => {
    await saveProvider('anthropic', { apiKey: 'sk-ant-x' });
    await saveJira({ projectKey: 'QA' });
    expect((await getSettings()).anthropic.apiKey).toBe('sk-ant-x');
  });
});

describe('hasApiKey', () => {
  it('treats whitespace as absent', () => {
    const anthropic = (apiKey: string) => ({
      ...DEFAULT_SETTINGS,
      anthropic: { ...DEFAULT_PROVIDERS.anthropic, apiKey },
    });

    expect(hasApiKey(anthropic('   '))).toBe(false);
    expect(hasApiKey(anthropic('sk-ant-x'))).toBe(true);
  });

  /** It answers for the selected provider, not for whichever key happens to be set. */
  it('ignores the key of the provider that is not selected', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      provider: 'google' as const,
      anthropic: { ...DEFAULT_PROVIDERS.anthropic, apiKey: 'sk-ant-x' },
    };

    expect(hasApiKey(settings)).toBe(false);
    expect(hasApiKey({ ...settings, google: { ...DEFAULT_PROVIDERS.google, apiKey: 'AIza-y' } })).toBe(
      true,
    );
  });
});

describe('hasJira', () => {
  const complete = {
    ...DEFAULT_JIRA,
    baseUrl: 'https://team.atlassian.net',
    email: 'qa@team.test',
    apiToken: 'token',
    projectKey: 'QA',
  };

  it('requires all four connection fields', () => {
    expect(hasJira({ ...DEFAULT_SETTINGS, jira: complete })).toBe(true);
    expect(hasJira({ ...DEFAULT_SETTINGS, jira: { ...complete, projectKey: '' } })).toBe(false);
    expect(hasJira({ ...DEFAULT_SETTINGS, jira: { ...complete, apiToken: ' ' } })).toBe(false);
  });

  /** The issue type has a working default, so it is not part of "configured". */
  it('does not require the issue type to have been changed', () => {
    expect(hasJira({ ...DEFAULT_SETTINGS, jira: { ...complete, issueType: 'Bug' } })).toBe(true);
  });
});

describe('redaction settings', () => {
  it('defaults to both lists empty, so nothing is captured in full unasked', async () => {
    const settings = await getSettings();
    expect(settings.redaction).toEqual(DEFAULT_REDACTION);
    expect(settings.redaction.allowValuesFor).toEqual([]);
    expect(settings.redaction.blockedHosts).toEqual([]);
  });

  it('saves one list without disturbing the other', async () => {
    await saveRedaction({ blockedHosts: ['admin.internal'] });
    await saveRedaction({ allowValuesFor: ['orderId'] });

    const settings = await getSettings();
    expect(settings.redaction.blockedHosts).toEqual(['admin.internal']);
    expect(settings.redaction.allowValuesFor).toEqual(['orderId']);
  });

  /** Arrays are replaced wholesale, not merged — removing the last host must empty it. */
  it('lets a list be emptied again', async () => {
    await saveRedaction({ blockedHosts: ['admin.internal'] });
    await saveRedaction({ blockedHosts: [] });
    expect((await getSettings()).redaction.blockedHosts).toEqual([]);
  });

  /**
   * The same second-level merge the `jira` block needs. A record written before
   * `redaction` existed must not read back `undefined`, which would throw on
   * `blockedHosts.some` in the worker and refuse every recording.
   */
  it('fills in redaction for a record written before it existed', async () => {
    store['settings'] = { provider: 'google', jira: DEFAULT_JIRA };
    expect((await getSettings()).redaction).toEqual(DEFAULT_REDACTION);
  });

  it('fills in a field added to RedactionSettings after a tester last saved', async () => {
    store['settings'] = { redaction: { blockedHosts: ['admin.internal'] } };

    const { redaction } = await getSettings();
    expect(redaction.blockedHosts).toEqual(['admin.internal']);
    expect(redaction.allowValuesFor).toEqual([]);
  });

  it('does not leave the credentials behind when redaction is saved', async () => {
    await saveProvider('anthropic', { apiKey: 'sk-ant-x' });
    await saveRedaction({ blockedHosts: ['admin.internal'] });
    expect((await getSettings()).anthropic.apiKey).toBe('sk-ant-x');
  });
});
