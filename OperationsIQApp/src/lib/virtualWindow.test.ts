import { describe, it, expect } from 'vitest';
import { computeVirtualWindow, shouldFetchMore } from './virtualWindow';

describe('computeVirtualWindow', () => {
  it('returns an empty window for an empty list', () => {
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: 28, itemCount: 0 });
    expect(w).toEqual({ startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0 });
  });

  it('returns an empty window for a non-positive row height', () => {
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: 0, itemCount: 100 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(0);
    expect(w.totalHeight).toBe(0);
  });

  it('renders from the top with overscan below when unscrolled', () => {
    const w = computeVirtualWindow({
      scrollTop: 0,
      viewportHeight: 280, // 10 rows @ 28
      rowHeight: 28,
      itemCount: 1000,
      overscan: 4,
    });
    expect(w.startIndex).toBe(0);
    // 10 visible + 4 overscan below (no overscan above at the top).
    expect(w.endIndex).toBe(14);
    expect(w.paddingTop).toBe(0);
    expect(w.paddingBottom).toBe((1000 - 14) * 28);
    expect(w.totalHeight).toBe(1000 * 28);
  });

  it('windows around the scroll position with overscan on both sides', () => {
    const w = computeVirtualWindow({
      scrollTop: 28 * 100, // first visible row = 100
      viewportHeight: 280, // 10 rows
      rowHeight: 28,
      itemCount: 1000,
      overscan: 4,
    });
    expect(w.startIndex).toBe(96); // 100 - 4
    expect(w.endIndex).toBe(114); // 100 + 10 + 4
    expect(w.paddingTop).toBe(96 * 28);
    expect(w.paddingBottom).toBe((1000 - 114) * 28);
  });

  it('clamps the window at the end of the list', () => {
    const w = computeVirtualWindow({
      scrollTop: 28 * 100000, // far past the end
      viewportHeight: 280,
      rowHeight: 28,
      itemCount: 500,
      overscan: 4,
    });
    expect(w.endIndex).toBe(500);
    expect(w.startIndex).toBeLessThanOrEqual(500);
    expect(w.paddingBottom).toBe(0);
    expect(w.paddingTop).toBe(w.startIndex * 28);
  });

  it('treats a negative scrollTop as the top of the list', () => {
    const w = computeVirtualWindow({ scrollTop: -50, viewportHeight: 280, rowHeight: 28, itemCount: 100 });
    expect(w.startIndex).toBe(0);
    expect(w.paddingTop).toBe(0);
  });

  it('renders at least one row when the viewport height is unknown', () => {
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 0, rowHeight: 28, itemCount: 100, overscan: 0 });
    expect(w.endIndex).toBe(1);
  });

  it('preserves invariant paddingTop + rendered + paddingBottom === totalHeight', () => {
    const w = computeVirtualWindow({ scrollTop: 1234, viewportHeight: 333, rowHeight: 28, itemCount: 777 });
    const rendered = (w.endIndex - w.startIndex) * 28;
    expect(w.paddingTop + rendered + w.paddingBottom).toBe(w.totalHeight);
  });
});

describe('shouldFetchMore', () => {
  it('is false when there is no viewport', () => {
    expect(
      shouldFetchMore({ scrollTop: 0, viewportHeight: 0, rowHeight: 28, itemCount: 100 }),
    ).toBe(false);
  });

  it('is false when scrolled near the top of a long list', () => {
    expect(
      shouldFetchMore({ scrollTop: 0, viewportHeight: 280, rowHeight: 28, itemCount: 1000, thresholdRows: 8 }),
    ).toBe(false);
  });

  it('is true when within the threshold of the bottom', () => {
    // total = 1000*28 = 28000; viewport 280; threshold 8 rows = 224.
    // scrollTop so distanceToBottom = 28000 - (scrollTop+280) <= 224 → scrollTop >= 27496.
    expect(
      shouldFetchMore({ scrollTop: 27500, viewportHeight: 280, rowHeight: 28, itemCount: 1000, thresholdRows: 8 }),
    ).toBe(true);
  });

  it('is true at the very bottom', () => {
    expect(
      shouldFetchMore({ scrollTop: 28000, viewportHeight: 280, rowHeight: 28, itemCount: 1000 }),
    ).toBe(true);
  });

  it('is false for an empty list', () => {
    expect(
      shouldFetchMore({ scrollTop: 0, viewportHeight: 280, rowHeight: 28, itemCount: 0 }),
    ).toBe(false);
  });
});
