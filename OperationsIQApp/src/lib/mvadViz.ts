/**
 * Pure (no-React) view-model helpers for the multi-algorithm Anomalies page
 * (PR-1b). Kept separate from `DiscoverPage.tsx` so the fiddly, easy-to-get-wrong
 * bits — detection-window alignment, event-index→time mapping, contributor
 * ranking — are unit-testable in isolation.
 *
 * Imports only pure data/types from PR-1a (`kql.ts`, `mvad.ts`); it must NOT be
 * given any browser/MSAL dependency so the tests stay lightweight.
 */

import { MVAD_DEFAULT_PARAMS, type MvadAlgorithm } from './kql';
import { MVAD_ALGORITHMS, type MvadAlgorithmInfo, type MvadContributor } from './mvad';

/** The SAX discords sentinel plus the four MVAD detector ids. */
export type PageAlgorithm = 'sax_discords' | MvadAlgorithm;

/** Selector metadata for one page algorithm (SAX or an MVAD detector). */
export interface PageAlgorithmInfo {
  id: PageAlgorithm;
  /** 'sax' = the existing univariate discords path; 'mvad' = multivariate. */
  kind: 'sax' | 'mvad';
  label: string;
  blurb: string;
  bestFor: string;
  notIdeal: string;
  /** Minimum signals the algorithm needs (SAX: 1; MVAD: 2). */
  requiresMinTracks: number;
  /** Minimum bins in the detection window, when the detector imposes one. */
  requiresMinDetectionBins?: number;
}

/** The SAX discords entry — concise text mirroring the MVAD catalog style. */
export const SAX_DISCORDS_INFO: PageAlgorithmInfo = {
  id: 'sax_discords',
  kind: 'sax',
  label: 'SAX discords',
  blurb:
    'Finds the most unusual repeated shape (a “discord”) within each signal, scoring each independently.',
  bestFor: 'the single most unusual repeated shape within individual signals',
  notIdeal:
    'anomalies that appear only in the JOINT behavior of multiple signals — use an MVAD algorithm',
  requiresMinTracks: 1,
};

/**
 * Combined selector catalog: the SAX discords entry followed by the four MVAD
 * detectors from {@link MVAD_ALGORITHMS}, adapted to {@link PageAlgorithmInfo}.
 */
export const PAGE_ALGORITHMS: PageAlgorithmInfo[] = [
  SAX_DISCORDS_INFO,
  ...MVAD_ALGORITHMS.map(
    (a: MvadAlgorithmInfo): PageAlgorithmInfo => ({
      id: a.id,
      kind: 'mvad',
      label: a.label,
      blurb: a.blurb,
      bestFor: a.bestFor,
      notIdeal: a.notIdeal,
      requiresMinTracks: a.requiresMinTracks,
      requiresMinDetectionBins: a.requiresMinDetectionBins,
    }),
  ),
];

const PAGE_ALGORITHM_BY_ID = new Map(PAGE_ALGORITHMS.map((a) => [a.id, a]));

/** Look up selector metadata for a page algorithm id. */
export function pageAlgorithmInfo(id: PageAlgorithm): PageAlgorithmInfo {
  return PAGE_ALGORITHM_BY_ID.get(id) ?? SAX_DISCORDS_INFO;
}

/** True when the id is one of the multivariate MVAD detectors (not SAX). */
export function isMvadAlgorithm(id: PageAlgorithm): id is MvadAlgorithm {
  return id !== 'sax_discords';
}

/**
 * MVAD time-series detectors emit one row per bin in the detection window;
 * `spectral` instead scores only the single most-recent window. Callers render
 * these two shapes differently.
 */
export function isTimeSeriesMvad(id: PageAlgorithm): boolean {
  return isMvadAlgorithm(id) && id !== 'spectral';
}

/**
 * Minimum allowed detection-window bins for an algorithm. Spectral needs >= 32
 * (its FFT baseline); the other detectors just need >= 1.
 */
export function minDetectionBins(id: MvadAlgorithm): number {
  return pageAlgorithmInfo(id).requiresMinDetectionBins ?? 1;
}

/**
 * Sensible default detection-window bins: spectral defaults to its 32-bin floor,
 * the other detectors to 4 most-recent bins.
 */
export function defaultDetectionBins(id: MvadAlgorithm): number {
  return id === 'spectral' ? 32 : 4;
}

/**
 * Clamp a user-entered detection-window bin count to a positive integer that
 * respects the algorithm's minimum. Non-finite input falls back to the minimum.
 */
export function clampDetectionBins(bins: number, id: MvadAlgorithm): number {
  const min = minDetectionBins(id);
  if (!Number.isFinite(bins)) return min;
  return Math.max(min, Math.floor(bins));
}

/**
 * Build the detection-window KQL literal as an integer millisecond timespan
 * (e.g. `3600000ms`). Expressing it as bins × bin-width GUARANTEES the window is
 * an exact multiple of the bin, so the detector never returns a
 * `misaligned_series` diagnostic. Non-finite/zero inputs yield `0ms`.
 */
export function detectionWindowKql(bins: number, binMillis: number): string {
  if (!Number.isFinite(bins) || !Number.isFinite(binMillis) || bins <= 0 || binMillis <= 0) {
    return '0ms';
  }
  return `${Math.round(bins * binMillis)}ms`;
}

/**
 * Map an MVAD `event_index` (position in the prepared series that spans
 * `startMs`..end at `binMillis` steps) to a wall-clock epoch millisecond.
 */
export function eventIndexToMs(eventIndex: number, startMs: number, binMillis: number): number {
  return startMs + eventIndex * binMillis;
}

/**
 * Rank an event's contributing tracks for display: tracks that met the vote
 * threshold first, then by descending score. Returns at most `limit` entries.
 */
export function rankContributors(contributors: MvadContributor[], limit = 5): MvadContributor[] {
  return [...contributors]
    .sort((a, b) => {
      if (a.voted !== b.voted) return a.voted ? -1 : 1;
      const sa = Number.isFinite(a.score) ? a.score : Number.NEGATIVE_INFINITY;
      const sb = Number.isFinite(b.score) ? b.score : Number.NEGATIVE_INFINITY;
      return sb - sa;
    })
    .slice(0, Math.max(0, limit));
}

/** A contributing track with its share of the shown contributors' total magnitude. */
export interface ContributorShare {
  trackId: string;
  score: number;
  voted: boolean;
  /** This track's score as a fraction (0..1) of the shown contributors' summed magnitude. */
  share: number;
}

/**
 * Select the tracks that meaningfully drive an event and quantify each one's
 * relative contribution. Only tracks that met the vote threshold are shown
 * (voters are what the detector actually flagged); when no track voted — which
 * happens when an event fires on aggregate score alone — the single
 * highest-scoring track is shown as a fallback so the list is never empty.
 *
 * Tracks are ranked by descending score and truncated to `limit`. `share` is
 * each track's score relative to the summed (non-negative) score of the shown
 * tracks, so shares sum to ~1 and can back a percentage or a bar. Non-finite or
 * negative scores contribute 0 to the total; if every shown score is <= 0 the
 * shares fall back to an equal split.
 */
export function contributorShares(contributors: MvadContributor[], limit = 5): ContributorShare[] {
  const scoreOf = (c: MvadContributor) => (Number.isFinite(c.score) ? c.score : 0);
  const voters = contributors.filter((c) => c.voted);
  let pool = voters;
  if (pool.length === 0) {
    const top = [...contributors].sort((a, b) => scoreOf(b) - scoreOf(a))[0];
    pool = top ? [top] : [];
  }
  const shown = [...pool]
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, Math.max(0, limit));
  const total = shown.reduce((sum, c) => sum + Math.max(0, scoreOf(c)), 0);
  return shown.map((c) => ({
    trackId: c.trackId,
    score: c.score,
    voted: c.voted,
    share: total > 0 ? Math.max(0, scoreOf(c)) / total : shown.length > 0 ? 1 / shown.length : 0,
  }));
}

/**
 * The default parameter bag to seed the Advanced-parameters UI for an MVAD
 * algorithm (a shallow copy so callers can mutate freely).
 */
export function defaultMvadParams(id: MvadAlgorithm) {
  return { ...MVAD_DEFAULT_PARAMS[id] };
}
