import { describe, it, expect } from 'vitest';
import {
  DURATION_UNIT_OPTIONS,
  durationToSeconds,
  secondsToDuration,
  durationToSubLen,
  sliderPosToSeconds,
  secondsToSliderPos,
  MIN_MOTIF_SECONDS,
} from './units';

describe('mp/units millisecond support', () => {
  it('exposes a milliseconds option as the finest unit', () => {
    const ms = DURATION_UNIT_OPTIONS[0];
    expect(ms.value).toBe('milliseconds');
    expect(ms.label).toBe('ms');
    expect(ms.seconds).toBe(0.001);
  });

  it('converts milliseconds to fractional seconds', () => {
    expect(durationToSeconds(200, 'milliseconds')).toBeCloseTo(0.2, 10);
    expect(durationToSeconds(1, 'milliseconds')).toBeCloseTo(0.001, 10);
    expect(durationToSeconds(1500, 'milliseconds')).toBeCloseTo(1.5, 10);
  });

  it('rejects non-positive values regardless of unit', () => {
    expect(durationToSeconds(0, 'milliseconds')).toBe(0);
    expect(durationToSeconds(-5, 'milliseconds')).toBe(0);
  });

  it('expresses sub-second durations back as milliseconds', () => {
    expect(secondsToDuration(0.2)).toEqual({ value: 200, unit: 'milliseconds' });
    expect(secondsToDuration(0.001)).toEqual({ value: 1, unit: 'milliseconds' });
    expect(secondsToDuration(1.5)).toEqual({ value: 1500, unit: 'milliseconds' });
  });

  it('still prefers the largest exact whole unit for round values', () => {
    expect(secondsToDuration(86400)).toEqual({ value: 1, unit: 'days' });
    expect(secondsToDuration(3600)).toEqual({ value: 1, unit: 'hours' });
    expect(secondsToDuration(90)).toEqual({ value: 90, unit: 'seconds' });
    expect(secondsToDuration(2)).toEqual({ value: 2, unit: 'seconds' });
  });

  it('round-trips a millisecond pattern length through the value+unit picker', () => {
    const seconds = durationToSeconds(250, 'milliseconds');
    expect(secondsToDuration(seconds)).toEqual({ value: 250, unit: 'milliseconds' });
  });

  it('converts sub-second durations to subsequence lengths with fractional bins', () => {
    // 200 ms pattern at a 50 ms bin width -> 4 points.
    expect(durationToSubLen(0.2, 0.05)).toBe(4);
    // 1 s pattern at a 100 ms bin width -> 10 points.
    expect(durationToSubLen(1, 0.1)).toBe(10);
    // Clamped to the usable minimum of 4.
    expect(durationToSubLen(0.05, 0.05)).toBe(4);
  });

  it('lets the log slider reach the millisecond floor', () => {
    expect(MIN_MOTIF_SECONDS).toBe(0.001);
    expect(sliderPosToSeconds(0)).toBeCloseTo(0.001, 10);
    expect(secondsToSliderPos(0.001)).toBe(0);
  });
});
