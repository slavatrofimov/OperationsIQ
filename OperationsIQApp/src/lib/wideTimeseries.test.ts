import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the active-connection singleton (transitively pulls eventhouse/msal/env)
// so the pure builders run headless. The wide-binding tests drive behaviour by
// passing an explicit `wide` config + scope into withTimeseriesRef; the probe
// tests instead toggle `isWideFn` (the wide probes read the getter directly).
// `vi.hoisted` guarantees it exists before the hoisted vi.mock factories run.
const { isWideFn } = vi.hoisted(() => ({ isWideFn: vi.fn((): boolean => false) }));
vi.mock('./activeConnection', () => ({
  getActiveKqlOpts: () => undefined,
  getActiveProfileId: () => undefined,
  getActiveTimeseriesRef: () => 'Timeseries',
  getActiveTimeseriesIsWide: () => isWideFn(),
  getActiveSignalIdDelimiter: () => '-',
  getActiveHierarchyRef: () => 'TagHierarchy',
  getActiveMetadataRef: () => 'TagMetadata',
  getActiveEventsRef: () => 'Events',
}));

// Offset is controlled per-test so we can exercise the tz-shift branch.
const offsetMinutes = vi.fn((): number => 0);
vi.mock('./queryTimezone', () => ({
  getQueryOffsetMinutes: () => offsetMinutes(),
}));

import {
  deriveWideColumns,
  withTimeseriesRef,
  vsmTrainingScope,
  buildMaxTagCountQuery,
  buildCoverageQuery,
  buildBinnedMultiSeriesQuery,
  buildExploreQuery,
} from './kql';

const start = new Date('2024-01-01T00:00:00Z');
const end = new Date('2024-01-02T00:00:00Z');

beforeEach(() => {
  offsetMinutes.mockReturnValue(0);
  isWideFn.mockReturnValue(false);
});

describe('deriveWideColumns', () => {
  it('splits each SignalId into prefix + column on the first delimiter', () => {
    const { prefixes, columns } = deriveWideColumns(['Pump7-Temp', 'Pump7-Press'], '-');
    expect(prefixes).toEqual(['Pump7']);
    expect(columns).toEqual(['Temp', 'Press']);
  });

  it('returns distinct prefixes and columns', () => {
    const { prefixes, columns } = deriveWideColumns(
      ['A-Temp', 'A-Press', 'B-Temp'],
      '-',
    );
    expect(prefixes).toEqual(['A', 'B']);
    expect(columns).toEqual(['Temp', 'Press']);
  });

  it('splits only on the FIRST delimiter occurrence (column may contain none)', () => {
    // Delimiter is chosen absent from prefixes/columns, but a multi-part column
    // after the first delimiter must be preserved verbatim.
    const { prefixes, columns } = deriveWideColumns(['Asset::Flow Rate'], '::');
    expect(prefixes).toEqual(['Asset']);
    expect(columns).toEqual(['Flow Rate']);
  });

  it('supports a multi-character delimiter', () => {
    const { prefixes, columns } = deriveWideColumns(['P7~|~Temp'], '~|~');
    expect(prefixes).toEqual(['P7']);
    expect(columns).toEqual(['Temp']);
  });

  it('throws when a SignalId lacks the delimiter', () => {
    expect(() => deriveWideColumns(['NoDelimiterHere'], '-')).toThrow(/does not contain/);
  });

  it('throws when the delimiter is empty', () => {
    expect(() => deriveWideColumns(['A-B'], '')).toThrow(/delimiter is required/);
  });
});

describe('withTimeseriesRef — wide binding', () => {
  const wide = { isWide: true, delimiter: '-' };

  it('throws when no bounded signal scope is supplied (guardrail)', () => {
    expect(() => withTimeseriesRef('Timeseries', 'WideBase', undefined, wide)).toThrow(
      /explicit, bounded signal selection/,
    );
    expect(() =>
      withTimeseriesRef('Timeseries', 'WideBase', { signalIds: [], start, end }, wide),
    ).toThrow(/explicit, bounded signal selection/);
  });

  it('builds a let Timeseries binding that unpivots only in-scope columns', () => {
    const scope = { signalIds: ['Pump7-Temp', 'Pump7-Press'], start, end };
    const csl = withTimeseriesRef('Timeseries | take 10', 'WideBase', scope, wide);

    expect(csl).toContain('let Timeseries = (');
    // Base bound to an intermediate name (avoids the materialize double-paren
    // parse error and a self-reference when the base reads a `Timeseries` table).
    expect(csl).toContain('let _TimeseriesBase = (');
    // Early prefix pre-filter.
    expect(csl).toContain("where SignalIdPrefix in (dynamic(['Pump7']))");
    // Early time-window pre-filter.
    expect(csl).toContain('where Timestamp between (datetime(2024-01-01T00:00:00.000Z)');
    // materialize the filtered base once, over the intermediate (canonical form).
    expect(csl).toContain('let _wb = materialize(');
    expect(csl).toContain('materialize(\n  _TimeseriesBase');
    // No fragile double-paren inside materialize.
    expect(csl).not.toContain('materialize((');
    // Early projection: keep only fixed cols + the distinct in-scope value cols,
    // so unused value columns never enter the materialized set.
    expect(csl).toContain("| project SignalIdPrefix, Timestamp, ['Temp'], ['Press']");
    // One union leg per distinct column, each projecting the canonical SignalId.
    expect(csl).toContain(
      "SignalId = strcat(SignalIdPrefix, '-', 'Temp'), Value = toreal(['Temp'])",
    );
    expect(csl).toContain(
      "SignalId = strcat(SignalIdPrefix, '-', 'Press'), Value = toreal(['Press'])",
    );
    // Final exact signal filter.
    expect(csl).toContain(
      "where SignalId in (dynamic(['Pump7-Temp', 'Pump7-Press']))",
    );
    // Downstream csl is appended after the binding.
    expect(csl.trimEnd().endsWith('Timeseries | take 10')).toBe(true);
  });

  it('emits exactly one union leg per DISTINCT column even with many signals', () => {
    const scope = {
      signalIds: ['A-Temp', 'B-Temp', 'C-Temp', 'A-Press'],
      start,
      end,
    };
    const csl = withTimeseriesRef('Timeseries', 'WideBase', scope, wide);
    const tempLegs = csl.match(/toreal\(\['Temp'\]\)/g) ?? [];
    const pressLegs = csl.match(/toreal\(\['Press'\]\)/g) ?? [];
    expect(tempLegs).toHaveLength(1);
    expect(pressLegs).toHaveLength(1);
    // All three prefixes pre-filtered.
    expect(csl).toContain("where SignalIdPrefix in (dynamic(['A', 'B', 'C']))");
  });

  it('projects only the in-scope value columns into the materialized set', () => {
    // 5-column wide base, but only 3 columns are referenced by the scope.
    const base =
      'AssetTelemetry | project SignalIdPrefix=AssetId, Timestamp, Temperature, Pressure, FlowRate, Vibration, Rpm';
    const scope = {
      signalIds: ['Pump7-Temperature', 'Pump7-Pressure', 'Compressor3-Vibration'],
      start,
      end,
    };
    const csl = withTimeseriesRef('Timeseries', base, scope, wide);
    expect(csl).toContain(
      "| project SignalIdPrefix, Timestamp, ['Temperature'], ['Pressure'], ['Vibration']",
    );
    // Out-of-scope value columns are dropped before materialize (they only appear
    // once, inside the user's base query — never in a project/unpivot leg).
    expect((csl.match(/FlowRate/g) ?? [])).toHaveLength(1);
    expect((csl.match(/Rpm/g) ?? [])).toHaveLength(1);
  });

  it('emits balanced parentheses across the whole binding (regression: materialize double-paren)', () => {
    const scope = {
      signalIds: ['pressure-01-Upper', 'temperature-01-Upper', 'flow-01-Upper'],
      start,
      end,
    };
    const base =
      'Timeseries | project SignalIdPrefix=TagId, Timestamp = Timestamp, Upper = Value, Lower = Value * 0.5';
    const csl = withTimeseriesRef(
      'Timeseries | where SignalId in (dynamic([])) | summarize count()',
      base,
      scope,
      wide,
    );
    let depth = 0;
    for (const ch of csl) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(csl).not.toContain('materialize((');
  });

  it('applies the time filter BEFORE the tz shift when offset != 0 (index pushdown)', () => {
    offsetMinutes.mockReturnValue(60);
    const scope = { signalIds: ['P-Temp', 'P-Press'], start, end };
    const csl = withTimeseriesRef('Timeseries', 'WideBase', scope, wide);
    const shiftIdx = csl.indexOf("datetime_add('minute', 60, Timestamp)");
    const filterIdx = csl.indexOf('where Timestamp between');
    expect(shiftIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(-1);
    // Filter the raw, indexed source column first...
    expect(filterIdx).toBeLessThan(shiftIdx);
    // ...using RAW UTC bounds (not shifted by +60m), since they are compared
    // against the source's unshifted Timestamp.
    expect(csl).toContain(
      'where Timestamp between (datetime(2024-01-01T00:00:00.000Z) .. datetime(2024-01-02T00:00:00.000Z))',
    );
  });

  it('does not emit a tz shift when offset is 0', () => {
    const scope = { signalIds: ['P-Temp', 'P-Press'], start, end };
    const csl = withTimeseriesRef('Timeseries', 'WideBase', scope, wide);
    expect(csl).not.toContain('datetime_add');
  });
});

describe('withTimeseriesRef — wide pre-aggregation', () => {
  const wide = { isWide: true, delimiter: '-' };

  it('bins the materialized subset with summarize + bin_at instead of a bare project', () => {
    const scope = { signalIds: ['Pump7-Temp', 'Pump7-Press'], start, end };
    const csl = withTimeseriesRef('Timeseries', 'WideBase', scope, wide, {
      binKql: '900000ms',
      aggregation: 'avg',
    });
    // Pre-aggregation replaces the raw column projection with an early summarize
    // that bins to the downstream grain, anchored to the window start via bin_at.
    expect(csl).toContain(
      "| summarize ['Temp'] = avg(['Temp']), ['Press'] = avg(['Press']) by SignalIdPrefix, " +
        'Timestamp = bin_at(Timestamp, 900000ms, datetime(2024-01-01T00:00:00.000Z))',
    );
    // The raw pass-through projection is no longer emitted for the value columns.
    expect(csl).not.toContain("| project SignalIdPrefix, Timestamp, ['Temp'], ['Press']");
    // Still materialized, and the union legs still read the (now aggregated) columns.
    expect(csl).toContain('let _wb = materialize(');
    expect(csl).toContain("SignalId = strcat(SignalIdPrefix, '-', 'Temp'), Value = toreal(['Temp'])");
  });

  it('uses the requested aggregation for every in-scope value column', () => {
    const scope = { signalIds: ['A-Temp', 'B-Press'], start, end };
    const csl = withTimeseriesRef('Timeseries', 'WideBase', scope, wide, {
      binKql: '1h',
      aggregation: 'max',
    });
    expect(csl).toContain("['Temp'] = max(['Temp'])");
    expect(csl).toContain("['Press'] = max(['Press'])");
  });

  it('anchors bin_at to the (tz-shifted) window start so pre-bins align with make-series', () => {
    offsetMinutes.mockReturnValue(60);
    const scope = { signalIds: ['P-Temp'], start, end };
    const csl = withTimeseriesRef('Timeseries', 'WideBase', scope, wide, {
      binKql: '1h',
      aggregation: 'avg',
    });
    // The shifted window start (kqlDatetime shifts literals by +offset) is the
    // fixed point, matching the shifted Timestamp column and the downstream grid.
    expect(csl).toContain('bin_at(Timestamp, 1h, datetime(2024-01-01T01:00:00.000Z))');
    // Shift still precedes the summarize.
    const shiftIdx = csl.indexOf("datetime_add('minute', 60, Timestamp)");
    const summarizeIdx = csl.indexOf('| summarize');
    expect(shiftIdx).toBeGreaterThan(-1);
    expect(shiftIdx).toBeLessThan(summarizeIdx);
  });

  it('falls back to a raw projection when the aggregation is count (not preservable)', () => {
    const scope = { signalIds: ['A-Temp', 'A-Press'], start, end };
    const csl = withTimeseriesRef('Timeseries', 'WideBase', scope, wide, {
      binKql: '1h',
      aggregation: 'count',
    });
    expect(csl).not.toContain('| summarize');
    expect(csl).not.toContain('bin_at');
    expect(csl).toContain("| project SignalIdPrefix, Timestamp, ['Temp'], ['Press']");
  });

  it('keeps parentheses balanced with the pre-aggregation summarize', () => {
    const scope = { signalIds: ['A-Temp', 'B-Press', 'C-Flow'], start, end };
    const csl = withTimeseriesRef('T | count', 'WideBase', scope, wide, {
      binKql: '5m',
      aggregation: 'avg',
    });
    let depth = 0;
    for (const ch of csl) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});

describe('adaptive-binned builders — wide pre-aggregation wiring', () => {
  beforeEach(() => {
    isWideFn.mockReturnValue(true);
  });

  it('buildBinnedMultiSeriesQuery pre-bins the wide subset at its make-series grain', () => {
    const kql = buildBinnedMultiSeriesQuery({
      tagIds: ['Pump7-Temp', 'Compressor3-Press'],
      start,
      end,
      binKql: '900000ms',
      aggregation: 'avg',
      timeseriesRef: 'AssetTelemetry | project SignalIdPrefix=AssetId, Timestamp, Temp, Press',
    });
    expect(kql).toContain('| summarize');
    expect(kql).toContain('bin_at(Timestamp, 900000ms, datetime(2024-01-01T00:00:00.000Z))');
    // The downstream make-series still runs at the same step over the pre-binned set.
    expect(kql).toContain('step 900000ms by SignalId');
  });

  it('buildExploreQuery pre-bins with the chosen aggregation', () => {
    const kql = buildExploreQuery({
      tagIds: ['Pump7-Temp'],
      start,
      end,
      binKql: '1h',
      aggregation: 'min',
      timeseriesRef: 'AssetTelemetry | project SignalIdPrefix=AssetId, Timestamp, Temp',
    });
    expect(kql).toContain("['Temp'] = min(['Temp'])");
    expect(kql).toContain('bin_at(Timestamp, 1h, datetime(2024-01-01T00:00:00.000Z))');
  });
});

describe('withTimeseriesRef — narrow regression', () => {
  it('returns the csl unchanged when ref is the raw Timeseries table and offset is 0', () => {
    const csl = withTimeseriesRef('Timeseries | take 5', 'Timeseries');
    expect(csl).toBe('Timeseries | take 5');
  });

  it('wraps a non-trivial ref in a let binding (narrow)', () => {
    const csl = withTimeseriesRef('Timeseries | take 5', 'RawTs | project SignalId, Timestamp, Value');
    expect(csl.startsWith('let Timeseries = (')).toBe(true);
    expect(csl).toContain('RawTs | project SignalId, Timestamp, Value');
  });
});

describe('vsmTrainingScope', () => {
  it('derives distinct tag ids and the spanning window from examples', () => {
    const scope = vsmTrainingScope([
      { classLabel: 'a', tagId: 'T1', start: new Date('2024-01-02T00:00:00Z'), end: new Date('2024-01-03T00:00:00Z') },
      { classLabel: 'b', tagId: 'T2', start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-01-02T12:00:00Z') },
      { classLabel: 'a', tagId: 'T1', start: new Date('2024-01-04T00:00:00Z'), end: new Date('2024-01-05T00:00:00Z') },
    ]);
    expect(scope.signalIds).toEqual(['T1', 'T2']);
    expect(scope.start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(scope.end.toISOString()).toBe('2024-01-05T00:00:00.000Z');
  });
});

describe('buildMaxTagCountQuery — wide profile (pre-unpivot count)', () => {
  const opts = { tagIds: ['Pump7-Temp', 'Pump7-Press', 'Comp3-Vibration'], start, end };

  it('narrow: routes through the canonical Timeseries binding and counts by SignalId', () => {
    isWideFn.mockReturnValue(false);
    const csl = buildMaxTagCountQuery(opts);
    expect(csl).toContain('| summarize Cnt = count() by SignalId\n');
    expect(csl).not.toContain('SignalIdPrefix');
  });

  it('wide: counts rows per prefix on the wide base — no materialize, no unpivot', () => {
    isWideFn.mockReturnValue(true);
    const csl = buildMaxTagCountQuery(opts);
    expect(csl).toContain('| summarize Cnt = count() by SignalIdPrefix');
    expect(csl).toContain('| summarize MaxTagCount = max(Cnt)');
    expect(csl).toContain('| where SignalIdPrefix in (');
    expect(csl).toContain('Pump7');
    expect(csl).toContain('Comp3');
    // The whole point: raw rows are never materialized or unpivoted here.
    expect(csl).not.toContain('materialize');
    expect(csl).not.toContain('union');
    expect(csl).not.toContain('toreal(');
  });

  it('wide: applies the time filter BEFORE the tz shift when offset != 0', () => {
    isWideFn.mockReturnValue(true);
    offsetMinutes.mockReturnValue(90);
    const csl = buildMaxTagCountQuery(opts);
    const shiftIdx = csl.indexOf("datetime_add('minute', 90, Timestamp)");
    const filterIdx = csl.indexOf('where Timestamp between');
    expect(shiftIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeLessThan(shiftIdx);
  });
});

describe('buildCoverageQuery — wide profile (pre-unpivot aggregate)', () => {
  const opts = { tagIds: ['A-Temp', 'B-Press'], start, end };

  it('narrow: routes through the canonical Timeseries binding and summarizes by SignalId', () => {
    isWideFn.mockReturnValue(false);
    const csl = buildCoverageQuery(opts);
    expect(csl).toContain('AvgV = avg(Value) by SignalId');
    expect(csl).not.toContain('SignalIdPrefix');
  });

  it('wide: reduces per-column aggregates by prefix, materializes only the aggregate', () => {
    isWideFn.mockReturnValue(true);
    const csl = buildCoverageQuery(opts);
    expect(csl).toContain('let _wcov = materialize(');
    expect(csl).toContain('| summarize FirstTs = min(Timestamp), LastTs = max(Timestamp),');
    expect(csl).toContain('c0_cnt = count(');
    expect(csl).toContain('by SignalIdPrefix');
    // The base binding is a top-level `let` OUTSIDE materialize (a `let` inside a
    // materialize() argument is a KQL parse error); materialize opens on the
    // filtered pipeline, not on another `let`.
    expect(csl.indexOf('let _TimeseriesBase')).toBeGreaterThan(-1);
    expect(csl.indexOf('let _TimeseriesBase')).toBeLessThan(csl.indexOf('let _wcov = materialize('));
    expect(csl).toContain('materialize(\n_TimeseriesBase');
    expect(csl).not.toMatch(/materialize\(\s*let\b/);
    // materialize is closed BEFORE the union — so only the tiny per-prefix
    // aggregate is materialized, never the raw un-binned rows.
    expect(csl).toContain(');\nunion\n');
    // Average is recovered from the carried sum/count.
    expect(csl).toContain('AvgV = iff(c0_cnt > 0, todouble(c0_sum) / c0_cnt, real(null))');
  });

  it('wide: emits one leg per distinct column and trims the cross-product to requested signals', () => {
    isWideFn.mockReturnValue(true);
    const csl = buildCoverageQuery(opts);
    // Two distinct columns (Temp, Press) => two column legs; each fans across
    // both prefixes, so the final filter trims the 2x2 grid to the 2 requested.
    expect((csl.match(/_wcov \| project/g) ?? []).length).toBe(2);
    expect(csl).toContain('| where SignalId in (');
    expect(csl).toContain('A-Temp');
    expect(csl).toContain('B-Press');
  });

  it('wide: produces balanced parentheses', () => {
    isWideFn.mockReturnValue(true);
    const csl = buildCoverageQuery(opts);
    let depth = 0;
    for (const ch of csl) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
