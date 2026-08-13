/**
 * Module-level singleton holding the query timezone offset (in minutes east of
 * UTC) for the user's preferred analysis timezone. This lets the KQL builders
 * (kql.ts) localize every query WITHOUT every page having to thread the offset
 * through props.
 *
 * TimezoneContext is the single writer: it calls {@link setQueryOffsetMinutes}
 * whenever the user changes the preferred timezone (and on mount to seed the
 * browser default). Readers — {@link kqlDatetime} and {@link withTimeseriesRef}
 * in kql.ts — only ever read.
 *
 * The offset is applied at two chokepoints so the WHOLE analysis surface is
 * localized in one place (see kql.ts):
 *   1. every datetime literal (window bounds/anchors) is shifted by +offset, and
 *   2. the canonical `Timestamp` column is shifted by +offset at the source
 *      binding.
 * Because both sides move by the same amount, row selection is unchanged while
 * bin()/make-series/hourofday/dayofweek/startofday all align to the preferred
 * zone's wall clock.
 *
 * A FIXED offset is used (no DST): KQL/Eventhouse has no reliable IANA timezone
 * conversion, so a site spanning a daylight-saving change will be off by an hour
 * in the affected period. This is a documented, pragmatic trade-off.
 */

let offsetMinutes = 0;

/**
 * Set the query timezone offset in minutes east of UTC (e.g. UTC-8 → -480).
 * Non-finite/non-integer values reset the offset to 0 (UTC) so a bad value can
 * never inject into a query.
 */
export function setQueryOffsetMinutes(minutes: number): void {
  offsetMinutes = Number.isInteger(minutes) ? minutes : 0;
}

/** The current query timezone offset in minutes east of UTC (0 = UTC). */
export function getQueryOffsetMinutes(): number {
  return offsetMinutes;
}
