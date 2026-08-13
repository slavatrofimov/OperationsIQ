import { describe, it, expect, vi } from 'vitest';

// mvad.ts -> eventhouse.ts pulls in msal/env; stub them so the pure parser can
// be imported without a browser/MSAL environment (mirrors periods.test).
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
  parseMvadRows,
  MVAD_ALGORITHMS,
  parseMvadCoverageRows,
  summarizeMvadCoverage,
} from './mvad';

const COLUMNS = [
  { name: 'entity_id', type: 'string' },
  { name: 'algorithm', type: 'string' },
  { name: 'event_index', type: 'long' },
  { name: 'event_time', type: 'datetime' },
  { name: 'window_start', type: 'datetime' },
  { name: 'window_end', type: 'datetime' },
  { name: 'score', type: 'real' },
  { name: 'threshold', type: 'real' },
  { name: 'severity', type: 'real' },
  { name: 'is_anomaly', type: 'bool' },
  { name: 'vote_count', type: 'long' },
  { name: 'vote_fraction', type: 'real' },
  { name: 'track_count', type: 'long' },
  { name: 'contributors', type: 'dynamic' },
  { name: 'status', type: 'string' },
  { name: 'explain', type: 'dynamic' },
];

function table(rows: unknown[][]): KustoTable {
  return { name: 'PrimaryResult', columns: COLUMNS, rows };
}

// A scored row whose contributors use the residual detector's `feature_score` key.
const scoredRowFeature: unknown[] = [
  'selection',
  'residual_voting',
  5,
  '2026-07-01T01:15:00.000Z',
  '2026-07-01T01:15:00.000Z',
  '2026-07-01T01:30:00.000Z',
  2.4,
  1.2,
  0.8,
  true,
  2,
  0.6667,
  3,
  [
    { track_id: 'vibration-01', feature_score: 3.1, voted: true },
    { track_id: 'temperature-01', feature_score: 0.4, voted: false },
  ],
  'ok',
  { feature_score_threshold: 1.5, required_votes: 2 },
];

// A scored row whose contributors use the `track_score` key variant.
const scoredRowTrack: unknown[] = [
  'selection',
  'change_point',
  2,
  '2026-07-01T00:30:00.000Z',
  '2026-07-01T00:30:00.000Z',
  '2026-07-01T00:45:00.000Z',
  1.9,
  1.2,
  0.5,
  true,
  2,
  0.5,
  4,
  [
    { track_id: 'vibration-02', track_score: 2.2, voted: true },
    { track_id: 'vibration-01', track_score: 1.0, voted: false },
  ],
  'ok',
  { contrast_window_bins: 8 },
];

// A diagnostic (non-ok) row: no meaningful score, event_index -1.
const diagnosticRow: unknown[] = [
  'selection',
  'residual_voting',
  -1,
  null,
  null,
  null,
  null,
  null,
  null,
  false,
  0,
  0,
  1,
  [],
  'invalid_input',
  { reason: 'need >= 2 tracks' },
];

describe('parseMvadRows', () => {
  it('maps the 16-column contract and normalizes contributor score keys', () => {
    const [row] = parseMvadRows(table([scoredRowFeature]));
    expect(row.entityId).toBe('selection');
    expect(row.algorithm).toBe('residual_voting');
    expect(row.eventIndex).toBe(5);
    expect(row.eventTime).toBeInstanceOf(Date);
    expect(row.eventTime?.toISOString()).toBe('2026-07-01T01:15:00.000Z');
    expect(row.windowEnd?.toISOString()).toBe('2026-07-01T01:30:00.000Z');
    expect(row.score).toBeCloseTo(2.4);
    expect(row.threshold).toBeCloseTo(1.2);
    expect(row.isAnomaly).toBe(true);
    expect(row.voteCount).toBe(2);
    expect(row.trackCount).toBe(3);
    expect(row.status).toBe('ok');
    expect(row.isDiagnostic).toBe(false);
    expect(row.explain).toEqual({ feature_score_threshold: 1.5, required_votes: 2 });
    expect(row.contributors).toEqual([
      { trackId: 'vibration-01', score: 3.1, voted: true },
      { trackId: 'temperature-01', score: 0.4, voted: false },
    ]);
  });

  it('accepts the track_score contributor key variant', () => {
    const [row] = parseMvadRows(table([scoredRowTrack]));
    expect(row.contributors).toEqual([
      { trackId: 'vibration-02', score: 2.2, voted: true },
      { trackId: 'vibration-01', score: 1.0, voted: false },
    ]);
  });

  it('flags non-ok rows as diagnostics and tolerates null score/time', () => {
    const [row] = parseMvadRows(table([diagnosticRow]));
    expect(row.status).toBe('invalid_input');
    expect(row.isDiagnostic).toBe(true);
    expect(row.eventIndex).toBe(-1);
    expect(row.eventTime).toBeNull();
    expect(Number.isNaN(row.score)).toBe(true);
    expect(row.contributors).toEqual([]);
    expect(row.explain).toEqual({ reason: 'need >= 2 tracks' });
  });

  it('sorts scored rows by eventIndex asc and appends diagnostics', () => {
    // input order: index 5, diagnostic, index 2 -> expect [2, 5, diagnostic]
    const rows = parseMvadRows(table([scoredRowFeature, diagnosticRow, scoredRowTrack]));
    expect(rows.map((r) => ({ i: r.eventIndex, d: r.isDiagnostic }))).toEqual([
      { i: 2, d: false },
      { i: 5, d: false },
      { i: -1, d: true },
    ]);
  });

  it('parses contributors and explain from JSON string cells', () => {
    const row = [...scoredRowFeature];
    row[13] = JSON.stringify([{ track_id: 't1', score: 9, voted: true }]);
    row[15] = JSON.stringify({ k: 'v' });
    const [parsed] = parseMvadRows(table([row]));
    expect(parsed.contributors).toEqual([{ trackId: 't1', score: 9, voted: true }]);
    expect(parsed.explain).toEqual({ k: 'v' });
  });

  it('throws an actionable error when required columns are missing', () => {
    const stale: KustoTable = {
      name: 'PrimaryResult',
      // Missing algorithm / event_index / score / is_anomaly / status.
      columns: [{ name: 'entity_id', type: 'string' }],
      rows: [['selection']],
    };
    expect(() => parseMvadRows(stale)).toThrowError(/out of date|redeploy/i);
  });

  it('returns an empty array for an empty table without throwing', () => {
    expect(parseMvadRows(table([]))).toEqual([]);
  });
});

describe('MVAD_ALGORITHMS catalog', () => {
  it('has one entry per algorithm with the correct KQL function names', () => {
    expect(MVAD_ALGORITHMS.map((a) => a.id)).toEqual([
      'residual_voting',
      'random_projection',
      'change_point',
      'spectral',
    ]);
    const byId = Object.fromEntries(MVAD_ALGORITHMS.map((a) => [a.id, a]));
    expect(byId.residual_voting.kqlFunction).toBe('mvad_residual_magnitude_voting');
    expect(byId.random_projection.kqlFunction).toBe('mvad_random_projection_ensemble');
    expect(byId.change_point.kqlFunction).toBe('mvad_change_point_ensemble');
    expect(byId.spectral.kqlFunction).toBe('mvad_spectral_aggregation');
  });

  it('requires >= 2 tracks for all and >= 32 detection bins only for spectral', () => {
    for (const a of MVAD_ALGORITHMS) {
      expect(a.requiresMinTracks).toBe(2);
      expect(a.bestFor.length).toBeGreaterThan(0);
      expect(a.notIdeal.length).toBeGreaterThan(0);
    }
    const spectral = MVAD_ALGORITHMS.find((a) => a.id === 'spectral');
    expect(spectral?.requiresMinDetectionBins).toBe(32);
    const others = MVAD_ALGORITHMS.filter((a) => a.id !== 'spectral');
    for (const a of others) {
      expect(a.requiresMinDetectionBins).toBeUndefined();
    }
  });
});


const COVERAGE_COLUMNS = [
  { name: 'track_id', type: 'string' },
  { name: 'point_count', type: 'long' },
  { name: 'observed_bins', type: 'long' },
  { name: 'coverage', type: 'real' },
  { name: 'max_missing_run', type: 'long' },
  { name: 'is_valid', type: 'bool' },
  { name: 'validation_error', type: 'string' },
];

function coverageTable(rows: unknown[][]): KustoTable {
  return { name: 'PrimaryResult', columns: COVERAGE_COLUMNS, rows };
}

describe('parseMvadCoverageRows', () => {
  it('parses per-track quality columns', () => {
    const rows = parseMvadCoverageRows(
      coverageTable([
        ['vibration-01', 672, 672, 1.0, 0, true, ''],
        ['vibration-02', 672, 640, 0.9524, 4, false, 'max_gap_exceeded'],
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      trackId: 'vibration-01',
      pointCount: 672,
      observedBins: 672,
      coverage: 1.0,
      maxMissingRun: 0,
      isValid: true,
      validationError: '',
    });
    expect(rows[1]).toMatchObject({
      trackId: 'vibration-02',
      coverage: 0.9524,
      maxMissingRun: 4,
      isValid: false,
      validationError: 'max_gap_exceeded',
    });
  });

  it('returns [] for an empty table', () => {
    expect(parseMvadCoverageRows(coverageTable([]))).toEqual([]);
  });

  it('throws when a required quality column is missing and rows exist', () => {
    const table: KustoTable = {
      name: 'PrimaryResult',
      columns: [
        { name: 'track_id', type: 'string' },
        { name: 'coverage', type: 'real' },
      ],
      rows: [['vibration-01', 0.9]],
    };
    expect(() => parseMvadCoverageRows(table)).toThrow(/max_missing_run/);
  });
});

describe('summarizeMvadCoverage', () => {
  it('reports worst coverage, worst gap, and failing tracks', () => {
    const rows = parseMvadCoverageRows(
      coverageTable([
        ['vibration-01', 672, 672, 1.0, 0, true, ''],
        ['vibration-02', 672, 640, 0.9524, 4, false, 'max_gap_exceeded'],
        ['temperature-01', 672, 500, 0.744, 2, false, 'insufficient_coverage'],
      ]),
    );
    const s = summarizeMvadCoverage(rows);
    expect(s.trackCount).toBe(3);
    expect(s.minCoverage).toBeCloseTo(0.744, 3);
    expect(s.worstMaxGap).toBe(4);
    expect(s.invalidTracks).toEqual([
      { trackId: 'vibration-02', validationError: 'max_gap_exceeded' },
      { trackId: 'temperature-01', validationError: 'insufficient_coverage' },
    ]);
  });

  it('handles an empty set without throwing', () => {
    const s = summarizeMvadCoverage([]);
    expect(s).toEqual({ trackCount: 0, minCoverage: 0, worstMaxGap: 0, invalidTracks: [] });
  });
});