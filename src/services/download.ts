/**
 * Saving a recording's artifacts to disk.
 *
 * The `downloads` permission has been in the manifest since Phase 0 and unused until
 * now. It earns its place here rather than `<a download>` for one reason: file names.
 * Six frames landing in ~/Downloads as `download.jpg`, `download (1).jpg` are six files
 * nobody can tell apart an hour later, and the whole point of taking them out of the
 * tool is to put them somewhere else.
 */
import type { Session } from '@/core/session';

/** Longest slug taken from a page title, before the date is appended. */
const MAX_STEM = 60;

/**
 * Extensions by media type.
 *
 * Read from the blob rather than assumed, because the two producers disagree: keyframes
 * are JPEG (`captureVisibleTab` with a quality setting) while a naive reading of
 * "screenshot" suggests PNG, and the recorder's WebM carries a codec parameter after the
 * type. A file saved with the wrong extension opens in the wrong application.
 */
const EXTENSIONS: Record<string, string> = {
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'text/markdown': 'md',
  'text/plain': 'txt',
};

export function extensionFor(blob: Blob, fallback: string): string {
  // `video/webm;codecs=vp9,opus` — the parameters are not part of the type.
  const mime = blob.type.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSIONS[mime] ?? fallback;
}

/**
 * A file-name-safe slug.
 *
 * Everything outside `[a-z0-9]` collapses to a single hyphen. That is stricter than any
 * one filesystem requires, and deliberately so: these names travel into Slack, Jira and
 * email, and a page title is arbitrary text that routinely contains `/`, `|` and `:`.
 */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_STEM)
    .replace(/-+$/, '');
}

/** Local calendar date, `YYYY-MM-DD`. `en-CA` is the shortest way to that shape. */
function isoDate(at: number): string {
  return new Date(at).toLocaleDateString('en-CA');
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The stem every file from one session shares, so they sort together in a folder.
 *
 * Title first because it is what the tester recognises, host second because a title can
 * be empty or decorative, and a fixed word last so the name is never just a date.
 */
export function baseName(session: Session): string {
  const stem =
    slugify(session.env.title) || slugify(hostname(session.env.url)) || 'recording';
  return `${stem}-${isoDate(session.startedAt)}`;
}

/** `title-2026-09-29-03.jpg` — padded so ten frames still sort in capture order. */
export function keyframeName(session: Session, index: number, blob: Blob): string {
  const n = String(index + 1).padStart(2, '0');
  return `${baseName(session)}-${n}.${extensionFor(blob, 'jpg')}`;
}

/**
 * Hand a blob to Chrome's download manager.
 *
 * `uniquify` rather than `overwrite`: downloading the same recording twice is a thing
 * people do when the first copy went to the wrong place, and silently replacing the
 * earlier file is not recoverable.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    revokeWhenSettled(id, url);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * Release the object URL once Chrome has finished reading it.
 *
 * Revoking as soon as `download()` resolves **cancels the transfer**: the id comes back
 * when the download is queued, not when the bytes have been read, and a 40 MB recording
 * is still being read long after that. Waiting for a terminal state is the difference
 * between a working Download Video and one that produces a zero-byte file.
 */
function revokeWhenSettled(id: number, url: string): void {
  const done = (delta: chrome.downloads.DownloadDelta) => {
    if (delta.id !== id || delta.state === undefined) return;
    if (delta.state.current === 'in_progress') return;
    chrome.downloads.onChanged.removeListener(done);
    URL.revokeObjectURL(url);
  };
  chrome.downloads.onChanged.addListener(done);
}
