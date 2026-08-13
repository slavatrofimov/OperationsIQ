/**
 * `mine_processes` — derive discrete operating states from a signal's value
 * thresholds and mine recurring operational sequences via the KQL `scan`
 * operator.
 *
 * Seam: chooseBin -> buildProcessMiningQuery -> executeKql ->
 * parseProcessMining. Each bin is classified into one of N+1 ordered bands
 * (from N ascending thresholds); scan collapses consecutive same-state bins
 * into episodes; recurring n-grams of consecutive states are counted with
 * median durations. Returns the discovered sequences, per-state dwell stats,
 * and the episode count.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildProcessMiningQuery, type Aggregation } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseProcessMining, validateBandModel } from '../../processMining';
import { parseWindow, binFor, round } from '../toolUtils';

export interface MineProcessesArgs {
  tagId: string;
  startIso: string;
  endIso: string;
  thresholds: number[];
  bandLabels?: string[];
  aggregation?: Aggregation;
  sequenceLength?: number;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

/** Auto-name N+1 bands when the caller omits labels (low/normal/high for the classic 2-threshold case). */
function defaultLabels(count: number): string[] {
  if (count === 3) return ['low', 'normal', 'high'];
  return Array.from({ length: count }, (_, i) => `band ${i + 1}`);
}

export const mineProcessesTool: AgentTool<MineProcessesArgs> = {
  name: 'mine_processes',
  readOnly: true,
  description:
    'Mine operational sequences from one signal by discretizing its values into ordered operating states ' +
    'and using the KQL scan operator to collapse consecutive bins into state episodes. Provide "thresholds" ' +
    '(ascending cut points): N thresholds make N+1 bands, so [20,80] gives 3 bands (low/normal/high) and ' +
    '[5,25,75] gives 4 (e.g. off/idle/run/overload). Optionally name them with "bandLabels" (lowest to ' +
    'highest, one more than thresholds). Use to discover how equipment actually operates — e.g. how often a ' +
    'low->normal->high startup ramp occurs and how long it takes. Call resolve_tags first; times are ISO ' +
    '8601 UTC. Returns the discovered sequences (ordered states, count, median duration), per-state dwell ' +
    'stats, and the total episode count.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      thresholds: {
        type: 'array',
        items: { type: 'number' },
        minItems: 1,
        description: 'Ascending value cut points; N thresholds define N+1 bands.',
      },
      bandLabels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional band names, lowest to highest. Must be one more than thresholds; auto-named if omitted.',
      },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      sequenceLength: {
        type: 'integer',
        minimum: 2,
        maximum: 6,
        default: 3,
        description: 'Number of consecutive states per mined sequence.',
      },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['tagId', 'startIso', 'endIso', 'thresholds'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required (call resolve_tags first).');
    const thresholds = Array.isArray(args.thresholds) ? args.thresholds.map(Number) : [];
    const bandLabels =
      Array.isArray(args.bandLabels) && args.bandLabels.length
        ? args.bandLabels.map((l) => String(l))
        : defaultLabels(thresholds.length + 1);
    const bandError = validateBandModel({ thresholds, labels: bandLabels });
    if (bandError) return toolError('bad_args', bandError);

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);
    const seqLength = Math.min(6, Math.max(2, Math.round(args.sequenceLength ?? 3)));

    const csl = buildProcessMiningQuery({
      tagId,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      aggregation: args.aggregation,
      thresholds,
      bandLabels,
      timeseriesRef: ctx.timeseriesRef,
    });

    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const pm = parseProcessMining(table, (bin.millis / 1000), seqLength, bandLabels);
    if (pm.episodes.length === 0) {
      return toolError('empty', `No data to mine for ${tagId} in the given window.`);
    }

    const top = pm.sequences[0];
    return {
      ok: true,
      summary: top
        ? `${tagId}: ${pm.episodes.length} episodes over ${pm.states.length} states. Top ${seqLength}-state ` +
          `sequence "${top.key}" occurred ${top.count}× (median ${round(top.medianDurationSeconds)}s).`
        : `${tagId}: ${pm.episodes.length} episodes, but no ${seqLength}-state sequence recurred.`,
      data: {
        tagId,
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        bands: bandLabels,
        thresholds,
        episodes: pm.episodes.length,
        states: pm.states,
        stateStats: pm.stateStats.map((s) => ({
          state: s.state,
          episodes: s.episodes,
          totalDurationSeconds: round(s.totalDurationSeconds),
        })),
        sequences: pm.sequences.slice(0, 20).map((s) => ({
          sequence: s.key,
          count: s.count,
          medianDurationSeconds: round(s.medianDurationSeconds),
        })),
        caveats:
          'States are value bands on one signal. Sequences are recurring runs of consecutive states; a high ' +
          'count means a repeatable pattern. Correlating sequences with discrete events (alarms, mode changes) ' +
          'is a future extension.',
      },
    };
  },
};
