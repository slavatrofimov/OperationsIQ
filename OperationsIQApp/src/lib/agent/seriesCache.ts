/**
 * Generic multi-track series cache — the progressive-disclosure backbone shared
 * by every analysis tool that produces a full-resolution series.
 *
 * A tool computes its analytics once, stashes the resulting aligned tracks here
 * under a short handle (e.g. `sr_3`), and returns only a compact preview in its
 * `data`. The agent can then call the single `series_detail` drill-down tool
 * with that handle to pull full-resolution points for any track/time-window it
 * actually needs — instead of every tool inventing its own cache + detail tool.
 *
 * All tracks in one entry share the same `x` axis (unix **milliseconds**), so a
 * caller must resample onto a common grid before caching (every query builder
 * here already does, via `make-series`).
 */

/** Metadata describing a cached series so `series_detail` can label its output. */
export interface SeriesMeta {
  /** Which tool produced it (e.g. 'explore', 'decomposition', 'monitor'). */
  kind: string;
  /** Primary signal/tag id when the entry is about one tag. */
  signalId?: string;
  /** Human-friendly bin label (e.g. '5min'). */
  binLabel?: string;
  /** Bin width in seconds. */
  binSeconds?: number;
  /** Ordered track names available in this entry (for discoverability). */
  trackNames: string[];
}

/** One cached, drillable multi-track series. */
export interface SeriesEntry {
  /** Shared time axis, unix milliseconds. */
  x: number[];
  /** Named parallel value tracks aligned to `x`. */
  tracks: Record<string, (number | null)[]>;
  meta: SeriesMeta;
}

const MAX_ENTRIES = 24;
let seq = 0;
const cache = new Map<string, SeriesEntry>();

/** Stash a multi-track series and return its handle. Evicts oldest past cap. */
export function putSeries(x: number[], tracks: Record<string, (number | null)[]>, meta: Omit<SeriesMeta, 'trackNames'>): string {
  const id = `sr_${++seq}`;
  cache.set(id, { x, tracks, meta: { ...meta, trackNames: Object.keys(tracks) } });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return id;
}

/** Fetch a cached series (LRU-touch), or undefined when unknown/evicted. */
export function getSeries(id: string): SeriesEntry | undefined {
  const entry = cache.get(id);
  if (!entry) return undefined;
  // Touch for LRU: re-insert so it becomes the most-recently-used.
  cache.delete(id);
  cache.set(id, entry);
  return entry;
}
