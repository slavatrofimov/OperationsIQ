/**
 * Adaptive bin-size selection, ported from the reference Power BI solution's
 * `f_bin_timespan` (Time-Series-Visualization-with-Microsoft-Fabric). Keeps the
 * number of points the client renders bounded (<= maxBins) at any zoom level so
 * the chart stays fast and readable, while snapping to human-friendly steps.
 *
 * The engine's canonical unit of measure is the **millisecond** (integer): bin
 * widths, standard steps, and preferred resolutions are all expressed in ms so
 * the app can support sub-second temporal resolution down to a 1 ms floor.
 */

export interface StandardTimespan {
  millis: number;
  label: string;
}

/** Human-friendly steps, ascending. Sub-second steps enable millisecond resolution. */
export const STANDARD_TIMESPANS: readonly StandardTimespan[] = [
  { millis: 1, label: '1ms' },
  { millis: 2, label: '2ms' },
  { millis: 5, label: '5ms' },
  { millis: 10, label: '10ms' },
  { millis: 20, label: '20ms' },
  { millis: 50, label: '50ms' },
  { millis: 100, label: '100ms' },
  { millis: 200, label: '200ms' },
  { millis: 500, label: '500ms' },
  { millis: 1_000, label: '1sec' },
  { millis: 2_000, label: '2sec' },
  { millis: 5_000, label: '5sec' },
  { millis: 10_000, label: '10sec' },
  { millis: 15_000, label: '15sec' },
  { millis: 30_000, label: '30sec' },
  { millis: 60_000, label: '1min' },
  { millis: 120_000, label: '2min' },
  { millis: 300_000, label: '5min' },
  { millis: 600_000, label: '10min' },
  { millis: 900_000, label: '15min' },
  { millis: 1_800_000, label: '30min' },
  { millis: 3_600_000, label: '1hour' },
  { millis: 7_200_000, label: '2hour' },
  { millis: 10_800_000, label: '3hour' },
  { millis: 21_600_000, label: '6hour' },
  { millis: 43_200_000, label: '12hour' },
  { millis: 86_400_000, label: '1day' },
  { millis: 604_800_000, label: '7days' },
];

export interface BinSelection {
  /** Bin width in milliseconds (integer). */
  millis: number;
  /** KQL timespan literal usable in a make-series `step` (e.g. "300000ms"). */
  kql: string;
  /** Human-friendly label (e.g. "5min"), or a computed fallback for non-standard widths. */
  label: string;
}

export interface ChooseBinOptions {
  start: Date;
  end: Date;
  /** Maximum number of bins (points) to render. Defaults to 1000. */
  maxBins?: number;
  /** Optional preferred bin width in milliseconds; used when it fits within maxBins. */
  preferredMillis?: number;
}

/**
 * Choose an adaptive bin width for a time range. Mirrors f_bin_timespan:
 * 1. If a preferred width fits within maxBins, use it.
 * 2. Otherwise pick the SMALLEST standard step whose bin count <= maxBins
 *    (i.e. the most detail the budget allows).
 * 3. Otherwise fall back to a computed even split.
 */
export function chooseBin(opts: ChooseBinOptions): BinSelection {
  const maxBins = opts.maxBins ?? 1000;
  const durationMs = Math.max(1, opts.end.getTime() - opts.start.getTime());

  if (opts.preferredMillis && durationMs / opts.preferredMillis <= maxBins) {
    return toSelection(opts.preferredMillis);
  }

  // Smallest standard step that keeps bins <= maxBins == largest usable resolution.
  const fitted = STANDARD_TIMESPANS.find((t) => durationMs / t.millis <= maxBins);
  if (fitted) {
    return { millis: fitted.millis, kql: `${fitted.millis}ms`, label: fitted.label };
  }

  const fallbackMs = Math.max(1, Math.floor(durationMs / Math.max(1, maxBins - 1)));
  return toSelection(fallbackMs);
}

function toSelection(millis: number): BinSelection {
  const width = Math.max(1, Math.round(millis));
  const std = STANDARD_TIMESPANS.find((t) => t.millis === width);
  return { millis: width, kql: `${width}ms`, label: std?.label ?? labelForMillisFallback(width) };
}

/** Fallback label for a non-standard bin width, e.g. 1500 -> "1500ms", 3000 -> "3sec". */
function labelForMillisFallback(millis: number): string {
  if (millis % 1000 === 0) return `${millis / 1000}sec`;
  return `${millis}ms`;
}
