import {
  kqlString,
  withTimeseriesRef,
  buildBinnedSeriesQuery,
  type Aggregation,
} from '../kql';

const RAW_AGGS = new Set<Aggregation>(['avg', 'min', 'max', 'sum', 'count']);

export interface RawSignalQueryOptions {
  signalId: string;
  /** Window start (ISO string, already timezone-shifted like other query datetimes). */
  startIso: string;
  /** Window end (ISO string). */
  endIso: string;
  /**
   * Bin width the backend analyzed on. When set (> 0), the raw signal is read on this SAME
   * uniform, gap-filled grid; otherwise native points are read.
   */
  binSeconds?: number;
  /** Aggregation applied within each bin; mirrors the job's params. Defaults to 'avg'. */
  aggregation?: string;
  /** Gap handling; 'none' keeps holes, anything else linearly interpolates. */
  gapFill?: string;
  /** Explicit Connection-Profile timeseries ref (defaults to the active profile). */
  timeseriesRef?: string;
}

/**
 * Build the query that loads a raw signal for display + shape-slicing on a run results page.
 *
 * Matrix Profile jobs analyze data on a fixed grid when the wizard's binning panel sets a
 * `binSeconds` (e.g. 1 h): the Spark reader aggregates every `binSeconds` window into one
 * sample, so a discovered pattern's indices (`idx`, `subLen`) and the emitted occurrence
 * positions are all in *bin units* — `subLen = 6` means six bins (six hours), not six raw
 * points. To map those indices back to wall-clock time and to the correct z-normalized
 * shape, the results view must load the signal on that SAME grid.
 *
 * Loading native points instead makes `secondsPerSample` reflect the raw cadence (e.g.
 * ~78 s over a 45-day window) rather than the bin width (3600 s), so a 6-bin / 6-hour
 * pattern misreports as ~8 minutes and every overlay position, timestamp, duration and
 * shape slice is wrong. This builder reproduces the backend grid via the shared
 * `buildBinnedSeriesQuery` (make-series + optional linear fill) and expands the resulting
 * value array back to one row per bin so existing `rows.map(r => r.Value)` consumers are
 * unchanged.
 *
 * Falls back to a native load when the job was not binned (older jobs). The row cap is high
 * (500k) rather than a small `take`, because the pattern indices are integer offsets into
 * the *full* compute series (which the Spark reader loads uncapped): truncating the display
 * load below the compute length would inflate the derived per-sample interval and push
 * later patterns off the chart — most visibly on a denser second AB-join series. For exact
 * alignment, run the analysis on a bin width (the binned path above is index-exact).
 */
export function rawSignalCsl(opts: RawSignalQueryOptions): string {
  const { signalId, startIso, endIso, binSeconds } = opts;
  if (binSeconds != null && Number.isFinite(binSeconds) && binSeconds > 0) {
    const agg = RAW_AGGS.has(opts.aggregation as Aggregation)
      ? (opts.aggregation as Aggregation)
      : 'avg';
    const base = buildBinnedSeriesQuery({
      tagId: signalId,
      start: new Date(startIso),
      end: new Date(endIso),
      binKql: `${Math.round(binSeconds * 1000)}ms`,
      aggregation: agg,
      fill: opts.gapFill !== 'none',
      timeseriesRef: opts.timeseriesRef,
    });
    return `${base}\n| mv-expand Value to typeof(real)\n| project Value`;
  }
  return withTimeseriesRef(
    `Timeseries | where SignalId == ${kqlString(signalId)} | where Timestamp between (datetime(${kqlString(startIso)}) .. datetime(${kqlString(endIso)})) | order by Timestamp asc | take 500000 | project Value`,
    opts.timeseriesRef,
  );
}
