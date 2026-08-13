import { describe, it, expect } from 'vitest';
import {
  ACTIVATOR_FREQUENCIES,
  frequencySecondsFor,
  frequencyLabelFor,
  computeLookbackSeconds,
} from './frequency';

describe('ACTIVATOR_FREQUENCIES', () => {
  it('maps each key to the documented second value', () => {
    const map = Object.fromEntries(ACTIVATOR_FREQUENCIES.map((f) => [f.key, f.seconds]));
    expect(map).toEqual({
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '30m': 1800,
      '1h': 3600,
      '3h': 10800,
      '6h': 21600,
      '12h': 43200,
      '1d': 86400,
    });
  });
});

describe('frequencySecondsFor', () => {
  it('resolves a known key', () => {
    expect(frequencySecondsFor('1h')).toBe(3600);
  });
  it('throws for an unknown key', () => {
    expect(() => frequencySecondsFor('nope')).toThrow();
  });
});

describe('frequencyLabelFor', () => {
  it('returns the label for a known key and echoes an unknown one', () => {
    expect(frequencyLabelFor('15m')).toBe('Every 15 minutes');
    expect(frequencyLabelFor('weird')).toBe('weird');
  });
});

describe('computeLookbackSeconds', () => {
  it('applies frequency + (queryBins - 1) * bin', () => {
    expect(computeLookbackSeconds(900, 4, 300)).toBe(1800);
    expect(computeLookbackSeconds(3600, 1, 300)).toBe(3600);
  });
  it('floors a degenerate pattern length at 1 bin', () => {
    expect(computeLookbackSeconds(600, 0, 300)).toBe(600);
  });
});
