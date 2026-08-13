import { describe, it, expect, vi } from 'vitest';

// kql.ts -> eventhouse.ts pulls in msal/env; stub them so the pure builder can
// be imported without a browser/MSAL environment (mirrors periods.test).
vi.mock('./msal', () => ({
  getEventhouseToken: vi.fn(async () => 'fake'),
  EventhouseSignInRequiredError: class extends Error {},
  notifyEventhouseSignInRequired: vi.fn(),
}));
vi.mock('./env', () => ({ env: { eventhouseQueryUri: 'https://c', eventhouseDb: 'db' } }));
// withTimeseriesRef reads getActiveTimeseriesRef(); returning 'Timeseries' makes
// the wrapping a byte-for-byte no-op (matching the "no timeseriesRef" fixtures).
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

import { buildMvadQuery, buildMvadCoverageQuery, MVAD_DEFAULT_PARAMS, type MvadAlgorithm } from './kql';

const TAGS = ['vibration-01', 'vibration-02', 'temperature-01'];
const START = new Date('2026-07-01T00:00:00Z');
const END = new Date('2026-07-08T00:00:00Z');

/** The shared Source + SeriesTable prefix every MVAD query emits. */
const PREFIX =
  `let Source = Timeseries\n` +
  `    | where Timestamp >= datetime(2026-07-01T00:00:00.000Z) and Timestamp < datetime(2026-07-08T00:00:00.000Z)\n` +
  `    | where SignalId in ('vibration-01', 'vibration-02', 'temperature-01')\n` +
  `    | project entity_id = 'selection', track_id = SignalId, timestamp = Timestamp, value = Value;\n` +
  `let SeriesTable = mvad_make_series(Source, datetime(2026-07-01T00:00:00.000Z), datetime(2026-07-08T00:00:00.000Z), 15m, 0.95, 3);\n`;

describe('buildMvadQuery emitted CSL', () => {
  it('residual_voting matches the live-validated contract', () => {
    const q = buildMvadQuery({
      algorithm: 'residual_voting',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '1h',
    });
    expect(q).toBe(
      PREFIX +
        `mvad_residual_magnitude_voting(SeriesTable, 1h, 0, 'linefit', 'ctukey', 1.5, 1.2, 2, 0.5, 3, false)`,
    );
  });

  it('random_projection matches the live-validated contract', () => {
    const q = buildMvadQuery({
      algorithm: 'random_projection',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '1h',
    });
    expect(q).toBe(
      PREFIX +
        `mvad_random_projection_ensemble(SeriesTable, 1h, 0, 'linefit', 16, 0.25, 'ops-iq-v1', 1.5, 1.2, 2, 3, 0.000001, 5000000, false)`,
    );
  });

  it('change_point matches the live-validated contract', () => {
    const q = buildMvadQuery({
      algorithm: 'change_point',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '1h',
    });
    expect(q).toBe(
      PREFIX +
        `mvad_change_point_ensemble(SeriesTable, 1h, 0, 8, 1.5, 1.2, 2, 0.5, 3, true, false)`,
    );
  });

  it('spectral matches the live-validated contract (8h = 32 bins minimum)', () => {
    const q = buildMvadQuery({
      algorithm: 'spectral',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '8h',
    });
    expect(q).toBe(
      PREFIX +
        `mvad_spectral_aggregation(SeriesTable, 8h, 8, 3, true, 2, 1.5, 2, 0.5, 4, false)`,
    );
  });

  it('emits stdev_floor as a plain decimal literal (not 1e-6)', () => {
    const q = buildMvadQuery({
      algorithm: 'random_projection',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '1h',
    });
    // Documents the actual kqlNum(1e-6) output so the CSL is stable.
    expect(q).toContain(', 0.000001, ');
    expect(q).not.toContain('1e-6');
  });
});

describe('buildMvadQuery options', () => {
  it('wraps the query in a let Timeseries binding when a timeseriesRef is given', () => {
    const q = buildMvadQuery({
      algorithm: 'residual_voting',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '1h',
      timeseriesRef: 'MySource | project SignalId, Timestamp, Value',
    });
    expect(q.startsWith('let Timeseries = (\nMySource | project SignalId, Timestamp, Value\n);\n')).toBe(
      true,
    );
    // The inner MVAD body is unchanged after the binding.
    expect(q).toContain(
      `mvad_residual_magnitude_voting(SeriesTable, 1h, 0, 'linefit', 'ctukey', 1.5, 1.2, 2, 0.5, 3, false)`,
    );
  });

  it('honours a custom entityId, coverage, gap, and emitAllScores', () => {
    const q = buildMvadQuery({
      algorithm: 'residual_voting',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '1h',
      entityId: 'line-7',
      minCoverage: 0.8,
      maxGapBins: 5,
      emitAllScores: true,
    });
    expect(q).toContain(`project entity_id = 'line-7', track_id = SignalId`);
    expect(q).toContain('mvad_make_series(Source, datetime(2026-07-01T00:00:00.000Z), datetime(2026-07-08T00:00:00.000Z), 15m, 0.8, 5);');
    expect(q.trimEnd().endsWith(', 3, true)')).toBe(true); // emit_all_scores flipped to true
  });

  it('flows non-default detector params through in the correct positions', () => {
    const q = buildMvadQuery({
      algorithm: 'residual_voting',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '1h',
      params: {
        seasonality: 96,
        trend: 'none',
        outlierKind: 'tukey',
        featureScoreThreshold: 2.5,
        residualRmsThreshold: 1.8,
        minTrackVotes: 3,
        minVoteFraction: 0.75,
        extremeFeatureThreshold: 5,
      },
    });
    expect(q).toContain(
      `mvad_residual_magnitude_voting(SeriesTable, 1h, 96, 'none', 'tukey', 2.5, 1.8, 3, 0.75, 5, false)`,
    );
  });

  it('overrides only the provided params, keeping the rest at defaults', () => {
    const q = buildMvadQuery({
      algorithm: 'change_point',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '1h',
      params: { detectSlopeChanges: false, contrastWindowBins: 16 },
    });
    expect(q).toContain(
      `mvad_change_point_ensemble(SeriesTable, 1h, 0, 16, 1.5, 1.2, 2, 0.5, 3, false, false)`,
    );
  });
});

describe('MVAD_DEFAULT_PARAMS', () => {
  it('exposes defaults for every algorithm', () => {
    const algos: MvadAlgorithm[] = ['residual_voting', 'random_projection', 'change_point', 'spectral'];
    for (const a of algos) {
      expect(MVAD_DEFAULT_PARAMS[a]).toBeDefined();
    }
    expect(MVAD_DEFAULT_PARAMS.random_projection.projectionSeed).toBe('ops-iq-v1');
    expect(MVAD_DEFAULT_PARAMS.spectral.trackScoreThreshold).toBe(2.0);
  });
});

describe('buildMvadQuery window alignment (binMillis)', () => {
  const BIN_MS = 15 * 60 * 1000;

  it('snaps a non-bin-multiple window end DOWN to a whole bin', () => {
    const q = buildMvadQuery({
      algorithm: 'residual_voting',
      tagIds: TAGS,
      start: new Date('2026-07-01T00:00:00Z'),
      end: new Date('2026-07-08T00:07:00Z'), // 7d + 7m: not a 15m multiple
      binKql: '15m',
      binMillis: BIN_MS,
      detectionWindowKql: '1h',
    });
    // floor((7d 7m) / 15m) = 672 bins -> aligned end = 2026-07-08T00:00:00Z
    expect(q).toContain(
      'Timestamp < datetime(2026-07-08T00:00:00.000Z)',
    );
    expect(q).toContain(
      'mvad_make_series(Source, datetime(2026-07-01T00:00:00.000Z), datetime(2026-07-08T00:00:00.000Z), 15m,',
    );
    expect(q).not.toContain('00:07:00');
  });

  it('leaves an already-aligned window unchanged when binMillis is provided', () => {
    const q = buildMvadQuery({
      algorithm: 'residual_voting',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      binMillis: BIN_MS,
      detectionWindowKql: '1h',
    });
    expect(q).toContain(
      'mvad_make_series(Source, datetime(2026-07-01T00:00:00.000Z), datetime(2026-07-08T00:00:00.000Z), 15m,',
    );
  });

  it('passes start/end through unchanged when binMillis is omitted', () => {
    const q = buildMvadQuery({
      algorithm: 'residual_voting',
      tagIds: TAGS,
      start: new Date('2026-07-01T00:00:00Z'),
      end: new Date('2026-07-08T00:07:00Z'),
      binKql: '15m',
      detectionWindowKql: '1h',
    });
    expect(q).toContain('Timestamp < datetime(2026-07-08T00:07:00.000Z)');
  });
});


describe('buildMvadQuery data-quality gate wiring (minCoverage / maxGapBins)', () => {
  it('threads non-default gates into the mvad_make_series call', () => {
    const q = buildMvadQuery({
      algorithm: 'residual_voting',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      minCoverage: 0.8,
      maxGapBins: 6,
      detectionWindowKql: '1h',
    });
    expect(q).toContain(
      'mvad_make_series(Source, datetime(2026-07-01T00:00:00.000Z), datetime(2026-07-08T00:00:00.000Z), 15m, 0.8, 6);',
    );
  });

  it('falls back to the 0.95 / 3 defaults when gates are omitted', () => {
    const q = buildMvadQuery({
      algorithm: 'residual_voting',
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      detectionWindowKql: '1h',
    });
    expect(q).toContain('15m, 0.95, 3);');
  });
});

describe('buildMvadCoverageQuery', () => {
  it('emits a projection-only companion query over the same window/bin/gate', () => {
    const q = buildMvadCoverageQuery({
      tagIds: TAGS,
      start: START,
      end: END,
      binKql: '15m',
      minCoverage: 0.8,
      maxGapBins: 6,
    });
    expect(q).toContain(
      `let Source = Timeseries\n` +
        `    | where Timestamp >= datetime(2026-07-01T00:00:00.000Z) and Timestamp < datetime(2026-07-08T00:00:00.000Z)\n` +
        `    | where SignalId in ('vibration-01', 'vibration-02', 'temperature-01')\n` +
        `    | project entity_id = 'selection', track_id = SignalId, timestamp = Timestamp, value = Value;\n`,
    );
    expect(q).toContain(
      'mvad_make_series(Source, datetime(2026-07-01T00:00:00.000Z), datetime(2026-07-08T00:00:00.000Z), 15m, 0.8, 6)',
    );
    expect(q).toContain(
      '| project track_id, point_count, observed_bins, coverage, max_missing_run, is_valid, validation_error',
    );
    // The companion query must NOT invoke any detector.
    expect(q).not.toContain('mvad_residual_magnitude_voting');
  });

  it('defaults the gate to 0.95 / 3 and snaps a non-bin-multiple end down', () => {
    const q = buildMvadCoverageQuery({
      tagIds: TAGS,
      start: new Date('2026-07-01T00:00:00Z'),
      end: new Date('2026-07-08T00:07:00Z'),
      binKql: '15m',
      binMillis: 15 * 60 * 1000,
    });
    expect(q).toContain(
      'mvad_make_series(Source, datetime(2026-07-01T00:00:00.000Z), datetime(2026-07-08T00:00:00.000Z), 15m, 0.95, 3)',
    );
    expect(q).not.toContain('00:07:00');
  });
});