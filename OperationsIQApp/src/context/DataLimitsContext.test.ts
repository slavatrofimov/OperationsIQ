import { describe, it, expect } from 'vitest';
import {
  clampVisualizationMaxPoints,
  clampPatternSearchMaxPoints,
  DEFAULT_VISUALIZATION_MAX_POINTS,
  DEFAULT_PATTERN_SEARCH_MAX_POINTS,
  MIN_VISUALIZATION_MAX_POINTS,
  MAX_VISUALIZATION_MAX_POINTS,
  MIN_PATTERN_SEARCH_MAX_POINTS,
  MAX_PATTERN_SEARCH_MAX_POINTS,
} from './DataLimitsContext';

describe('clampVisualizationMaxPoints', () => {
  it('keeps in-range values (floored)', () => {
    expect(clampVisualizationMaxPoints(12_345.7)).toBe(12_345);
  });

  it('clamps below the minimum', () => {
    expect(clampVisualizationMaxPoints(0)).toBe(MIN_VISUALIZATION_MAX_POINTS);
  });

  it('clamps above the maximum', () => {
    expect(clampVisualizationMaxPoints(9_999_999)).toBe(MAX_VISUALIZATION_MAX_POINTS);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampVisualizationMaxPoints(NaN)).toBe(DEFAULT_VISUALIZATION_MAX_POINTS);
  });
});

describe('clampPatternSearchMaxPoints', () => {
  it('keeps in-range values (floored)', () => {
    expect(clampPatternSearchMaxPoints(250_000.9)).toBe(250_000);
  });

  it('clamps below the minimum', () => {
    expect(clampPatternSearchMaxPoints(1)).toBe(MIN_PATTERN_SEARCH_MAX_POINTS);
  });

  it('clamps above the maximum', () => {
    expect(clampPatternSearchMaxPoints(50_000_000)).toBe(MAX_PATTERN_SEARCH_MAX_POINTS);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampPatternSearchMaxPoints(Infinity)).toBe(DEFAULT_PATTERN_SEARCH_MAX_POINTS);
    expect(clampPatternSearchMaxPoints(NaN)).toBe(DEFAULT_PATTERN_SEARCH_MAX_POINTS);
  });
});
