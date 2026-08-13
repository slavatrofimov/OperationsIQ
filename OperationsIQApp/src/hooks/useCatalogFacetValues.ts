import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionProfile } from '../lib/connectionProfile';
import { profileToKqlOpts } from '../lib/connectionProfile';
import type { CatalogFilter, CatalogValue } from '../lib/catalog';
import { getFacetValues, DEFAULT_VALUES_TAKE } from '../lib/catalog';
import { useDebouncedValue } from './useDebouncedValue';

export interface UseCatalogFacetValuesOptions {
  /** Active connection profile; when null the hook stays idle with no values. */
  profile: ConnectionProfile | null | undefined;
  /** The facet whose distinct values to enumerate (facet/level key). */
  facetKey: string;
  /** Case-insensitive substring for type-ahead. */
  prefix?: string;
  /** Context filter (other active facets) so values cross-filter sensibly. */
  filter?: CatalogFilter;
  /** Max distinct values to fetch. Default {@link DEFAULT_VALUES_TAKE}. */
  take?: number;
  /** Debounce for the type-ahead prefix, in ms. Default 250. */
  debounceMs?: number;
  /** When false the hook is inert (used while the dropdown is closed). */
  enabled?: boolean;
}

export interface UseCatalogFacetValuesResult {
  values: CatalogValue[];
  loading: boolean;
  error?: string;
  /** Re-run the current values query. */
  reload: () => void;
}

/**
 * Debounced, cancelable lookup of one facet's distinct values via
 * `catalog.getFacetValues`. Loads (and reloads) whenever the profile, facet,
 * debounced prefix, or context filter changes while `enabled`; each new request
 * aborts the previous one and is generation-guarded so a late response for a
 * superseded prefix can never overwrite fresher values. Inert (and cleared)
 * while disabled, so a closed dropdown does no work and holds no rows.
 */
export function useCatalogFacetValues(
  opts: UseCatalogFacetValuesOptions,
): UseCatalogFacetValuesResult {
  const {
    profile,
    facetKey,
    prefix = '',
    filter,
    take = DEFAULT_VALUES_TAKE,
    debounceMs = 250,
    enabled = true,
  } = opts;

  const [values, setValues] = useState<CatalogValue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const debouncedPrefix = useDebouncedValue(prefix, debounceMs);
  // Stable content key so an identically-shaped filter object doesn't refetch.
  const filterKey = useMemo(() => JSON.stringify(filter ?? {}), [filter]);

  const filterRef = useRef(filter);
  filterRef.current = filter;
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const profileId = profile?.id;

  const run = useCallback(() => {
    if (!enabled || !profile) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++genRef.current;
    setLoading(true);
    setError(undefined);

    getFacetValues(
      profile,
      { key: facetKey, prefix: debouncedPrefix, filter: filterRef.current, take },
      profileToKqlOpts(profile),
      { signal: controller.signal },
    )
      .then((res) => {
        if (generation !== genRef.current) return; // superseded
        setValues(res);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || generation !== genRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [enabled, profile, facetKey, debouncedPrefix, take]);

  useEffect(() => {
    if (!enabled || !profileId) {
      abortRef.current?.abort();
      setValues([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    run();
    return () => abortRef.current?.abort();
    // run is stable for a given profile/facet/prefix/take; refetch on those + filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, profileId, facetKey, debouncedPrefix, filterKey, take]);

  const reload = useCallback(() => run(), [run]);

  return { values, loading, error, reload };
}
