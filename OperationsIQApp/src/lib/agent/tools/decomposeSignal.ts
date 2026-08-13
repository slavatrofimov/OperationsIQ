/**
 * `decompose_signal` — split one tag into baseline / seasonal / trend / residual
 * components via series_decompose.
 *
 * Seam: chooseBin -> buildDecompositionQuery -> executeKql -> parseDecomposition,
 * then residualStats for a fit-quality read. The four component arrays are cached
 * under a seriesId for series_detail drill-down.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildDecompositionQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseDecomposition, residualStats } from '../../decompose';
import { computeStats } from '../../stats';
import { putSeries } from '../seriesCache';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, preview, round, slopePerBin, trendLabel } from '../toolUtils';

export interface DecomposeSignalArgs {
  tagId: string;
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  /** Seasonality period in bins: -1 auto-detect (default), 0 disable, or a fixed period. */
  seasonality?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const decomposeSignalTool: AgentTool<DecomposeSignalArgs> = {
  name: 'decompose_signal',
  readOnly: true,
  description:
    'Decompose one tag into baseline, seasonal, trend, and residual components (series_decompose). ' +
    'Use to separate a persistent trend and repeating seasonality from noise, and to judge how much ' +
    'of the signal is explained by that structure. Call resolve_tags first; times are ISO 8601 UTC. ' +
    'Returns component features (trend direction, seasonal amplitude, variance explained, largest ' +
    'residual), a preview, a seriesId (drill in with series_detail), and a chart. Sibling: this ' +
    'removes one assumed seasonal period; to discover unknown periodicities/frequencies use ' +
    'analyze_spectrum.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      seasonality: { type: 'integer', minimum: -1, description: 'Season period in bins: -1 auto (default), 0 off, or fixed.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['tagId', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required (call resolve_tags first).');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);

    const csl = buildDecompositionQuery({
      tagId,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      seasonality: args.seasonality,
      timeseriesRef: ctx.timeseriesRef,
    });

    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const d = parseDecomposition(table);
    if (!d || d.t.length === 0) return toolError('empty', `No data to decompose for ${tagId} in the given window.`);

    const rs = residualStats(d);
    const trendStats = computeStats(d.trend);
    const seasonalStats = computeStats(d.seasonal);
    const trendSlope = slopePerBin(d.trend);

    const seriesId = putSeries(
      d.t,
      { value: d.value, baseline: d.baseline, seasonal: d.seasonal, trend: d.trend, residual: d.residual },
      { kind: 'decomposition', signalId: tagId, binLabel: bin.label, binSeconds: (bin.millis / 1000) },
    );

    const chart = renderSeriesChart({
      title: `Decomposition — ${tagId}`,
      x: d.t,
      series: [
        { name: 'value', values: d.value },
        { name: 'baseline', values: d.baseline, dashed: true },
        { name: 'trend', values: d.trend, dashed: true },
      ],
    });

    const seasonalAmplitude =
      Number.isFinite(seasonalStats.max) && Number.isFinite(seasonalStats.min)
        ? seasonalStats.max - seasonalStats.min
        : NaN;

    return {
      ok: true,
      summary:
        `Decomposed ${tagId} at ${bin.label} bins: trend ${trendLabel(trendSlope, trendStats.max - trendStats.min)}, ` +
        `seasonal amplitude ${round(seasonalAmplitude) ?? '—'}, ` +
        `${(rs.varianceExplained * 100).toFixed(0)}% of variance explained by baseline; ` +
        `largest residual ${rs.maxResidualZ.toFixed(1)}σ.`,
      data: {
        seriesId,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        features: {
          trend: trendLabel(trendSlope, trendStats.max - trendStats.min),
          trendSlopePerBin: round(trendSlope),
          trendStart: round(d.trend.find((v) => v != null) ?? null),
          trendEnd: round([...d.trend].reverse().find((v) => v != null) ?? null),
          seasonalAmplitude: round(seasonalAmplitude),
          varianceExplained: round(rs.varianceExplained),
          residualStdDev: round(rs.residualStdDev),
          maxResidualZ: round(rs.maxResidualZ),
        },
        preview: preview(d.t, d.value),
        caveats:
          'Trend is a linear fit; seasonality is auto-detected unless a period is given (0 disables it). ' +
          'varianceExplained is 1 − var(residual)/var(value). Use series_detail for the full component arrays.',
      },
      chart,
    };
  },
};
