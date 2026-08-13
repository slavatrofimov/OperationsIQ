import { describe, it, expect } from 'vitest';
import { chooseBin, STANDARD_TIMESPANS } from './binning';

/** Build a [start, end) range spanning `ms` milliseconds. */
function range(ms: number): { start: Date; end: Date } {
  const start = new Date('2024-01-01T00:00:00.000Z');
  return { start, end: new Date(start.getTime() + ms) };
}

describe('STANDARD_TIMESPANS', () => {
  it('is strictly ascending and starts at sub-second steps', () => {
    expect(STANDARD_TIMESPANS[0].millis).toBe(1);
    for (let i = 1; i < STANDARD_TIMESPANS.length; i++) {
      expect(STANDARD_TIMESPANS[i].millis).toBeGreaterThan(STANDARD_TIMESPANS[i - 1].millis);
    }
  });
});

describe('chooseBin', () => {
  it('selects a sub-second standard step for a short, high-resolution range', () => {
    // 1 second range, budget 1000 points -> smallest step keeping bins <= 1000
    // is 1ms (1000 bins). Emits a millisecond KQL step literal.
    const bin = chooseBin({ ...range(1_000), maxBins: 1000 });
    expect(bin.millis).toBe(1);
    expect(bin.kql).toBe('1ms');
    expect(bin.label).toBe('1ms');
  });

  it('honors a preferred sub-second width when it fits the budget', () => {
    const bin = chooseBin({ ...range(60_000), maxBins: 1000, preferredMillis: 200 });
    expect(bin.millis).toBe(200);
    expect(bin.kql).toBe('200ms');
    expect(bin.label).toBe('200ms');
  });

  it('ignores a preferred width that would exceed the budget', () => {
    // 1 hour at a preferred 1ms would be 3.6M bins >> 100, so fall back to a fit.
    const bin = chooseBin({ ...range(3_600_000), maxBins: 100, preferredMillis: 1 });
    expect(bin.millis).toBeGreaterThan(1);
    expect(3_600_000 / bin.millis).toBeLessThanOrEqual(100);
  });

  it('emits a millisecond step literal for standard second/minute widths', () => {
    const bin = chooseBin({ ...range(3_600_000), maxBins: 1000 });
    expect(bin.kql).toMatch(/^\d+ms$/);
    expect(bin.millis).toBe(5_000);
    expect(bin.label).toBe('5sec');
  });

  it('keeps bins within budget for very small ranges', () => {
    const bin = chooseBin({ ...range(3), maxBins: 2 });
    expect(bin.millis).toBeGreaterThanOrEqual(1);
    expect(3 / bin.millis).toBeLessThanOrEqual(2);
    expect(bin.kql).toBe(`${bin.millis}ms`);
  });

  it('never returns a bin width below the 1ms floor', () => {
    const bin = chooseBin({ ...range(1), maxBins: 1000 });
    expect(bin.millis).toBeGreaterThanOrEqual(1);
  });

  it('labels a non-standard preferred whole-second width in seconds', () => {
    const bin = chooseBin({ ...range(60_000), maxBins: 1000, preferredMillis: 3_000 });
    expect(bin.millis).toBe(3_000);
    expect(bin.kql).toBe('3000ms');
    expect(bin.label).toBe('3sec');
  });

  it('labels a non-standard preferred sub-second width in milliseconds', () => {
    const bin = chooseBin({ ...range(60_000), maxBins: 1000, preferredMillis: 1_500 });
    expect(bin.millis).toBe(1_500);
    expect(bin.label).toBe('1500ms');
  });
});
