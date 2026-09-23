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
 * Apply a change to a stored session and write it back.
 *
 * Read-modify-write rather than a partial update: the callers are the service worker
 * and the review page, which never touch the same session concurrently.
 */
export async function updateSession(
  id: string,
  mutate: (session: Session) => void,
): Promise<Session | undefined> {
  const session = await getSession(id);
  if (!session) return undefined;
  mutate(session);
  await putSession(session);
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

/** Bytes currently used, so the UI can warn before the quota bites. */
export async function estimateUsage(): Promise<{ usage: number; quota: number }> {
  const est = await navigator.storage?.estimate?.();
  return { usage: est?.usage ?? 0, quota: est?.quota ?? 0 };
}
