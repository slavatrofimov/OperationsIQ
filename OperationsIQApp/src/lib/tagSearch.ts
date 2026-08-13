/**
 * Faceting + filtering logic for the advanced tag search. Kept as pure functions
 * (no React) so the same rules power the popover TagPicker, the inline TagBrowser,
 * and any future tag surface. Facets are derived from the flat tag catalog: the
 * dynamic asset-hierarchy levels (profile-driven) plus Metric and Engineering
 * Units. Free-text matching reuses `tagMatches` from tagTree.
 */
import type { TagInfo } from './tags';
import { tagMatches, type HierarchyLevel } from './tagTree';

/** A metadata dimension the user can filter by (e.g. a hierarchy level or Metric). */
export interface Facet {
  /** Stable key used in the selection map. */
  key: string;
  /** Human label (localized/profile-driven where relevant). */
  label: string;
  /** Read the facet value off a tag. */
  get: (t: TagInfo) => string | undefined;
  /** Sorted distinct non-empty values present in the catalog. */
  values: string[];
}

/** Current search state: free text plus selected values per facet (OR within a facet). */
export interface TagFilter {
  query: string;
  /** facet key -> selected values. A facet absent or empty imposes no constraint. */
  selections: Record<string, string[]>;
}

export const EMPTY_FILTER: TagFilter = { query: '', selections: {} };

/** Optional label overrides so facet titles match the active profile's terminology. */
export interface FacetLabelOptions {
  metricLabel?: string;
  unitsLabel?: string;
}

/**
 * Build the list of filterable facets for a tag catalog. Includes one facet per
 * hierarchy level followed by Metric and Engineering Units. Only facets that have
 * more than one distinct value are returned, so small/uniform catalogs stay clean.
 */
export function getFacets(
  tags: TagInfo[],
  hierarchyLevels: readonly HierarchyLevel[],
  opts: FacetLabelOptions = {},
): Facet[] {
  const candidates: Array<Pick<Facet, 'key' | 'label' | 'get'>> = [
    ...hierarchyLevels.map((l) => ({ key: l.key, label: l.label, get: l.get })),
    { key: 'metric', label: opts.metricLabel || 'Metric', get: (t: TagInfo) => t.metric },
    { key: 'engUnits', label: opts.unitsLabel || 'Engineering Units', get: (t: TagInfo) => t.engUnits },
  ];

  return candidates
    .map((c) => {
      const set = new Set<string>();
      for (const t of tags) {
        const v = c.get(t)?.trim();
        if (v) set.add(v);
      }
      const values = [...set].sort((a, b) => a.localeCompare(b));
      return { ...c, values };
    })
    .filter((f) => f.values.length > 1);
}

/** True when the filter imposes no constraint (no query and no selected facet values). */
export function isFilterActive(filter: TagFilter): boolean {
  if (filter.query.trim()) return true;
  return Object.values(filter.selections).some((v) => v.length > 0);
}

/**
 * Apply free-text search AND facet selections to the catalog. Within a single
 * facet the selected values are OR-ed; across facets they are AND-ed. `facets`
 * supplies the value accessors keyed by facet key.
 */
export function filterTags(tags: TagInfo[], filter: TagFilter, facets: Facet[]): TagInfo[] {
  const getByKey = new Map(facets.map((f) => [f.key, f.get]));
  const activeSelections = Object.entries(filter.selections)
    .filter(([, vals]) => vals.length > 0)
    .map(([key, vals]) => ({ get: getByKey.get(key), values: new Set(vals) }))
    .filter((s): s is { get: (t: TagInfo) => string | undefined; values: Set<string> } => !!s.get);

  const q = filter.query;

  return tags.filter((tag) => {
    if (q.trim() && !tagMatches(tag, q)) return false;
    for (const sel of activeSelections) {
      const v = sel.get(tag)?.trim();
      if (!v || !sel.values.has(v)) return false;
    }
    return true;
  });
}
