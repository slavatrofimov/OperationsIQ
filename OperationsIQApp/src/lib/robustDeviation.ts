/**
 * Robust deviation monitoring backed by KQL `series_outliers` (Tukey's fences).
 *
 * The seasonal Monitor path ({@link ./deviation.computeDeviation}) treats the
 * trend+seasonal decomposition baseline as "expected" and sizes a ±z·σ band from
 * the residual standard deviation. That assumes a periodic/decomposable signal.
 *
 * This robust path makes no seasonal assumption. `series_outliers` scores each
 * bin with Tukey's test (>1.5 = rise anomaly, <-1.5 = decline anomaly). We treat
 * the series median as the flat expected value and draw the Tukey whisker
 * envelope — the most extreme non-outlier value on each side — as the normal
 * band, so every bin the scorer flags sits outside the band and vice-versa.
 * Contiguous flagged bins are grouped into the same {@link Breach} runs the
 * seasonal path produces, so the Monitor page renders both modes identically.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';
import type { Breach, DeviationResult } from './deviation';

/** Default Tukey score threshold: |score| above this is an outlier. */
export const DEFAULT_TUKEY_THRESHOLD = 1.5;

/** One tag's binned series plus its per-bin Tukey outlier scores. */
export interface RobustSeries {
  tagId: string;
  /** X values as unix seconds. */
  x: number[];
  values: (number | null)[];
  /** series_outliers score per bin (sign carries direction). */
  scores: (number | null)[];
}

interface RobustRow {
  SignalId: string;
  Timestamp: string[];
  Value: (number | null)[];
  AnomalyScore: (number | null)[];
}

/** Parse the single-row {@link buildRobustOutliersQuery} result into a series. */
export function parseRobustSeries(table: KustoTable): RobustSeries | null {
  const r = rowsToObjects<RobustRow>(table)[0];
  if (!r) return null;
  const x = (r.Timestamp ?? []).map((t) => new Date(t).getTime() / 1000);
  const values = (r.Value ?? []).map((v) => (v == null ? null : Number(v)));
  const scores = (r.AnomalyScore ?? []).map((v) => (v == null ? null : Number(v)));
  return { tagId: r.SignalId, x, values, scores };
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute a {@link DeviationResult} from robust Tukey scores. `expected` is the
 * flat median; the band is the Tukey whisker envelope (extreme non-outlier value
 * on each side). A bin is out of band when |score| exceeds `threshold`.
 */
export function computeRobustDeviation(
  series: RobustSeries,
  threshold = DEFAULT_TUKEY_THRESHOLD,
): DeviationResult {
  const n = series.x.length;
  const { values, scores } = series;

  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  const med = median([...finite].sort((a, b) => a - b));

  // Direction-aware outlier flags from the Tukey score.
  const highOut: boolean[] = new Array(n).fill(false);
  const lowOut: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const s = scores[i];
    if (s == null || !Number.isFinite(s)) continue;
    if (s > threshold) highOut[i] = true;
    else if (s < -threshold) lowOut[i] = true;
  }

  // Whisker envelope: the most extreme value that is NOT flagged on that side.
  let upperFence = Number.NEGATIVE_INFINITY;
  let lowerFence = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (!highOut[i] && v > upperFence) upperFence = v;
    if (!lowOut[i] && v < lowerFence) lowerFence = v;
  }
  if (!Number.isFinite(upperFence)) upperFence = finite.length ? Math.max(...finite) : med;
  if (!Number.isFinite(lowerFence)) lowerFence = finite.length ? Math.min(...finite) : med;

  const x = series.x.map((s) => s * 1000);
  const expected: (number | null)[] = new Array(n).fill(med);
  const lower: (number | null)[] = new Array(n).fill(lowerFence);
  const upper: (number | null)[] = new Array(n).fill(upperFence);
  const outFlags: boolean[] = new Array(n).fill(false);

  let evaluated = 0;
  let inBand = 0;
  let maxAbsDeviation = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    evaluated++;
    const dev = Math.abs(v - med);
    if (dev > maxAbsDeviation) maxAbsDeviation = dev;
    const out = highOut[i] || lowOut[i];
    outFlags[i] = out;
    if (!out) inBand++;
  }

  // Group contiguous out-of-band bins into breach runs (mirrors computeDeviation).
  const breaches: Breach[] = [];
  let runStart = -1;
  const flushRun = (endIdx: number) => {
    if (runStart < 0) return;
    let peakIdx = runStart;
    let peakAbs = -1;
    for (let k = runStart; k <= endIdx; k++) {
      const v = values[k];
      if (v != null && Number.isFinite(v)) {
        const abs = Math.abs(v - med);
        if (abs > peakAbs) {
          peakAbs = abs;
          peakIdx = k;
        }
      }
    }
    const pv = values[peakIdx] as number;
    const dev = pv - med;
    breaches.push({
      startIndex: runStart,
      endIndex: endIdx,
      startMs: x[runStart],
      endMs: x[endIdx],
      peakDeviation: dev,
      peakValue: pv,
      direction: dev >= 0 ? 'high' : 'low',
    });
    runStart = -1;
  };
  for (let i = 0; i < n; i++) {
    if (outFlags[i]) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      flushRun(i - 1);
    }
  }
  if (runStart >= 0) flushRun(n - 1);

  return {
    tagId: series.tagId,
    x,
    actual: values,
    expected,
    lower,
    upper,
    // No σ/z in the robust model; expose the half-envelope so the "Band ±" KPI
    // still reads a meaningful width (z=1, sigma=half the whisker span).
    sigma: (upperFence - lowerFence) / 2,
    z: 1,
    breaches,
    pctInBand: evaluated > 0 ? inBand / evaluated : 1,
    maxAbsDeviation,
    evaluated,
  };
}
