/**
 * `monitor_deviation` — expected-vs-actual monitoring for one tag. The anomaly
 * decomposition baseline is the "expected" value; a ±z·σ band around it defines
 * the normal envelope, and bins outside it are grouped into breach runs.
 *
 * Seam: chooseBin -> buildExploreQuery -> executeKql -> parseExploreRows ->
 * computeDeviation. The actual/expected/band tracks are cached for series_detail.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildExploreQuery, buildRobustOutliersQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseExploreRows } from '../../series';
import { computeDeviation } from '../../deviation';
import {
  parseRobustSeries,
  computeRobustDeviation,
  DEFAULT_TUKEY_THRESHOLD,
} from '../../robustDeviation';
import { putSeries } from '../seriesCache';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, preview, round } from '../toolUtils';

export interface MonitorDeviationArgs {
  tagId: string;
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  /** Band confidence (two-sided). Default 0.99. Used by the 'seasonal' detector. */
  confidence?: number;
  /** Detector: 'seasonal' (series_decompose_anomalies) or 'robust' (series_outliers). */
  detector?: 'seasonal' | 'robust';
  /** Tukey score threshold for the robust detector. Default 1.5. */
  sensitivity?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const monitorDeviationTool: AgentTool<MonitorDeviationArgs> = {
  name: 'monitor_deviation',
  readOnly: true,
  description:
    'Monitor one tag against its expected envelope. Two detectors: "seasonal" uses the trend+seasonal ' +
    'baseline ± z·σ (best for periodic signals); "robust" uses Tukey outlier scoring (series_outliers), ' +
    'a model-free option for aperiodic/spiky signals and level shifts. Flags out-of-band bins and groups ' +
    'them into breach runs with peak deviation and direction. Use for "is this signal behaving normally / ' +
    'when did it deviate". Call resolve_tags first; times are ISO 8601 UTC. Returns coverage (% in band), ' +
    'breach list, a preview, a seriesId (series_detail), and a chart. Siblings: unlike control_chart ' +
    '(fixed SPC control limits + run-rules for process stability) this tracks an adaptive expected ' +
    'envelope; use explore_signals for a general first look, and diagnose_anomalies to find what ' +
    'co-varies with the breaches it flags.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      confidence: { type: 'number', minimum: 0.5, maximum: 0.999, default: 0.99, description: 'Band confidence (two-sided), seasonal detector.' },
      detector: { type: 'string', enum: ['seasonal', 'robust'], default: 'seasonal', description: 'seasonal (series_decompose_anomalies) or robust (series_outliers).' },
      sensitivity: { type: 'number', minimum: 0.5, maximum: 6, default: 1.5, description: 'Tukey score threshold for the robust detector.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['tagId', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required (call resolve_tags first).');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const confidence = args.confidence ?? 0.99;
    const detector = args.detector ?? 'seasonal';
    const sensitivity = args.sensitivity ?? DEFAULT_TUKEY_THRESHOLD;
    const bin = binFor(win.start, win.end, args.maxBins);

    let dev;
    if (detector === 'robust') {
      const csl = buildRobustOutliersQuery({
        tagId,
        start: win.start,
        end: win.end,
        binKql: bin.kql,
        aggregation: args.aggregation,
        timeseriesRef: ctx.timeseriesRef,
      });
      const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
      const series = parseRobustSeries(table);
      if (!series || series.x.length === 0) {
        return toolError('empty', `No data for ${tagId} in the given window.`);
      }
      dev = computeRobustDeviation(series, sensitivity);
    } else {
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
      dev = computeDeviation(series[0], confidence);
    }

    const bandLabel =
      detector === 'robust' ? `Tukey |score|>${sensitivity}` : `±${(confidence * 100).toFixed(0)}% band`;
    const seriesId = putSeries(
      dev.x,
      { actual: dev.actual, expected: dev.expected, lower: dev.lower, upper: dev.upper },
      { kind: 'deviation', signalId: tagId, binLabel: bin.label, binSeconds: (bin.millis / 1000) },
    );

    const chart = renderSeriesChart({
      title: `Deviation — ${tagId}`,
      x: dev.x,
      series: [
        { name: 'actual', values: dev.actual },
        { name: 'expected', values: dev.expected, dashed: true },
      ],
      band: { name: bandLabel, lower: dev.lower, upper: dev.upper },
    });

    const breaches = dev.breaches
      .slice(0, 10)
      .map((b) => ({
        fromIso: new Date(b.startMs).toISOString(),
        toIso: new Date(b.endMs).toISOString(),
        direction: b.direction,
        peakDeviation: round(b.peakDeviation),
        peakValue: round(b.peakValue),
      }));

    return {
      ok: true,
      summary:
        `${tagId} (${detector}): ${(dev.pctInBand * 100).toFixed(1)}% of ${dev.evaluated} bins inside the ` +
        `${bandLabel}; ${dev.breaches.length} breach run(s). ` +
        (dev.breaches.length ? `Largest deviation ${round(dev.maxAbsDeviation)}.` : 'No breaches.'),
      data: {
        seriesId,
        detector,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        features: {
          pctInBand: round(dev.pctInBand),
          evaluatedBins: dev.evaluated,
          breachRuns: dev.breaches.length,
          maxAbsDeviation: round(dev.maxAbsDeviation),
          sigma: round(dev.sigma),
          z: round(dev.z),
        },
        breaches,
        breachesTruncated: dev.breaches.length > breaches.length,
        preview: preview(dev.x, dev.actual),
        caveats:
          detector === 'robust'
            ? 'Robust: expected = series median; band = Tukey whisker envelope (series_outliers, ' +
              'custom-Tukey 10/90 IQR). No seasonal model — level shifts are treated as outliers, not baseline. ' +
              'Use series_detail for full arrays.'
            : 'Seasonal: expected = trend+seasonal baseline; band half-width = z·σ where σ is the in-sample ' +
              'residual standard deviation (whole-window fit, so a persistent shift widens σ). Breaches are ' +
              'statistical, not confirmed faults. Use series_detail for full arrays.',
      },
      chart,
    };
  },
};
