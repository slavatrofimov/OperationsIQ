/**
 * useRawDataDensity: a lightweight, debounced safeguard against choosing a
 * temporal resolution finer than the underlying data actually supports.
 *
 * It runs a cheap per-tag `count` over the raw (un-binned) records for the
 * selected tags/range, reduces it to the highest count of any single tag,
 * estimates that densest tag's native sampling interval, and flags when the
 * projected number of points at the chosen resolution materially exceeds the
 * records that densest tag can supply. We compare against the densest single
 * tag — not the total across tags — because selecting more tags inflates the
 * total record count without implying the data is sampled any more frequently.
 * This is advisory only — sparse data with bursts of high-frequency activity is
 * legitimate — so callers surface it as a soft warning with a recommended
 * resolution, never a hard block.
 */

import { useEffect, useRef, useState } from 'react';
import { getActiveTimeseriesRef } from '../lib/activeConnection';
import { STANDARD_TIMESPANS } from '../lib/binning';
import { executeKql } from '../lib/eventhouse';
import { buildMaxTagCountQuery } from '../lib/kql';

export interface RawDataDensity {
  /** True while the count query is in flight. */
  loading: boolean;
  /** Highest raw record count of any single selected tag, or null if unknown. */
  maxTagCount: number | null;
  /** Estimated average milliseconds between raw records of the densest tag (duration / maxTagCount). */
  nativeMillis: number | null;
  /** Projected points at the chosen resolution across the range. */
  projectedPoints: number;
  /** True when the chosen resolution over-samples relative to the densest tag's raw data. */
  overResolved: boolean;
  /** A suggested resolution (ms/bin) snapped to a standard step, when over-resolved. */
  recommendedMillis: number | null;
}

/** Smallest standard step whose width is >= the given milliseconds. */
function snapUpToStandard(millis: number): number {
  const std = STANDARD_TIMESPANS.find((t) => t.millis >= millis);
  return std ? std.millis : STANDARD_TIMESPANS[STANDARD_TIMESPANS.length - 1].millis;
}

/** Above this ratio of projected points to raw records we consider it over-resolved. */
const OVER_RESOLVE_FACTOR = 1.5;

export interface UseRawDataDensityParams {
  tagIds: string[];
  start: Date;
  end: Date;
  /** The effective bin width (ms/bin) the query will use. */
  effectiveMillis: number;
  /** Skip the check entirely (e.g. while a heavier query is running). */
  enabled?: boolean;
  debounceMs?: number;
}

export function useRawDataDensity({
  tagIds,
  start,
  end,
  effectiveMillis,
  enabled = true,
  debounceMs = 600,
}: UseRawDataDensityParams): RawDataDensity {
  const [maxTagCount, setMaxTagCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const callId = useRef(0);

  const startMs = start.getTime();
  const endMs = end.getTime();
  const key = `${tagIds.join(',')}|${startMs}|${endMs}`;

  useEffect(() => {
    const timeseriesRef = getActiveTimeseriesRef();
    if (!enabled || !timeseriesRef || tagIds.length === 0 || !(endMs > startMs)) {
      setMaxTagCount(null);
      setLoading(false);
      return;
    }
    const id = ++callId.current;
    clearTimeout(timer.current);
    setLoading(true);
    timer.current = setTimeout(() => {
      executeKql(
        buildMaxTagCountQuery({
          tagIds,
          start: new Date(startMs),
          end: new Date(endMs),
          // The count filters on the canonical `SignalId` column, so it must run
          // against the active profile's canonical-bound `Timeseries`.
          timeseriesRef,
        }),
      )
        .then((table) => {
          if (callId.current !== id) return;
          const n = Number(table.rows?.[0]?.[0] ?? 0);
          setMaxTagCount(Number.isFinite(n) ? n : 0);
          setLoading(false);
        })
        .catch(() => {
          if (callId.current !== id) return;
          setMaxTagCount(null);
          setLoading(false);
        });
    }, debounceMs);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, debounceMs]);

  const durationMs = Math.max(0, endMs - startMs);
  const nativeMillis = maxTagCount != null && maxTagCount > 0 ? durationMs / maxTagCount : null;
  const projectedPoints = effectiveMillis > 0 ? Math.ceil(durationMs / effectiveMillis) : 0;
  const overResolved =
    maxTagCount != null && maxTagCount > 0 && projectedPoints > maxTagCount * OVER_RESOLVE_FACTOR;
  const recommendedMillis =
    overResolved && nativeMillis != null ? snapUpToStandard(nativeMillis) : null;

  return { loading, maxTagCount, nativeMillis, projectedPoints, overResolved, recommendedMillis };
}
