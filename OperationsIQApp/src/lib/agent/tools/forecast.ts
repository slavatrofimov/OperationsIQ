/**
 * `forecast` tool — the reference analysis adapter.
 *
 * Composes the app's existing forecast seam end to end:
 *   chooseBin -> buildForecastQuery -> executeKql -> parseForecastResult
 *   (-> exceedanceProbability when a threshold is supplied)
 *
 * The query runs under the user's delegated Kusto token via executeKql, so RLS
 * and the active Connection Profile are honored. The result is summarized and
 * DOWNSAMPLED (a min/max horizon preview) so the agent payload stays small.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { chooseBin } from '../../binning';
import { buildForecastQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import {
  parseForecastResult,
  downsampleMinMax,
  summarizeForecast,
  type ForecastResult,
} from '../../forecast';
import { renderForecastChart } from '../chartRender';
import { putForecast } from '../forecastCache';

export interface ForecastArgs {
  /** Resolved tag id (use resolve_tags first). */
  tagId: string;
  /** History window start (ISO 8601). */
  startIso: string;
  /** History window end / forecast origin (ISO 8601). */
  endIso: string;
  /** Number of future bins to predict. */
  horizonPoints: number;
  /** Two-sided prediction-interval confidence (default 0.95). */
  confidence?: number;
  aggregation?: Aggregation;
  /** Optional threshold for a breach-probability check. */
  threshold?: number;
  /** Required when `threshold` is set. */
  direction?: 'above' | 'below';
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

function horizonPreview(r: ForecastResult) {
  const relX = r.x.slice(r.forecastStart);
  const relForecast = r.forecast.slice(r.forecastStart);
  return downsampleMinMax(relX, relForecast, 24).map((relIdx) => {
    const i = r.forecastStart + relIdx;
    return {
      t: r.x[i],
      iso: new Date(r.x[i]).toISOString(),
      f: round(r.forecast[i]),
      lo: round(r.lower[i]),
      hi: round(r.upper[i]),
    };
  });
}

function round(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v === 0) return 0;
  return Number(v.toPrecision(3));
}

export const forecastTool: AgentTool<ForecastArgs> = {
  name: 'forecast',
  readOnly: true,
  description:
    'Forecast a single tag over a future horizon using series_decompose_forecast, with a ' +
    'prediction interval. Optionally returns the probability that a threshold is breached ' +
    'somewhere in the horizon. Call resolve_tags first to obtain tagId. Times are ISO 8601. ' +
    'Returns a compact feature summary, a min/max-downsampled preview, a forecastId, and ' +
    'a chart. To inspect a specific region at full resolution, call forecast_detail with ' +
    'that forecastId.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id from resolve_tags.' },
      startIso: { type: 'string', description: 'History start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'History end / forecast origin (ISO 8601, UTC).' },
      horizonPoints: { type: 'integer', minimum: 1, maximum: 2000, description: 'Future bins to predict.' },
      confidence: { type: 'number', minimum: 0.5, maximum: 0.999, default: 0.95 },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      threshold: { type: 'number', description: 'Optional value to test for a breach.' },
      direction: { type: 'string', enum: ['above', 'below'], description: 'Breach direction; required with threshold.' },
    },
    required: ['tagId', 'startIso', 'endIso', 'horizonPoints'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required (call resolve_tags first).');

    const start = new Date(args.startIso);
    const end = new Date(args.endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return toolError('bad_args', 'startIso/endIso must be valid ISO 8601 datetimes.');
    }
    if (end <= start) return toolError('bad_args', 'endIso must be after startIso.');

    const horizonPoints = Math.trunc(args.horizonPoints);
    if (!Number.isFinite(horizonPoints) || horizonPoints < 1) {
      return toolError('bad_args', 'horizonPoints must be a positive integer.');
    }
    if (args.threshold != null && !args.direction) {
      return toolError('bad_args', 'direction is required when threshold is provided.');
    }

    const confidence = args.confidence ?? 0.95;
    const bin = chooseBin({ start, end });
    const futureEnd = new Date(end.getTime() + horizonPoints * bin.millis);

    const csl = buildForecastQuery({
      tagId,
      start,
      end,
      futureEnd,
      binKql: bin.kql,
      horizonPoints,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });

    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const result = parseForecastResult(table, confidence);
    if (!result) return toolError('empty', `No data to forecast for ${tagId} in the given window.`);

    const features = summarizeForecast(result, {
      threshold: args.threshold,
      direction: args.direction,
    });
    const forecastId = putForecast(result, {
      signalId: tagId,
      binLabel: bin.label,
      binSeconds: (bin.millis / 1000),
      confidence,
      threshold: args.threshold,
      direction: args.direction,
    });
    const chart = renderForecastChart(result, {
      title: `Forecast — ${tagId}`,
      threshold: args.threshold,
    });
    const fc = result.forecast.filter((v): v is number => v != null);
    const first = fc[0];
    const last = fc[fc.length - 1];
    const breach = features.breach;

    return {
      ok: true,
      summary:
        `Forecast ${horizonPoints} bin(s) of ${bin.label} for ${tagId}: ` +
        `${round(first) ?? '—'} → ${round(last) ?? '—'} ` +
        `(±${(confidence * 100).toFixed(0)}% interval).` +
        (breach
          ? ` ~${(breach.anyBreachProbability * 100).toFixed(0)}% chance of going ` +
            `${args.direction} ${args.threshold} in the horizon.`
          : ''),
      data: {
        forecastId,
        signalId: tagId,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        confidence,
        features,
        breach,
        preview: horizonPreview(result),
        caveats:
          (features.historyWindow === 'recent' ? 'Point forecast uses a shortened recent-regime history window that a rolling-origin backtest selected over the full window; ' : '') +
          (features.modelInput === 'outlier-cleaned' ? 'Point forecast was computed on an outlier-cleaned (winsorized) model input that a rolling-origin backtest selected over the raw series; ' : '') +
          (result.calibration.method === 'backtest'
            ? 'Prediction band is measured from a rolling-origin backtest\u2019s out-of-sample per-horizon error quantiles (no Gaussian/sqrt(steps-ahead) assumption); '
            : result.calibration.method === 'empirical'
              ? 'Prediction band uses empirical residual quantiles scaled by sqrt(steps-ahead); '
              : 'Prediction band assumes Gaussian errors widening as sqrt(steps-ahead) under a random-walk; ') +
          (breach?.anyBreachMethod === 'trajectory'
            ? 'anyBreachProbability is estimated from an ensemble of residual-based error trajectories that preserve cross-horizon dependence, so it is an APPROXIMATE estimate (not a guaranteed bound). '
            : 'anyBreachProbability treats bins as independent, so it is an APPROXIMATE estimate (not a guaranteed upper bound) and assumes approximately-normal residuals. ') +
          'The chart shows shape/seasonality; use features/preview for exact values.',
      },
      chart,
    };
  },
};
