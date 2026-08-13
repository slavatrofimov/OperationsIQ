import { describe, expect, it } from 'vitest';
import { buildBinnedMultiSeriesQuery, buildBinnedSeriesQuery } from './kql';

const base = {
  start: new Date('2026-06-01T00:00:00Z'),
  end: new Date('2026-06-08T00:00:00Z'),
  binKql: '1h',
  timeseriesRef: 'Timeseries',
};

describe('buildBinnedMultiSeriesQuery', () => {
  it('queries all tags in one make-series grouped by SignalId', () => {
    const csl = buildBinnedMultiSeriesQuery({
      tagIds: ['sig-a', 'sig-b', 'sig-c'],
      ...base,
    });
    // Single `in (...)` filter covering every tag, not one query per tag.
    expect(csl).toContain("| where SignalId in (dynamic(['sig-a', 'sig-b', 'sig-c']))");
    // One row per signal, same shape as the single-tag builder.
    expect(csl).toContain('by SignalId');
    expect(csl).toContain('| project SignalId, Timestamp, Value');
    // Exactly one make-series (one query, not one per tag).
    expect(csl.match(/make-series/g)).toHaveLength(1);
  });

  it('fills gaps by default and skips the fill for calendar (fill:false)', () => {
    const filled = buildBinnedMultiSeriesQuery({ tagIds: ['sig-a'], ...base });
    expect(filled).toContain('series_fill_linear(Value)');

    const raw = buildBinnedMultiSeriesQuery({ tagIds: ['sig-a'], ...base, fill: false });
    expect(raw).not.toContain('series_fill_linear');
  });

  it('produces the same per-signal projection as the single-tag builder', () => {
    const multi = buildBinnedMultiSeriesQuery({ tagIds: ['sig-a'], ...base });
    const single = buildBinnedSeriesQuery({ tagId: 'sig-a', ...base });
    // Both project the same columns and aggregate identically; only the filter differs.
    expect(multi).toContain('| project SignalId, Timestamp, Value');
    expect(single).toContain('| project SignalId, Timestamp, Value');
    expect(multi).toContain('make-series Value = avg(Value)');
    expect(single).toContain('make-series Value = avg(Value)');
  });

  it('honors a non-default aggregation', () => {
    const csl = buildBinnedMultiSeriesQuery({
      tagIds: ['sig-a', 'sig-b'],
      ...base,
      aggregation: 'max',
    });
    expect(csl).toContain('make-series Value = max(Value)');
  });
});
