import { describe, it, expect } from 'vitest';
import type { TagInfo } from './tags';
import {
  catalogSearchReducer,
  dedupeAppend,
  initialSearchState,
  type CatalogSearchState,
} from './catalogSearchState';

const tag = (tagId: string): TagInfo =>
  ({ tagId, tagName: tagId, metric: '', description: '' } as TagInfo);

describe('dedupeAppend', () => {
  it('appends new rows after the existing ones', () => {
    expect(dedupeAppend([tag('a')], [tag('b'), tag('c')]).map((t) => t.tagId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('skips rows whose id is already present', () => {
    expect(dedupeAppend([tag('a'), tag('b')], [tag('b'), tag('c')]).map((t) => t.tagId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('does not mutate the input array', () => {
    const prev = [tag('a')];
    dedupeAppend(prev, [tag('b')]);
    expect(prev.map((t) => t.tagId)).toEqual(['a']);
  });
});

describe('catalogSearchReducer', () => {
  const start = (generation: number, append = false): CatalogSearchState =>
    catalogSearchReducer(initialSearchState, { type: 'start', generation, append });

  it('start on a fresh query clears rows and sets loading', () => {
    const seeded: CatalogSearchState = { ...initialSearchState, rows: [tag('x')], hasMore: true };
    const next = catalogSearchReducer(seeded, { type: 'start', generation: 1, append: false });
    expect(next).toMatchObject({ generation: 1, rows: [], hasMore: false, loading: true });
  });

  it('start with append keeps existing rows', () => {
    const seeded: CatalogSearchState = {
      generation: 1,
      rows: [tag('a')],
      hasMore: true,
      loading: false,
    };
    const next = catalogSearchReducer(seeded, { type: 'start', generation: 2, append: true });
    expect(next.rows.map((t) => t.tagId)).toEqual(['a']);
    expect(next.loading).toBe(true);
  });

  it('success replaces rows and records hasMore', () => {
    const s = start(1);
    const next = catalogSearchReducer(s, {
      type: 'success',
      generation: 1,
      rows: [tag('a'), tag('b')],
      hasMore: true,
      append: false,
    });
    expect(next.rows.map((t) => t.tagId)).toEqual(['a', 'b']);
    expect(next).toMatchObject({ hasMore: true, loading: false });
  });

  it('success with append dedupe-appends the next page', () => {
    let s = start(1);
    s = catalogSearchReducer(s, {
      type: 'success',
      generation: 1,
      rows: [tag('a'), tag('b')],
      hasMore: true,
      append: false,
    });
    s = catalogSearchReducer(s, { type: 'start', generation: 2, append: true });
    s = catalogSearchReducer(s, {
      type: 'success',
      generation: 2,
      rows: [tag('b'), tag('c')],
      hasMore: false,
      append: true,
    });
    expect(s.rows.map((t) => t.tagId)).toEqual(['a', 'b', 'c']);
    expect(s.hasMore).toBe(false);
  });

  it('ignores a success from a superseded generation', () => {
    const s = start(2);
    const next = catalogSearchReducer(s, {
      type: 'success',
      generation: 1,
      rows: [tag('stale')],
      hasMore: true,
      append: false,
    });
    expect(next).toBe(s);
  });

  it('records an error only for the current generation', () => {
    const s = start(2);
    expect(catalogSearchReducer(s, { type: 'failure', generation: 1, error: 'old' })).toBe(s);
    const failed = catalogSearchReducer(s, { type: 'failure', generation: 2, error: 'boom' });
    expect(failed).toMatchObject({ loading: false, error: 'boom' });
  });

  it('reset returns to the initial state', () => {
    const s = start(5);
    expect(catalogSearchReducer(s, { type: 'reset' })).toEqual(initialSearchState);
  });
});
