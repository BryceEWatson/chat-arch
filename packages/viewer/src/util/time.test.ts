import { describe, it, expect } from 'vitest';
import { formatRelative, minTimestamp, maxTimestamp, weekStart, formatShortDate } from './time.js';

const NOW = Date.UTC(2026, 3, 15, 12, 0, 0); // 2026-04-15 12:00 UTC

describe('formatRelative', () => {
  it('minutes ago', () => {
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });
  it('rounds sub-minute up to 1m', () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe('1m ago');
  });
  it('hours ago within <2h window', () => {
    expect(formatRelative(NOW - 90 * 60_000, NOW)).toBe('1h ago');
  });
  it('days ago within <3d window', () => {
    expect(formatRelative(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });
  it('same-year absolute (Mmm D) past 3d', () => {
    const ts = Date.UTC(2026, 0, 5); // Jan 5 2026
    expect(formatRelative(ts, NOW)).toBe('Jan 5');
  });
  it('different-year absolute ISO', () => {
    const ts = Date.UTC(2024, 7, 12);
    expect(formatRelative(ts, NOW)).toBe('2024-08-12');
  });
  it('handles zero / invalid timestamps', () => {
    expect(formatRelative(0, NOW)).toBe('—');
  });
});

describe('min/max timestamp', () => {
  it('handles empty array', () => {
    expect(minTimestamp([])).toBeNull();
    expect(maxTimestamp([])).toBeNull();
  });
  it('computes min/max', () => {
    expect(minTimestamp([3, 1, 2])).toBe(1);
    expect(maxTimestamp([3, 1, 2])).toBe(3);
  });
});

describe('weekStart', () => {
  it('floors to Sunday 00:00 UTC', () => {
    // Wed 2026-04-15 12:00 UTC -> prior Sunday = 2026-04-12 00:00 UTC
    const ws = weekStart(NOW);
    expect(new Date(ws).toISOString()).toBe('2026-04-12T00:00:00.000Z');
  });
  it('is idempotent on a Sunday midnight', () => {
    const sunday = Date.UTC(2026, 3, 12, 0, 0, 0);
    expect(weekStart(sunday)).toBe(sunday);
  });
});

describe('formatShortDate', () => {
  it('same year uses Mmm D', () => {
    expect(formatShortDate(Date.UTC(2026, 0, 1), NOW)).toBe('Jan 1');
  });
});
