import { describe, it, expect, vi } from 'vitest';

// anomalyDiagnosis.ts -> eventhouse.ts pulls in msal/env; stub them so the pure
// parser can be imported headless (mirrors periods.test / spectrum.test).
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
import { parseAnomalyDiagnosis } from './anomalyDiagnosis';
import { buildAnomalyDiagnosisQuery } from './kql';

// diffpatterns-shaped table: fixed columns + one column per candidate.
function diffTable(rows: unknown[][]): KustoTable {
  return {
    name: 'PrimaryResult',
    columns: [
      { name: 'SegmentId', type: 'long' },
      { name: 'CountA', type: 'long' },
      { name: 'CountB', type: 'long' },
      { name: 'PercentA', type: 'real' },
      { name: 'PercentB', type: 'real' },
      { name: 'PercentDiffAB', type: 'real' },
      { name: 'Cand0', type: 'string' },
      { name: 'Cand1', type: 'string' },
    ],
    rows,
  };
}

describe('parseAnomalyDiagnosis', () => {
  it('maps Cand columns back to tag ids and drops wildcard-only rows', () => {
    const table = diffTable([
      // all-wildcard row (empty strings) — should be skipped.
      [0, 40, 200, 100, 100, 0, '', ''],
      // Cand0=high strongly over-represented in anomalies.
      [1, 30, 20, 75, 10, 65, 'high', ''],
      // Cand1=low, both columns set.
      [2, 10, 8, 25, 4, 21, 'normal', 'low'],
    ]);
    const d = parseAnomalyDiagnosis(table, 'pump-1', ['motor-1', 'valve-1']);
    expect(d.targetTagId).toBe('pump-1');
    expect(d.factors).toHaveLength(2);

    const top = d.factors[0];
    expect(top.pattern).toEqual([{ column: 'Cand0', tagId: 'motor-1', regime: 'high' }]);
    expect(top.contribution).toBeCloseTo(65);
    expect(top.absDiff).toBeCloseTo(65);

    const second = d.factors[1];
    expect(second.pattern).toEqual([
      { column: 'Cand0', tagId: 'motor-1', regime: 'normal' },
      { column: 'Cand1', tagId: 'valve-1', regime: 'low' },
    ]);
  });

  it('ranks factors by signed over-representation in anomalies', () => {
    const table = diffTable([
      [1, 10, 30, 20, 60, 40, 'low', ''], // under-represented (negative)
      [2, 30, 10, 60, 20, 40, 'high', ''], // over-represented (positive)
    ]);
    const d = parseAnomalyDiagnosis(table, 'pump-1', ['motor-1', 'valve-1']);
    expect(d.factors[0].pattern[0].regime).toBe('high');
    expect(d.factors[0].contribution).toBeGreaterThan(0);
    expect(d.factors[1].contribution).toBeLessThan(0);
  });

  it('estimates total anomalous / normal bin counts from the plugin percentages', () => {
    const table = diffTable([
      [1, 30, 20, 75, 10, 65, 'high', ''], // 30/0.75 = 40 anomalous, 20/0.10 = 200 normal
    ]);
    const d = parseAnomalyDiagnosis(table, 'pump-1', ['motor-1', 'valve-1']);
    expect(d.anomalousBins).toBe(40);
    expect(d.normalBins).toBe(200);
  });

  it('treats null cells as wildcards', () => {
    const table = diffTable([[1, 30, 20, 75, 10, 65, 'high', null]]);
    const d = parseAnomalyDiagnosis(table, 'pump-1', ['motor-1', 'valve-1']);
    expect(d.factors[0].pattern).toHaveLength(1);
    expect(d.factors[0].pattern[0].regime).toBe('high');
  });

  it('caps the number of returned factors', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [
      i + 1,
      i,
      1,
      i,
      1,
      Math.abs(i - 1),
      'high',
      '',
    ]);
    const d = parseAnomalyDiagnosis(diffTable(rows), 'pump-1', ['m', 'v'], 5);
    expect(d.factors).toHaveLength(5);
  });
});

describe('buildAnomalyDiagnosisQuery', () => {
  const base = {
    targetTagId: 'pump-1',
    candidateTagIds: ['motor-1', 'valve-1'],
    start: new Date('2024-01-01T00:00:00Z'),
    end: new Date('2024-01-02T00:00:00Z'),
    binKql: '1h',
  };

  it('flags the target with series_decompose_anomalies and guards literals', () => {
    const q = buildAnomalyDiagnosisQuery(base);
    expect(q).toContain('series_decompose_anomalies(V, 1.5, -1, \'linefit\')');
    expect(q).toContain("where SignalId == 'pump-1'");
    expect(q).toContain("where SignalId == 'motor-1'");
    expect(q).toContain("where SignalId == 'valve-1'");
    expect(q).toContain("Label = iff(Flags != 0, 'anomalous', 'normal')");
  });

  it('discretizes each candidate into low/normal/high regimes', () => {
    const q = buildAnomalyDiagnosisQuery(base);
    expect(q).toContain('series_stats(V)');
    expect(q).toContain("Cand0 = case(V > Cavg + 0.5 * Cstdev, 'high'");
    expect(q).toContain("Cand1 = case(V > Cavg + 0.5 * Cstdev, 'high'");
  });

  it('joins all candidates and evaluates diffpatterns on the label', () => {
    const q = buildAnomalyDiagnosisQuery(base);
    expect(q).toContain('| join kind=inner (_Cand0) on Timestamp');
    expect(q).toContain('| join kind=inner (_Cand1) on Timestamp');
    expect(q).toContain('project Label, Cand0, Cand1');
    expect(q).toContain("evaluate diffpatterns(Label, 'anomalous', 'normal')");
  });

  it('honors a custom sensitivity', () => {
    const q = buildAnomalyDiagnosisQuery({ ...base, sensitivity: 3 });
    expect(q).toContain('series_decompose_anomalies(V, 3, -1, \'linefit\')');
  });
});
