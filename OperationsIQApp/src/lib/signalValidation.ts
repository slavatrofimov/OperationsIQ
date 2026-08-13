/**
 * Signal validation via multivariate state estimation (functional spec §MSET /
 * signal validation).
 *
 * True MSET builds a non-parametric memory matrix of healthy states; here we
 * use a transparent, dependency-free approximation with the same intent: model
 * a target sensor as a linear combination of correlated reference sensors,
 * learned over a "healthy" training window. The model's prediction is a
 * *virtual sensor*; the residual (actual − estimate) isolates behavior the
 * peers can't explain. A sustained bias or inflated residual points to sensor
 * drift/fault rather than a genuine process move (which the peers would track).
 *
 * All math is client-side least squares — transparent and reproducible. For
 * large fleets this can be pushed to Spark later; the residual-test contract
 * stays the same.
 */
import type { AlignedSeries } from './rootCause';

/** Solve a small symmetric positive-definite system A·x = b via Gaussian
 * elimination with partial pivoting. Returns null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export interface FitResult {
  /** Regression coefficients; index 0 is the intercept. */
  beta: number[];
  /** Reference tag ids in coefficient order (beta[1..]). */
  refTagIds: string[];
  /** In-sample residual standard deviation over the training rows. */
  trainSigma: number;
  /** Coefficient of determination on the training rows. */
  r2: number;
}

/**
 * Fit target ≈ β0 + Σ βk·refk over the first `trainFraction` of aligned rows
 * where every series has a finite value. Returns null when there is not enough
 * clean training data.
 */
export function fitVirtualSensor(
  target: AlignedSeries,
  refs: AlignedSeries[],
  trainFraction: number,
): FitResult | null {
  const n = target.v.length;
  const p = refs.length;
  if (p === 0 || n === 0) return null;
  const trainEnd = Math.max(1, Math.floor(n * Math.min(0.95, Math.max(0.1, trainFraction))));

  // Assemble clean training rows: [1, ref1..refp] → y.
  const rows: number[][] = [];
  const ys: number[] = [];
  for (let i = 0; i < trainEnd; i++) {
    const y = target.v[i];
    if (y == null || !Number.isFinite(y)) continue;
    const xs = refs.map((r) => r.v[i]);
    if (xs.some((x) => x == null || !Number.isFinite(x as number))) continue;
    rows.push([1, ...(xs as number[])]);
    ys.push(y);
  }
  if (rows.length < p + 2) return null;

  // Normal equations: (XᵀX) β = Xᵀy.
  const dim = p + 1;
  const XtX: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
  const Xty: number[] = new Array(dim).fill(0);
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k];
    for (let a = 0; a < dim; a++) {
      Xty[a] += row[a] * ys[k];
      for (let b = 0; b < dim; b++) XtX[a][b] += row[a] * row[b];
    }
  }
  const beta = solve(XtX, Xty);
  if (!beta) return null;

  // Training residuals → sigma and R².
  const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < rows.length; k++) {
    const pred = rows[k].reduce((s, x, a) => s + x * beta[a], 0);
    ssRes += (ys[k] - pred) ** 2;
    ssTot += (ys[k] - meanY) ** 2;
  }
  const trainSigma = Math.sqrt(ssRes / Math.max(1, rows.length - dim));
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { beta, refTagIds: refs.map((r) => r.tagId), trainSigma, r2 };
}

export interface ValidationSeries {
  /** Unix ms timestamps. */
  t: number[];
  actual: (number | null)[];
  /** Virtual-sensor estimate from peer signals. */
  estimate: (number | null)[];
  /** actual − estimate. */
  residual: (number | null)[];
  /** Residual in training-sigma units. */
  residualZ: (number | null)[];
}

export type Verdict = 'valid' | 'suspect' | 'faulty';

/**
 * Human-facing verdict labels. The internal `Verdict` union stays terse for
 * logic/persistence; these labels soften the wording to reflect that a
 * model-based validation is probabilistic, not a definitive judgement.
 */
export const VERDICT_LABEL: Record<Verdict, string> = {
  valid: 'Likely valid',
  suspect: 'Possibly degraded',
  faulty: 'Potentially faulty',
};

export interface ValidationReport {
  fit: FitResult;
  series: ValidationSeries;
  /** Mean residual over the evaluation (post-training) region — persistent bias. */
  bias: number;
  /** Fraction of evaluation points with |z| > 3. */
  outOfBoundsFraction: number;
  /** Largest |z| over the evaluation region. */
  maxAbsZ: number;
  verdict: Verdict;
  /** trainEnd index (first evaluation row). */
  trainEnd: number;
}

/** Compute the virtual-sensor estimate, residuals, and a validity verdict. */
export function validateSignal(
  target: AlignedSeries,
  refs: AlignedSeries[],
  trainFraction: number,
): ValidationReport | null {
  const fit = fitVirtualSensor(target, refs, trainFraction);
  if (!fit) return null;
  const n = target.v.length;
  const trainEnd = Math.max(1, Math.floor(n * Math.min(0.95, Math.max(0.1, trainFraction))));
  const sigma = fit.trainSigma > 0 ? fit.trainSigma : 1;

  const estimate: (number | null)[] = new Array(n).fill(null);
  const residual: (number | null)[] = new Array(n).fill(null);
  const residualZ: (number | null)[] = new Array(n).fill(null);

  const evalResiduals: number[] = [];
  let maxAbsZ = 0;
  let oob = 0;
  let evalCount = 0;

  for (let i = 0; i < n; i++) {
    const xs = refs.map((r) => r.v[i]);
    if (xs.some((x) => x == null || !Number.isFinite(x as number))) continue;
    const est = fit.beta[0] + xs.reduce((s: number, x, k) => s + (x as number) * fit.beta[k + 1], 0);
    estimate[i] = est;
    const y = target.v[i];
    if (y == null || !Number.isFinite(y)) continue;
    const res = y - est;
    const z = res / sigma;
    residual[i] = res;
    residualZ[i] = z;
    if (i >= trainEnd) {
      evalResiduals.push(res);
      evalCount++;
      if (Math.abs(z) > maxAbsZ) maxAbsZ = Math.abs(z);
      if (Math.abs(z) > 3) oob++;
    }
  }

  const bias = evalResiduals.length
    ? evalResiduals.reduce((s, v) => s + v, 0) / evalResiduals.length
    : 0;
  const outOfBoundsFraction = evalCount > 0 ? oob / evalCount : 0;
  const biasZ = Math.abs(bias) / sigma;

  let verdict: Verdict = 'valid';
  if (maxAbsZ > 6 || outOfBoundsFraction > 0.1 || biasZ > 2) verdict = 'faulty';
  else if (maxAbsZ > 3 || outOfBoundsFraction > 0.02 || biasZ > 1) verdict = 'suspect';

  return {
    fit,
    series: { t: target.t, actual: target.v, estimate, residual, residualZ },
    bias,
    outOfBoundsFraction,
    maxAbsZ,
    verdict,
    trainEnd,
  };
}
