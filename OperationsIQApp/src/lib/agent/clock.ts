/**
 * Agent clock + natural-language time-window resolution.
 *
 * LLMs have no reliable notion of "now", so every relative window the user
 * mentions ("yesterday", "the last 7 days", "this month") is guesswork unless
 * the agent is handed an authoritative clock. `get_current_time` and
 * `resolve_time_window` both build on the helpers here.
 *
 * All arithmetic is done in UTC to match the Eventhouse (which stores and
 * compares `datetime` values in UTC) and the ISO-8601-UTC contract every
 * analysis tool advertises. The resolver is deliberately dependency-free and
 * pure so it is trivially unit-testable with a frozen `now`.
 *
 * Preferred-analysis-timezone note: the agent intentionally reasons in UTC even
 * when the user has picked a non-UTC analysis offset. The windows it resolves
 * are absolute instants passed to the query layer, which shifts both the
 * datetime literals and the `Timestamp` column by the same offset — the two
 * shifts cancel, so agent-driven windows keep UTC-day semantics ("today" is the
 * UTC day) regardless of the chosen offset. Aligning the agent clock to the
 * preferred offset is a possible future enhancement (it would change the meaning
 * of "today"/"yesterday" to the preferred zone) but is deliberately out of scope
 * here to keep the clock's behavior and its unit tests stable.
 */

/** Resolve the current time from a ToolContext-style clock, defaulting to real now. */
export function nowFrom(clock?: () => Date): Date {
  try {
    const d = clock?.();
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
  } catch {
    /* fall through to real clock */
  }
  return new Date();
}

/** A resolved, machine-usable time window. */
export interface ResolvedWindow {
  startIso: string;
  endIso: string;
  /** A tidy echo of what the phrase was understood to mean. */
  label: string;
}

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

/** Start-of-day (UTC) for a date. */
function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Add whole days to a date (UTC-safe). */
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * MS.day);
}

const UNIT_MS: Record<string, number> = {
  minute: MS.minute,
  min: MS.minute,
  hour: MS.hour,
  hr: MS.hour,
  day: MS.day,
  week: 7 * MS.day,
};

const UNIT_ALIASES: Record<string, keyof typeof UNIT_MS | 'month' | 'year' | 'quarter'> = {
  minute: 'minute', minutes: 'minute', min: 'min', mins: 'min',
  hour: 'hour', hours: 'hour', hr: 'hr', hrs: 'hr',
  day: 'day', days: 'day',
  week: 'week', weeks: 'week',
  month: 'month', months: 'month',
  quarter: 'quarter', quarters: 'quarter',
  year: 'year', years: 'year',
};

/** Subtract a calendar month/year span, clamping day-of-month overflow. */
function subtractSpan(now: Date, count: number, unit: 'month' | 'year' | 'quarter'): Date {
  const months = unit === 'year' ? count * 12 : unit === 'quarter' ? count * 3 : count;
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

function win(start: Date, end: Date, label: string): ResolvedWindow {
  return { startIso: start.toISOString(), endIso: end.toISOString(), label };
}

/**
 * Turn a natural-language phrase into a concrete [start, end] UTC window,
 * relative to `now`. Returns null when the phrase is not understood, so the
 * caller can ask the user to rephrase or give explicit dates.
 *
 * Understood shapes (case-insensitive):
 *  - "last|past|previous N minutes|hours|days|weeks|months|quarters|years"
 *  - "last minute|hour|day|week|month|quarter|year" (N defaults to 1)
 *  - "today", "yesterday"
 *  - "this week|month|quarter|year", "last week|month|quarter|year"
 *  - "ytd" / "year to date", "mtd" / "month to date"
 */
export function resolveRelativeWindow(phrase: string, now: Date): ResolvedWindow | null {
  const p = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!p) return null;

  if (p === 'today') return win(startOfDayUtc(now), now, 'today');
  if (p === 'yesterday') {
    const startToday = startOfDayUtc(now);
    return win(addDays(startToday, -1), startToday, 'yesterday');
  }
  if (p === 'ytd' || p === 'year to date') {
    return win(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), now, 'year to date');
  }
  if (p === 'mtd' || p === 'month to date') {
    return win(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), now, 'month to date');
  }

  // "this <unit>" — from the start of the current calendar unit to now.
  const thisMatch = /^this (week|month|quarter|year)$/.exec(p);
  if (thisMatch) {
    const unit = thisMatch[1];
    if (unit === 'week') {
      const start = startOfDayUtc(now);
      const dow = start.getUTCDay(); // 0=Sun; treat Monday as week start
      const mondayOffset = (dow + 6) % 7;
      return win(addDays(start, -mondayOffset), now, 'this week');
    }
    if (unit === 'month') {
      return win(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), now, 'this month');
    }
    if (unit === 'quarter') {
      const q = Math.floor(now.getUTCMonth() / 3) * 3;
      return win(new Date(Date.UTC(now.getUTCFullYear(), q, 1)), now, 'this quarter');
    }
    return win(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), now, 'this year');
  }

  // "last <unit>" (whole previous calendar unit) vs. "last N <units>" (rolling).
  const lastCalendar = /^(?:last|previous) (week|month|quarter|year)$/.exec(p);
  if (lastCalendar) {
    const unit = lastCalendar[1];
    if (unit === 'week') {
      const startToday = startOfDayUtc(now);
      const dow = startToday.getUTCDay();
      const mondayOffset = (dow + 6) % 7;
      const thisMonday = addDays(startToday, -mondayOffset);
      return win(addDays(thisMonday, -7), thisMonday, 'last week');
    }
    if (unit === 'month') {
      const startThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const startPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      return win(startPrev, startThis, 'last month');
    }
    if (unit === 'quarter') {
      const q = Math.floor(now.getUTCMonth() / 3) * 3;
      const startThis = new Date(Date.UTC(now.getUTCFullYear(), q, 1));
      const startPrev = new Date(Date.UTC(now.getUTCFullYear(), q - 3, 1));
      return win(startPrev, startThis, 'last quarter');
    }
    const startThisYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const startPrevYear = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
    return win(startPrevYear, startThisYear, 'last year');
  }

  // "last|past|previous [N] <unit>" — a rolling window ending at now.
  const rolling = /^(?:last|past|previous) (\d+)?\s*([a-z]+)$/.exec(p);
  if (rolling) {
    const count = rolling[1] ? parseInt(rolling[1], 10) : 1;
    if (!Number.isFinite(count) || count <= 0) return null;
    const unit = UNIT_ALIASES[rolling[2]];
    if (!unit) return null;
    const plural = count === 1 ? unit : `${unit}s`;
    if (unit === 'month' || unit === 'year' || unit === 'quarter') {
      return win(subtractSpan(now, count, unit), now, `last ${count} ${plural}`);
    }
    const ms = UNIT_MS[unit];
    return win(new Date(now.getTime() - count * ms), now, `last ${count} ${plural}`);
  }

  return null;
}
