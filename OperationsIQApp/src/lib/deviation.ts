/**
 * Deviation (expected-vs-actual) monitoring. The decomposition baseline
 * (trend+seasonal fit) from `series_decompose_anomalies` is treated as the
 * expected value; a band of ±z·σ around it — where σ is the in-sample residual
 * standard deviation — defines the normal envelope. Bins whose actual value
 * falls outside the band are flagged as breaches and grouped into contiguous
 * runs, along with summary KPIs.
 */
import { zForConfidence } from './forecast';
import type { ExploreSeries } from './series';

/** One contiguous run of out-of-band bins. */
export interface Breach {
  startIndex: number;
  endIndex: number;
  startMs: number;
  endMs: number;
  /** Signed deviation (actual − expected) at the most extreme bin in the run. */
  peakDeviation: number;
  /** Actual value at the most extreme bin. */
  peakValue: number;
  /** 'high' when the peak actual is above the band, 'low' when below. */
  direction: 'high' | 'low';
}

export interface DeviationResult {
  tagId: string;
  /** X values as unix ms. */
  x: number[];
  actual: (number | null)[];
  expected: (number | null)[];
  lower: (number | null)[];
  upper: (number | null)[];
  /** In-sample residual standard deviation used to size the band. */
  sigma: number;
  /** Confidence-derived z-multiplier applied to σ. */
  z: number;
  breaches: Breach[];
  /** Fraction of evaluated bins whose actual sits inside the band (0–1). */
  pctInBand: number;
  /** Largest absolute (actual − expected) over evaluated bins. */
  maxAbsDeviation: number;
  /** Count of bins with both an actual and an expected value. */
  evaluated: number;
}

/**
 * Compute the expected band and breach runs for one explore series. The series
 * must carry a `baseline` (from the anomaly decomposition); when it is missing
 * the band collapses onto the actual and no breaches are reported.
 */
export function computeDeviation(series: ExploreSeries, confidence: number): DeviationResult {
  const n = series.x.length;
  const z = zForConfidence(confidence);
  const actual = series.values;
  const expected = series.baseline ?? [];

  // In-sample residual standard deviation (population, over finite pairs).
  let sum = 0;
  let sumSq = 0;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const e = expected[i];
    if (a != null && e != null && Number.isFinite(a) && Number.isFinite(e)) {
      const r = a - e;
      sum += r;
      sumSq += r * r;
      m++;
    }
  }
  const mean = m > 0 ? sum / m : 0;
  const variance = m > 1 ? Math.max(0, sumSq / m - mean * mean) : 0;
  const sigma = Math.sqrt(variance);
  const halfWidth = z * sigma;

  const x = series.x.map((s) => s * 1000);
  const lower: (number | null)[] = new Array(n).fill(null);
  const upper: (number | null)[] = new Array(n).fill(null);
  const outFlags: boolean[] = new Array(n).fill(false);

  let evaluated = 0;
  let inBand = 0;
  let maxAbsDeviation = 0;

  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const e = expected[i];
    if (e != null && Number.isFinite(e)) {
      lower[i] = e - halfWidth;
      upper[i] = e + halfWidth;
    }
    if (a != null && e != null && Number.isFinite(a) && Number.isFinite(e)) {
      evaluated++;
      const dev = a - e;
      if (Math.abs(dev) > maxAbsDeviation) maxAbsDeviation = Math.abs(dev);
      const out = Math.abs(dev) > halfWidth;
      outFlags[i] = out;
      if (!out) inBand++;
    }
  }

  // Group contiguous out-of-band bins into breach runs.
  const breaches: Breach[] = [];
  let runStart = -1;
  const flushRun = (endIdx: number) => {
    if (runStart < 0) return;
    let peakIdx = runStart;
    let peakAbs = -1;
    for (let k = runStart; k <= endIdx; k++) {
      const a = actual[k];
      const e = expected[k];
      if (a != null && e != null) {
        const abs = Math.abs(a - e);
        if (abs > peakAbs) {
          peakAbs = abs;
          peakIdx = k;
        }
      }
    }
    const pa = actual[peakIdx] as number;
    const pe = expected[peakIdx] as number;
    const dev = pa - pe;
    breaches.push({
      startIndex: runStart,
      endIndex: endIdx,
      startMs: x[runStart],
      endMs: x[endIdx],
      peakDeviation: dev,
      peakValue: pa,
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
    actual,
    expected,
    lower,
    upper,
    sigma,
    z,
    breaches,
    pctInBand: evaluated > 0 ? inBand / evaluated : 1,
    maxAbsDeviation,
    evaluated,
  };
}
