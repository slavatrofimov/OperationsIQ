/**
 * `detect_discords` — unsupervised shape-anomaly discovery (SAX discords) across
 * one or more tags. A discord is the subsequence most dissimilar from every other
 * subsequence of the same length — a "most unusual shape" detector.
 *
 * Seam: chooseBin -> buildDiscordsQuery -> executeKql -> parseDiscordRows. Discord
 * window indices are mapped back to timestamps using the bin grid (index 0 = start).
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildDiscordsQuery } from '../../kql';
import { executeKql } from '../../eventhouse';
import { parseDiscordRows } from '../../discover';
import { parseWindow, binFor, round } from '../toolUtils';

export interface DetectDiscordsArgs {
  tagIds: string[];
  startIso: string;
  endIso: string;
  /** Subsequence length in bins. Default 16. */
  windowSize?: number;
  /** How many discords per tag. Default 3. */
  numDiscords?: number;
  paaSize?: number;
  alphabetSize?: number;
  maxBins?: number;
}

export const detectDiscordsTool: AgentTool<DetectDiscordsArgs> = {
  name: 'detect_discords',
  readOnly: true,
  description:
    'Discover the most unusual-shaped subsequences (SAX discords) in one or more tags — a shape-based ' +
    'anomaly detector that finds windows unlike any other window of the same length. Use for "find the ' +
    'strangest patterns / rare events" when you care about shape, not just level. Call resolve_tags first; ' +
    'times are ISO 8601 UTC. Returns ranked discords with their time span, nearest-neighbor distance, and ' +
    'SAX word. Complements explore_signals (point anomalies) and monitor_deviation (band breaches).',
  parameters: {
    type: 'object',
    properties: {
      tagIds: { type: 'array', items: { type: 'string' }, description: 'Resolved tag ids (from resolve_tags).' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      windowSize: { type: 'integer', minimum: 4, maximum: 512, default: 16, description: 'Subsequence length in bins.' },
      numDiscords: { type: 'integer', minimum: 1, maximum: 20, default: 3, description: 'Discords to return per tag.' },
      paaSize: { type: 'integer', minimum: 2, maximum: 64, default: 4, description: 'SAX PAA segments (≤ windowSize).' },
      alphabetSize: { type: 'integer', minimum: 3, maximum: 8, default: 5, description: 'SAX alphabet size.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 5000 },
    },
    required: ['tagIds', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagIds = (args.tagIds ?? []).map((t) => String(t).trim()).filter(Boolean);
    if (tagIds.length === 0) return toolError('bad_args', 'tagIds is required (call resolve_tags first).');

    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const bin = binFor(win.start, win.end, args.maxBins);
    const windowSize = Math.trunc(args.windowSize ?? 16);
    const paaSize = Math.min(Math.trunc(args.paaSize ?? 4), windowSize);

    const csl = buildDiscordsQuery({
      tagIds,
      start: win.start,
      end: win.end,
      binKql: bin.kql,
      windowSize,
      numDiscords: Math.trunc(args.numDiscords ?? 3),
      paaSize,
      alphabetSize: Math.trunc(args.alphabetSize ?? 5),
      znormThreshold: 0.01,
      candidateLimit: 512,
      timeseriesRef: ctx.timeseriesRef,
    });

    let rows;
    try {
      const table = await executeKql(csl, ctx.kqlOpts, { signal: ctx.signal });
      rows = parseDiscordRows(table);
    } catch (e) {
      return toolError('tool_error', e instanceof Error ? e.message : String(e));
    }
    if (rows.length === 0) return toolError('empty', 'No discords found (try a larger window or wider range).');

    const startMs = win.start.getTime();
    const stepMs = bin.millis;
    const idxToIso = (i: number) => new Date(startMs + i * stepMs).toISOString();

    const discords = rows.slice(0, 30).map((d) => ({
      tagId: d.seriesId,
      rank: d.rank,
      fromIso: idxToIso(d.startIndex),
      toIso: idxToIso(d.endIndex + 1),
      nnDistance: round(d.nnDistance),
      word: d.word,
    }));

    const byTag = new Map<string, number>();
    for (const d of rows) byTag.set(d.seriesId, (byTag.get(d.seriesId) ?? 0) + 1);

    return {
      ok: true,
      summary:
        `Found ${rows.length} discord(s) across ${byTag.size} tag(s) at ${bin.label} bins (window ${windowSize}). ` +
        `Strongest: ${discords[0].tagId} at ${discords[0].fromIso} (nn-dist ${discords[0].nnDistance}).`,
      data: {
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        windowSize,
        discords,
        discordsTruncated: rows.length > discords.length,
        caveats:
          'Discords rank by nearest-neighbor SAX distance — larger = more unusual shape, but the ranking is ' +
          'relative to this window/range, not an absolute severity. A discord is a rare shape, not a confirmed ' +
          'fault. Window/PAA/alphabet control granularity. Timestamps are derived from the bin grid (index 0 = start).',
      },
    };
  },
};
