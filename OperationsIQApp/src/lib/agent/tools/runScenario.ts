/**
 * `run_scenario` — deterministic what-if projection. Takes one tag's baseline
 * over a window, applies a chain of adjustments (scale / offset / ramp / clamp),
 * and compares KPIs (mean, peak, integral, time-above-limit) between baseline
 * and scenario, plus advisory risk flags.
 *
 * Seam: chooseBin -> buildAlignedSeriesQuery -> parseAlignedSeries ->
 * applyAdjustments / compareKpis / riskFlags. Read-only: never persists a run.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildAlignedSeriesQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseAlignedSeries } from '../../rootCause';
import { applyAdjustments, compareKpis, riskFlags, type Adjustment, type AdjustmentKind } from '../../scenario';
import { putSeries } from '../seriesCache';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, preview, round } from '../toolUtils';

export interface ScenarioAdjustmentInput {
  kind: AdjustmentKind;
  value?: number;
  rampTo?: number;
  min?: number;
  max?: number;
  enabled?: boolean;
}

export interface RunScenarioArgs {
  tagId: string;
  startIso: string;
  endIso: string;
  adjustments: ScenarioAdjustmentInput[];
  aggregation?: Aggregation;
  upperLimit?: number;
  lowerLimit?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];
const KINDS: AdjustmentKind[] = ['scale', 'offset', 'ramp', 'clamp'];

function kpiBlock(k: { mean: number; min: number; max: number; integral: number; timeAboveLimit: number }) {
  return {
    mean: round(k.mean),
    min: round(k.min),
    max: round(k.max),
    integral: round(k.integral),
    timeAboveLimitSeconds: round(k.timeAboveLimit),
  };
}

export const runScenarioTool: AgentTool<RunScenarioArgs> = {
  name: 'run_scenario',
  readOnly: true,
  description:
    'Project a what-if scenario for one tag by applying adjustments to its baseline and comparing KPIs. ' +
    'Adjustments (applied in order): scale (multiply by value), offset (add value), ramp (add a linear change ' +
    'reaching rampTo by the end), clamp (bound to min/max). Compares mean, peak, integral, and time-above-limit ' +
    'baseline vs scenario, and raises advisory risk flags against optional limits. Read-only — nothing is saved. ' +
    'Call resolve_tags first. Times are ISO 8601 UTC.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      startIso: { type: 'string', description: 'Baseline window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Baseline window end (ISO 8601, UTC).' },
      adjustments: {
        type: 'array',
        description: 'Ordered chain of adjustments to apply to the baseline.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: KINDS, description: 'scale | offset | ramp | clamp.' },
            value: { type: 'number', description: 'scale: multiplier (1=no change). offset: additive constant.' },
            rampTo: { type: 'number', description: 'ramp: total additive change applied linearly across the window.' },
            min: { type: 'number', description: 'clamp: lower bound.' },
            max: { type: 'number', description: 'clamp: upper bound.' },
            enabled: { type: 'boolean', default: true },
          },
          required: ['kind'],
        },
      },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      upperLimit: { type: 'number', description: 'Optional upper operating limit for KPIs and risk flags.' },
      lowerLimit: { type: 'number', description: 'Optional lower operating limit for risk flags.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['tagId', 'startIso', 'endIso', 'adjustments'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required. Call resolve_tags first.');
    const rawAdj = (args.adjustments ?? []).filter((a) => a && a.kind);
    if (rawAdj.length === 0) return toolError('bad_args', 'Provide at least one adjustment.');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);

    const csl = buildAlignedSeriesQuery({
      tagIds: [tagId],
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });
    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const series = parseAlignedSeries(table);
    const base = series[0];
    if (!base || base.v.every((v) => v == null)) return toolError('empty', 'No baseline data in the given window.');

    const adjustments: Adjustment[] = rawAdj.map((a) => ({
      kind: a.kind,
      value: a.value,
      rampTo: a.rampTo,
      min: a.min,
      max: a.max,
      enabled: a.enabled !== false,
    }));

    const scenario = applyAdjustments(base.v, adjustments);
    const cmp = compareKpis(base.v, scenario, (bin.millis / 1000), args.upperLimit);
    const flags = riskFlags(cmp, scenario, { upperLimit: args.upperLimit, lowerLimit: args.lowerLimit });

    const seriesId = putSeries(base.t, { baseline: base.v, scenario }, { kind: 'scenario', signalId: tagId, binLabel: bin.label, binSeconds: (bin.millis / 1000) });
    const chart = renderSeriesChart({
      title: `Scenario — ${tagId}`,
      x: base.t,
      series: [
        { name: 'baseline', values: base.v },
        { name: 'scenario', values: scenario, dashed: true },
      ],
      threshold: args.upperLimit,
    });

    const meanShiftPct =
      cmp.baseline.mean !== 0 ? round(((cmp.scenario.mean - cmp.baseline.mean) / Math.abs(cmp.baseline.mean)) * 100) : null;

    return {
      ok: true,
      summary:
        `Scenario on ${tagId} (${adjustments.filter((a) => a.enabled).length} adjustment(s)) at ${bin.label} bins: ` +
        `mean ${round(cmp.baseline.mean)} → ${round(cmp.scenario.mean)}` +
        (meanShiftPct != null ? ` (${meanShiftPct >= 0 ? '+' : ''}${meanShiftPct}%)` : '') +
        `, peak ${round(cmp.baseline.max)} → ${round(cmp.scenario.max)}. ${flags.length} risk flag(s).`,
      data: {
        seriesId,
        tagId,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        adjustments,
        kpis: { baseline: kpiBlock(cmp.baseline), scenario: kpiBlock(cmp.scenario) },
        meanShiftPct,
        riskFlags: flags,
        preview: preview(base.t, scenario),
        caveats:
          'Deterministic client-side projection over the fetched baseline — not a physical/plant model. ' +
          'Risk flags are heuristic and advisory. Nothing is persisted. Use series_detail for full resolution.',
      },
      chart,
    };
  },
};
