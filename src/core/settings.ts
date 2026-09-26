/**
 * Extension settings, in `chrome.storage.local`.
 *
 * `local`, and deliberately not `sync`: `chrome.storage.sync` replicates through the
 * signed-in Google account to every machine and profile the tester uses. Copying a
 * credential across machines is a decision for the person holding it, not a side effect
 * of saving a form, so credentials stay on the machine they were typed into.
 *
 * Nothing here is secret *from* the tester — an extension's storage is readable by
 * anyone who can open its DevTools, and the credentials are theirs. They are kept off
 * the network and out of sync, which is the part that matters.
 */

/**
 * Jira Cloud connection details.
 *
 * An API token, not a password: Atlassian disabled password auth for the REST API, and
 * a token can be revoked from the account page without changing the login. Both are
 * sent as HTTP Basic, which is what Atlassian's own documentation specifies.
 */
export interface JiraSettings {
  /** Site root, e.g. `https://yourteam.atlassian.net`. Normalised on save. */
  baseUrl: string;
  /** The Atlassian account email the token belongs to — the Basic auth username. */
  email: string;
  /** Created at id.atlassian.com → Security → API tokens. */
  apiToken: string;
  /** Project the issue is created in, e.g. `QA`. */
  projectKey: string;
  /** Issue type name. `Bug` on almost every project; editable because it is renameable. */
  issueType: string;
  /** Whether the recording is attached to the issue. */
  attachVideo: boolean;
  /** Whether keyframe screenshots are attached to the issue. */
  attachScreenshots: boolean;
}

/**
 * Who writes the report.
 *
 * Two providers rather than one because neither key is a given: an Anthropic key is
 * bought with credits, while Google issues a free-tier key from AI Studio. A tester
 * who has one of them should not be blocked for want of the other.
 */
export type Provider = 'anthropic' | 'google';

/** What to call each provider in front of a tester. */
export const PROVIDER_NAMES: Record<Provider, string> = {
  anthropic: 'Claude',
  google: 'Gemini',
};

/** One provider's credentials. */
export interface ProviderSettings {
  /** Empty until the tester supplies one; report generation is unavailable until then. */
  apiKey: string;
  /**
   * Model id, overridable so a tester can drop to a cheaper model for a noisy session
   * without a rebuild — and so a model released after this build can be typed in.
   */
  model: string;
}

export interface Settings {
  /** Which provider report generation uses. */
  provider: Provider;
  /**
   * Both providers' settings are kept, not just the selected one's. Switching provider
   * to compare a report is a thing a tester will do twice in a minute, and a switch
   * that discarded the other key would make it cost a trip to a credentials page.
   */
  anthropic: ProviderSettings;
  google: ProviderSettings;
  /**
   * Whether keyframe screenshots are sent along with the event log.
   *
   * Screenshots are pixels, and Phase 5's redaction cannot touch them — a frame of a
   * patient record is legible to anything that receives it. The event log is already
   * shape-only; images are not. This toggle is the only control over that, so it is a
   * setting rather than a constant.
   */
  sendScreenshots: boolean;
  jira: JiraSettings;
}

export const DEFAULT_JIRA: JiraSettings = {
  baseUrl: '',
  email: '',
  apiToken: '',
  projectKey: '',
  issueType: 'Bug',
  attachVideo: true,
  attachScreenshots: true,
};

export const DEFAULT_PROVIDERS: Record<Provider, ProviderSettings> = {
  anthropic: { apiKey: '', model: 'claude-opus-5' },
  // A Flash model by default, not the largest Gemini: this is the provider a tester
  // reaches for because it has a free tier, and the free tier is where the flagship
  // models are rationed hardest. Editable for anyone who wants otherwise.
  google: { apiKey: '', model: 'gemini-3.8-flash' },
};

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  anthropic: DEFAULT_PROVIDERS.anthropic,
  google: DEFAULT_PROVIDERS.google,
  sendScreenshots: true,
  jira: DEFAULT_JIRA,
};

const KEY = 'settings';

/**
 * Settings as written before report generation had a provider: a single `apiKey` and
 * `model` at the top level, both Anthropic's. Read and folded into `anthropic` so an
 * upgrade does not present an existing tester with an empty key field.
 */
type LegacySettings = { apiKey?: string; model?: string };

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const saved = (stored[KEY] as (Partial<Settings> & LegacySettings) | undefined) ?? {};
  return {
    // Spread over the defaults rather than returning the stored object: a build that
    // adds a setting must not read `undefined` out of a record written by the previous
    // one.
    ...DEFAULT_SETTINGS,
    ...saved,
    // The nested objects are merged a second level down for the same reason. A shallow
    // spread would hand back whatever nested object was written by the build that saved
    // it, so the first setting added to `JiraSettings` would read `undefined` for every
    // existing user — and `undefined` in a controlled React input switches it to
    // uncontrolled, which React reports as a warning and the tester experiences as a
    // field that will not accept typing.
    anthropic: {
      ...DEFAULT_PROVIDERS.anthropic,
      ...(saved.apiKey === undefined ? {} : { apiKey: saved.apiKey }),
      ...(saved.model === undefined ? {} : { model: saved.model }),
      // Last, so a record that somehow holds both shapes keeps the newer one.
      ...(saved.anthropic ?? {}),
    },
    google: { ...DEFAULT_PROVIDERS.google, ...(saved.google ?? {}) },
    jira: { ...DEFAULT_JIRA, ...(saved.jira ?? {}) },
  };
}

/** Save the settings that are not nested: the provider choice and the screenshot toggle. */
export async function saveSettings(
  patch: Partial<Pick<Settings, 'provider' | 'sendScreenshots'>>,
): Promise<Settings> {
  return write({ ...(await getSettings()), ...patch });
}

/** Save one provider's key or model, leaving the other provider's alone. */
export async function saveProvider(
  provider: Provider,
  patch: Partial<ProviderSettings>,
): Promise<Settings> {
  const current = await getSettings();
  return write({ ...current, [provider]: { ...current[provider], ...patch } });
}

export async function saveJira(patch: Partial<JiraSettings>): Promise<Settings> {
  const current = await getSettings();
  return write({ ...current, jira: { ...current.jira, ...patch } });
}

/**
 * Write the whole record, and drop the pre-provider fields while doing it.
 *
 * Without the delete, a migrated record keeps a stale top-level `apiKey` next to the
 * live `anthropic.apiKey` — two copies of a credential, one of which is never updated
 * again and would silently win if the merge order in `getSettings` ever changed.
 */
async function write(next: Settings): Promise<Settings> {
  const record: Settings & LegacySettings = { ...next };
  delete record.apiKey;
  delete record.model;
  await chrome.storage.local.set({ [KEY]: record });
  return next;
}

/** The credentials report generation will actually use. */
export function activeProvider(settings: Settings): ProviderSettings {
  return settings[settings.provider];
}

/** Whether report generation is configured for the selected provider. */
export function hasApiKey(settings: Settings): boolean {
  return activeProvider(settings).apiKey.trim().length > 0;
}

/** Whether a Jira export can be attempted at all. */
export function hasJira(settings: Settings): boolean {
  const { baseUrl, email, apiToken, projectKey } = settings.jira;
  return [baseUrl, email, apiToken, projectKey].every((value) => value.trim().length > 0);
}
