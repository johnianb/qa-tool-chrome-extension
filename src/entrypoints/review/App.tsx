/**
 * Review page.
 *
 * Phase 1 scope: list recorded sessions and play one back. The step timeline,
 * editable report fields and Jira export land here in later phases — the layout
 * already reserves the two-column shape they need.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteSession, listSessions } from '@/core/storage/db';
import { formatOffset, type Session } from '@/core/session';

export function App() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const all = await listSessions();
    setSessions(all);
    setSelectedId((current) => current ?? all[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => sessions?.find((s) => s.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteSession(id);
      setSelectedId(null);
      await load();
    },
    [load],
  );

  if (sessions === null) {
    return <Centered>Loading…</Centered>;
  }

  if (sessions.length === 0) {
    return (
      <Centered>
        <p className="font-medium">No recordings yet</p>
        <p className="mt-1 text-sm text-neutral-500">
          Open the extension on the tab showing the bug and press Record.
        </p>
      </Centered>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6 lg:flex-row">
      <aside className="w-full shrink-0 lg:w-72">
        <h1 className="mb-3 text-sm font-semibold">Recordings</h1>
        <ul className="flex flex-col gap-1">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => setSelectedId(session.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                  session.id === selectedId
                    ? 'border-neutral-900 bg-neutral-900 text-white'
                    : 'border-neutral-200 hover:border-neutral-400'
                }`}
              >
                <span className="block truncate font-medium">
                  {session.env.title || session.env.url || 'Untitled'}
                </span>
                <span
                  className={`block truncate text-xs ${
                    session.id === selectedId ? 'text-neutral-300' : 'text-neutral-500'
                  }`}
                >
                  {new Date(session.startedAt).toLocaleString()} · {duration(session)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {selected && <Detail session={selected} onDelete={() => void remove(selected.id)} />}
    </div>
  );
}

function Detail({ session, onDelete }: { session: Session; onDelete: () => void }) {
  const videoUrl = useObjectUrl(session.video);

  return (
    <main className="min-w-0 flex-1">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">
            {session.env.title || 'Untitled recording'}
          </h2>
          <p className="truncate text-sm text-neutral-500">{session.env.url}</p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm hover:border-red-400 hover:text-red-600"
        >
          Delete
        </button>
      </header>

      {videoUrl ? (
        <video
          src={videoUrl}
          controls
          className="w-full rounded-xl border border-neutral-200 bg-black"
        />
      ) : (
        <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">
          {session.status === 'recording'
            ? 'Still recording…'
            : 'No video was saved for this recording.'}
        </div>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Stat label="Duration" value={duration(session)} />
        <Stat label="Interactions" value={String(session.events.length)} />
        <Stat label="Console errors" value={String(session.console.filter((c) => c.level === 'error').length)} />
        <Stat label="Failed requests" value={String(session.network.length)} />
      </dl>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6 text-center text-neutral-700">
      <div>{children}</div>
    </div>
  );
}

function duration(session: Session): string {
  if (!session.stoppedAt) return '—';
  return formatOffset(session.stoppedAt - session.startedAt);
}

/** Blob → object URL, revoked when the blob changes or the component unmounts. */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
