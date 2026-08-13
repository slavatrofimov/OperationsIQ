/**
 * Causality matrix via linear Granger causality (functional spec §Causality).
 *
 * For an ordered pair (source → target) we ask: does knowing the recent past of
 * `source` improve our ability to predict `target` beyond target's own past?
 * We fit two linear autoregressive models on the aligned grid:
 *   - restricted: target[t] ~ target[t-1..t-p]
 *   - full:       target[t] ~ target[t-1..t-p] + source[t-1..t-p]
 * The proportional reduction in residual sum of squares is the causality score
 * in [0,1). Higher = source's history helps predict the target (Granger-causes).
 *
 * This is a *predictive*, linear, pairwise notion of causality — a screening
 * tool that feeds the root-cause graph, not proof of a physical mechanism. The
 * UI frames it as such.
 */
import type { AlignedSeries } from './rootCause';

/** Solve A·x = b via Gaussian elimination with partial pivoting; null if singular. */
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

/** OLS residual sum of squares for design matrix X (rows) and response y. */
function rss(X: number[][], y: number[]): number | null {
  const dim = X[0]?.length ?? 0;
  if (dim === 0 || X.length < dim + 1) return null;
  const XtX: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
  const Xty: number[] = new Array(dim).fill(0);
  for (let k = 0; k < X.length; k++) {
    for (let a = 0; a < dim; a++) {
      Xty[a] += X[k][a] * y[k];
      for (let b = 0; b < dim; b++) XtX[a][b] += X[k][a] * X[k][b];
    }
  }
  const beta = solve(XtX, Xty);
  if (!beta) return null;
  let s = 0;
  for (let k = 0; k < X.length; k++) {
    const pred = X[k].reduce((acc, x, a) => acc + x * beta[a], 0);
    s += (y[k] - pred) ** 2;
  }
  return s;
}

/**
 * Linear Granger causality score for source → target with `lag` past terms.
 * Returns a value in [0,1): proportional RSS reduction from adding the source's
 * lags. Returns 0 when the models can't be fit or the source doesn't help.
 */
export function grangerScore(target: AlignedSeries, source: AlignedSeries, lag: number): number {
  const n = Math.min(target.v.length, source.v.length);
  const p = Math.max(1, lag);
  const yArr: number[] = [];
  const Xr: number[][] = [];
  const Xf: number[][] = [];
  for (let t = p; t < n; t++) {
    const y = target.v[t];
    if (y == null || !Number.isFinite(y)) continue;
    const tgtLags: number[] = [];
    const srcLags: number[] = [];
    let ok = true;
    for (let k = 1; k <= p; k++) {
      const ty = target.v[t - k];
      const sy = source.v[t - k];
      if (ty == null || !Number.isFinite(ty) || sy == null || !Number.isFinite(sy)) {
        ok = false;
        break;
      }
      tgtLags.push(ty);
      srcLags.push(sy);
    }
    if (!ok) continue;
    yArr.push(y);
    Xr.push([1, ...tgtLags]);
    Xf.push([1, ...tgtLags, ...srcLags]);
  }
  if (yArr.length < 2 * p + 3) return 0;
  const rssR = rss(Xr, yArr);
  const rssF = rss(Xf, yArr);
  if (rssR == null || rssF == null || rssR <= 0) return 0;
  return Math.max(0, Math.min(0.999, (rssR - rssF) / rssR));
}

export interface CausalityMatrix {
  tagIds: string[];
  /** matrix[i][j] = Granger score for tagIds[i] → tagIds[j]; diagonal is 0. */
  matrix: number[][];
}

/** Build the full pairwise Granger causality matrix. */
export function buildCausalityMatrix(series: AlignedSeries[], lag: number): CausalityMatrix {
  const tagIds = series.map((s) => s.tagId);
  const matrix = series.map((src, i) =>
    series.map((tgt, j) => (i === j ? 0 : grangerScore(tgt, src, lag))),
  );
  return { tagIds, matrix };
}

export interface CausalEdge {
  source: string;
  target: string;
  score: number;
}

/** Extract directed edges above a threshold, strongest first. */
export function causalEdges(m: CausalityMatrix, threshold = 0.1): CausalEdge[] {
  const edges: CausalEdge[] = [];
  for (let i = 0; i < m.tagIds.length; i++) {
    for (let j = 0; j < m.tagIds.length; j++) {
      if (i === j) continue;
      const score = m.matrix[i][j];
      if (score >= threshold) edges.push({ source: m.tagIds[i], target: m.tagIds[j], score });
    }
  }
  return edges.sort((a, b) => b.score - a.score);
}
