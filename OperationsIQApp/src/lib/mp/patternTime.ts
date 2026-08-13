/**
 * Index ↔ time conversion for Matrix Profile artifacts.
 *
 * `Label.startIndex/length`, motif `idxA/idxB`, and discord `idx` are all *sample
 * indices* into an analysis job's window. To place them on a real time axis (so a
 * pattern-search result can be overlaid on the signal, like the Explore page) we
 * map an index to a timestamp assuming uniform sampling across the job window —
 * the same assumption `ResultsView.estimateSecondsPerSample` already relies on.
 */

import { queryRows } from '../eventhouse';
import { kqlDatetime, kqlString, withTimeseriesRef } from '../kql';
import type { AnalysisJob, Label } from './types';

/** A pattern occurrence resolved to wall-clock time. */
export interface TimeSpan {
  start: Date;
  end: Date;
}

interface CountRow {
  Count: number;
}

/**
 * Seconds between consecutive samples for a job, given the number of samples that
 * fall in its window. Returns `undefined` when the window or count is unusable.
 */
export function secondsPerSample(job: AnalysisJob, nSamples: number): number | undefined {
  if (nSamples <= 1) return undefined;
  const start = new Date(job.windowStart).getTime();
  const end = new Date(job.windowEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return (end - start) / 1000 / nSamples;
}

/** Convert a sample index to a timestamp within the job window. */
export function indexToTime(job: AnalysisJob, idx: number, nSamples: number): Date {
  const start = new Date(job.windowStart).getTime();
  const sps = secondsPerSample(job, nSamples);
  if (sps === undefined) return new Date(start);
  return new Date(start + idx * sps * 1000);
}

/**
 * Convert an index-based span (startIndex + length in samples) to a wall-clock
 * `TimeSpan`, clamped to the job window end.
 */
export function spanToTime(
  job: AnalysisJob,
  startIndex: number,
  length: number,
  nSamples: number,
): TimeSpan {
  const windowEnd = new Date(job.windowEnd).getTime();
  const start = indexToTime(job, startIndex, nSamples);
  const rawEnd = indexToTime(job, startIndex + Math.max(1, length), nSamples).getTime();
  return { start, end: new Date(Math.min(rawEnd, windowEnd)) };
}

/** Convert a persisted `Label` to a `TimeSpan`. */
export function labelToTimeSpan(job: AnalysisJob, label: Label, nSamples: number): TimeSpan {
  return spanToTime(job, label.startIndex, label.length, nSamples);
}

/**
 * Resolve the number of samples in a job's window.
 *
 * Prefers a caller-supplied hint (e.g. the Matrix Profile length: `mpLength +
 * subLen - 1`, or a raw-signal array length) to avoid a round-trip; otherwise
 * counts rows in the KQL `Timeseries` table for the signal + window. Returns
 * `undefined` when neither a hint nor a positive count is available, so callers
 * can fall back to a sample-rate estimate.
 */
export async function sampleCountForJob(
  job: AnalysisJob,
  hint?: { mpLength?: number; rawSignalLength?: number },
): Promise<number | undefined> {
  if (hint?.rawSignalLength && hint.rawSignalLength > 1) return hint.rawSignalLength;
  if (hint?.mpLength && hint.mpLength > 1) {
    return hint.mpLength + (job.subLen ?? 1) - 1;
  }

  try {
    const rows = await queryRows<CountRow>(
      withTimeseriesRef(
        `Timeseries | where SignalId == ${kqlString(job.signalId)} | where Timestamp between (${kqlDatetime(
          new Date(job.windowStart),
        )} .. ${kqlDatetime(new Date(job.windowEnd))}) | count`,
      ),
    );
    const n = rows[0]?.Count;
    return typeof n === 'number' && n > 1 ? n : undefined;
  } catch {
    return undefined;
  }
}
