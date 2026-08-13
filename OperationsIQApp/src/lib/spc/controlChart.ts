/**
 * Shewhart control-chart compute core (Phase 1 of the SPC integration).
 *
 * Computes classic *statistical control* limits with the standard unbiasing
 * constants (d2, A2, A3, B3, B4, D3, D4). It supports the three variables-chart
 * families that map most naturally onto this app's data:
 *
 *   - **I-MR**   Individuals + Moving Range (one observation per period).
 *   - **X̄-R**    Subgroup mean + Range (small rational subgroups, n ≤ ~10).
 *   - **X̄-S**    Subgroup mean + Standard deviation (larger subgroups).
 *
 * Every chart distinguishes **Phase I** (limits *estimated* from a baseline
 * window) from **Phase II** (a frozen baseline's limits *applied* to new data).
 * This separation is what lets the product prevent silent limit changes, per the
 * SPC design spec.
 */

/** Which control-chart family to compute. */
export type ControlChartType = 'i-mr' | 'xbar-r' | 'xbar-s';

/** Whether limits are being estimated (I) or applied from a frozen baseline (II). */
export type ControlPhase = 'I' | 'II';

/** The kind of statistic a single panel plots. */
export type PanelKind = 'individuals' | 'moving-range' | 'xbar' | 'range' | 'stdev';

/**
 * Control limits plus the 1σ/2σ zone boundaries used by the run-rule engine and
 * the zone-shaded chart. `sigma` is the estimated standard deviation of the
 * plotted statistic, i.e. (UCL − CL) / 3.
 */
export interface ControlLimits {
  centerLine: number;
  ucl: number;
  lcl: number;
  /** Estimated σ of the plotted statistic: (UCL − CL) / 3. */
  sigma: number;
  /** CL + 1σ / CL + 2σ. */
  zoneUpper1: number;
  zoneUpper2: number;
  /** CL − 1σ / CL − 2σ. */
  zoneLower1: number;
  zoneLower2: number;
}

/** One plotted point on a control-chart panel. */
export interface ChartPoint {
  /** Representative time as unix ms. */
  x: number;
  /** Plotted statistic (individual value, subgroup mean, MR, R, or S). */
  value: number | null;
}

/** A single control-chart panel (primary statistic or its variation chart). */
export interface ChartPanel {
  kind: PanelKind;
  points: ChartPoint[];
  limits: ControlLimits;
}

/** One rational subgroup of observations at a representative time. */
export interface Subgroup {
  /** Representative time as unix ms. */
  x: number;
  /** Observations in the subgroup; length 1 for individuals. */
  values: number[];
}

/** Full result: the primary chart, its variation chart, and metadata. */
export interface ControlChartResult {
  type: ControlChartType;
  phase: ControlPhase;
  /** Individuals or X̄ panel. */
  primary: ChartPanel;
  /** Moving-range, R, or S panel. */
  secondary: ChartPanel;
  /** Nominal subgroup size (1 for I-MR). */
  subgroupSize: number;
}

/**
 * Unbiasing constants for subgroup sizes n = 2..25. Values are the standard SPC
 * table (Montgomery, *Introduction to Statistical Quality Control*). d2 is used
 * to convert average ranges/moving-ranges into a σ estimate; A2/A3 size the X̄
 * limits from R̄/S̄; B3/B4 and D3/D4 size the S and R limits respectively.
 */
interface SpcConstants {
  d2: number;
  A2: number;
  A3: number;
  B3: number;
  B4: number;
  D3: number;
  D4: number;
}

const SPC_CONSTANTS: Record<number, SpcConstants> = {
  2: { d2: 1.128, A2: 1.88, A3: 2.659, B3: 0, B4: 3.267, D3: 0, D4: 3.267 },
  3: { d2: 1.693, A2: 1.023, A3: 1.954, B3: 0, B4: 2.568, D3: 0, D4: 2.574 },
  4: { d2: 2.059, A2: 0.729, A3: 1.628, B3: 0, B4: 2.266, D3: 0, D4: 2.282 },
  5: { d2: 2.326, A2: 0.577, A3: 1.427, B3: 0, B4: 2.089, D3: 0, D4: 2.114 },
  6: { d2: 2.534, A2: 0.483, A3: 1.287, B3: 0.03, B4: 1.97, D3: 0, D4: 2.004 },
  7: { d2: 2.704, A2: 0.419, A3: 1.182, B3: 0.118, B4: 1.882, D3: 0.076, D4: 1.924 },
  8: { d2: 2.847, A2: 0.373, A3: 1.099, B3: 0.185, B4: 1.815, D3: 0.136, D4: 1.864 },
  9: { d2: 2.97, A2: 0.337, A3: 1.032, B3: 0.239, B4: 1.761, D3: 0.184, D4: 1.816 },
  10: { d2: 3.078, A2: 0.308, A3: 0.975, B3: 0.284, B4: 1.716, D3: 0.223, D4: 1.777 },
  11: { d2: 3.173, A2: 0.285, A3: 0.927, B3: 0.321, B4: 1.679, D3: 0.256, D4: 1.744 },
  12: { d2: 3.258, A2: 0.266, A3: 0.886, B3: 0.354, B4: 1.646, D3: 0.283, D4: 1.717 },
  13: { d2: 3.336, A2: 0.249, A3: 0.85, B3: 0.382, B4: 1.618, D3: 0.307, D4: 1.693 },
  14: { d2: 3.407, A2: 0.235, A3: 0.817, B3: 0.406, B4: 1.594, D3: 0.328, D4: 1.672 },
  15: { d2: 3.472, A2: 0.223, A3: 0.789, B3: 0.428, B4: 1.572, D3: 0.347, D4: 1.653 },
  16: { d2: 3.532, A2: 0.212, A3: 0.763, B3: 0.448, B4: 1.552, D3: 0.363, D4: 1.637 },
  17: { d2: 3.588, A2: 0.203, A3: 0.739, B3: 0.466, B4: 1.534, D3: 0.378, D4: 1.622 },
  18: { d2: 3.64, A2: 0.194, A3: 0.718, B3: 0.482, B4: 1.518, D3: 0.391, D4: 1.608 },
  19: { d2: 3.689, A2: 0.187, A3: 0.698, B3: 0.497, B4: 1.503, D3: 0.403, D4: 1.597 },
  20: { d2: 3.735, A2: 0.18, A3: 0.68, B3: 0.51, B4: 1.49, D3: 0.415, D4: 1.585 },
  21: { d2: 3.778, A2: 0.173, A3: 0.663, B3: 0.523, B4: 1.477, D3: 0.425, D4: 1.575 },
  22: { d2: 3.819, A2: 0.167, A3: 0.647, B3: 0.534, B4: 1.466, D3: 0.434, D4: 1.566 },
  23: { d2: 3.858, A2: 0.162, A3: 0.633, B3: 0.545, B4: 1.455, D3: 0.443, D4: 1.557 },
  24: { d2: 3.895, A2: 0.157, A3: 0.619, B3: 0.555, B4: 1.445, D3: 0.451, D4: 1.548 },
  25: { d2: 3.931, A2: 0.153, A3: 0.606, B3: 0.565, B4: 1.435, D3: 0.459, D4: 1.541 },
};

/** Clamp a requested subgroup size to the range covered by the constants table. */
function constantsFor(n: number): SpcConstants {
  const clamped = Math.max(2, Math.min(25, Math.round(n)));
  return SPC_CONSTANTS[clamped];
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sampleStdev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  const ss = values.reduce((s, v) => s + (v - m) ** 2, 0);
  return Math.sqrt(ss / (n - 1));
}

/** Build limits + zone boundaries from a center line and a 1σ estimate. */
function limitsFromSigma(centerLine: number, sigma: number, lclFloor?: number): ControlLimits {
  const rawLcl = centerLine - 3 * sigma;
  const lcl = lclFloor != null ? Math.max(lclFloor, rawLcl) : rawLcl;
  const ucl = centerLine + 3 * sigma;
  return {
    centerLine,
    ucl,
    lcl,
    sigma,
    zoneUpper1: centerLine + sigma,
    zoneUpper2: centerLine + 2 * sigma,
    zoneLower1: centerLine - sigma,
    zoneLower2: centerLine - 2 * sigma,
  };
}

/** Explicit limits for a variation chart (R/S/MR) whose bounds aren't symmetric. */
function limitsExplicit(centerLine: number, ucl: number, lcl: number): ControlLimits {
  const sigma = (ucl - centerLine) / 3;
  return {
    centerLine,
    ucl,
    lcl,
    sigma,
    zoneUpper1: centerLine + sigma,
    zoneUpper2: centerLine + 2 * sigma,
    zoneLower1: Math.max(lcl, centerLine - sigma),
    zoneLower2: Math.max(lcl, centerLine - 2 * sigma),
  };
}

/**
 * The limit sets a control chart needs, computed from a baseline window.
 * Returned separately so a caller can freeze them into a Phase-II baseline.
 */
export interface EstimatedLimits {
  type: ControlChartType;
  subgroupSize: number;
  primary: ControlLimits;
  secondary: ControlLimits;
}

/**
 * Estimate control limits (Phase I) from a set of subgroups. For I-MR the
 * subgroups must each hold a single observation. Subgroups with too few finite
 * values to contribute are skipped.
 */
export function estimateLimits(type: ControlChartType, subgroups: Subgroup[]): EstimatedLimits {
  if (type === 'i-mr') return estimateImr(subgroups);
  if (type === 'xbar-r') return estimateXbar(subgroups, 'r');
  return estimateXbar(subgroups, 's');
}

function estimateImr(subgroups: Subgroup[]): EstimatedLimits {
  // Flatten to the individual values in time order.
  const xs = subgroups
    .map((g) => g.values.find((v) => Number.isFinite(v)))
    .filter((v): v is number => v != null && Number.isFinite(v));

  const movingRanges: number[] = [];
  for (let i = 1; i < xs.length; i++) movingRanges.push(Math.abs(xs[i] - xs[i - 1]));

  const xBar = mean(xs);
  const mrBar = movingRanges.length > 0 ? mean(movingRanges) : 0;
  // σ estimated from the average moving range of two consecutive points (n=2).
  const { d2, D3, D4 } = constantsFor(2);
  const sigma = d2 > 0 ? mrBar / d2 : 0;

  const primary = limitsFromSigma(xBar, sigma);
  const secondary = limitsExplicit(mrBar, D4 * mrBar, D3 * mrBar);
  return { type: 'i-mr', subgroupSize: 1, primary, secondary };
}

function estimateXbar(subgroups: Subgroup[], variation: 'r' | 's'): EstimatedLimits {
  const groups = subgroups
    .map((g) => g.values.filter((v) => Number.isFinite(v)))
    .filter((vs) => vs.length >= 2);

  // Use the first group size for the constants; guard empty input.
  const n = groups.length > 0 ? groups[0].length : 2;
  const c = constantsFor(n);

  const means = groups.map(mean);
  const xBarBar = mean(means);

  if (variation === 'r') {
    const ranges = groups.map((vs) => Math.max(...vs) - Math.min(...vs));
    const rBar = mean(ranges);
    const sigmaXbar = (c.A2 * rBar) / 3; // A2·R̄ is the 3σ half-width, so 1σ = A2·R̄/3
    const primary = limitsFromSigma(xBarBar, sigmaXbar);
    const secondary = limitsExplicit(rBar, c.D4 * rBar, c.D3 * rBar);
    return { type: 'xbar-r', subgroupSize: n, primary, secondary };
  }

  const stdevs = groups.map(sampleStdev);
  const sBar = mean(stdevs);
  const sigmaXbar = (c.A3 * sBar) / 3;
  const primary = limitsFromSigma(xBarBar, sigmaXbar);
  const secondary = limitsExplicit(sBar, c.B4 * sBar, c.B3 * sBar);
  return { type: 'xbar-s', subgroupSize: n, primary, secondary };
}

/** Map subgroups to the (x, statistic) points for the primary + secondary panels. */
function panelPoints(
  type: ControlChartType,
  subgroups: Subgroup[],
): { primary: ChartPoint[]; secondary: ChartPoint[] } {
  if (type === 'i-mr') {
    const primary: ChartPoint[] = [];
    const secondary: ChartPoint[] = [];
    let prev: number | null = null;
    for (const g of subgroups) {
      const v = g.values.find((x) => Number.isFinite(x)) ?? null;
      primary.push({ x: g.x, value: v });
      const mr = v != null && prev != null ? Math.abs(v - prev) : null;
      secondary.push({ x: g.x, value: mr });
      if (v != null) prev = v;
    }
    return { primary, secondary };
  }

  const primary: ChartPoint[] = [];
  const secondary: ChartPoint[] = [];
  for (const g of subgroups) {
    const vs = g.values.filter((v) => Number.isFinite(v));
    if (vs.length === 0) {
      primary.push({ x: g.x, value: null });
      secondary.push({ x: g.x, value: null });
      continue;
    }
    primary.push({ x: g.x, value: mean(vs) });
    const stat = type === 'xbar-r' ? Math.max(...vs) - Math.min(...vs) : sampleStdev(vs);
    secondary.push({ x: g.x, value: stat });
  }
  return { primary, secondary };
}

/**
 * Build a full control chart. In **Phase I** (`frozen` omitted) limits are
 * estimated from `subgroups` and applied to the same data. In **Phase II**
 * (`frozen` provided) the frozen baseline limits are applied to `subgroups`
 * without recomputation — the governed way to monitor new data.
 */
export function buildControlChart(
  type: ControlChartType,
  subgroups: Subgroup[],
  frozen?: EstimatedLimits,
): ControlChartResult {
  const limits = frozen ?? estimateLimits(type, subgroups);
  const { primary, secondary } = panelPoints(type, subgroups);
  return {
    type,
    phase: frozen ? 'II' : 'I',
    subgroupSize: limits.subgroupSize,
    primary: { kind: type === 'i-mr' ? 'individuals' : 'xbar', points: primary, limits: limits.primary },
    secondary: {
      kind: type === 'i-mr' ? 'moving-range' : type === 'xbar-r' ? 'range' : 'stdev',
      points: secondary,
      limits: limits.secondary,
    },
  };
}

/**
 * Convenience: turn a plain individual-value series (x in unix ms, nullable
 * values) into single-observation subgroups for an I-MR chart.
 */
export function individualsToSubgroups(x: number[], values: (number | null)[]): Subgroup[] {
  const out: Subgroup[] = [];
  const n = Math.min(x.length, values.length);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    out.push({ x: x[i], values: v != null && Number.isFinite(v) ? [v] : [] });
  }
  return out;
}
