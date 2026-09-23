import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSession, listSessions, putSession, updateSession, appendTrace } from './db';
import type { Session } from '../session';

function blankSession(id: string): Session {
  return {
    id,
    status: 'recording',
    startedAt: Date.now(),
    env: {
      url: 'https://example.test/',
      title: 'Example',
      userAgent: 'test',
      viewport: { width: 1280, height: 720 },
      devicePixelRatio: 1,
      recordedAt: new Date().toISOString(),
      extensionVersion: '0.0.0',
    },
    events: [],
    console: [],
    network: [],
    keyframes: [],
    trace: [],
  };
}

describe('updateSession', () => {
  beforeEach(async () => {
    for (const session of await listSessions()) {
      await updateSession(session.id, (s) => {
        s.trace = [];
      });
    }
  });

  it('applies a change', async () => {
    await putSession(blankSession('s1'));
    await updateSession('s1', (s) => {
      s.status = 'stopped';
    });
    expect((await getSession('s1'))?.status).toBe('stopped');
  });

  it('returns undefined for a session that does not exist', async () => {
    expect(await updateSession('nope', () => {})).toBeUndefined();
  });

  /**
   * The regression that erased a 694 KB recording.
   *
   * The offscreen document saves the video while the service worker appends a trace
   * line. With a get and a put in separate transactions these interleave and the later
   * writer puts back a stale copy — the trace write silently deleting the video.
   */
  it('does not lose a concurrent write', async () => {
    await putSession(blankSession('s2'));

    // Stands in for the video blob: `fake-indexeddb` cannot structured-clone a Blob
    // under jsdom, and the race being tested is indifferent to the field's type — it is
    // about two writers reading the same record before either has written back.
    await Promise.all([
      updateSession('s2', (s) => {
        s.jiraKey = 'THE-VIDEO';
      }),
      updateSession('s2', (s) => {
        s.trace.push('worker: stop requested');
      }),
      updateSession('s2', (s) => {
        s.trace.push('offscreen: recorder stopped');
      }),
    ]);

    const saved = await getSession('s2');
    expect(saved?.jiraKey, 'the payload survived concurrent trace writes').toBe('THE-VIDEO');
    expect(saved?.trace, 'no trace line was lost').toHaveLength(2);
  });

  it('keeps every line when trace writes race each other', async () => {
    await putSession(blankSession('s3'));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => appendTrace('s3', 'worker', `line ${i}`)),
    );
    expect((await getSession('s3'))?.trace).toHaveLength(20);
  });
});
