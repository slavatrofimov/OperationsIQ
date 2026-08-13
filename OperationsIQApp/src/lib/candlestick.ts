/**
 * Reshape and derive candlestick (OHLC) data. The KQL builder
 * {@link import('./kql').buildCandlestickQuery} returns one row per non-empty
 * bin with Open/High/Low/Close and a raw-record Volume, all pre-aggregated from
 * the original time series. Moving averages are derived here (client-side) over
 * the binned Close values, so every plotted metric traces back to the raw data.
 */

import { rowsToObjects, type KustoTable } from './eventhouse';

/** One pre-aggregated OHLC bar. */
export interface OhlcBar {
  /** Bin start as unix milliseconds. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Raw-record count in the bin. */
  volume: number;
}

interface OhlcRow {
  Bin: string;
  Open: number | null;
  High: number | null;
  Low: number | null;
  Close: number | null;
  Volume: number | null;
}

/**
 * Parse rows from buildCandlestickQuery into OHLC bars, dropping any bin missing
 * a finite OHLC value (a candlestick needs all four). Bars are sorted ascending
 * by time so moving averages and the category axis line up.
 */
export function parseCandlestickRows(table: KustoTable): OhlcBar[] {
  const bars = rowsToObjects<OhlcRow>(table)
    .map((r) => ({
      t: new Date(r.Bin).getTime(),
      open: Number(r.Open),
      high: Number(r.High),
      low: Number(r.Low),
      close: Number(r.Close),
      volume: Number(r.Volume ?? 0),
    }))
    .filter(
      (b) =>
        Number.isFinite(b.t) &&
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close),
    );
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

/**
 * Simple moving average of the Close price over `window` bars. The first
 * `window - 1` positions have no full window and are returned as `null` so the
 * chart leaves a gap there instead of drawing a misleading partial average.
 */
export function computeMA(bars: OhlcBar[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  if (window <= 0) return bars.map(() => null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= window) sum -= bars[i - window].close;
    out.push(i >= window - 1 ? sum / window : null);
  }
  return out;
}

/**
 * Normalize a user-supplied set of moving-average windows: keep positive
 * integers only, de-duplicate, and sort ascending. Falls back to the caller's
 * default when nothing valid remains.
 */
export function normalizeMaWindows(
  windows: readonly number[],
  fallback: number[] = DEFAULT_MA_WINDOWS,
): number[] {
  const src = Array.isArray(windows) ? windows : [];
  const cleaned = Array.from(
    new Set(src.map((w) => Math.floor(w)).filter((w) => Number.isFinite(w) && w > 0)),
  ).sort((a, b) => a - b);
  return cleaned.length > 0 ? cleaned : [...fallback];
}

/** Parse a comma/space separated list of MA windows (e.g. "5, 10, 20"). */
export function parseMaWindows(text: string, fallback: number[] = DEFAULT_MA_WINDOWS): number[] {
  const nums = text
    .split(/[\s,]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  return normalizeMaWindows(nums, fallback);
}

/** Default moving-average windows, matching the reference candlestick example. */
export const DEFAULT_MA_WINDOWS = [5, 10, 20, 30];
