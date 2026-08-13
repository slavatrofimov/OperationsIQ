/**
 * `detect_change_point` — find the single most significant level-shift or
 * slope-break in one tag via series_fit_2lines.
 *
 * Seam: chooseBin -> buildChangePointsQuery -> executeKql -> parseChangePoint.
 * Returns the break time, the kind of change (level shift vs slope break), the
 * split strength (R-square), and the per-side slopes. The value + fitted-line
 * arrays are cached under a seriesId for series_detail drill-down.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildChangePointsQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseChangePoint } from '../../changePoints';
import { putSeries } from '../seriesCache';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, preview, round } from '../toolUtils';

export interface DetectChangePointArgs {
  tagId: string;
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const detectChangePointTool: AgentTool<DetectChangePointArgs> = {
  name: 'detect_change_point',
  readOnly: true,
  description:
    'Detect the single most significant change point in one tag using two-segment linear regression ' +
    '(series_fit_2lines). Use to pinpoint when a signal shifted level or changed its trend rate — e.g. a ' +
    'step after a setpoint change or the onset of drift. Call resolve_tags first; times are ISO 8601 UTC. ' +
    'Returns the break timestamp, change kind (level shift / slope break), split strength (R-square), the ' +
    'left/right slopes and level shift, a preview, a seriesId, and a chart.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
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

    const csl = buildChangePointsQuery({
      tagId,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });

    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const cp = parseChangePoint(table);
    if (!cp || cp.t.length === 0) {
      return toolError('empty', `No data to fit for ${tagId} in the given window.`);
    }

    const seriesId = putSeries(
      cp.t,
      { value: cp.value, fit: cp.lineFit },
      { kind: 'change_point', signalId: tagId, binLabel: bin.label, binSeconds: (bin.millis / 1000) },
    );

    const chart = renderSeriesChart({
      title: `Change point — ${tagId}`,
      x: cp.t,
      series: [
        { name: 'value', values: cp.value },
        { name: 'fit', values: cp.lineFit, dashed: true },
      ],
    });

    const breakIso = cp.splitTime != null ? new Date(cp.splitTime).toISOString() : null;

    return {
      ok: true,
      summary:
        cp.kind === 'none'
          ? `No material change point for ${tagId} (best split R² ${cp.rSquare.toFixed(2)} at ${bin.label} bins).`
          : `${tagId}: ${cp.kind === 'level-shift' ? 'level shift' : cp.kind === 'slope-break' ? 'slope break' : 'level shift + slope break'} ` +
            `near ${breakIso ?? 'unknown time'} (split strength R² ${cp.rSquare.toFixed(2)}); ` +
            `level shift ${round(cp.levelShift) ?? '—'}, slope change ${round(cp.slopeDelta) ?? '—'}/bin.`,
      data: {
        seriesId,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        features: {
          kind: cp.kind,
          rSquare: round(cp.rSquare),
          breakTime: breakIso,
          splitIndex: cp.splitIdx,
          levelShift: round(cp.levelShift),
          slopeDeltaPerBin: round(cp.slopeDelta),
          leftSlopePerBin: round(cp.leftSlope),
          rightSlopePerBin: round(cp.rightSlope),
        },
        preview: preview(cp.t, cp.value),
        caveats:
          'series_fit_2lines returns exactly one break — the split maximizing combined R². A low R² means no ' +
          'clean two-line structure (the "change" may be noise or gradual). Slopes are per bin at the chosen resolution.',
      },
      chart,
    };
  },
};
