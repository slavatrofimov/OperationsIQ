import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BINNING_SETTINGS,
  PREFERRED_MILLIS_MAX,
  clampRangeToBinBudget,
  computeBinningOutputs,
  formatResolution,
  labelForMillis,
  millisToValueUnit,
  parseBinningSettings,
  valueUnitToMillis,
} from './binningSettings';

describe('parseBinningSettings', () => {
  it('reads millisecond-canonical preferredMillis', () => {
    expect(parseBinningSettings({ preferredMillis: 250 }).preferredMillis).toBe(250);
  });

  it('migrates legacy preferredSeconds (whole seconds) to preferredMillis (×1000)', () => {
    expect(parseBinningSettings({ preferredSeconds: 5 }).preferredMillis).toBe(5_000);
  });

  it('prefers preferredMillis over a stray legacy preferredSeconds', () => {
    const out = parseBinningSettings({ preferredMillis: 200, preferredSeconds: 5 });
    expect(out.preferredMillis).toBe(200);
  });

  it('treats 0 / negative preferred widths as auto (null)', () => {
    expect(parseBinningSettings({ preferredMillis: 0 }).preferredMillis).toBeNull();
    expect(parseBinningSettings({ preferredSeconds: 0 }).preferredMillis).toBeNull();
  });

  it('clamps preferredMillis to the max (7 days)', () => {
    expect(parseBinningSettings({ preferredMillis: 999_999_999_999 }).preferredMillis).toBe(
      PREFERRED_MILLIS_MAX,
    );
  });

  it('falls back to defaults for empty input', () => {
    expect(parseBinningSettings({})).toEqual(DEFAULT_BINNING_SETTINGS);
  });
});

describe('clampRangeToBinBudget', () => {
  const range = (startMs: number, endMs: number) => ({
    start: new Date(startMs),
    end: new Date(endMs),
  });

  it('returns the range unchanged when it already fits the budget', () => {
    const r = range(0, 1000 * 100); // 100 s at 1 s/bin = 100 bins
    const out = clampRangeToBinBudget(r, 1000, 5000);
    expect(out.clamped).toBe(false);
    expect(out.start).toBe(r.start);
    expect(out.end).toBe(r.end);
  });

  it('shortens an over-budget range, keeping the end fixed', () => {
    // 10_000 s at 1 s/bin = 10_000 bins, budget 5_000 → keep last 5_000 s.
    const r = range(0, 1000 * 10_000);
    const out = clampRangeToBinBudget(r, 1000, 5000);
    expect(out.clamped).toBe(true);
    expect(out.end.getTime()).toBe(r.end.getTime());
    expect(out.end.getTime() - out.start.getTime()).toBe(1000 * 5000);
  });

  it('honors the exact boundary (duration == budget is not clamped)', () => {
    const r = range(0, 1000 * 5000);
    expect(clampRangeToBinBudget(r, 1000, 5000).clamped).toBe(false);
  });

  it('is a no-op for unusable inputs', () => {
    const r = range(0, 1000 * 10_000);
    expect(clampRangeToBinBudget(r, 0, 5000).clamped).toBe(false);
    expect(clampRangeToBinBudget(r, 1000, 0).clamped).toBe(false);
    expect(clampRangeToBinBudget(range(1000, 1000), 1000, 5000).clamped).toBe(false);
  });
});

describe('valueUnitToMillis / millisToValueUnit', () => {
  it('converts value+unit into whole milliseconds', () => {
    expect(valueUnitToMillis(500, 'milliseconds')).toBe(500);
    expect(valueUnitToMillis(2, 'seconds')).toBe(2_000);
    expect(valueUnitToMillis(1, 'hours')).toBe(3_600_000);
  });

  it('round-trips through the largest exact unit', () => {
    expect(millisToValueUnit(3_600_000)).toEqual({ value: 1, unit: 'hours' });
    expect(millisToValueUnit(1_500)).toEqual({ value: 1500, unit: 'milliseconds' });
    expect(millisToValueUnit(5_000)).toEqual({ value: 5, unit: 'seconds' });
  });
});

describe('formatResolution / labelForMillis', () => {
  it('formats sub-second widths in milliseconds', () => {
    expect(formatResolution(500)).toBe('500ms');
    expect(formatResolution(1)).toBe('1ms');
  });

  it('formats whole units compactly', () => {
    expect(formatResolution(5_000)).toBe('5s');
    expect(formatResolution(300_000)).toBe('5min');
    expect(formatResolution(86_400_000)).toBe('1d');
  });

  it('labels a standard step by its friendly name', () => {
    expect(labelForMillis(300_000)).toBe('5min');
    expect(labelForMillis(500)).toBe('500ms');
  });
});

describe('computeBinningOutputs', () => {
  const start = new Date('2024-01-01T00:00:00.000Z');
  const range = (ms: number) => ({ start, end: new Date(start.getTime() + ms) });

  it('reports the effective ms bin width and point count', () => {
    const out = computeBinningOutputs(range(60_000), { maxBins: 1000, preferredMillis: 200 });
    expect(out.effectiveMillis).toBe(200);
    expect(out.durationMs).toBe(60_000);
    expect(out.points).toBe(300);
  });

  it('honors an explicit override width', () => {
    const out = computeBinningOutputs(range(60_000), { maxBins: 1000, preferredMillis: null }, 500);
    expect(out.effectiveMillis).toBe(500);
    expect(out.label).toBe('500ms');
  });
});
