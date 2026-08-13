/**
 * Seasonality / period-detection helpers (KQL `series_periods_detect`).
 *
 * The Decomposition and Forecast pages accept a seasonality period in *bins*.
 * Users normally have to guess it (or accept auto-detect); `series_periods_detect`
 * finds the dominant recurring cycles directly from the data so we can offer
 * them as one-click chips that fill the seasonality control.
 *
 * The KQL returns period lengths in units of the bin size, ordered by a 0..1
 * significance score. A period of 0 (score 0) is the "no pattern" sentinel, so
 * we drop non-positive periods/scores here.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';
import { formatDuration } from './binningSettings';

/** A single detected recurring cycle. */
export interface DetectedPeriod {
  /** Period length in bins (as returned by series_periods_detect). */
  bins: number;
  /** Period length in milliseconds (bins * binMillis). */
  millis: number;
  /** Significance score in [0, 1]; higher is stronger. */
  score: number;
}

interface PeriodsRow {
  SignalId: string;
  Periods: (number | null)[];
  Scores: (number | null)[];
}

/**
 * Parse the single-row `series_periods_detect` result into detected cycles.
 * Filters out the zero/no-pattern sentinels and orders by descending score.
 */
export function parseDetectedPeriods(table: KustoTable, binMillis: number): DetectedPeriod[] {
  const rows = rowsToObjects<PeriodsRow>(table);
  const r = rows[0];
  if (!r) return [];
  const periods = Array.isArray(r.Periods) ? r.Periods : [];
  const scores = Array.isArray(r.Scores) ? r.Scores : [];
  const out: DetectedPeriod[] = [];
  for (let i = 0; i < periods.length; i++) {
    const bins = Number(periods[i]);
    const score = Number(scores[i]);
    if (!Number.isFinite(bins) || bins <= 0) continue;
    if (!Number.isFinite(score) || score <= 0) continue;
    out.push({ bins, millis: bins * binMillis, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The seasonality value (in whole bins) to pass to a KQL decompose/forecast call. */
export function periodToSeasonalityBins(p: DetectedPeriod): number {
  return Math.max(1, Math.round(p.bins));
}

/** Human label for a detected cycle, e.g. "1d (24 bins) · 84%". */
export function formatDetectedPeriod(p: DetectedPeriod): string {
  const bins = periodToSeasonalityBins(p);
  const pct = Math.round(p.score * 100);
  return `${formatDuration(p.millis / 1000)} (${bins} bins) · ${pct}%`;
}
