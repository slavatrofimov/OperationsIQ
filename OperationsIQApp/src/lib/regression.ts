/**
 * Parsing helpers for regression and sensitivity analysis KQL results.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';

export interface CorrelationPair {
  tagA: string;
  tagB: string;
  correlation: number;
}

/**
 * Parse the upper-triangle correlation matrix rows into an array of pairwise
 * correlations. Client-side, you can build a full symmetric matrix from these.
 */
export function parseCorrelationMatrix(table: KustoTable): CorrelationPair[] {
  const rows = rowsToObjects<{ TagA: string; TagB: string; Correlation: number }>(table);
  return rows.map((r) => ({
    tagA: r.TagA,
    tagB: r.TagB,
    correlation: Number.isFinite(r.Correlation) ? r.Correlation : 0,
  }));
}

export interface FeatureSensitivity {
  featureTagId: string;
  rsquare: number;
  slope: number;
  intercept: number;
}

/**
 * Parse the sensitivity ranking table (one row per feature, sorted by R²
 * descending). Returns feature importance ordered by explanatory power.
 */
export function parseSensitivityResult(table: KustoTable): FeatureSensitivity[] {
  const rows = rowsToObjects<{
    FeatureTagId: string;
    RSq: number;
    Slope: number;
    Intercept: number;
  }>(table);
  return rows.map((r) => ({
    featureTagId: r.FeatureTagId,
    rsquare: Number.isFinite(r.RSq) ? r.RSq : 0,
    slope: Number.isFinite(r.Slope) ? r.Slope : 0,
    intercept: Number.isFinite(r.Intercept) ? r.Intercept : 0,
  }));
}

export interface RegressionFit {
  targetTagId: string;
  featureTagId: string;
  rsquare: number;
  slope: number;
  intercept: number;
  variance: number;
  rvariance: number;
  /** Aligned time axis (unix seconds). */
  timestamps: number[];
  /** Actual target series values. */
  targetSeries: (number | null)[];
  /** Fitted regression line. */
  fittedSeries: (number | null)[];
}

/**
 * Parse regression fit results (one row per feature when multivariate, or one
 * row for a single feature). Each row contains the target series, fitted series,
 * and regression statistics.
 */
export function parseRegressionFit(table: KustoTable): RegressionFit[] {
  const rows = rowsToObjects<{
    TargetTagId: string;
    FeatureTagId: string;
    RSq: number;
    Slope: number;
    Intercept: number;
    Variance: number;
    RVariance: number;
    Timestamp: string[];
    TargetSeries: (number | null)[];
    FittedSeries: (number | null)[];
  }>(table);
  
  return rows.map((r) => ({
    targetTagId: r.TargetTagId,
    featureTagId: r.FeatureTagId,
    rsquare: Number.isFinite(r.RSq) ? r.RSq : 0,
    slope: Number.isFinite(r.Slope) ? r.Slope : 0,
    intercept: Number.isFinite(r.Intercept) ? r.Intercept : 0,
    variance: Number.isFinite(r.Variance) ? r.Variance : 0,
    rvariance: Number.isFinite(r.RVariance) ? r.RVariance : 0,
    timestamps: (r.Timestamp ?? []).map((t) => new Date(t).getTime() / 1000),
    targetSeries: (r.TargetSeries ?? []).map((v) => (v == null ? null : Number(v))),
    fittedSeries: (r.FittedSeries ?? []).map((v) => (v == null ? null : Number(v))),
  }));
}

/**
 * Client-side prediction using linear regression coefficients. For multivariate,
 * computes: predicted = intercept + sum(slope_i * featureValue_i).
 * 
 * For simplicity, this assumes a linear combination (degree=1). For polynomial
 * or more complex models, extend this to handle coefficient arrays.
 */
export function predictWhatIf(
  coefficients: { slope: number; intercept: number }[],
  featureValues: number[],
): number {
  if (coefficients.length === 0) return 0;
  // For a single feature: y = intercept + slope * x.
  if (coefficients.length === 1) {
    return coefficients[0].intercept + coefficients[0].slope * (featureValues[0] ?? 0);
  }
  // For multivariate: average the intercepts, sum slope_i * x_i.
  const avgIntercept = coefficients.reduce((s, c) => s + c.intercept, 0) / coefficients.length;
  const slopeSum = coefficients.reduce((s, c, i) => s + c.slope * (featureValues[i] ?? 0), 0);
  return avgIntercept + slopeSum;
}

/**
 * Build a full symmetric correlation matrix from the upper-triangle pairs.
 * Returns a map: tagId → { tagId → correlation }.
 */
export function buildSymmetricCorrelationMatrix(
  pairs: CorrelationPair[],
  allTagIds: string[],
): Map<string, Map<string, number>> {
  const matrix = new Map<string, Map<string, number>>();
  
  // Initialize diagonal (self-correlation = 1).
  for (const id of allTagIds) {
    const row = new Map<string, number>();
    row.set(id, 1);
    matrix.set(id, row);
  }
  
  // Fill from upper triangle pairs.
  for (const p of pairs) {
    const rowA = matrix.get(p.tagA);
    const rowB = matrix.get(p.tagB);
    if (rowA) rowA.set(p.tagB, p.correlation);
    if (rowB) rowB.set(p.tagA, p.correlation);
  }
  
  return matrix;
}
