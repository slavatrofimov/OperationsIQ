import { describe, it, expect } from 'vitest';
import {
  buildFindMoreSeed,
  seedTagIds,
  type FindMoreSeedTarget,
  type SimilarityQuerySeed,
} from './appTypes';

describe('seedTagIds', () => {
  it('returns the multi-tag set when present', () => {
    const seed: SimilarityQuerySeed = {
      tagId: 'a',
      tagIds: ['a', 'b', 'c'],
      start: new Date(0),
      end: new Date(1000),
    };
    expect(seedTagIds(seed)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to the single tagId when tagIds is absent or empty', () => {
    const base = { tagId: 'x', start: new Date(0), end: new Date(1000) };
    expect(seedTagIds(base)).toEqual(['x']);
    expect(seedTagIds({ ...base, tagIds: [] })).toEqual(['x']);
  });
});

describe('buildFindMoreSeed', () => {
  const windowStart = '2024-01-01T00:00:00.000Z';
  const windowStartMs = Date.parse(windowStart);

  it('builds a locked single-tag seed from one occurrence', () => {
    const targets: FindMoreSeedTarget[] = [
      { signalId: 'sig-1', startIndex: 10, length: 4, secondsPerSample: 2 },
    ];
    const seed = buildFindMoreSeed(windowStart, targets);
    expect(seed).not.toBeNull();
    expect(seed!.tagId).toBe('sig-1');
    expect(seed!.tagIds).toEqual(['sig-1']);
    expect(seed!.locked).toBe(true);
    // 2 s/sample → 2000 ms bin.
    expect(seed!.lockedBinMillis).toBe(2000);
    // start = windowStart + 10 * 2000 ms; end = start + 4 * 2000 ms.
    expect(seed!.start.getTime()).toBe(windowStartMs + 10 * 2000);
    expect(seed!.end.getTime()).toBe(windowStartMs + 10 * 2000 + 4 * 2000);
  });

  it('collects every participating track tag for a multidimensional pattern', () => {
    const targets: FindMoreSeedTarget[] = [
      { signalId: 'sig-a', startIndex: 5, length: 3, secondsPerSample: 1 },
      { signalId: 'sig-b', startIndex: 5, length: 3, secondsPerSample: 1 },
      { signalId: 'sig-c', startIndex: 5, length: 3, secondsPerSample: 1 },
    ];
    const seed = buildFindMoreSeed(windowStart, targets);
    expect(seed!.tagIds).toEqual(['sig-a', 'sig-b', 'sig-c']);
    expect(seed!.tagId).toBe('sig-a');
    expect(seed!.lockedBinMillis).toBe(1000);
  });

  it('dedupes repeated tags while preserving order', () => {
    const targets: FindMoreSeedTarget[] = [
      { signalId: 'sig-a', startIndex: 8, length: 2, secondsPerSample: 1 },
      { signalId: 'sig-a', startIndex: 20, length: 2, secondsPerSample: 1 },
      { signalId: 'sig-b', startIndex: 8, length: 2, secondsPerSample: 1 },
    ];
    const seed = buildFindMoreSeed(windowStart, targets);
    expect(seed!.tagIds).toEqual(['sig-a', 'sig-b']);
  });

  it('anchors the window to the earliest occurrence', () => {
    const targets: FindMoreSeedTarget[] = [
      { signalId: 'sig-a', startIndex: 30, length: 2, secondsPerSample: 1 },
      { signalId: 'sig-a', startIndex: 12, length: 2, secondsPerSample: 1 },
    ];
    const seed = buildFindMoreSeed(windowStart, targets);
    expect(seed!.start.getTime()).toBe(windowStartMs + 12 * 1000);
  });

  it('uses the fallback seconds-per-sample when a target omits it', () => {
    const targets: FindMoreSeedTarget[] = [{ signalId: 'sig-a', startIndex: 0, length: 4 }];
    const seed = buildFindMoreSeed(windowStart, targets, 5);
    expect(seed!.lockedBinMillis).toBe(5000);
  });

  it('returns null with no targets or no usable granularity', () => {
    expect(buildFindMoreSeed(windowStart, [])).toBeNull();
    expect(
      buildFindMoreSeed(windowStart, [{ signalId: 'sig-a', startIndex: 0, length: 4 }]),
    ).toBeNull();
    expect(
      buildFindMoreSeed('not-a-date', [
        { signalId: 'sig-a', startIndex: 0, length: 4, secondsPerSample: 1 },
      ]),
    ).toBeNull();
  });

  it('never emits a zero-length window', () => {
    const targets: FindMoreSeedTarget[] = [
      { signalId: 'sig-a', startIndex: 3, length: 0, secondsPerSample: 1 },
    ];
    const seed = buildFindMoreSeed(windowStart, targets);
    expect(seed!.end.getTime()).toBeGreaterThan(seed!.start.getTime());
  });
});
