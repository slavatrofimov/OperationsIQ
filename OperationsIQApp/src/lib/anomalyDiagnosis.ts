/**
 * Anomaly diagnosis backed by KQL `series_decompose_anomalies` + `diffpatterns`.
 *
 * A target signal's bins are labeled 'anomalous' / 'normal', each candidate
 * driver is discretized into a 'low' / 'normal' / 'high' regime per bin, and
 * the `diffpatterns` plugin finds the regime combinations most over-represented
 * in anomalous bins versus normal ones. This module parses that plugin output
 * into a ranked list of contributing factors, mapping the builder's static
 * Cand0..CandN columns back to the candidate tag ids.
 *
 * diffpatterns returns: SegmentId, CountA, CountB, PercentA, PercentB,
 * PercentDiffAB (absolute), then one column per input dimension. For string
 * columns the wildcard (dimension not part of the pattern) is an empty string;
 * we treat empty string and null alike as "wildcard".
 */
import { rowsToObjects, type KustoTable } from './eventhouse';

/** One dimension restriction that defines part of a pattern. */
export interface FactorTerm {
  /** Builder column name (Cand0..CandN). */
  column: string;
  /** The candidate driver tag id this column maps to. */
  tagId: string;
  /** The regime that characterizes the pattern ('low' / 'normal' / 'high'). */
  regime: string;
}

export interface DiagnosisFactor {
  segmentId: number;
  /** The non-wildcard dimension restrictions defining this pattern. */
  pattern: FactorTerm[];
  countAnomalous: number;
  countNormal: number;
  /** Percent of anomalous bins captured by the pattern (diffpatterns PercentA). */
  pctAnomalous: number;
  /** Percent of normal bins captured by the pattern (diffpatterns PercentB). */
  pctNormal: number;
  /** Signed over-representation in anomalies: pctAnomalous − pctNormal. */
  contribution: number;
  /** Absolute point difference (diffpatterns PercentDiffAB). */
  absDiff: number;
}

export interface AnomalyDiagnosis {
  targetTagId: string;
  /** Estimated total anomalous / normal bins (derived from the plugin percentages). */
  anomalousBins: number;
  normalBins: number;
  /** Contributing factors, ranked by signed over-representation in anomalies. */
  factors: DiagnosisFactor[];
}

interface DiffRow {
  SegmentId: number;
  CountA: number;
  CountB: number;
  PercentA: number;
  PercentB: number;
  PercentDiffAB: number;
  [col: string]: unknown;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A diffpatterns cell is a wildcard when it is null/undefined or an empty string. */
function isWildcard(v: unknown): boolean {
  return v == null || v === '';
}

/** Estimate the total set size from a captured count and its percentage. */
function estimateTotal(count: number, percent: number): number {
  if (percent <= 0) return 0;
  return Math.round((100 * count) / percent);
}

/**
 * Parse the `diffpatterns` result into ranked contributing factors. Pass the
 * candidate tag ids in the SAME order the query builder used, so Cand{i} maps
 * back to `candidateTagIds[i]`.
 */
export function parseAnomalyDiagnosis(
  table: KustoTable,
  targetTagId: string,
  candidateTagIds: string[],
  maxFactors = 12,
): AnomalyDiagnosis {
  const rows = rowsToObjects<DiffRow>(table);

  let anomalousBins = 0;
  let normalBins = 0;

  const factors: DiagnosisFactor[] = [];
  for (const r of rows) {
    const countAnomalous = num(r.CountA);
    const countNormal = num(r.CountB);
    const pctAnomalous = num(r.PercentA);
    const pctNormal = num(r.PercentB);

    // Recover the total set sizes from the most-populated segment we see.
    anomalousBins = Math.max(anomalousBins, estimateTotal(countAnomalous, pctAnomalous));
    normalBins = Math.max(normalBins, estimateTotal(countNormal, pctNormal));

    const pattern: FactorTerm[] = [];
    candidateTagIds.forEach((tagId, i) => {
      const col = `Cand${i}`;
      const val = r[col];
      if (!isWildcard(val)) pattern.push({ column: col, tagId, regime: String(val) });
    });
    // Skip the all-wildcard segment (no restriction — describes nothing).
    if (pattern.length === 0) continue;

    factors.push({
      segmentId: num(r.SegmentId),
      pattern,
      countAnomalous,
      countNormal,
      pctAnomalous,
      pctNormal,
      contribution: pctAnomalous - pctNormal,
      absDiff: num(r.PercentDiffAB),
    });
  }

  // Rank by signed over-representation in anomalies (strongest anomaly-linked
  // pattern first).
  factors.sort((a, b) => b.contribution - a.contribution);

  return {
    targetTagId,
    anomalousBins,
    normalBins,
    factors: factors.slice(0, maxFactors),
  };
}
