import { describe, it, expect, vi } from 'vitest';

// robustDeviation.ts -> eventhouse.ts pulls in msal/env; stub them so the pure
// parser can be imported headless (mirrors periods.test / eventhouse.test).
vi.mock('./msal', () => ({
  getEventhouseToken: vi.fn(async () => 'fake'),
  EventhouseSignInRequiredError: class extends Error {},
  notifyEventhouseSignInRequired: vi.fn(),
}));
vi.mock('./env', () => ({ env: { eventhouseQueryUri: 'https://c', eventhouseDb: 'db' } }));
vi.mock('./activeConnection', () => ({
  getActiveKqlOpts: () => undefined,
  getActiveProfileId: () => undefined,
  getActiveTimeseriesRef: () => 'Timeseries',
  getActiveTimeseriesIsWide: () => false,
  getActiveSignalIdDelimiter: () => '-',
  getActiveHierarchyRef: () => 'TagHierarchy',
  getActiveMetadataRef: () => 'TagMetadata',
  getActiveEventsRef: () => 'Events',
}));

import type { KustoTable } from './eventhouse';
import {
  parseRobustSeries,
  computeRobustDeviation,
  DEFAULT_TUKEY_THRESHOLD,
} from './robustDeviation';
import { buildRobustOutliersQuery } from './kql';

function robustTable(
  ts: string[],
  values: (number | null)[],
  scores: (number | null)[],
): KustoTable {
  return {
    name: 'PrimaryResult',
    columns: [
      { name: 'SignalId', type: 'string' },
      { name: 'Timestamp', type: 'dynamic' },
      { name: 'Value', type: 'dynamic' },
      { name: 'AnomalyScore', type: 'dynamic' },
    ],
    rows: [['tag-1', ts, values, scores]],
  };
}

const TS = ['2024-01-01T00:00:00Z', '2024-01-01T01:00:00Z', '2024-01-01T02:00:00Z', '2024-01-01T03:00:00Z'];

describe('parseRobustSeries', () => {
  it('parses the single-row series into parallel arrays', () => {
    const s = parseRobustSeries(robustTable(TS, [1, 2, 3, 40], [0, 0, 0, 3.2]));
    expect(s).not.toBeNull();
    expect(s!.tagId).toBe('tag-1');
    expect(s!.x).toHaveLength(4);
    expect(s!.values).toEqual([1, 2, 3, 40]);
    expect(s!.scores).toEqual([0, 0, 0, 3.2]);
  });

  it('returns null on an empty table', () => {
    const empty: KustoTable = { name: 'PrimaryResult', columns: [], rows: [] };
    expect(parseRobustSeries(empty)).toBeNull();
  });
});

describe('computeRobustDeviation', () => {
  it('flags a high outlier beyond the Tukey threshold and groups it as a breach', () => {
    const s = parseRobustSeries(robustTable(TS, [1, 2, 3, 40], [0, 0, 0, 3.2]))!;
    const d = computeRobustDeviation(s, DEFAULT_TUKEY_THRESHOLD);
    expect(d.expected.every((v) => v === 2.5)).toBe(true); // median of 1,2,3,40
    // Whisker envelope tops out at the largest non-outlier value (3).
    expect(d.upper.every((v) => v === 3)).toBe(true);
    expect(d.breaches).toHaveLength(1);
    expect(d.breaches[0]).toMatchObject({ startIndex: 3, endIndex: 3, direction: 'high', peakValue: 40 });
    expect(d.evaluated).toBe(4);
    expect(d.pctInBand).toBeCloseTo(3 / 4);
  });

  it('flags a low outlier via a negative score', () => {
    const s = parseRobustSeries(robustTable(TS, [-50, 10, 11, 12], [-4.0, 0, 0, 0]))!;
    const d = computeRobustDeviation(s);
    expect(d.breaches).toHaveLength(1);
    expect(d.breaches[0].direction).toBe('low');
    expect(d.lower.every((v) => v === 10)).toBe(true); // lowest non-outlier
  });

  it('reports no breaches when nothing exceeds the threshold', () => {
    const s = parseRobustSeries(robustTable(TS, [1, 2, 3, 4], [0.2, -0.5, 1.0, -1.2]))!;
    const d = computeRobustDeviation(s);
    expect(d.breaches).toHaveLength(0);
    expect(d.pctInBand).toBe(1);
  });

  it('ignores null values/scores in coverage', () => {
    const s = parseRobustSeries(robustTable(TS, [1, null, 3, 4], [0, null, 0, 0]))!;
    const d = computeRobustDeviation(s);
    expect(d.evaluated).toBe(3);
  });
});

describe('buildRobustOutliersQuery', () => {
  it('scores the gap-filled series with series_outliers and guards the tag literal', () => {
    const q = buildRobustOutliersQuery({
      tagId: 'tag-1',
      start: new Date('2024-01-01T00:00:00Z'),
      end: new Date('2024-01-02T00:00:00Z'),
      binKql: '1h',
    });
    expect(q).toContain('series_outliers(Value)');
    expect(q).toContain('series_fill_linear(Value)');
    expect(q).toContain("where SignalId == 'tag-1'");
    expect(q).toContain('project SignalId, Timestamp, Value, AnomalyScore');
  });
});
