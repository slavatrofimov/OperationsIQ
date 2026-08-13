/**
 * `diagnose_anomalies` — explain a target signal's anomalous time bins by the
 * operating regimes of candidate driver signals.
 *
 * Seam: chooseBin -> buildAnomalyDiagnosisQuery -> executeKql ->
 * parseAnomalyDiagnosis. The target is flagged bin-by-bin with
 * series_decompose_anomalies; each candidate driver is discretized into a
 * low / normal / high regime per bin; the diffpatterns plugin then finds the
 * regime combinations most over-represented in anomalous bins. Returns a ranked
 * list of contributing factors (hypotheses, not proof of causation).
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildAnomalyDiagnosisQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseAnomalyDiagnosis } from '../../anomalyDiagnosis';
import { parseWindow, binFor, round } from '../toolUtils';

export interface DiagnoseAnomaliesArgs {
  targetTagId: string;
  candidateTagIds: string[];
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  sensitivity?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const diagnoseAnomaliesTool: AgentTool<DiagnoseAnomaliesArgs> = {
  name: 'diagnose_anomalies',
  readOnly: true,
  description:
    'Diagnose which candidate driver signals accompany a target signal being anomalous. The target is ' +
    'flagged bin-by-bin with series_decompose_anomalies, each candidate is discretized into low/normal/high ' +
    'regimes, and the diffpatterns plugin ranks the driver regime combinations most over-represented in ' +
    'anomalous bins versus normal ones. Use after monitor_deviation flags anomalies and you want to know ' +
    'what co-varies with them. Call resolve_tags first; times are ISO 8601 UTC. Returns ranked contributing ' +
    'factors (pattern, anomalous %, normal %, signed contribution) — hypotheses, not proof of causation.',
  parameters: {
    type: 'object',
    properties: {
      targetTagId: { type: 'string', description: 'Resolved target tag id (the signal being anomalous).' },
      candidateTagIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Resolved candidate driver tag ids to test as explanatory regimes.',
      },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      sensitivity: {
        type: 'number',
        minimum: 0.1,
        maximum: 10,
        default: 1.5,
        description: 'series_decompose_anomalies sensitivity (lower flags more bins).',
      },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['targetTagId', 'candidateTagIds', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const targetTagId = String(args.targetTagId ?? '').trim();
    if (!targetTagId) return toolError('bad_args', 'targetTagId is required (call resolve_tags first).');
    const candidateTagIds = (args.candidateTagIds ?? [])
      .map((c) => String(c ?? '').trim())
      .filter((c) => c && c !== targetTagId);
    if (candidateTagIds.length === 0) {
      return toolError('bad_args', 'At least one candidate driver tag id (other than the target) is required.');
    }

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);

    const csl = buildAnomalyDiagnosisQuery({
      targetTagId,
      candidateTagIds,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      sensitivity: args.sensitivity,
      timeseriesRef: ctx.timeseriesRef,
    });

    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const diag = parseAnomalyDiagnosis(table, targetTagId, candidateTagIds);

    if (diag.anomalousBins === 0) {
      return {
        ok: true,
        summary: `No anomalous bins detected for ${targetTagId} at sensitivity ${args.sensitivity ?? 1.5}; nothing to diagnose.`,
        data: { anomalousBins: 0, normalBins: diag.normalBins, factors: [] },
      };
    }

    const top = diag.factors[0];
    const factors = diag.factors.map((f) => ({
      pattern: f.pattern.map((t) => ({ tagId: t.tagId, regime: t.regime })),
      pctAnomalous: round(f.pctAnomalous),
      pctNormal: round(f.pctNormal),
      contribution: round(f.contribution),
    }));

    return {
      ok: true,
      summary: top
        ? `${targetTagId}: ${diag.anomalousBins} anomalous vs ${diag.normalBins} normal bins. ` +
          `Top factor ${top.pattern.map((t) => `${t.tagId}=${t.regime}`).join(' & ')} appears in ` +
          `${top.pctAnomalous.toFixed(0)}% of anomalous vs ${top.pctNormal.toFixed(0)}% of normal bins ` +
          `(+${top.contribution.toFixed(0)} pts).`
        : `${targetTagId}: ${diag.anomalousBins} anomalous bins, but no driver regime pattern differentiates them.`,
      data: {
        targetTagId,
        anomalousBins: diag.anomalousBins,
        normalBins: diag.normalBins,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        factors,
        caveats:
          'Driver regimes are per-bin thresholds (mean ± ½·σ over the window). diffpatterns finds statistical ' +
          'over-representation, not causation — validate top factors against process knowledge. Only candidate ' +
          'signal regimes are tested; event types and asset-hierarchy attributes are a future extension.',
      },
    };
  },
};
