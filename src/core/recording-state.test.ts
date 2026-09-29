import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecordingState, getRecordingState, setRecordingState } from './recording-state';
import { DEFAULT_REDACTION, isBlockedHost } from './events/redact';
import type { RecordingState } from './session';

/** A minimal `chrome.storage.session` backed by a plain object. */
let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  });
});

const state: RecordingState = {
  sessionId: 's_abc',
  tabId: 7,
  startedAt: 1_700_000_000_000,
  streamId: 'stream-1',
  redaction: { ...DEFAULT_REDACTION, blockedHosts: ['admin.internal'] },
};

describe('recording state', () => {
  it('round-trips a full record', async () => {
    await setRecordingState(state);
    expect(await getRecordingState()).toEqual(state);
  });

  it('is null before a recording starts and after one is cleared', async () => {
    expect(await getRecordingState()).toBeNull();
    await setRecordingState(state);
    await clearRecordingState();
    expect(await getRecordingState()).toBeNull();
  });

  /**
   * The regression this file exists for. `chrome.storage.session` survives a worker death,
   * so a recording started by a build without `redaction` can still be read by one that
   * has it — and the first thing the worker does with the value is `blockedHosts.some` in
   * the `webNavigation` listener. Undefined there is a TypeError inside an event handler,
   * which presents as a recording that quietly stops logging navigations rather than as
   * an error anyone sees.
   */
  it('fills in redaction for a record written before that field existed', async () => {
    store['recordingState'] = {
      sessionId: 's_old',
      tabId: 7,
      startedAt: 1_700_000_000_000,
      streamId: 'stream-1',
    };

    const recovered = await getRecordingState();
    expect(recovered?.redaction).toEqual(DEFAULT_REDACTION);
    expect(() => isBlockedHost('https://admin.internal/x', recovered!.redaction)).not.toThrow();
    expect(isBlockedHost('https://admin.internal/x', recovered!.redaction)).toBe(false);
  });

  it('fills in a field added to RedactionSettings after a recording began', async () => {
    store['recordingState'] = { ...state, redaction: { blockedHosts: ['admin.internal'] } };

    const recovered = await getRecordingState();
    expect(recovered?.redaction.blockedHosts).toEqual(['admin.internal']);
    expect(recovered?.redaction.allowValuesFor).toEqual([]);
  });
});
