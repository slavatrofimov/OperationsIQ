/**
 * `analyze_spectrum` — frequency spectrum of one tag via series_fft.
 *
 * Seam: chooseBin -> buildSpectrumQuery -> executeKql -> parseSpectrum. Returns
 * the dominant frequency peaks with their equivalent periods, useful for
 * identifying the rotating / vibration frequency of equipment. The magnitude
 * spectrum is cached under a seriesId for drill-down.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildSpectrumQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseSpectrum } from '../../spectrum';
import { formatDuration } from '../../binningSettings';
import { putSeries } from '../seriesCache';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, round } from '../toolUtils';

export interface AnalyzeSpectrumArgs {
  tagId: string;
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  maxBins?: number;
  maxPeaks?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const analyzeSpectrumTool: AgentTool<AnalyzeSpectrumArgs> = {
  name: 'analyze_spectrum',
  readOnly: true,
  description:
    'Compute the frequency spectrum of one tag with the Fast Fourier Transform (series_fft) and return the ' +
    'dominant frequency peaks with their equivalent periods. Use to find the periodic content of a signal — ' +
    'e.g. the rotating or vibration frequency of a pump or motor, or a hidden cyclic pattern. Call resolve_tags ' +
    'first; times are ISO 8601 UTC. Returns ranked peaks (frequency in Hz, equivalent period, magnitude), a ' +
    'seriesId for the magnitude spectrum, and a chart. Sibling: unlike decompose_signal (which ' +
    'removes one assumed seasonal period) this discovers unknown periodicities across the whole ' +
    'spectrum.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      maxBins: { type: 'integer', minimum: 10, maximum: 4000 },
      maxPeaks: { type: 'integer', minimum: 1, maximum: 20, description: 'How many peaks to return (default 8).' },
    },
    required: ['tagId', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required (call resolve_tags first).');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);

    const csl = buildSpectrumQuery({
      tagId,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });

    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const sp = parseSpectrum(table, (bin.millis / 1000), args.maxPeaks ?? 8);
    if (!sp || sp.bins.length === 0) {
      return toolError('empty', `Not enough data to compute a spectrum for ${tagId} in the given window.`);
    }

    const x = sp.bins.map((b) => b.freqHz);
    const seriesId = putSeries(
      x,
      { magnitude: sp.bins.map((b) => b.magnitude) },
      { kind: 'spectrum', signalId: tagId, binLabel: bin.label, binSeconds: (bin.millis / 1000) },
    );

    const chart = renderSeriesChart({
      title: `Spectrum — ${tagId}`,
      x,
      series: [{ name: 'magnitude', values: sp.bins.map((b) => b.magnitude) }],
    });

    const top = sp.peaks[0];

    return {
      ok: true,
      summary: top
        ? `${tagId}: dominant period ≈ ${formatDuration(top.periodSeconds)} ` +
          `(${top.freqHz.toExponential(2)} Hz), from ${sp.peaks.length} peak(s) over ${sp.n} samples at ${bin.label} bins.`
        : `${tagId}: no dominant spectral peaks over ${sp.n} samples at ${bin.label} bins.`,
      data: {
        seriesId,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        samples: sp.n,
        peaks: sp.peaks.map((b) => ({
          freqHz: round(b.freqHz),
          periodSeconds: round(b.periodSeconds),
          period: formatDuration(b.periodSeconds),
          magnitude: round(b.magnitude),
        })),
        caveats:
          'The frequency axis assumes a uniform sample interval (the chosen bin width); the DC/mean term and ' +
          'the mirror half above the Nyquist frequency are dropped. Peaks are local maxima ranked by magnitude. ' +
          'Coarse bins alias fast cycles — narrow the bin width to resolve higher frequencies.',
      },
      chart,
    };
  },
};
