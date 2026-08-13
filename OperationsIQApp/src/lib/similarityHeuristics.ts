/**
 * Query-aware smart defaults for the 1-D SAX similarity search.
 *
 * Most similarity knobs are NOT universal: the right value depends on the shape
 * of the reviewed query pattern (its sample count and its raw variability). This
 * module turns a query's summary statistics into sensible starting parameters
 * plus a plain-language rationale for each adapted field, so a non-technical
 * analyst gets good defaults without understanding SAX.
 *
 * Grounded in eventhouse/schema/40_sax_similarity_1d.kql + 30_sax_core.kql:
 *  - `znormThreshold` is compared against the query's RAW standard deviation in
 *    DATA UNITS (sax_znorm mean-centers when std < threshold), so a fixed value
 *    is not scale-invariant. We make it scale-relative to the query's std.
 *  - `queryLengthSymbols` is the PAA word length and must be <= the smallest
 *    window size = round(length * minScale). We derive it from the sample count
 *    so each segment averages a few points and always satisfies that bound.
 *  - `symbolTolerance` > 0 forces the slower symbolic pre-filter (which can prune
 *    true matches); <= 0 selects the fast fully-vectorized EXACT path. We suggest 0.
 *  - `alphabetSize` stays near the base of 4, nudged by length + variability.
 *  - scale sweep, topK, and the multivariate knobs are not query-derived; they
 *    keep their current defaults and are only reframed/regrouped in the UI.
 *
 * Pure, deterministic, browser-free, and fully unit-tested — no backend, no DOM.
 */

/** The full similarity parameter set (same keys as the page's `Params`). */
export interface SimilarityParams {
  queryLengthSymbols: number;
  alphabetSize: number;
  minScale: number;
  maxScale: number;
  scaleSteps: number;
  symbolTolerance: number;
  topK: number;
  znormThreshold: number;
  maxInterTrackDelay: number;
  perTrackTopK: number;
}

/**
 * The current, non-query-derived defaults. Kept here as the single source of
 * truth so the page, the agent tool, and these heuristics never drift apart.
 */
export const DEFAULT_SIMILARITY_PARAMS: SimilarityParams = {
  queryLengthSymbols: 8,
  alphabetSize: 4,
  minScale: 0.9,
  maxScale: 1.1,
  scaleSteps: 3,
  symbolTolerance: 1,
  topK: 5,
  znormThreshold: 0.01,
  maxInterTrackDelay: 2,
  perTrackTopK: 5,
};

/** Summary statistics of a query pattern at the effective (search-driven) resolution. */
export interface QueryStats {
  /** Number of samples in the query window (drives the PAA word length + scale bound). */
  length: number;
  /** Raw (population) standard deviation in DATA UNITS (drives the z-norm floor). */
  std: number;
  /** Peak-to-peak range (max - min) in data units. */
  range: number;
}

export type SimilarityMode = 'single' | 'multi';

/** Input to {@link suggestSimilarityParams}. */
export interface SuggestInput {
  mode: SimilarityMode;
  /**
   * Single mode: one {@link QueryStats}. Multi mode: one per track — the most
   * variable track is used to derive the shared parameters.
   */
  stats: QueryStats | QueryStats[];
  /**
   * The effective smallest scale ratio (params.minScale). The suggested PAA word
   * length is capped at floor(length * minScale) so it never exceeds the smallest
   * window the search will evaluate.
   */
  minScale: number;
}

/** Result of {@link suggestSimilarityParams}. */
export interface Suggestion {
  params: SimilarityParams;
  /** One plain-language line per query-adapted field, for the "smart defaults" note. */
  rationale: Partial<Record<keyof SimilarityParams, string>>;
}

/** Fraction of the query's std used as the scale-relative z-norm flatness floor. */
export const ZNORM_FRAC = 0.03;

const FLAT_EPS = 1e-9;
const ZNORM_MIN = 1e-6;
const ZNORM_MAX = 1e6;

// alphabetSize nudging thresholds.
const SHORT_LENGTH = 12;
const LONG_LENGTH = 48;
const HIGH_CV = 0.3;
const VERY_HIGH_CV = 0.4;

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Compute {@link QueryStats} from a raw sample series (in data units). Non-finite
 * samples are ignored. Returns zeros for an empty/all-flat series.
 */
export function computeQueryStats(values: number[]): QueryStats {
  const finite = values.filter((v) => Number.isFinite(v));
  const length = values.length;
  if (finite.length === 0) return { length, std: 0, range: 0 };
  let min = finite[0];
  let max = finite[0];
  let sum = 0;
  for (const v of finite) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / finite.length;
  let varAcc = 0;
  for (const v of finite) varAcc += (v - mean) * (v - mean);
  const std = Math.sqrt(varAcc / finite.length);
  return { length, std, range: max - min };
}

/**
 * Aggregate per-track stats to a single representative for shared parameters by
 * picking the MOST VARIABLE track (largest std). Ties resolve to the earliest
 * track, keeping the result deterministic. Empty input yields zeros.
 */
export function aggregateQueryStats(stats: QueryStats[]): QueryStats {
  if (stats.length === 0) return { length: 0, std: 0, range: 0 };
  let best = stats[0];
  for (let i = 1; i < stats.length; i++) {
    if (stats[i].std > best.std) best = stats[i];
  }
  return best;
}

/**
 * Derive smart starting parameters from a reviewed query pattern. All formulas
 * are clamped to the schema-enforced ranges, and the PAA word length is
 * guaranteed to satisfy queryLengthSymbols <= floor(length * minScale).
 */
export function suggestSimilarityParams(input: SuggestInput): Suggestion {
  const stat = Array.isArray(input.stats)
    ? aggregateQueryStats(input.stats)
    : input.stats;
  const { length, std, range } = stat;
  const minScale = Number.isFinite(input.minScale) && input.minScale > 0 ? input.minScale : 1;

  const params: SimilarityParams = { ...DEFAULT_SIMILARITY_PARAMS };
  const rationale: Partial<Record<keyof SimilarityParams, string>> = {};

  // --- queryLengthSymbols: ~4 samples per segment, capped by the smallest window ---
  const hardMax = Math.max(1, Math.floor(length * minScale));
  const upper = Math.min(32, hardMax);
  const lower = Math.min(4, upper);
  const queryLengthSymbols = clamp(Math.round(length / 4), lower, upper);
  params.queryLengthSymbols = queryLengthSymbols;
  rationale.queryLengthSymbols =
    length > 0
      ? `Set to ${queryLengthSymbols} segment${queryLengthSymbols === 1 ? '' : 's'} so each spans a few of the ~${length} samples in your pattern (kept within the shortest window it can match).`
      : `Kept at ${queryLengthSymbols} until a query pattern is reviewed.`;

  // --- alphabetSize: base 4, nudged by length + variability ---
  const nearFlat = std <= FLAT_EPS || range <= FLAT_EPS;
  const cv = range > FLAT_EPS ? std / range : 0;
  let alphabetSize = DEFAULT_SIMILARITY_PARAMS.alphabetSize;
  if (length >= LONG_LENGTH && cv >= HIGH_CV) {
    alphabetSize += cv >= VERY_HIGH_CV ? 2 : 1;
  } else if (length <= SHORT_LENGTH || nearFlat) {
    alphabetSize -= 1;
  }
  alphabetSize = clamp(alphabetSize, 3, 8);
  params.alphabetSize = alphabetSize;
  if (alphabetSize > DEFAULT_SIMILARITY_PARAMS.alphabetSize) {
    rationale.alphabetSize = `Raised to ${alphabetSize} levels because the pattern is long and highly variable, so finer height differences matter.`;
  } else if (alphabetSize < DEFAULT_SIMILARITY_PARAMS.alphabetSize) {
    rationale.alphabetSize = nearFlat
      ? `Lowered to ${alphabetSize} levels because the pattern is nearly flat, so fewer height buckets avoid chasing noise.`
      : `Lowered to ${alphabetSize} levels because the pattern is short, so fewer height buckets are more forgiving.`;
  } else {
    rationale.alphabetSize = `Kept at ${alphabetSize} levels — a balanced default for this pattern's length and variability.`;
  }

  // --- znormThreshold: scale-relative to the query's raw std (data units) ---
  const znormThreshold = clamp(ZNORM_FRAC * std, ZNORM_MIN, ZNORM_MAX);
  params.znormThreshold = znormThreshold;
  rationale.znormThreshold = nearFlat
    ? `Set to a tiny floor (${formatNum(znormThreshold)}) because the pattern is nearly flat; the search will mostly mean-center it.`
    : `Scaled to ${formatNum(ZNORM_FRAC)}× your pattern's variability (std ≈ ${formatNum(std)}), i.e. ${formatNum(znormThreshold)} in your data's units, instead of a fixed value that ignores scale.`;

  // --- symbolTolerance: exact for single-track, forgiving for multivariate ---
  const isMulti = input.mode === 'multi';
  params.symbolTolerance = isMulti ? 1 : 0;
  rationale.symbolTolerance = isMulti
    ? 'Allowing 1 SAX-symbol of mismatch so coordinated multi-signal matches survive small timing/quantization differences between tracks — the exact matcher often assembles nothing across tracks. Set to 0 to require exact symbolic alignment on every track.'
    : 'Using the exact, fully-vectorized matcher (faster, no true matches pruned). Raise above 0 only to allow looser symbolic near-misses.';

  return { params, rationale };
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1000 || abs < 1e-3) return n.toExponential(2);
  // Trim to at most 4 significant-ish decimals without trailing zeros.
  return parseFloat(n.toPrecision(4)).toString();
}
