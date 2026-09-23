/**
 * Screenshots taken at significant moments during a recording.
 *
 * Keyframes exist so the report can be illustrated — and, in Phase 3, so the model has
 * a handful of images alongside the event log — without anyone decoding the video.
 * Pulling frames out of a webm in a service worker is possible and miserable; asking
 * Chrome for a PNG is neither.
 */

/**
 * Chrome's documented ceiling is two `captureVisibleTab` calls per second. Staying well
 * under it: exceeding the quota throws, and a thrown screenshot must never take a
 * recording with it.
 */
export const MIN_CAPTURE_INTERVAL_MS = 1200;

/** Wide enough to read a UI, small enough that a dozen fit comfortably in a request. */
const MAX_WIDTH = 1024;
const JPEG_QUALITY = 0.72;

/**
 * Capture the visible area of a tab, downscaled.
 *
 * Runs in the service worker, which has no DOM — hence `OffscreenCanvas` and
 * `createImageBitmap` rather than an `<img>` and a `<canvas>`.
 *
 * @returns a JPEG blob, or null if the shot could not be taken. Null is unremarkable:
 * the tab may be inactive, mid-navigation, or showing a page Chrome refuses to capture.
 */
export async function captureKeyframe(windowId: number): Promise<Blob | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const full = await (await fetch(dataUrl)).blob();
    return await downscale(full);
  } catch {
    return null;
  }
}

/** Shrink to `MAX_WIDTH` and re-encode as JPEG. */
async function downscale(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return source;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
}
