import { describe, expect, it } from 'vitest';

/**
 * Guards the bug that cost us a blank review page: a Blob handed to
 * `chrome.runtime.sendMessage` is JSON-serialised, arrives as `{}`, and then
 * `URL.createObjectURL` throws inside a React effect and unmounts the root.
 *
 * The extension must never put a Blob in a runtime message. These tests pin the
 * serialisation behaviour so the reasoning stays visible to whoever reads this next.
 */
describe('runtime message serialisation', () => {
  it('destroys a Blob, silently', () => {
    const video = new Blob(['fake webm payload'], { type: 'video/webm' });
    expect(video.size).toBeGreaterThan(0);

    // What chrome.runtime.sendMessage does to the payload.
    const received = JSON.parse(JSON.stringify({ video })) as { video: unknown };

    expect(received.video).toEqual({});
    expect(received.video instanceof Blob).toBe(false);
  });

  it('survives the RECORDING_SAVED shape, which carries only a size', () => {
    const message = { type: 'RECORDING_SAVED', sessionId: 's_abc', bytes: 4_194_304 };
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });
});
