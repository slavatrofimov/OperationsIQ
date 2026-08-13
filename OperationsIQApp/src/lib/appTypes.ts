import type { TimeRange } from '../components/TimeRangePicker';

/**
 * A subsequence handed to the Similarity page as a prefilled query pattern. It
 * originates either from a brushed selection on the Exploration page (a single
 * tag + window) or from a *discovered deep-pattern* on the Patterns page
 * ("Find more like these" — Scenario 2), which additionally carries every
 * participating track's tag and a granularity lock.
 */
export interface SimilarityQuerySeed {
  /**
   * Primary query tag. Always populated for back-compat; when {@link tagIds} is
   * present it equals `tagIds[0]`.
   */
  tagId: string;
  /**
   * All query tags for a multidimensional pattern (one per participating track).
   * When absent, treat `[tagId]` as the query-tag set.
   */
  tagIds?: string[];
  start: Date;
  end: Date;
  /**
   * When set, pins the Similarity page's binning to this resolution (in
   * milliseconds) so the search runs at the exact granularity the pattern was
   * discovered at, and locks the granularity control.
   */
  lockedBinMillis?: number;
  /** Marks a granularity-locked seed (Scenario 2 "Find more like these"). */
  locked?: true;
}

/** The query-tag set a seed represents (all tracks, or `[tagId]` for single). */
export function seedTagIds(seed: SimilarityQuerySeed): string[] {
  return seed.tagIds && seed.tagIds.length > 0 ? seed.tagIds : [seed.tagId];
}

/** One participating track of a discovered deep-pattern (from ResultsView). */
export interface FindMoreSeedTarget {
  signalId: string;
  /** First sample index of the occurrence on the analysis grid. */
  startIndex: number;
  /** Occurrence length in samples. */
  length: number;
  /** Seconds represented by one sample/index for this track's analysis grid. */
  secondsPerSample?: number;
}

/**
 * Build a granularity-locked {@link SimilarityQuerySeed} from a discovered
 * deep-pattern's per-track occurrences ("Find more like these").
 *
 * - `tagIds` collects every participating track's tag (order-preserving, deduped)
 *   so a multidimensional pattern seeds all its query tags; a single-tag pattern
 *   yields one.
 * - The query window is the pattern's *earliest* occurrence, mapped to wall-clock
 *   time from the job window start (`windowStart` is a REAL-UTC instant and the
 *   analysis grid is anchored there, so no timezone shift is applied).
 * - `lockedBinMillis` is the pattern's temporal granularity: samples-per-bin ×
 *   secondsPerSample — i.e. `secondsPerSample × 1000` for a one-sample bin.
 *
 * Returns `null` when there are no usable targets or the granularity cannot be
 * determined.
 */
export function buildFindMoreSeed(
  windowStart: string | number | Date,
  targets: FindMoreSeedTarget[],
  fallbackSecondsPerSample?: number,
): SimilarityQuerySeed | null {
  if (!targets || targets.length === 0) return null;

  const windowStartMs =
    windowStart instanceof Date
      ? windowStart.getTime()
      : typeof windowStart === 'number'
        ? windowStart
        : Date.parse(windowStart);
  if (!Number.isFinite(windowStartMs)) return null;

  const tagIds: string[] = [];
  for (const t of targets) {
    if (t.signalId && !tagIds.includes(t.signalId)) tagIds.push(t.signalId);
  }
  if (tagIds.length === 0) return null;

  // Representative occurrence = the earliest one (smallest start index); for a
  // multidimensional pattern every track shares the same joint-event window.
  const rep = targets.reduce((a, b) => (b.startIndex < a.startIndex ? b : a));
  const sps =
    rep.secondsPerSample && rep.secondsPerSample > 0
      ? rep.secondsPerSample
      : fallbackSecondsPerSample && fallbackSecondsPerSample > 0
        ? fallbackSecondsPerSample
        : undefined;
  if (!sps) return null;

  const startMs = windowStartMs + rep.startIndex * sps * 1000;
  const endMs = startMs + Math.max(1, rep.length) * sps * 1000;
  const lockedBinMillis = Math.max(1, Math.round(sps * 1000));

  return {
    tagId: tagIds[0],
    tagIds,
    start: new Date(startMs),
    end: new Date(endMs),
    lockedBinMillis,
    locked: true,
  };
}

/** Length of the default view window: the last 24 hours. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The default view window: the last 24 hours relative to *now* (when this is
 * called). Computed on demand — never a frozen module constant — so the app
 * opens on a data window that is valid in any environment, not the Contoso
 * sample's fixed 2024 dates. Call it from a lazy `useState(() => defaultRange())`
 * initializer so each fresh selection reflects the load time.
 */
export function defaultRange(): TimeRange {
  const end = new Date();
  const start = new Date(end.getTime() - DEFAULT_WINDOW_MS);
  return { start, end };
}
