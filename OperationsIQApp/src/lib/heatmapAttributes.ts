/**
 * Helpers for building "heatmap by date attribute" views on the Heatmaps page.
 *
 * Instead of the calendar's one-cell-per-calendar-day layout, these group a
 * signal's samples by cyclical attributes of their timestamp (minute of hour,
 * hour of day, day of week, day of month, month of year) and aggregate the
 * values in each group. Any two attributes can be crossed to form a 2-D matrix
 * heatmap (e.g. hour-of-day x day-of-week), or a single attribute can be shown
 * as a 1-D strip.
 *
 * All extraction uses `getUTC*` on the timestamps returned by the query. Because
 * the query layer shifts the canonical `Timestamp` column by the preferred
 * timezone offset (see queryTimezone.ts), those timestamps are already the
 * preferred-zone wall clock encoded as UTC ticks — so reading their UTC fields
 * yields preferred-zone-aware buckets that line up with the calendar heatmap
 * (which keys cells off the same shifted timestamps). At the default browser
 * offset this matches the machine's local cycles; DST transitions are not
 * accounted for (a fixed offset is used).
 */

import type { Aggregation } from './kql';

/** The cyclical timestamp attributes a heatmap can be grouped by. */
export type DateAttribute = 'minute' | 'hour' | 'dayOfWeek' | 'dayOfMonth' | 'month';

/** A row attribute may also be "none" to collapse the matrix to a single strip. */
export type RowAttribute = DateAttribute | 'none';

export interface AttributeDef {
  value: DateAttribute;
  /** User-facing label for the selector and axis name. */
  label: string;
  /** Ordered category labels (one per bucket). */
  categories: string[];
  /** Extract the 0-based bucket index from a Date (UTC). */
  index: (d: Date) => number;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Monday-first, to match the calendar heatmap's `dayLabel.firstDay: 1`. */
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const numbers = (n: number, from = 0): string[] =>
  Array.from({ length: n }, (_, i) => String(i + from));

/** Canonical, ordered set of groupable date attributes. */
export const DATE_ATTRIBUTES: AttributeDef[] = [
  {
    value: 'minute',
    label: 'Minute of hour',
    categories: numbers(60),
    index: (d) => d.getUTCMinutes(),
  },
  {
    value: 'hour',
    label: 'Hour of day',
    categories: numbers(24),
    index: (d) => d.getUTCHours(),
  },
  {
    value: 'dayOfWeek',
    label: 'Day of week',
    categories: DOW,
    // JS getUTCDay(): 0=Sun..6=Sat -> shift so 0=Mon..6=Sun.
    index: (d) => (d.getUTCDay() + 6) % 7,
  },
  {
    value: 'dayOfMonth',
    label: 'Day of month',
    categories: numbers(31, 1),
    index: (d) => d.getUTCDate() - 1,
  },
  {
    value: 'month',
    label: 'Month of year',
    categories: MONTHS,
    index: (d) => d.getUTCMonth(),
  },
];

const ATTR_BY_VALUE = new Map(DATE_ATTRIBUTES.map((a) => [a.value, a]));

export function attributeDef(value: DateAttribute): AttributeDef {
  const def = ATTR_BY_VALUE.get(value);
  if (!def) throw new Error(`Unknown date attribute: ${value}`);
  return def;
}

/** Combine a group of sample values with the given aggregation. */
export function aggregateValues(values: number[], agg: Aggregation): number {
  if (agg === 'count') return values.length;
  if (values.length === 0) return NaN;
  switch (agg) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'min':
      return values.reduce((a, b) => Math.min(a, b), Infinity);
    case 'max':
      return values.reduce((a, b) => Math.max(a, b), -Infinity);
    case 'avg':
    default:
      return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

export interface AttrHeatmap {
  xDef: AttributeDef;
  /** Null when collapsed to a single strip (row attribute = "none"). */
  yDef: AttributeDef | null;
  /** Category labels for the Y axis (a single blank entry when collapsed). */
  yCategories: string[];
  /** [xIndex, yIndex, value] tuples for every populated bucket. */
  cells: [number, number, number][];
  min: number;
  max: number;
}

/**
 * Build a 1-D or 2-D attribute heatmap from timestamped samples.
 *
 * @param detail [unixMs, value] pairs (nulls are skipped).
 * @param xAttr  Attribute mapped to the horizontal axis.
 * @param yAttr  Attribute mapped to the vertical axis, or "none" for a strip.
 * @param agg    How to combine values that fall in the same bucket.
 */
export function buildAttributeHeatmap(
  detail: [number, number | null][],
  xAttr: DateAttribute,
  yAttr: RowAttribute,
  agg: Aggregation,
): AttrHeatmap {
  const xDef = attributeDef(xAttr);
  const yDef = yAttr === 'none' ? null : attributeDef(yAttr);
  const yCategories = yDef ? yDef.categories : [''];

  const groups = new Map<string, number[]>();
  for (const [ms, v] of detail) {
    if (v == null || !Number.isFinite(v)) continue;
    const d = new Date(ms);
    const xi = xDef.index(d);
    const yi = yDef ? yDef.index(d) : 0;
    const key = `${xi},${yi}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(v);
    else groups.set(key, [v]);
  }

  const cells: [number, number, number][] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const [key, values] of groups) {
    const [xi, yi] = key.split(',').map(Number);
    const value = aggregateValues(values, agg);
    if (!Number.isFinite(value)) continue;
    cells.push([xi, yi, value]);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }

  return { xDef, yDef, yCategories, cells, min, max };
}
