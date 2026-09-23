/**
 * Offscreen document: hosts the MediaRecorder.
 *
 * MV3 service workers have no DOM and no `MediaRecorder`, and Chrome terminates them
 * after roughly 30 seconds idle. `chrome.offscreen` is the supported way to keep a
 * recorder alive for the length of a recording, so all capture happens here and the
 * finished blob is handed back to the worker on stop.
 */
import type { OffscreenMessage, OffscreenReply } from '@/core/messages';
import { updateSession } from '@/core/storage/db';

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let activeSessionId: string | null = null;
let stream: MediaStream | null = null;

/** 720p at 2.5 Mbps keeps a two-minute recording comfortably under Jira's 10MB default. */
const VIDEO_BITS_PER_SECOND = 2_500_000;
const MAX_HEIGHT = 720;

function reply(message: OffscreenReply): void {
  // A rejected send must never break recording: the worker may simply be asleep.
  chrome.runtime.sendMessage(message).catch(() => {});
}

/**
 * Record a breadcrumb against the session.
 *
 * This document's DevTools console only exists while it is open, and it closes as soon
 * as a recording finishes — so anything logged only to the console is gone before a
 * tester can look at it. Breadcrumbs go to the session record instead, where the review
 * page can show them.
 */
function trace(sessionId: string, line: string): void {
  console.info(`[qa-bug-reporter] ${line}`);
  reply({ type: 'OFFSCREEN_TRACE', sessionId, line });
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage) => {
  if (message.type === 'OFFSCREEN_STOP') {
    stop();
  }
  // No response is sent; replies come back via sendMessage so the worker can be
  // restarted between start and stop without breaking a held sendResponse callback.
  return false;
});

/**
 * Read the capture parameters from this document's own URL and start recording.
 *
 * The worker puts them in the query string when it creates the document, so they
 * arrive *with* the document. No storage read, no message, nothing to be unavailable
 * or mistimed — earlier designs used `chrome.storage.session` for this, and every
 * silent failure we chased shared that one dependency.
 */
function startFromUrl(): void {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session');
  const streamId = params.get('stream');

  console.info('[qa-bug-reporter] offscreen module loaded', { sessionId, hasStream: !!streamId });

  if (!sessionId || !streamId) {
    // Nothing to do: the document was opened without parameters. Report it rather than
    // returning silently — an unexplained no-op is what made this hard to find.
    chrome.runtime
      .sendMessage({
        type: 'OFFSCREEN_TRACE',
        sessionId: sessionId ?? 'unknown',
        line: `module loaded but URL had no capture parameters (${location.search || 'empty'})`,
      })
      .catch(() => {});
    return;
  }

  void start(streamId, sessionId);
}

startFromUrl();

async function start(streamId: string, sessionId: string): Promise<void> {
  activeSessionId = sessionId;
  chunks = [];
  trace(sessionId, `claimed capture, redeeming stream id`);

  try {
    // The `mandatory` constraint shape is Chrome-specific and is how a tabCapture
    // stream id is redeemed; it is not part of the standard getUserMedia typings.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
          maxHeight: MAX_HEIGHT,
        },
      },
    } as unknown as MediaStreamConstraints);
  } catch (error) {
    reply({
      type: 'RECORDING_FAILED',
      sessionId,
      error: `getUserMedia failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const tracks = stream.getTracks();
  trace(
    sessionId,
    `stream acquired: ${tracks.length} track(s) — ` +
      tracks.map((t) => `${t.kind}:${t.readyState}`).join(', '),
  );
  if (stream.getVideoTracks().length === 0) {
    reply({
      type: 'RECORDING_FAILED',
      sessionId,
      error: 'The capture stream contained no video track.',
    });
    return;
  }

  // Capturing a tab's audio silently mutes the tab for the user unless the stream is
  // routed back to the speakers. A bug tool that mutes the app under test will itself
  // get reported as a bug, so always play the audio back.
  playAudioBack(stream);

  recorder = new MediaRecorder(stream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });

  recorder.onerror = (event) => {
    const detail = (event as unknown as { error?: Error }).error;
    reply({
      type: 'RECORDING_FAILED',
      sessionId,
      error: `MediaRecorder error: ${detail?.message ?? 'unknown'}`,
    });
  };

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
      // Only trace the first chunk; one line proves data is flowing, more is noise.
      if (chunks.length === 1) trace(sessionId, `first chunk received (${event.data.size} bytes)`);
    }
  };

  recorder.onstop = () => {
    const video = new Blob(chunks, { type: recorder?.mimeType ?? 'video/webm' });
    const chunkCount = chunks.length;
    chunks = [];
    const sessionId = activeSessionId;
    if (sessionId) {
      trace(sessionId, `recorder stopped: ${chunkCount} chunk(s), ${video.size} bytes`);
    }
    teardown();
    if (sessionId) void save(sessionId, video);
  };

  // A timeslice means chunks accumulate as we go, so a crash mid-recording still
  // leaves recoverable data rather than nothing.
  recorder.start(1000);
  trace(sessionId, `recorder started, mimeType=${recorder.mimeType}`);
  reply({ type: 'RECORDING_STARTED', sessionId });
}

function stop(): void {
  if (activeSessionId) {
    trace(activeSessionId, `stop received, recorder state=${recorder?.state ?? 'none'}`);
  }
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop(); // onstop delivers the blob
  } else {
    teardown();
  }
}

function teardown(): void {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  recorder = null;
  activeSessionId = null;
}

/**
 * Persist the finished recording.
 *
 * The blob is written here rather than handed to the service worker, because
 * `chrome.runtime.sendMessage` serialises with JSON: a Blob sent across it arrives as
 * an empty object, with no error raised. This document shares the extension's origin,
 * so it is writing to exactly the same IndexedDB the worker and review page read.
 */
async function save(sessionId: string, video: Blob): Promise<void> {
  try {
    const updated = await updateSession(sessionId, (session) => {
      session.video = video;
      session.status = 'stopped';
      session.stoppedAt ??= Date.now();
    });
    if (!updated) throw new Error(`session ${sessionId} not found`);
    trace(sessionId, `saved ${video.size} bytes to IndexedDB`);
    reply({ type: 'RECORDING_SAVED', sessionId, bytes: video.size });
  } catch (error) {
    reply({
      type: 'RECORDING_FAILED',
      sessionId,
      error: `failed to save recording: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** Route captured tab audio back to the speakers so the tab is not silenced. */
function playAudioBack(source: MediaStream): void {
  if (source.getAudioTracks().length === 0) return;
  const context = new AudioContext();
  context.createMediaStreamSource(source).connect(context.destination);
}

/** VP9 where available, VP8 as the fallback on older builds. */
function pickMimeType(): string {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? 'video/webm';
}
