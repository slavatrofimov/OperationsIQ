/**
 * `compare_periods` — compare one tag's behavior across two or more time
 * windows (e.g. this week vs last week, before vs after a change).
 *
 * Seam: chooseBin per window -> buildBinnedSeriesQuery -> parseExploreRows ->
 * computeStats per period, plus deltas vs the first (reference) period. Series
 * are re-based to a shared relative offset (bin index) so they overlay on one
 * chart despite different absolute times.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildBinnedSeriesQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseExploreRows } from '../../series';
import { computeStats } from '../../stats';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, preview, round, slopePerBin, trendLabel } from '../toolUtils';

export interface ComparePeriodInput {
  /** Optional label (e.g. "last week"). Defaults to the index. */
  label?: string;
  startIso: string;
  endIso: string;
}

export interface ComparePeriodsArgs {
  tagId: string;
  periods: ComparePeriodInput[];
  aggregation?: Aggregation;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

function statBlock(values: (number | null)[]) {
  const s = computeStats(values);
  return {
    count: s.count,
    min: round(s.min),
    max: round(s.max),
    mean: round(s.mean),
    median: round(s.median),
    stdev: round(s.stdev),
    p05: round(s.p05),
    p95: round(s.p95),
  };
}

export const comparePeriodsTool: AgentTool<ComparePeriodsArgs> = {
  name: 'compare_periods',
  readOnly: true,
  description:
    'Compare one tag across two or more time windows — e.g. this week vs last week, or before vs after a ' +
    'maintenance event. Returns descriptive statistics per period plus the change (delta and %) of each ' +
    'period relative to the first, and a chart overlaying the periods on a shared relative time axis. Call ' +
    'resolve_tags first. Times are ISO 8601 UTC. For A/B driver analysis use rank_causes; for anomaly ' +
    'context use explore_signals.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      periods: {
        type: 'array',
        description: 'Two or more windows to compare. The first is the reference/baseline for deltas.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Optional human label, e.g. "baseline" or "after fix".' },
            startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
            endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
          },
          required: ['startIso', 'endIso'],
        },
      },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['tagId', 'periods'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required. Call resolve_tags first.');
    const periods = (args.periods ?? []).filter((p) => p && p.startIso && p.endIso);
    if (periods.length < 2) return toolError('bad_args', 'Provide at least two periods to compare.');

    const results: {
      label: string;
      startIso: string;
      endIso: string;
      bin: string;
      stats: ReturnType<typeof statBlock>;
      trend: 'rising' | 'falling' | 'flat';
      values: (number | null)[];
      x: number[];
    }[] = [];

    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      const win = parseWindow(p.startIso, p.endIso);
      if ('error' in win) return toolError('bad_args', `Period ${i + 1}: ${win.error}`);
      const bin = binFor(win.start, win.end, args.maxBins);
      const csl = buildBinnedSeriesQuery({
        tagId,
        start: win.start,
        end: win.end,
        binKql: bin.kql,
        aggregation: args.aggregation,
        timeseriesRef: ctx.timeseriesRef,
      });
      const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
      const rows = parseExploreRows(table);
      const values = rows[0]?.values ?? [];
      const x = (rows[0]?.x ?? []).map((s) => s * 1000);
      const st = computeStats(values);
      if (st.count === 0) return toolError('empty', `No data for period ${i + 1} (${p.label ?? ''}).`);
      results.push({
        label: p.label?.trim() || `period_${i + 1}`,
        startIso: win.start.toISOString(),
        endIso: win.end.toISOString(),
        bin: bin.label,
        stats: statBlock(values),
        trend: trendLabel(slopePerBin(values), st.max - st.min),
        values,
        x,
      });
    }

    const ref = results[0];
    const refMean = ref.stats.mean;
    const comparisons = results.slice(1).map((r) => {
      const delta = r.stats.mean != null && refMean != null ? round(r.stats.mean - refMean) : null;
      const pct =
        r.stats.mean != null && refMean != null && refMean !== 0
          ? round(((r.stats.mean - refMean) / Math.abs(refMean)) * 100)
          : null;
      return { label: r.label, meanDelta: delta, meanPctChange: pct, trend: r.trend };
    });

    // Overlay periods on a shared synthetic relative axis (bin offset from start).
    const maxLen = Math.max(...results.map((r) => r.values.length));
    const step = ref.x.length > 1 ? ref.x[1] - ref.x[0] : 60_000;
    const base = ref.x[0] ?? 0;
    const relAxis = Array.from({ length: maxLen }, (_, i) => base + i * step);
    const chart = renderSeriesChart({
      title: `Compare periods — ${tagId}`,
      x: relAxis,
      series: results.map((r) => ({ name: r.label, values: r.values })),
    });

    const best = comparisons.reduce<{ label: string; pct: number } | null>((acc, c) => {
      if (c.meanPctChange == null) return acc;
      if (!acc || Math.abs(c.meanPctChange) > Math.abs(acc.pct)) return { label: c.label, pct: c.meanPctChange };
      return acc;
    }, null);

    return {
      ok: true,
      summary:
        `Compared ${results.length} periods of ${tagId}. Reference "${ref.label}" mean ${ref.stats.mean}. ` +
        (best ? `Largest shift: "${best.label}" ${best.pct! >= 0 ? '+' : ''}${best.pct}% vs reference.` : 'No mean change computable.'),
      data: {
        tagId,
        reference: ref.label,
        periods: results.map((r) => ({
          label: r.label,
          startIso: r.startIso,
          endIso: r.endIso,
          bin: r.bin,
          stats: r.stats,
          trend: r.trend,
          preview: preview(r.x, r.values),
        })),
        comparisons,
        caveats:
          'Deltas compare each period\'s mean to the first period. Periods may use different bin widths if their ' +
          'durations differ; the chart overlays them on a relative offset axis, not absolute time.',
      },
      chart,
    };
  },
};
