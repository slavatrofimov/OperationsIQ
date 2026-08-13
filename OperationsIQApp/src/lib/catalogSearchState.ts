/**
 * Framework-free state model for incremental, server-backed catalog search.
 *
 * The server picker fetches one page at a time from `catalog.searchTags` as the
 * user types and scrolls. Because queries are debounced and cancelable, responses
 * can arrive out of order or after the query has moved on, so this reducer stamps
 * every request with a monotonically increasing `generation` and ignores any
 * response that doesn't match the latest one. Keeping the logic here (separate
 * from the React hook) lets us unit-test the tricky parts — stale-response
 * rejection, replace-vs-append paging, and de-duplication — without a DOM or the
 * Eventhouse stack.
 */

import type { TagInfo } from './tags';

export interface CatalogSearchState {
  /** Id of the most recently started request; older responses are ignored. */
  generation: number;
  /** Accumulated result rows (page 1..N when paging). */
  rows: TagInfo[];
  /** True when more rows matched beyond what has been fetched. */
  hasMore: boolean;
  /** True while a request is in flight. */
  loading: boolean;
  /** Last error message, if the most recent request failed. */
  error?: string;
}

export type CatalogSearchAction =
  | { type: 'start'; generation: number; append: boolean }
  | { type: 'success'; generation: number; rows: TagInfo[]; hasMore: boolean; append: boolean }
  | { type: 'failure'; generation: number; error: string }
  | { type: 'reset' };

export const initialSearchState: CatalogSearchState = {
  generation: 0,
  rows: [],
  hasMore: false,
  loading: false,
  error: undefined,
};

/** Append `next` after `prev`, skipping any rows whose `tagId` is already present. */
export function dedupeAppend(prev: readonly TagInfo[], next: readonly TagInfo[]): TagInfo[] {
  const seen = new Set(prev.map((t) => t.tagId));
  const out = prev.slice();
  for (const t of next) {
    if (t && t.tagId && !seen.has(t.tagId)) {
      seen.add(t.tagId);
      out.push(t);
    }
  }
  return out;
}

/**
 * Reduce a catalog-search action. `start` bumps the generation and marks loading
 * (clearing rows on a fresh, non-append query). `success`/`failure` are applied
 * only when their `generation` matches the current one, so late responses from a
 * superseded query are dropped.
 */
export function catalogSearchReducer(
  state: CatalogSearchState,
  action: CatalogSearchAction,
): CatalogSearchState {
  switch (action.type) {
    case 'start':
      return {
        generation: action.generation,
        rows: action.append ? state.rows : [],
        hasMore: action.append ? state.hasMore : false,
        loading: true,
        error: undefined,
      };
    case 'success':
      if (action.generation !== state.generation) return state;
      return {
        ...state,
        rows: action.append ? dedupeAppend(state.rows, action.rows) : action.rows.slice(),
        hasMore: action.hasMore,
        loading: false,
        error: undefined,
      };
    case 'failure':
      if (action.generation !== state.generation) return state;
      return { ...state, loading: false, error: action.error };
    case 'reset':
      return initialSearchState;
    default:
      return state;
  }
}
