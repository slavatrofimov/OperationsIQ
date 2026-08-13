/**
 * Shared, app-wide adaptive-binning settings. These control how raw time series
 * are pre-processed (aggregated into bins) before any analysis on every page.
 *
 * Historically only the Explore tab exposed these controls; this module makes
 * one shape + defaults that every page reads (via BinningContext) and every
 * binning control (BinningControls) renders, so behavior is consistent and
 * scalable at extreme data volumes.
 *
 * The canonical unit of measure for a bin width / preferred resolution is the
 * **millisecond** (integer), so the app can support sub-second temporal
 * resolution down to a 1 ms floor.
 */

import { chooseBin, STANDARD_TIMESPANS, type BinSelection } from './binning';
import type { Aggregation } from './kql';

/** The minimal set of binning controls surfaced on every analysis page. */
export interface BinningSettings {
  /** Aggregate applied per bin in make-series. */
  aggregation: Aggregation;
  /** Maximum bins (points) to render; drives adaptive bin width. */
  maxBins: number;
  /** Optional preferred bin width in milliseconds; used when it fits within maxBins. */
  preferredMillis: number | null;
}

/** Bin-count (max points) bounds, shared by every binning control. */
export const BIN_COUNT_MIN = 100;
export const BIN_COUNT_MAX = 50000;
export const BIN_COUNT_STEP = 100;

/**
 * A far larger max-points ceiling used only by the Matrix Profile analysis
 * wizard. MP jobs run on Spark and can legitimately need up to ~1M points for
 * large windows, whereas charting-oriented pages must stay bounded (50k) so the
 * browser never tries to render millions of points. Controls opt into this
 * higher ceiling via an explicit `maxBinsLimit` prop.
 */
export const BIN_COUNT_MAX_MP = 1_000_000;

/** Preferred bin width bounds (milliseconds). 7 days is the largest standard step. */
export const PREFERRED_MILLIS_MIN = 0;
export const PREFERRED_MILLIS_MAX = 604_800_000;

export const DEFAULT_BINNING_SETTINGS: BinningSettings = {
  aggregation: 'avg',
  maxBins: 5000,
  preferredMillis: null,
};

/** Aggregation choices for the per-bin combine. Canonical source of truth. */
export const AGGREGATION_OPTIONS: { value: Aggregation; label: string }[] = [
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
  { value: 'sum', label: 'Sum' },
  { value: 'count', label: 'Count' },
];

/**
 * Choose an adaptive bin width for a range using the given settings. Thin
 * wrapper over {@link chooseBin} that maps `preferredMillis` (0/null = auto).
 */
export function chooseBinFor(
  range: { start: Date; end: Date },
  settings: Pick<BinningSettings, 'maxBins' | 'preferredMillis'>,
): BinSelection {
  return chooseBin({
    start: range.start,
    end: range.end,
    maxBins: settings.maxBins,
    preferredMillis: settings.preferredMillis ?? undefined,
  });
}

/**
 * Unit of measure for the "Preferred resolution" input. The binning engine works
 * at whole-millisecond granularity, so the smallest offered unit is a millisecond.
 */
export type ResolutionUnit = 'milliseconds' | 'seconds' | 'minutes' | 'hours' | 'days';

export const RESOLUTION_UNIT_OPTIONS: { value: ResolutionUnit; label: string; millis: number }[] =
  [
    { value: 'milliseconds', label: 'ms', millis: 1 },
    { value: 'seconds', label: 'sec', millis: 1_000 },
    { value: 'minutes', label: 'min', millis: 60_000 },
    { value: 'hours', label: 'hour', millis: 3_600_000 },
    { value: 'days', label: 'day', millis: 86_400_000 },
  ];

const UNIT_MILLIS: Record<ResolutionUnit, number> = {
  milliseconds: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/**
 * Unit of measure for a "relative" (Last N …) time window. Mirrors
 * {@link ResolutionUnit} but adds `months`, which has no fixed number of
 * milliseconds and is therefore resolved with calendar arithmetic.
 */
export type RelativeUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'months';

export const RELATIVE_UNIT_OPTIONS: { value: RelativeUnit; label: string }[] = [
  { value: 'seconds', label: 'seconds' },
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
  { value: 'months', label: 'months' },
];

/** A relative time window expressed as a whole count of a single unit. */
export interface RelativeTimeSpec {
  value: number;
  unit: RelativeUnit;
}

/** Default relative window: the last one hour. */
export const DEFAULT_RELATIVE_SPEC: RelativeTimeSpec = { value: 1, unit: 'hours' };

/**
 * Resolve a relative window into an absolute `{ start, end }` range ending at
 * `now`. Sub-day units use exact millisecond arithmetic; `months` uses calendar
 * arithmetic so "last 1 month" lands on the same day-of-month a month earlier.
 */
export function resolveRelativeRange(
  spec: RelativeTimeSpec,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const value = Number.isFinite(spec.value) && spec.value > 0 ? Math.floor(spec.value) : 1;
  const end = new Date(now.getTime());
  const start = new Date(now.getTime());
  switch (spec.unit) {
    case 'seconds':
      start.setTime(end.getTime() - value * 1000);
      break;
    case 'minutes':
      start.setTime(end.getTime() - value * 60_000);
      break;
    case 'hours':
      start.setTime(end.getTime() - value * 3_600_000);
      break;
    case 'days':
      start.setTime(end.getTime() - value * 86_400_000);
      break;
    case 'months':
      start.setMonth(start.getMonth() - value);
      break;
  }
  return { start, end };
}

/** Convert a value + unit into whole milliseconds (floored, non-negative). */
export function valueUnitToMillis(value: number, unit: ResolutionUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value * UNIT_MILLIS[unit]);
}

/**
 * Express a whole-millisecond count as the largest exact unit (days > hours >
 * minutes > seconds > milliseconds), so e.g. 3_600_000 -> {value:1, unit:'hours'}
 * and 1500 -> {value:1500, unit:'milliseconds'}.
 */
export function millisToValueUnit(millis: number): { value: number; unit: ResolutionUnit } {
  if (!Number.isFinite(millis) || millis <= 0) return { value: 0, unit: 'milliseconds' };
  const ms = Math.floor(millis);
  if (ms % 86_400_000 === 0) return { value: ms / 86_400_000, unit: 'days' };
  if (ms % 3_600_000 === 0) return { value: ms / 3_600_000, unit: 'hours' };
  if (ms % 60_000 === 0) return { value: ms / 60_000, unit: 'minutes' };
  if (ms % 1_000 === 0) return { value: ms / 1_000, unit: 'seconds' };
  return { value: ms, unit: 'milliseconds' };
}

/**
 * Human-friendly duration like "2d 4h" or "3h 15m" or "45s" or "500 ms". Accepts
 * a duration in **seconds** (may be fractional); shows at most the two
 * most-significant non-zero units for readability, and renders sub-second
 * durations in milliseconds.
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s';
  if (totalSeconds < 1) {
    const ms = Math.round(totalSeconds * 1000);
    return `${ms} ms`;
  }
  const s = Math.round(totalSeconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs) parts.push(`${secs}s`);
  return parts.slice(0, 2).join(' ');
}

/**
 * Compact, human-friendly label for a bin width in **milliseconds**, e.g.
 * 500 -> "500ms", 5000 -> "5s", 300000 -> "5min". Used for the effective
 * resolution readout.
 */
export function formatResolution(millis: number): string {
  if (!Number.isFinite(millis) || millis <= 0) return '0ms';
  if (millis < 1000) return `${Math.round(millis)}ms`;
  if (millis % 86_400_000 === 0) return `${millis / 86_400_000}d`;
  if (millis % 3_600_000 === 0) return `${millis / 3_600_000}h`;
  if (millis % 60_000 === 0) return `${millis / 60_000}min`;
  if (millis % 1000 === 0) return `${millis / 1000}s`;
  return `${(millis / 1000).toFixed(3).replace(/\.?0+$/, '')}s`;
}

/** Transparent adaptive-binning outputs derived from a range + settings. */
export interface BinningOutputs {
  /** Effective bin width the engine will use, in milliseconds/bin. */
  effectiveMillis: number;
  /** Human-friendly label for the effective resolution (e.g. "5min"). */
  label: string;
  /** Total duration of the range in milliseconds. */
  durationMs: number;
  /** Human-friendly duration (e.g. "2d 4h"). */
  durationText: string;
  /** Projected number of points/bins across the range at the effective resolution. */
  points: number;
}

/** Human-friendly label for an arbitrary whole-millisecond resolution. */
export function labelForMillis(millis: number): string {
  const std = STANDARD_TIMESPANS.find((t) => t.millis === millis);
  return std?.label ?? formatResolution(millis);
}

/**
 * Compute the transparent binning outputs (effective resolution, duration, and
 * projected point count) for a range under the given settings. Mirrors exactly
 * the bin the query will use via {@link chooseBinFor}.
 *
 * Pass {@link overrideMillis} when the effective resolution is dictated by a
 * different range than the one being measured (e.g. a similarity query pattern
 * whose resolution is derived from the wider search space). In that case the
 * duration reflects `range` but the resolution and point count use the shared
 * bin width.
 */
export function computeBinningOutputs(
  range: { start: Date; end: Date },
  settings: Pick<BinningSettings, 'maxBins' | 'preferredMillis'>,
  overrideMillis?: number | null,
): BinningOutputs {
  const bin =
    overrideMillis && overrideMillis > 0
      ? { millis: overrideMillis, label: labelForMillis(overrideMillis) }
      : chooseBinFor(range, settings);
  const durationMs = Math.max(0, range.end.getTime() - range.start.getTime());
  const points = bin.millis > 0 ? Math.max(1, Math.ceil(durationMs / bin.millis)) : 0;
  return {
    effectiveMillis: bin.millis,
    label: bin.label,
    durationMs,
    durationText: formatDuration(durationMs / 1000),
    points,
  };
}

/** Clamp a bin-count into the shared bounds and floor it to an integer. */
export function clampBinCount(n: number, max: number = BIN_COUNT_MAX): number {
  if (!Number.isFinite(n)) return DEFAULT_BINNING_SETTINGS.maxBins;
  return Math.min(max, Math.max(BIN_COUNT_MIN, Math.floor(n)));
}

/**
 * Clamp a time range so a *fixed* bin width stays within a max-points budget.
 *
 * Used by the granularity-locked Similarity search (Scenario 2): the bin width is
 * pinned to the discovered pattern's resolution, so the only lever left to keep
 * the query performant is the search window. If the range would project more than
 * `maxBins` points at `binMillis`, the window is shortened — keeping its end fixed
 * (the most recent data) and moving its start forward — so the locked resolution
 * is honored without exceeding the point budget. Returns the original range
 * (`clamped: false`) when it already fits or the inputs are unusable.
 */
export function clampRangeToBinBudget(
  range: { start: Date; end: Date },
  binMillis: number,
  maxBins: number,
): { start: Date; end: Date; clamped: boolean } {
  const durationMs = range.end.getTime() - range.start.getTime();
  if (
    !Number.isFinite(binMillis) ||
    binMillis <= 0 ||
    !Number.isFinite(maxBins) ||
    maxBins <= 0 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return { start: range.start, end: range.end, clamped: false };
  }
  const maxDurationMs = binMillis * maxBins;
  if (durationMs <= maxDurationMs) {
    return { start: range.start, end: range.end, clamped: false };
  }
  return { start: new Date(range.end.getTime() - maxDurationMs), end: range.end, clamped: true };
}

const VALID_AGGREGATIONS: readonly Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

/**
 * Safely hydrate {@link BinningSettings} from untrusted input (e.g. localStorage),
 * falling back to defaults for any missing/invalid field.
 *
 * Legacy settings persisted a `preferredSeconds` field; those are migrated to
 * `preferredMillis` (×1000) on read so existing users don't break.
 *
 * @param maxBinsLimit Upper bound applied to `maxBins`. Defaults to the shared
 *   {@link BIN_COUNT_MAX} (50k); pass {@link BIN_COUNT_MAX_MP} for the Matrix
 *   Profile wizard, whose Spark jobs can need far more points.
 */
export function parseBinningSettings(
  raw: unknown,
  maxBinsLimit: number = BIN_COUNT_MAX,
): BinningSettings {
  const src = (raw ?? {}) as Partial<Record<string, unknown>>;
  const aggregation = VALID_AGGREGATIONS.includes(src.aggregation as Aggregation)
    ? (src.aggregation as Aggregation)
    : DEFAULT_BINNING_SETTINGS.aggregation;
  const maxBins =
    typeof src.maxBins === 'number' && Number.isFinite(src.maxBins)
      ? clampBinCount(src.maxBins, maxBinsLimit)
      : DEFAULT_BINNING_SETTINGS.maxBins;

  let preferredMillis: number | null = DEFAULT_BINNING_SETTINGS.preferredMillis;
  if (typeof src.preferredMillis === 'number' && Number.isFinite(src.preferredMillis)) {
    const v = Math.floor(src.preferredMillis);
    preferredMillis = v > 0 ? Math.min(PREFERRED_MILLIS_MAX, v) : null;
  } else if (src.preferredMillis === null) {
    preferredMillis = null;
  } else if (typeof src.preferredSeconds === 'number' && Number.isFinite(src.preferredSeconds)) {
    // Legacy migration: preferredSeconds (whole seconds) -> preferredMillis.
    const v = Math.floor(src.preferredSeconds) * 1000;
    preferredMillis = v > 0 ? Math.min(PREFERRED_MILLIS_MAX, v) : null;
  }
  return { aggregation, maxBins, preferredMillis };
}
