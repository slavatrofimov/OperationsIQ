import { describe, expect, it } from 'vitest';
import {
  buildCorrelationMatrixQuery,
  buildRegressionQuery,
  buildSensitivityQuery,
} from './kql';

const base = {
  start: new Date('2026-06-01T00:00:00Z'),
  end: new Date('2026-06-08T00:00:00Z'),
  binKql: '15m',
  timeseriesRef: 'Timeseries',
};

describe('regression query deterministic ordering', () => {
  it('buildRegressionQuery orders the union deterministically by RSq then FeatureTagId', () => {
    const csl = buildRegressionQuery({
      targetTagId: 'temperature-01',
      featureTagIds: ['pressure-01', 'vibration-01', 'flow-01'],
      ...base,
    });
    expect(csl).toContain('| order by RSq desc, FeatureTagId asc');
    // The order clause must come after the union so it applies to all fits.
    expect(csl.indexOf('| order by RSq desc, FeatureTagId asc')).toBeGreaterThan(
      csl.indexOf('union Fit0'),
    );
  });

  it('buildSensitivityQuery breaks RSq ties deterministically by FeatureTagId', () => {
    const csl = buildSensitivityQuery({
      targetTagId: 'temperature-01',
      featureTagIds: ['pressure-01', 'vibration-01'],
      ...base,
    });
    expect(csl).toContain('| order by RSq desc, FeatureTagId asc');
  });

  it('buildCorrelationMatrixQuery orders pairs deterministically', () => {
    const csl = buildCorrelationMatrixQuery({
      tagIds: ['temperature-01', 'pressure-01', 'vibration-01'],
      ...base,
    });
    expect(csl).toContain('| order by TagA asc, TagB asc');
  });
});
