import { describe, it, expect, vi } from 'vitest';

// mvadViz.ts -> kql.ts/mvad.ts transitively touch modules that expect a
// browser/MSAL environment; stub them so the pure helpers import cleanly
// (mirrors mvad.test.ts).
vi.mock('./msal', () => ({
  getEventhouseToken: vi.fn(async () => 'fake'),
  EventhouseSignInRequiredError: class extends Error {},
  notifyEventhouseSignInRequired: vi.fn(),
}));
vi.mock('./env', () => ({ env: { eventhouseQueryUri: 'https://c', eventhouseDb: 'db' } }));
vi.mock('./activeConnection', () => ({
  getActiveKqlOpts: () => undefined,
  getActiveProfileId: () => undefined,
  getActiveTimeseriesRef: () => 'Timeseries',
  getActiveTimeseriesIsWide: () => false,
  getActiveSignalIdDelimiter: () => '-',
  getActiveHierarchyRef: () => 'TagHierarchy',
  getActiveMetadataRef: () => 'TagMetadata',
  getActiveEventsRef: () => 'Events',
}));

import {
  PAGE_ALGORITHMS,
  SAX_DISCORDS_INFO,
  pageAlgorithmInfo,
  isMvadAlgorithm,
  isTimeSeriesMvad,
  minDetectionBins,
  defaultDetectionBins,
  clampDetectionBins,
  detectionWindowKql,
  eventIndexToMs,
  rankContributors,
  contributorShares,
  defaultMvadParams,
} from './mvadViz';
import type { MvadContributor } from './mvad';

describe('PAGE_ALGORITHMS catalog', () => {
  it('lists SAX first then the four MVAD detectors', () => {
    expect(PAGE_ALGORITHMS[0]).toBe(SAX_DISCORDS_INFO);
    expect(PAGE_ALGORITHMS.map((a) => a.id)).toEqual([
      'sax_discords',
      'residual_voting',
      'random_projection',
      'change_point',
      'spectral',
    ]);
  });

  it('marks SAX univariate (min 1 track) and MVAD multivariate (min 2)', () => {
    expect(SAX_DISCORDS_INFO.kind).toBe('sax');
    expect(SAX_DISCORDS_INFO.requiresMinTracks).toBe(1);
    for (const a of PAGE_ALGORITHMS.filter((x) => x.kind === 'mvad')) {
      expect(a.requiresMinTracks).toBe(2);
    }
  });

  it('carries the spectral 32-bin minimum through to the page catalog', () => {
    expect(pageAlgorithmInfo('spectral').requiresMinDetectionBins).toBe(32);
    expect(pageAlgorithmInfo('residual_voting').requiresMinDetectionBins).toBeUndefined();
  });

  it('falls back to SAX for an unknown id', () => {
    // @ts-expect-error exercising the defensive default
    expect(pageAlgorithmInfo('nope')).toBe(SAX_DISCORDS_INFO);
  });
});

describe('algorithm predicates', () => {
  it('isMvadAlgorithm distinguishes SAX from detectors', () => {
    expect(isMvadAlgorithm('sax_discords')).toBe(false);
    expect(isMvadAlgorithm('residual_voting')).toBe(true);
    expect(isMvadAlgorithm('spectral')).toBe(true);
  });

  it('isTimeSeriesMvad is true for per-bin detectors, false for spectral/SAX', () => {
    expect(isTimeSeriesMvad('sax_discords')).toBe(false);
    expect(isTimeSeriesMvad('residual_voting')).toBe(true);
    expect(isTimeSeriesMvad('random_projection')).toBe(true);
    expect(isTimeSeriesMvad('change_point')).toBe(true);
    expect(isTimeSeriesMvad('spectral')).toBe(false);
  });
});

describe('detection-window bins', () => {
  it('minDetectionBins enforces spectral 32, others 1', () => {
    expect(minDetectionBins('spectral')).toBe(32);
    expect(minDetectionBins('residual_voting')).toBe(1);
    expect(minDetectionBins('change_point')).toBe(1);
  });

  it('defaultDetectionBins is 32 for spectral, 4 otherwise', () => {
    expect(defaultDetectionBins('spectral')).toBe(32);
    expect(defaultDetectionBins('residual_voting')).toBe(4);
    expect(defaultDetectionBins('random_projection')).toBe(4);
    expect(defaultDetectionBins('change_point')).toBe(4);
  });

  it('clampDetectionBins floors, enforces minimum, and handles NaN', () => {
    expect(clampDetectionBins(6.9, 'residual_voting')).toBe(6);
    expect(clampDetectionBins(0, 'residual_voting')).toBe(1);
    expect(clampDetectionBins(10, 'spectral')).toBe(32);
    expect(clampDetectionBins(40, 'spectral')).toBe(40);
    expect(clampDetectionBins(Number.NaN, 'spectral')).toBe(32);
  });
});

describe('detectionWindowKql', () => {
  it('produces an integer millisecond timespan literal', () => {
    expect(detectionWindowKql(4, 900_000)).toBe('3600000ms');
    expect(detectionWindowKql(1, 60_000)).toBe('60000ms');
    expect(detectionWindowKql(32, 1_000)).toBe('32000ms');
  });

  it('is always an exact multiple of the bin width', () => {
    const binMillis = 900_000;
    for (const bins of [1, 4, 32, 100]) {
      const literal = detectionWindowKql(bins, binMillis);
      const ms = Number(literal.replace('ms', ''));
      expect(ms % binMillis).toBe(0);
      expect(ms / binMillis).toBe(bins);
    }
  });

  it('returns 0ms for degenerate input', () => {
    expect(detectionWindowKql(0, 1000)).toBe('0ms');
    expect(detectionWindowKql(4, 0)).toBe('0ms');
    expect(detectionWindowKql(Number.NaN, 1000)).toBe('0ms');
  });
});

describe('eventIndexToMs', () => {
  it('maps an event index to wall-clock ms from the range start', () => {
    const startMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    expect(eventIndexToMs(0, startMs, 900_000)).toBe(startMs);
    expect(eventIndexToMs(4, startMs, 900_000)).toBe(startMs + 4 * 900_000);
  });
});

describe('rankContributors', () => {
  const mk = (trackId: string, score: number, voted: boolean): MvadContributor => ({
    trackId,
    score,
    voted,
  });

  it('orders voted tracks first, then by descending score', () => {
    const ranked = rankContributors([
      mk('a', 1.0, false),
      mk('b', 5.0, false),
      mk('c', 2.0, true),
      mk('d', 9.0, true),
    ]);
    expect(ranked.map((c) => c.trackId)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('respects the limit and does not mutate the input', () => {
    const input = [mk('a', 1, true), mk('b', 2, true), mk('c', 3, true)];
    const ranked = rankContributors(input, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((c) => c.trackId)).toEqual(['c', 'b']);
    expect(input.map((c) => c.trackId)).toEqual(['a', 'b', 'c']);
  });

  it('handles non-finite scores by sinking them to the bottom', () => {
    const ranked = rankContributors([mk('a', Number.NaN, false), mk('b', 0.1, false)]);
    expect(ranked.map((c) => c.trackId)).toEqual(['b', 'a']);
  });
});

describe('contributorShares', () => {
  const mk = (trackId: string, score: number, voted: boolean): MvadContributor => ({
    trackId,
    score,
    voted,
  });

  it('shows only voting tracks, ranked by score, with shares summing to ~1', () => {
    const shares = contributorShares([
      mk('a', 3, true),
      mk('b', 1, true),
      mk('c', 9, false), // high score but did not vote -> excluded
    ]);
    expect(shares.map((s) => s.trackId)).toEqual(['a', 'b']);
    expect(shares.map((s) => Number(s.share.toFixed(2)))).toEqual([0.75, 0.25]);
    expect(shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
  });

  it('falls back to the single top-scoring track when none voted', () => {
    const shares = contributorShares([mk('a', 2, false), mk('b', 5, false)]);
    expect(shares).toHaveLength(1);
    expect(shares[0].trackId).toBe('b');
    expect(shares[0].share).toBe(1);
  });

  it('respects the limit and does not mutate the input', () => {
    const input = [mk('a', 1, true), mk('b', 2, true), mk('c', 3, true)];
    const shares = contributorShares(input, 2);
    expect(shares.map((s) => s.trackId)).toEqual(['c', 'b']);
    expect(input.map((c) => c.trackId)).toEqual(['a', 'b', 'c']);
  });

  it('splits evenly and treats non-finite/negative scores as zero magnitude', () => {
    const shares = contributorShares([mk('a', 0, true), mk('b', -1, true)]);
    expect(shares.map((s) => Number(s.share.toFixed(2)))).toEqual([0.5, 0.5]);
  });
});

describe('defaultMvadParams', () => {
  it('returns a fresh copy of the algorithm defaults', () => {
    const p1 = defaultMvadParams('residual_voting');
    const p2 = defaultMvadParams('residual_voting');
    expect(p1).toEqual(p2);
    expect(p1).not.toBe(p2);
    expect(p1.trend).toBe('linefit');
    expect(p1.outlierKind).toBe('ctukey');
  });

  it('spectral defaults expose spectral-specific knobs', () => {
    const p = defaultMvadParams('spectral');
    expect(p.useHannWindow).toBe(true);
    expect(p.baselineWindowCount).toBe(8);
  });
});
