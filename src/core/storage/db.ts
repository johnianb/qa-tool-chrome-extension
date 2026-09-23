/**
 * IndexedDB access for recorded sessions.
 *
 * Sessions hold video and screenshot Blobs that run to tens of megabytes, so they
 * live in IndexedDB rather than `chrome.storage.local` (quota-limited, and it
 * serialises values through JSON, which destroys Blobs).
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Session } from '../session';

const DB_NAME = 'qa-bug-reporter';
const DB_VERSION = 1;
const STORE = 'sessions';

interface QaDB extends DBSchema {
  sessions: {
    key: string;
    value: Session;
    indexes: { 'by-startedAt': number };
  };
}

let dbPromise: Promise<IDBPDatabase<QaDB>> | null = null;

function db(): Promise<IDBPDatabase<QaDB>> {
  dbPromise ??= openDB<QaDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const store = database.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('by-startedAt', 'startedAt');
    },
  });
  return dbPromise;
}

export async function putSession(session: Session): Promise<void> {
  await (await db()).put(STORE, session);
}

export async function getSession(id: string): Promise<Session | undefined> {
  return (await db()).get(STORE, id);
}

/**
 * Apply a change to a stored session and write it back, atomically.
 *
 * The get and the put share **one** `readwrite` transaction. This is not a detail:
 * IndexedDB serialises readwrite transactions over the same store, so a single
 * transaction makes concurrent updates queue instead of interleave. Across two separate
 * transactions they interleave freely, and the last writer silently wins with whatever
 * stale copy it read.
 *
 * That bug cost a day here. The service worker, the offscreen document and the review
 * page all write to the same session record — the offscreen document saving a video
 * while the worker appended a trace line was enough to erase a 694 KB recording, with
 * the trace itself as the clobbering write. Never reintroduce a get/put pair.
 *
 * `mutate` must be synchronous: awaiting anything that is not an IndexedDB request
 * inside a transaction lets it auto-close, and the put then throws.
 */
export async function updateSession(
  id: string,
  mutate: (session: Session) => void,
): Promise<Session | undefined> {
  const database = await db();
  const tx = database.transaction(STORE, 'readwrite');
  const session = await tx.store.get(id);
  if (!session) {
    await tx.done;
    return undefined;
  }
  mutate(session);
  await tx.store.put(session);
  await tx.done;
  return session;
}

/** All sessions, newest first. */
export async function listSessions(): Promise<Session[]> {
  const all = await (await db()).getAllFromIndex(STORE, 'by-startedAt');
  return all.reverse();
}

export async function deleteSession(id: string): Promise<void> {
  await (await db()).delete(STORE, id);
}

/**
 * Append a lifecycle breadcrumb to a session.
 *
 * Safe to call from any extension context — they all share this database. Failures are
 * swallowed: a diagnostic that can break the thing it is diagnosing is worse than no
 * diagnostic.
 */
export async function appendTrace(
  sessionId: string,
  context: 'worker' | 'offscreen',
  line: string,
): Promise<void> {
  try {
    await updateSession(sessionId, (session) => {
      const at = Date.now() - session.startedAt;
      const stamp = `T+${Math.floor(at / 1000)}.${String(at % 1000).padStart(3, '0')}s`;
      session.trace ??= [];
      session.trace.push(`${stamp}  ${context}: ${line}`);
    });
  } catch {
    // ignore
  }
}

/** Bytes currently used, so the UI can warn before the quota bites. */
export async function estimateUsage(): Promise<{ usage: number; quota: number }> {
  const est = await navigator.storage?.estimate?.();
  return { usage: est?.usage ?? 0, quota: est?.quota ?? 0 };
}
