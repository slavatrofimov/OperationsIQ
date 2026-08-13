/**
 * Root-cause analysis helpers (functional spec §Root-cause workspace).
 *
 * Given a target signal and a set of candidate driver signals sampled on a
 * common grid, compute the lagged cross-correlation of each candidate against
 * the target. The best lag tells us whether a candidate *leads* the target
 * (a prerequisite for it being a plausible cause) and by how much; the
 * correlation magnitude ranks candidates by strength of association.
 *
 * IMPORTANT: correlation (even lagged) is association, not proof of causation.
 * The UI surfaces this explicitly. These rankings are hypotheses for an
 * engineer to confirm, not automated root-cause verdicts.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';

/** One signal's values on the shared, gap-filled time grid. */
export interface AlignedSeries {
  tagId: string;
  /** Unix ms timestamps. */
  t: number[];
  /** Values aligned to `t`; nulls have been filled upstream but may remain. */
  v: (number | null)[];
}

/** Parse the aligned-series KQL result into per-tag arrays. */
export function parseAlignedSeries(table: KustoTable): AlignedSeries[] {
  const rows = rowsToObjects<{ SignalId: string; Timestamp: string[]; Value: (number | null)[] }>(
    table,
  );
  return rows.map((r) => ({
    tagId: r.SignalId,
    t: (r.Timestamp ?? []).map((x) => new Date(x).getTime()),
    v: (r.Value ?? []).map((x) => (x == null ? null : Number(x))),
  }));
}

/** Z-normalize a numeric array, treating nulls as gaps (kept as NaN). */
function znorm(v: (number | null)[]): number[] {
  const nums = v.map((x) => (x == null ? NaN : x));
  const valid = nums.filter((x) => Number.isFinite(x));
  const n = valid.length;
  if (n === 0) return nums.map(() => 0);
  const mean = valid.reduce((s, x) => s + x, 0) / n;
  const varc = valid.reduce((s, x) => s + (x - mean) * (x - mean), 0) / n;
  const sd = Math.sqrt(varc);
  if (sd === 0) return nums.map(() => 0);
  return nums.map((x) => (Number.isFinite(x) ? (x - mean) / sd : NaN));
}

/**
 * Pearson correlation of two z-normalized arrays over their overlapping,
 * finite region only. Returns 0 when fewer than `minOverlap` valid pairs exist.
 */
function corr(a: number[], b: number[], minOverlap: number): number {
  let sum = 0;
  let count = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      sum += a[i] * b[i];
      count++;
    }
  }
  if (count < minOverlap) return 0;
  return sum / count;
}

/** Result of correlating a candidate against the target across lags. */
export interface LaggedCorrelation {
  /** Lag in bins that maximizes |correlation|. Positive = candidate leads target. */
  bestLag: number;
  /** Signed correlation at the best lag. */
  bestCorrelation: number;
  /** Correlation at each lag, from -maxLag..+maxLag. */
  byLag: { lag: number; correlation: number }[];
}

/**
 * Cross-correlate `candidate` against `target` for lags in [-maxLag, +maxLag].
 * A positive lag L means the candidate shifted forward by L bins best matches
 * the target, i.e. the candidate's movements precede (lead) the target's.
 */
export function laggedCrossCorrelation(
  target: (number | null)[],
  candidate: (number | null)[],
  maxLag: number,
): LaggedCorrelation {
  const zt = znorm(target);
  const zc = znorm(candidate);
  const n = zt.length;
  const minOverlap = Math.max(8, Math.floor(n * 0.25));
  const byLag: { lag: number; correlation: number }[] = [];
  let best = { lag: 0, correlation: 0 };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    // Shift candidate by `lag`: compare target[i] with candidate[i - lag].
    const shifted: number[] = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const j = i - lag;
      if (j >= 0 && j < n) shifted[i] = zc[j];
    }
    const c = corr(zt, shifted, minOverlap);
    byLag.push({ lag, correlation: c });
    if (Math.abs(c) > Math.abs(best.correlation)) best = { lag, correlation: c };
  }
  return { bestLag: best.lag, bestCorrelation: best.correlation, byLag };
}

/** A ranked candidate cause with its lead/lag relationship to the target. */
export interface CauseRanking {
  tagId: string;
  /** Signed correlation at the best lag. */
  correlation: number;
  /** Best lag in bins (positive = leads the target). */
  lagBins: number;
  /** Best lag in seconds (lagBins × binSeconds). */
  lagSeconds: number;
  /** True when the candidate leads the target (plausible driver). */
  leads: boolean;
  /** 0..1 strength = |correlation|. */
  strength: number;
}

/**
 * Rank candidate drivers against the target by lagged cross-correlation.
 * Candidates that lead the target and correlate strongly rank highest.
 */
export function rankCauses(
  targetSeries: (number | null)[],
  candidates: AlignedSeries[],
  maxLag: number,
  binSeconds: number,
): CauseRanking[] {
  return candidates
    .map((c) => {
      const lc = laggedCrossCorrelation(targetSeries, c.v, maxLag);
      return {
        tagId: c.tagId,
        correlation: lc.bestCorrelation,
        lagBins: lc.bestLag,
        lagSeconds: lc.bestLag * binSeconds,
        leads: lc.bestLag > 0,
        strength: Math.abs(lc.bestCorrelation),
      } satisfies CauseRanking;
    })
    .sort((a, b) => {
      // Leading causes first, then by strength.
      if (a.leads !== b.leads) return a.leads ? -1 : 1;
      return b.strength - a.strength;
    });
}

/** A directed edge in the root-cause propagation graph. */
export interface CauseEdge {
  source: string;
  target: string;
  correlation: number;
  lagSeconds: number;
}

/**
 * Build directed edges (candidate → target) for the root-cause graph. Only
 * meaningfully-correlated candidates (|corr| ≥ threshold) are included.
 */
export function buildCauseEdges(
  targetTagId: string,
  causes: CauseRanking[],
  threshold = 0.3,
): CauseEdge[] {
  return causes
    .filter((c) => c.strength >= threshold)
    .map((c) => ({
      source: c.tagId,
      target: targetTagId,
      correlation: c.correlation,
      lagSeconds: c.lagSeconds,
    }));
}

/** Human-readable propagation order: leading drivers first, by lead time. */
export function propagationOrder(causes: CauseRanking[]): CauseRanking[] {
  return [...causes]
    .filter((c) => c.leads && c.strength >= 0.3)
    .sort((a, b) => b.lagSeconds - a.lagSeconds);
}
