/**
 * Parse the forecast query result and build a horizon-widening prediction
 * interval on the client. `series_decompose_forecast` gives the point forecast;
 * the band is derived from the in-sample residuals. When enough finite residual
 * samples are available (>= {@link MIN_RESIDUALS}) the band uses their EMPIRICAL,
 * asymmetric (fat-tail-aware) quantiles scaled by sqrt(steps-ahead); otherwise it
 * falls back to the normal residual standard deviation widened by sqrt(steps),
 * under the usual random-walk error-accumulation assumption.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';

/**
 * Minimum number of finite history residuals required to build an EMPIRICAL
 * (asymmetric, fat-tail-aware) prediction band. Below this count the client
 * falls back to the exact normal path (`zForConfidence(c)·σ·√steps`), so
 * sparse-history forecasts are unchanged.
 */
export const MIN_RESIDUALS = 20;

/**
 * Minimum number of honest (non-circular, contiguous) residual windows required
 * to estimate the aggregate any-breach probability from an ensemble of
 * residual-based cumulative error trajectories. Below this count the aggregate
 * falls back to the per-bin independence product.
 */
export const MIN_TRAJECTORIES = 20;

/**
 * Minimum per-horizon fold count required before a MEASURED (rolling-origin
 * backtest) prediction band is trusted. When any horizon step has fewer than
 * this many out-of-sample folds the caller keeps the in-sample empirical/normal
 * band instead.
 */
export const MIN_BACKTEST_FOLDS = 20;

interface ForecastRow {
  SignalId: string;
  Timestamp: string[];
  Value: (number | null)[];
  ModelValue: (number | null)[];
  Forecast: (number | null)[];
  Sigma: number | null;
  Residuals: (number | null)[];
  HorizonPoints: number;
  Cnt?: (number | null)[];
}

/** Parsed forecast with a prediction interval, ready for charting. */
export interface ForecastResult {
  tagId: string;
  /** X values as unix ms (full extended axis: history + horizon). */
  x: number[];
  /** Observed values only; null where a history bin had no samples, null over the forecast horizon. */
  actual: (number | null)[];
  /** Linearly-filled series fed to the model; used to distinctly chart imputed spans. */
  modelInput: (number | null)[];
  /** True where a HISTORY bin was imputed (Cnt==0 and i<forecastStart); false elsewhere (incl. horizon). */
  imputed: boolean[];
  /** Point forecast; null over the in-sample (historical) region. */
  forecast: (number | null)[];
  /** Lower prediction bound; null in-sample. */
  lower: (number | null)[];
  /** Upper prediction bound; null in-sample. */
  upper: (number | null)[];
  /** Index of the first forecast point (== count of historical bins). */
  forecastStart: number;
  /** In-sample residual standard deviation used to size the band. */
  sigma: number;
  /** Finite history residuals (observed − fitted) driving the empirical band. */
  residuals: number[];
  /**
   * Which distribution shaped the band: `empirical` when there were at least
   * {@link MIN_RESIDUALS} finite residuals (asymmetric quantiles), otherwise the
   * `normal` fallback (`zForConfidence(c)·σ·√steps`).
   */
  calibration: { method: 'backtest' | 'empirical' | 'normal'; sampleCount: number };
  /** Per-horizon out-of-sample error calibration from a rolling backtest, present only when a measured (backtest) band was applied. */
  horizonCalibration?: HorizonErrorCalibration;
  /** Present when the Run action compared raw vs outlier-cleaned model inputs via backtest (A2). Indicates which input produced this forecast and the RMSE evidence. */
  modelSelection?: ModelSelection;
  /** Present when the Run action compared the full vs a shorter recent-regime history window via backtest (A4). */
  windowSelection?: WindowSelection;
  /** Data coverage across the history region, when the query returned bin counts. */
  coverage?: {
    historyBins: number;
    missingBins: number;
    missingFraction: number;
    /** Longest run of consecutive Cnt==0 bins within the history region. */
    longestGapBins: number;
    /** Consecutive Cnt==0 bins at the END of history (bins since the last real observation). */
    trailingStaleBins: number;
  };
}

/**
 * Map a two-sided confidence level (e.g. 0.95) to a normal z-multiplier. For a
 * two-sided interval at confidence `c`, the half-width multiplier is the
 * upper-tail quantile `Phi^-1((1 + c) / 2)`, computed exactly via
 * {@link normalQuantile} (Acklam inverse-CDF, a function declaration below that
 * hoists safely). Confidence is clamped into an open (0,1) interval so the
 * quantile stays finite for extreme values (e.g. 0.999).
 */
export function zForConfidence(confidence: number): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, confidence));
  return normalQuantile((1 + c) / 2);
}

/**
 * Empirical quantile of an ascending-sorted sample via linear interpolation
 * between order statistics (the "type 7" / R default definition). `p` is clamped
 * to [0,1]. Returns 0 for an empty sample and the single value for length 1.
 * Pure and separately unit-tested; used to build asymmetric, fat-tail-aware
 * prediction bands from the in-sample residual distribution.
 */
export function empiricalQuantile(sortedAsc: number[], p: number): number {
  const len = sortedAsc.length;
  if (len === 0) return 0;
  if (len === 1) return sortedAsc[0];
  const clamped = Math.min(1, Math.max(0, p));
  const pos = clamped * (len - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

/**
 * Parse a single-row forecast table into charting arrays and compute the
 * prediction interval at the given confidence. History keeps `actual` and
 * blanks the forecast/band; the horizon blanks `actual` and fills the rest.
 */
export function parseForecastResult(table: KustoTable, confidence: number): ForecastResult | null {
  const rows = rowsToObjects<ForecastRow>(table);
  if (rows.length === 0) return null;
  const o = rows[0];
  const x = (o.Timestamp ?? []).map((t) => new Date(t).getTime());
  const rawActual = (o.Value ?? []).map((v) => (v == null ? null : Number(v)));
  const rawModel = (o.ModelValue ?? []).map((v) => (v == null ? null : Number(v)));
  const rawForecast = (o.Forecast ?? []).map((v) => (v == null ? null : Number(v)));
  const n = x.length;
  const horizon = Math.max(0, Math.min(n, Math.floor(o.HorizonPoints ?? 0)));
  const forecastStart = Math.max(0, n - horizon);
  const sigma = o.Sigma != null && Number.isFinite(o.Sigma) ? Number(o.Sigma) : 0;
  const z = zForConfidence(confidence);
  const c = Math.min(1 - 1e-6, Math.max(1e-6, confidence));
  // Empirical calibration inputs: finite history residuals only. A sorted copy
  // powers asymmetric quantiles; the band switches to empirical once there are
  // enough samples, else falls back to the exact normal path.
  const residuals = (Array.isArray(o.Residuals) ? o.Residuals : [])
    .map((v) => (v == null ? NaN : Number(v)))
    .filter((v) => Number.isFinite(v));
  const sortedResiduals = [...residuals].sort((a, b) => a - b);
  const method: 'empirical' | 'normal' =
    residuals.length >= MIN_RESIDUALS ? 'empirical' : 'normal';
  const qLo = empiricalQuantile(sortedResiduals, (1 - c) / 2);
  const qHi = empiricalQuantile(sortedResiduals, (1 + c) / 2);
  const counts = Array.isArray(o.Cnt) ? o.Cnt : undefined;
  const isMissing = (i: number) => (counts ? Number(counts[i] ?? 0) === 0 : false);

  let coverage: ForecastResult['coverage'];
  if (counts) {
    const historyCounts = counts.slice(0, forecastStart);
    const missingBins = historyCounts.filter((v) => Number(v ?? 0) === 0).length;
    // Longest run of consecutive Cnt==0 bins in the history region.
    let longestGapBins = 0;
    let run = 0;
    for (const c of historyCounts) {
      if (Number(c ?? 0) === 0) {
        run += 1;
        if (run > longestGapBins) longestGapBins = run;
      } else {
        run = 0;
      }
    }
    // Trailing gap: consecutive Cnt==0 bins at the END of history (staleness).
    let trailingStaleBins = 0;
    for (let i = forecastStart - 1; i >= 0; i--) {
      if (Number(counts[i] ?? 0) === 0) trailingStaleBins += 1;
      else break;
    }
    coverage = {
      historyBins: forecastStart,
      missingBins,
      missingFraction: forecastStart > 0 ? missingBins / forecastStart : 0,
      longestGapBins,
      trailingStaleBins,
    };
  }

  const actual: (number | null)[] = new Array(n).fill(null);
  const modelInput: (number | null)[] = new Array(n).fill(null);
  const imputed: boolean[] = new Array(n).fill(false);
  const forecast: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  const upper: (number | null)[] = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    modelInput[i] = rawModel[i] ?? null;
    if (i < forecastStart) {
      if (isMissing(i)) {
        // Force imputed history bins to null so no stray observed value leaks in.
        actual[i] = null;
        imputed[i] = true;
      } else {
        actual[i] = rawActual[i] ?? null;
      }
    } else {
      const f = rawForecast[i] ?? null;
      forecast[i] = f;
      if (f != null) {
        // Steps ahead: 1 at the first forecast bin, growing across the horizon.
        const stepsAhead = i - forecastStart + 1;
        const grow = Math.sqrt(stepsAhead);
        if (method === 'empirical') {
          // Asymmetric empirical residual quantiles scaled by sqrt(steps).
          lower[i] = f + qLo * grow;
          upper[i] = f + qHi * grow;
        } else {
          // Normal fallback: symmetric band f ± z·σ·√steps (unchanged).
          const halfWidth = z * sigma * grow;
          lower[i] = f - halfWidth;
          upper[i] = f + halfWidth;
        }
      }
    }
  }
  // Bridge the join: repeat the last OBSERVED point as the forecast anchor so
  // the forecast line visually connects to history instead of floating. Search
  // backward for the last non-null observed value, since a trailing gap can
  // leave actual[forecastStart-1] null.
  if (forecastStart > 0 && forecastStart < n) {
    let lastObserved: number | null = null;
    for (let i = forecastStart - 1; i >= 0; i--) {
      if (actual[i] != null) {
        lastObserved = actual[i];
        break;
      }
    }
    if (lastObserved != null) {
      forecast[forecastStart - 1] = lastObserved;
      lower[forecastStart - 1] = lastObserved;
      upper[forecastStart - 1] = lastObserved;
    }
  }

  return {
    tagId: o.SignalId,
    x,
    actual,
    modelInput,
    imputed,
    forecast,
    lower,
    upper,
    forecastStart,
    sigma,
    residuals,
    calibration: { method, sampleCount: residuals.length },
    coverage,
  };
}

/**
 * Post-hoc: replace the in-sample prediction band on a parsed forecast with one
 * built from MEASURED out-of-sample per-horizon errors from a rolling-origin
 * backtest ({@link parseBacktestResult}). The point forecast is untouched; only
 * lower/upper, calibration.method ('backtest') and horizonCalibration change.
 * Returns the input result UNCHANGED when the backtest does not cover the whole
 * horizon or any horizon step has fewer than {@link MIN_BACKTEST_FOLDS} folds, so
 * the caller keeps the existing empirical/normal band. Measured errors are
 * actual - forecast (asymmetric, bias-aware): the band is f + errorQuantile, with
 * NO sqrt(steps) scaling since per-horizon spread is measured directly.
 */
export function applyMeasuredBands(
  result: ForecastResult,
  calibration: HorizonErrorCalibration,
  confidence: number,
): ForecastResult {
  const horizon = result.x.length - result.forecastStart;
  const usable =
    horizon > 0 &&
    calibration.horizonPoints >= horizon &&
    calibration.foldsPerHorizon.slice(0, horizon).every((k) => k >= MIN_BACKTEST_FOLDS);
  if (!usable) return result;
  const c = Math.min(1 - 1e-6, Math.max(1e-6, confidence));
  const lower = [...result.lower];
  const upper = [...result.upper];
  for (let i = result.forecastStart; i < result.x.length; i++) {
    const f = result.forecast[i];
    if (f == null) continue;
    const stepsAhead = i - result.forecastStart + 1;
    const samples = calibration.perHorizonErrors[stepsAhead - 1] ?? [];
    lower[i] = f + horizonErrorQuantile(samples, (1 - c) / 2);
    upper[i] = f + horizonErrorQuantile(samples, (1 + c) / 2);
  }
  // Re-anchor the join point to the forecast anchor (unchanged value).
  if (result.forecastStart > 0 && result.forecast[result.forecastStart - 1] != null) {
    const anchor = result.forecast[result.forecastStart - 1];
    lower[result.forecastStart - 1] = anchor;
    upper[result.forecastStart - 1] = anchor;
  }
  const sampleCount = Math.min(...calibration.foldsPerHorizon.slice(0, horizon));
  return {
    ...result,
    lower,
    upper,
    horizonCalibration: calibration,
    calibration: { method: 'backtest', sampleCount },
  };
}

/**
 * Nuance-preserving sampler: per bucket, keep the min and max non-null value
 * indices, plus the first and last index. Returned indices are sorted and unique.
 */
export function downsampleMinMax(
  x: number[],
  values: (number | null)[],
  buckets: number,
): number[] {
  const n = Math.min(x.length, values.length);
  if (n === 0) return [];

  const selected = new Set<number>([0, n - 1]);
  const bucketCount = Math.max(1, Math.min(n, Math.floor(buckets)));
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor((b * n) / bucketCount);
    const end = Math.floor(((b + 1) * n) / bucketCount);
    let minIdx = -1;
    let maxIdx = -1;
    let min = Infinity;
    let max = -Infinity;

    for (let i = start; i < end; i++) {
      const v = values[i];
      if (v == null || !Number.isFinite(v)) continue;
      if (v < min) {
        min = v;
        minIdx = i;
      }
      if (v > max) {
        max = v;
        maxIdx = i;
      }
    }

    if (minIdx >= 0) selected.add(minIdx);
    if (maxIdx >= 0) selected.add(maxIdx);
  }

  return [...selected].sort((a, b) => a - b);
}

// --- rolling-origin backtest calibration (B3a) ------------------------------

export interface BacktestPlan {
  historyPoints: number;
  foldStep: number;
  folds: number;
  feasible: boolean;
}

/** Clamp `v` into the inclusive [lo, hi] range (returns lo when lo > hi). */
function clampInt(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Pick the fit window (L) and origin spacing (S) for a rolling-origin backtest
 * from the number of available history bins (M) and the forecast horizon (H).
 * Pure and unit-testable — it never touches the network. The goal is roughly
 * `targetFolds` evenly-spaced folds while keeping each fold's fit window at least
 * `minHistory` bins. When even the minimum-history configuration cannot fit
 * `minFolds` folds the plan is returned with `feasible: false` (folds may be 0)
 * so the caller can skip the backtest and fall back to the in-sample band. All
 * divisions are guarded so the result is never NaN or negative.
 */
export function planBacktest(
  historyBins: number,
  horizonPoints: number,
  opts?: { targetFolds?: number; minFolds?: number; minHistory?: number },
): BacktestPlan {
  const M = Math.max(0, Math.floor(historyBins));
  const H = Math.max(1, Math.floor(horizonPoints));
  const targetFolds = Math.max(1, Math.floor(opts?.targetFolds ?? 30));
  const minFolds = Math.max(1, Math.floor(opts?.minFolds ?? 20));
  const minHistory = Math.max(1, Math.floor(opts?.minHistory ?? Math.max(2 * H, 24)));

  // Largest L that still leaves room for (minFolds - 1) additional origins after
  // the first: origins span [L, M - H], so we need (M - H) - L >= minFolds - 1.
  const maxL = M - H - (minFolds - 1);
  const L = clampInt(Math.round(M * 0.6), minHistory, maxL);

  // Cannot fit minFolds folds even at the minimum fit window, or the clamp
  // pushed L below the minimum history requirement => infeasible.
  if (M - H - minHistory < minFolds - 1 || L < minHistory) {
    return { historyPoints: Math.max(0, L), foldStep: 1, folds: 0, feasible: false };
  }

  const span = M - H - L; // number of origins beyond the first (>= 0 here)
  const foldStep = Math.max(1, Math.floor(span / Math.max(1, targetFolds - 1)));
  const folds = Math.floor(span / foldStep) + 1;
  return { historyPoints: L, foldStep, folds, feasible: folds >= minFolds };
}

/** Per-horizon out-of-sample forecast-error calibration from a rolling backtest. */
export interface HorizonErrorCalibration {
  /** Per-fold forecast errors (actual - forecast) indexed by horizon step: perHorizonErrors[h-1] = number[]. */
  perHorizonErrors: number[][];
  /** Fold count per horizon step (foldsPerHorizon[h-1]). */
  foldsPerHorizon: number[];
  horizonPoints: number;
}

interface BacktestRow {
  SignalId: string;
  h: number | string;
  Errors: (number | null)[];
  Folds: number | string;
}

/**
 * Parse the {@link buildBacktestQuery} result (one row per horizon step
 * `{ SignalId, h, Errors, Folds }`) into per-horizon error arrays. Rows are
 * sorted by `h` ascending and indexed by `h - 1`; each `Errors` element is
 * coerced to a number and non-finite values are dropped, so `foldsPerHorizon`
 * reflects the count of usable (finite) errors. `horizonPoints` is the maximum
 * `h`. An empty or missing table yields empty arrays and `horizonPoints: 0`.
 */
export function parseBacktestResult(table: KustoTable): HorizonErrorCalibration {
  const rows = rowsToObjects<BacktestRow>(table);
  if (rows.length === 0) {
    return { perHorizonErrors: [], foldsPerHorizon: [], horizonPoints: 0 };
  }
  const parsed = rows
    .map((r) => ({
      h: Math.floor(Number(r.h)),
      errors: (Array.isArray(r.Errors) ? r.Errors : [])
        .map((v) => (v == null ? NaN : Number(v)))
        .filter((v) => Number.isFinite(v)),
    }))
    .filter((r) => Number.isFinite(r.h) && r.h >= 1)
    .sort((a, b) => a.h - b.h);

  if (parsed.length === 0) {
    return { perHorizonErrors: [], foldsPerHorizon: [], horizonPoints: 0 };
  }

  const horizonPoints = parsed.reduce((max, r) => Math.max(max, r.h), 0);
  const perHorizonErrors: number[][] = Array.from({ length: horizonPoints }, () => []);
  const foldsPerHorizon: number[] = new Array(horizonPoints).fill(0);
  for (const r of parsed) {
    perHorizonErrors[r.h - 1] = r.errors;
    foldsPerHorizon[r.h - 1] = r.errors.length;
  }
  return { perHorizonErrors, foldsPerHorizon, horizonPoints };
}

/**
 * Empirical quantile `p` of an unsorted `samples` array of horizon errors. A thin
 * wrapper that sorts a copy and delegates to {@link empiricalQuantile}, so the
 * type-7 interpolation semantics are identical.
 */
export function horizonErrorQuantile(samples: number[], p: number): number {
  return empiricalQuantile([...samples].sort((a, b) => a - b), p);
}

/** Root-mean-square of ALL finite per-horizon out-of-sample errors pooled across every horizon step and fold. Returns NaN when there are no finite samples. */
export function pooledRmse(calibration: HorizonErrorCalibration): number {
  let sumSq = 0;
  let count = 0;
  for (const errs of calibration.perHorizonErrors) {
    for (const e of errs) {
      if (Number.isFinite(e)) {
        sumSq += e * e;
        count += 1;
      }
    }
  }
  return count > 0 ? Math.sqrt(sumSq / count) : NaN;
}

/** Minimum relative pooled-RMSE improvement the cleaned candidate must show over baseline before it is preferred (guards against churn/overfitting the selection to noise). */
export const OUTLIER_SELECTION_MARGIN = 0.02;

export type ForecastModelChoice = 'baseline' | 'cleaned';

/**
 * Choose between the raw baseline forecast and the outlier-cleaned candidate by
 * comparing their rolling-origin backtest pooled RMSE. The candidate is chosen
 * only when its pooled RMSE is at least `margin` (default {@link OUTLIER_SELECTION_MARGIN})
 * relatively lower than baseline; otherwise baseline is kept. Non-finite RMSE on
 * either side (e.g. an infeasible/empty backtest) yields 'baseline'.
 */
export function selectForecastModel(
  baseline: HorizonErrorCalibration,
  candidate: HorizonErrorCalibration,
  margin: number = OUTLIER_SELECTION_MARGIN,
): ForecastModelChoice {
  const rb = pooledRmse(baseline);
  const rc = pooledRmse(candidate);
  if (!Number.isFinite(rb) || !Number.isFinite(rc)) return 'baseline';
  return rc < rb * (1 - margin) ? 'cleaned' : 'baseline';
}

/** Outcome of the A2 raw-vs-outlier-cleaned model-input comparison from the rolling-origin backtest. */
export interface ModelSelection {
  choice: ForecastModelChoice;
  /** Pooled out-of-sample RMSE of the raw (baseline) model input. */
  baselineRmse: number;
  /** Pooled out-of-sample RMSE of the outlier-cleaned candidate. */
  cleanedRmse: number;
}

/** Human-readable one-line explanation of the raw-vs-outlier-cleaned model-input decision (A2). */
export function modelSelectionCaption(sel: ModelSelection): string {
  const improvePct =
    Number.isFinite(sel.baselineRmse) && sel.baselineRmse > 0
      ? ((sel.baselineRmse - sel.cleanedRmse) / sel.baselineRmse) * 100
      : 0;
  return sel.choice === 'cleaned'
    ? `Model input: outlier-cleaned (isolated spikes winsorized to the decomposition baseline). Chosen over raw because a rolling-origin backtest lowered pooled RMSE ${sel.baselineRmse.toFixed(4)} \u2192 ${sel.cleanedRmse.toFixed(4)} (${improvePct.toFixed(1)}% lower).`
    : `Model input: raw. Outlier-cleaning was tested but did not beat raw by the required margin (backtest pooled RMSE ${sel.cleanedRmse.toFixed(4)} vs raw ${sel.baselineRmse.toFixed(4)}).`;
}

/** Default fraction of the full history window used for the A4 recent-regime candidate. */
export const A4_RECENT_WINDOW_FRACTION = 0.5;

/**
 * Length (in bins) of the recent-regime candidate fit window, or null when a
 * shorter window is not worthwhile: it must be strictly shorter than the full
 * window AND long enough to fit and leave a fold (>= 2 * horizonPoints).
 */
export function recentWindowPoints(
  historyPoints: number,
  horizonPoints: number,
  fraction: number = A4_RECENT_WINDOW_FRACTION,
): number | null {
  const lp = Math.round(historyPoints * fraction);
  const minWin = Math.max(2 * horizonPoints, 1);
  return lp >= minWin && lp < historyPoints ? lp : null;
}

/** Outcome of the A4 full-vs-recent history-window comparison from the rolling-origin backtest. */
export interface WindowSelection {
  choice: 'full' | 'recent';
  /** Pooled out-of-sample RMSE of the full-window model. */
  fullRmse: number;
  /** Pooled out-of-sample RMSE of the recent-regime (shorter-window) candidate. */
  recentRmse: number;
  /** Length (bins) of the recent-regime fit window. */
  recentBins: number;
}

/**
 * Choose between the full history window and the shorter recent-regime candidate
 * by pooled backtest RMSE. Recent wins only when its pooled RMSE is at least
 * `margin` (default {@link OUTLIER_SELECTION_MARGIN}) relatively lower than the
 * full window; non-finite RMSE on either side yields 'full'.
 */
export function selectHistoryWindow(
  full: HorizonErrorCalibration,
  recent: HorizonErrorCalibration,
  margin: number = OUTLIER_SELECTION_MARGIN,
): 'full' | 'recent' {
  const rf = pooledRmse(full);
  const rr = pooledRmse(recent);
  if (!Number.isFinite(rf) || !Number.isFinite(rr)) return 'full';
  return rr < rf * (1 - margin) ? 'recent' : 'full';
}

/** Human-readable one-line explanation of the A4 history-window decision, or null when no recent-regime candidate was chosen. */
export function windowSelectionCaption(sel: WindowSelection): string | null {
  if (sel.choice !== 'recent') return null;
  const improvePct =
    Number.isFinite(sel.fullRmse) && sel.fullRmse > 0
      ? ((sel.fullRmse - sel.recentRmse) / sel.fullRmse) * 100
      : 0;
  return `History window: recent-regime (last ${sel.recentBins} bins). Chosen over the full window because a rolling-origin backtest lowered pooled RMSE ${sel.fullRmse.toFixed(4)} \u2192 ${sel.recentRmse.toFixed(4)} (${improvePct.toFixed(1)}% lower).`;
}

// --- probabilistic enrichment (functional spec §Probabilistic forecast) -----

/**
 * Standard normal quantile function (inverse CDF) via the Acklam rational
 * approximation. Maps a probability p in (0,1) to a z-score. Used to build
 * arbitrary percentile bands (P10/P50/P90, etc.).
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Standard normal CDF via an erf approximation (Abramowitz & Stegun 7.1.26). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const prob =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - prob : prob;
}

/** The predictive standard deviation at a given step ahead (random-walk widening). */
export function stepSigma(sigma: number, stepsAhead: number): number {
  return sigma * Math.sqrt(Math.max(1, stepsAhead));
}

/** One percentile curve across the forecast horizon. */
export interface QuantileBand {
  /** Probability level in (0,1), e.g. 0.1, 0.5, 0.9. */
  p: number;
  /** Value at each x index; null over the historical (in-sample) region. */
  values: (number | null)[];
}

/**
 * Compute percentile curves (e.g. P10/P50/P90) over the forecast horizon. When
 * the band is measured (backtest) calibrated, curves use the measured per-horizon
 * out-of-sample error quantiles directly (no sqrt-time scaling), so measured P50
 * reflects the median forecast bias and may differ slightly from the point
 * forecast. When the band is empirically calibrated, curves use asymmetric
 * residual quantiles scaled by sqrt(steps ahead); otherwise they assume Gaussian
 * predictive errors that widen as sqrt(steps ahead) with P50 at the point
 * forecast. Historical bins are left null.
 */
export function quantileBands(result: ForecastResult, probs: number[]): QuantileBand[] {
  const n = result.x.length;
  const backtest = result.calibration.method === 'backtest' && result.horizonCalibration != null;
  const empirical = result.calibration.method === 'empirical';
  const sortedResiduals = empirical ? [...result.residuals].sort((a, b) => a - b) : [];
  return probs.map((p) => {
    const z = normalQuantile(p);
    const q = empirical ? empiricalQuantile(sortedResiduals, p) : 0;
    const values: (number | null)[] = new Array(n).fill(null);
    for (let i = result.forecastStart; i < n; i++) {
      const f = result.forecast[i];
      if (f == null) continue;
      const stepsAhead = i - result.forecastStart + 1;
      values[i] = backtest
        ? f + horizonErrorQuantile(result.horizonCalibration!.perHorizonErrors[stepsAhead - 1] ?? [], p)
        : empirical
          ? f + q * Math.sqrt(stepsAhead)
          : f + z * stepSigma(result.sigma, stepsAhead);
    }
    // Anchor to the join point so curves connect to history.
    if (result.forecastStart > 0 && result.forecast[result.forecastStart - 1] != null) {
      values[result.forecastStart - 1] = result.forecast[result.forecastStart - 1];
    }
    return { p, values };
  });
}

export type ThresholdDirection = 'above' | 'below';

/** Per-step and aggregate probability of a signal breaching a threshold. */
export interface ExceedanceResult {
  threshold: number;
  direction: ThresholdDirection;
  /** Per-bin breach probability; null over history. */
  perStep: (number | null)[];
  /** Highest per-bin breach probability across the horizon. */
  peakProbability: number;
  /** x index of the peak; -1 if none. */
  peakIndex: number;
  /** First horizon x index where per-bin probability ≥ 0.5; -1 if never. */
  firstLikelyIndex: number;
  /**
   * Probability the threshold is breached in at least one horizon bin. When the
   * band is empirically calibrated and there are enough residual windows
   * (>= {@link MIN_TRAJECTORIES}), this is estimated from an ensemble of
   * residual-based cumulative error trajectories that preserve cross-horizon
   * dependence (a single random-walk error path drives every bin); otherwise it
   * falls back to the per-bin independence product `1 - ∏(1 - perStep)`. Either
   * way it remains an APPROXIMATE estimate — not a guaranteed upper bound — and
   * can be higher or lower than the true risk.
   */
  anyBreachProbability: number;
  /**
   * How `anyBreachProbability` was computed: `trajectory` when the
   * dependency-preserving residual-trajectory ensemble was used, `independent`
   * when it fell back to the per-bin independence product.
   */
  anyBreachMethod: 'trajectory' | 'independent';
}

interface ValueAtTime {
  value: number | null;
  iso: string | null;
}

export interface ForecastFeatures {
  trend: {
    slope: number | null;
    totalChange: number | null;
    pctChange: number | null;
    direction: 'rising' | 'falling' | 'flat';
  };
  level: {
    firstForecast: number | null;
    lastForecast: number | null;
    meanForecast: number | null;
    minForecast: ValueAtTime;
    maxForecast: ValueAtTime;
  };
  uncertainty: {
    sigma: number;
    halfWidthFirst: number | null;
    halfWidthLast: number | null;
    wideningRatio: number | null;
  };
  history: {
    count: number;
    mean: number | null;
    min: number | null;
    max: number | null;
    stdev: number | null;
    lastValue: number | null;
  };
  coverage?: {
    historyBins: number;
    missingBins: number;
    missingFraction: number;
    longestGapBins: number;
    trailingStaleBins: number;
  };
  calibration?: { method: string; sampleCount: number };
  /** Which model input produced the point forecast, when A2 selection ran. */
  modelInput?: 'raw' | 'outlier-cleaned';
  /** Which history window produced the point forecast, when A4 selection ran. */
  historyWindow?: 'full' | 'recent';
  breach?: {
    peakProbability: number;
    anyBreachProbability: number;
    anyBreachMethod: 'trajectory' | 'independent';
    firstLikelyIso: string | null;
    expectedBreachBins: number;
  };
}

function roundSig(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value === 0) return 0;
  return Number(value.toPrecision(3));
}

function stats(values: number[]) {
  if (values.length === 0) {
    return { count: 0, mean: null, min: null, max: null, stdev: null, lastValue: null };
  }
  const sum = values.reduce((acc, v) => acc + v, 0);
  const mean = sum / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return {
    count: values.length,
    mean: roundSig(mean),
    min: roundSig(Math.min(...values)),
    max: roundSig(Math.max(...values)),
    stdev: roundSig(Math.sqrt(variance)),
    lastValue: roundSig(values[values.length - 1]),
  };
}

/** Compact client-side feature extraction for agent-readable forecast payloads. */
export function summarizeForecast(
  result: ForecastResult,
  opts: { threshold?: number; direction?: ThresholdDirection } = {},
): ForecastFeatures {
  const forecastIdx: number[] = [];
  for (let i = result.forecastStart; i < result.forecast.length; i++) {
    const v = result.forecast[i];
    if (v != null && Number.isFinite(v)) forecastIdx.push(i);
  }

  const forecastValues = forecastIdx.map((i) => result.forecast[i] as number);
  const firstIdx = forecastIdx[0] ?? -1;
  const lastIdx = forecastIdx[forecastIdx.length - 1] ?? -1;
  const firstF = firstIdx >= 0 ? result.forecast[firstIdx] : null;
  const lastF = lastIdx >= 0 ? result.forecast[lastIdx] : null;
  const meanForecast =
    forecastValues.length > 0
      ? forecastValues.reduce((acc, v) => acc + v, 0) / forecastValues.length
      : null;

  let minIdx = -1;
  let maxIdx = -1;
  for (const i of forecastIdx) {
    const v = result.forecast[i];
    if (v == null) continue;
    if (minIdx < 0 || v < (result.forecast[minIdx] as number)) minIdx = i;
    if (maxIdx < 0 || v > (result.forecast[maxIdx] as number)) maxIdx = i;
  }

  let slope: number | null = null;
  if (forecastValues.length >= 2) {
    const m = forecastValues.length;
    const meanX = (m - 1) / 2;
    const meanY = forecastValues.reduce((acc, v) => acc + v, 0) / m;
    let num = 0;
    let den = 0;
    for (let i = 0; i < m; i++) {
      const dx = i - meanX;
      num += dx * (forecastValues[i] - meanY);
      den += dx * dx;
    }
    slope = den > 0 ? num / den : 0;
  }

  const totalChange = firstF != null && lastF != null ? lastF - firstF : null;
  const pctChange =
    firstF != null && firstF !== 0 && totalChange != null ? totalChange / Math.abs(firstF) : 0;
  const flatThreshold = Math.max(Math.abs(result.sigma) * 0.01, 1e-12);
  const direction =
    slope == null || Math.abs(slope) <= flatThreshold ? 'flat' : slope > 0 ? 'rising' : 'falling';
  const halfWidthAt = (i: number) =>
    i >= 0 && result.upper[i] != null && result.forecast[i] != null
      ? (result.upper[i] as number) - (result.forecast[i] as number)
      : null;
  const halfWidthFirst = halfWidthAt(firstIdx);
  const halfWidthLast = halfWidthAt(lastIdx);

  const features: ForecastFeatures = {
    trend: {
      slope: roundSig(slope),
      totalChange: roundSig(totalChange),
      pctChange: roundSig(pctChange),
      direction,
    },
    level: {
      firstForecast: roundSig(firstF),
      lastForecast: roundSig(lastF),
      meanForecast: roundSig(meanForecast),
      minForecast: {
        value: minIdx >= 0 ? roundSig(result.forecast[minIdx]) : null,
        iso: minIdx >= 0 ? new Date(result.x[minIdx]).toISOString() : null,
      },
      maxForecast: {
        value: maxIdx >= 0 ? roundSig(result.forecast[maxIdx]) : null,
        iso: maxIdx >= 0 ? new Date(result.x[maxIdx]).toISOString() : null,
      },
    },
    uncertainty: {
      sigma: roundSig(result.sigma) ?? 0,
      halfWidthFirst: roundSig(halfWidthFirst),
      halfWidthLast: roundSig(halfWidthLast),
      wideningRatio:
        halfWidthFirst != null && halfWidthFirst !== 0 && halfWidthLast != null
          ? roundSig(halfWidthLast / halfWidthFirst)
          : null,
    },
    history: stats(result.actual.filter((v): v is number => v != null && Number.isFinite(v))),
    coverage: result.coverage
      ? {
          historyBins: roundSig(result.coverage.historyBins) ?? 0,
          missingBins: roundSig(result.coverage.missingBins) ?? 0,
          missingFraction: roundSig(result.coverage.missingFraction) ?? 0,
          longestGapBins: roundSig(result.coverage.longestGapBins) ?? 0,
          trailingStaleBins: roundSig(result.coverage.trailingStaleBins) ?? 0,
        }
      : undefined,
    calibration: {
      method: result.calibration.method,
      sampleCount: result.calibration.sampleCount,
    },
    modelInput: result.modelSelection
      ? result.modelSelection.choice === 'cleaned' ? 'outlier-cleaned' : 'raw'
      : undefined,
    historyWindow: result.windowSelection ? result.windowSelection.choice : undefined,
  };

  if (opts.threshold != null && opts.direction) {
    const breach = exceedanceProbability(result, opts.threshold, opts.direction);
    features.breach = {
      peakProbability: roundSig(breach.peakProbability) ?? 0,
      anyBreachProbability: roundSig(breach.anyBreachProbability) ?? 0,
      anyBreachMethod: breach.anyBreachMethod,
      firstLikelyIso:
        breach.firstLikelyIndex >= 0
          ? new Date(result.x[breach.firstLikelyIndex]).toISOString()
          : null,
      expectedBreachBins:
        roundSig(
          breach.perStep.reduce<number>((acc, v) => acc + (v == null ? 0 : v), 0),
        ) ?? 0,
    };
  }

  return features;
}

/**
 * Estimate the probability the forecast breaches `threshold` at least once over
 * the horizon using an ensemble of residual-based CUMULATIVE error trajectories.
 * Summing H consecutive 1-step residuals builds a random-walk error path whose
 * marginal SD grows as σ·√h (consistent with the per-step band) while preserving
 * the real cross-horizon dependence — a single error path drives every bin. Each
 * of the W = R − H + 1 contiguous residual windows yields one honest trajectory;
 * the estimate is the fraction of those trajectories that breach. Returns `null`
 * when there is no horizon or fewer than {@link MIN_TRAJECTORIES} windows, so the
 * caller falls back to the per-bin independence product.
 */
function trajectoryAnyBreach(
  result: ForecastResult,
  threshold: number,
  direction: ThresholdDirection,
): number | null {
  const residuals = result.residuals;
  const R = residuals.length;
  // Horizon forecast values in order (skip nulls defensively).
  const fs: number[] = [];
  for (let i = result.forecastStart; i < result.x.length; i++) {
    const f = result.forecast[i];
    if (f != null) fs.push(f);
  }
  const H = fs.length;
  if (H === 0) return null;
  const W = R - H + 1; // non-circular contiguous windows of increments
  if (W < MIN_TRAJECTORIES) return null; // too few honest paths -> caller falls back
  let breaches = 0;
  for (let s = 0; s <= R - H; s++) {
    let c = 0;
    let breached = false;
    for (let h = 0; h < H; h++) {
      c += residuals[s + h]; // cumulative random-walk error path
      const v = fs[h] + c;
      if (direction === 'above' ? v > threshold : v < threshold) {
        breached = true;
        break;
      }
    }
    if (breached) breaches += 1;
  }
  return breaches / W;
}

/**
 * Compute the probability that the forecast breaches `threshold` in the given
 * direction, per horizon bin and in aggregate. When the band is measured
 * (backtest) calibrated, each per-step probability is the fraction of the
 * measured out-of-sample per-horizon errors `e` for which `f + e` breaches the
 * threshold (no sqrt-time scaling, since per-horizon spread is measured
 * directly). When the band is empirically calibrated, each per-step probability
 * is the fraction of residuals `r` for which `f + r·√steps` breaches the
 * threshold (asymmetric, fat-tail-aware); otherwise it uses the Gaussian
 * predictive distribution (mean = point forecast, sd = σ·√steps). The aggregate
 * `anyBreachProbability` uses an ensemble of residual-based cumulative error
 * trajectories (dependency-preserving; see {@link trajectoryAnyBreach}) when the
 * band is empirically OR measured calibrated and there are enough residual
 * windows (>= {@link MIN_TRAJECTORIES}); otherwise it falls back to the per-bin
 * independence product `1 - ∏(1 - perStep)`. Either way the aggregate is an
 * APPROXIMATE estimate, not a guaranteed bound.
 */
export function exceedanceProbability(
  result: ForecastResult,
  threshold: number,
  direction: ThresholdDirection,
): ExceedanceResult {
  const n = result.x.length;
  const perStep: (number | null)[] = new Array(n).fill(null);
  const method = result.calibration.method;
  const hcal = result.horizonCalibration;
  const residuals = result.residuals;
  let peakProbability = 0;
  let peakIndex = -1;
  let firstLikelyIndex = -1;
  let survive = 1; // P(no breach so far)
  for (let i = result.forecastStart; i < n; i++) {
    const f = result.forecast[i];
    if (f == null) continue;
    const stepsAhead = i - result.forecastStart + 1;
    let prob: number;
    if (method === 'backtest' && hcal) {
      // Measured per-step breach: fraction of the out-of-sample per-horizon
      // errors e whose f + e breaches the threshold (no sqrt-time scaling).
      const samples = hcal.perHorizonErrors[stepsAhead - 1] ?? [];
      let breaches = 0;
      for (const e of samples) {
        const v = f + e;
        if (direction === 'above' ? v > threshold : v < threshold) breaches += 1;
      }
      prob =
        samples.length > 0
          ? breaches / samples.length
          : direction === 'above'
            ? f > threshold
              ? 1
              : 0
            : f < threshold
              ? 1
              : 0;
    } else if (method === 'empirical') {
      // Empirical per-step breach: fraction of residuals whose scaled value
      // f + r·√steps breaches the threshold in the requested direction.
      const grow = Math.sqrt(stepsAhead);
      let breaches = 0;
      for (const r of residuals) {
        const v = f + r * grow;
        if (direction === 'above' ? v > threshold : v < threshold) breaches += 1;
      }
      prob = residuals.length > 0 ? breaches / residuals.length : direction === 'above' ? (f > threshold ? 1 : 0) : f < threshold ? 1 : 0;
    } else {
      const sd = stepSigma(result.sigma, stepsAhead);
      if (sd <= 0) {
        prob = direction === 'above' ? (f > threshold ? 1 : 0) : f < threshold ? 1 : 0;
      } else {
        const z = (threshold - f) / sd;
        // P(value > threshold) = 1 - Phi(z); P(value < threshold) = Phi(z).
        prob = direction === 'above' ? 1 - normalCdf(z) : normalCdf(z);
      }
    }
    perStep[i] = prob;
    if (prob > peakProbability) {
      peakProbability = prob;
      peakIndex = i;
    }
    if (firstLikelyIndex < 0 && prob >= 0.5) firstLikelyIndex = i;
    survive *= 1 - prob;
  }
  let anyBreachProbability = 1 - survive; // independence fallback
  let anyBreachMethod: 'trajectory' | 'independent' = 'independent';
  if (result.calibration.method === 'empirical' || result.calibration.method === 'backtest') {
    const traj = trajectoryAnyBreach(result, threshold, direction);
    if (traj != null) {
      anyBreachProbability = traj;
      anyBreachMethod = 'trajectory';
    }
  }
  return {
    threshold,
    direction,
    perStep,
    peakProbability,
    peakIndex,
    firstLikelyIndex,
    anyBreachProbability,
    anyBreachMethod,
  };
}
