import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMILARITY_PARAMS,
  ZNORM_FRAC,
  aggregateQueryStats,
  computeQueryStats,
  suggestSimilarityParams,
  type QueryStats,
} from './similarityHeuristics';

/** Build a sine-like sample series with a given length and amplitude. */
function sine(length: number, amplitude: number): number[] {
  return Array.from({ length }, (_, i) => amplitude * Math.sin((2 * Math.PI * i) / length));
}

describe('computeQueryStats', () => {
  it('reports length, population std, and range', () => {
    const s = computeQueryStats([0, 2, 4]);
    expect(s.length).toBe(3);
    expect(s.range).toBe(4);
    // population std of [0,2,4] = sqrt((4+0+4)/3) = sqrt(2.667) ≈ 1.633
    expect(s.std).toBeCloseTo(1.632993, 4);
  });

  it('ignores non-finite samples but keeps raw length', () => {
    const s = computeQueryStats([1, NaN, 3, Infinity]);
    expect(s.length).toBe(4);
    expect(s.range).toBe(2);
    expect(Number.isFinite(s.std)).toBe(true);
  });

  it('returns zeros for an empty series', () => {
    expect(computeQueryStats([])).toEqual({ length: 0, std: 0, range: 0 });
  });

  it('returns zero std and range for a flat series', () => {
    const s = computeQueryStats([5, 5, 5, 5]);
    expect(s.std).toBe(0);
    expect(s.range).toBe(0);
    expect(s.length).toBe(4);
  });
});

describe('aggregateQueryStats', () => {
  it('picks the most variable track (largest std)', () => {
    const a: QueryStats = { length: 20, std: 1, range: 3 };
    const b: QueryStats = { length: 20, std: 5, range: 10 };
    const c: QueryStats = { length: 20, std: 2, range: 4 };
    expect(aggregateQueryStats([a, b, c])).toBe(b);
  });

  it('resolves ties to the earliest track', () => {
    const a: QueryStats = { length: 10, std: 2, range: 5 };
    const b: QueryStats = { length: 12, std: 2, range: 6 };
    expect(aggregateQueryStats([a, b])).toBe(a);
  });

  it('returns zeros for empty input', () => {
    expect(aggregateQueryStats([])).toEqual({ length: 0, std: 0, range: 0 });
  });
});

describe('suggestSimilarityParams — queryLengthSymbols', () => {
  it('targets ~4 samples per segment for a typical pattern', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 40, std: 1, range: 4 },
      minScale: 0.9,
    });
    // round(40/4) = 10, within [4, min(32, floor(40*0.9)=36)]
    expect(params.queryLengthSymbols).toBe(10);
  });

  it('never exceeds floor(length * minScale) (safety bound)', () => {
    // A short pattern with a small minScale would push the naive value too high.
    const length = 24;
    const minScale = 0.2;
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length, std: 1, range: 3 },
      minScale,
    });
    const hardMax = Math.floor(length * minScale); // 4
    expect(params.queryLengthSymbols).toBeLessThanOrEqual(hardMax);
  });

  it('caps at 32 for very long patterns', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 500, std: 1, range: 4 },
      minScale: 0.9,
    });
    expect(params.queryLengthSymbols).toBe(32);
  });

  it('relaxes the lower bound when the window is tiny', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 3, std: 1, range: 2 },
      minScale: 0.9,
    });
    // floor(3*0.9)=2, so the value must be <= 2 even though the usual floor is 4.
    expect(params.queryLengthSymbols).toBeLessThanOrEqual(2);
    expect(params.queryLengthSymbols).toBeGreaterThanOrEqual(1);
  });

  it('is safe for an empty query (length 0)', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 0, std: 0, range: 0 },
      minScale: 0.9,
    });
    expect(params.queryLengthSymbols).toBeGreaterThanOrEqual(1);
  });
});

describe('suggestSimilarityParams — alphabetSize', () => {
  it('keeps the base of 4 for a moderate pattern', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 30, std: 1, range: 4 },
      minScale: 0.9,
    });
    expect(params.alphabetSize).toBe(4);
  });

  it('raises for a long, highly variable pattern', () => {
    const values = sine(120, 10); // std/range ≈ 0.35 (high)
    const stats = computeQueryStats(values);
    const { params } = suggestSimilarityParams({ mode: 'single', stats, minScale: 0.9 });
    expect(params.alphabetSize).toBeGreaterThan(4);
    expect(params.alphabetSize).toBeLessThanOrEqual(8);
  });

  it('lowers for a very short pattern', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 8, std: 1, range: 3 },
      minScale: 0.9,
    });
    expect(params.alphabetSize).toBe(3);
  });

  it('lowers for a near-flat pattern', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 60, std: 0, range: 0 },
      minScale: 0.9,
    });
    expect(params.alphabetSize).toBe(3);
  });

  it('clamps to the 3..8 range', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 400, std: 100, range: 100 }, // cv = 1.0, very high
      minScale: 0.9,
    });
    expect(params.alphabetSize).toBeGreaterThanOrEqual(3);
    expect(params.alphabetSize).toBeLessThanOrEqual(8);
  });
});

describe('suggestSimilarityParams — znormThreshold', () => {
  it('scales to a fraction of the query std', () => {
    const std = 20;
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 40, std, range: 60 },
      minScale: 0.9,
    });
    expect(params.znormThreshold).toBeCloseTo(ZNORM_FRAC * std, 6);
  });

  it('falls back to a tiny positive floor for a flat query', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 40, std: 0, range: 0 },
      minScale: 0.9,
    });
    expect(params.znormThreshold).toBeGreaterThan(0);
    expect(params.znormThreshold).toBeLessThan(1e-3);
  });

  it('is scale-relative: a 100x larger signal gets a 100x larger threshold', () => {
    const small = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 40, std: 1, range: 4 },
      minScale: 0.9,
    }).params.znormThreshold;
    const large = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 40, std: 100, range: 400 },
      minScale: 0.9,
    }).params.znormThreshold;
    expect(large / small).toBeCloseTo(100, 3);
  });
});

describe('suggestSimilarityParams — symbolTolerance and untouched defaults', () => {
  it('suggests 0 to select the fast exact path', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 40, std: 1, range: 4 },
      minScale: 0.9,
    });
    expect(params.symbolTolerance).toBe(0);
  });

  it('suggests 1 in multivariate mode so coordinated matches survive small timing differences', () => {
    const { params, rationale } = suggestSimilarityParams({
      mode: 'multi',
      stats: [
        { length: 40, std: 1, range: 4 },
        { length: 40, std: 2, range: 8 },
      ],
      minScale: 0.9,
    });
    expect(params.symbolTolerance).toBe(1);
    expect(rationale.symbolTolerance).toBeTruthy();
  });

  it('keeps scale, topK, and multivariate knobs at their defaults', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 40, std: 1, range: 4 },
      minScale: 0.9,
    });
    expect(params.minScale).toBe(DEFAULT_SIMILARITY_PARAMS.minScale);
    expect(params.maxScale).toBe(DEFAULT_SIMILARITY_PARAMS.maxScale);
    expect(params.scaleSteps).toBe(DEFAULT_SIMILARITY_PARAMS.scaleSteps);
    expect(params.topK).toBe(DEFAULT_SIMILARITY_PARAMS.topK);
    expect(params.maxInterTrackDelay).toBe(DEFAULT_SIMILARITY_PARAMS.maxInterTrackDelay);
    expect(params.perTrackTopK).toBe(DEFAULT_SIMILARITY_PARAMS.perTrackTopK);
  });
});

describe('suggestSimilarityParams — multivariate aggregation', () => {
  it('derives shared params from the most variable track', () => {
    const quiet: QueryStats = { length: 40, std: 1, range: 4 };
    const busy: QueryStats = { length: 40, std: 50, range: 200 };
    const multi = suggestSimilarityParams({
      mode: 'multi',
      stats: [quiet, busy],
      minScale: 0.9,
    });
    const fromBusy = suggestSimilarityParams({ mode: 'single', stats: busy, minScale: 0.9 });
    expect(multi.params.znormThreshold).toBeCloseTo(fromBusy.params.znormThreshold, 6);
  });
});

describe('suggestSimilarityParams — rationale + determinism', () => {
  it('produces a plain-language rationale for each adapted field', () => {
    const { rationale } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 40, std: 2, range: 8 },
      minScale: 0.9,
    });
    expect(rationale.queryLengthSymbols).toBeTruthy();
    expect(rationale.alphabetSize).toBeTruthy();
    expect(rationale.znormThreshold).toBeTruthy();
    expect(rationale.symbolTolerance).toBeTruthy();
  });

  it('is deterministic for identical input', () => {
    const input = {
      mode: 'single' as const,
      stats: { length: 37, std: 3.5, range: 11 },
      minScale: 0.85,
    };
    const a = suggestSimilarityParams(input);
    const b = suggestSimilarityParams(input);
    expect(a).toEqual(b);
  });

  it('guards against a non-positive minScale', () => {
    const { params } = suggestSimilarityParams({
      mode: 'single',
      stats: { length: 40, std: 1, range: 4 },
      minScale: 0,
    });
    expect(params.queryLengthSymbols).toBeGreaterThanOrEqual(1);
  });
});
