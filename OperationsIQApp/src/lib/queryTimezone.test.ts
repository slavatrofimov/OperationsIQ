import { describe, it, expect, afterEach, vi } from 'vitest';

// kql.ts -> (transitively) eventhouse/msal/env via activeConnection; stub the
// active-connection singleton so the pure builders can run headless. Mirrors
// changePoints.test.ts.
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

import {
  kqlDatetime,
  withTimeseriesRef,
  buildEventsQuery,
  buildBinnedSeriesQuery,
} from './kql';
import { setQueryOffsetMinutes } from './queryTimezone';

afterEach(() => {
  setQueryOffsetMinutes(0); // reset the global offset between tests
});

describe('query timezone offset in the KQL layer', () => {
  const start = new Date('2024-01-01T00:00:00Z');
  const end = new Date('2024-01-02T00:00:00Z');

  it('emits plain UTC literals and no Timestamp shift at offset 0', () => {
    setQueryOffsetMinutes(0);
    expect(kqlDatetime(start)).toBe('datetime(2024-01-01T00:00:00.000Z)');
    expect(withTimeseriesRef('X', 'Timeseries')).toBe('X');
    expect(withTimeseriesRef('X', 'MyTable')).toBe('let Timeseries = (\nMyTable\n);\nX');
  });

  it('shifts datetime literals by +offset', () => {
    setQueryOffsetMinutes(-480); // UTC-8
    expect(kqlDatetime(start)).toBe('datetime(2023-12-31T16:00:00.000Z)');
    setQueryOffsetMinutes(330); // UTC+5:30
    expect(kqlDatetime(start)).toBe('datetime(2024-01-01T05:30:00.000Z)');
  });

  it('shifts the canonical Timestamp column via an intermediate binding', () => {
    setQueryOffsetMinutes(-480);
    const csl = withTimeseriesRef('PROJECT', 'Timeseries');
    expect(csl).toContain("let _TimeseriesBase = (\nTimeseries\n);");
    expect(csl).toContain("datetime_add('minute', -480, Timestamp)");
    expect(csl).toContain('let Timeseries = (_TimeseriesBase | extend Timestamp =');
    expect(csl.endsWith('PROJECT')).toBe(true);
    // No scope supplied -> nothing to push down.
    expect(csl).not.toContain('where Timestamp between');
  });

  it('pushes the window onto the raw Timestamp ahead of the shift when scoped', () => {
    setQueryOffsetMinutes(-480); // UTC-8
    const csl = withTimeseriesRef('PROJECT', 'Timeseries', { signalIds: ['sig1'], start, end });
    // The pre-filter compares the source's UNSHIFTED column, so its bounds stay raw UTC.
    expect(csl).toContain(
      'where Timestamp between (datetime(2024-01-01T00:00:00.000Z) .. datetime(2024-01-02T00:00:00.000Z))',
    );
    // ...and it precedes the extend, so Kusto's datetime index still applies.
    const filterIdx = csl.indexOf('where Timestamp between');
    const shiftIdx = csl.indexOf("datetime_add('minute', -480, Timestamp)");
    expect(filterIdx).toBeGreaterThan(-1);
    expect(shiftIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeLessThan(shiftIdx);
  });

  it('emits neither a pre-filter nor a shift at offset 0 even when scoped', () => {
    setQueryOffsetMinutes(0);
    const csl = withTimeseriesRef('PROJECT', 'Timeseries', { signalIds: ['sig1'], start, end });
    expect(csl).toBe('PROJECT');
  });

  it('keeps literal and column shifts consistent in a full binned-series query', () => {
    setQueryOffsetMinutes(-480);
    const q = buildBinnedSeriesQuery({
      tagId: 'sig1',
      start,
      end,
      binKql: '1h',
      timeseriesRef: 'Timeseries',
    });
    // Both the where/make-series bounds and the source column are shifted by -8h.
    expect(q).toContain('datetime(2023-12-31T16:00:00.000Z)'); // start - 8h
    expect(q).toContain("datetime_add('minute', -480, Timestamp)");
    // The pushed-down source guard keeps the RAW bounds. Both filters select the
    // same rows: T + off in [s + off, e + off]  <=>  T in [s, e].
    expect(q).toContain(
      'where Timestamp between (datetime(2024-01-01T00:00:00.000Z) .. datetime(2024-01-02T00:00:00.000Z))',
    );
  });

  it('shifts event timestamps at the Events binding', () => {
    setQueryOffsetMinutes(-480);
    const q = buildEventsQuery(['TagId|#|scope1'], start, end, 'Events');
    expect(q).toContain(
      "extend StartTimestamp = datetime_add('minute', -480, StartTimestamp), EndTimestamp = datetime_add('minute', -480, EndTimestamp)",
    );
    expect(q).toContain('datetime(2023-12-31T16:00:00.000Z)');
  });

  it('does not shift events at offset 0', () => {
    setQueryOffsetMinutes(0);
    const q = buildEventsQuery(['TagId|#|scope1'], start, end, 'Events');
    expect(q).not.toContain('datetime_add');
    expect(q).toContain('let Events = (\nEvents\n);');
  });
});
