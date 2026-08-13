/**
 * `rank_causes` — rank candidate driver tags against a target by lagged
 * cross-correlation, to shortlist plausible root causes and their lead time.
 *
 * Seam: chooseBin -> buildAlignedSeriesQuery -> executeKql -> parseAlignedSeries
 * -> rankCauses / buildCauseEdges / propagationOrder. A candidate that both leads
 * the target and correlates strongly ranks highest.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildAlignedSeriesQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseAlignedSeries } from '../../rootCause';
import { rankCauses, propagationOrder } from '../../rootCause';
import { parseWindow, binFor, round } from '../toolUtils';

export interface RankCausesArgs {
  targetTagId: string;
  candidateTagIds: string[];
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  /** Max lag to search, in bins. Default 12. */
  maxLagBins?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const rankCausesTool: AgentTool<RankCausesArgs> = {
  name: 'rank_causes',
  readOnly: true,
  description:
    'Rank candidate driver tags against a target by lagged cross-correlation, to shortlist plausible ' +
    'root causes and their lead/lag time. Use for "what is driving / leading this signal". Call ' +
    'resolve_tags first for the target and candidates; times are ISO 8601 UTC. Returns each candidate\'s ' +
    'best-lag correlation, whether it leads the target, and a propagation order. This is a correlational ' +
    'screen, not proof of physical causation — see causality_matrix for a predictive (Granger) view.',
  parameters: {
    type: 'object',
    properties: {
      targetTagId: { type: 'string', description: 'The tag whose drivers you want (from resolve_tags).' },
      candidateTagIds: { type: 'array', items: { type: 'string' }, description: 'Candidate driver tag ids.' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      maxLagBins: { type: 'integer', minimum: 1, maximum: 200, default: 12, description: 'Max lead/lag to search, in bins.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['targetTagId', 'candidateTagIds', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const targetTagId = String(args.targetTagId ?? '').trim();
    const candidateTagIds = (args.candidateTagIds ?? []).map((t) => String(t).trim()).filter((t) => t && t !== targetTagId);
    if (!targetTagId) return toolError('bad_args', 'targetTagId is required (call resolve_tags first).');
    if (candidateTagIds.length === 0) return toolError('bad_args', 'Provide at least one candidateTagId distinct from the target.');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);
    const maxLag = Math.trunc(args.maxLagBins ?? 12);

    const csl = buildAlignedSeriesQuery({
      tagIds: [targetTagId, ...candidateTagIds],
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });
    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const aligned = parseAlignedSeries(table);
    const target = aligned.find((s) => s.tagId === targetTagId);
    const candidates = aligned.filter((s) => s.tagId !== targetTagId);
    if (!target || target.v.length === 0) return toolError('empty', `No data for target ${targetTagId} in the given window.`);
    if (candidates.length === 0) return toolError('empty', 'No candidate series returned.');

    const ranked = rankCauses(target.v, candidates, maxLag, (bin.millis / 1000));
    const order = propagationOrder(ranked);

    const causes = ranked.map((c) => ({
      tagId: c.tagId,
      correlation: round(c.correlation),
      strength: round(c.strength),
      lagBins: c.lagBins,
      lagSeconds: c.lagSeconds,
      leads: c.leads,
    }));

    const top = ranked[0];
    return {
      ok: true,
      summary:
        `Ranked ${candidates.length} candidate driver(s) of ${targetTagId} at ${bin.label} bins. ` +
        (top
          ? `Top: ${top.tagId} (r=${round(top.correlation)}, ${top.leads ? `leads by ${top.lagBins} bin(s)` : 'not leading'}).`
          : 'No candidates.'),
      data: {
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        maxLagBins: maxLag,
        target: targetTagId,
        causes,
        propagationOrder: order.map((c) => ({ tagId: c.tagId, lagSeconds: c.lagSeconds, correlation: round(c.correlation) })),
        caveats:
          'Correlation at best lag, over the overlapping finite region (≥25% overlap required). "leads" means ' +
          'the candidate\'s movements precede the target — plausible driver, NOT proof of causation. Confounders ' +
          'and common drivers can inflate correlation. For a predictive test use causality_matrix.',
      },
    };
  },
};
