/**
 * Run-frequency catalog and incremental-lookback math for Activator (Reflex)
 * alerts generated from SAX similarity searches.
 *
 * A generated Activator alert re-runs the (self-contained) KQL on a fixed
 * schedule. Each run only needs to look back far enough to (a) cover the time
 * elapsed since the previous run plus (b) the length of the query pattern, so a
 * match whose window straddles the previous run boundary is still found. That is
 * the user's formula:
 *
 *   lookbackSeconds = frequencySeconds + (queryBins - 1) * binSeconds
 */

/** One selectable run frequency. `seconds` feeds executionIntervalInSeconds. */
export interface ActivatorFrequency {
  /** Stable key persisted with the alert pointer and used by the UI dropdown. */
  key: string;
  /** Human label shown in the Monitor dropdown. */
  label: string;
  /** Interval in seconds (= executionIntervalInSeconds on the kqlSource). */
  seconds: number;
}

/**
 * The nine run frequencies Activator's "Run query every" control offers, mapped
 * to their exact second values (see activator-reference-notes.md).
 */
export const ACTIVATOR_FREQUENCIES: readonly ActivatorFrequency[] = [
  { key: '1m', label: 'Every 1 minute', seconds: 60 },
  { key: '5m', label: 'Every 5 minutes', seconds: 300 },
  { key: '15m', label: 'Every 15 minutes', seconds: 900 },
  { key: '30m', label: 'Every 30 minutes', seconds: 1800 },
  { key: '1h', label: 'Every 1 hour', seconds: 3600 },
  { key: '3h', label: 'Every 3 hours', seconds: 10800 },
  { key: '6h', label: 'Every 6 hours', seconds: 21600 },
  { key: '12h', label: 'Every 12 hours', seconds: 43200 },
  { key: '1d', label: 'Every 1 day', seconds: 86400 },
];

/** Default run frequency for a new alert. */
export const DEFAULT_ACTIVATOR_FREQUENCY_KEY = '15m';

/** Resolve a frequency key to its second value (throws on an unknown key). */
export function frequencySecondsFor(key: string): number {
  const match = ACTIVATOR_FREQUENCIES.find((f) => f.key === key);
  if (!match) throw new Error(`Unknown Activator frequency: ${key}`);
  return match.seconds;
}

/** Human label for a frequency key (falls back to the key when unknown). */
export function frequencyLabelFor(key: string): string {
  return ACTIVATOR_FREQUENCIES.find((f) => f.key === key)?.label ?? key;
}

/**
 * Incremental lookback window (seconds) for a scheduled run:
 *   frequencySeconds + (queryBins - 1) * binSeconds
 *
 * `queryBins` is the number of samples in the inlined query pattern; `binSeconds`
 * is the search granularity in seconds. Guards against a degenerate 0/negative
 * pattern length by flooring queryBins at 1 (a 1-bin pattern → lookback = freq).
 */
export function computeLookbackSeconds(
  frequencySeconds: number,
  queryBins: number,
  binSeconds: number,
): number {
  const bins = Math.max(1, Math.floor(queryBins));
  return frequencySeconds + (bins - 1) * binSeconds;
}
