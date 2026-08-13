/**
 * `regression_analysis` — relate a target tag to one or more feature tags via
 * per-feature ordinary least-squares fits, ranked by R² (feature importance).
 *
 * Seam: chooseBin -> buildRegressionQuery -> executeKql -> parseRegressionFit.
 * KQL lacks native multivariate regression, so each feature is fit univariately
 * (target ~ feature) and ranked; the strongest feature's fitted line is charted.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildRegressionQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseRegressionFit } from '../../regression';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, round } from '../toolUtils';

export interface RegressionAnalysisArgs {
  targetTagId: string;
  featureTagIds: string[];
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const regressionAnalysisTool: AgentTool<RegressionAnalysisArgs> = {
  name: 'regression_analysis',
  readOnly: true,
  description:
    'Relate a target tag to one or more feature tags with least-squares regression, ranked by R² ' +
    '(feature importance / sensitivity). Use for "what best explains this signal / how sensitive is it ' +
    'to X". Call resolve_tags first; times are ISO 8601 UTC. Returns per-feature R², slope, and intercept ' +
    'sorted strongest first, plus a fitted-vs-actual chart for the top feature. Each feature is fit ' +
    'univariately (KQL has no native multivariate regression), so rankings are marginal, not partial. ' +
    'Siblings: this quantifies how strongly/which direction each feature explains the target\'s level ' +
    '(sensitivity, R²); for temporal lead/lag use rank_causes, and for directional predictive ' +
    'influence across a group use causality_matrix.',
  parameters: {
    type: 'object',
    properties: {
      targetTagId: { type: 'string', description: 'The tag to explain (from resolve_tags).' },
      featureTagIds: { type: 'array', items: { type: 'string' }, description: 'Candidate explanatory tag ids.' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['targetTagId', 'featureTagIds', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const targetTagId = String(args.targetTagId ?? '').trim();
    const featureTagIds = (args.featureTagIds ?? []).map((t) => String(t).trim()).filter((t) => t && t !== targetTagId);
    if (!targetTagId) return toolError('bad_args', 'targetTagId is required (call resolve_tags first).');
    if (featureTagIds.length === 0) return toolError('bad_args', 'Provide at least one featureTagId distinct from the target.');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);

    const csl = buildRegressionQuery({
      targetTagId,
      featureTagIds,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });
    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const fits = parseRegressionFit(table).sort((a, b) => b.rsquare - a.rsquare);
    if (fits.length === 0) return toolError('empty', `No regression fit for ${targetTagId} in the given window.`);

    const features = fits.map((f) => ({
      featureTagId: f.featureTagId,
      rsquare: round(f.rsquare),
      slope: round(f.slope),
      intercept: round(f.intercept),
    }));

    const best = fits[0];
    const xMs = best.timestamps.map((s) => s * 1000);
    const chart = renderSeriesChart({
      title: `Regression — ${targetTagId} ~ ${best.featureTagId} (R²=${round(best.rsquare)})`,
      x: xMs,
      series: [
        { name: targetTagId, values: best.targetSeries },
        { name: `fit(${best.featureTagId})`, values: best.fittedSeries, dashed: true },
      ],
    });

    return {
      ok: true,
      summary:
        `Regressed ${targetTagId} on ${featureTagIds.length} feature(s) at ${bin.label} bins. ` +
        `Best: ${best.featureTagId} explains ${(best.rsquare * 100).toFixed(0)}% of variance ` +
        `(slope ${round(best.slope)}).`,
      data: {
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        target: targetTagId,
        features,
        caveats:
          'Each feature is fit univariately (target ~ feature); R² is the squared Pearson correlation, so ' +
          'rankings are marginal — correlated features can each look strong without adding independent ' +
          'explanatory power. Relationship is linear and associational, not causal.',
      },
      chart,
    };
  },
};
