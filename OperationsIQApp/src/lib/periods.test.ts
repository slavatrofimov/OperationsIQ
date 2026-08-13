import { describe, it, expect, vi } from 'vitest';

// periods.ts -> eventhouse.ts pulls in msal/env; stub them so the pure parser
// can be imported without a browser/MSAL environment (mirrors eventhouse.test).
vi.mock('./msal', () => ({
  getEventhouseToken: vi.fn(async () => 'fake'),
  EventhouseSignInRequiredError: class extends Error {},
  notifyEventhouseSignInRequired: vi.fn(),
}));
vi.mock('./env', () => ({ env: { eventhouseQueryUri: 'https://c', eventhouseDb: 'db' } }));
// kql.ts calls getActiveTimeseriesRef via withTimeseriesRef.
vi.mock('./activeConnection', () => ({
  getActiveKqlOpts: () => undefined,
  getActiveProfileId: () => undefined,
  getActiveTimeseriesRef: () => 'Timeseries',
  getActiveTimeseriesIsWide: () => false,
  getActiveSignalIdDelimiter: () => '-',
  getActiveHierarchyRef: () => 'TagHierarchy',
  getActiveMetadataRef: () => 'TagMetadata',
  getActiveEventsRef: () => 'Events',
}));

import type { KustoTable } from './eventhouse';
import {
  parseDetectedPeriods,
  periodToSeasonalityBins,
  formatDetectedPeriod,
} from './periods';
import { buildPeriodsQuery, buildForecastQuery, buildBacktestQuery } from './kql';

/** Build a one-row Kusto table for the periods query shape. */
function periodsTable(periods: (number | null)[], scores: (number | null)[]): KustoTable {
  return {
    name: 'PrimaryResult',
    columns: [
      { name: 'SignalId', type: 'string' },
      { name: 'Periods', type: 'dynamic' },
      { name: 'Scores', type: 'dynamic' },
    ],
    rows: [['tag-1', periods, scores]],
  };
}

describe('parseDetectedPeriods', () => {
  it('drops the zero/no-pattern sentinels and orders by descending score', () => {
    // 24-bin cycle (strong) + 168-bin cycle (weaker) + a 0 sentinel.
    const table = periodsTable([168, 24, 0], [0.6, 0.84, 0]);
    const out = parseDetectedPeriods(table, 3_600_000); // 1h bins
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ bins: 24, score: 0.84, millis: 24 * 3_600_000 });
    expect(out[1]).toMatchObject({ bins: 168, score: 0.6 });
  });

  it('returns [] when the query produced no row (series too short)', () => {
    const empty: KustoTable = { name: 'PrimaryResult', columns: [], rows: [] };
    expect(parseDetectedPeriods(empty, 60)).toEqual([]);
  });

  it('ignores non-finite / non-positive entries', () => {
    const table = periodsTable([12, null, -3], [0.5, 0.9, 0.9]);
    const out = parseDetectedPeriods(table, 60_000);
    expect(out).toEqual([{ bins: 12, millis: 720_000, score: 0.5 }]);
  });
});

describe('period formatting helpers', () => {
  it('rounds fractional bins to a whole, >=1 seasonality', () => {
    expect(periodToSeasonalityBins({ bins: 23.6, millis: 0, score: 1 })).toBe(24);
    expect(periodToSeasonalityBins({ bins: 0.2, millis: 0, score: 1 })).toBe(1);
  });

  it('formats a human label with duration, bins and score', () => {
    expect(formatDetectedPeriod({ bins: 24, millis: 24 * 3_600_000, score: 0.84 })).toBe(
      '1d (24 bins) · 84%',
    );
  });
});

describe('buildPeriodsQuery', () => {
  it('bounds max_period at n/2 and guards short series', () => {
    const q = buildPeriodsQuery({
      tagId: 'tag-1',
      start: new Date('2024-01-01T00:00:00Z'),
      end: new Date('2024-01-02T00:00:00Z'),
      binKql: '1h',
      numPeriods: 3,
    });
    expect(q).toContain('series_periods_detect(_detr, 4.0, todouble(max_of(_n, 8)) / 2.0, 3)');
    expect(q).toContain('| extend _detr = series_subtract(Value, series_fit_line_dynamic(Value).line_fit)');
    expect(q).toContain('let _n = toscalar(');
    expect(q).toContain('| where _n >= 8');
    expect(q).toContain("where SignalId == 'tag-1'");
    // max_period must be a scalar constant, not a per-row array_length column.
    expect(q).not.toContain('| extend _n = array_length(Value)');
  });
});

describe('buildForecastQuery seasonality', () => {
  const base = {
    tagId: 'tag-1',
    start: new Date('2024-01-01T00:00:00Z'),
    end: new Date('2024-01-02T00:00:00Z'),
    futureEnd: new Date('2024-01-03T00:00:00Z'),
    binKql: '1h',
    horizonPoints: 24,
  };

  it('omits the seasonality argument by default (auto-detect)', () => {
    const q = buildForecastQuery(base);
    expect(q).toContain('series_decompose_forecast(ModelValue, 24)');
    // Companion residual decompose matches the point model: auto seasonality
    // (-1), avg trend, and Test_points == horizon to exclude the forecast.
    expect(q).toContain("series_decompose(Forecast, -1, 'avg', 24)");
  });

  it('passes an explicit seasonality when provided', () => {
    const q = buildForecastQuery({ ...base, seasonality: 24 });
    expect(q).toContain('series_decompose_forecast(ModelValue, 24, 24)');
    // Companion decompose reuses the same explicit seasonality.
    expect(q).toContain("series_decompose(Forecast, 24, 'avg', 24)");
  });

  // The cleanOutliers model-input winsorization is run live against a real
  // Eventhouse during review, so this assertion is byte-faithful. Only the
  // ModelValue line is swapped for the 4-line edge-filled decompose/outlier
  // block; everything else (Forecast, companion decompose, Sigma, project)
  // is identical to the default path.
  const EXPECTED_CLEAN_FORECAST = `Timeseries
| where SignalId == 'tag-1'
| where Timestamp between (datetime(2024-01-01T00:00:00.000Z) .. datetime(2024-01-02T00:00:00.000Z))
| make-series Value = avg(Value) default = real(null), Cnt = count() default = long(0) on Timestamp from datetime(2024-01-01T00:00:00.000Z) to datetime(2024-01-03T00:00:00.000Z) step 1h
| extend ModelValue = series_fill_linear(Value, real(null), true)
| extend (_obl, _ose, _otr, _ore) = series_decompose(ModelValue)
| extend _okeep = series_less(series_abs(series_outliers(ModelValue)), 1.5)
| extend ModelValue = series_add(series_multiply(ModelValue, _okeep), series_multiply(_obl, series_subtract(1.0, _okeep)))
| extend Forecast = series_decompose_forecast(ModelValue, 24)
| extend (FcBaseline, FcSeasonal, FcTrend, FcResidual) = series_decompose(Forecast, -1, 'avg', 24)
| extend _n = array_length(Forecast)
| extend Sigma = toreal(series_stats_dynamic(array_slice(FcResidual, 0, _n - 24 - 1)).stdev)
| project SignalId = 'tag-1', Timestamp, Value, ModelValue, Forecast, Sigma, Residuals = array_slice(FcResidual, 0, _n - 24 - 1), HorizonPoints = 24, Cnt`;

  it('winsorizes the model input when cleanOutliers is set (default threshold)', () => {
    expect(buildForecastQuery({ ...base, cleanOutliers: {} })).toBe(EXPECTED_CLEAN_FORECAST);
  });

  it('uses the supplied threshold literal in the outlier keep mask', () => {
    const q = buildForecastQuery({ ...base, cleanOutliers: { threshold: 2 } });
    expect(q).toContain('series_less(series_abs(series_outliers(ModelValue)), 2)');
  });
});

describe('buildBacktestQuery', () => {
  // Representative rolling-origin backtest: 1h bins, H=24, L=336, S=24. The
  // active-connection mock returns 'Timeseries' and the offset is 0, so passing
  // timeseriesRef: 'Timeseries' keeps withTimeseriesRef a byte-for-byte no-op.
  const base = {
    tagId: 'tag-1',
    start: new Date('2024-01-01T00:00:00Z'),
    end: new Date('2024-01-15T00:00:00Z'),
    binKql: '1h',
    horizonPoints: 24,
    historyPoints: 336,
    foldStep: 24,
    timeseriesRef: 'Timeseries',
  };

  // The emitted CSL is run live against a real Eventhouse during review, so this
  // assertion is byte-faithful. Note the two KQL gotchas encoded in the shape:
  // fcArr is a NAMED column before array_slice, and errors are zipped via a
  // single mv-expand with_itemindex (see buildBacktestQuery docs).
  const EXPECTED_NO_SEASONALITY = `Timeseries
| where SignalId == 'tag-1'
| where Timestamp between (datetime(2024-01-01T00:00:00.000Z) .. datetime(2024-01-15T00:00:00.000Z))
| make-series V = avg(Value) default = real(null) on Timestamp from datetime(2024-01-01T00:00:00.000Z) to datetime(2024-01-15T00:00:00.000Z) step 1h
| extend V = series_fill_linear(V, real(null), false)
| extend _n = array_length(V)
| extend origins = range(336, _n - 24, 24)
| mv-apply o = origins to typeof(long) on (
    project o, actual = array_slice(V, o, o + 24 - 1),
      fcArr = series_decompose_forecast(array_concat(array_slice(V, o - 336, o - 1), repeat(0.0, 24)), 24)
    | extend err = series_subtract(actual, array_slice(fcArr, 336, 336 + 24 - 1))
    | mv-expand with_itemindex = idx e = err to typeof(real)
    | project h = idx + 1, err = todouble(e)
  )
| summarize Errors = make_list(err), Folds = count() by h
| order by h asc
| project SignalId = 'tag-1', h, Errors, Folds`;

  const EXPECTED_SEASONALITY = `Timeseries
| where SignalId == 'tag-1'
| where Timestamp between (datetime(2024-01-01T00:00:00.000Z) .. datetime(2024-01-15T00:00:00.000Z))
| make-series V = avg(Value) default = real(null) on Timestamp from datetime(2024-01-01T00:00:00.000Z) to datetime(2024-01-15T00:00:00.000Z) step 1h
| extend V = series_fill_linear(V, real(null), false)
| extend _n = array_length(V)
| extend origins = range(336, _n - 24, 24)
| mv-apply o = origins to typeof(long) on (
    project o, actual = array_slice(V, o, o + 24 - 1),
      fcArr = series_decompose_forecast(array_concat(array_slice(V, o - 336, o - 1), repeat(0.0, 24)), 24, 24)
    | extend err = series_subtract(actual, array_slice(fcArr, 336, 336 + 24 - 1))
    | mv-expand with_itemindex = idx e = err to typeof(real)
    | project h = idx + 1, err = todouble(e)
  )
| summarize Errors = make_list(err), Folds = count() by h
| order by h asc
| project SignalId = 'tag-1', h, Errors, Folds`;

  it('emits the exact rolling-origin CSL with no seasonality argument', () => {
    expect(buildBacktestQuery(base)).toBe(EXPECTED_NO_SEASONALITY);
  });

  it('appends the seasonality argument after the horizon points arg', () => {
    expect(buildBacktestQuery({ ...base, seasonality: 24 })).toBe(EXPECTED_SEASONALITY);
  });

  // cleanOutliers fits each fold on the winsorized Vfit while the held-out
  // actuals stay on RAW V. Three decompose/outlier lines are inserted after the
  // fill line, and ONLY the array_concat fit slice switches from V to Vfit. This
  // is byte-faithful to the live-validated Eventhouse query.
  const EXPECTED_CLEAN_NO_SEASONALITY = `Timeseries
| where SignalId == 'tag-1'
| where Timestamp between (datetime(2024-01-01T00:00:00.000Z) .. datetime(2024-01-15T00:00:00.000Z))
| make-series V = avg(Value) default = real(null) on Timestamp from datetime(2024-01-01T00:00:00.000Z) to datetime(2024-01-15T00:00:00.000Z) step 1h
| extend V = series_fill_linear(V, real(null), false)
| extend (_bl, _se, _tr, _re) = series_decompose(V)
| extend _keep = series_less(series_abs(series_outliers(V)), 1.5)
| extend Vfit = series_add(series_multiply(V, _keep), series_multiply(_bl, series_subtract(1.0, _keep)))
| extend _n = array_length(V)
| extend origins = range(336, _n - 24, 24)
| mv-apply o = origins to typeof(long) on (
    project o, actual = array_slice(V, o, o + 24 - 1),
      fcArr = series_decompose_forecast(array_concat(array_slice(Vfit, o - 336, o - 1), repeat(0.0, 24)), 24)
    | extend err = series_subtract(actual, array_slice(fcArr, 336, 336 + 24 - 1))
    | mv-expand with_itemindex = idx e = err to typeof(real)
    | project h = idx + 1, err = todouble(e)
  )
| summarize Errors = make_list(err), Folds = count() by h
| order by h asc
| project SignalId = 'tag-1', h, Errors, Folds`;

  const EXPECTED_CLEAN_SEASONALITY = `Timeseries
| where SignalId == 'tag-1'
| where Timestamp between (datetime(2024-01-01T00:00:00.000Z) .. datetime(2024-01-15T00:00:00.000Z))
| make-series V = avg(Value) default = real(null) on Timestamp from datetime(2024-01-01T00:00:00.000Z) to datetime(2024-01-15T00:00:00.000Z) step 1h
| extend V = series_fill_linear(V, real(null), false)
| extend (_bl, _se, _tr, _re) = series_decompose(V)
| extend _keep = series_less(series_abs(series_outliers(V)), 1.5)
| extend Vfit = series_add(series_multiply(V, _keep), series_multiply(_bl, series_subtract(1.0, _keep)))
| extend _n = array_length(V)
| extend origins = range(336, _n - 24, 24)
| mv-apply o = origins to typeof(long) on (
    project o, actual = array_slice(V, o, o + 24 - 1),
      fcArr = series_decompose_forecast(array_concat(array_slice(Vfit, o - 336, o - 1), repeat(0.0, 24)), 24, 24)
    | extend err = series_subtract(actual, array_slice(fcArr, 336, 336 + 24 - 1))
    | mv-expand with_itemindex = idx e = err to typeof(real)
    | project h = idx + 1, err = todouble(e)
  )
| summarize Errors = make_list(err), Folds = count() by h
| order by h asc
| project SignalId = 'tag-1', h, Errors, Folds`;

  it('fits folds on Vfit while actuals stay raw when cleanOutliers is set', () => {
    expect(buildBacktestQuery({ ...base, cleanOutliers: {} })).toBe(EXPECTED_CLEAN_NO_SEASONALITY);
  });

  it('keeps the seasonality arg placement unchanged under cleanOutliers', () => {
    expect(buildBacktestQuery({ ...base, seasonality: 24, cleanOutliers: {} })).toBe(
      EXPECTED_CLEAN_SEASONALITY,
    );
  });

  // fitWindowPoints fits each fold on only the most recent 168 bins (a
  // 'recent-regime' candidate) instead of the full 336. The fold ORIGINS stay on
  // 336 (range unchanged) so the candidate shares identical origins and held-out
  // actuals with the full-window baseline; only the fit slice and the forecast
  // tail offset switch 336 -> 168. Live-validated against a real Eventhouse.
  const EXPECTED_FIT_WINDOW = `Timeseries
| where SignalId == 'tag-1'
| where Timestamp between (datetime(2024-01-01T00:00:00.000Z) .. datetime(2024-01-15T00:00:00.000Z))
| make-series V = avg(Value) default = real(null) on Timestamp from datetime(2024-01-01T00:00:00.000Z) to datetime(2024-01-15T00:00:00.000Z) step 1h
| extend V = series_fill_linear(V, real(null), false)
| extend _n = array_length(V)
| extend origins = range(336, _n - 24, 24)
| mv-apply o = origins to typeof(long) on (
    project o, actual = array_slice(V, o, o + 24 - 1),
      fcArr = series_decompose_forecast(array_concat(array_slice(V, o - 168, o - 1), repeat(0.0, 24)), 24)
    | extend err = series_subtract(actual, array_slice(fcArr, 168, 168 + 24 - 1))
    | mv-expand with_itemindex = idx e = err to typeof(real)
    | project h = idx + 1, err = todouble(e)
  )
| summarize Errors = make_list(err), Folds = count() by h
| order by h asc
| project SignalId = 'tag-1', h, Errors, Folds`;

  it('fits folds on the recent window while origins stay on the full window when fitWindowPoints is set', () => {
    expect(buildBacktestQuery({ ...base, fitWindowPoints: 168 })).toBe(EXPECTED_FIT_WINDOW);
  });
});
