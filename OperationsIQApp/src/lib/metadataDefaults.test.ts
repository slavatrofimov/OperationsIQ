import { describe, it, expect } from 'vitest';
import type { TagInfo } from './tags';
import {
  forecastThresholdDefault,
  scenarioLimitDefaults,
  alertThresholdDefaults,
  validationRangeDefaults,
  monitorConfidenceDefault,
  toInputValue,
} from './metadataDefaults';

function tag(p: Partial<TagInfo>): TagInfo {
  return { tagId: 't', tagName: '', metric: '', engUnits: '', ...p } as TagInfo;
}

describe('forecastThresholdDefault', () => {
  it('returns undefined for no tag or no limits', () => {
    expect(forecastThresholdDefault(undefined)).toBeUndefined();
    expect(forecastThresholdDefault(tag({}))).toBeUndefined();
  });

  it('prefers USL upward over operating/LSL', () => {
    expect(forecastThresholdDefault(tag({ usl: 100, upperOperatingLimit: 90, lsl: 10 }))).toEqual({
      threshold: 100,
      direction: 'above',
    });
  });

  it('falls back to upper operating limit when no USL', () => {
    expect(forecastThresholdDefault(tag({ upperOperatingLimit: 90 }))).toEqual({
      threshold: 90,
      direction: 'above',
    });
  });

  it('uses lower limit (below) when only lower limits present', () => {
    expect(forecastThresholdDefault(tag({ lsl: 5 }))).toEqual({ threshold: 5, direction: 'below' });
    expect(forecastThresholdDefault(tag({ lowerOperatingLimit: 3 }))).toEqual({
      threshold: 3,
      direction: 'below',
    });
  });

  it('handles a zero limit (not treated as absent)', () => {
    expect(forecastThresholdDefault(tag({ usl: 0 }))).toEqual({ threshold: 0, direction: 'above' });
  });
});

describe('scenarioLimitDefaults', () => {
  it('prefers operating envelope over spec limits', () => {
    expect(
      scenarioLimitDefaults(tag({ upperOperatingLimit: 90, usl: 100, lowerOperatingLimit: 10, lsl: 5 })),
    ).toEqual({ upperLimit: 90, lowerLimit: 10 });
  });

  it('falls back to spec limits', () => {
    expect(scenarioLimitDefaults(tag({ usl: 100, lsl: 5 }))).toEqual({ upperLimit: 100, lowerLimit: 5 });
  });

  it('returns empty for no tag', () => {
    expect(scenarioLimitDefaults(undefined)).toEqual({});
  });
});

describe('alertThresholdDefaults', () => {
  it('prefers recommendedAlertThreshold for level but keeps forecast direction', () => {
    const r = alertThresholdDefaults(
      tag({ recommendedAlertThreshold: 95, usl: 100, maxRateOfChange: 2, recommendedConfidence: 0.99 }),
    );
    expect(r).toEqual({ threshold: 95, direction: 'above', ratePerMinute: 2, confidence: 0.99 });
  });

  it('falls back to forecast threshold when no recommended threshold', () => {
    expect(alertThresholdDefaults(tag({ lsl: 5 }))).toEqual({
      threshold: 5,
      direction: 'below',
      ratePerMinute: undefined,
      confidence: undefined,
    });
  });

  it('returns empty for no tag', () => {
    expect(alertThresholdDefaults(undefined)).toEqual({});
  });
});

describe('validationRangeDefaults', () => {
  it('widens by sensor uncertainty', () => {
    expect(validationRangeDefaults(tag({ physicalMin: 0, physicalMax: 100, sensorUncertainty: 2 }))).toEqual({
      min: -2,
      max: 102,
    });
  });

  it('treats missing uncertainty as zero', () => {
    expect(validationRangeDefaults(tag({ physicalMin: 1, physicalMax: 9 }))).toEqual({ min: 1, max: 9 });
  });

  it('leaves a missing bound undefined', () => {
    expect(validationRangeDefaults(tag({ physicalMax: 9 }))).toEqual({ min: undefined, max: 9 });
  });
});

describe('monitorConfidenceDefault', () => {
  it('returns the recommended confidence or undefined', () => {
    expect(monitorConfidenceDefault(tag({ recommendedConfidence: 0.9 }))).toBe(0.9);
    expect(monitorConfidenceDefault(tag({}))).toBeUndefined();
    expect(monitorConfidenceDefault(undefined)).toBeUndefined();
  });
});

describe('toInputValue', () => {
  it('formats numbers and blanks undefined', () => {
    expect(toInputValue(12.5)).toBe('12.5');
    expect(toInputValue(0)).toBe('0');
    expect(toInputValue(undefined)).toBe('');
  });
});
