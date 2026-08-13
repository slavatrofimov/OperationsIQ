import { describe, it, expect } from 'vitest';
import { nowFrom, resolveRelativeWindow } from './clock';

// A fixed instant: Wed 2024-03-13T15:30:00Z (Q1, March).
const NOW = new Date('2024-03-13T15:30:00.000Z');

describe('nowFrom', () => {
  it('uses the supplied clock when it yields a valid date', () => {
    expect(nowFrom(() => NOW).toISOString()).toBe(NOW.toISOString());
  });

  it('falls back to real time when the clock throws or is invalid', () => {
    const before = Date.now();
    const t = nowFrom(() => {
      throw new Error('boom');
    }).getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    const t2 = nowFrom(() => new Date('not-a-date')).getTime();
    expect(Number.isNaN(t2)).toBe(false);
  });
});

describe('resolveRelativeWindow', () => {
  it('resolves "today" from start-of-day UTC to now', () => {
    const w = resolveRelativeWindow('today', NOW)!;
    expect(w.startIso).toBe('2024-03-13T00:00:00.000Z');
    expect(w.endIso).toBe(NOW.toISOString());
  });

  it('resolves "yesterday" as the whole previous UTC day', () => {
    const w = resolveRelativeWindow('yesterday', NOW)!;
    expect(w.startIso).toBe('2024-03-12T00:00:00.000Z');
    expect(w.endIso).toBe('2024-03-13T00:00:00.000Z');
  });

  it('resolves a rolling "last 7 days" window ending at now', () => {
    const w = resolveRelativeWindow('last 7 days', NOW)!;
    expect(w.endIso).toBe(NOW.toISOString());
    expect(w.startIso).toBe('2024-03-06T15:30:00.000Z');
  });

  it('treats "last month" as the whole previous calendar month', () => {
    const w = resolveRelativeWindow('last month', NOW)!;
    expect(w.startIso).toBe('2024-02-01T00:00:00.000Z');
    expect(w.endIso).toBe('2024-03-01T00:00:00.000Z');
  });

  it('resolves "this quarter" from the quarter start to now', () => {
    const w = resolveRelativeWindow('this quarter', NOW)!;
    expect(w.startIso).toBe('2024-01-01T00:00:00.000Z');
    expect(w.endIso).toBe(NOW.toISOString());
  });

  it('resolves YTD / MTD', () => {
    expect(resolveRelativeWindow('ytd', NOW)!.startIso).toBe('2024-01-01T00:00:00.000Z');
    expect(resolveRelativeWindow('mtd', NOW)!.startIso).toBe('2024-03-01T00:00:00.000Z');
  });

  it('returns null for phrases it cannot interpret', () => {
    expect(resolveRelativeWindow('around the last shutdown', NOW)).toBeNull();
    expect(resolveRelativeWindow('', NOW)).toBeNull();
    expect(resolveRelativeWindow('last 0 days', NOW)).toBeNull();
  });
});
