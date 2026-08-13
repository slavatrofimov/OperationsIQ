import type { KustoTable } from './eventhouse';

/**
 * One row of `sax_discords` output: the most anomalous (least self-similar)
 * subsequences per series. `startIndex`/`endIndex` are inclusive offsets into
 * the series' binned sample array; `nnDistance` is the distance to the nearest
 * non-overlapping neighbour (higher = more anomalous). Ranked 1 = strongest.
 */
export interface DiscordRow {
  seriesId: string;
  startIndex: number;
  endIndex: number;
  nearestNeighborStart: number;
  nnDistance: number;
  word: string;
  wordFrequency: number;
  rank: number;
}

function indexer(table: KustoTable) {
  const map = new Map(table.columns.map((c, i) => [c.name, i]));
  return (name: string): number => map.get(name) ?? -1;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse the discord-discovery result table into typed, rank-sorted rows. */
export function parseDiscordRows(table: KustoTable): DiscordRow[] {
  const at = indexer(table);
  const iId = at('series_id');
  const iStart = at('start_index');
  const iEnd = at('end_index');
  const iNn = at('nearest_neighbor_start');
  const iDist = at('nn_distance');
  const iWord = at('word');
  const iFreq = at('word_frequency');
  const iRank = at('rank');

  // A stale/mismatched deployed `sax_discords` (e.g. an older schema that
  // predates the start_index/end_index/rank columns) would silently produce
  // rows where these resolve to NaN, which the UI rendered as "#NaN · dist
  // NaN". Fail loudly with an actionable message instead.
  const missing = (
    [
      ['series_id', iId],
      ['start_index', iStart],
      ['end_index', iEnd],
      ['nn_distance', iDist],
      ['rank', iRank],
    ] as const
  )
    .filter(([, idx]) => idx < 0)
    .map(([name]) => name);
  if (table.rows.length > 0 && missing.length > 0) {
    throw new Error(
      `Discord result is missing expected column(s): ${missing.join(', ')}. ` +
        'The deployed sax_discords function is out of date — redeploy the ' +
        'Eventhouse schema (eventhouse/schema/60_sax_discords.kql).',
    );
  }

  return table.rows
    .map((r) => ({
      seriesId: String(r[iId] ?? ''),
      startIndex: Math.round(num(r[iStart])),
      endIndex: Math.round(num(r[iEnd])),
      nearestNeighborStart: iNn >= 0 ? Math.round(num(r[iNn])) : NaN,
      nnDistance: iDist >= 0 ? num(r[iDist]) : NaN,
      word: iWord >= 0 ? String(r[iWord] ?? '') : '',
      wordFrequency: iFreq >= 0 ? Math.round(num(r[iFreq])) : NaN,
      rank: iRank >= 0 ? Math.round(num(r[iRank])) : NaN,
    }))
    // Defensively drop any row whose magnitude or position is non-finite, so a
    // NaN distance can never render as a "#NaN · dist NaN" anomaly badge.
    .filter(
      (d) =>
        Number.isFinite(d.nnDistance) &&
        Number.isFinite(d.rank) &&
        Number.isFinite(d.startIndex) &&
        Number.isFinite(d.endIndex),
    )
    .sort((a, b) => a.rank - b.rank);
}

/** One track (metric) contributing to a multivariate match. */
export interface MultidimTrackMatch {
  trackId: string;
  startIndex: number;
  endIndex: number;
  scale: number;
  queryWord: string;
  candidateWord: string;
  distance: number;
  similarity: number;
  symbolicDistance: number;
}

/**
 * One row of `sax_similarity_search_multidim`: a window in an entity where the
 * multivariate query pattern (all its tracks) recurs. `startIndex`/`endIndex`
 * are inclusive offsets into the entity's binned sample axis.
 */
export interface MultidimRow {
  entityId: string;
  startIndex: number;
  endIndex: number;
  matchedTrackCount: number;
  symbolicScore: number;
  exactScore: number;
  meanDistance: number;
  rankScore: number;
  matchPattern: string;
  candidatePattern: string;
  rank: number;
  trackMatches: MultidimTrackMatch[];
}

/** Parse the multivariate-search result table into typed, rank-sorted rows. */
export function parseMultidimRows(table: KustoTable): MultidimRow[] {
  const at = indexer(table);
  const iEntity = at('entity_id');
  const iStart = at('start_index');
  const iEnd = at('end_index');
  const iCount = at('matched_track_count');
  const iSym = at('symbolic_score');
  const iExact = at('exact_score');
  const iMean = at('mean_distance');
  const iRankScore = at('rank_score');
  const iMatchPat = at('match_pattern');
  const iCandPat = at('candidate_pattern');
  const iRank = at('rank');
  const iTracks = at('track_matches');

  const parseTracks = (v: unknown): MultidimTrackMatch[] => {
    if (!Array.isArray(v)) return [];
    return v.map((t) => {
      const b = (t ?? {}) as Record<string, unknown>;
      return {
        trackId: String(b.track_id ?? ''),
        startIndex: Math.round(num(b.start_index)),
        endIndex: Math.round(num(b.end_index)),
        scale: num(b.scale),
        queryWord: String(b.query_word ?? ''),
        candidateWord: String(b.candidate_word ?? ''),
        distance: num(b.distance),
        similarity: num(b.similarity),
        symbolicDistance: num(b.symbolic_distance),
      };
    });
  };

  return table.rows
    .map((r) => ({
      entityId: String(r[iEntity] ?? ''),
      startIndex: Math.round(num(r[iStart])),
      endIndex: Math.round(num(r[iEnd])),
      matchedTrackCount: iCount >= 0 ? Math.round(num(r[iCount])) : NaN,
      symbolicScore: iSym >= 0 ? num(r[iSym]) : NaN,
      exactScore: iExact >= 0 ? num(r[iExact]) : NaN,
      meanDistance: iMean >= 0 ? num(r[iMean]) : NaN,
      rankScore: iRankScore >= 0 ? num(r[iRankScore]) : NaN,
      matchPattern: iMatchPat >= 0 ? String(r[iMatchPat] ?? '') : '',
      candidatePattern: iCandPat >= 0 ? String(r[iCandPat] ?? '') : '',
      rank: iRank >= 0 ? Math.round(num(r[iRank])) : NaN,
      trackMatches: iTracks >= 0 ? dedupeTrackMatches(parseTracks(r[iTracks])) : [],
    }))
    .sort((a, b) => a.rank - b.rank);
}

/**
 * Collapse a single match's track list to one window per track — the best
 * (highest similarity, tie-broken by lowest distance). The multidim search
 * assembles matches per anchor bucket and can list several survivor windows
 * for the same track inside one match; each participating signal should appear
 * exactly once in the pattern-comparison, track-timeline, and details views.
 */
function dedupeTrackMatches(tracks: MultidimTrackMatch[]): MultidimTrackMatch[] {
  const best = new Map<string, MultidimTrackMatch>();
  for (const t of tracks) {
    const cur = best.get(t.trackId);
    if (
      !cur ||
      t.similarity > cur.similarity ||
      (t.similarity === cur.similarity && t.distance < cur.distance)
    ) {
      best.set(t.trackId, t);
    }
  }
  return [...best.values()];
}

/**
 * Parse a (entity_id, track_id, series) table — as produced by
 * `buildMultidimSearchSeriesQuery` — into a nested map keyed by
 * entity (Station) → track (Metric) → numeric sample array. Sample indices
 * align with the start/end indices carried on each multivariate match.
 */
export function parseEntityTrackSeries(table: KustoTable): Map<string, Map<string, number[]>> {
  const at = indexer(table);
  const iEntity = at('entity_id');
  const iTrack = at('track_id');
  const iSeries = at('series');
  const out = new Map<string, Map<string, number[]>>();
  for (const r of table.rows) {
    const entity = String(r[iEntity] ?? '');
    const track = String(r[iTrack] ?? '');
    const arr = Array.isArray(r[iSeries]) ? (r[iSeries] as unknown[]).map(num) : [];
    let byTrack = out.get(entity);
    if (!byTrack) {
      byTrack = new Map<string, number[]>();
      out.set(entity, byTrack);
    }
    byTrack.set(track, arr);
  }
  return out;
}

