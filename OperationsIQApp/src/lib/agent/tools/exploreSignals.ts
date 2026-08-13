/**
 * `explore_signals` — adaptive-binned exploration with an unsupervised anomaly
 * overlay, for one or more tags over a time window.
 *
 * Seam: chooseBin -> buildExploreQuery -> executeKql -> parseExploreRows, then
 * per-tag descriptive stats + anomaly summary + a capped min/max preview. The
 * full per-tag series (value, baseline, anomaly) is cached under a seriesId so
 * the agent can drill in with series_detail.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildExploreQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseExploreRows } from '../../series';
import { computeStats } from '../../stats';
import { putSeries } from '../seriesCache';
import { renderSeriesChart, type ChartSeriesSpec } from '../charts';
import { parseWindow, binFor, preview, round, slopePerBin, trendLabel } from '../toolUtils';

export interface ExploreSignalsArgs {
  tagIds: string[];
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  /** Anomaly sensitivity (lower = more sensitive). Default 1.5. */
  sensitivity?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const exploreSignalsTool: AgentTool<ExploreSignalsArgs> = {
  name: 'explore_signals',
  readOnly: true,
  description:
    'Explore one or more tags over a time window: adaptive-binned series with an unsupervised ' +
    'anomaly overlay (series_decompose_anomalies). Call resolve_tags first for tagIds; times are ' +
    'ISO 8601 UTC. Returns per-tag descriptive stats, trend, anomaly count/timestamps, a compact ' +
    'min/max preview, a seriesId (drill in with series_detail), and a chart. This is the general ' +
    'starting point for "what does this signal look like / are there anomalies". Siblings: for ' +
    'structure use decompose_signal (trend/seasonal split) or analyze_spectrum (periodic content); ' +
    'to test a signal against an expected envelope use monitor_deviation; for SPC run-rules use ' +
    'control_chart; for shape-based rare events use detect_discords.',
  parameters: {
    type: 'object',
    properties: {
      tagIds: { type: 'array', items: { type: 'string' }, description: 'Resolved tag ids (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      sensitivity: { type: 'number', minimum: 0.1, maximum: 10, default: 1.5, description: 'Anomaly sensitivity; lower flags more.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000, description: 'Optional cap on number of bins.' },
    },
    required: ['tagIds', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagIds = (args.tagIds ?? []).map((t) => String(t).trim()).filter(Boolean);
    if (tagIds.length === 0) return toolError('bad_args', 'tagIds is required (call resolve_tags first).');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);

    const csl = buildExploreQuery({
      tagIds,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      sensitivity: args.sensitivity,
      timeseriesRef: ctx.timeseriesRef,
    });

    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const series = parseExploreRows(table);
    if (series.length === 0) return toolError('empty', `No data for the given tags in ${win.start.toISOString()}..${win.end.toISOString()}.`);

    const chartSeries: ChartSeriesSpec[] = [];
    const perTag = series.map((s) => {
      const xMs = s.x.map((v) => v * 1000);
      const stats = computeStats(s.values);
      const anomalyIdx: number[] = [];
      s.anomalies.forEach((v, i) => {
        if (v != null) anomalyIdx.push(i);
      });
      const slope = slopePerBin(s.values);
      const missing = s.values.filter((v) => v == null).length;
      const seriesId = putSeries(
        xMs,
        { value: s.values, baseline: s.baseline, anomaly: s.anomalies },
        { kind: 'explore', signalId: s.tagId, binLabel: bin.label, binSeconds: (bin.millis / 1000) },
      );
      chartSeries.push({ name: s.tagId, values: s.values });
      if (anomalyIdx.length > 0) {
        const overlay = s.values.map((v, i) => (s.anomalies[i] != null ? v : null));
        chartSeries.push({ name: `${s.tagId} anomalies`, values: overlay, type: 'scatter' });
      }
      return {
        tagId: s.tagId,
        seriesId,
        points: s.x.length,
        missingBins: missing,
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
        slopePerBin: round(slope),
        anomalyCount: anomalyIdx.length,
        anomalyTimes: anomalyIdx.slice(0, 10).map((i) => new Date(xMs[i]).toISOString()),
        preview: preview(xMs, s.values),
      };
    });

    const xMs0 = series[0].x.map((v) => v * 1000);
    const chart = renderSeriesChart({
      title: `Explore — ${tagIds.slice(0, 3).join(', ')}${tagIds.length > 3 ? ', …' : ''}`,
      x: xMs0,
      series: chartSeries,
    });

    const totalAnoms = perTag.reduce((s, t) => s + t.anomalyCount, 0);
    return {
      ok: true,
      summary:
        `Explored ${perTag.length} tag(s) at ${bin.label} bins; ${totalAnoms} anomaly point(s) flagged. ` +
        perTag.map((t) => `${t.tagId}: mean ${t.stats.mean ?? '—'}, ${t.trend}`).slice(0, 3).join('; ') + '.',
      data: {
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        tags: perTag,
        caveats:
          'Anomalies are unsupervised (series_decompose_anomalies vs a trend+seasonal baseline); ' +
          'they flag statistical outliers, not confirmed faults. Gaps were linearly interpolated. ' +
          'Preview is min/max-downsampled — use series_detail for exact values.',
      },
      chart,
    };
  },
};
