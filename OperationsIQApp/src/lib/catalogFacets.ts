/**
 * Facet definitions and context helpers for the server-backed catalog picker.
 *
 * In the legacy (in-memory) picker, `getFacets` derives both the facet list and
 * their distinct values by scanning every loaded tag. That does not scale to a
 * large catalog, so the server-backed picker instead (a) knows the facet *shape*
 * up-front — the profile's hierarchy levels plus Metric and Engineering Units —
 * and (b) fetches each facet's values on demand via `catalog.getFacetValues`.
 *
 * These pure helpers produce that facet shape and the per-facet context filter,
 * with no dependency on a loaded catalog, so they can be unit-tested in isolation.
 */

import type { CatalogFilter } from './catalog';
import type { HierarchyLevel } from './tagTree';

/** A server-backed facet the user can filter by (values are fetched lazily). */
export interface ServerFacetDef {
  /** Stable key used in the selection map and mapped to a Catalog column. */
  key: string;
  /** Human label (profile-driven where relevant). */
  label: string;
}

/** Optional label overrides so facet titles match the active profile's terminology. */
export interface ServerFacetLabelOptions {
  metricLabel?: string;
  unitsLabel?: string;
}

/**
 * The ordered facet definitions for server-backed browsing: one per hierarchy
 * level (in profile order) followed by Metric and Engineering Units. Unlike the
 * in-memory `getFacets`, this does not drop single-value facets — distinct-value
 * counts aren't known without a query — so all defined facets are offered.
 */
export function getServerFacetDefs(
  hierarchyLevels: readonly HierarchyLevel[],
  opts: ServerFacetLabelOptions = {},
): ServerFacetDef[] {
  return [
    ...hierarchyLevels.map((l) => ({ key: l.key, label: l.label })),
    { key: 'metric', label: opts.metricLabel || 'Metric' },
    { key: 'engUnits', label: opts.unitsLabel || 'Engineering Units' },
  ];
}

/**
 * Build the context filter used when fetching one facet's values: the *other*
 * active facet selections, so the facets cross-filter each other, but never the
 * facet's own selection (which would hide its currently-unselected values). The
 * free-text query is intentionally excluded so a facet's options don't vanish as
 * the user types in the main search box (matching the in-memory picker, whose
 * facet values are independent of the query).
 */
export function facetContextFilter(
  key: string,
  selections: Record<string, string[]>,
): CatalogFilter {
  const facetSelections: Record<string, string[]> = {};
  for (const [k, vals] of Object.entries(selections)) {
    if (k === key) continue;
    if (vals && vals.length > 0) facetSelections[k] = vals;
  }
  return { facetSelections };
}
