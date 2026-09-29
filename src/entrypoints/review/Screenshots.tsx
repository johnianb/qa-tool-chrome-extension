/**
 * The keyframe gallery.
 *
 * Per-image delete is the point of this component, not a convenience. Screenshots are
 * the one thing the tool captures that redaction cannot touch — a frame showing a
 * patient record is legible to whatever receives it — so the tester needs a way to drop
 * a frame *before* it is sent to a model or attached to a ticket that the whole company
 * can read. Deleting here removes it from the stored session, so it is gone from both.
 */
import { useCallback, useState } from 'react';
import { formatOffset, type Keyframe, type Session } from '@/core/session';
import { updateSession } from '@/core/storage/db';
import { formatBytes } from '@/services/jira';
import { downloadBlob, keyframeName } from '@/services/download';
import { useObjectUrl } from './useObjectUrl';

export function Screenshots({
  session,
  onSeek,
  onChanged,
}: {
  session: Session;
  onSeek: (atMs: number) => void;
  onChanged: () => void;
}) {
  // Index of the frame awaiting a second click. A deleted screenshot cannot be
  // recovered, and a `confirm()` dialog would block every extension context — so the
  // confirmation is the button itself, changing to ask.
  const [confirming, setConfirming] = useState<number | null>(null);

  const remove = useCallback(
    async (index: number) => {
      await updateSession(session.id, (stored) => {
        stored.keyframes.splice(index, 1);
      });
      setConfirming(null);
      onChanged();
    },
    [session.id, onChanged],
  );

  const frames = session.keyframes ?? [];
  if (frames.length === 0) return null;

  const total = frames.reduce(
    (sum, frame) => sum + (frame.blob instanceof Blob ? frame.blob.size : 0),
    0,
  );

  return (
    <section className="mt-5">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">
          Screenshots
          <span className="ml-2 font-normal text-neutral-500">{frames.length}</span>
        </h3>
        <p className="text-xs text-neutral-500 tabular-nums">{formatBytes(total)}</p>
      </div>

      <p className="mb-3 text-xs text-neutral-500">
        Sent to the model that writes the report and attached to Jira unless you remove
        them. Screenshots are pixels — nothing scrubs what is visible in one.
      </p>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {frames.map((frame, index) => (
          <Thumbnail
            // `t` alone repeats when two frames land in the same millisecond, and React
            // reuses the wrong object URL when a key collides.
            key={`${frame.t}-${index}`}
            frame={frame}
            onSeek={() => onSeek(frame.t)}
            confirming={confirming === index}
            onAskDelete={() => setConfirming(index)}
            onCancelDelete={() => setConfirming(null)}
            onConfirmDelete={() => void remove(index)}
            /*
              Per-frame, beside the per-frame delete. The header's Download menu takes all
              of them at once, but the common errand is one frame for a chat message —
              and this is where you are already looking at the one you want.
            */
            onDownload={() => {
              void downloadBlob(frame.blob, keyframeName(session, index, frame.blob));
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function Thumbnail({
  frame,
  onSeek,
  confirming,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
  onDownload,
}: {
  frame: Keyframe;
  onSeek: () => void;
  confirming: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onDownload: () => void;
}) {
  const url = useObjectUrl(frame.blob);

  return (
    <li className="group relative overflow-hidden rounded-lg border border-neutral-200">
      <button
        type="button"
        onClick={onSeek}
        title={`Seek the video to ${formatOffset(frame.t)}`}
        className="block w-full text-left"
      >
        {url ? (
          <img src={url} alt={frame.caption} className="aspect-video w-full object-cover" />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center bg-neutral-100 text-xs text-neutral-500">
            Image unavailable
          </div>
        )}
        <span className="block px-2 py-1.5">
          <span className="block text-xs text-neutral-400 tabular-nums">
            {formatOffset(frame.t)}
          </span>
          <span className="block truncate text-xs text-neutral-700">{frame.caption}</span>
        </span>
      </button>

      {confirming ? (
        <span className="absolute inset-x-0 top-0 flex items-center justify-between gap-1 bg-red-600/95 px-2 py-1 text-xs text-white">
          Delete?
          <span className="flex gap-1">
            <button type="button" onClick={onConfirmDelete} className="font-semibold underline">
              Yes
            </button>
            <button type="button" onClick={onCancelDelete} className="underline">
              No
            </button>
          </span>
        </span>
      ) : (
        <span className="absolute right-1 top-1 flex gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={onDownload}
            title="Save this screenshot"
            aria-label={`Save the screenshot at ${formatOffset(frame.t)}`}
            className="rounded bg-white/90 px-1.5 py-0.5 text-xs text-neutral-600 hover:text-neutral-900"
          >
            ⤓
          </button>
          <button
            type="button"
            onClick={onAskDelete}
            title="Remove this screenshot from the recording"
            aria-label={`Remove the screenshot at ${formatOffset(frame.t)}`}
            className="rounded bg-white/90 px-1.5 py-0.5 text-xs text-neutral-600 hover:text-red-600"
          >
            ✕
          </button>
        </span>
      )}
    </li>
  );
}
