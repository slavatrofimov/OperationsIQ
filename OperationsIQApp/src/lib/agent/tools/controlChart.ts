/**
 * `control_chart` — SPC (Statistical Process Control) chart for one tag: an
 * I-MR / X̄-R / X̄-S chart with Nelson/WECO run-rule evaluation and an in-control
 * false-alarm estimate (α, ARL₀).
 *
 * Seam: chooseBin -> buildExploreQuery -> parseExploreRows -> individualsToSubgroups
 * -> buildControlChart -> evaluateRules(resolveProfile). Returns the estimated
 * limits, every rule violation, and the false-alarm tradeoff for the chosen profile.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildExploreQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseExploreRows } from '../../series';
import { buildControlChart, individualsToSubgroups } from '../../spc/controlChart';
import { evaluateRules, resolveProfile, estimateFalseAlarm, RULE_DEFS, type RuleId } from '../../spc/rules';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, preview, round } from '../toolUtils';

export interface ControlChartArgs {
  tagId: string;
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  /** Run-rule profile. */
  profile?: 'basic' | 'weco' | 'nelson' | 'minitab';
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];
const PROFILES = ['basic', 'weco', 'nelson', 'minitab'] as const;

export const controlChartTool: AgentTool<ControlChartArgs> = {
  name: 'control_chart',
  readOnly: true,
  description:
    'Build a Statistical Process Control (SPC) I-MR chart for one tag and evaluate special-cause ' +
    'run rules (basic 3σ, Western Electric, or Nelson). Use for "is this process in statistical control ' +
    'and which points signal a special cause". Call resolve_tags first; times are ISO 8601 UTC. Returns ' +
    'the estimated control limits, rule violations (with rule name and flagged time), the in-control ' +
    'false-alarm rate (alpha) and ARL0 for the chosen profile, a preview, and a chart. Each binned value ' +
    'is treated as one individual observation. Sibling: unlike monitor_deviation (adaptive ' +
    'trend/seasonal envelope for "did it leave its expected band") this uses data-derived SPC ' +
    'control limits and run-rules to judge process stability.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      profile: { type: 'string', enum: PROFILES, default: 'nelson', description: 'Run-rule set to apply.' },
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
    const profile = args.profile ?? 'nelson';

    const csl = buildExploreQuery({
      tagIds: [tagId],
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });
    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const series = parseExploreRows(table);
    if (series.length === 0 || series[0].x.length === 0) {
      return toolError('empty', `No data for ${tagId} in the given window.`);
    }

    const s = series[0];
    const xMs = s.x.map((v) => v * 1000);
    const subgroups = individualsToSubgroups(xMs, s.values);
    const chart = buildControlChart('i-mr', subgroups);
    const cfg = resolveProfile(profile);
    const violations = evaluateRules({ values: s.values, limits: chart.primary.limits }, cfg);
    const falseAlarm = estimateFalseAlarm(cfg);

    const lim = chart.primary.limits;
    const violationSummary = violations.slice(0, 15).map((v) => ({
      rule: `${v.ruleId} ${RULE_DEFS[v.ruleId as RuleId].name}`,
      atIso: new Date(xMs[v.flaggedIndex] ?? xMs[0]).toISOString(),
      side: v.side,
      value: round(s.values[v.flaggedIndex] ?? null),
    }));

    const chartImg = renderSeriesChart({
      title: `Control chart (I) — ${tagId}`,
      x: xMs,
      series: [
        { name: 'value', values: s.values },
        { name: 'CL', values: xMs.map(() => lim.centerLine), dashed: true },
        { name: 'UCL', values: xMs.map(() => lim.ucl), dashed: true },
        { name: 'LCL', values: xMs.map(() => lim.lcl), dashed: true },
      ],
    });

    return {
      ok: true,
      summary:
        `${tagId} I-MR chart (${profile}): CL ${round(lim.centerLine)}, UCL ${round(lim.ucl)}, LCL ${round(lim.lcl)}. ` +
        `${violations.length} rule violation(s) across ${s.x.length} points. ` +
        `In-control ARL0 ≈ ${round(falseAlarm.arl0)} points (α ≈ ${round(falseAlarm.alpha)}).`,
      data: {
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        profile,
        limits: {
          centerLine: round(lim.centerLine),
          ucl: round(lim.ucl),
          lcl: round(lim.lcl),
          sigma: round(lim.sigma),
        },
        violationCount: violations.length,
        violations: violationSummary,
        violationsTruncated: violations.length > violationSummary.length,
        falseAlarm: { alpha: round(falseAlarm.alpha), arl0: round(falseAlarm.arl0), ruleIds: falseAlarm.ruleIds },
        preview: preview(xMs, s.values),
        caveats:
          'Phase I: limits are estimated from this same data (I-MR, σ from the average moving range). ' +
          'Each bin is one individual observation, so autocorrelation from binning can inflate violations. ' +
          'ARL0/α are Monte-Carlo estimates for an in-control normal process under the chosen rule set.',
      },
      chart: chartImg,
    };
  },
};
