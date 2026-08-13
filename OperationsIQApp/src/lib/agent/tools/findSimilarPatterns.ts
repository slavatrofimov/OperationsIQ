/**
 * `find_similar_patterns` — 1-D SAX similarity search. Given a query pattern
 * (one tag over a short window), find where a similar shape recurs across one or
 * more search tags over a wider window. Scale-invariant (stretch/shrink) and
 * amplitude-invariant (z-normalized), so it matches *shape*, not absolute level.
 *
 * Seam: chooseBin -> buildSimilarity1dQuery (matches) + buildSegmentSeriesQuery
 * (query samples) + buildSearchSpaceSeriesQuery (search samples) ->
 * parseMatchRows / consolidateMatches, then map match indices to wall-clock time
 * and overlay the query vs. top matches (z-normalized, length-aligned).
 */
import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildSimilarity1dQuery, buildSegmentSeriesQuery, buildSearchSpaceSeriesQuery } from '../../kql';
import { executeKql } from '../../eventhouse';
import {
  parseMatchRows,
  consolidateMatches,
  parseSingleSeries,
  parseSeriesMap,
  sliceInclusive,
  znorm,
  resampleToLength,
} from '../../similarityViz';
import {
  DEFAULT_SIMILARITY_PARAMS,
  computeQueryStats,
  suggestSimilarityParams,
} from '../../similarityHeuristics';
import { renderSeriesChart } from '../charts';
import { parseWindow, binFor, round } from '../toolUtils';

export interface FindSimilarPatternsArgs {
  queryTagId: string;
  queryStartIso: string;
  queryEndIso: string;
  searchTagIds: string[];
  searchStartIso: string;
  searchEndIso: string;
  topK?: number;
  queryLengthSymbols?: number;
  alphabetSize?: number;
  minScale?: number;
  maxScale?: number;
  scaleSteps?: number;
  symbolTolerance?: number;
  znormThreshold?: number;
  maxBins?: number;
}

export const findSimilarPatternsTool: AgentTool<FindSimilarPatternsArgs> = {
  name: 'find_similar_patterns',
  readOnly: true,
  description:
    'Find where a query pattern (one tag over a short window) recurs across one or more search tags over a ' +
    'wider window, using scale- and amplitude-invariant SAX similarity search (matches shape, not absolute ' +
    'level). Returns the top matches with their wall-clock times and similarity/distance scores, plus a chart ' +
    'overlaying the z-normalized query against the best matches. Encoding parameters (queryLengthSymbols, ' +
    'alphabetSize, symbolTolerance, znormThreshold) are auto-tuned from the reviewed query pattern when omitted; ' +
    'pass them explicitly only to override. Call ' +
    'resolve_tags first for both the query and ' +
    'search tags. Times are ISO 8601 UTC. For self-anomalies (unusual sub-sequences) use detect_discords; for ' +
    'clustering whole cycles use segment_cycles.',
  parameters: {
    type: 'object',
    properties: {
      queryTagId: { type: 'string', description: 'Tag whose window defines the pattern to search for.' },
      queryStartIso: { type: 'string', description: 'Query pattern window start (ISO 8601, UTC).' },
      queryEndIso: { type: 'string', description: 'Query pattern window end (ISO 8601, UTC).' },
      searchTagIds: {
        type: 'array',
        description: 'One or more tags to search for the pattern.',
        items: { type: 'string' },
      },
      searchStartIso: { type: 'string', description: 'Search window start (ISO 8601, UTC).' },
      searchEndIso: { type: 'string', description: 'Search window end (ISO 8601, UTC).' },
      topK: { type: 'integer', minimum: 1, maximum: 50, default: 5, description: 'Max matches to return.' },
      queryLengthSymbols: { type: 'integer', minimum: 3, maximum: 32, description: 'SAX symbols encoding the query. Auto-tuned from the query length when omitted (~4 samples per symbol, capped so it never exceeds the shortest matchable window).' },
      alphabetSize: { type: 'integer', minimum: 3, maximum: 8, description: 'SAX alphabet size. Auto-tuned from the query length and variability when omitted (base 4).' },
      minScale: { type: 'number', minimum: 0.1, maximum: 1, default: 0.9, description: 'Smallest time-scale ratio to consider.' },
      maxScale: { type: 'number', minimum: 1, maximum: 10, default: 1.1, description: 'Largest time-scale ratio to consider.' },
      scaleSteps: { type: 'integer', minimum: 1, maximum: 11, default: 3, description: 'Number of scales between min and max.' },
      symbolTolerance: { type: 'integer', minimum: 0, maximum: 4, description: 'Allowed SAX symbol mismatch. Auto-tuned to 0 when omitted, which selects the fast exact matcher; values > 0 use the slower symbolic pre-filter.' },
      znormThreshold: { type: 'number', minimum: 0, maximum: 1, description: 'Z-norm flatness floor in the query\'s data units. Auto-tuned to a small fraction of the query\'s standard deviation when omitted, so it stays scale-relative instead of a fixed value.' },
      maxBins: { type: 'integer', minimum: 10, maximum: 5000 },
    },
    required: ['queryTagId', 'queryStartIso', 'queryEndIso', 'searchTagIds', 'searchStartIso', 'searchEndIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const queryTagId = String(args.queryTagId ?? '').trim();
    if (!queryTagId) return toolError('bad_args', 'queryTagId is required. Call resolve_tags first.');
    const searchTagIds = (args.searchTagIds ?? []).map((t) => String(t).trim()).filter(Boolean);
    if (searchTagIds.length === 0) return toolError('bad_args', 'Provide at least one searchTagId.');

    const qWin = parseWindow(args.queryStartIso, args.queryEndIso);
    if ('error' in qWin) return toolError('bad_args', `Query window: ${qWin.error}`);
    const sWin = parseWindow(args.searchStartIso, args.searchEndIso);
    if ('error' in sWin) return toolError('bad_args', `Search window: ${sWin.error}`);

    // Bin the (wider) search window; the same bin is used for query and search.
    const bin = binFor(sWin.start, sWin.end, args.maxBins);

    // Fetch the query series FIRST so smart defaults can be derived from its
    // actual shape (sample count + raw variability) at the effective resolution.
    // Explicit tool args always override the derived suggestion (back-compat).
    const queryCsl = buildSegmentSeriesQuery({ tagId: queryTagId, start: qWin.start, end: qWin.end, binKql: bin.kql, timeseriesRef: ctx.timeseriesRef });
    const queryTable = await executeKql(queryCsl, ctx.kqlOpts, { signal: ctx.signal });
    const queryValues = parseSingleSeries(queryTable);

    const minScale = args.minScale ?? DEFAULT_SIMILARITY_PARAMS.minScale;
    const suggested = suggestSimilarityParams({
      mode: 'single',
      stats: computeQueryStats(queryValues),
      minScale,
    }).params;

    const params = {
      queryLengthSymbols: Math.trunc(args.queryLengthSymbols ?? suggested.queryLengthSymbols),
      alphabetSize: Math.trunc(args.alphabetSize ?? suggested.alphabetSize),
      minScale,
      maxScale: args.maxScale ?? DEFAULT_SIMILARITY_PARAMS.maxScale,
      scaleSteps: Math.trunc(args.scaleSteps ?? DEFAULT_SIMILARITY_PARAMS.scaleSteps),
      symbolTolerance: Math.trunc(args.symbolTolerance ?? suggested.symbolTolerance),
      topK: Math.trunc(args.topK ?? DEFAULT_SIMILARITY_PARAMS.topK),
      znormThreshold: args.znormThreshold ?? suggested.znormThreshold,
    };

    const searchCsl = buildSimilarity1dQuery({
      queryTagId,
      queryStart: qWin.start,
      queryEnd: qWin.end,
      searchTagIds,
      searchStart: sWin.start,
      searchEnd: sWin.end,
      binKql: bin.kql,
      ...params,
      timeseriesRef: ctx.timeseriesRef,
    });
    const spaceCsl = buildSearchSpaceSeriesQuery({ tagIds: searchTagIds, start: sWin.start, end: sWin.end, binKql: bin.kql, timeseriesRef: ctx.timeseriesRef });

    const [matchesTable, spaceTable] = await Promise.all([
      executeKql(searchCsl, ctx.kqlOpts, { signal: ctx.signal }),
      executeKql(spaceCsl, ctx.kqlOpts, { signal: ctx.signal }),
    ]);

    const matches = consolidateMatches(parseMatchRows(matchesTable)).slice(0, params.topK);
    if (matches.length === 0) return toolError('empty', 'No similar patterns found — try a longer search window, more scale steps, or a higher symbol tolerance.');

    const searchSeries = parseSeriesMap(spaceTable);
    const searchStartMs = sWin.start.getTime();
    const binMs = bin.millis;

    const enriched = matches.map((m, i) => {
      const startMs = searchStartMs + m.startIndex * binMs;
      const endMs = searchStartMs + (m.endIndex + 1) * binMs;
      return {
        rank: i + 1,
        tagId: m.seriesId,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
        durationBins: m.windowSize,
        scale: round(m.scale),
        distance: round(m.distance),
        similarity: round(m.similarity),
      };
    });

    // Overlay the z-normalized query against the top matches, length-aligned.
    const queryLen = queryValues.length || params.queryLengthSymbols;
    const axis = Array.from({ length: queryLen }, (_, i) => i * binMs);
    const overlay: { name: string; values: (number | null)[]; dashed?: boolean }[] = [];
    if (queryValues.length > 0) overlay.push({ name: 'query', values: znorm(queryValues) });
    for (let i = 0; i < Math.min(matches.length, 4); i++) {
      const m = matches[i];
      const full = searchSeries.get(m.seriesId) ?? [];
      const slice = sliceInclusive(full, m.startIndex, m.endIndex);
      if (slice.length === 0) continue;
      overlay.push({ name: `match ${i + 1} (${round(m.similarity)})`, values: resampleToLength(znorm(slice), queryLen), dashed: true });
    }
    const chart = renderSeriesChart({
      title: `Similar patterns — query ${queryTagId}`,
      x: axis,
      series: overlay,
      yName: 'z-normalized',
    });

    const best = enriched[0];
    return {
      ok: true,
      summary:
        `Found ${enriched.length} match(es) for the ${queryTagId} pattern across ${searchTagIds.length} search tag(s) ` +
        `at ${bin.label} bins. Best: ${best.tagId} @ ${best.startIso} (similarity ${best.similarity}, scale ${best.scale}).`,
      data: {
        queryTagId,
        queryWindow: { startIso: qWin.start.toISOString(), endIso: qWin.end.toISOString() },
        searchTagIds,
        searchWindow: { startIso: sWin.start.toISOString(), endIso: sWin.end.toISOString() },
        bin: bin.label,
        binSeconds: (bin.millis / 1000),
        params,
        matches: enriched,
        caveats:
          'Matches are shape-based (z-normalized) and scale-invariant within [minScale, maxScale], so absolute ' +
          'level and amplitude are ignored. Similarity is a SAX-distance-derived score, not a probability. ' +
          'Near-duplicate overlapping hits are consolidated to the strongest per cluster.',
      },
      chart,
    };
  },
};
