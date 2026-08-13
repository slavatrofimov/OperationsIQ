/**
 * Catalog "size mode" selection.
 *
 * The app supports two data-access strategies for the signal catalog:
 *
 * - **small** — the legacy path: load the whole catalog into memory once
 *   (`listTags`) and search / facet / build the hierarchy tree client-side.
 *   Instant and zero-risk for modest catalogs.
 * - **large** — the scalable path: keep the catalog server-side and issue small,
 *   targeted, cancelable KQL queries (`lib/catalog.ts`) for a page of search
 *   results, one hierarchy node's children, or the metadata of the selected ids.
 *   Bounded memory + no per-keystroke O(n) work, so it stays usable at ~500k
 *   signals.
 *
 * The mode is chosen automatically from a one-time size probe
 * (`approxCountTags`) per connection. This module holds only the pure decision so
 * it is trivially unit-testable; the probing + wiring live in `CatalogContext`.
 */

export type CatalogMode = 'small' | 'large';

/**
 * Signal count above which the server-backed ("large") path is used. Chosen near
 * the top of what the in-memory path handles comfortably on a typical laptop; the
 * legacy path stays in charge for everything at or below it so small catalogs see
 * zero behavioral change.
 */
export const LARGE_CATALOG_THRESHOLD = 50_000;

/**
 * Pick the catalog mode for an (approximate) signal count.
 *
 * Returns `'small'` when the count is unknown (`null`/`undefined`) or not yet a
 * finite number, so the app defaults to the zero-risk in-memory path while the
 * size probe is still in flight or if it failed — auto-upgrading to `'large'`
 * only once we positively know the catalog exceeds the threshold.
 */
export function catalogModeForCount(
  count: number | null | undefined,
  threshold: number = LARGE_CATALOG_THRESHOLD,
): CatalogMode {
  return typeof count === 'number' && Number.isFinite(count) && count > threshold
    ? 'large'
    : 'small';
}
