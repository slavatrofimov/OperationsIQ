/**
 * `segment_cycles` — split one tag into fixed-length cycles (e.g. daily), reduce
 * each to a SAX word, and cluster them so recurring operating patterns and odd
 * cycles surface. Answers "how many distinct daily shapes are there, and which
 * days are outliers?".
 *
 * Seam: chooseBin -> buildCycleExtractionQuery -> inline parse of
 * (CycleIndex, CycleStart, series) rows -> toSax per cycle -> clusterCycles.
 *
 * NOTE: k-means uses random initial centroids, so cluster ids/membership can
 * vary slightly between identical calls — surfaced as a caveat.
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildCycleExtractionQuery, type Aggregation } from '../../kql';
import { executeKql, rowsToObjects } from '../../eventhouse';
import { toSax, clusterCycles } from '../../segmentation';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor } from '../toolUtils';

interface CycleRow {
  CycleIndex: number;
  CycleStart: string;
  series: (number | null)[];
}

export interface SegmentCyclesArgs {
  tagId: string;
  startIso: string;
  endIso: string;
  /** Cycle length as a KQL timespan, e.g. '1d', '8h', '1h'. Default '1d'. */
  cycleDuration?: string;
  numClusters?: number;
  paaSize?: number;
  alphabetSize?: number;
  aggregation?: Aggregation;
  maxBins?: number;
}

const AGGREGATIONS: Aggregation[] = ['avg', 'min', 'max', 'sum', 'count'];

export const segmentCyclesTool: AgentTool<SegmentCyclesArgs> = {
  name: 'segment_cycles',
  readOnly: true,
  description:
    'Split one tag into fixed-length cycles (default daily) and cluster them by shape (SAX + k-means) to find ' +
    'recurring operating patterns and outlier cycles. Returns each cluster\'s size, a representative cycle, and ' +
    'the smallest clusters as candidate anomalies. Set cycleDuration to a KQL timespan like "1d", "8h", or "1h". ' +
    'Call resolve_tags first. Times are ISO 8601 UTC. For point anomalies within a series use explore_signals; ' +
    'for repeated sub-sequence motifs use detect_discords.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Resolved tag id (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      cycleDuration: { type: 'string', default: '1d', description: 'Cycle length as a KQL timespan, e.g. "1d", "8h", "1h".' },
      numClusters: { type: 'integer', minimum: 1, maximum: 12, default: 3, description: 'Number of shape clusters (k).' },
      paaSize: { type: 'integer', minimum: 3, maximum: 20, default: 8, description: 'SAX word length (segments per cycle).' },
      alphabetSize: { type: 'integer', minimum: 3, maximum: 8, default: 5, description: 'SAX alphabet size.' },
      aggregation: { type: 'string', enum: AGGREGATIONS, default: 'avg' },
      maxBins: { type: 'integer', minimum: 10, maximum: 2000 },
    },
    required: ['tagId', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required. Call resolve_tags first.');
    const cycleDuration = (args.cycleDuration ?? '1d').trim() || '1d';
    const paaSize = Math.trunc(args.paaSize ?? 8);
    const alphabetSize = Math.trunc(args.alphabetSize ?? 5);
    const k = Math.trunc(args.numClusters ?? 3);

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);

    const csl = buildCycleExtractionQuery({
      tagId,
      start: win.start,
      end: win.end,
      cycleDuration,
      binKql: bin.kql,
      aggregation: args.aggregation,
      timeseriesRef: ctx.timeseriesRef,
    });
    const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
    const rows = rowsToObjects<CycleRow>(table);
    if (rows.length === 0) return toolError('empty', 'No cycles extracted — widen the window or shorten cycleDuration.');

    const cycles = rows
      .map((row) => {
        const series = (row.series ?? []).filter((v): v is number => v != null && Number.isFinite(v));
        return { index: row.CycleIndex, start: new Date(row.CycleStart), series };
      })
      .filter((c) => c.series.length >= paaSize);
    if (cycles.length === 0) return toolError('empty', 'Cycles had too few samples for the chosen paaSize.');
    if (cycles.length < 2) return toolError('empty', 'Need at least two cycles to cluster; widen the window.');

    const seriesLength = cycles[0].series.length;
    const saxCycles = cycles.map((c) => ({ index: c.index, series: c.series, saxWord: toSax(c.series, paaSize, alphabetSize) }));
    const kEff = Math.min(k, cycles.length);
    const clusters = clusterCycles(saxCycles, kEff, alphabetSize, seriesLength);

    const byIndex = new Map(cycles.map((c) => [c.index, c]));
    const enriched = clusters
      .map((cl) => {
        const rep = byIndex.get(cl.centroidIndex);
        return {
          clusterId: cl.clusterId,
          size: cl.members.length,
          representativeCycleIndex: cl.centroidIndex,
          representativeStartIso: rep ? rep.start.toISOString() : undefined,
          memberStartIsos: cl.members.map((idx) => byIndex.get(idx)?.start.toISOString()).filter(Boolean).slice(0, 20),
        };
      })
      .filter((c) => c.size > 0)
      .sort((a, b) => b.size - a.size);

    // Overlay each cluster's representative cycle on a shared relative offset axis.
    const step = bin.millis;
    const maxLen = Math.max(...enriched.map((c) => byIndex.get(c.representativeCycleIndex)?.series.length ?? 0), 1);
    const relAxis = Array.from({ length: maxLen }, (_, i) => i * step);
    const chart = renderSeriesChart({
      title: `Cycle clusters — ${tagId} (${cycleDuration})`,
      x: relAxis,
      series: enriched.map((c) => ({
        name: `cluster ${c.clusterId} (n=${c.size})`,
        values: byIndex.get(c.representativeCycleIndex)?.series ?? [],
      })),
    });

    const smallest = enriched[enriched.length - 1];

    return {
      ok: true,
      summary:
        `${cycles.length} ${cycleDuration} cycles of ${tagId} grouped into ${enriched.length} shape cluster(s). ` +
        `Dominant cluster ${enriched[0].clusterId} has ${enriched[0].size} cycles; smallest cluster ${smallest.clusterId} ` +
        `has ${smallest.size} (candidate outliers).`,
      data: {
        tagId,
        cycleDuration,
        bin: bin.label,
        cycleCount: cycles.length,
        requestedClusters: k,
        effectiveClusters: kEff,
        paaSize,
        alphabetSize,
        clusters: enriched,
        caveats:
          'k-means uses random initial centroids, so cluster ids and exact membership can vary between identical ' +
          'calls (the overall grouping is stable). Cycles with fewer samples than paaSize are dropped. Small ' +
          'clusters are candidate outliers, not confirmed anomalies.',
      },
      chart,
    };
  },
};
