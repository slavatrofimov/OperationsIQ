import { useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { computeVirtualWindow, shouldFetchMore } from '../lib/virtualWindow';

const useStyles = makeStyles({
  viewport: {
    overflowY: 'auto',
    overflowX: 'hidden',
    position: 'relative',
    paddingRight: tokens.spacingHorizontalXS,
  },
  spacerTop: { flexShrink: 0 },
  row: {
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
});

export interface VirtualListProps<T> {
  items: readonly T[];
  /** Fixed height (px) of every row. Must match the rendered row's box height. */
  rowHeight: number;
  /** Max height (px) of the scroll viewport. */
  maxHeight: number;
  /** Render one row's content. Kept inside a fixed-height, clipped row wrapper. */
  renderItem: (item: T, index: number) => ReactNode;
  /** Stable key for a row (defaults to its index). */
  itemKey?: (item: T, index: number) => string | number;
  /** Called when the user scrolls close to the bottom (for infinite paging). */
  onNeedMore?: () => void;
  /** Extra rows rendered above/below the viewport. Default 6. */
  overscan?: number;
}

/**
 * A minimal fixed-row-height virtual list. Only the rows intersecting the
 * viewport (plus overscan) are mounted; the remaining scroll height is reserved
 * with top/bottom spacers. All windowing math lives in `lib/virtualWindow` and is
 * unit-tested; this component is the thin DOM/scroll shell around it. No external
 * virtualization dependency is used.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  maxHeight,
  renderItem,
  itemKey,
  onNeedMore,
  overscan = 6,
}: VirtualListProps<T>) {
  const styles = useStyles();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(maxHeight);

  // Track the real viewport height (it may be shorter than maxHeight when the
  // list is short) so the window math and fetch-ahead trigger stay accurate.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (el) setViewportHeight(el.clientHeight || maxHeight);
  }, [maxHeight, items.length]);

  const win = computeVirtualWindow({
    scrollTop,
    viewportHeight,
    rowHeight,
    itemCount: items.length,
    overscan,
  });

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (el.clientHeight !== viewportHeight) setViewportHeight(el.clientHeight);
    if (
      onNeedMore &&
      shouldFetchMore({
        scrollTop: el.scrollTop,
        viewportHeight: el.clientHeight,
        rowHeight,
        itemCount: items.length,
      })
    ) {
      onNeedMore();
    }
  };

  const visible: ReactNode[] = [];
  for (let i = win.startIndex; i < win.endIndex; i++) {
    const item = items[i];
    visible.push(
      <div
        key={itemKey ? itemKey(item, i) : i}
        className={styles.row}
        style={{ height: rowHeight }}
      >
        {renderItem(item, i)}
      </div>,
    );
  }

  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      style={{ maxHeight }}
      onScroll={onScroll}
    >
      <div className={styles.spacerTop} style={{ height: win.paddingTop }} />
      {visible}
      <div style={{ height: win.paddingBottom }} />
    </div>
  );
}
