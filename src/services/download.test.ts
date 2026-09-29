import { describe, expect, it } from 'vitest';
import { baseName, extensionFor, keyframeName, slugify } from './download';
import type { Session } from '@/core/session';

function session(over: Partial<Session['env']> = {}, startedAt = Date.parse('2026-09-29T12:00:00')): Session {
  return {
    id: 's_abc',
    status: 'stopped',
    startedAt,
    env: {
      url: 'https://pharmacy-procurement-stg.swiperxapp.com/id/order-confirmed',
      title: 'SwipeRx Procurement | Pharmacy',
      userAgent: 'test',
      viewport: { width: 1, height: 1 },
      devicePixelRatio: 1,
      recordedAt: '2026-09-29T12:00:00.000Z',
      extensionVersion: '0.1.0',
      ...over,
    },
    events: [],
    console: [],
    network: [],
    keyframes: [],
    trace: [],
  };
}

describe('slugify', () => {
  /** A page title is arbitrary text, and these land in Slack, Jira and email. */
  it('collapses everything outside a-z0-9 to single hyphens', () => {
    expect(slugify('SwipeRx Procurement | Pharmacy')).toBe('swiperx-procurement-pharmacy');
    expect(slugify('Order #123 / confirmed: yes')).toBe('order-123-confirmed-yes');
  });

  it('never leaves a leading or trailing hyphen', () => {
    expect(slugify('  — Orders — ')).toBe('orders');
    expect(slugify('!!!')).toBe('');
  });

  /** Truncation must not leave the hyphen it cut on. */
  it('truncates long titles without a trailing hyphen', () => {
    const slug = slugify('a'.repeat(50) + ' ' + 'b'.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('extensionFor', () => {
  /** The recorder's blob carries codec parameters after the type. */
  it('ignores media type parameters', () => {
    expect(extensionFor(new Blob([], { type: 'video/webm;codecs=vp9,opus' }), 'bin')).toBe('webm');
  });

  it('maps jpeg to jpg, not jpeg', () => {
    expect(extensionFor(new Blob([], { type: 'image/jpeg' }), 'bin')).toBe('jpg');
  });

  it('falls back when the blob has no type at all', () => {
    expect(extensionFor(new Blob([]), 'webm')).toBe('webm');
  });
});

describe('baseName', () => {
  it('uses the page title and the recording date', () => {
    expect(baseName(session())).toBe('swiperx-procurement-pharmacy-2026-09-29');
  });

  /** A title can be empty or decorative; the host still identifies the recording. */
  it('falls back to the hostname when the title is unusable', () => {
    expect(baseName(session({ title: '' }))).toBe(
      'pharmacy-procurement-stg-swiperxapp-com-2026-09-29',
    );
    expect(baseName(session({ title: '—' }))).toContain('swiperxapp-com');
  });

  it('never produces a name that is only a date', () => {
    expect(baseName(session({ title: '', url: 'not a url' }))).toBe('recording-2026-09-29');
  });
});

describe('keyframeName', () => {
  /** Padded so ten frames still sort in capture order in a file listing. */
  it('pads the index and takes the extension from the blob', () => {
    const jpeg = new Blob([], { type: 'image/jpeg' });
    expect(keyframeName(session(), 0, jpeg)).toBe('swiperx-procurement-pharmacy-2026-09-29-01.jpg');
    expect(keyframeName(session(), 9, jpeg)).toBe('swiperx-procurement-pharmacy-2026-09-29-10.jpg');
  });

  it('shares its stem with the video, so one session sorts together', () => {
    const s = session();
    expect(keyframeName(s, 0, new Blob([], { type: 'image/jpeg' }))).toContain(baseName(s));
  });
});
