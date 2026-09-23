import { describe, expect, it } from 'vitest';
import { formatOffset, newSessionId, relativeTime } from './session';

describe('relativeTime', () => {
  it('measures from the session start', () => {
    expect(relativeTime(1_000, 3_500)).toBe(2_500);
  });

  it('clamps events that predate the start rather than going negative', () => {
    // Content scripts can flush a batch buffered just before recording began.
    expect(relativeTime(5_000, 4_000)).toBe(0);
  });
});

describe('formatOffset', () => {
  it('formats as m:ss with a padded seconds field', () => {
    expect(formatOffset(0)).toBe('0:00');
    expect(formatOffset(9_000)).toBe('0:09');
    expect(formatOffset(65_000)).toBe('1:05');
    expect(formatOffset(3_600_000)).toBe('60:00');
  });

  it('truncates rather than rounds, so the timer never shows a second early', () => {
    expect(formatOffset(1_999)).toBe('0:01');
  });
});

describe('newSessionId', () => {
  it('is unique across rapid calls', () => {
    const ids = new Set(Array.from({ length: 100 }, newSessionId));
    expect(ids.size).toBe(100);
  });
});
