/**
 * `series_detail` — the shared drill-down over any cached multi-track series.
 *
 * Analysis tools that produce a full-resolution series (explore_signals,
 * decompose_signal, monitor_deviation, …) stash it in the series cache and
 * return a `seriesId`. This one tool lets the agent pull full-resolution points
 * for any track(s) over any time window of that series — so we don't need a
 * bespoke `*_detail` tool per analysis. Still capped by `maxPoints` (min/max
 * downsampled) to keep the payload lean.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { getSeries } from '../seriesCache';
import { downsampleMinMax } from '../../forecast';
import { round } from '../toolUtils';

export interface SeriesDetailArgs {
  /** Handle returned by an analysis tool (e.g. explore_signals). */
  seriesId: string;
  /** Optional track names to return; defaults to all tracks in the series. */
  tracks?: string[];
  fromIso?: string;
  toIso?: string;
  maxPoints?: number;
}

function nearestIndex(x: number[], target: number): number {
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < x.length; i++) {
    const delta = Math.abs(x[i] - target);
    if (delta < bestDelta) {
      best = i;
      bestDelta = delta;
    }
  }
  return best;
}

export const seriesDetailTool: AgentTool<SeriesDetailArgs> = {
  name: 'series_detail',
  readOnly: true,
  description:
    'Inspect a cached series at higher resolution by seriesId. Use this after any tool that ' +
    'returns a seriesId (explore_signals, decompose_signal, monitor_deviation, compute_derived_metric, ' +
    'run_scenario, …) when the compact preview is not enough for a specific time region or track. ' +
    'Optionally restrict to specific track names and a time window; points are min/max downsampled to maxPoints.',
  parameters: {
    type: 'object',
    properties: {
      seriesId: { type: 'string', description: 'Series handle returned by an analysis tool.' },
      tracks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Track names to return (default: all). See the trackNames on the source result.',
      },
      fromIso: { type: 'string', description: 'Optional window start ISO timestamp.' },
      toIso: { type: 'string', description: 'Optional window end ISO timestamp.' },
      maxPoints: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        default: 200,
        description: 'Maximum returned points; min/max downsampled if needed.',
      },
    },
    required: ['seriesId'],
  },
  async run(args, _ctx: ToolContext): Promise<ToolResult> {
    const seriesId = String(args.seriesId ?? '').trim();
    const entry = getSeries(seriesId);
    if (!entry) return toolError('not_found', 'Unknown seriesId — it may have expired; re-run the source tool.');

    const { x, tracks, meta } = entry;
    const n = x.length;
    if (n === 0) return toolError('empty', `Series ${seriesId} has no points.`);

    const available = Object.keys(tracks);
    const requested = args.tracks && args.tracks.length > 0 ? args.tracks.filter((t) => t in tracks) : available;
    if (requested.length === 0) {
      return toolError('bad_args', `None of the requested tracks exist. Available: ${available.join(', ')}.`);
    }

    let start = 0;
    let end = n - 1;
    if (args.fromIso) {
      const t = new Date(args.fromIso).getTime();
      if (!Number.isFinite(t)) return toolError('bad_args', 'fromIso must be a valid ISO timestamp.');
      start = nearestIndex(x, t);
    }
    if (args.toIso) {
      const t = new Date(args.toIso).getTime();
      if (!Number.isFinite(t)) return toolError('bad_args', 'toIso must be a valid ISO timestamp.');
      end = nearestIndex(x, t);
    }
    if (end < start) [start, end] = [end, start];

    const maxPoints = Math.max(1, Math.min(500, Math.trunc(args.maxPoints ?? 200)));
    const allIdx = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    let idx = allIdx;
    let downsampled = false;
    if (allIdx.length > maxPoints) {
      // Downsample along the first requested track so extrema of the primary line survive.
      const primary = tracks[requested[0]];
      const sliceX = allIdx.map((i) => x[i]);
      const sliceV = allIdx.map((i) => primary[i]);
      const buckets = Math.max(1, Math.floor(maxPoints / 2));
      idx = downsampleMinMax(sliceX, sliceV, buckets).map((i) => allIdx[i]);
      downsampled = true;
    }

    return {
      ok: true,
      summary:
        `${idx.length} point(s) of ${meta.kind} series ${seriesId} ` +
        `[${requested.join(', ')}] from ${args.fromIso ?? 'start'} to ${args.toIso ?? 'end'}` +
        `${downsampled ? ' (min/max downsampled)' : ''}.`,
      data: {
        seriesId,
        tracks: requested,
        window: { fromIso: new Date(x[start]).toISOString(), toIso: new Date(x[end]).toISOString() },
        downsampled,
        points: idx.map((i) => {
          const p: Record<string, number | null | string> = { t: x[i], iso: new Date(x[i]).toISOString() };
          for (const name of requested) p[name] = round(tracks[name][i]);
          return p;
        }),
      },
    };
  },
};
