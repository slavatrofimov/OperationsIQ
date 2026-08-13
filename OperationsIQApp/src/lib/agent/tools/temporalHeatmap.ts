/**
 * `temporal_heatmap` — reveal cyclical patterns in one tag by grouping its
 * samples on cyclical timestamp attributes (minute-of-hour, hour-of-day,
 * day-of-week, day-of-month, month) and aggregating each bucket. Crossing two
 * attributes forms a 2-D heatmap (e.g. hour-of-day × day-of-week); a single
 * attribute is a 1-D strip.
 *
 * Seam: chooseBin -> buildBinnedSeriesQuery(fill:false) -> parseExploreRows ->
 * buildAttributeHeatmap -> renderGridHeatmap. All buckets use UTC.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildBinnedSeriesQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseExploreRows } from '../../series';
import { buildAttributeHeatmap, type DateAttribute, type RowAttribute } from '../../heatmapAttributes';
import { renderGridHeatmap } from '../charts';
import { parseWindow, binFor, round } from '../toolUtils';

export interface TemporalHeatmapArgs {
  tagId: string;
  startIso: string;
  endIso: string;
  /** Attribute on the horizontal axis. */
  xAttribute: DateAttribute;
  /** Attribute on the vertical axis, or 'none' for a 1-D strip. */
  yAttribute?: RowAttribute;
  aggregation?: Aggregation;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];
const DATE_ATTRS: DateAttribute[] = ['minute', 'hour', 'dayOfWeek', 'dayOfMonth', 'month'];
const ROW_ATTRS: RowAttribute[] = ['none', 'minute', 'hour', 'dayOfWeek', 'dayOfMonth', 'month'];

export const temporalHeatmapTool: AgentTool<TemporalHeatmapArgs> = {
  name: 'temporal_heatmap',
  readOnly: true,
  description:
    'Surface cyclical/seasonal structure in one tag by grouping its samples on timestamp attributes and ' +
    'aggregating each bucket — e.g. hour-of-day × day-of-week to see daily/weekly rhythms, or a single ' +
    'attribute as a strip. Returns the populated buckets (with the hottest/coldest called out) and a heatmap ' +
    'chart. Attributes: minute, hour, dayOfWeek, dayOfMonth, month (all UTC). Call resolve_tags first. ' +
    'Times are ISO 8601 UTC. For continuous decomposition use decompose_signal.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      xAttribute: { type: 'string', enum: DATE_ATTRS, description: 'Horizontal-axis attribute.' },
      yAttribute: { type: 'string', enum: ROW_ATTRS, default: 'none', description: 'Vertical-axis attribute, or "none" for a strip.' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      maxBins: { type: 'integer', minimum: 10, maximum: 5000 },
    },
    required: ['tagId', 'startIso', 'endIso', 'xAttribute'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required. Call resolve_tags first.');
    const xAttr = args.xAttribute;
    if (!xAttr || !DATE_ATTRS.includes(xAttr)) return toolError('bad_args', `xAttribute must be one of: ${DATE_ATTRS.join(', ')}.`);
    const yAttr: RowAttribute = args.yAttribute ?? 'none';

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    // Use a fine grid (more bins) so the cyclical buckets are well populated.
    const bin = binFor(win.start, win.end, args.maxBins ?? 2000);

    const csl = buildBinnedSeriesQuery({
      tagId,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      fill: false,
      timeseriesRef: ctx.timeseriesRef,
    });
    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const rows = parseExploreRows(table);
    if (rows.length === 0 || rows[0].x.length === 0) return toolError('empty', 'No data in the given window.');

    const detail: [number, number | null][] = rows[0].x.map((s, i) => [s * 1000, rows[0].values[i]]);
    const heat = buildAttributeHeatmap(detail, xAttr, yAttr, args.aggregation ?? 'avg');
    if (heat.cells.length === 0) return toolError('empty', 'No populated buckets — try a wider window or coarser attribute.');

    // Identify the hottest / coldest buckets for the summary.
    let hot = heat.cells[0];
    let cold = heat.cells[0];
    for (const c of heat.cells) {
      if (c[2] > hot[2]) hot = c;
      if (c[2] < cold[2]) cold = c;
    }
    const xCats = heat.xDef.categories;
    const yCats = heat.yCategories;
    const label = (c: [number, number, number]) =>
      yAttr === 'none' ? `${heat.xDef.label} ${xCats[c[0]]}` : `${xCats[c[0]]} / ${yCats[c[1]]}`;

    const chart = renderGridHeatmap({
      title: `Temporal heatmap — ${tagId}`,
      xLabels: xCats,
      yLabels: yCats,
      cells: heat.cells,
      xName: heat.xDef.label,
      yName: heat.yDef?.label,
      min: heat.min,
      max: heat.max,
    });

    return {
      ok: true,
      summary:
        `${tagId} by ${heat.xDef.label}${heat.yDef ? ` × ${heat.yDef.label}` : ''}: ` +
        `hottest ${label(hot)} = ${round(hot[2])}, coldest ${label(cold)} = ${round(cold[2])} ` +
        `(${heat.cells.length} buckets, ${args.aggregation ?? 'avg'}).`,
      data: {
        tagId,
        bin: bin.label,
        xAttribute: xAttr,
        yAttribute: yAttr,
        aggregation: args.aggregation ?? 'avg',
        range: { min: round(heat.min), max: round(heat.max) },
        hottest: { bucket: label(hot), value: round(hot[2]) },
        coldest: { bucket: label(cold), value: round(cold[2]) },
        cells: heat.cells.map((c) => ({
          x: xCats[c[0]],
          y: yAttr === 'none' ? undefined : yCats[c[1]],
          value: round(c[2]),
        })),
        caveats:
          'Buckets aggregate all samples sharing that attribute across the whole window (UTC). A sparse window ' +
          'leaves buckets empty. Aggregation applies within each bucket; "count" reports sample counts.',
      },
      chart,
    };
  },
};
