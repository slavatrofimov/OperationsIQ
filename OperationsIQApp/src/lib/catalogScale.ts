/**
 * Deterministic synthetic-catalog generator and page slicer used by the catalog
 * scale harness and its bounded-ness tests.
 *
 * The 500K-tag scaling work rests on one invariant: in `large` mode the browser
 * never materializes the whole catalog. What it *does* hold — a page of search
 * results, one expanded hierarchy level, the resolved-selection cache — is
 * bounded by what the user fetched, independent of how many tags exist on the
 * server. These helpers let us prove that invariant (and benchmark it) without a
 * live Eventhouse: generate N realistic {@link TagInfo} rows, then simulate the
 * server by slicing bounded pages/levels out of them.
 *
 * Everything here is pure and network-free so it runs under the Node test runner.
 */

import type { TagInfo } from './tags';
import type { CatalogValue } from './catalog';

/** Shape of the synthetic hierarchy: `level1 → level2 → level3` fan-out. */
export interface SyntheticDims {
  /** Distinct level-1 (plant) values. */
  plants: number;
  /** Distinct level-2 (area) values per plant. */
  areasPerPlant: number;
  /** Distinct level-3 (unit) values per area. */
  unitsPerArea: number;
}

/** A middle-of-the-road industrial shape: 10 × 20 × 25 = 5,000 leaf scopes. */
export const DEFAULT_DIMS: SyntheticDims = {
  plants: 10,
  areasPerPlant: 20,
  unitsPerArea: 25,
};

const METRICS = [
  'Temperature', 'Pressure', 'Flow', 'Level', 'Vibration',
  'Speed', 'Torque', 'Current', 'Voltage', 'Power',
] as const;

const UNITS = ['°C', 'bar', 'm3/h', 'm', 'mm/s', 'rpm', 'Nm', 'A', 'V', 'kW'] as const;

/**
 * Build one deterministic synthetic tag for index `i`. The index is spread across
 * the hierarchy so the generated catalog has a realistic, balanced tree shape and
 * every `tagId` is unique.
 */
export function makeSyntheticTag(i: number, dims: SyntheticDims = DEFAULT_DIMS): TagInfo {
  const areasTotal = dims.plants * dims.areasPerPlant;
  const unitsTotal = areasTotal * dims.unitsPerArea;

  const plantIdx = i % dims.plants;
  const areaIdx = Math.floor(i / dims.plants) % dims.areasPerPlant;
  const unitIdx = Math.floor(i / areasTotal) % dims.unitsPerArea;
  const metricIdx = Math.floor(i / unitsTotal) % METRICS.length;

  const metric = METRICS[metricIdx];
  const level1 = `Plant ${String(plantIdx + 1).padStart(2, '0')}`;
  const level2 = `Area ${String(areaIdx + 1).padStart(2, '0')}`;
  const level3 = `Unit ${String(unitIdx + 1).padStart(3, '0')}`;

  return {
    tagId: `SIG-${i}`,
    tagName: `${level1}/${level2}/${level3}/${metric}`,
    metric,
    description: `${metric} on ${level1} ${level2} ${level3}`,
    engUnits: UNITS[metricIdx],
    level1,
    level2,
    level3,
    plant: level1,
    factory: level2,
    line: level3,
  };
}

/**
 * Generate `n` deterministic synthetic tags. Suitable for large `n` (the harness
 * uses 500,000); the array itself is the "server-side" catalog that the paging
 * helpers below carve bounded slices out of.
 */
export function generateSyntheticTags(n: number, dims: SyntheticDims = DEFAULT_DIMS): TagInfo[] {
  const out = new Array<TagInfo>(Math.max(0, n));
  for (let i = 0; i < n; i++) out[i] = makeSyntheticTag(i, dims);
  return out;
}

/**
 * Simulate a `catalog.searchTags` page: the rows whose name/metric/id/description
 * contain `query` (case-insensitive), sliced to `[skip, skip + take)`. Mirrors the
 * server contract the client pages through, so a test can drive the real search
 * reducer with realistic, bounded pages. Returns `hasMore` when more matched
 * beyond the page.
 */
export function searchPage(
  catalog: readonly TagInfo[],
  query: string,
  skip: number,
  take: number,
): { rows: TagInfo[]; hasMore: boolean } {
  const needle = query.trim().toLowerCase();
  const matches: TagInfo[] = [];
  // Collect just enough to answer this page plus one, so we never build the full
  // match set for a broad query — the same bound the server enforces with `take`.
  for (const t of catalog) {
    if (
      !needle ||
      t.tagName.toLowerCase().includes(needle) ||
      t.metric.toLowerCase().includes(needle) ||
      t.tagId.toLowerCase().includes(needle) ||
      t.description.toLowerCase().includes(needle)
    ) {
      matches.push(t);
      if (matches.length >= skip + take + 1) break;
    }
  }
  const rows = matches.slice(skip, skip + take);
  const hasMore = matches.length > skip + take;
  return { rows, hasMore };
}

/**
 * Simulate `catalog.getHierarchyChildren`: the distinct values of `levelKey`
 * among rows matching `scope` (level key → value equality), with per-value signal
 * counts, sorted for stable display. Bounded by the level's cardinality, never by
 * the catalog size.
 */
export function hierarchyChildren(
  catalog: readonly TagInfo[],
  scope: Record<string, string>,
  levelKey: keyof TagInfo,
): CatalogValue[] {
  const counts = new Map<string, number>();
  const scopeEntries = Object.entries(scope) as [keyof TagInfo, string][];
  for (const t of catalog) {
    let inScope = true;
    for (const [k, v] of scopeEntries) {
      if (t[k] !== v) {
        inScope = false;
        break;
      }
    }
    if (!inScope) continue;
    const value = t[levelKey];
    if (typeof value !== 'string' || value.length === 0) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort((a, b) =>
    a.value.localeCompare(b.value),
  );
}
