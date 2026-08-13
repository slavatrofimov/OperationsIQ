// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildJobPayload, type LivySource } from './livyClient';
import type { AnalysisJob } from './types';

function source(overrides: Partial<LivySource> = {}): LivySource {
  return {
    kqlClusterUri: 'https://cluster',
    database: 'db',
    table: 'Timeseries',
    timeColumn: 'Timestamp',
    valueColumn: 'Value',
    tagColumn: 'SignalId',
    tag: 'sig-a',
    windowStart: '2024-07-01T00:00:00Z',
    windowEnd: '2024-07-02T00:00:00Z',
    ...overrides,
  };
}

function job(overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  return {
    id: 'job-1',
    signalId: 'sig-a',
    type: 'AB_MOTIF',
    windowStart: '2024-07-01T00:00:00Z',
    windowEnd: '2024-07-02T00:00:00Z',
    status: 'QUEUED',
    progressPct: 0,
    ...overrides,
  };
}

const binnedSummary = JSON.stringify({ binSeconds: 3600, aggregation: 'max', gapFill: 'linear' });

describe('buildJobPayload source binning', () => {
  it('bins series A (source) when binSeconds is set', () => {
    const payload = buildJobPayload(job({ summary: binnedSummary }), source());
    const s = payload.source as LivySource;
    expect(s.binSeconds).toBe(3600);
    expect(s.aggregation).toBe('max');
    expect(s.gapFill).toBe('linear');
  });

  it('bins series B (compareSource) onto the SAME grid as series A', () => {
    const payload = buildJobPayload(
      job({ summary: binnedSummary, compareSignalId: 'sig-b' }),
      source(),
      source({ tag: 'sig-b' }),
    );
    const b = payload.compareSource as LivySource;
    // Series B must carry the identical bin width/aggregation/gap-fill as A, otherwise the
    // AB-join compares a binned A against a native B and B's indices drift off-chart.
    expect(b.binSeconds).toBe(3600);
    expect(b.aggregation).toBe('max');
    expect(b.gapFill).toBe('linear');
  });

  it('leaves compareSource native when no binSeconds is set', () => {
    const payload = buildJobPayload(job(), source(), source({ tag: 'sig-b' }));
    const b = payload.compareSource as LivySource;
    expect(b.binSeconds).toBeUndefined();
    expect(b.aggregation).toBeUndefined();
  });

  it('bins every multi-series signalSource on the shared grid', () => {
    const payload = buildJobPayload(
      job({ type: 'MULTIDIM_MOTIF', summary: binnedSummary }),
      source(),
      undefined,
      [source({ tag: 's0' }), source({ tag: 's1' })],
    );
    const list = payload.signalSources as LivySource[];
    expect(list).toHaveLength(2);
    for (const s of list) expect(s.binSeconds).toBe(3600);
  });
});
