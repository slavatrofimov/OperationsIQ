import { describe, it, expect, vi } from 'vitest';

// kql.ts resolves the timeseries source via getActiveTimeseriesRef; mock it to a bare table.
vi.mock('../activeConnection', async (orig) => {
  const actual = await orig<typeof import('../activeConnection')>();
  return { ...actual, getActiveTimeseriesRef: () => 'Timeseries' };
});

import { rawSignalCsl } from './rawSignalQuery';

const WIN = { startIso: '2024-01-01T00:00:00Z', endIso: '2024-02-01T00:00:00Z' };

describe('rawSignalCsl', () => {
  it('reads native points (uncapped-ish take) when the job was not binned', () => {
    const csl = rawSignalCsl({ signalId: 'sig-a', ...WIN });
    expect(csl).toContain('take 500000');
    expect(csl).not.toContain('make-series');
    expect(csl).toContain("SignalId == 'sig-a'");
  });

  it('reads the analysis grid (make-series) when binSeconds is set', () => {
    const csl = rawSignalCsl({ signalId: 'sig-a', ...WIN, binSeconds: 3600 });
    // 3600s bin -> 3600000ms step literal; expanded back to one row per bin.
    expect(csl).toContain('make-series');
    expect(csl).toContain('step 3600000ms');
    expect(csl).toContain('mv-expand Value to typeof(real)');
    expect(csl).not.toContain('take 500000');
  });

  it('applies the job aggregation, defaulting invalid values to avg', () => {
    expect(rawSignalCsl({ signalId: 's', ...WIN, binSeconds: 60, aggregation: 'max' })).toContain(
      'max(Value)',
    );
    expect(rawSignalCsl({ signalId: 's', ...WIN, binSeconds: 60, aggregation: 'bogus' })).toContain(
      'avg(Value)',
    );
  });

  it('fills gaps linearly unless gapFill is "none"', () => {
    expect(rawSignalCsl({ signalId: 's', ...WIN, binSeconds: 60, gapFill: 'linear' })).toContain(
      'series_fill_linear',
    );
    expect(
      rawSignalCsl({ signalId: 's', ...WIN, binSeconds: 60, gapFill: 'none' }),
    ).not.toContain('series_fill_linear');
  });

  it('ignores non-positive binSeconds (falls back to native)', () => {
    expect(rawSignalCsl({ signalId: 's', ...WIN, binSeconds: 0 })).toContain('take 500000');
    expect(rawSignalCsl({ signalId: 's', ...WIN, binSeconds: -1 })).toContain('take 500000');
  });
});
