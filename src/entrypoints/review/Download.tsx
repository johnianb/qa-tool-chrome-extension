/**
 * Taking a recording's evidence off this page.
 *
 * One menu rather than a button per artifact. Video, screenshots and the report are the
 * same intent — put this somewhere else — and the header already carries two buttons; a
 * fourth and fifth would crowd out the recording's own title. A menu also has room for
 * each item's *size*, which is the fact that decides whether you want it: a 40 MB video
 * and a 180 kB screenshot are not the same request.
 *
 * `<details>` rather than a popup built from scratch, matching Diagnostics below. It is
 * keyboard-operable and dismissible without a focus trap, and it cannot become the kind
 * of blocking dialog that would freeze every other extension context.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@/core/session';
import { toMarkdown } from '@/services/markdown';
import { formatBytes } from '@/services/jira';
import { baseName, downloadBlob, extensionFor, keyframeName } from '@/services/download';

export function DownloadMenu({ session }: { session: Session }) {
  const box = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    if (box.current) box.current.open = false;
  }, []);

  // A menu that stays open after you have clicked away from it reads as stuck. Escape
  // and outside-click are both here because either alone leaves one habit unserved.
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [close]);

  // Selecting a different recording must not leave the previous one's failure attributed
  // to this one.
  useEffect(() => setError(null), [session.id]);

  const run = useCallback(
    async (job: () => Promise<void>) => {
      close();
      setError(null);
      setBusy(true);
      try {
        await job();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [close],
  );

  const video = session.video instanceof Blob ? session.video : null;
  const frames = (session.keyframes ?? []).filter((f) => f.blob instanceof Blob);
  const framesBytes = frames.reduce((sum, f) => sum + f.blob.size, 0);

  const saveVideo = () =>
    run(async () => {
      if (!video) return;
      await downloadBlob(video, `${baseName(session)}.${extensionFor(video, 'webm')}`);
    });

  /*
    One file per frame, in order, rather than a zip. Zipping would mean a new dependency
    in a chunk that is already 566 kB, to save a step in the case where you wanted all
    six — and the count is in the label so the number of files is never a surprise.
  */
  const saveScreenshots = () =>
    run(async () => {
      for (const [index, frame] of frames.entries()) {
        await downloadBlob(frame.blob, keyframeName(session, index, frame.blob));
      }
    });

  const saveReport = () =>
    run(async () => {
      const markdown = new Blob([toMarkdown(session)], { type: 'text/markdown' });
      await downloadBlob(markdown, `${baseName(session)}.md`);
    });

  return (
    <div className="relative">
      <details ref={box}>
        <summary
          className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:border-neutral-500 [&::-webkit-details-marker]:hidden"
          aria-label="Download this recording"
        >
          {busy ? 'Saving…' : 'Download'}
          <span aria-hidden className="text-xs text-neutral-500">
            ▾
          </span>
        </summary>

        <div className="absolute right-0 z-10 mt-1 w-64 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg">
          <Item
            label="Video"
            detail={video ? formatBytes(video.size) : 'none saved'}
            disabled={!video}
            onSelect={saveVideo}
          />
          <Item
            label={`Screenshots${frames.length > 0 ? ` (${frames.length})` : ''}`}
            detail={
              frames.length === 0
                ? 'none captured'
                : `${frames.length} file${frames.length === 1 ? '' : 's'} · ${formatBytes(framesBytes)}`
            }
            disabled={frames.length === 0}
            onSelect={saveScreenshots}
          />
          <Item
            label="Report"
            // Always available: `toMarkdown` renders from the captured log, so this works
            // before a model has written anything — which is also when it is most useful,
            // because there is no other way to get the log off this page.
            detail="Markdown, .md"
            disabled={false}
            onSelect={saveReport}
          />
        </div>
      </details>

      {error && (
        <p className="absolute right-0 top-full mt-1 w-64 rounded-lg bg-red-50 px-2 py-1 text-right text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function Item({
  label,
  detail,
  disabled,
  onSelect,
}: {
  label: string;
  detail: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-neutral-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <span>{label}</span>
      <span className="shrink-0 text-xs text-neutral-500 tabular-nums">{detail}</span>
    </button>
  );
}
