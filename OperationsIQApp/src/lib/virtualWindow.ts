/**
 * Framework-free windowing math for a fixed-row-height virtual list.
 *
 * The server-backed catalog picker must stay responsive with hundreds of
 * thousands of signals. Rendering every fetched row into the DOM (as a plain
 * "Load more" list does) grows unbounded and eventually janks the browser, which
 * defeats the whole point of the scalable catalog service. Instead we render only
 * the rows intersecting the viewport (plus a small overscan) and reserve the rest
 * of the scroll height with spacer padding.
 *
 * Keeping the arithmetic here — separate from the React component that owns the
 * scroll container — lets us unit-test the tricky boundary conditions (empty
 * lists, over-scroll, overscan clamping, the fetch-ahead trigger) without a DOM.
 */

export interface VirtualWindow {
  /** Index of the first row to render (inclusive), clamped to [0, itemCount]. */
  startIndex: number;
  /** Index one past the last row to render (exclusive), clamped to [0, itemCount]. */
  endIndex: number;
  /** Spacer height (px) above the rendered rows to preserve scroll position. */
  paddingTop: number;
  /** Spacer height (px) below the rendered rows so the scrollbar stays correct. */
  paddingBottom: number;
  /** Total scrollable height (px) of the full list. */
  totalHeight: number;
}

export interface VirtualWindowParams {
  /** Current scroll offset of the viewport, in px. */
  scrollTop: number;
  /** Visible height of the viewport, in px. */
  viewportHeight: number;
  /** Fixed height of every row, in px. Must be > 0. */
  rowHeight: number;
  /** Total number of items in the list. */
  itemCount: number;
  /** Extra rows to render above/below the viewport to smooth fast scrolls. Default 4. */
  overscan?: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/**
 * Compute which slice of a fixed-height list to render for the current scroll
 * position. Returns an empty window (all zero) when there is nothing to show or
 * the inputs are degenerate (non-positive row height / viewport).
 */
export function computeVirtualWindow(params: VirtualWindowParams): VirtualWindow {
  const { scrollTop, viewportHeight, rowHeight, itemCount } = params;
  const overscan = Math.max(0, Math.floor(params.overscan ?? 4));

  if (itemCount <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0 };
  }

  const totalHeight = itemCount * rowHeight;
  const safeScroll = clamp(scrollTop, 0, Math.max(0, totalHeight));
  const firstVisible = Math.floor(safeScroll / rowHeight);
  // At least one row is visible even if the viewport height is unknown (0).
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));

  const startIndex = clamp(firstVisible - overscan, 0, itemCount);
  const endIndex = clamp(firstVisible + visibleCount + overscan, startIndex, itemCount);

  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * rowHeight,
    paddingBottom: (itemCount - endIndex) * rowHeight,
    totalHeight,
  };
}

/**
 * Whether the current scroll position is close enough to the bottom to warrant
 * pre-fetching the next page. `thresholdRows` is expressed in rows so the trigger
 * scales with row height. Returns false when there is no viewport yet.
 */
export function shouldFetchMore(params: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  itemCount: number;
  thresholdRows?: number;
}): boolean {
  const { scrollTop, viewportHeight, rowHeight, itemCount } = params;
  if (itemCount <= 0 || rowHeight <= 0 || viewportHeight <= 0) return false;
  const threshold = Math.max(0, Math.floor(params.thresholdRows ?? 8)) * rowHeight;
  const totalHeight = itemCount * rowHeight;
  const distanceToBottom = totalHeight - (scrollTop + viewportHeight);
  return distanceToBottom <= threshold;
}
