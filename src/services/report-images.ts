/**
 * Keyframes, prepared for a model.
 *
 * Both providers send the same frames with the same captions and differ only in the
 * JSON they wrap them in, so the selection, the captioning and the base64 happen here
 * once. Getting this wrong is expensive twice over — a mislabelled frame is a wrong
 * report, and a second copy of the encoder is a second place for the chunking bug
 * below to come back.
 */
import type { Keyframe } from '@/core/session';
import { formatOffset } from '@/core/session';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface InlineImage {
  /** The line that introduces the frame, so the model knows when it was taken. */
  caption: string;
  mediaType: ImageMediaType;
  base64: string;
}

/** Caption and encode the chosen keyframes, skipping any that came back empty. */
export async function toInlineImages(keyframes: Keyframe[]): Promise<InlineImage[]> {
  const images: InlineImage[] = [];

  for (const frame of keyframes) {
    if (!(frame.blob instanceof Blob) || frame.blob.size === 0) continue;
    images.push({
      caption: `Screen at ${formatOffset(frame.t)} (${frame.caption}):`,
      mediaType: mediaTypeOf(frame.blob),
      base64: await toBase64(frame.blob),
    });
  }

  return images;
}

/**
 * Keyframes are JPEG, except when `downscale` had to hand back the original PNG because
 * no 2D context was available. Both are valid; declaring the wrong one is a 400.
 */
export function mediaTypeOf(blob: Blob): ImageMediaType {
  const supported: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return supported.find((type) => type === blob.type) ?? 'image/jpeg';
}

/**
 * Blob → base64.
 *
 * Chunked deliberately: `String.fromCharCode(...bytes)` on a few hundred kilobytes
 * exceeds the argument limit and throws a `RangeError`, which would surface as a broken
 * report generation rather than as anything resembling its cause.
 */
export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
