/**
 * Pure helpers backing the {@link CatalogContext} selection-resolution cache.
 *
 * In the scalable ("large catalog") world the app no longer holds every signal
 * in memory, so the labels, "selected tags" summaries and per-tag analysis that
 * used to read from the full `TagInfo[]` instead read from a bounded cache of the
 * *selected* (and recently browsed) ids, resolved on demand via
 * `catalog.getTagsByIds`. These helpers are the framework-free core of that cache
 * — id normalization, "what still needs fetching", immutable merge, and
 * cache-aware label formatting — kept separate from the React provider so they
 * can be unit-tested without a DOM or the Eventhouse/auth stack.
 */

import type { TagInfo } from '../lib/tags';
import type { SignalMetadataView } from '../lib/signalMetadata';
import { applySignalMetadataToTags } from '../lib/signalMetadataMerge';
import { formatTagLabel, type TagDisplayMode } from './TagDisplayContext';

/** Dedupe a list of ids, dropping empties, preserving first-seen order. */
export function normalizeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The subset of `ids` that still needs resolving — normalized, minus anything the
 * `has` predicate reports as already known (cached or in-flight). Returns [] when
 * nothing is missing so callers can skip the query entirely.
 */
export function selectMissing(ids: readonly string[], has: (id: string) => boolean): string[] {
  return normalizeIds(ids).filter((id) => !has(id));
}

/**
 * Immutably merge resolved tags into the cache. Returns a new Map (the input is
 * left untouched) with each valid tag keyed by its `tagId`; later entries win, so
 * a refreshed tag overwrites a stale one. Entries without a `tagId` are skipped.
 */
export function mergeResolved(
  prev: ReadonlyMap<string, TagInfo>,
  tags: readonly TagInfo[],
): Map<string, TagInfo> {
  const next = new Map(prev);
  for (const t of tags) {
    if (t && t.tagId) next.set(t.tagId, t);
  }
  return next;
}

/**
 * Overlay governed signal metadata onto `tags`, then merge the result into the
 * cache. This is the single choke point that gives the *large-mode* resolved
 * cache (and therefore the `tags` array pages read in large mode) the same
 * governed limits the small-mode full-load overlays up front. When `meta` is
 * empty — always the case in small mode, where the overlay happens on the full
 * load instead — `applySignalMetadataToTags` returns the input unchanged, so
 * this degrades to a plain {@link mergeResolved} with no behavior change.
 */
export function mergeResolvedWithMetadata(
  prev: ReadonlyMap<string, TagInfo>,
  tags: readonly TagInfo[],
  meta: ReadonlyMap<string, SignalMetadataView>,
): Map<string, TagInfo> {
  const overlaid =
    meta.size === 0
      ? tags
      : applySignalMetadataToTags([...tags], meta as Map<string, SignalMetadataView>);
  return mergeResolved(prev, overlaid);
}

/**
 * Re-overlay governed metadata onto tags already in the cache. Used when the
 * governed map arrives *after* some ids were resolved (the metadata load and the
 * selection resolution race): existing entries are re-run through the overlay so
 * their limits are backfilled. Returns `prev` untouched when there is nothing to
 * do (no metadata or an empty cache) so callers' `setState` bails out.
 */
export function reoverlayCache(
  prev: ReadonlyMap<string, TagInfo>,
  meta: ReadonlyMap<string, SignalMetadataView>,
): ReadonlyMap<string, TagInfo> {
  if (meta.size === 0 || prev.size === 0) return prev;
  return mergeResolvedWithMetadata(prev, Array.from(prev.values()), meta);
}

/**
 * Format a tag's display label honoring the current {@link TagDisplayMode},
 * resolving the name from the cache first and falling back to a caller-supplied
 * name (e.g. a chart's local `Map<tagId, tagName>`) when the id isn't cached yet.
 * `formatTagLabel` itself falls back to the id when no name is known.
 */
export function resolveTagLabel(
  cache: ReadonlyMap<string, TagInfo>,
  id: string,
  mode: TagDisplayMode,
  fallbackName?: string,
): string {
  const cached = cache.get(id);
  const name = cached?.tagName ?? fallbackName;
  return formatTagLabel(name, id, mode);
}
