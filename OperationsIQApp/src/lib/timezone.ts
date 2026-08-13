/**
 * Pure, framework-free helpers for the preferred-analysis-timezone feature.
 *
 * The app models the preferred timezone as a FIXED offset in minutes east of
 * UTC (no DST — see queryTimezone.ts for the rationale). A stored *preference*
 * is either the sentinel `'browser'` (track the machine's current offset) or a
 * signed integer minute string (a pinned fixed offset, e.g. `'-480'`).
 *
 * Two rendering rules keep everything consistent (see the double-shift invariant
 * documented in queryTimezone.ts):
 *   - Query-returned timestamps are already shifted by the query, so the client
 *     renders them verbatim as UTC (ECharts `useUTC:true`, `getUTC*`, Intl with
 *     `timeZone:'UTC'`).
 *   - Client-created instants (now, "last used", job finish times) are real UTC
 *     instants; render them with {@link formatInstant}, which shifts by +offset
 *     then formats as UTC.
 */

/** A stored timezone preference: `'browser'` or a signed integer-minute string. */
export type TimezonePreference = string;

/** The sentinel preference that tracks the browser's current offset. */
export const BROWSER_PREFERENCE: TimezonePreference = 'browser';

/** Current browser offset in minutes EAST of UTC (e.g. UTC-8 → -480). */
export function browserOffsetMinutes(): number {
  // Date.getTimezoneOffset() is minutes BEHIND UTC (positive west), so negate.
  return -new Date().getTimezoneOffset();
}

/** Resolve a stored preference to a concrete offset in minutes east of UTC. */
export function resolveOffsetMinutes(pref: TimezonePreference | null | undefined): number {
  if (pref == null || pref === BROWSER_PREFERENCE) return browserOffsetMinutes();
  const n = Number(pref);
  return Number.isInteger(n) ? n : browserOffsetMinutes();
}

/** Format an offset as an ISO-style label, e.g. "UTC+05:30", "UTC−08:00", "UTC±00:00". */
export function formatOffsetLabel(minutes: number): string {
  if (minutes === 0) return 'UTC\u00B100:00';
  const sign = minutes > 0 ? '+' : '\u2212';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

export interface TimezoneOption {
  /** Stored preference value (`'browser'` or a signed integer-minute string). */
  value: TimezonePreference;
  /** User-facing label for the dropdown. */
  label: string;
}

/**
 * The dropdown choices: "Browser default" first, then every 30-minute fixed
 * offset from UTC−12:00 to UTC+14:00 (covers all real-world civil offsets).
 */
export function timezoneOptions(): TimezoneOption[] {
  const opts: TimezoneOption[] = [
    { value: BROWSER_PREFERENCE, label: `Browser default (${formatOffsetLabel(browserOffsetMinutes())})` },
  ];
  for (let m = -12 * 60; m <= 14 * 60; m += 30) {
    opts.push({ value: String(m), label: formatOffsetLabel(m) });
  }
  return opts;
}

/** Shift a real instant by +offset, yielding a Date whose UTC fields are the preferred-zone wall clock. */
function shiftToWallClock(input: number | Date, offsetMinutes: number): Date {
  const ms = input instanceof Date ? input.getTime() : input;
  return new Date(ms + offsetMinutes * 60_000);
}

/**
 * Format a real client-created instant in the preferred timezone. Shifts by
 * +offset then formats the wall clock as UTC so no browser-local re-shift is
 * applied. Falls back to a compact default format when no options are given.
 */
export function formatInstant(
  input: number | Date,
  offsetMinutes: number,
  opts?: Intl.DateTimeFormatOptions,
): string {
  const shifted = shiftToWallClock(input, offsetMinutes);
  return shifted.toLocaleString(undefined, {
    ...(opts ?? {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    timeZone: 'UTC',
  });
}

/**
 * Format an already-shifted *query* timestamp verbatim as UTC. Query timestamps
 * come back from the KQL layer pre-shifted into the preferred zone (wall clock
 * encoded as UTC ticks), so they must be rendered as UTC — applying the browser
 * offset again would double-shift. Use this for chart tooltips / labels that
 * format query series times; use {@link formatInstant} for real client-created
 * instants instead. When `opts` is omitted the locale's default date+time format
 * is used (matching a bare `toLocaleString()` call, but in UTC).
 */
export function formatQueryInstant(
  input: number | Date,
  opts?: Intl.DateTimeFormatOptions,
): string {
  const d = input instanceof Date ? input : new Date(input);
  return d.toLocaleString(undefined, opts ? { ...opts, timeZone: 'UTC' } : { timeZone: 'UTC' });
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Format a real instant as a `datetime-local` string ("YYYY-MM-DDTHH:mm")
 * expressed in the preferred timezone. Used by the time-range picker so the
 * inputs show the zone the user is analyzing in.
 */
export function toPreferredWallClock(date: Date, offsetMinutes: number): string {
  const d = shiftToWallClock(date, offsetMinutes);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}`;
}

/**
 * Parse a `datetime-local` string ("YYYY-MM-DDTHH:mm") entered as preferred-zone
 * wall clock back into the real UTC instant it denotes. Returns null when empty
 * or unparseable.
 */
export function fromPreferredWallClock(s: string, offsetMinutes: number): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  const year = Number(y);
  const wall = new Date(
    Date.UTC(year, Number(mo) - 1, Number(d), Number(hh), Number(mm), ss ? Number(ss) : 0),
  );
  // Date.UTC (and the Date constructor) remap two-digit years 0–99 to 1900–1999.
  // While the user types a 4-digit year, the buffer briefly holds values like
  // 0002 or 0020 that would otherwise resolve to 1902/1920, diverging from the
  // field's own buffer and wiping each keystroke. Force the literal year back.
  if (year >= 0 && year <= 99) wall.setUTCFullYear(year);
  const instant = new Date(wall.getTime() - offsetMinutes * 60_000);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Move a REAL-UTC instant (epoch ms) into CHART / wall-clock space by +offset.
 *
 * On a `useUTC:true` ECharts time axis the app renders query-returned timestamps
 * verbatim, because the KQL layer has already shifted them into the preferred
 * zone (`kqlDatetime` + the canonical `Timestamp` column — see queryTimezone.ts).
 * A CLIENT-created instant — a picker range, `now`, a job window, a brush value
 * read back from an already-shifted axis — is a *real* UTC instant, so to place
 * it as a coordinate on that same axis (axis `min`/`max`, a `markLine`/`markArea`
 * value, or a reconstruction base like `start + i*bin`) it must be shifted by the
 * same +offset. Without this the coordinate is displaced from the wall-clock
 * series by exactly `offsetMinutes`.
 */
export function toChartMs(realMs: number, offsetMinutes: number): number {
  return realMs + offsetMinutes * 60_000;
}

/**
 * Inverse of {@link toChartMs}: bring a CHART / wall-clock-space ms (e.g. a value
 * emitted by a brush / dataZoom on a `useUTC` axis) back to a REAL UTC instant by
 * -offset. Use this before feeding a chart-space value to a KQL query builder
 * (which re-applies +offset via `kqlDatetime`) or storing it as a real instant,
 * so the shift is not applied twice.
 */
export function fromChartMs(chartMs: number, offsetMinutes: number): number {
  return chartMs - offsetMinutes * 60_000;
}

/** ISO-8601 numeric offset label with an ASCII sign, e.g. `+00:00`, `-04:00`, `+05:30`. */
function isoOffsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Render a Date's UTC fields as `YYYY-MM-DDTHH:mm:ss` (no zone suffix). */
function isoLocalPart(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Format a REAL instant as an ISO-8601 string in the preferred analysis timezone
 * WITH an explicit numeric offset — never a bare `Z`. Use for client-created
 * instants and reconstructed `start + i*bin` series times. With offset -240 an
 * instant of `2026-07-24T03:03:35Z` renders as `2026-07-23T23:03:35-04:00`.
 */
export function formatInstantIso(input: number | Date, offsetMinutes: number): string {
  return `${isoLocalPart(shiftToWallClock(input, offsetMinutes))}${isoOffsetLabel(offsetMinutes)}`;
}

/**
 * Format an already-shifted QUERY timestamp (wall clock encoded as UTC ticks, as
 * returned by the KQL layer) as ISO-8601 WITH the preferred-zone numeric offset —
 * never a bare `Z`. Use for MVAD `event_time`/`window_start`/`window_end`, which
 * the detector emits in the preferred zone. No re-shift is applied (that would
 * double-shift); the offset is appended only as the label so the value is
 * unambiguous instead of falsely claiming UTC. See {@link formatQueryInstant}.
 */
export function formatQueryInstantIso(input: number | Date, offsetMinutes: number): string {
  const d = input instanceof Date ? input : new Date(input);
  return `${isoLocalPart(d)}${isoOffsetLabel(offsetMinutes)}`;
}
