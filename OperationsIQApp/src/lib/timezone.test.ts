import { describe, it, expect } from 'vitest';
import {
  BROWSER_PREFERENCE,
  browserOffsetMinutes,
  resolveOffsetMinutes,
  formatOffsetLabel,
  timezoneOptions,
  formatInstant,
  formatQueryInstant,
  toPreferredWallClock,
  fromPreferredWallClock,
  toChartMs,
  fromChartMs,
  formatInstantIso,
  formatQueryInstantIso,
} from './timezone';

describe('timezone helpers', () => {
  it('resolves the browser sentinel to the current browser offset', () => {
    expect(resolveOffsetMinutes(BROWSER_PREFERENCE)).toBe(browserOffsetMinutes());
    expect(resolveOffsetMinutes(null)).toBe(browserOffsetMinutes());
    expect(resolveOffsetMinutes(undefined)).toBe(browserOffsetMinutes());
  });

  it('resolves a signed integer-minute string to a fixed offset', () => {
    expect(resolveOffsetMinutes('-480')).toBe(-480);
    expect(resolveOffsetMinutes('330')).toBe(330);
    expect(resolveOffsetMinutes('0')).toBe(0);
  });

  it('falls back to the browser offset for a garbage preference', () => {
    expect(resolveOffsetMinutes('nonsense')).toBe(browserOffsetMinutes());
  });

  it('formats offset labels with sign and zero-padding', () => {
    expect(formatOffsetLabel(0)).toBe('UTC\u00B100:00');
    expect(formatOffsetLabel(330)).toBe('UTC+05:30');
    expect(formatOffsetLabel(-480)).toBe('UTC\u221208:00');
  });

  it('offers the browser default first plus every 30-min fixed offset', () => {
    const opts = timezoneOptions();
    expect(opts[0].value).toBe(BROWSER_PREFERENCE);
    // -12:00 .. +14:00 inclusive at 30-min steps = 53 offsets, plus the sentinel.
    expect(opts.length).toBe(1 + 53);
    expect(opts.some((o) => o.value === '0')).toBe(true);
    expect(opts.some((o) => o.value === '840')).toBe(true); // +14:00
    expect(opts.some((o) => o.value === '-720')).toBe(true); // -12:00
  });

  it('formats a client instant shifted into the preferred zone', () => {
    // 2024-01-01T00:00Z at UTC-8 -> 2023-12-31 16:00 wall clock.
    const s = formatInstant(new Date('2024-01-01T00:00:00Z'), -480, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(s).toContain('2023');
    expect(s).toContain('16:00');
  });

  it('round-trips a preferred wall-clock string through the range picker helpers', () => {
    const offset = -480;
    const instant = new Date('2024-06-15T12:34:00Z');
    const wall = toPreferredWallClock(instant, offset);
    expect(wall).toBe('2024-06-15T04:34'); // 12:34Z - 8h
    const back = fromPreferredWallClock(wall, offset);
    expect(back?.toISOString()).toBe('2024-06-15T12:34:00.000Z');
  });

  it('treats a wall-clock string as UTC when offset is 0', () => {
    const back = fromPreferredWallClock('2024-06-15T12:34', 0);
    expect(back?.toISOString()).toBe('2024-06-15T12:34:00.000Z');
  });

  it('returns null for empty/invalid wall-clock strings', () => {
    expect(fromPreferredWallClock('', -480)).toBeNull();
    expect(fromPreferredWallClock('not-a-date', -480)).toBeNull();
  });

  it('preserves the literal year for years 0–99 (no 1900s remap)', () => {
    // The intermediate values a user types while entering "2025" (e.g. 0002,
    // 0020, 0202) must round-trip to the same year, not be remapped to 1900s.
    expect(fromPreferredWallClock('0002-06-15T12:00', 0)?.getUTCFullYear()).toBe(2);
    expect(fromPreferredWallClock('0020-06-15T12:00', 0)?.getUTCFullYear()).toBe(20);
    expect(fromPreferredWallClock('0099-06-15T12:00', 0)?.getUTCFullYear()).toBe(99);
    expect(fromPreferredWallClock('2025-06-15T12:00', 0)?.getUTCFullYear()).toBe(2025);
  });

  it('formats an already-shifted query instant verbatim as UTC (no re-shift)', () => {
    // A query timestamp is pre-shifted: its UTC fields ARE the preferred wall
    // clock, so formatQueryInstant must render them as-is regardless of the
    // machine timezone.
    const s = formatQueryInstant(new Date('2024-01-01T16:00:00Z'), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(s).toContain('2024');
    expect(s).toContain('16:00');
  });

  it('formatQueryInstant and formatInstant(+offset) agree on a real instant', () => {
    // formatInstant shifts a real instant by +offset; formatQueryInstant renders
    // a value that has ALREADY been shifted. Feeding the pre-shifted value to
    // formatQueryInstant must equal feeding the raw instant to formatInstant.
    const offset = 330; // +05:30
    const real = new Date('2024-03-10T09:15:00Z');
    const preShifted = new Date(real.getTime() + offset * 60_000);
    const opts = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
    expect(formatQueryInstant(preShifted, opts)).toBe(formatInstant(real, offset, opts));
  });
});

describe('chart-space helpers (toChartMs / fromChartMs)', () => {
  it('shifts a real-UTC instant into chart space by +offset', () => {
    const real = Date.parse('2024-01-01T00:00:00Z');
    // US Eastern-ish: UTC-4 (=-240). Chart space is 4h earlier in absolute ms.
    expect(toChartMs(real, -240)).toBe(real - 240 * 60_000);
    // +05:30 (India): chart space is 5h30m later.
    expect(toChartMs(real, 330)).toBe(real + 330 * 60_000);
  });

  it('is an identity when the offset is 0', () => {
    const ms = Date.parse('2024-06-15T12:34:56Z');
    expect(toChartMs(ms, 0)).toBe(ms);
    expect(fromChartMs(ms, 0)).toBe(ms);
  });

  it('fromChartMs is the exact inverse of toChartMs', () => {
    for (const offset of [0, 330, -240, -480, 840, -720]) {
      const real = Date.parse('2024-03-10T09:15:00Z');
      expect(fromChartMs(toChartMs(real, offset), offset)).toBe(real);
      const chart = Date.parse('2024-03-10T09:15:00Z');
      expect(toChartMs(fromChartMs(chart, offset), offset)).toBe(chart);
    }
  });

  it('places a client instant on the same axis as a pre-shifted query timestamp', () => {
    // A query timestamp for wall-clock 16:00 comes back pre-shifted (its UTC
    // ticks already read 16:00Z). A real client instant of 20:00Z at UTC-4 must
    // map to those same chart ms via toChartMs so the axis and series align.
    const offset = -240;
    const realInstant = Date.parse('2024-01-01T20:00:00Z');
    const preShiftedQueryTs = Date.parse('2024-01-01T16:00:00Z');
    expect(toChartMs(realInstant, offset)).toBe(preShiftedQueryTs);
  });

  it('round-trips a brush window: chart-space -> query range -> chart-space', () => {
    // Models the ExplorePage brush: the overview axis is in chart space, the
    // detail query needs a real-UTC range (KQL re-applies +offset), and drawing
    // the window back on the axis must land where the user dragged.
    const offset = -240;
    const dragged = { start: Date.parse('2024-01-01T16:00:00Z'), end: Date.parse('2024-01-01T18:00:00Z') };
    const queryStart = fromChartMs(dragged.start, offset);
    const queryEnd = fromChartMs(dragged.end, offset);
    // Real-UTC range fed to the query builder is 4h later than the axis ms.
    expect(queryStart).toBe(Date.parse('2024-01-01T20:00:00Z'));
    expect(queryEnd).toBe(Date.parse('2024-01-01T22:00:00Z'));
    // Re-projecting the stored real-UTC range onto the axis returns the drag.
    expect(toChartMs(queryStart, offset)).toBe(dragged.start);
    expect(toChartMs(queryEnd, offset)).toBe(dragged.end);
  });
});

describe('formatInstantIso / formatQueryInstantIso', () => {
  const instant = Date.parse('2026-07-24T03:03:35Z');

  it('formats a real instant in the preferred zone with a numeric offset, never Z', () => {
    // -240 (UTC-04:00): the same instant is 23:03:35 the previous day.
    expect(formatInstantIso(instant, -240)).toBe('2026-07-23T23:03:35-04:00');
    expect(formatInstantIso(new Date(instant), -240)).toBe('2026-07-23T23:03:35-04:00');
    expect(formatInstantIso(instant, -240)).not.toContain('Z');
  });

  it('labels UTC as +00:00 (not Z) and handles half-hour and positive offsets', () => {
    expect(formatInstantIso(instant, 0)).toBe('2026-07-24T03:03:35+00:00');
    expect(formatInstantIso(instant, 330)).toBe('2026-07-24T08:33:35+05:30');
  });

  it('renders a pre-shifted query timestamp verbatim, only appending the offset label', () => {
    // A query timestamp is wall-clock encoded as UTC ticks: do NOT re-shift it.
    const preShifted = Date.parse('2026-07-23T23:03:35Z');
    expect(formatQueryInstantIso(preShifted, -240)).toBe('2026-07-23T23:03:35-04:00');
    expect(formatQueryInstantIso(new Date(preShifted), -240)).toBe('2026-07-23T23:03:35-04:00');
  });
});
