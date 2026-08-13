/**
 * Client-side descriptive statistics and Pearson correlation, computed from the
 * already-fetched detail series. Nulls (gaps) are ignored per series; pairwise
 * correlation uses only bins where both series have a value.
 */

export interface SeriesStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  stdev: number;
  p05: number;
  p95: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Descriptive stats for one series; NaN-filled fields when there is no data. */
export function computeStats(values: (number | null)[]): SeriesStats {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  const n = nums.length;
  if (n === 0) {
    return { count: 0, min: NaN, max: NaN, mean: NaN, median: NaN, stdev: NaN, p05: NaN, p95: NaN };
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1 ? nums.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median: percentile(sorted, 0.5),
    stdev: Math.sqrt(variance),
    p05: percentile(sorted, 0.05),
    p95: percentile(sorted, 0.95),
  };
}

/**
 * Pearson correlation over the bins where BOTH series have a finite value.
 * Returns NaN when fewer than two overlapping points exist or either series is
 * constant.
 */
export function pearson(a: (number | null)[], b: (number | null)[]): number {
  const n = Math.min(a.length, b.length);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  const m = xs.length;
  if (m < 2) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / m;
  const my = ys.reduce((s, v) => s + v, 0) / m;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < m; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

/** A single lag/correlation sample for a cross-correlation function. */
export interface LagCorrelation {
  /** Lag in bins. Positive means A leads B (B shifted forward to align). */
  lag: number;
  /** Pearson correlation at this lag, or NaN when too few overlapping points. */
  r: number;
}

/**
 * Cross-correlation of two aligned series over integer lags in
 * [-maxLag, +maxLag]. At lag L the correlation is pearson(a[i], b[i + L]),
 * so a positive peak lag means series A leads series B by that many bins.
 */
export function crossCorrelation(
  a: (number | null)[],
  b: (number | null)[],
  maxLag: number,
): LagCorrelation[] {
  const n = Math.min(a.length, b.length);
  const lim = Math.max(0, Math.min(Math.floor(maxLag), n - 1));
  const out: LagCorrelation[] = [];
  for (let lag = -lim; lag <= lim; lag++) {
    const xs: (number | null)[] = [];
    const ys: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n) continue;
      xs.push(a[i]);
      ys.push(b[j]);
    }
    out.push({ lag, r: pearson(xs, ys) });
  }
  return out;
}

/** Lag with the largest absolute correlation, plus its r. Null when no data. */
export function bestLag(cc: LagCorrelation[]): LagCorrelation | null {
  let best: LagCorrelation | null = null;
  for (const c of cc) {
    if (!Number.isFinite(c.r)) continue;
    if (best == null || Math.abs(c.r) > Math.abs(best.r)) best = c;
  }
  return best;
}

/**
 * Aligned finite (x, y) pairs from two index-aligned series — the sample set a
 * pairwise scatter plot renders. Optionally downsampled to at most `maxPoints`.
 */
export function scatterPairs(
  x: (number | null)[],
  y: (number | null)[],
  maxPoints = 3000,
): [number, number][] {
  const n = Math.min(x.length, y.length);
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const xv = x[i];
    const yv = y[i];
    if (xv != null && yv != null && Number.isFinite(xv) && Number.isFinite(yv)) {
      pairs.push([xv, yv]);
    }
  }
  if (pairs.length <= maxPoints) return pairs;
  const step = Math.ceil(pairs.length / maxPoints);
  const out: [number, number][] = [];
  for (let i = 0; i < pairs.length; i += step) out.push(pairs[i]);
  return out;
}

/** Symmetric Pearson correlation matrix for a set of series (row/col aligned). */
export function correlationMatrix(seriesValues: (number | null)[][]): number[][] {
  const k = seriesValues.length;
  const m: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(NaN));
  for (let i = 0; i < k; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < k; j++) {
      const r = pearson(seriesValues[i], seriesValues[j]);
      m[i][j] = r;
      m[j][i] = r;
    }
  }
  return m;
}

/** Extract finite numeric values (dropping gaps/NaN) from a nullable series. */
function finiteValues(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v != null && Number.isFinite(v));
}

/** A histogram bin: half-open interval [lo, hi) with a sample count. */
export interface HistogramBin {
  lo: number;
  hi: number;
  count: number;
}

/**
 * Equal-width histogram over the finite values of a series. Returns an empty
 * array when there is no data. A constant series yields a single bin.
 */
export function histogram(values: (number | null)[], binCount = 30): HistogramBin[] {
  const nums = finiteValues(values);
  if (nums.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of nums) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return [{ lo: min, hi: max, count: nums.length }];
  const bins = Math.max(1, Math.floor(binCount));
  const width = (max - min) / bins;
  const out: HistogramBin[] = Array.from({ length: bins }, (_, i) => ({
    lo: min + i * width,
    hi: min + (i + 1) * width,
    count: 0,
  }));
  for (const v of nums) {
    // Clamp the top edge into the last bin (half-open [lo, hi), last is closed).
    const idx = Math.min(bins - 1, Math.floor((v - min) / width));
    out[idx].count++;
  }
  return out;
}

/** Five-number summary plus Tukey-fence whiskers and outliers for a box plot. */
export interface BoxSummary {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  /** Lower whisker: smallest value >= q1 - 1.5*IQR. */
  whiskerLow: number;
  /** Upper whisker: largest value <= q3 + 1.5*IQR. */
  whiskerHigh: number;
  /** Values beyond the whiskers. */
  outliers: number[];
}

/** Quartiles + Tukey whiskers/outliers over a series' finite values. */
export function boxSummary(values: (number | null)[]): BoxSummary | null {
  const nums = finiteValues(values);
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const median = percentile(sorted, 0.5);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  let whiskerLow = sorted[sorted.length - 1];
  let whiskerHigh = sorted[0];
  const outliers: number[] = [];
  for (const v of sorted) {
    if (v < loFence || v > hiFence) outliers.push(v);
    else {
      if (v < whiskerLow) whiskerLow = v;
      if (v > whiskerHigh) whiskerHigh = v;
    }
  }
  return {
    min: sorted[0],
    q1,
    median,
    q3,
    max: sorted[sorted.length - 1],
    whiskerLow,
    whiskerHigh,
    outliers,
  };
}

/** A point on a duration (load-duration) curve: value at a % of time. */
export interface DurationPoint {
  /** Percent of time (0-100) the series is at or above `value`. */
  percent: number;
  value: number;
}

/**
 * Load-duration curve: finite values sorted descending, x-axis is the fraction
 * of time (0-100%) the series spends at or above each level. Optionally
 * downsampled to at most `maxPoints` for rendering.
 */
export function durationCurve(values: (number | null)[], maxPoints = 500): DurationPoint[] {
  const nums = finiteValues(values);
  const n = nums.length;
  if (n === 0) return [];
  const sorted = [...nums].sort((a, b) => b - a);
  const step = n > maxPoints ? Math.ceil(n / maxPoints) : 1;
  const out: DurationPoint[] = [];
  for (let i = 0; i < n; i += step) {
    out.push({ percent: ((i + 1) / n) * 100, value: sorted[i] });
  }
  // Always include the final (minimum) point at 100%.
  if (out.length === 0 || out[out.length - 1].percent < 100) {
    out.push({ percent: 100, value: sorted[n - 1] });
  }
  return out;
}
