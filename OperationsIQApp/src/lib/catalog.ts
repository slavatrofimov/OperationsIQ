/**
 * Scalable catalog data-access service.
 *
 * The legacy path (`listTags`) loads the entire signal catalog into memory and
 * filters/faceted-searches it client-side. That is fine for small catalogs but
 * does not scale to hundreds of thousands of signals (memory, non-virtualized
 * rendering, Kusto's 500k-row result truncation). This service instead keeps the
 * heavy lifting server-side: it issues small, targeted, cancelable KQL queries
 * against the canonical `Catalog` table (see {@link buildCatalogPrelude}) and
 * returns only what the UI needs right now — a page of search results, the
 * children of one hierarchy node, the distinct values of one facet, the metadata
 * for a bounded set of selected ids, or a count.
 *
 * Every dynamic value is escaped via the kql.ts literal helpers, so untrusted UI
 * input cannot inject KQL. All queries run under the user's delegated token, so
 * RLS is enforced exactly as with the legacy path.
 */

import type { ConnectionProfile, KqlOptions } from './connectionProfile';
import { buildCatalogPrelude, mapCanonicalRows, type CanonicalRow, type TagInfo } from './tags';
import { queryRows } from './eventhouse';
import { kqlString, kqlStringArray, kqlInt } from './kql';

// ---------------------------------------------------------------------------
// Facet key → canonical column mapping
// ---------------------------------------------------------------------------

/**
 * Map a facet / hierarchy-level key (as produced by getFacets / getHierarchyLevels)
 * to its canonical `Catalog` column. Supports both the default Contoso hierarchy
 * keys (plant/factory/line/station → Level1..Level4) and the profile-driven
 * generic keys (level1..level10), plus the Metric and Engineering-Units facets.
 * Returns `undefined` for unknown keys so callers can skip them safely.
 */
export function catalogColumnForKey(key: string): string | undefined {
  switch (key) {
    case 'plant':
      return 'Level1';
    case 'factory':
      return 'Level2';
    case 'line':
      return 'Level3';
    case 'station':
      return 'Level4';
    case 'metric':
      return 'MetricName';
    case 'engUnits':
      return 'UnitOfMeasure';
    default: {
      const m = /^level([1-9]|10)$/.exec(key);
      return m ? `Level${m[1]}` : undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A shared catalog filter: free text + exact scope + multi-value facet selections. */
export interface CatalogFilter {
  /** Free-text search across name / id / metric / description (case-insensitive). */
  query?: string;
  /** Exact, case-insensitive equality on hierarchy levels (facet key → value). */
  scope?: Record<string, string | undefined>;
  /** Multi-value facet selections (facet key → values); OR within, AND across. */
  facetSelections?: Record<string, string[]>;
}

export interface SearchTagsParams extends CatalogFilter {
  /** Rows to skip (paging). Default 0. */
  skip?: number;
  /** Max rows to return. Default {@link DEFAULT_SEARCH_TAKE}, capped at {@link MAX_SEARCH_TAKE}. */
  take?: number;
}

export interface SearchTagsResult {
  rows: TagInfo[];
  /** True when more rows matched beyond the returned page (detected via take+1). */
  hasMore: boolean;
}

/** A distinct hierarchy-child or facet value with the number of signals under it. */
export interface CatalogValue {
  value: string;
  count: number;
}

export interface HierarchyChildrenParams {
  /** Exact parent-scope filters (facet key → value) narrowing to a subtree. */
  scope?: Record<string, string | undefined>;
  /** The child level to enumerate (facet/level key, e.g. "level3"). */
  childKey: string;
  /** Max distinct values to return. Default {@link DEFAULT_VALUES_TAKE}. */
  take?: number;
}

export interface FacetValuesParams {
  /** The facet to enumerate (facet key). */
  key: string;
  /** Optional case-insensitive substring filter for type-ahead. */
  prefix?: string;
  /** Additional context filter (other facets / scope) to keep values relevant. */
  filter?: CatalogFilter;
  /** Max distinct values to return. Default {@link DEFAULT_VALUES_TAKE}. */
  take?: number;
}

export const DEFAULT_SEARCH_TAKE = 200;
export const MAX_SEARCH_TAKE = 1000;
export const DEFAULT_VALUES_TAKE = 500;

const clampTake = (take: number | undefined, fallback: number, max = MAX_SEARCH_TAKE): number => {
  const n = typeof take === 'number' && Number.isFinite(take) ? Math.floor(take) : fallback;
  return Math.min(Math.max(n, 1), max);
};

// ---------------------------------------------------------------------------
// WHERE-clause builders (pure, exported for testing)
// ---------------------------------------------------------------------------

/** Free-text search clause: each whitespace-separated term must appear (AND) in
 *  one of name / id / metric / description (OR). `contains` is case-insensitive. */
export function buildSearchWhere(query?: string): string {
  const terms = (query ?? '').trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return '';
  const cols = ['SignalName', 'SignalId', 'MetricName', 'Description'];
  return terms
    .map((t) => {
      const lit = kqlString(t);
      return `| where (${cols.map((c) => `${c} contains ${lit}`).join(' or ')})`;
    })
    .join('\n');
}

/** Exact equality clauses for a scope map (facet key → value). */
export function buildScopeWhere(scope?: Record<string, string | undefined>): string {
  if (!scope) return '';
  return Object.entries(scope)
    .map(([key, value]) => {
      const col = catalogColumnForKey(key);
      const v = value?.trim();
      if (!col || !v) return '';
      return `| where ${col} == ${kqlString(v)}`;
    })
    .filter(Boolean)
    .join('\n');
}

/** Multi-value `in (...)` clauses for facet selections (OR within, AND across). */
export function buildFacetWhere(selections?: Record<string, string[]>): string {
  if (!selections) return '';
  return Object.entries(selections)
    .map(([key, values]) => {
      const col = catalogColumnForKey(key);
      const vals = (values ?? []).filter((v) => v && v.trim());
      if (!col || vals.length === 0) return '';
      return `| where ${col} in (${kqlStringArray(vals)})`;
    })
    .filter(Boolean)
    .join('\n');
}

/** Combined WHERE body for a CatalogFilter (scope, facets, then free text). */
function buildFilterBody(filter: CatalogFilter): string {
  return [
    buildScopeWhere(filter.scope),
    buildFacetWhere(filter.facetSelections),
    buildSearchWhere(filter.query),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Join non-empty query segments with newlines. */
function joinCsl(...parts: string[]): string {
  return parts.filter((p) => p && p.length > 0).join('\n');
}

// ---------------------------------------------------------------------------
// Query builders (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * A page of matching signals, ordered by name then id. Requests `take + 1` rows
 * so the caller can detect (and trim) an over-fetch into a `hasMore` flag without
 * a separate count query. Paging uses `row_number()` since KQL has no OFFSET.
 */
export function buildSearchTagsQuery(profile: ConnectionProfile, params: SearchTagsParams): string {
  const take = clampTake(params.take, DEFAULT_SEARCH_TAKE);
  const skip = Math.max(0, Math.floor(params.skip ?? 0));
  const body = joinCsl(
    buildFilterBody(params),
    '| order by SignalName asc, SignalId asc',
    '| serialize Rn = row_number()',
    skip > 0 ? `| where Rn > ${kqlInt(skip)}` : '',
    `| take ${kqlInt(take + 1)}`,
    '| project-away Rn',
  );
  return `${buildCatalogPrelude(profile)}\nCatalog\n${body}`;
}

/** Full canonical rows for a bounded set of signal ids (e.g. the current selection). */
export function buildTagsByIdsQuery(profile: ConnectionProfile, ids: string[]): string {
  return `${buildCatalogPrelude(profile)}\nCatalog\n| where SignalId in (${kqlStringArray(ids)})`;
}

/** Count of signals matching a filter (for exact "of N" totals). */
export function buildCountTagsQuery(profile: ConnectionProfile, filter: CatalogFilter = {}): string {
  return joinCsl(buildCatalogPrelude(profile), 'Catalog', buildFilterBody(filter), '| count');
}

/**
 * Distinct child values (+ signal counts) at one hierarchy level within a parent
 * scope — the on-demand expansion query for a lazy hierarchy tree.
 */
export function buildHierarchyChildrenQuery(
  profile: ConnectionProfile,
  params: HierarchyChildrenParams,
): string {
  const col = catalogColumnForKey(params.childKey);
  if (!col) throw new Error(`Unknown hierarchy level key: ${params.childKey}`);
  const take = clampTake(params.take, DEFAULT_VALUES_TAKE);
  return joinCsl(
    buildCatalogPrelude(profile),
    'Catalog',
    buildScopeWhere(params.scope),
    `| where isnotempty(${col})`,
    `| summarize Count = count() by Value = ${col}`,
    '| order by Value asc',
    `| take ${kqlInt(take)}`,
  );
}

/**
 * Distinct values (+ signal counts) for a single facet, optionally type-ahead
 * filtered by a prefix and narrowed by other active filters.
 */
export function buildFacetValuesQuery(
  profile: ConnectionProfile,
  params: FacetValuesParams,
): string {
  const col = catalogColumnForKey(params.key);
  if (!col) throw new Error(`Unknown facet key: ${params.key}`);
  const take = clampTake(params.take, DEFAULT_VALUES_TAKE);
  const prefix = params.prefix?.trim();
  return joinCsl(
    buildCatalogPrelude(profile),
    'Catalog',
    params.filter ? buildFilterBody(params.filter) : '',
    `| where isnotempty(${col})`,
    prefix ? `| where ${col} contains ${kqlString(prefix)}` : '',
    `| summarize Count = count() by Value = ${col}`,
    '| order by Value asc',
    `| take ${kqlInt(take)}`,
  );
}

// ---------------------------------------------------------------------------
// Async service functions
// ---------------------------------------------------------------------------

type Exec = { signal?: AbortSignal };

/** Run a server-side signal search and return one page plus a `hasMore` flag. */
export async function searchTags(
  profile: ConnectionProfile,
  params: SearchTagsParams,
  opts?: KqlOptions,
  exec?: Exec,
): Promise<SearchTagsResult> {
  const take = clampTake(params.take, DEFAULT_SEARCH_TAKE);
  const csl = buildSearchTagsQuery(profile, params);
  const rows = await queryRows<CanonicalRow>(csl, opts, exec);
  const hasMore = rows.length > take;
  return { rows: mapCanonicalRows(hasMore ? rows.slice(0, take) : rows), hasMore };
}

/**
 * Resolve full metadata for a bounded set of ids (the selection cache). Returns
 * an empty array without querying when `ids` is empty.
 */
export async function getTagsByIds(
  profile: ConnectionProfile,
  ids: string[],
  opts?: KqlOptions,
  exec?: Exec,
): Promise<TagInfo[]> {
  const unique = [...new Set(ids.filter((id) => id && id.length > 0))];
  if (unique.length === 0) return [];
  const csl = buildTagsByIdsQuery(profile, unique);
  return mapCanonicalRows(await queryRows<CanonicalRow>(csl, opts, exec));
}

/** Enumerate the children of one hierarchy node (lazy tree expansion). */
export async function getHierarchyChildren(
  profile: ConnectionProfile,
  params: HierarchyChildrenParams,
  opts?: KqlOptions,
  exec?: Exec,
): Promise<CatalogValue[]> {
  const csl = buildHierarchyChildrenQuery(profile, params);
  const rows = await queryRows<{ Value: string; Count: number }>(csl, opts, exec);
  return rows.map((r) => ({ value: r.Value, count: Number(r.Count) || 0 }));
}

/** Enumerate distinct values of one facet (with counts), optional type-ahead. */
export async function getFacetValues(
  profile: ConnectionProfile,
  params: FacetValuesParams,
  opts?: KqlOptions,
  exec?: Exec,
): Promise<CatalogValue[]> {
  const csl = buildFacetValuesQuery(profile, params);
  const rows = await queryRows<{ Value: string; Count: number }>(csl, opts, exec);
  return rows.map((r) => ({ value: r.Value, count: Number(r.Count) || 0 }));
}

/** Count signals matching a filter (empty filter → full catalog size). */
export async function countTags(
  profile: ConnectionProfile,
  filter: CatalogFilter = {},
  opts?: KqlOptions,
  exec?: Exec,
): Promise<number> {
  const csl = buildCountTagsQuery(profile, filter);
  const rows = await queryRows<{ Count: number }>(csl, opts, exec);
  return rows.length > 0 ? Number(rows[0].Count) || 0 : 0;
}

/** Approximate catalog size — used once per connection to pick the browsing mode. */
export async function approxCountTags(
  profile: ConnectionProfile,
  opts?: KqlOptions,
  exec?: Exec,
): Promise<number> {
  return countTags(profile, {}, opts, exec);
}
