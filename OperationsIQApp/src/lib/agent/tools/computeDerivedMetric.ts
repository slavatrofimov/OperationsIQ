/**
 * `compute_derived_metric` — evaluate a user formula over several tags on a
 * common time grid to produce a new synthetic series (e.g. efficiency = power/flow).
 *
 * Seam: chooseBin -> buildBinnedSeriesQuery per tag -> parseExploreRows ->
 * compileExpression / evaluateSeries (+ optional rateOfChange / rollingMean),
 * then descriptive stats. The derived series is cached under a seriesId.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildBinnedMultiSeriesQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseExploreRows } from '../../series';
import { compileExpression, evaluateSeries, rateOfChange, rollingMean } from '../../expression';
import { computeStats } from '../../stats';
import { putSeries } from '../seriesCache';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, preview, round, slopePerBin, trendLabel } from '../toolUtils';

export interface DerivedVariable {
  /** Identifier used in `formula` (letters/digits/underscore). */
  name: string;
  /** Resolved tag id supplying this variable's series. */
  tagId: string;
}

export interface ComputeDerivedMetricArgs {
  formula: string;
  variables: DerivedVariable[];
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  /** Optional post-transform of the derived series. */
  transform?: 'none' | 'rate_of_change' | 'rolling_mean';
  /** Window (bins) for rolling_mean. Default 5. */
  rollingWindow?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];
const TRANSFORMS = ['none', 'rate_of_change', 'rolling_mean'] as const;

export const computeDerivedMetricTool: AgentTool<ComputeDerivedMetricArgs> = {
  name: 'compute_derived_metric',
  readOnly: true,
  description:
    'Compute a synthetic series from a formula over several tags on a common time grid — e.g. ' +
    '"power / flow" or "a - b". Use for engineered metrics the raw tags don\'t provide. Call resolve_tags ' +
    'first, then map each formula variable to a tagId. Supported ops: + - * / % ^ and functions like ' +
    'abs, min, max, sqrt, log, exp (see the expression library). Times are ISO 8601 UTC. Returns descriptive ' +
    'stats + trend of the derived series, a preview, a seriesId (series_detail), and a chart.',
  parameters: {
    type: 'object',
    properties: {
      formula: { type: 'string', description: 'Expression using the variable names, e.g. "power / flow".' },
      variables: {
        type: 'array',
        description: 'Map each formula variable name to a resolved tagId.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Variable name used in the formula.' },
            tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
          },
          required: ['name', 'tagId'],
        },
      },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      transform: { type: 'string', enum: TRANSFORMS, default: 'none', description: 'Optional post-transform.' },
      rollingWindow: { type: 'integer', minimum: 2, maximum: 500, default: 5, description: 'Window (bins) for rolling_mean.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['formula', 'variables', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const formula = String(args.formula ?? '').trim();
    if (!formula) return toolError('bad_args', 'formula is required.');
    const variables = (args.variables ?? []).filter((v) => v && v.name && v.tagId);
    if (variables.length === 0) return toolError('bad_args', 'Provide at least one variable → tagId mapping.');

    const names = variables.map((v) => v.name);
    const compiled = compileExpression(formula, names);
    if (!compiled.ok) return toolError('bad_args', `Formula error: ${compiled.error}`);

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);

    // Fetch every distinct tag on the shared grid in a single query (one row per
    // SignalId), instead of one query per tag.
    const byTag = new Map<string, (number | null)[]>();
    let axis: number[] | null = null;
    const distinctIds = [...new Set(variables.map((v) => v.tagId))];
    const csl = buildBinnedMultiSeriesQuery({
      tagIds: distinctIds,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });
    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const byId = new Map(parseExploreRows(table).map((row) => [row.tagId, row]));
    for (const tagId of distinctIds) {
      const rows = byId.get(tagId);
      if (!rows || rows.x.length === 0) return toolError('empty', `No data for tag ${tagId} in the given window.`);
      byTag.set(tagId, rows.values);
      if (!axis) axis = rows.x.map((s) => s * 1000);
    }
    if (!axis) return toolError('empty', 'No data returned.');

    const length = axis.length;
    const scope: Record<string, (number | null)[]> = {};
    for (const v of variables) scope[v.name] = byTag.get(v.tagId) ?? [];

    let derived = evaluateSeries(compiled.expr, scope, length);
    const transform = args.transform ?? 'none';
    if (transform === 'rate_of_change') derived = rateOfChange(derived);
    else if (transform === 'rolling_mean') derived = rollingMean(derived, Math.trunc(args.rollingWindow ?? 5));

    const stats = computeStats(derived);
    if (stats.count === 0) return toolError('empty', 'The formula produced no finite values (check for divide-by-zero or missing overlap).');

    const slope = slopePerBin(derived);
    const seriesId = putSeries(axis, { derived }, { kind: 'derived', binLabel: bin.label, binSeconds: (bin.millis / 1000) });
    const chart = renderSeriesChart({
      title: `Derived — ${formula}${transform !== 'none' ? ` (${transform})` : ''}`,
      x: axis,
      series: [{ name: formula, values: derived }],
    });

    return {
      ok: true,
      summary:
        `Derived "${formula}"${transform !== 'none' ? ` [${transform}]` : ''} at ${bin.label} bins: ` +
        `mean ${round(stats.mean)}, range ${round(stats.min)}..${round(stats.max)}, ${trendLabel(slope, stats.max - stats.min)}.`,
      data: {
        seriesId,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        formula,
        transform,
        variables,
        stats: {
          count: stats.count,
          min: round(stats.min),
          max: round(stats.max),
          mean: round(stats.mean),
          median: round(stats.median),
          stdev: round(stats.stdev),
          p05: round(stats.p05),
          p95: round(stats.p95),
        },
        trend: trendLabel(slope, stats.max - stats.min),
        preview: preview(axis, derived),
        caveats:
          'Bins where any input is missing/non-finite (including divide-by-zero) yield no derived value. ' +
          'Inputs are gap-filled and aligned to a shared grid. Use series_detail for full-resolution values.',
      },
      chart,
    };
  },
};
