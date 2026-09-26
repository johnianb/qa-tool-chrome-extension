/**
 * Trim a recording to its last N seconds, for Jira's attachment limit.
 *
 * ## Why this re-encodes instead of slicing
 *
 * A WebM file cannot be cut with `Blob.slice`. The container is a sequence of clusters
 * whose headers describe the whole stream, and the tail alone begins mid-cluster with no
 * keyframe — the result is not a shorter video, it is a corrupt file that some players
 * show as a black rectangle and others refuse outright. Attaching one of those to a bug
 * report is worse than attaching nothing, because the reviewer cannot tell whether the
 * tool or the product is broken.
 *
 * So the tail is replayed into a `MediaRecorder` through `captureStream()`. That is the
 * only route to a valid file available in a page without shipping an encoder.
 *
 * **It runs in real time.** Thirty seconds of video takes thirty seconds to trim, and
 * `playbackRate` is deliberately left at 1: raising it does finish sooner, but the
 * output plays back at the wrong speed, and the timing of a bug is frequently the
 * evidence. A progress callback is offered instead of a shortcut.
 *
 * Page-only. There is no `MediaRecorder` in a service worker, and none in jsdom either,
 * which is why this module has no unit test — the device check in the roadmap is what
 * covers it.
 */

/** Candidate output formats, best first. */
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

/** Whether this context can trim at all, so the UI can hide the offer rather than fail. */
export function canTrim(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLVideoElement !== 'undefined' &&
    'captureStream' in HTMLVideoElement.prototype
  );
}

export interface TrimOptions {
  /**
   * The recording's length from the session record, used when the file does not declare
   * one — which is the normal case here, not an edge case. See `resolveDuration`.
   */
  knownDurationMs?: number;
  /** 0–1, for a progress bar during the real-time replay. */
  onProgress?: (fraction: number) => void;
}

/**
 * Re-encode the last `seconds` of `video`.
 *
 * Returns the original blob untouched when it is already shorter than the window —
 * re-encoding it would only lose quality for no reduction in size.
 */
export async function trimToLastSeconds(
  video: Blob,
  seconds: number,
  options: TrimOptions = {},
): Promise<Blob> {
  if (!canTrim()) {
    throw new Error('This browser cannot trim video (no MediaRecorder capture support).');
  }

  const url = URL.createObjectURL(video);
  const element = document.createElement('video');
  // Muted, or the trim plays the recording's audio aloud across the room.
  element.muted = true;
  element.playsInline = true;
  element.preload = 'auto';
  element.src = url;

  try {
    await once(element, 'loadedmetadata', 'video metadata never loaded');
    const duration = await resolveDuration(element, options.knownDurationMs);

    if (duration <= seconds) return video;

    const start = duration - seconds;
    element.currentTime = start;
    await once(element, 'seeked', 'seeking to the trim point timed out');

    const stream = captureStream(element);
    const recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    // A timeslice means a long trim is not held entirely in one buffer, and it gives us
    // data even if the recorder is stopped abruptly.
    recorder.start(1000);
    element.onended = () => {
      if (recorder.state !== 'inactive') recorder.stop();
    };
    if (options.onProgress) {
      const report = options.onProgress;
      element.ontimeupdate = () =>
        report(Math.min(1, Math.max(0, (element.currentTime - start) / seconds)));
    }

    await element.play();
    await stopped;

    for (const track of stream.getTracks()) track.stop();

    const trimmed = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });
    if (trimmed.size === 0) {
      throw new Error('The trim produced an empty file. Attach the full recording instead.');
    }
    return trimmed;
  } finally {
    element.pause();
    element.removeAttribute('src');
    element.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Get a usable duration out of a `MediaRecorder`-produced file.
 *
 * A live-recorded WebM has no duration in its header — the encoder does not know it
 * when it writes the header and never goes back — so `video.duration` is `Infinity`,
 * and seeking into such a file does nothing. Forcing a seek past any plausible end makes
 * Chrome index the stream and replace the duration with the real one; this is the
 * long-standing workaround, not a trick of our own.
 *
 * The session's own `stoppedAt - startedAt` is preferred when we have it: it is known
 * without touching the file, and the two agree to within the last partial frame.
 */
async function resolveDuration(element: HTMLVideoElement, knownDurationMs?: number): Promise<number> {
  if (Number.isFinite(element.duration) && element.duration > 0) return element.duration;
  if (knownDurationMs && knownDurationMs > 0) {
    // Still force the index, or the seek below silently does nothing.
    await forceDurationIndex(element);
    return Number.isFinite(element.duration) && element.duration > 0
      ? element.duration
      : knownDurationMs / 1000;
  }

  await forceDurationIndex(element);
  if (!Number.isFinite(element.duration) || element.duration <= 0) {
    throw new Error('Could not determine how long this recording is, so it cannot be trimmed.');
  }
  return element.duration;
}

async function forceDurationIndex(element: HTMLVideoElement): Promise<void> {
  element.currentTime = 1e101;
  try {
    await once(element, 'durationchange', 'duration never resolved', 5_000);
  } catch {
    // Some builds fire only `timeupdate`; the duration check after this decides.
  }
  element.currentTime = 0;
}

/** `captureStream` is spec'd on media elements but absent from TypeScript's DOM lib. */
function captureStream(element: HTMLVideoElement): MediaStream {
  const capturable = element as HTMLVideoElement & { captureStream?: () => MediaStream };
  if (!capturable.captureStream) {
    throw new Error('This browser cannot capture a stream from a video element.');
  }
  return capturable.captureStream();
}

function pickMimeType(): string {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? 'video/webm';
}

/** Resolve on an event, or reject with a message that says which step stalled. */
function once(
  element: HTMLVideoElement,
  event: keyof HTMLVideoElementEventMap,
  failure: string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      element.removeEventListener(event, done);
      element.removeEventListener('error', failed);
      resolve();
    };
    const failed = () => {
      clearTimeout(timer);
      element.removeEventListener(event, done);
      element.removeEventListener('error', failed);
      reject(new Error(`${failure}: the file could not be read.`));
    };
    const timer = setTimeout(() => {
      element.removeEventListener(event, done);
      element.removeEventListener('error', failed);
      reject(new Error(failure));
    }, timeoutMs);

    element.addEventListener(event, done, { once: true });
    element.addEventListener('error', failed, { once: true });
  });
}
