import { describe, it, expect, vi } from 'vitest';

// processMining.ts -> eventhouse.ts pulls in msal/env; stub them so the pure
// parser can be imported headless (mirrors periods.test / spectrum.test).
vi.mock('./msal', () => ({
  getEventhouseToken: vi.fn(async () => 'fake'),
  EventhouseSignInRequiredError: class extends Error {},
  notifyEventhouseSignInRequired: vi.fn(),
}));
vi.mock('./env', () => ({ env: { eventhouseQueryUri: 'https://c', eventhouseDb: 'db' } }));
vi.mock('./activeConnection', () => ({
  getActiveKqlOpts: () => undefined,
  getActiveProfileId: () => undefined,
  getActiveTimeseriesRef: () => 'Timeseries',
  getActiveTimeseriesIsWide: () => false,
  getActiveSignalIdDelimiter: () => '-',
  getActiveHierarchyRef: () => 'TagHierarchy',
  getActiveMetadataRef: () => 'TagMetadata',
  getActiveEventsRef: () => 'Events',
}));

import type { KustoTable } from './eventhouse';
import {
  parseEpisodes,
  mineSequences,
  summarizeStates,
  parseProcessMining,
  validateBandModel,
  addBand,
  removeBand,
  DEFAULT_BAND_MODEL,
  type Episode,
} from './processMining';
import { buildProcessMiningQuery } from './kql';

function episodeTable(rows: [number, string, string, string, number][]): KustoTable {
  return {
    name: 'PrimaryResult',
    columns: [
      { name: 'SegId', type: 'long' },
      { name: 'State', type: 'string' },
      { name: 'StartTime', type: 'datetime' },
      { name: 'EndTime', type: 'datetime' },
      { name: 'Bins', type: 'long' },
    ],
    rows,
  };
}

const ep = (state: string, durationSeconds: number, start = 0): Episode => ({
  segId: 0,
  state,
  start,
  end: start,
  bins: 1,
  durationSeconds,
});

describe('parseEpisodes', () => {
  it('parses rows and computes duration as span + one bin', () => {
    // 60s bins. Episode spans 00:00 -> 00:02 (120s span) => 120 + 60 = 180s.
    const table = episodeTable([
      [0, 'low', '2024-01-01T00:00:00Z', '2024-01-01T00:02:00Z', 3],
      [1, 'high', '2024-01-01T00:03:00Z', '2024-01-01T00:03:00Z', 1],
    ]);
    const eps = parseEpisodes(table, 60);
    expect(eps).toHaveLength(2);
    expect(eps[0].state).toBe('low');
    expect(eps[0].durationSeconds).toBe(180);
    // single-bin episode still has a positive (one-bin) duration.
    expect(eps[1].durationSeconds).toBe(60);
  });

  it('sorts episodes by start time', () => {
    const table = episodeTable([
      [1, 'high', '2024-01-01T01:00:00Z', '2024-01-01T01:00:00Z', 1],
      [0, 'low', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 1],
    ]);
    const eps = parseEpisodes(table, 60);
    expect(eps.map((e) => e.state)).toEqual(['low', 'high']);
  });
});

describe('mineSequences', () => {
  it('finds recurring n-grams with counts and median durations', () => {
    // Pattern low,normal,high repeated twice, plus a trailing normal.
    const eps = [
      ep('low', 10),
      ep('normal', 20),
      ep('high', 30),
      ep('low', 10),
      ep('normal', 20),
      ep('high', 40),
      ep('normal', 5),
    ];
    const seqs = mineSequences(eps, 3);
    const top = seqs[0];
    expect(top.key).toBe('low > normal > high');
    expect(top.count).toBe(2);
    // window durations: (10+20+30)=60 and (10+20+40)=70 => median 65.
    expect(top.medianDurationSeconds).toBe(65);
  });

  it('returns nothing when there are fewer episodes than the window', () => {
    expect(mineSequences([ep('low', 1), ep('high', 1)], 3)).toEqual([]);
    expect(mineSequences([ep('low', 1)], 2)).toEqual([]);
  });

  it('ranks by count then duration', () => {
    const eps = [
      ep('a', 1),
      ep('b', 1),
      ep('a', 1),
      ep('b', 1),
      ep('c', 1),
      ep('d', 1),
    ];
    const seqs = mineSequences(eps, 2);
    // a>b occurs twice; others once. a>b must rank first.
    expect(seqs[0].key).toBe('a > b');
    expect(seqs[0].count).toBe(2);
  });
});

describe('summarizeStates', () => {
  it('aggregates episode counts and dwell per state in canonical order', () => {
    const stats = summarizeStates([
      ep('high', 30),
      ep('low', 10),
      ep('low', 20),
      ep('normal', 5),
    ]);
    expect(stats.map((s) => s.state)).toEqual(['low', 'normal', 'high']);
    const low = stats.find((s) => s.state === 'low')!;
    expect(low.episodes).toBe(2);
    expect(low.totalDurationSeconds).toBe(30);
  });
});

describe('parseProcessMining', () => {
  it('produces episodes, sequences, and states end to end', () => {
    const table = episodeTable([
      [0, 'low', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 1],
      [1, 'normal', '2024-01-01T00:01:00Z', '2024-01-01T00:01:00Z', 1],
      [2, 'high', '2024-01-01T00:02:00Z', '2024-01-01T00:02:00Z', 1],
    ]);
    const pm = parseProcessMining(table, 60, 3);
    expect(pm.episodes).toHaveLength(3);
    expect(pm.states).toEqual(['low', 'normal', 'high']);
    expect(pm.sequences[0].key).toBe('low > normal > high');
    expect(pm.sequenceLength).toBe(3);
  });

  it('orders states by the supplied band order', () => {
    const table = episodeTable([
      [0, 'run', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 1],
      [1, 'off', '2024-01-01T00:01:00Z', '2024-01-01T00:01:00Z', 1],
      [2, 'idle', '2024-01-01T00:02:00Z', '2024-01-01T00:02:00Z', 1],
    ]);
    const pm = parseProcessMining(table, 60, 3, ['off', 'idle', 'run']);
    expect(pm.states).toEqual(['off', 'idle', 'run']);
    expect(pm.stateStats.map((s) => s.state)).toEqual(['off', 'idle', 'run']);
  });
});

describe('buildProcessMiningQuery', () => {
  const base = {
    tagId: 'reactor-1',
    start: new Date('2024-01-01T00:00:00Z'),
    end: new Date('2024-01-02T00:00:00Z'),
    binKql: '5m',
    thresholds: [10, 90],
    bandLabels: ['low', 'normal', 'high'],
  };

  it('classifies states by threshold and guards the literals', () => {
    const q = buildProcessMiningQuery(base);
    expect(q).toContain("where SignalId == 'reactor-1'");
    expect(q).toContain("State = case(V >= 90, 'high', V >= 10, 'normal', 'low')");
  });

  it('uses the scan operator to segment consecutive states', () => {
    const q = buildProcessMiningQuery(base);
    expect(q).toContain('| sort by Timestamp asc');
    expect(q).toContain('scan declare (SegId: long = 0, PrevState: string = \'\')');
    expect(q).toContain('SegId = iff(isempty(s.PrevState) or State == s.PrevState, s.SegId, s.SegId + 1)');
  });

  it('summarizes one row per episode ordered by start', () => {
    const q = buildProcessMiningQuery(base);
    expect(q).toContain('summarize StartTime = min(Timestamp), EndTime = max(Timestamp), Bins = count() by SegId, State');
    expect(q).toContain('order by StartTime asc');
  });

  it('supports decimal thresholds', () => {
    const q = buildProcessMiningQuery({ ...base, thresholds: [12.5, 87.25] });
    expect(q).toContain("State = case(V >= 87.25, 'high', V >= 12.5, 'normal', 'low')");
  });

  it('builds N+1 labeled bands from N thresholds', () => {
    const q = buildProcessMiningQuery({
      ...base,
      thresholds: [5, 25, 75],
      bandLabels: ['off', 'idle', 'run', 'overload'],
    });
    expect(q).toContain(
      "State = case(V >= 75, 'overload', V >= 25, 'run', V >= 5, 'idle', 'off')",
    );
  });

  it('escapes band labels through the injection guard', () => {
    const q = buildProcessMiningQuery({
      ...base,
      thresholds: [50],
      bandLabels: ["o'ff", 'on'],
    });
    expect(q).toContain("V >= 50, 'on', 'o\\'ff'");
  });

  it('rejects a mismatched threshold/label count', () => {
    expect(() => buildProcessMiningQuery({ ...base, thresholds: [10], bandLabels: ['low', 'normal', 'high'] })).toThrow();
  });

  it('rejects non-ascending thresholds', () => {
    expect(() =>
      buildProcessMiningQuery({ ...base, thresholds: [90, 10], bandLabels: ['low', 'normal', 'high'] }),
    ).toThrow();
  });
});

describe('band model helpers', () => {
  it('accepts a well-formed model and the default', () => {
    expect(validateBandModel(DEFAULT_BAND_MODEL)).toBeNull();
    expect(validateBandModel({ thresholds: [5, 25, 75], labels: ['off', 'idle', 'run', 'overload'] })).toBeNull();
  });

  it('rejects malformed models with a message', () => {
    expect(validateBandModel({ thresholds: [], labels: ['only'] })).toMatch(/at least two/i);
    expect(validateBandModel({ thresholds: [10], labels: ['a', 'b', 'c'] })).toMatch(/threshold/i);
    expect(validateBandModel({ thresholds: [10], labels: ['a', ' '] })).toMatch(/name/i);
    expect(validateBandModel({ thresholds: [10], labels: ['dup', 'DUP'] })).toMatch(/unique/i);
    expect(validateBandModel({ thresholds: [50, 20], labels: ['a', 'b', 'c'] })).toMatch(/increase/i);
  });

  it('addBand appends a higher band using the last gap', () => {
    const m = addBand({ thresholds: [20, 80], labels: ['low', 'normal', 'high'] });
    expect(m.thresholds).toEqual([20, 80, 140]);
    expect(m.labels).toHaveLength(4);
  });

  it('removeBand drops the bordering threshold and keeps >= 2 bands', () => {
    const m = { thresholds: [20, 80], labels: ['low', 'normal', 'high'] };
    // remove the top band -> drops the upper threshold
    expect(removeBand(m, 2)).toEqual({ thresholds: [20], labels: ['low', 'normal'] });
    // remove the lowest band -> drops the lowest threshold
    expect(removeBand(m, 0)).toEqual({ thresholds: [80], labels: ['normal', 'high'] });
    // refuses to go below two bands
    const two = { thresholds: [50], labels: ['low', 'high'] };
    expect(removeBand(two, 0)).toBe(two);
  });
});
