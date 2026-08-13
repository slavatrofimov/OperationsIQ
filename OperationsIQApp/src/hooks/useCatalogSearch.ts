import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ConnectionProfile } from '../lib/connectionProfile';
import { profileToKqlOpts } from '../lib/connectionProfile';
import type { CatalogFilter } from '../lib/catalog';
import { searchTags, DEFAULT_SEARCH_TAKE } from '../lib/catalog';
import {
  catalogSearchReducer,
  initialSearchState,
  type CatalogSearchState,
} from '../lib/catalogSearchState';
import { useDebouncedValue } from './useDebouncedValue';

export interface UseCatalogSearchOptions {
  /** Active connection profile; when null the hook stays idle with no results. */
  profile: ConnectionProfile | null | undefined;
  /** The current search filter (free text + scope + facet selections). */
  filter: CatalogFilter;
  /** Page size. Default {@link DEFAULT_SEARCH_TAKE}. */
  take?: number;
  /** Debounce for the free-text query, in ms. Default 200. */
  debounceMs?: number;
  /** When false, the hook is inert (used to skip work while a picker is closed). */
  enabled?: boolean;
}

export interface UseCatalogSearchResult extends CatalogSearchState {
  /** Fetch the next page (no-op while loading or when there is nothing more). */
  loadMore: () => void;
  /** Re-run the current query from the first page. */
  reload: () => void;
}

/**
 * Debounced, cancelable, paged catalog search backed by `catalog.searchTags`.
 *
 * Every fetch is stamped with a generation via the reducer, and each new query
 * aborts the previous in-flight request, so results never arrive out of order or
 * for a stale query. The first page loads (or reloads) whenever the profile or
 * the debounced filter changes; `loadMore` appends subsequent pages.
 */
export function useCatalogSearch(opts: UseCatalogSearchOptions): UseCatalogSearchResult {
  const { profile, filter, take = DEFAULT_SEARCH_TAKE, debounceMs = 200, enabled = true } = opts;

  const [state, dispatch] = useReducer(catalogSearchReducer, initialSearchState);

  // A stable key so identical filters don't re-trigger; the latest filter object
  // is read from a ref inside fetches to avoid stale closures.
  const filterKey = useMemo(() => JSON.stringify(filter ?? {}), [filter]);
  const debouncedKey = useDebouncedValue(filterKey, debounceMs);

  const filterRef = useRef(filter);
  filterRef.current = filter;
  const stateRef = useRef(state);
  stateRef.current = state;
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const profileId = profile?.id;

  const runFetch = useCallback(
    (append: boolean) => {
      if (!enabled || !profile) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const generation = ++genRef.current;
      const skip = append ? stateRef.current.rows.length : 0;
      dispatch({ type: 'start', generation, append });

      searchTags(
        profile,
        { ...filterRef.current, skip, take },
        profileToKqlOpts(profile),
        { signal: controller.signal },
      )
        .then((res) => {
          dispatch({
            type: 'success',
            generation,
            rows: res.rows,
            hasMore: res.hasMore,
            append,
          });
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return; // superseded; ignore
          dispatch({
            type: 'failure',
            generation,
            error: e instanceof Error ? e.message : String(e),
          });
        });
    },
    [enabled, profile, take],
  );

  // (Re)load the first page when the profile or the debounced filter changes.
  useEffect(() => {
    if (!enabled) {
      dispatch({ type: 'reset' });
      return;
    }
    if (!profileId) {
      dispatch({ type: 'reset' });
      return;
    }
    runFetch(false);
    return () => abortRef.current?.abort();
    // runFetch is stable for a given profile/take; re-run on filter/profile change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, profileId, debouncedKey, take]);

  const loadMore = useCallback(() => {
    if (stateRef.current.loading || !stateRef.current.hasMore) return;
    runFetch(true);
  }, [runFetch]);

  const reload = useCallback(() => runFetch(false), [runFetch]);

  return { ...state, loadMore, reload };
}
