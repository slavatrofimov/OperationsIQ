import { describe, it, expect } from 'vitest';
import type { TagInfo } from '../lib/tags';
import type { SignalMetadataView } from '../lib/signalMetadata';
import {
  normalizeIds,
  selectMissing,
  mergeResolved,
  mergeResolvedWithMetadata,
  reoverlayCache,
  resolveTagLabel,
} from './catalogCache';

const tag = (tagId: string, tagName?: string): TagInfo =>
  ({ tagId, tagName: tagName ?? tagId, metric: '', description: '' } as TagInfo);

describe('normalizeIds', () => {
  it('dedupes and preserves first-seen order', () => {
    expect(normalizeIds(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
  });

  it('drops empty ids', () => {
    expect(normalizeIds(['a', '', 'b'])).toEqual(['a', 'b']);
    expect(normalizeIds([])).toEqual([]);
  });
});

describe('selectMissing', () => {
  it('returns only ids the predicate does not already know', () => {
    const known = new Set(['a', 'c']);
    expect(selectMissing(['a', 'b', 'c', 'd'], (id) => known.has(id))).toEqual(['b', 'd']);
  });

  it('normalizes before filtering (dedupe + drop empties)', () => {
    expect(selectMissing(['a', 'a', '', 'b'], () => false)).toEqual(['a', 'b']);
  });

  it('returns an empty array when everything is known', () => {
    expect(selectMissing(['a', 'b'], () => true)).toEqual([]);
  });
});

describe('mergeResolved', () => {
  it('adds new tags keyed by tagId', () => {
    const next = mergeResolved(new Map(), [tag('a'), tag('b')]);
    expect([...next.keys()]).toEqual(['a', 'b']);
  });

  it('overwrites stale entries with the latest tag', () => {
    const prev = new Map([['a', tag('a', 'old')]]);
    const next = mergeResolved(prev, [tag('a', 'new')]);
    expect(next.get('a')?.tagName).toBe('new');
  });

  it('does not mutate the input map', () => {
    const prev = new Map([['a', tag('a')]]);
    mergeResolved(prev, [tag('b')]);
    expect([...prev.keys()]).toEqual(['a']);
  });

  it('skips entries without a tagId', () => {
    const next = mergeResolved(new Map(), [tag('a'), { tagId: '' } as TagInfo]);
    expect([...next.keys()]).toEqual(['a']);
  });
});

describe('mergeResolvedWithMetadata (large-mode governed overlay choke point)', () => {
  const uslTag = (tagId: string, usl?: number): TagInfo =>
    ({ tagId, tagName: tagId, metric: '', description: '', usl } as unknown as TagInfo);
  const meta = (entries: Array<[string, number]>): Map<string, SignalMetadataView> =>
    new Map(entries.map(([id, usl]) => [id, { usl } as unknown as SignalMetadataView]));

  it('overlays governed values onto incoming rows before merging', () => {
    const next = mergeResolvedWithMetadata(new Map(), [uslTag('a', 1)], meta([['a', 42]]));
    expect(next.get('a')?.usl).toBe(42);
  });

  it('is a plain merge when the governed map is empty (small-mode no-op)', () => {
    const next = mergeResolvedWithMetadata(new Map(), [uslTag('a', 7)], new Map());
    expect(next.get('a')?.usl).toBe(7);
    expect([...next.keys()]).toEqual(['a']);
  });

  it('leaves rows without a governed record untouched', () => {
    const next = mergeResolvedWithMetadata(new Map(), [uslTag('a', 7), uslTag('b', 9)], meta([['a', 42]]));
    expect(next.get('a')?.usl).toBe(42);
    expect(next.get('b')?.usl).toBe(9);
  });

  it('preserves existing cache entries while adding overlaid ones', () => {
    const prev = new Map([['x', uslTag('x', 5)]]);
    const next = mergeResolvedWithMetadata(prev, [uslTag('a', 1)], meta([['a', 42]]));
    expect(next.get('x')?.usl).toBe(5);
    expect(next.get('a')?.usl).toBe(42);
  });

  it('does not mutate the input map', () => {
    const prev = new Map([['x', uslTag('x', 5)]]);
    mergeResolvedWithMetadata(prev, [uslTag('a', 1)], meta([['a', 42]]));
    expect([...prev.keys()]).toEqual(['x']);
  });
});

describe('reoverlayCache (backfill when the governed map lands late)', () => {
  const uslTag = (tagId: string, usl?: number): TagInfo =>
    ({ tagId, tagName: tagId, metric: '', description: '', usl } as unknown as TagInfo);
  const meta = (entries: Array<[string, number]>): Map<string, SignalMetadataView> =>
    new Map(entries.map(([id, usl]) => [id, { usl } as unknown as SignalMetadataView]));

  it('re-overlays governed limits onto already-cached tags', () => {
    const prev = new Map([['a', uslTag('a', 1)], ['b', uslTag('b', 2)]]);
    const next = reoverlayCache(prev, meta([['a', 42]]));
    expect(next.get('a')?.usl).toBe(42);
    expect(next.get('b')?.usl).toBe(2);
  });

  it('returns the same map reference when there is no metadata (setState bails out)', () => {
    const prev = new Map([['a', uslTag('a', 1)]]);
    expect(reoverlayCache(prev, new Map())).toBe(prev);
  });

  it('returns the same map reference for an empty cache', () => {
    const prev = new Map<string, TagInfo>();
    expect(reoverlayCache(prev, meta([['a', 42]]))).toBe(prev);
  });
});

describe('resolveTagLabel', () => {
  const cache = new Map([['a', tag('a', 'Alpha')]]);

  it('uses the cached name in name mode', () => {
    expect(resolveTagLabel(cache, 'a', 'name')).toBe('Alpha');
  });

  it('shows Name (Id) in nameId mode', () => {
    expect(resolveTagLabel(cache, 'a', 'nameId')).toBe('Alpha (a)');
  });

  it('shows the id in id mode', () => {
    expect(resolveTagLabel(cache, 'a', 'id')).toBe('a');
  });

  it('falls back to the supplied name when the id is not cached', () => {
    expect(resolveTagLabel(cache, 'z', 'name', 'Zeta')).toBe('Zeta');
  });

  it('falls back to the id when neither cache nor fallback has a name', () => {
    expect(resolveTagLabel(cache, 'z', 'name')).toBe('z');
  });
});
