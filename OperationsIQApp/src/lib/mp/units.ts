/**
 * Domain-unit helpers (design spec §7.1 step 3). Non-technical users think in **time**
 * ("~2 seconds"), never in samples ("m=512"). These pure converters bridge the two using
 * a signal's sample rate, and format lengths back into friendly text.
 */

/** Convert a pattern duration in seconds to a subsequence length `m` (samples). */
export function secondsToSubLen(seconds: number, sampleRateHz: number): number {
  if (sampleRateHz <= 0) throw new Error("sampleRateHz must be positive");
  return Math.max(4, Math.round(seconds * sampleRateHz));
}

/** Convert a subsequence length back to seconds. */
export function subLenToSeconds(subLen: number, sampleRateHz: number): number {
  if (sampleRateHz <= 0) throw new Error("sampleRateHz must be positive");
  return subLen / sampleRateHz;
}

/** Friendly duration string, e.g. 0.5 -> "500 ms", 2 -> "2.0 s", 90 -> "1 min 30 s". */
export function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const rem = Math.round(seconds - mins * 60);
    if (rem === 60) return `${mins + 1} min`;
    return rem === 0 ? `${mins} min` : `${mins} min ${rem} s`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const remMin = Math.round((seconds - hours * 3600) / 60);
    if (remMin === 60) return `${hours + 1} h`;
    return remMin === 0 ? `${hours} h` : `${hours} h ${remMin} min`;
  }
  const days = Math.floor(seconds / 86400);
  const remHours = Math.round((seconds - days * 86400) / 3600);
  if (remHours === 24) return `${days + 1} d`;
  return remHours === 0 ? `${days} d` : `${days} d ${remHours} h`;
}

/**
 * Unit of measure for a pattern-length / separation duration input. Pattern
 * cycles can recur over **days** for slow physical or business processes, so
 * this set lets a single value + unit span a few seconds up to a year or more.
 */
export type DurationUnit = 'milliseconds' | 'seconds' | 'minutes' | 'hours' | 'days';

export const DURATION_UNIT_OPTIONS: { value: DurationUnit; label: string; seconds: number }[] = [
  { value: 'milliseconds', label: 'ms', seconds: 0.001 },
  { value: 'seconds', label: 'sec', seconds: 1 },
  { value: 'minutes', label: 'min', seconds: 60 },
  { value: 'hours', label: 'hour', seconds: 3600 },
  { value: 'days', label: 'day', seconds: 86400 },
];

const DURATION_UNIT_SECONDS: Record<DurationUnit, number> = {
  milliseconds: 0.001,
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

/**
 * Convert a value + unit into seconds (non-negative). Sub-second units (ms)
 * yield fractional seconds, which downstream converters and the Spark source
 * read (`bin(t, {seconds} * 1s)`) handle natively.
 */
export function durationToSeconds(value: number, unit: DurationUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (unit === 'milliseconds') return value / 1000;
  return value * DURATION_UNIT_SECONDS[unit];
}

/**
 * Express a duration in seconds as the largest exact whole unit
 * (days > hours > minutes > seconds > milliseconds), so e.g. 86400 ->
 * {value:1, unit:'days'}, 90 -> {value:90, unit:'seconds'} and 0.2 ->
 * {value:200, unit:'milliseconds'}. Computed against a 1 ms grid (the finest
 * supported resolution) so sub-second durations survive the round-trip.
 */
export function secondsToDuration(seconds: number): { value: number; unit: DurationUnit } {
  if (!Number.isFinite(seconds) || seconds <= 0) return { value: 0, unit: 'seconds' };
  const ms = Math.round(seconds * 1000);
  if (ms % 86_400_000 === 0) return { value: ms / 86_400_000, unit: 'days' };
  if (ms % 3_600_000 === 0) return { value: ms / 3_600_000, unit: 'hours' };
  if (ms % 60_000 === 0) return { value: ms / 60_000, unit: 'minutes' };
  if (ms % 1000 === 0) return { value: ms / 1000, unit: 'seconds' };
  return { value: ms, unit: 'milliseconds' };
}

/**
 * Convert a pattern duration in **seconds** to a subsequence length `m`
 * (points), given the effective **bin width** (seconds per point) the analysis
 * will run at. `m = round(seconds / binSeconds)`, clamped to a usable minimum of
 * 4 (below which a matrix profile is meaningless). Both arguments may be
 * fractional (e.g. a 0.2 s pattern at a 0.05 s / 50 ms bin width -> 4 points).
 */
export function durationToSubLen(seconds: number, binSeconds: number): number {
  if (!Number.isFinite(binSeconds) || binSeconds <= 0) return 4;
  return Math.max(4, Math.round(seconds / binSeconds));
}

/**
 * Motif-length slider bounds (design spec §7.1 step 3). Patterns can be anything from a
 * millisecond (fast, high-rate signals) up to an hour (slowly-sampled process data), so
 * the picker spans 1 ms .. 1 h. That is a ~3.6-million-x range, which a *linear* slider
 * cannot express usefully (a single step would jump minutes at the top while losing all
 * sub-second resolution), so the slider position is mapped **logarithmically** to seconds:
 * equal slider travel is equal *ratio* of duration, giving fine control at short durations
 * and still reaching an hour.
 */
export const MIN_MOTIF_SECONDS = 0.001;
export const MAX_MOTIF_SECONDS = 3600; // 1 hour
export const MOTIF_SLIDER_STEPS = 1000;

/** Map an integer slider position (0..steps) to a duration in seconds (log scale). */
export function sliderPosToSeconds(
  pos: number,
  min = MIN_MOTIF_SECONDS,
  max = MAX_MOTIF_SECONDS,
  steps = MOTIF_SLIDER_STEPS,
): number {
  const clamped = Math.min(steps, Math.max(0, pos));
  return min * Math.pow(max / min, clamped / steps);
}

/** Inverse of {@link sliderPosToSeconds}: map a duration in seconds to a slider position. */
export function secondsToSliderPos(
  seconds: number,
  min = MIN_MOTIF_SECONDS,
  max = MAX_MOTIF_SECONDS,
  steps = MOTIF_SLIDER_STEPS,
): number {
  const clamped = Math.min(max, Math.max(min, seconds));
  return Math.round((steps * Math.log(clamped / min)) / Math.log(max / min));
}

/**
 * The classic motif definition is robust across ~0.25x..1.25x the true length, so we
 * offer a sensible range around the user's guess (design spec §6.6, §7.1). Returns the
 * `m` range a Pan-MP scan would cover.
 */
export function robustSubLenRange(subLen: number): { min: number; max: number } {
  return {
    min: Math.max(4, Math.round(subLen * 0.25)),
    max: Math.max(5, Math.round(subLen * 1.25)),
  };
}
