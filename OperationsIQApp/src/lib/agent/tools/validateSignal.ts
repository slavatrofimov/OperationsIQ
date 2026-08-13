/**
 * `validate_signal` — cross-check one tag against peer signals with a virtual
 * sensor (a linear fit of the target on its references over a training window),
 * then flag drift/bias/faults in the evaluation window.
 *
 * Seam: chooseBin -> buildAlignedSeriesQuery -> executeKql -> parseAlignedSeries
 * -> validateSignal. Returns a valid/suspect/faulty verdict with the evidence.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildAlignedSeriesQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseAlignedSeries } from '../../rootCause';
import { validateSignal } from '../../signalValidation';
import { putSeries } from '../seriesCache';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, preview, round } from '../toolUtils';

export interface ValidateSignalArgs {
  targetTagId: string;
  referenceTagIds: string[];
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  /** Fraction of the window used to train the virtual sensor. Default 0.5. */
  trainFraction?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const validateSignalTool: AgentTool<ValidateSignalArgs> = {
  name: 'validate_signal',
  readOnly: true,
  description:
    'Validate whether one tag is trustworthy by cross-checking it against peer/reference signals. Fits a ' +
    'virtual sensor (linear estimate of the target from the references) on a training window, then flags ' +
    'bias, drift, and out-of-bounds residuals in the rest — returning a valid/suspect/faulty verdict. Use ' +
    'for "is this sensor healthy / has it drifted". Call resolve_tags first; times are ISO 8601 UTC. Returns ' +
    'the verdict, fit quality, residual features, a seriesId (series_detail), and an actual-vs-estimate chart.',
  parameters: {
    type: 'object',
    properties: {
      targetTagId: { type: 'string', description: 'The tag to validate (from resolve_tags).' },
      referenceTagIds: { type: 'array', items: { type: 'string' }, description: 'Peer/reference tag ids used to estimate the target.' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      trainFraction: { type: 'number', minimum: 0.1, maximum: 0.95, default: 0.5, description: 'Fraction of the window used to train.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['targetTagId', 'referenceTagIds', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const targetTagId = String(args.targetTagId ?? '').trim();
    const referenceTagIds = (args.referenceTagIds ?? []).map((t) => String(t).trim()).filter((t) => t && t !== targetTagId);
    if (!targetTagId) return toolError('bad_args', 'targetTagId is required (call resolve_tags first).');
    if (referenceTagIds.length === 0) return toolError('bad_args', 'Provide at least one referenceTagId distinct from the target.');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);
    const trainFraction = args.trainFraction ?? 0.5;

    const csl = buildAlignedSeriesQuery({
      tagIds: [targetTagId, ...referenceTagIds],
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });
    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const aligned = parseAlignedSeries(table);
    const target = aligned.find((s) => s.tagId === targetTagId);
    const refs = referenceTagIds.map((id) => aligned.find((s) => s.tagId === id)).filter((s): s is NonNullable<typeof s> => !!s);
    if (!target || target.v.length === 0) return toolError('empty', `No data for target ${targetTagId} in the given window.`);
    if (refs.length === 0) return toolError('empty', 'No reference series returned.');

    const report = validateSignal(target, refs, trainFraction);
    if (!report) return toolError('empty', 'Not enough clean overlapping data to fit the virtual sensor.');

    const { series } = report;
    const seriesId = putSeries(
      series.t,
      { actual: series.actual, estimate: series.estimate, residual: series.residual, residualZ: series.residualZ },
      { kind: 'validation', signalId: targetTagId, binLabel: bin.label, binSeconds: (bin.millis / 1000) },
    );

    const chart = renderSeriesChart({
      title: `Validation — ${targetTagId} vs virtual sensor (${report.verdict})`,
      x: series.t,
      series: [
        { name: 'actual', values: series.actual },
        { name: 'estimate', values: series.estimate, dashed: true },
      ],
    });

    return {
      ok: true,
      summary:
        `${targetTagId}: verdict "${report.verdict}" from ${refs.length} reference(s). ` +
        `Train R²=${round(report.fit.r2)}; eval bias ${round(report.bias)}, max |z| ${round(report.maxAbsZ)}, ` +
        `${(report.outOfBoundsFraction * 100).toFixed(1)}% of eval points beyond 3σ.`,
      data: {
        seriesId,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        verdict: report.verdict,
        features: {
          trainR2: round(report.fit.r2),
          trainSigma: round(report.fit.trainSigma),
          bias: round(report.bias),
          maxAbsZ: round(report.maxAbsZ),
          outOfBoundsFraction: round(report.outOfBoundsFraction),
          trainEndIso: new Date(series.t[report.trainEnd] ?? series.t[0]).toISOString(),
          coefficients: report.fit.beta.map(round),
          refOrder: report.fit.refTagIds,
        },
        preview: preview(series.t, series.residual),
        caveats:
          'Verdict thresholds: faulty if max|z|>6 or >10% of eval beyond 3σ or |bias|>2σ; suspect at the milder ' +
          'tier. The estimate is a linear combination of references fit on the training window only, so a shared ' +
          'fault across references can hide a real problem. Use series_detail for full residual arrays.',
      },
      chart,
    };
  },
};
