import type { KustoTable } from './eventhouse';
import { PALETTE } from './series';

/**
 * One row of `sax_similarity_search_1d` output. `startIndex`/`endIndex` are
 * inclusive offsets into the search-space tag's binned sample array; `scale` is
 * the length ratio relative to the query (>1 = longer/stretched match).
 */
export interface MatchRow {
  seriesId: string;
  startIndex: number;
  endIndex: number;
  windowSize: number;
  scale: number;
  distance: number;
  similarity: number;
}

/** Column-name → index lookup, resilient to column ordering. */
function indexer(table: KustoTable) {
  const map = new Map(table.columns.map((c, i) => [c.name, i]));
  return (name: string): number => map.get(name) ?? -1;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse the similarity-search result table into typed, similarity-sorted matches. */
export function parseMatchRows(table: KustoTable): MatchRow[] {
  const at = indexer(table);
  const iId = at('series_id');
  const iStart = at('start_index');
  const iEnd = at('end_index');
  const iWin = at('window_size');
  const iScale = at('scale');
  const iDist = at('distance');
  const iSim = at('similarity');

  const rows = table.rows.map((r) => {
    const start = Math.round(num(r[iStart]));
    const win = iWin >= 0 ? Math.round(num(r[iWin])) : NaN;
    const end = iEnd >= 0 ? Math.round(num(r[iEnd])) : start + (Number.isFinite(win) ? win - 1 : 0);
    return {
      seriesId: String(r[iId] ?? ''),
      startIndex: start,
      endIndex: end,
      windowSize: Number.isFinite(win) ? win : end - start + 1,
      scale: iScale >= 0 ? num(r[iScale]) : 1,
      distance: iDist >= 0 ? num(r[iDist]) : NaN,
      similarity: iSim >= 0 ? num(r[iSim]) : NaN,
    } satisfies MatchRow;
  });

  return rows.sort((a, b) => b.similarity - a.similarity);
}

/** True when `a` is the stronger match (higher similarity, then lower distance). */
function isBetter(a: MatchRow, b: MatchRow): boolean {
  if (a.similarity !== b.similarity) return a.similarity > b.similarity;
  return a.distance < b.distance;
}

/**
 * Collapse runs of matches that land on consecutive / overlapping positions of
 * the same series into a single best-scoring match. The top-K search commonly
 * returns several near-duplicate hits one sample apart (e.g. start 100, 101,
 * 102) that all describe the same event; keeping only the strongest per cluster
 * de-clutters the charts and match list. Two matches join the same cluster when
 * their index windows touch or overlap (next start ≤ running end + 1). The
 * representative keeps its own window and score; the result is similarity-sorted.
 */
export function consolidateMatches(matches: MatchRow[]): MatchRow[] {
  if (matches.length <= 1) return matches.slice();

  const bySeries = new Map<string, MatchRow[]>();
  for (const m of matches) {
    const arr = bySeries.get(m.seriesId) ?? [];
    arr.push(m);
    bySeries.set(m.seriesId, arr);
  }

  const survivors: MatchRow[] = [];
  for (const arr of bySeries.values()) {
    const sorted = [...arr].sort((a, b) => a.startIndex - b.startIndex);
    let best = sorted[0];
    let clusterEnd = sorted[0].endIndex;
    for (let i = 1; i < sorted.length; i++) {
      const m = sorted[i];
      if (m.startIndex <= clusterEnd + 1) {
        // Consecutive / overlapping — same cluster; keep the stronger match.
        clusterEnd = Math.max(clusterEnd, m.endIndex);
        if (isBetter(m, best)) best = m;
      } else {
        survivors.push(best);
        best = m;
        clusterEnd = m.endIndex;
      }
    }
    survivors.push(best);
  }

  return survivors.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Filter a raw similarity-result table down to the rows backing `matches`
 * (matched by series_id + start_index), so the details table stays in sync with
 * the consolidated match set shown in the charts.
 */
export function filterTableToMatches(table: KustoTable, matches: MatchRow[]): KustoTable {
  const at = indexer(table);
  const iId = at('series_id');
  const iStart = at('start_index');
  const keep = new Set(matches.map((m) => `${m.seriesId}#${m.startIndex}`));
  const rows = table.rows.filter(
    (r) => keep.has(`${String(r[iId] ?? '')}#${Math.round(num(r[iStart]))}`),
  );
  return { ...table, rows };
}

/** Parse a (series_id, series) table into a map of tag → numeric sample array. */
export function parseSeriesMap(table: KustoTable): Map<string, number[]> {
  const at = indexer(table);
  const iId = at('series_id');
  const iSeries = at('series');
  const out = new Map<string, number[]>();
  for (const r of table.rows) {
    const arr = Array.isArray(r[iSeries]) ? (r[iSeries] as unknown[]).map(num) : [];
    out.set(String(r[iId] ?? ''), arr);
  }
  return out;
}

/** Extract the single sample array from a (series_id, series) query result. */
export function parseSingleSeries(table: KustoTable): number[] {
  const at = indexer(table);
  const iSeries = at('series');
  const first = table.rows[0];
  if (!first || !Array.isArray(first[iSeries])) return [];
  return (first[iSeries] as unknown[]).map(num);
}

/**
 * Z-normalize a series (subtract mean, divide by standard deviation). This is
 * the transform the SAX distance operates on, so plotting z-normalized values
 * reveals the *shape* match independent of absolute level or amplitude. Falls
 * back to mean-centering when the series is (near-)flat.
 */
export function znorm(values: number[]): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return values.map(() => 0);
  const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
  const variance = finite.reduce((s, v) => s + (v - mean) * (v - mean), 0) / finite.length;
  const std = Math.sqrt(variance);
  if (std < 1e-9) return values.map((v) => (Number.isFinite(v) ? v - mean : 0));
  return values.map((v) => (Number.isFinite(v) ? (v - mean) / std : 0));
}

/**
 * Resample a series to exactly `targetLen` points via linear interpolation.
 * Used to align matches of different durations (scale ≠ 1) onto a common
 * data-point axis so shapes overlay regardless of how long each match lasted.
 */
export function resampleToLength(values: number[], targetLen: number): number[] {
  const n = values.length;
  if (targetLen <= 0) return [];
  if (n === 0) return new Array(targetLen).fill(0);
  if (n === 1) return new Array(targetLen).fill(values[0]);
  if (n === targetLen) return values.slice();
  const out = new Array<number>(targetLen);
  for (let i = 0; i < targetLen; i++) {
    const pos = (i * (n - 1)) / (targetLen - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, n - 1);
    const frac = pos - lo;
    out[i] = values[lo] * (1 - frac) + values[hi] * frac;
  }
  return out;
}

/** Stable color for the match at rank `index` (0-based). */
export function matchColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/**
 * Slice `values[start..end]` with inclusive bounds (matching KQL `array_slice`),
 * clamped to the array so out-of-range match indices never throw. Used to cut a
 * matched track window out of its full binned search series.
 */
export function sliceInclusive(values: number[], start: number, end: number): number[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const lo = Math.max(0, Math.min(Math.round(start), values.length));
  const hi = Math.max(lo, Math.min(Math.round(end) + 1, values.length));
  return values.slice(lo, hi);
}
