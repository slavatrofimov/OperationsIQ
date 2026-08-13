/**
 * Small shared helpers for the analysis tool adapters — the bits every tool
 * repeats: rounding to a few significant digits (per the design guide's
 * "round aggressively" rule), ISO-window validation, and a capped min/max
 * preview built on the same `downsampleMinMax` the forecast tool uses.
 */
import { downsampleMinMax } from '../forecast';
import { chooseBin, type BinSelection } from '../binning';

/** Round to 3 significant digits; pass through null/non-finite as null. */
export function round(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v === 0) return 0;
  return Number(v.toPrecision(3));
}

/** Round every element of a nullable series. */
export function roundArr(vs: (number | null)[]): (number | null)[] {
  return vs.map(round);
}

/** Parse & validate a [startIso, endIso] window; returns Dates or an error string. */
export function parseWindow(startIso: string, endIso: string): { start: Date; end: Date } | { error: string } {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: 'startIso/endIso must be valid ISO 8601 datetimes.' };
  }
  if (end <= start) return { error: 'endIso must be after startIso.' };
  return { start, end };
}

/** Choose an adaptive bin for a window, honoring an optional maxBins budget. */
export function binFor(start: Date, end: Date, maxBins?: number): BinSelection {
  return chooseBin({ start, end, maxBins });
}

/** One point in a min/max-downsampled preview. */
export interface PreviewPoint {
  t: number;
  iso: string;
  v: number | null;
}

/**
 * Build a capped min/max preview of a single track over the shared axis `x`
 * (unix ms). Bucketing preserves extrema and rounds values.
 */
export function preview(x: number[], values: (number | null)[], maxPoints = 24): PreviewPoint[] {
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  return downsampleMinMax(x, values, buckets).map((i) => ({
    t: x[i],
    iso: new Date(x[i]).toISOString(),
    v: round(values[i]),
  }));
}

/** Least-squares slope per bin over a nullable series (ignoring gaps). */
export function slopePerBin(values: (number | null)[]): number {
  const pts: [number, number][] = [];
  values.forEach((y, i) => {
    if (y != null && Number.isFinite(y)) pts.push([i, y]);
  });
  const n = pts.length;
  if (n < 2) return 0;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) * (x - mx);
  }
  return den === 0 ? 0 : num / den;
}

/** Direction label from a per-bin slope relative to the series' spread. */
export function trendLabel(slope: number, spread: number): 'rising' | 'falling' | 'flat' {
  const eps = spread > 0 ? spread * 1e-3 : 1e-9;
  if (slope > eps) return 'rising';
  if (slope < -eps) return 'falling';
  return 'flat';
}
