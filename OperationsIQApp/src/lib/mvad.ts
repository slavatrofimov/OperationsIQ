/**
 * Result parsing + normalized view-model + static catalog for the pure-KQL
 * multivariate anomaly-detection (MVAD) library deployed in the Eventhouse
 * (`eventhouse/schema/80_mvad_core.kql` .. `84_mvad_spectral.kql`).
 *
 * The four detectors (mvad_residual_magnitude_voting, mvad_random_projection_
 * ensemble, mvad_change_point_ensemble, mvad_spectral_aggregation) share ONE
 * 16-column result contract, so a single {@link parseMvadRows} normalizes any of
 * them. Query construction lives in `src/lib/kql.ts` (`buildMvadQuery`); this
 * module is pure (no React) so it can be unit-tested and reused by PR-1b's UI.
 */

import type { KustoTable } from './eventhouse';
import type { MvadAlgorithm } from './kql';

/** One track's contribution to a scored MVAD event (an entry of `contributors`). */
export interface MvadContributor {
  trackId: string;
  /**
   * The track's per-detector score. The KQL bag uses a detector-specific key
   * (`feature_score` for residual voting, `track_score` for change-point /
   * spectral, `score` for random projection); all are surfaced here as `score`.
   */
  score: number;
  /** Whether this track met the detector's per-track vote threshold. */
  voted: boolean;
}

/**
 * One normalized MVAD result row. Scored rows have `status === 'ok'`; every other
 * status is a DIAGNOSTIC row (score is not meaningful, `eventIndex === -1`) and is
 * kept with `isDiagnostic === true` so callers can surface why nothing scored
 * (e.g. `misaligned_series`, `insufficient_history`, `insufficient_coverage`,
 * `invalid_input`, `work_limit_exceeded`).
 */
export interface MvadResultRow {
  entityId: string;
  algorithm: string;
  eventIndex: number;
  eventTime: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  score: number;
  threshold: number;
  severity: number;
  isAnomaly: boolean;
  voteCount: number;
  voteFraction: number;
  trackCount: number;
  contributors: MvadContributor[];
  status: string;
  explain: Record<string, unknown>;
  isDiagnostic: boolean;
}

function indexer(table: KustoTable) {
  const map = new Map(table.columns.map((c, i) => [c.name, i]));
  return (name: string): number => map.get(name) ?? -1;
}

function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v === '1';
  return false;
}

/** Parse a Kusto datetime cell (ISO string / Date / epoch) to a Date, or null. */
function parseDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse the `explain` cell — a JSON bag — into an opaque object. */
function parseExplain(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to empty bag */
    }
  }
  return {};
}

/** Parse the `contributors` cell — a JSON array of per-track bags. */
function parseContributors(v: unknown): MvadContributor[] {
  let arr: unknown = v;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((entry) => {
    const b = (entry ?? {}) as Record<string, unknown>;
    // The score key name varies by detector; accept any of the known variants.
    const rawScore =
      b.feature_score ?? b.track_score ?? b.score ?? b.projection_score;
    return {
      trackId: String(b.track_id ?? ''),
      score: num(rawScore),
      voted: bool(b.voted),
    };
  });
}

/**
 * Parse an MVAD detector result table into typed rows. Scored rows are sorted by
 * `eventIndex` ascending; diagnostic rows (status !== 'ok') are preserved and
 * appended after the scored rows in their original order.
 *
 * Throws an actionable error if the deployed detector's result schema is missing
 * required columns (i.e. an out-of-date function), mirroring `parseDiscordRows`.
 */
export function parseMvadRows(table: KustoTable): MvadResultRow[] {
  const at = indexer(table);
  const iEntity = at('entity_id');
  const iAlgo = at('algorithm');
  const iEventIndex = at('event_index');
  const iEventTime = at('event_time');
  const iWindowStart = at('window_start');
  const iWindowEnd = at('window_end');
  const iScore = at('score');
  const iThreshold = at('threshold');
  const iSeverity = at('severity');
  const iIsAnomaly = at('is_anomaly');
  const iVoteCount = at('vote_count');
  const iVoteFraction = at('vote_fraction');
  const iTrackCount = at('track_count');
  const iContributors = at('contributors');
  const iStatus = at('status');
  const iExplain = at('explain');

  const missing = (
    [
      ['entity_id', iEntity],
      ['algorithm', iAlgo],
      ['event_index', iEventIndex],
      ['score', iScore],
      ['is_anomaly', iIsAnomaly],
      ['status', iStatus],
    ] as const
  )
    .filter(([, idx]) => idx < 0)
    .map(([name]) => name);
  if (table.rows.length > 0 && missing.length > 0) {
    throw new Error(
      `MVAD result is missing expected column(s): ${missing.join(', ')}. ` +
        'The deployed MVAD function is out of date — redeploy the Eventhouse ' +
        'schema (eventhouse/schema/80-84_mvad_*.kql).',
    );
  }

  const rows: MvadResultRow[] = table.rows.map((r) => {
    const status = String(r[iStatus] ?? '');
    return {
      entityId: String(r[iEntity] ?? ''),
      algorithm: String(r[iAlgo] ?? ''),
      eventIndex: Math.round(num(r[iEventIndex])),
      eventTime: iEventTime >= 0 ? parseDate(r[iEventTime]) : null,
      windowStart: iWindowStart >= 0 ? parseDate(r[iWindowStart]) : null,
      windowEnd: iWindowEnd >= 0 ? parseDate(r[iWindowEnd]) : null,
      score: iScore >= 0 ? num(r[iScore]) : NaN,
      threshold: iThreshold >= 0 ? num(r[iThreshold]) : NaN,
      severity: iSeverity >= 0 ? num(r[iSeverity]) : NaN,
      isAnomaly: iIsAnomaly >= 0 ? bool(r[iIsAnomaly]) : false,
      voteCount: iVoteCount >= 0 ? Math.round(num(r[iVoteCount])) : NaN,
      voteFraction: iVoteFraction >= 0 ? num(r[iVoteFraction]) : NaN,
      trackCount: iTrackCount >= 0 ? Math.round(num(r[iTrackCount])) : NaN,
      contributors: iContributors >= 0 ? parseContributors(r[iContributors]) : [],
      status,
      explain: iExplain >= 0 ? parseExplain(r[iExplain]) : {},
      isDiagnostic: status !== 'ok',
    };
  });

  const scored = rows.filter((row) => !row.isDiagnostic);
  const diagnostics = rows.filter((row) => row.isDiagnostic);
  scored.sort((a, b) => a.eventIndex - b.eventIndex);
  return [...scored, ...diagnostics];
}

// --- per-track data-quality (coverage badge) --------------------------------

/**
 * One track's data-quality metrics from the companion coverage query
 * (`buildMvadCoverageQuery` -> `mvad_make_series` quality columns). `coverage` is
 * the fraction of bins with at least one finite sample; `maxMissingRun` is the
 * longest run of consecutive empty bins. `isValid`/`validationError` reflect the
 * `min_coverage`/`max_gap_bins` gate the query was run with.
 */
export interface MvadCoverageRow {
  trackId: string;
  pointCount: number;
  observedBins: number;
  /** Fraction of bins with data, 0..1. */
  coverage: number;
  /** Longest run of consecutive missing bins. */
  maxMissingRun: number;
  isValid: boolean;
  /** '' when valid, else e.g. 'insufficient_coverage' / 'max_gap_exceeded'. */
  validationError: string;
}

/** Roll-up of {@link MvadCoverageRow}s for a one-line badge. */
export interface MvadCoverageSummary {
  trackCount: number;
  /** Worst (lowest) per-track coverage across tracks, 0..1; 0 when no tracks. */
  minCoverage: number;
  /** Worst (largest) per-track max missing run across tracks, in bins. */
  worstMaxGap: number;
  /** Tracks that failed the current coverage/gap gate. */
  invalidTracks: { trackId: string; validationError: string }[];
}

/**
 * Parse the companion coverage table (`buildMvadCoverageQuery`) into typed rows.
 * Returns [] for an empty table. Throws an actionable error if the deployed
 * `mvad_make_series` is missing expected quality columns (out-of-date schema).
 */
export function parseMvadCoverageRows(table: KustoTable): MvadCoverageRow[] {
  const at = indexer(table);
  const iTrack = at('track_id');
  const iPoint = at('point_count');
  const iObserved = at('observed_bins');
  const iCoverage = at('coverage');
  const iMaxRun = at('max_missing_run');
  const iValid = at('is_valid');
  const iError = at('validation_error');

  const missing = (
    [
      ['track_id', iTrack],
      ['coverage', iCoverage],
      ['max_missing_run', iMaxRun],
    ] as const
  )
    .filter(([, idx]) => idx < 0)
    .map(([name]) => name);
  if (table.rows.length > 0 && missing.length > 0) {
    throw new Error(
      `MVAD coverage result is missing expected column(s): ${missing.join(', ')}. ` +
        'The deployed MVAD function is out of date — redeploy the Eventhouse ' +
        'schema (eventhouse/schema/80-84_mvad_*.kql).',
    );
  }

  return table.rows.map((r) => ({
    trackId: String(r[iTrack] ?? ''),
    pointCount: iPoint >= 0 ? Math.round(num(r[iPoint])) : NaN,
    observedBins: iObserved >= 0 ? Math.round(num(r[iObserved])) : NaN,
    coverage: iCoverage >= 0 ? num(r[iCoverage]) : NaN,
    maxMissingRun: iMaxRun >= 0 ? Math.round(num(r[iMaxRun])) : NaN,
    isValid: iValid >= 0 ? bool(r[iValid]) : true,
    validationError: iError >= 0 ? String(r[iError] ?? '') : '',
  }));
}

/** Roll up per-track coverage rows into a one-line {@link MvadCoverageSummary}. */
export function summarizeMvadCoverage(rows: MvadCoverageRow[]): MvadCoverageSummary {
  const covs = rows.map((r) => r.coverage).filter((c) => Number.isFinite(c));
  const gaps = rows.map((r) => r.maxMissingRun).filter((g) => Number.isFinite(g));
  return {
    trackCount: rows.length,
    minCoverage: covs.length ? Math.min(...covs) : 0,
    worstMaxGap: gaps.length ? Math.max(...gaps) : 0,
    invalidTracks: rows
      .filter((r) => !r.isValid)
      .map((r) => ({ trackId: r.trackId, validationError: r.validationError })),
  };
}

// --- algorithm catalog (pure data for PR-1b UI) -----------------------------

/** Human-facing metadata describing one MVAD detector. */
export interface MvadAlgorithmInfo {
  id: MvadAlgorithm;
  /** The deployed KQL function name. */
  kqlFunction: string;
  /** Short display label. */
  label: string;
  /** One-line description of what the detector does. */
  blurb: string;
  /** When this detector is the right choice. */
  bestFor: string;
  /** When to prefer a different detector. */
  notIdeal: string;
  /** Minimum tracks per entity the detector requires (KQL enforces >= 2). */
  requiresMinTracks: number;
  /** Minimum bins in the detection window, when the detector imposes one. */
  requiresMinDetectionBins?: number;
}

/**
 * Static catalog of the four MVAD detectors. Text is grounded in the KQL
 * docstrings; `requiresMin*` mirror the detectors' validated constraints.
 */
export const MVAD_ALGORITHMS: MvadAlgorithmInfo[] = [
  {
    id: 'residual_voting',
    kqlFunction: 'mvad_residual_magnitude_voting',
    label: 'Residual magnitude voting',
    blurb:
      'Removes each track’s seasonal/trend baseline and votes on the magnitude of the leftover residuals across tracks.',
    bestFor:
      'coordinated point/level spikes in the residuals of several tracks at the same time',
    notIdeal: 'gradual drifts or single-track noise',
    requiresMinTracks: 2,
  },
  {
    id: 'random_projection',
    kqlFunction: 'mvad_random_projection_ensemble',
    label: 'Random projection ensemble',
    blurb:
      'Projects all tracks onto many random directions and votes across the projection ensemble; deterministic for a fixed seed.',
    bestFor:
      'high-dimensional coordinated outliers across many tracks; deterministic for a fixed seed',
    notIdeal: 'very few tracks (it needs several to project meaningfully)',
    requiresMinTracks: 2,
  },
  {
    id: 'change_point',
    kqlFunction: 'mvad_change_point_ensemble',
    label: 'Change-point ensemble',
    blurb:
      'Contrasts each track’s level (and optionally slope) before vs. after a moving boundary and votes on coordinated shifts.',
    bestFor: 'coordinated level or slope shifts (regime changes) across tracks',
    notIdeal: 'brief transient spikes',
    requiresMinTracks: 2,
  },
  {
    id: 'spectral',
    kqlFunction: 'mvad_spectral_aggregation',
    label: 'Spectral aggregation',
    blurb:
      'Compares the frequency/spectral shape of the latest window against recent baseline windows and aggregates across tracks.',
    bestFor:
      'changes in the periodic/spectral shape of the latest window vs. recent history (e.g. new vibration harmonics)',
    notIdeal:
      'short windows — it needs >= 32 bins in the detection window plus several full baseline windows of history, and scores only the most recent window',
    requiresMinTracks: 2,
    requiresMinDetectionBins: 32,
  },
];
