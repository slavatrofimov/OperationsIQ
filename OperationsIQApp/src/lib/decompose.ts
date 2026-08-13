/**
 * Signal decomposition helpers (functional spec §Decomposition workspace).
 *
 * `series_decompose` splits a signal into interpretable components:
 *   - Baseline  = trend + seasonal (the "expected" pattern)
 *   - Trend     = slow-moving level (linear fit here)
 *   - Seasonal  = repeating cycle
 *   - Residual  = what's left after removing the baseline (the anomaly signal)
 *
 * The 4-panel view lets an engineer see *why* a value is unusual: a residual
 * spike with a flat trend is a transient; a rising trend is drift.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';

export interface Decomposition {
  tagId: string;
  /** Unix ms timestamps. */
  t: number[];
  value: (number | null)[];
  baseline: (number | null)[];
  trend: (number | null)[];
  seasonal: (number | null)[];
  residual: (number | null)[];
}

function toNums(a: unknown): (number | null)[] {
  return ((a as (number | null)[]) ?? []).map((x) => (x == null ? null : Number(x)));
}

/** Parse the single-row decomposition KQL result into parallel arrays. */
export function parseDecomposition(table: KustoTable): Decomposition | null {
  const rows = rowsToObjects<{
    SignalId: string;
    Timestamp: string[];
    Value: (number | null)[];
    Baseline: (number | null)[];
    Trend: (number | null)[];
    Seasonal: (number | null)[];
    Residual: (number | null)[];
  }>(table);
  const r = rows[0];
  if (!r) return null;
  return {
    tagId: r.SignalId,
    t: (r.Timestamp ?? []).map((x) => new Date(x).getTime()),
    value: toNums(r.Value),
    baseline: toNums(r.Baseline),
    trend: toNums(r.Trend),
    seasonal: toNums(r.Seasonal),
    residual: toNums(r.Residual),
  };
}

/** Summary stats over the residual for a quick read on decomposition quality. */
export interface ResidualStats {
  /** Fraction of variance explained by the baseline (1 - var(resid)/var(value)). */
  varianceExplained: number;
  residualStdDev: number;
  /** Largest absolute residual, expressed in residual standard deviations. */
  maxResidualZ: number;
}

export function residualStats(d: Decomposition): ResidualStats {
  const val = d.value.filter((x): x is number => x != null && Number.isFinite(x));
  const res = d.residual.filter((x): x is number => x != null && Number.isFinite(x));
  const variance = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
  };
  const vVal = variance(val);
  const vRes = variance(res);
  const sd = Math.sqrt(vRes);
  const maxAbs = res.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  return {
    varianceExplained: vVal > 0 ? Math.max(0, 1 - vRes / vVal) : 0,
    residualStdDev: sd,
    maxResidualZ: sd > 0 ? maxAbs / sd : 0,
  };
}
