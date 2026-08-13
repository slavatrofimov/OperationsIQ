/**
 * `causality_matrix` — pairwise linear Granger causality across a set of tags.
 *
 * For each ordered pair (source → target) it asks whether the source's recent
 * past improves prediction of the target beyond the target's own past. Seam:
 * chooseBin -> buildAlignedSeriesQuery -> executeKql -> parseAlignedSeries ->
 * buildCausalityMatrix / causalEdges. Returns the score matrix + strongest edges.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildAlignedSeriesQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseAlignedSeries } from '../../rootCause';
import { buildCausalityMatrix, causalEdges } from '../../causality';
import { renderMatrixChart } from '../charts';
import { parseWindow, binFor, round } from '../toolUtils';

export interface CausalityMatrixArgs {
  tagIds: string[];
  startIso: string;
  endIso: string;
  aggregation?: Aggregation;
  /** Number of autoregressive lag terms. Default 3. */
  lag?: number;
  /** Edge inclusion threshold on the Granger score. Default 0.1. */
  edgeThreshold?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const causalityMatrixTool: AgentTool<CausalityMatrixArgs> = {
  name: 'causality_matrix',
  readOnly: true,
  description:
    'Compute the pairwise linear Granger causality matrix over a set of tags: for each source→target ' +
    'pair, how much the source\'s recent past improves prediction of the target beyond the target\'s own ' +
    'past (score in [0,1)). Use for "which signals drive which" across a group. Call resolve_tags first; ' +
    'times are ISO 8601 UTC. Returns the score matrix, the strongest directed edges, and a heatmap. This ' +
    'is a predictive, linear screen — not proof of physical mechanism. Use rank_causes for lead/lag of one target.',
  parameters: {
    type: 'object',
    properties: {
      tagIds: { type: 'array', items: { type: 'string' }, description: 'Resolved tag ids (2–12 recommended).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      lag: { type: 'integer', minimum: 1, maximum: 20, default: 3, description: 'Autoregressive lag terms.' },
      edgeThreshold: { type: 'number', minimum: 0, maximum: 0.99, default: 0.1, description: 'Min score to report an edge.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['tagIds', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagIds = (args.tagIds ?? []).map((t) => String(t).trim()).filter(Boolean);
    const unique = [...new Set(tagIds)];
    if (unique.length < 2) return toolError('bad_args', 'Provide at least two distinct tagIds (call resolve_tags first).');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);
    const lag = Math.trunc(args.lag ?? 3);
    const threshold = args.edgeThreshold ?? 0.1;

    const csl = buildAlignedSeriesQuery({
      tagIds: unique,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });
    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const aligned = parseAlignedSeries(table);
    if (aligned.length < 2) return toolError('empty', 'Fewer than two series returned for the given window.');

    const m = buildCausalityMatrix(aligned, lag);
    const edges = causalEdges(m, threshold);

    const roundedMatrix = m.matrix.map((row) => row.map((v) => round(v)));
    const chart = renderMatrixChart({
      title: `Granger causality (lag ${lag}) — source → target`,
      labels: m.tagIds,
      matrix: m.matrix,
      rowName: 'source',
      colName: 'target',
      min: 0,
      max: 1,
    });

    return {
      ok: true,
      summary:
        `Granger causality over ${m.tagIds.length} tag(s) at ${bin.label} bins (lag ${lag}): ` +
        `${edges.length} edge(s) ≥ ${threshold}. ` +
        (edges[0] ? `Strongest: ${edges[0].source} → ${edges[0].target} (${round(edges[0].score)}).` : 'No strong edges.'),
      data: {
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        lag,
        tagIds: m.tagIds,
        matrix: roundedMatrix,
        edges: edges.slice(0, 30).map((e) => ({ source: e.source, target: e.target, score: round(e.score) })),
        caveats:
          'Score = proportional reduction in residual sum-of-squares from adding the source\'s lags to a linear ' +
          'AR model of the target; matrix[i][j] is tagIds[i] → tagIds[j], diagonal 0. Linear & pairwise only — ' +
          'misses nonlinear and multivariate effects, and predictive precedence is not physical proof.',
      },
      chart,
    };
  },
};
