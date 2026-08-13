// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { KustoTable } from './eventhouse';
import {
  parseForecastResult,
  zForConfidence,
  exceedanceProbability,
  quantileBands,
  empiricalQuantile,
  MIN_RESIDUALS,
  MIN_BACKTEST_FOLDS,
  planBacktest,
  parseBacktestResult,
  applyMeasuredBands,
  horizonErrorQuantile,
  pooledRmse,
  selectForecastModel,
  modelSelectionCaption,
  summarizeForecast,
  OUTLIER_SELECTION_MARGIN,
  recentWindowPoints,
  selectHistoryWindow,
  windowSelectionCaption,
  A4_RECENT_WINDOW_FRACTION,
  type ForecastResult,
  type HorizonErrorCalibration,
  type ModelSelection,
  type WindowSelection,
} from './forecast';

/**
 * Build a one-row Kusto table mirroring the `buildForecastQuery` projection:
 * SignalId, Timestamp, Value (raw observed), ModelValue (linearly-filled model
 * input), Forecast, Sigma, HorizonPoints, Cnt.
 */
function forecastTable(opts: {
  timestamps: string[];
  value: (number | null)[];
  modelValue: (number | null)[];
  forecast: (number | null)[];
  sigma: number;
  horizonPoints: number;
  cnt: (number | null)[];
  residuals?: (number | null)[];
}): KustoTable {
  return {
    name: 'PrimaryResult',
    columns: [
      { name: 'SignalId', type: 'string' },
      { name: 'Timestamp', type: 'dynamic' },
      { name: 'Value', type: 'dynamic' },
      { name: 'ModelValue', type: 'dynamic' },
      { name: 'Forecast', type: 'dynamic' },
      { name: 'Sigma', type: 'real' },
      { name: 'Residuals', type: 'dynamic' },
      { name: 'HorizonPoints', type: 'long' },
      { name: 'Cnt', type: 'dynamic' },
    ],
    rows: [
      [
        'tag-1',
        opts.timestamps,
        opts.value,
        opts.modelValue,
        opts.forecast,
        opts.sigma,
        opts.residuals ?? [],
        opts.horizonPoints,
        opts.cnt,
      ],
    ],
  };
}

// 9 hourly bins: 6 history + 3 horizon (forecastStart == 6).
const TIMESTAMPS = [
  '2024-01-01T00:00:00Z',
  '2024-01-01T01:00:00Z',
  '2024-01-01T02:00:00Z',
  '2024-01-01T03:00:00Z',
  '2024-01-01T04:00:00Z',
  '2024-01-01T05:00:00Z',
  '2024-01-01T06:00:00Z',
  '2024-01-01T07:00:00Z',
  '2024-01-01T08:00:00Z',
];

describe('parseForecastResult raw/model separation + gap diagnostics', () => {
  // History: observed at 0,3,4; gaps (Cnt==0) at 1,2 (run of 2) and a trailing
  // gap at 5. Horizon bins 6,7,8 have Cnt==0 by default but must not be imputed.
  const gapTable = forecastTable({
    timestamps: TIMESTAMPS,
    value: [10, null, null, 12, 13, null, null, null, null],
    // ModelValue[5] deliberately differs (99) so we can prove the bridge uses
    // the OBSERVED value (13 at index 4), not the filled model input.
    modelValue: [10, 10.67, 11.33, 12, 13, 99, null, null, null],
    forecast: [null, null, null, null, null, null, 14, 15, 16],
    sigma: 1,
    horizonPoints: 3,
    cnt: [1, 0, 0, 1, 1, 0, 0, 0, 0],
  });

  it('keeps actual observed-only, null exactly at Cnt==0 history bins', () => {
    const r = parseForecastResult(gapTable, 0.95)!;
    expect(r).not.toBeNull();
    expect(r.forecastStart).toBe(6);
    // Observed bins keep their raw value.
    expect(r.actual[0]).toBe(10);
    expect(r.actual[3]).toBe(12);
    expect(r.actual[4]).toBe(13);
    // Gap bins are forced null.
    expect(r.actual[1]).toBeNull();
    expect(r.actual[2]).toBeNull();
    expect(r.actual[5]).toBeNull();
    // Horizon bins carry no observed value.
    expect(r.actual[6]).toBeNull();
    expect(r.actual[7]).toBeNull();
    expect(r.actual[8]).toBeNull();
  });

  it('flags imputed only on Cnt==0 history bins (never on observed or horizon)', () => {
    const r = parseForecastResult(gapTable, 0.95)!;
    expect(r.imputed).toEqual([
      false, // 0 observed
      true, // 1 gap
      true, // 2 gap
      false, // 3 observed
      false, // 4 observed
      true, // 5 trailing gap
      false, // 6 horizon
      false, // 7 horizon
      false, // 8 horizon
    ]);
  });

  it('carries the filled model input at imputed bins', () => {
    const r = parseForecastResult(gapTable, 0.95)!;
    expect(r.modelInput[1]).toBeCloseTo(10.67);
    expect(r.modelInput[2]).toBeCloseTo(11.33);
    expect(r.modelInput[5]).toBe(99);
  });

  it('computes longestGapBins and trailingStaleBins over history only', () => {
    const r = parseForecastResult(gapTable, 0.95)!;
    expect(r.coverage).toBeDefined();
    expect(r.coverage!.historyBins).toBe(6);
    expect(r.coverage!.missingBins).toBe(3);
    expect(r.coverage!.missingFraction).toBeCloseTo(0.5);
    expect(r.coverage!.longestGapBins).toBe(2);
    expect(r.coverage!.trailingStaleBins).toBe(1);
  });

  it('anchors the forecast bridge to the last OBSERVED value even with a trailing gap', () => {
    const r = parseForecastResult(gapTable, 0.95)!;
    // Bridge index is forecastStart - 1 == 5, which is itself a gap. It must use
    // the last observed value (13 at index 4), not modelInput[5] (99).
    expect(r.forecast[5]).toBe(13);
    expect(r.lower[5]).toBe(13);
    expect(r.upper[5]).toBe(13);
  });
});

describe('parseForecastResult no-gap series', () => {
  const cleanTable = forecastTable({
    timestamps: TIMESTAMPS,
    value: [10, 11, 12, 13, 14, 15, null, null, null],
    modelValue: [10, 11, 12, 13, 14, 15, null, null, null],
    forecast: [null, null, null, null, null, null, 16, 17, 18],
    sigma: 1,
    horizonPoints: 3,
    cnt: [1, 1, 1, 1, 1, 1, 0, 0, 0],
  });

  it('reports zero gaps, no staleness, and no imputed bins', () => {
    const r = parseForecastResult(cleanTable, 0.95)!;
    expect(r.coverage!.longestGapBins).toBe(0);
    expect(r.coverage!.trailingStaleBins).toBe(0);
    expect(r.coverage!.missingBins).toBe(0);
    expect(r.imputed.every((v) => v === false)).toBe(true);
    // actual mirrors the observed history exactly.
    expect(r.actual.slice(0, 6)).toEqual([10, 11, 12, 13, 14, 15]);
    // Bridge uses the last observed value (15).
    expect(r.forecast[5]).toBe(15);
  });
});

describe('zForConfidence exact two-sided normal z', () => {
  it('matches standard table values', () => {
    // Two-sided z = Phi^-1((1+c)/2).
    expect(zForConfidence(0.95)).toBeCloseTo(1.9600, 3);
    expect(zForConfidence(0.9)).toBeCloseTo(1.6449, 3);
    expect(zForConfidence(0.99)).toBeCloseTo(2.5758, 3);
    expect(zForConfidence(0.8)).toBeCloseTo(1.2816, 3);
  });

  it('no longer snaps: returns exact z for a non-table confidence', () => {
    // 0.85 would previously snap to 0.8 or 0.9; the exact value is ~1.4395.
    expect(zForConfidence(0.85)).toBeCloseTo(1.4395, 3);
  });

  it('is strictly increasing in confidence', () => {
    const levels = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98, 0.99, 0.999];
    for (let i = 1; i < levels.length; i++) {
      expect(zForConfidence(levels[i])).toBeGreaterThan(zForConfidence(levels[i - 1]));
    }
  });

  it('stays finite at extreme confidence', () => {
    const z = zForConfidence(0.999);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeCloseTo(3.2905, 3);
  });
});

/**
 * Build a bare ForecastResult (plain interface, no KustoTable needed) with the
 * given horizon forecast values. History fills the first `forecastStart` bins.
 */
function makeResult(opts: {
  forecast: number[];
  sigma: number;
  forecastStart?: number;
  residuals?: number[];
}): ForecastResult {
  const forecastStart = opts.forecastStart ?? 2;
  const n = forecastStart + opts.forecast.length;
  const x = Array.from({ length: n }, (_, i) => i * 3_600_000);
  const forecast: (number | null)[] = new Array(n).fill(null);
  for (let k = 0; k < opts.forecast.length; k++) forecast[forecastStart + k] = opts.forecast[k];
  const residuals = opts.residuals ?? [];
  return {
    tagId: 'tag-1',
    x,
    actual: new Array(n).fill(null),
    modelInput: new Array(n).fill(null),
    imputed: new Array(n).fill(false),
    forecast,
    lower: new Array(n).fill(null),
    upper: new Array(n).fill(null),
    forecastStart,
    sigma: opts.sigma,
    residuals,
    calibration: {
      method: residuals.length >= MIN_RESIDUALS ? 'empirical' : 'normal',
      sampleCount: residuals.length,
    },
  };
}

describe('exceedanceProbability', () => {
  it('per-step sd grows with sqrt(steps) and any = 1 - prod(1 - perStep)', () => {
    const result = makeResult({ forecast: [10, 10, 10], sigma: 2 });
    const threshold = 12;
    const r = exceedanceProbability(result, threshold, 'above');

    const perStep = [1, 2, 3].map((step) => r.perStep[result.forecastStart + step - 1] as number);
    // Probability rises as the band widens (constant forecast, growing sd).
    expect(perStep[0]).toBeLessThan(perStep[1]);
    expect(perStep[1]).toBeLessThan(perStep[2]);

    // anyBreachProbability == 1 - product(1 - perStep).
    const expectedAny = 1 - perStep.reduce((acc, p) => acc * (1 - p), 1);
    expect(r.anyBreachProbability).toBeCloseTo(expectedAny, 10);
  });

  it('reports peakProbability/peakIndex and firstLikelyIndex correctly', () => {
    // Rising forecast well past threshold => probability increases; last bin peaks.
    const result = makeResult({ forecast: [11, 13, 20], sigma: 1 });
    const r = exceedanceProbability(result, 12, 'above');
    // Peak is at the final horizon bin (highest forecast, widest band).
    expect(r.peakIndex).toBe(result.forecastStart + 2);
    expect(r.peakProbability).toBeCloseTo(r.perStep[result.forecastStart + 2] as number, 12);
    // First bin where prob >= 0.5: forecast 13 > threshold 12 at step 2.
    expect(r.firstLikelyIndex).toBe(result.forecastStart + 1);
  });

  it('degenerate sd<=0 branch: deterministic 1/0 for above', () => {
    const result = makeResult({ forecast: [15, 5, 15], sigma: 0 });
    const r = exceedanceProbability(result, 10, 'above');
    expect(r.perStep[result.forecastStart]).toBe(1); // 15 > 10
    expect(r.perStep[result.forecastStart + 1]).toBe(0); // 5 < 10
    expect(r.perStep[result.forecastStart + 2]).toBe(1); // 15 > 10
    expect(r.anyBreachProbability).toBe(1);
  });

  it('degenerate sd<=0 branch: deterministic 1/0 for below', () => {
    const result = makeResult({ forecast: [5, 15, 5], sigma: 0 });
    const r = exceedanceProbability(result, 10, 'below');
    expect(r.perStep[result.forecastStart]).toBe(1); // 5 < 10
    expect(r.perStep[result.forecastStart + 1]).toBe(0); // 15 > 10
    expect(r.perStep[result.forecastStart + 2]).toBe(1); // 5 < 10
    expect(r.anyBreachProbability).toBe(1);
  });
});

describe('quantileBands transform', () => {
  it('P50 equals the point forecast; P10 < P50 < P90; symmetric bounds', () => {
    const result = makeResult({ forecast: [10, 10, 10], sigma: 2 });
    const [p10, p50, p90] = quantileBands(result, [0.1, 0.5, 0.9]);

    for (let i = result.forecastStart; i < result.x.length; i++) {
      const f = result.forecast[i] as number;
      // P50 is exactly the point forecast.
      expect(p50.values[i]).toBeCloseTo(f, 10);
      // Ordering holds at every horizon bin.
      expect(p10.values[i] as number).toBeLessThan(p50.values[i] as number);
      expect(p50.values[i] as number).toBeLessThan(p90.values[i] as number);
      // Symmetric probs => lower/upper equidistant from the forecast.
      const below = f - (p10.values[i] as number);
      const above = (p90.values[i] as number) - f;
      expect(below).toBeCloseTo(above, 10);
    }
  });
});

describe('empiricalQuantile', () => {
  const sorted = [1, 2, 3, 4, 5];

  it('interpolates between order statistics (median, 0.1, 0.9)', () => {
    expect(empiricalQuantile(sorted, 0.5)).toBeCloseTo(3, 12); // exact middle
    expect(empiricalQuantile(sorted, 0.1)).toBeCloseTo(1.4, 12); // 0.1*4 = 0.4
    expect(empiricalQuantile(sorted, 0.9)).toBeCloseTo(4.6, 12); // 0.9*4 = 3.6
  });

  it('returns the endpoints at p=0 and p=1 and clamps out-of-range p', () => {
    expect(empiricalQuantile(sorted, 0)).toBe(1);
    expect(empiricalQuantile(sorted, 1)).toBe(5);
    expect(empiricalQuantile(sorted, -0.5)).toBe(1);
    expect(empiricalQuantile(sorted, 1.5)).toBe(5);
  });

  it('handles length-0 (=> 0) and length-1 (=> that value) edge cases', () => {
    expect(empiricalQuantile([], 0.5)).toBe(0);
    expect(empiricalQuantile([42], 0.5)).toBe(42);
    expect(empiricalQuantile([42], 0)).toBe(42);
    expect(empiricalQuantile([42], 1)).toBe(42);
  });
});

// A clearly right-skewed residual sample (heavy positive tail), 24 values so it
// crosses MIN_RESIDUALS and triggers the empirical path.
const SKEWED_RESIDUALS = [
  -2, -1.5, -1, -1, -0.5, -0.5, -0.5, -0.5, 0, 0, 0, 0, 0.5, 0.5, 1, 1, 2, 3, 5,
  8, 12, 15, 20, 25,
];

describe('parseForecastResult empirical residual calibration', () => {
  it('builds an ASYMMETRIC band whose wider side matches the (positive) skew', () => {
    const table = forecastTable({
      timestamps: TIMESTAMPS,
      value: [10, 11, 12, 13, 14, 15, null, null, null],
      modelValue: [10, 11, 12, 13, 14, 15, null, null, null],
      forecast: [null, null, null, null, null, null, 16, 17, 18],
      sigma: 5,
      horizonPoints: 3,
      cnt: [1, 1, 1, 1, 1, 1, 0, 0, 0],
      residuals: SKEWED_RESIDUALS,
    });
    const r = parseForecastResult(table, 0.95)!;
    expect(r.calibration.method).toBe('empirical');
    expect(r.calibration.sampleCount).toBe(SKEWED_RESIDUALS.length);

    const i = r.forecastStart; // first horizon bin, stepsAhead = 1
    const f = r.forecast[i] as number;
    const up = (r.upper[i] as number) - f;
    const down = f - (r.lower[i] as number);
    // Asymmetric: the two half-widths differ, and the heavier tail is the upper.
    expect(up).not.toBeCloseTo(down, 6);
    expect(up).toBeGreaterThan(down);

    // Empirical band matches the residual quantiles scaled by sqrt(steps).
    const sortedAsc = [...SKEWED_RESIDUALS].sort((a, b) => a - b);
    const qLo = empiricalQuantile(sortedAsc, 0.025);
    const qHi = empiricalQuantile(sortedAsc, 0.975);
    for (let k = 0; k < 3; k++) {
      const idx = r.forecastStart + k;
      const grow = Math.sqrt(k + 1);
      const fk = r.forecast[idx] as number;
      expect(r.lower[idx] as number).toBeCloseTo(fk + qLo * grow, 10);
      expect(r.upper[idx] as number).toBeCloseTo(fk + qHi * grow, 10);
    }
  });

  it('falls back to the EXACT normal band when residuals < MIN_RESIDUALS', () => {
    const fewResiduals = Array.from({ length: MIN_RESIDUALS - 1 }, (_, i) => i - 5);
    const sigma = 2;
    const conf = 0.95;
    const table = forecastTable({
      timestamps: TIMESTAMPS,
      value: [10, 11, 12, 13, 14, 15, null, null, null],
      modelValue: [10, 11, 12, 13, 14, 15, null, null, null],
      forecast: [null, null, null, null, null, null, 16, 17, 18],
      sigma,
      horizonPoints: 3,
      cnt: [1, 1, 1, 1, 1, 1, 0, 0, 0],
      residuals: fewResiduals,
    });
    const r = parseForecastResult(table, conf)!;
    expect(r.calibration.method).toBe('normal');
    expect(r.calibration.sampleCount).toBe(fewResiduals.length);

    const z = zForConfidence(conf);
    for (let k = 0; k < 3; k++) {
      const idx = r.forecastStart + k;
      const fk = r.forecast[idx] as number;
      const half = z * sigma * Math.sqrt(k + 1);
      expect(r.lower[idx] as number).toBeCloseTo(fk - half, 10);
      expect(r.upper[idx] as number).toBeCloseTo(fk + half, 10);
    }
  });

  it('counts only finite residuals and flips method at the MIN_RESIDUALS threshold', () => {
    const base = {
      timestamps: TIMESTAMPS,
      value: [10, 11, 12, 13, 14, 15, null, null, null] as (number | null)[],
      modelValue: [10, 11, 12, 13, 14, 15, null, null, null] as (number | null)[],
      forecast: [null, null, null, null, null, null, 16, 17, 18] as (number | null)[],
      sigma: 1,
      horizonPoints: 3,
      cnt: [1, 1, 1, 1, 1, 1, 0, 0, 0] as (number | null)[],
    };

    // 19 finite values padded with nulls/NaN => still normal (finite count only).
    const justUnder = [
      ...Array.from({ length: MIN_RESIDUALS - 1 }, (_, i) => i - 5),
      null,
      Number.NaN,
    ];
    const under = parseForecastResult(forecastTable({ ...base, residuals: justUnder }), 0.95)!;
    expect(under.calibration.sampleCount).toBe(MIN_RESIDUALS - 1);
    expect(under.calibration.method).toBe('normal');

    // 20 finite values => empirical.
    const atThreshold = Array.from({ length: MIN_RESIDUALS }, (_, i) => i - 5);
    const at = parseForecastResult(forecastTable({ ...base, residuals: atThreshold }), 0.95)!;
    expect(at.calibration.sampleCount).toBe(MIN_RESIDUALS);
    expect(at.calibration.method).toBe('empirical');
  });
});

describe('exceedanceProbability empirical per-step', () => {
  it('per-step probability equals the residual-fraction definition', () => {
    // 20 residuals: integers -10..9. Single horizon bin, stepsAhead = 1.
    const residuals = Array.from({ length: 20 }, (_, i) => i - 10);
    const result = makeResult({ forecast: [10], sigma: 3, residuals });
    expect(result.calibration.method).toBe('empirical');

    const threshold = 12; // f + r > 12  <=>  r > 2  => {3..9} = 7 of 20
    const r = exceedanceProbability(result, threshold, 'above');
    expect(r.perStep[result.forecastStart] as number).toBeCloseTo(7 / 20, 12);

    // 'below': f + r < 12  <=>  r < 2  => {-10..1} = 12 of 20
    const rb = exceedanceProbability(result, threshold, 'below');
    expect(rb.perStep[result.forecastStart] as number).toBeCloseTo(12 / 20, 12);
  });
});

describe('exceedanceProbability trajectory anyBreach', () => {
  // 21 residuals (>= MIN_RESIDUALS so empirical), all 0 except a spike of 3 at
  // indices 5 and 15. H = 2 horizon bins => W = 21 - 2 + 1 = 20 (>= MIN_TRAJECTORIES).
  const spikedResiduals = () =>
    Array.from({ length: 21 }, (_, i) => (i === 5 || i === 15 ? 3 : 0));

  it('estimates the aggregate from the residual-trajectory ensemble (hand-counted)', () => {
    const residuals = spikedResiduals();
    const result = makeResult({ forecast: [10, 10], sigma: 3, residuals });
    expect(result.calibration.method).toBe('empirical');

    // A window s (s in 0..19) breaches iff (10 + r[s] > 12) OR (10 + r[s] + r[s+1] > 12),
    // i.e. r[s] == 3 OR r[s+1] == 3. With spikes at 5 and 15 that is s in {4,5,14,15}
    // => 4 of 20 windows breach.
    const r = exceedanceProbability(result, 12, 'above');
    expect(r.anyBreachMethod).toBe('trajectory');
    expect(r.anyBreachProbability).toBeCloseTo(4 / 20, 12);
  });

  it('differs from the per-bin independence product', () => {
    const residuals = spikedResiduals();
    const result = makeResult({ forecast: [10, 10], sigma: 3, residuals });
    const r = exceedanceProbability(result, 12, 'above');

    // Independence product over the horizon per-step probabilities.
    const horizon = r.perStep
      .slice(result.forecastStart)
      .filter((p): p is number => p != null);
    const independence = 1 - horizon.reduce((acc, p) => acc * (1 - p), 1);

    // Both per-step probs are 2/21, so independence = 1 - (19/21)^2 ≈ 0.18141,
    // while the dependency-preserving trajectory estimate is exactly 0.2.
    expect(independence).toBeCloseTo(1 - (19 / 21) ** 2, 12);
    expect(r.anyBreachProbability).toBeCloseTo(0.2, 12);
    expect(Math.abs(r.anyBreachProbability - independence)).toBeGreaterThan(0.01);
    expect(r.anyBreachProbability).not.toBeCloseTo(independence, 2);
  });

  it('falls back to independence when there are too few residual windows', () => {
    // 21 residuals (empirical) but H = 3 => W = 21 - 3 + 1 = 19 < MIN_TRAJECTORIES.
    const residuals = spikedResiduals();
    const result = makeResult({ forecast: [10, 10, 10], sigma: 3, residuals });
    expect(result.calibration.method).toBe('empirical');

    const r = exceedanceProbability(result, 12, 'above');
    expect(r.anyBreachMethod).toBe('independent');

    const horizon = r.perStep
      .slice(result.forecastStart)
      .filter((p): p is number => p != null);
    const independence = 1 - horizon.reduce((acc, p) => acc * (1 - p), 1);
    expect(r.anyBreachProbability).toBeCloseTo(independence, 12);
  });

  it('uses independence for the normal (no-residuals) calibration', () => {
    const result = makeResult({ forecast: [10, 10, 10], sigma: 2 });
    expect(result.calibration.method).toBe('normal');

    const r = exceedanceProbability(result, 12, 'above');
    expect(r.anyBreachMethod).toBe('independent');

    const horizon = r.perStep
      .slice(result.forecastStart)
      .filter((p): p is number => p != null);
    const independence = 1 - horizon.reduce((acc, p) => acc * (1 - p), 1);
    expect(r.anyBreachProbability).toBeCloseTo(independence, 12);
  });
});

describe('planBacktest', () => {
  it('produces a feasible plan with a valid fit window and >= minFolds folds', () => {
    // 1440 hourly history bins, 24-step horizon.
    const plan = planBacktest(1440, 24);
    expect(plan.feasible).toBe(true);
    expect(plan.folds).toBeGreaterThanOrEqual(20);
    // Fit window stays within [minHistory, M - H] and leaves room for the horizon.
    const minHistory = Math.max(2 * 24, 24);
    expect(plan.historyPoints).toBeGreaterThanOrEqual(minHistory);
    expect(plan.historyPoints).toBeLessThanOrEqual(1440 - 24);
    expect(plan.foldStep).toBeGreaterThanOrEqual(1);
    // Every field is finite and non-negative (no NaN / negative leakage).
    for (const v of [plan.historyPoints, plan.foldStep, plan.folds]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('marks tiny histories infeasible without producing NaN', () => {
    const plan = planBacktest(30, 24);
    expect(plan.feasible).toBe(false);
    expect(plan.folds).toBe(0);
    for (const v of [plan.historyPoints, plan.foldStep, plan.folds]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('parseBacktestResult', () => {
  /** Build a Kusto table mirroring the buildBacktestQuery projection. */
  function backtestTable(
    rows: [string, number | string, (number | null)[], number][],
  ): KustoTable {
    return {
      name: 'PrimaryResult',
      columns: [
        { name: 'SignalId', type: 'string' },
        { name: 'h', type: 'long' },
        { name: 'Errors', type: 'dynamic' },
        { name: 'Folds', type: 'long' },
      ],
      rows: rows.map((r) => [r[0], r[1], r[2], r[3]]),
    };
  }

  it('sorts by h, indexes per horizon, and drops non-finite errors', () => {
    // Rows arrive out of order; h=3 comes as a string; h=2 carries a null and an
    // Infinity that must both be dropped from perHorizonErrors and folds.
    const table = backtestTable([
      ['tag-1', '3', [7, 8], 2],
      ['tag-1', 1, [1, 2, 3], 3],
      ['tag-1', 2, [4, null, Infinity, 6], 3],
    ]);
    const cal = parseBacktestResult(table);
    expect(cal.horizonPoints).toBe(3);
    expect(cal.perHorizonErrors).toEqual([
      [1, 2, 3],
      [4, 6],
      [7, 8],
    ]);
    expect(cal.foldsPerHorizon).toEqual([3, 2, 2]);
  });

  it('returns empty calibration for a missing/empty table', () => {
    const empty: KustoTable = { name: 'PrimaryResult', columns: [], rows: [] };
    expect(parseBacktestResult(empty)).toEqual({
      perHorizonErrors: [],
      foldsPerHorizon: [],
      horizonPoints: 0,
    });
  });
});

describe('horizonErrorQuantile', () => {
  it('matches empiricalQuantile on a sorted copy of unsorted samples', () => {
    const samples = [5, 3, 9, 1, 7, 2, 8, 4, 6];
    const sorted = [...samples].sort((a, b) => a - b);
    expect(horizonErrorQuantile(samples, 0.5)).toBe(5); // P50 of 1..9
    expect(horizonErrorQuantile(samples, 0.5)).toBe(empiricalQuantile(sorted, 0.5));
    expect(horizonErrorQuantile(samples, 0.25)).toBe(empiricalQuantile(sorted, 0.25));
    expect(horizonErrorQuantile(samples, 0.9)).toBe(empiricalQuantile(sorted, 0.9));
    // Does not mutate the caller's array.
    expect(samples[0]).toBe(5);
  });
});

/** Inclusive integer range [lo, hi]; length hi - lo + 1. */
const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

/** Build a HorizonErrorCalibration from per-horizon error arrays. */
function makeCalibration(perHorizonErrors: number[][]): HorizonErrorCalibration {
  return {
    perHorizonErrors,
    foldsPerHorizon: perHorizonErrors.map((e) => e.length),
    horizonPoints: perHorizonErrors.length,
  };
}

/** makeResult + a forecast-anchor bin at forecastStart-1 (with band anchored). */
function makeAnchoredResult(opts: {
  forecast: number[];
  anchor: number;
  residuals?: number[];
}): ForecastResult {
  const base = makeResult({ forecast: opts.forecast, sigma: 1, residuals: opts.residuals });
  base.forecast[base.forecastStart - 1] = opts.anchor;
  base.lower[base.forecastStart - 1] = opts.anchor;
  base.upper[base.forecastStart - 1] = opts.anchor;
  return base;
}

describe('applyMeasuredBands', () => {
  // Asymmetric per-horizon error samples (median != 0) prove the band is
  // f + errorQuantile, NOT a symmetric f ± something.
  const h1 = range(-5, 15); // 21 folds, median +5
  const h2 = range(0, 20); //  21 folds, median +10
  const h3 = range(-10, 10); // 21 folds, median 0

  it('usable calibration builds measured, asymmetric, bias-aware bands', () => {
    const result = makeAnchoredResult({ forecast: [10, 20, 30], anchor: 5 });
    const cal = makeCalibration([h1, h2, h3]);
    const conf = 0.9;
    const out = applyMeasuredBands(result, cal, conf);

    expect(out).not.toBe(result); // new object
    expect(out.calibration.method).toBe('backtest');
    // sampleCount = min folds across horizon steps.
    expect(out.calibration.sampleCount).toBe(21);
    expect(out.horizonCalibration).toBe(cal);
    // Point forecast is untouched.
    expect(out.forecast).toEqual(result.forecast);

    const samplesByStep = [h1, h2, h3];
    for (let step = 1; step <= 3; step++) {
      const i = result.forecastStart + step - 1;
      const f = result.forecast[i] as number;
      const s = samplesByStep[step - 1];
      expect(out.lower[i]).toBeCloseTo(f + horizonErrorQuantile(s, (1 - conf) / 2), 10);
      expect(out.upper[i]).toBeCloseTo(f + horizonErrorQuantile(s, (1 + conf) / 2), 10);
      // Asymmetric: distance below != distance above for a biased sample set.
      const below = f - (out.lower[i] as number);
      const above = (out.upper[i] as number) - f;
      if (step !== 3) expect(below).not.toBeCloseTo(above, 6);
    }

    // Join anchor equals the (unchanged) forecast anchor.
    const anchorIdx = result.forecastStart - 1;
    expect(out.lower[anchorIdx]).toBe(result.forecast[anchorIdx]);
    expect(out.upper[anchorIdx]).toBe(result.forecast[anchorIdx]);
  });

  it('returns the input UNCHANGED when a horizon step has too few folds', () => {
    const result = makeAnchoredResult({ forecast: [10, 20, 30], anchor: 5 });
    const short = range(1, MIN_BACKTEST_FOLDS - 1); // fewer than MIN_BACKTEST_FOLDS
    const cal = makeCalibration([h1, short, h3]);
    const out = applyMeasuredBands(result, cal, 0.9);
    expect(out).toBe(result); // identity: band/method untouched
    expect(out.calibration.method).not.toBe('backtest');
  });

  it('returns the input UNCHANGED when the backtest does not cover the horizon', () => {
    const result = makeAnchoredResult({ forecast: [10, 20, 30], anchor: 5 });
    const cal = makeCalibration([h1, h2]); // horizonPoints 2 < horizon 3
    const out = applyMeasuredBands(result, cal, 0.9);
    expect(out).toBe(result);
    expect(out.calibration.method).not.toBe('backtest');
  });
});

describe('quantileBands measured (backtest) calibration', () => {
  const h1 = range(-5, 15); // median +5
  const h2 = range(0, 20); // median +10
  const h3 = range(-10, 10); // median 0

  it('uses measured per-horizon samples; P50 == f + median error; P10<P50<P90', () => {
    const base = makeAnchoredResult({ forecast: [10, 20, 30], anchor: 5 });
    const cal = makeCalibration([h1, h2, h3]);
    const result = applyMeasuredBands(base, cal, 0.9);
    expect(result.calibration.method).toBe('backtest');

    const [p10, p50, p90] = quantileBands(result, [0.1, 0.5, 0.9]);
    const samplesByStep = [h1, h2, h3];
    for (let step = 1; step <= 3; step++) {
      const i = result.forecastStart + step - 1;
      const f = result.forecast[i] as number;
      const s = samplesByStep[step - 1];
      expect(p50.values[i]).toBeCloseTo(f + horizonErrorQuantile(s, 0.5), 10);
      expect(p10.values[i]).toBeCloseTo(f + horizonErrorQuantile(s, 0.1), 10);
      expect(p90.values[i]).toBeCloseTo(f + horizonErrorQuantile(s, 0.9), 10);
      expect(p10.values[i] as number).toBeLessThan(p50.values[i] as number);
      expect(p50.values[i] as number).toBeLessThan(p90.values[i] as number);
    }
    // Measured P50 for a biased horizon reflects the median error, not f.
    const iBiased = result.forecastStart; // step 1, median +5
    expect(p50.values[iBiased]).not.toBeCloseTo(result.forecast[iBiased] as number, 6);
  });
});

describe('exceedanceProbability measured (backtest) calibration', () => {
  const h1 = range(-5, 15);
  const h2 = range(0, 20);
  const h3 = range(-10, 10);

  it('per-step prob equals the measured breach fraction (no sqrt-time scaling)', () => {
    const base = makeAnchoredResult({ forecast: [10, 20, 30], anchor: 5 });
    const cal = makeCalibration([h1, h2, h3]);
    const result = applyMeasuredBands(base, cal, 0.9);
    const threshold = 22;
    const r = exceedanceProbability(result, threshold, 'above');

    const samplesByStep = [h1, h2, h3];
    for (let step = 1; step <= 3; step++) {
      const i = result.forecastStart + step - 1;
      const f = result.forecast[i] as number;
      const s = samplesByStep[step - 1];
      const breaches = s.filter((e) => f + e > threshold).length;
      expect(r.perStep[i]).toBeCloseTo(breaches / s.length, 12);
    }
  });

  it('aggregate uses trajectory when residuals suffice, else independent', () => {
    const cal = makeCalibration([h1, h2, h3]);
    // Enough contiguous residual windows (R - H + 1 >= MIN_TRAJECTORIES).
    const manyResiduals = Array.from({ length: 25 }, (_, i) => (i % 5) - 2);
    const withResiduals = applyMeasuredBands(
      makeAnchoredResult({ forecast: [10, 20, 30], anchor: 5, residuals: manyResiduals }),
      cal,
      0.9,
    );
    const rTraj = exceedanceProbability(withResiduals, 22, 'above');
    expect(rTraj.anyBreachMethod).toBe('trajectory');

    // No residuals => trajectory ensemble unavailable => independence product.
    const noResiduals = applyMeasuredBands(
      makeAnchoredResult({ forecast: [10, 20, 30], anchor: 5, residuals: [] }),
      cal,
      0.9,
    );
    const rIndep = exceedanceProbability(noResiduals, 22, 'above');
    expect(rIndep.anyBreachMethod).toBe('independent');
  });
});

describe('pooledRmse', () => {
  const cal = (perHorizonErrors: number[][]): HorizonErrorCalibration => ({
    perHorizonErrors,
    foldsPerHorizon: perHorizonErrors.map((e) => e.length),
    horizonPoints: perHorizonErrors.length,
  });

  it('pools every per-horizon error into a single RMS', () => {
    // [[3,4],[0]] -> sqrt((9+16+0)/3) = sqrt(25/3).
    expect(pooledRmse(cal([[3, 4], [0]]))).toBeCloseTo(Math.sqrt(25 / 3), 12);
  });

  it('returns NaN when there are no finite samples', () => {
    expect(pooledRmse(cal([]))).toBeNaN();
    expect(pooledRmse(cal([[], []]))).toBeNaN();
  });

  it('drops non-finite values before averaging', () => {
    // NaN/Infinity ignored: only 3 and 4 count -> sqrt((9+16)/2) = sqrt(12.5).
    expect(pooledRmse(cal([[3, NaN], [Infinity, 4]]))).toBeCloseTo(Math.sqrt(12.5), 12);
  });
});

describe('selectForecastModel', () => {
  const cal = (perHorizonErrors: number[][]): HorizonErrorCalibration => ({
    perHorizonErrors,
    foldsPerHorizon: perHorizonErrors.map((e) => e.length),
    horizonPoints: perHorizonErrors.length,
  });

  it('prefers the cleaned candidate when it beats baseline by more than the margin', () => {
    const baseline = cal([[10, 10]]);
    const candidate = cal([[1, 1]]);
    expect(selectForecastModel(baseline, candidate)).toBe('cleaned');
  });

  it('keeps baseline on an exact RMSE tie', () => {
    const baseline = cal([[5, 5]]);
    const candidate = cal([[5, 5]]);
    expect(selectForecastModel(baseline, candidate)).toBe('baseline');
  });

  it('keeps baseline when the candidate improves only within the margin', () => {
    // ~1% better but default margin is 2% -> not enough.
    const baseline = cal([[100]]);
    const candidate = cal([[99]]);
    expect(selectForecastModel(baseline, candidate)).toBe('baseline');
  });

  it('keeps baseline when the candidate backtest is empty (NaN RMSE)', () => {
    const baseline = cal([[5, 5]]);
    const candidate = cal([]);
    expect(selectForecastModel(baseline, candidate)).toBe('baseline');
  });

  it('keeps baseline when the baseline backtest is empty (NaN RMSE)', () => {
    expect(selectForecastModel(cal([]), cal([[1]]))).toBe('baseline');
  });

  it('respects a custom margin', () => {
    const baseline = cal([[100]]);
    const candidate = cal([[99]]); // 1% better.
    // margin 0.005 (0.5%) -> the 1% improvement now clears the bar.
    expect(selectForecastModel(baseline, candidate, 0.005)).toBe('cleaned');
    // margin 0.05 (5%) -> not enough.
    expect(selectForecastModel(baseline, candidate, 0.05)).toBe('baseline');
  });

  it('exposes the default selection margin constant', () => {
    expect(OUTLIER_SELECTION_MARGIN).toBe(0.02);
  });
});

describe('modelSelectionCaption', () => {
  it('describes the cleaned choice with both RMSEs and the percent-lower figure', () => {
    const sel: ModelSelection = { choice: 'cleaned', baselineRmse: 0.01012, cleanedRmse: 0.00912 };
    const caption = modelSelectionCaption(sel);
    expect(caption).toContain('outlier-cleaned');
    expect(caption).toContain('0.0101'); // baseline toFixed(4) -> 0.0101
    expect(caption).toContain('0.0091'); // cleaned toFixed(4)  -> 0.0091
    expect(caption).toContain('9.9% lower');
  });

  it('describes the raw (baseline) choice', () => {
    const sel: ModelSelection = { choice: 'baseline', baselineRmse: 0.0091, cleanedRmse: 0.009 };
    const caption = modelSelectionCaption(sel);
    expect(caption).toContain('Model input: raw');
    expect(caption).toContain('0.0090');
    expect(caption).toContain('0.0091');
  });

  it('guards against a zero baseline RMSE (no NaN/Infinity in output)', () => {
    const sel: ModelSelection = { choice: 'cleaned', baselineRmse: 0, cleanedRmse: 0 };
    const caption = modelSelectionCaption(sel);
    expect(caption).not.toContain('NaN');
    expect(caption).not.toContain('Infinity');
    expect(caption).toContain('0.0% lower');
  });
});

describe('summarizeForecast modelInput threading', () => {
  it('reports outlier-cleaned when the cleaned model input was selected', () => {
    const result = makeResult({ forecast: [1, 2], sigma: 1 });
    result.modelSelection = { choice: 'cleaned', baselineRmse: 0.02, cleanedRmse: 0.01 };
    expect(summarizeForecast(result).modelInput).toBe('outlier-cleaned');
  });

  it('reports raw when the baseline model input was kept', () => {
    const result = makeResult({ forecast: [1, 2], sigma: 1 });
    result.modelSelection = { choice: 'baseline', baselineRmse: 0.02, cleanedRmse: 0.019 };
    expect(summarizeForecast(result).modelInput).toBe('raw');
  });

  it('leaves modelInput undefined when no selection ran', () => {
    const result = makeResult({ forecast: [1, 2], sigma: 1 });
    expect(summarizeForecast(result).modelInput).toBeUndefined();
  });
});

describe('recentWindowPoints', () => {
  it('returns half the history window rounded, when it clears the minimum', () => {
    // 0.5 * 336 = 168; minWin = 2 * 24 = 48; 168 >= 48 and 168 < 336 -> 168.
    expect(recentWindowPoints(336, 24)).toBe(168);
  });

  it('exposes the default recent-window fraction constant', () => {
    expect(A4_RECENT_WINDOW_FRACTION).toBe(0.5);
  });

  it('returns null when the computed window is not shorter than the full window', () => {
    // fraction 1.0 -> 336, which is not < historyPoints 336.
    expect(recentWindowPoints(336, 24, 1.0)).toBeNull();
  });

  it('returns null when the computed window is shorter than 2 * horizon', () => {
    // 0.5 * 40 = 20; minWin = 2 * 24 = 48; 20 < 48 -> null.
    expect(recentWindowPoints(40, 24)).toBeNull();
  });

  it('respects a custom fraction', () => {
    // 0.25 * 400 = 100; minWin = 2 * 24 = 48; 100 >= 48 and 100 < 400 -> 100.
    expect(recentWindowPoints(400, 24, 0.25)).toBe(100);
  });
});

describe('selectHistoryWindow', () => {
  const cal = (perHorizonErrors: number[][]): HorizonErrorCalibration => ({
    perHorizonErrors,
    foldsPerHorizon: perHorizonErrors.map((e) => e.length),
    horizonPoints: perHorizonErrors.length,
  });

  it('prefers the recent window when it beats the full window by more than the margin', () => {
    const full = cal([[10, 10]]);
    const recent = cal([[1, 1]]);
    expect(selectHistoryWindow(full, recent)).toBe('recent');
  });

  it('keeps the full window on an exact RMSE tie', () => {
    const full = cal([[5, 5]]);
    const recent = cal([[5, 5]]);
    expect(selectHistoryWindow(full, recent)).toBe('full');
  });

  it('keeps the full window when the recent candidate improves only within the margin', () => {
    // ~1% better but default margin is 2% -> not enough.
    const full = cal([[100]]);
    const recent = cal([[99]]);
    expect(selectHistoryWindow(full, recent)).toBe('full');
  });

  it('keeps the full window when the recent backtest is empty (NaN RMSE)', () => {
    expect(selectHistoryWindow(cal([[5, 5]]), cal([]))).toBe('full');
  });

  it('keeps the full window when the full backtest is empty (NaN RMSE)', () => {
    expect(selectHistoryWindow(cal([]), cal([[1]]))).toBe('full');
  });
});

describe('windowSelectionCaption', () => {
  it('describes the recent choice with the bin count, both RMSEs and percent-lower', () => {
    const sel: WindowSelection = {
      choice: 'recent',
      fullRmse: 0.01012,
      recentRmse: 0.00912,
      recentBins: 168,
    };
    const caption = windowSelectionCaption(sel);
    expect(caption).toContain('recent-regime');
    expect(caption).toContain('last 168 bins');
    expect(caption).toContain('0.0101'); // full toFixed(4)
    expect(caption).toContain('0.0091'); // recent toFixed(4)
    expect(caption).toContain('9.9% lower');
  });

  it('returns null for the full choice', () => {
    const sel: WindowSelection = {
      choice: 'full',
      fullRmse: 0.0091,
      recentRmse: 0.009,
      recentBins: 168,
    };
    expect(windowSelectionCaption(sel)).toBeNull();
  });

  it('guards against a zero full RMSE (no NaN/Infinity in output)', () => {
    const sel: WindowSelection = { choice: 'recent', fullRmse: 0, recentRmse: 0, recentBins: 168 };
    const caption = windowSelectionCaption(sel);
    expect(caption).not.toBeNull();
    expect(caption).not.toContain('NaN');
    expect(caption).not.toContain('Infinity');
    expect(caption).toContain('0.0% lower');
  });
});

describe('summarizeForecast historyWindow threading', () => {
  it('reports recent when the recent-regime window was selected', () => {
    const result = makeResult({ forecast: [1, 2], sigma: 1 });
    result.windowSelection = {
      choice: 'recent',
      fullRmse: 0.02,
      recentRmse: 0.01,
      recentBins: 168,
    };
    expect(summarizeForecast(result).historyWindow).toBe('recent');
  });

  it('reports full when the full window was kept', () => {
    const result = makeResult({ forecast: [1, 2], sigma: 1 });
    result.windowSelection = {
      choice: 'full',
      fullRmse: 0.02,
      recentRmse: 0.019,
      recentBins: 168,
    };
    expect(summarizeForecast(result).historyWindow).toBe('full');
  });

  it('leaves historyWindow undefined when no selection ran', () => {
    const result = makeResult({ forecast: [1, 2], sigma: 1 });
    expect(summarizeForecast(result).historyWindow).toBeUndefined();
  });
});
