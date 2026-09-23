/**
 * Offscreen document: hosts the MediaRecorder.
 *
 * MV3 service workers have no DOM and no `MediaRecorder`, and Chrome terminates them
 * after roughly 30 seconds idle. `chrome.offscreen` is the supported way to keep a
 * recorder alive for the length of a recording, so all capture happens here and the
 * finished blob is handed back to the worker on stop.
 */
import type { OffscreenMessage, OffscreenReply } from '@/core/messages';

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let activeSessionId: string | null = null;
let stream: MediaStream | null = null;

/** 720p at 2.5 Mbps keeps a two-minute recording comfortably under Jira's 10MB default. */
const VIDEO_BITS_PER_SECOND = 2_500_000;
const MAX_HEIGHT = 720;

function reply(message: OffscreenReply): void {
  void chrome.runtime.sendMessage(message);
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage) => {
  if (message.type === 'OFFSCREEN_START') {
    void start(message.streamId, message.sessionId);
  } else if (message.type === 'OFFSCREEN_STOP') {
    stop();
  }
  // No response is sent; replies come back via sendMessage so the worker can be
  // restarted between start and stop without breaking a held sendResponse callback.
  return false;
});

async function start(streamId: string, sessionId: string): Promise<void> {
  activeSessionId = sessionId;
  chunks = [];

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
      error: error instanceof Error ? error.message : String(error),
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

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  recorder.onstop = () => {
    const video = new Blob(chunks, { type: recorder?.mimeType ?? 'video/webm' });
    chunks = [];
    if (activeSessionId) {
      reply({ type: 'RECORDING_DATA', sessionId: activeSessionId, video });
    }
    teardown();
  };

  // A timeslice means chunks accumulate as we go, so a crash mid-recording still
  // leaves recoverable data rather than nothing.
  recorder.start(1000);
  reply({ type: 'RECORDING_STARTED', sessionId });
}

function stop(): void {
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
