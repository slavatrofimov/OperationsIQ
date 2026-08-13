import { describe, it, expect, vi } from 'vitest';

// changePoints.ts -> eventhouse.ts pulls in msal/env; stub them so the pure
// parser can be imported headless (mirrors periods.test / robustDeviation.test).
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
import { parseChangePoint } from './changePoints';
import { buildChangePointsQuery } from './kql';

interface Row {
  ts: string[];
  value: (number | null)[];
  lineFit: (number | null)[];
  rSquare: number;
  splitIdx: number;
  variance?: number;
  rVariance?: number;
  leftSlope: number;
  rightSlope: number;
  leftInterception: number;
  rightInterception: number;
}

function cpTable(r: Row): KustoTable {
  return {
    name: 'PrimaryResult',
    columns: [
      { name: 'SignalId', type: 'string' },
      { name: 'Timestamp', type: 'dynamic' },
      { name: 'Value', type: 'dynamic' },
      { name: 'LineFit', type: 'dynamic' },
      { name: 'RSquare', type: 'real' },
      { name: 'SplitIdx', type: 'long' },
      { name: 'Variance', type: 'real' },
      { name: 'RVariance', type: 'real' },
      { name: 'LeftSlope', type: 'real' },
      { name: 'RightSlope', type: 'real' },
      { name: 'LeftInterception', type: 'real' },
      { name: 'RightInterception', type: 'real' },
    ],
    rows: [
      [
        'tag-1',
        r.ts,
        r.value,
        r.lineFit,
        r.rSquare,
        r.splitIdx,
        r.variance ?? 1,
        r.rVariance ?? 0,
        r.leftSlope,
        r.rightSlope,
        r.leftInterception,
        r.rightInterception,
      ],
    ],
  };
}

const TS = [
  '2024-01-01T00:00:00Z',
  '2024-01-01T01:00:00Z',
  '2024-01-01T02:00:00Z',
  '2024-01-01T03:00:00Z',
  '2024-01-01T04:00:00Z',
  '2024-01-01T05:00:00Z',
];

describe('parseChangePoint', () => {
  it('returns null for an empty table', () => {
    const empty: KustoTable = { name: 'PrimaryResult', columns: [], rows: [] };
    expect(parseChangePoint(empty)).toBeNull();
  });

  it('maps the split index onto the shared time axis', () => {
    const cp = parseChangePoint(
      cpTable({
        ts: TS,
        value: [0, 0, 0, 10, 10, 10],
        lineFit: [0, 0, 0, 10, 10, 10],
        rSquare: 0.99,
        splitIdx: 3,
        leftSlope: 0,
        rightSlope: 0,
        leftInterception: 0,
        rightInterception: 10,
      }),
    )!;
    expect(cp).not.toBeNull();
    expect(cp.tagId).toBe('tag-1');
    expect(cp.splitIdx).toBe(3);
    expect(cp.splitTime).toBe(new Date('2024-01-01T03:00:00Z').getTime());
    expect(cp.rSquare).toBeCloseTo(0.99);
  });

  it('classifies a pure jump (equal slopes, offset lines) as a level-shift', () => {
    const cp = parseChangePoint(
      cpTable({
        ts: TS,
        value: [0, 0, 0, 10, 10, 10],
        lineFit: [0, 0, 0, 10, 10, 10],
        rSquare: 0.99,
        splitIdx: 3,
        leftSlope: 0,
        rightSlope: 0,
        leftInterception: 0,
        rightInterception: 10,
      }),
    )!;
    expect(cp.slopeDelta).toBe(0);
    expect(cp.levelShift).toBeCloseTo(10);
    expect(cp.kind).toBe('level-shift');
  });

  it('classifies a trend-rate change (aligned lines, differing slopes) as a slope-break', () => {
    // Left line flat at 0; right line starts at 0 at the break and rises 4/bin.
    // interception is b in y = a·index + b, so right b = -rightSlope·splitIdx.
    const rightSlope = 4;
    const splitIdx = 3;
    const cp = parseChangePoint(
      cpTable({
        ts: TS,
        value: [0, 0, 0, 0, 4, 8],
        lineFit: [0, 0, 0, 0, 4, 8],
        rSquare: 0.98,
        splitIdx,
        leftSlope: 0,
        rightSlope,
        leftInterception: 0,
        rightInterception: -rightSlope * splitIdx,
      }),
    )!;
    expect(cp.levelShift).toBeCloseTo(0);
    expect(cp.slopeDelta).toBeCloseTo(4);
    expect(cp.kind).toBe('slope-break');
  });

  it('reports "none" when the change is negligible relative to spread', () => {
    const cp = parseChangePoint(
      cpTable({
        ts: TS,
        value: [100, 100.1, 99.9, 100.05, 100, 99.95],
        lineFit: [100, 100, 100, 100, 100, 100],
        rSquare: 0.1,
        splitIdx: 3,
        leftSlope: 0,
        rightSlope: 0.0001,
        leftInterception: 100,
        rightInterception: 100,
      }),
    )!;
    expect(cp.kind).toBe('none');
  });

  it('handles an out-of-range split index with a null split time', () => {
    const cp = parseChangePoint(
      cpTable({
        ts: TS,
        value: [1, 2, 3, 4, 5, 6],
        lineFit: [1, 2, 3, 4, 5, 6],
        rSquare: 0.5,
        splitIdx: -1,
        leftSlope: 1,
        rightSlope: 1,
        leftInterception: 1,
        rightInterception: 1,
      }),
    )!;
    expect(cp.splitTime).toBeNull();
  });
});

describe('buildChangePointsQuery', () => {
  it('fits two lines on the gap-filled series and guards the tag literal', () => {
    const q = buildChangePointsQuery({
      tagId: "tag-'; drop",
      start: new Date('2024-01-01T00:00:00Z'),
      end: new Date('2024-01-02T00:00:00Z'),
      binKql: '1h',
    });
    expect(q).toContain('series_fit_2lines(Value)');
    expect(q).toContain('series_fill_linear(Value)');
    expect(q).toContain('project SignalId, Timestamp, Value, LineFit, RSquare, SplitIdx');
    // Single-quote injection is escaped by kqlString.
    expect(q).toContain("where SignalId == 'tag-\\'; drop'");
  });
});
