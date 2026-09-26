/**
 * Export to Jira: what will be sent, what it weighs, and the push itself.
 *
 * The attachment sizes are shown *before* the button, not reported after a failure.
 * Jira's default per-file limit is 10 MB and a two-minute tab recording clears that
 * easily, so the size is the piece of information that decides what the tester does
 * next — which is why the trim offer sits beside it rather than appearing in an error.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@/core/session';
import { hasJira, type Settings } from '@/core/settings';
import { updateSession } from '@/core/storage/db';
import {
  ATTACHMENT_LIMIT_BYTES,
  exportToJira,
  formatBytes,
  oversized,
  planAttachments,
  type AttachmentResult,
  type ExportStage,
  type PlannedAttachment,
} from '@/services/jira';
import { canTrim, trimToLastSeconds } from '@/services/video-trim';

/** The window the roadmap specifies for an over-limit recording. */
const TRIM_SECONDS = 30;

export function JiraPanel({
  session,
  settings,
  onOpenSettings,
  onChanged,
}: {
  session: Session;
  settings: Settings | null;
  onOpenSettings: () => void;
  onChanged: () => void;
}) {
  /**
   * A trimmed copy of the recording, held only for this export.
   *
   * Deliberately not written back to the session. The full recording is the evidence;
   * the trim exists because Jira will not take it, and silently replacing 90 seconds of
   * captured behaviour with the last 30 would destroy data the tester cannot recover.
   */
  const [trimmed, setTrimmed] = useState<Blob | null>(null);
  const [trimProgress, setTrimProgress] = useState<number | null>(null);
  const [stage, setStage] = useState<ExportStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    { key: string; url: string; attachments: AttachmentResult[] } | null
  >(null);

  // Everything here is about one recording. Carrying a trim, a result or a failure
  // across to another would attribute it to the wrong session.
  useEffect(() => {
    setTrimmed(null);
    setTrimProgress(null);
    setStage(null);
    setError(null);
    setResult(null);
  }, [session.id]);

  const attachments = useMemo<PlannedAttachment[]>(() => {
    if (!settings) return [];
    const planned = planAttachments(session, settings.jira);
    if (!trimmed) return planned;
    return planned.map((file) =>
      file.kind === 'video'
        ? { ...file, blob: trimmed, name: file.name.replace(/\.webm$/, `-last${TRIM_SECONDS}s.webm`) }
        : file,
    );
  }, [session, settings, trimmed]);

  const video = attachments.find((file) => file.kind === 'video');
  const tooBig = oversized(attachments);
  const configured = settings !== null && hasJira(settings);

  const trim = useCallback(async () => {
    if (!(session.video instanceof Blob)) return;
    setError(null);
    setTrimProgress(0);
    try {
      setTrimmed(
        await trimToLastSeconds(session.video, TRIM_SECONDS, {
          knownDurationMs: session.stoppedAt ? session.stoppedAt - session.startedAt : undefined,
          onProgress: setTrimProgress,
        }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setTrimProgress(null);
    }
  }, [session]);

  const push = useCallback(async () => {
    if (!settings) return;
    setError(null);
    setResult(null);
    setStage({ kind: 'creating' });
    try {
      const created = await exportToJira(session, settings.jira, { attachments, onStage: setStage });
      await updateSession(session.id, (stored) => {
        stored.jiraKey = created.key;
        stored.status = 'exported';
      });
      setResult(created);
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setStage(null);
    }
  }, [session, settings, attachments, onChanged]);

  const busy = stage !== null || trimProgress !== null;

  return (
    <section className="mt-5 rounded-xl border border-neutral-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          Export to Jira
          {session.jiraKey && (
            <span className="ml-2 font-normal text-neutral-500">
              already exported as {session.jiraKey}
            </span>
          )}
        </h3>
        <button
          type="button"
          onClick={() => void push()}
          disabled={!configured || busy || session.status === 'recording'}
          className="rounded-lg border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
        >
          {stageLabel(stage) ?? (session.jiraKey ? 'Create another issue' : 'Create issue')}
        </button>
      </div>

      {!configured ? (
        <p className="mt-3 text-sm text-neutral-500">
          Not configured.{' '}
          <button type="button" onClick={onOpenSettings} className="underline hover:text-neutral-900">
            Add your Jira site, email, API token and project key
          </button>{' '}
          to push this report as an issue.
        </p>
      ) : (
        <>
          <p className="mt-3 text-sm text-neutral-500">
            Creates a {settings.jira.issueType || 'Bug'} in {settings.jira.projectKey} on{' '}
            {settings.jira.baseUrl}
            {session.report ? ' from the written report' : ' from the captured log'}.
          </p>

          <Attachments attachments={attachments} />

          {tooBig.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <p>
                {tooBig.map((file) => file.name).join(', ')} exceeds Jira's default{' '}
                {formatBytes(ATTACHMENT_LIMIT_BYTES)} attachment limit. The issue will still be
                created; the oversized file will be the only thing rejected.
              </p>
              {video && !trimmed && canTrim() && (
                <button
                  type="button"
                  onClick={() => void trim()}
                  disabled={busy}
                  className="mt-2 rounded-lg border border-amber-400 px-2.5 py-1 text-xs font-medium hover:bg-amber-100 disabled:opacity-50"
                >
                  Trim the video to its last {TRIM_SECONDS}s
                </button>
              )}
            </div>
          )}

          {trimProgress !== null && (
            <p className="mt-3 text-sm text-neutral-600">
              Trimming — {Math.round(trimProgress * 100)}%.{' '}
              {/* Stated up front so a 30-second wait does not read as a hang. */}
              <span className="text-neutral-500">
                This replays the last {TRIM_SECONDS}s in real time, so it takes about that long.
              </span>
            </p>
          )}

          {trimmed && (
            <p className="mt-3 text-sm text-green-700">
              Trimmed to the last {TRIM_SECONDS}s ({formatBytes(trimmed.size)}). The full
              recording is untouched and stays on this machine.
            </p>
          )}
        </>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {result && <Result result={result} />}
    </section>
  );
}

/** What is going up, and what it weighs. */
function Attachments({ attachments }: { attachments: PlannedAttachment[] }) {
  if (attachments.length === 0) {
    return (
      <p className="mt-3 text-sm text-neutral-500">
        No attachments — the issue will be the written report only.
      </p>
    );
  }

  const total = attachments.reduce((sum, file) => sum + file.blob.size, 0);

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-xs text-neutral-500">
        <span>
          {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
        </span>
        <span className="tabular-nums">{formatBytes(total)} total</span>
      </div>
      <ul className="mt-1 divide-y divide-neutral-100 text-sm">
        {attachments.map((file) => (
          <li key={file.name} className="flex items-baseline justify-between gap-3 py-1">
            <span className="min-w-0 truncate font-mono text-xs">{file.name}</span>
            <span
              className={`shrink-0 tabular-nums ${
                file.blob.size > ATTACHMENT_LIMIT_BYTES ? 'font-medium text-amber-700' : 'text-neutral-500'
              }`}
            >
              {formatBytes(file.blob.size)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The outcome.
 *
 * Attachment failures are listed rather than folded into a single "partly failed":
 * the issue exists either way, and what the tester needs to know is precisely which
 * file is missing from it.
 */
function Result({
  result,
}: {
  result: { key: string; url: string; attachments: AttachmentResult[] };
}) {
  const failed = result.attachments.filter((file) => !file.ok);

  return (
    <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm">
      <p className="text-green-800">
        Created{' '}
        <a href={result.url} target="_blank" rel="noreferrer" className="font-medium underline">
          {result.key}
        </a>
        {result.attachments.length > 0 &&
          ` with ${result.attachments.length - failed.length} of ${result.attachments.length} attachments`}
        .
      </p>
      {failed.length > 0 && (
        <ul className="mt-2 space-y-1 text-red-700">
          {failed.map((file) => (
            <li key={file.name}>
              <span className="font-mono text-xs">{file.name}</span> ({formatBytes(file.size)}) was
              not attached: {file.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function stageLabel(stage: ExportStage | null): string | null {
  if (!stage) return null;
  return stage.kind === 'creating'
    ? 'Creating issue…'
    : `Attaching ${stage.index} of ${stage.total}…`;
}
