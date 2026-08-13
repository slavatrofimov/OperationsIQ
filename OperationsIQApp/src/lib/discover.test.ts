import { describe, it, expect } from 'vitest';
import { parseMultidimRows } from './discover';
import type { KustoTable } from './eventhouse';

function track(trackId: string, similarity: number, distance: number, startIndex = 0) {
  return {
    track_id: trackId,
    start_index: startIndex,
    end_index: startIndex + 9,
    scale: 1,
    query_word: 'aaa',
    candidate_word: 'aab',
    symbolic_distance: 1,
    distance,
    similarity,
  };
}

function multidimTable(trackMatches: unknown[]): KustoTable {
  return {
    name: 'PrimaryResult',
    columns: [
      { name: 'entity_id', type: 'string' },
      { name: 'start_index', type: 'long' },
      { name: 'end_index', type: 'long' },
      { name: 'matched_track_count', type: 'long' },
      { name: 'symbolic_score', type: 'real' },
      { name: 'exact_score', type: 'real' },
      { name: 'mean_distance', type: 'real' },
      { name: 'rank_score', type: 'real' },
      { name: 'match_pattern', type: 'string' },
      { name: 'candidate_pattern', type: 'string' },
      { name: 'rank', type: 'long' },
      { name: 'track_matches', type: 'dynamic' },
    ],
    rows: [['motor-1', 10, 30, 2, 0.5, 0.6, 0.4, 0.3, 'q', 'c', 1, trackMatches]],
  };
}

describe('parseMultidimRows — track dedupe', () => {
  it('collapses repeated per-track windows to one best window per track', () => {
    const rows = parseMultidimRows(
      multidimTable([
        track('vibration-01', 0.45, 1.25, 0),
        track('vibration-01', 0.63, 0.59, 4), // best for vibration-01
        track('vibration-01', 0.44, 1.31, 8),
        track('temp-02', 0.51, 1.0, 2),
        track('temp-02', 0.51, 0.8, 6), // tie on similarity → lower distance wins
      ]),
    );
    expect(rows).toHaveLength(1);
    const tracks = rows[0].trackMatches;
    expect(tracks).toHaveLength(2);

    const vib = tracks.find((t) => t.trackId === 'vibration-01')!;
    expect(vib.similarity).toBe(0.63);
    expect(vib.distance).toBe(0.59);

    const temp = tracks.find((t) => t.trackId === 'temp-02')!;
    expect(temp.similarity).toBe(0.51);
    expect(temp.distance).toBe(0.8);
  });

  it('leaves an already-unique track list unchanged', () => {
    const rows = parseMultidimRows(
      multidimTable([track('a', 0.9, 0.1, 0), track('b', 0.8, 0.2, 3)]),
    );
    expect(rows[0].trackMatches).toHaveLength(2);
  });
});
