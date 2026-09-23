/**
 * Review page.
 *
 * Phase 1 scope: list recorded sessions and play one back. The step timeline,
 * editable report fields and Jira export land here in later phases — the layout
 * already reserves the two-column shape they need.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteSession, listSessions } from '@/core/storage/db';
import { formatOffset, type Session } from '@/core/session';
import { toMarkdown, toSteps } from '@/services/markdown';

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
  const video = useRef<HTMLVideoElement>(null);
  const steps = useMemo(() => toSteps(session.events), [session.events]);

  /**
   * Seek the player to the moment a step happened.
   *
   * Every captured event carries `t` relative to the recording start, so this costs
   * nothing to implement — and it is what lets a reviewer check a written step against
   * what actually happened instead of taking the report on trust.
   */
  const seekTo = useCallback((atMs: number) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = atMs / 1000;
    void el.play().catch(() => {
      // Autoplay may be refused; the seek still happened, which is the point.
    });
  }, []);

  return (
    <main className="min-w-0 flex-1">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">
            {session.env.title || 'Untitled recording'}
          </h2>
          <p className="truncate text-sm text-neutral-500">{session.env.url}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <CopyMarkdownButton session={session} />
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm hover:border-red-400 hover:text-red-600"
          >
            Delete
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="min-w-0 flex-1">
          {videoUrl ? (
            <video
              ref={video}
              src={videoUrl}
              controls
              className="w-full rounded-xl border border-neutral-200 bg-black"
            />
          ) : (
            <NoVideo session={session} />
          )}
        </div>
        <Steps steps={steps} onSeek={seekTo} seekable={videoUrl !== null} />
      </div>

      <Diagnostics session={session} />

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Stat label="Duration" value={duration(session)} />
        <Stat label="Interactions" value={String(session.events.length)} />
        <Stat label="Console errors" value={String(session.console.filter((c) => c.level === 'error').length)} />
        <Stat label="Failed requests" value={String(session.network.length)} />
      </dl>
    </main>
  );
}

/** The reproduction steps, each one a seek into the video. */
function Steps({
  steps,
  onSeek,
  seekable,
}: {
  steps: ReturnType<typeof toSteps>;
  onSeek: (atMs: number) => void;
  seekable: boolean;
}) {
  return (
    <section className="w-full lg:w-80">
      <h3 className="mb-2 text-sm font-semibold">
        Steps to reproduce
        <span className="ml-2 font-normal text-neutral-500">{steps.length}</span>
      </h3>

      {steps.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500">
          No interactions were captured. If the recording predates event capture, record
          a new one.
        </p>
      ) : (
        <ol className="max-h-[28rem] overflow-y-auto pr-1">
          {steps.map((step) => (
            <li key={step.n}>
              <button
                type="button"
                onClick={() => onSeek(step.atMs)}
                disabled={!seekable}
                className="flex w-full gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="w-4 shrink-0 text-right text-neutral-400 tabular-nums">
                  {step.n}
                </span>
                <span className="min-w-0 flex-1">{step.text}</span>
                <span className="shrink-0 text-neutral-400 tabular-nums">
                  {formatOffset(step.atMs)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Copies the rendered Markdown report to the clipboard. */
function CopyMarkdownButton({ session }: { session: Session }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(toMarkdown(session));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [session]);

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="rounded-lg border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
    >
      {copied ? 'Copied' : 'Copy report'}
    </button>
  );
}

/**
 * Shown in place of the player when there is no video.
 *
 * A recording that produced nothing is the failure a tester is most likely to hit, so
 * this says what went wrong and where to look rather than leaving a blank box.
 */
function NoVideo({ session }: { session: Session }) {
  if (session.status === 'recording') {
    return (
      <Placeholder>
        <p>Still recording…</p>
      </Placeholder>
    );
  }

  if (session.error) {
    return (
      <Placeholder tone="error">
        <p className="font-medium text-red-700">This recording failed</p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-left text-xs text-red-700">
          {session.error}
        </pre>
      </Placeholder>
    );
  }

  return (
    <Placeholder>
      <p className="font-medium">No video was saved</p>
      <p className="mt-1">
        The recorder never produced data. The diagnostics below show how far the
        recording got — the last line is where it stopped.
      </p>
    </Placeholder>
  );
}

function Placeholder({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'error';
}) {
  return (
    <div
      className={`rounded-xl border border-dashed p-8 text-center text-sm ${
        tone === 'error'
          ? 'border-red-300 bg-red-50 text-red-700'
          : 'border-neutral-300 text-neutral-500'
      }`}
    >
      {children}
    </div>
  );
}

/**
 * The recording lifecycle, as it actually happened.
 *
 * Open by default when there is no video, because that is exactly when someone needs
 * it; collapsed otherwise so a healthy recording stays uncluttered. The last line
 * reached is the answer to "where did it stop?".
 */
function Diagnostics({ session }: { session: Session }) {
  const trace = session.trace ?? [];
  const failed = !(session.video instanceof Blob) && session.status !== 'recording';
  if (trace.length === 0) return null;

  return (
    <details open={failed} className="mt-5 rounded-xl border border-neutral-200">
      <summary className="cursor-pointer px-4 py-2 text-sm font-medium">
        Diagnostics
        <span className="ml-2 font-normal text-neutral-500">{trace.length} steps</span>
      </summary>
      <pre className="overflow-x-auto border-t border-neutral-200 px-4 py-3 text-xs leading-relaxed text-neutral-700">
        {trace.join('\n')}
      </pre>
    </details>
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

/**
 * Blob → object URL, revoked when the blob changes or the component unmounts.
 *
 * The `instanceof` check is load-bearing, not defensive noise. A session written by an
 * older build can hold `{}` where a Blob belongs (a Blob does not survive
 * `chrome.runtime.sendMessage`, which serialises as JSON). `URL.createObjectURL({})`
 * throws, and a throw inside an effect unmounts the React root — one bad record would
 * otherwise blank the whole page.
 */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!(blob instanceof Blob) || blob.size === 0) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
