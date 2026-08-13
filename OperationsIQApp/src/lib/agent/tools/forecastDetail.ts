import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { getForecast } from '../forecastCache';
import { downsampleMinMax } from '../../forecast';

interface ForecastDetailArgs {
  forecastId: string;
  fromIso?: string;
  toIso?: string;
  maxPoints?: number;
}

function round(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value === 0) return 0;
  return Number(value.toPrecision(3));
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

export const forecastDetailTool: AgentTool<ForecastDetailArgs> = {
  name: 'forecast_detail',
  readOnly: true,
  description:
    'Inspect a cached forecast at higher resolution by forecastId. Use this after forecast ' +
    'when the compact preview is not enough for a specific time region.',
  parameters: {
    type: 'object',
    properties: {
      forecastId: { type: 'string', description: 'Forecast result handle returned by forecast.' },
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
    required: ['forecastId'],
  },
  async run(args, _ctx: ToolContext): Promise<ToolResult> {
    const forecastId = String(args.forecastId ?? '').trim();
    const entry = getForecast(forecastId);
    if (!entry) return toolError('not_found', 'Unknown forecastId — run forecast first.');

    const { result } = entry;
    const n = result.x.length;
    if (n === 0) return toolError('empty', `Forecast ${forecastId} has no points.`);

    let start = result.forecastStart;
    let end = n - 1;
    if (args.fromIso) {
      const t = new Date(args.fromIso).getTime();
      if (!Number.isFinite(t)) return toolError('bad_args', 'fromIso must be a valid ISO timestamp.');
      start = nearestIndex(result.x, t);
    }
    if (args.toIso) {
      const t = new Date(args.toIso).getTime();
      if (!Number.isFinite(t)) return toolError('bad_args', 'toIso must be a valid ISO timestamp.');
      end = nearestIndex(result.x, t);
    }
    if (end < start) [start, end] = [end, start];

    const maxPoints = Math.max(1, Math.min(500, Math.trunc(args.maxPoints ?? 200)));
    const allIdx = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    let idx = allIdx;
    let downsampled = false;
    if (allIdx.length > maxPoints) {
      const sliceX = allIdx.map((i) => result.x[i]);
      const sliceValues = allIdx.map((i) => result.forecast[i] ?? result.actual[i]);
      const buckets = Math.max(1, Math.floor(maxPoints / 2));
      idx = downsampleMinMax(sliceX, sliceValues, buckets).map((i) => allIdx[i]);
      downsampled = true;
    }

    return {
      ok: true,
      summary:
        `${idx.length} point(s) from ${args.fromIso ?? 'start'} to ${args.toIso ?? 'end'}` +
        `${downsampled ? ' (min/max downsampled)' : ''}.`,
      data: {
        forecastId,
        window: {
          fromIso: new Date(result.x[start]).toISOString(),
          toIso: new Date(result.x[end]).toISOString(),
        },
        downsampled,
        points: idx.map((i) => ({
          t: result.x[i],
          iso: new Date(result.x[i]).toISOString(),
          history: round(result.actual[i]),
          forecast: round(result.forecast[i]),
          lo: round(result.lower[i]),
          hi: round(result.upper[i]),
        })),
      },
    };
  },
};
