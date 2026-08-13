import { describe, expect, it } from 'vitest';
import { buildSignalProfileQuery } from './kql';

const base = {
  start: new Date('2026-06-01T00:00:00Z'),
  end: new Date('2026-06-08T00:00:00Z'),
  binKql: '15m',
  timeseriesRef: 'Timeseries',
};

describe('buildSignalProfileQuery', () => {
  it('calls the app_signal_profile stored function with the canonical Timeseries source', () => {
    const csl = buildSignalProfileQuery({ tagId: 'temperature-01', ...base });
    expect(csl).toContain('app_signal_profile(Timeseries,');
  });

  it('passes the tag, range and bin as literal arguments in order', () => {
    const csl = buildSignalProfileQuery({ tagId: 'pressure-07', ...base });
    expect(csl).toContain("'pressure-07'");
    expect(csl).toContain('datetime(2026-06-01T00:00:00.000Z)');
    expect(csl).toContain('datetime(2026-06-08T00:00:00.000Z)');
    // bin literal is the last argument before the closing paren
    expect(csl).toMatch(/app_signal_profile\(Timeseries, 'pressure-07', datetime\([^)]+\), datetime\([^)]+\), 15m\)/);
  });

  it('binds a non-default connection profile as a let Timeseries = (...) prefix', () => {
    const csl = buildSignalProfileQuery({
      tagId: 't1',
      start: base.start,
      end: base.end,
      binKql: '5m',
      timeseriesRef: 'MyTable | project SignalId = Tag, Timestamp = Ts, Value = V',
    });
    expect(csl.startsWith('let Timeseries = (')).toBe(true);
    expect(csl).toContain("app_signal_profile(Timeseries, 't1'");
  });

  it('escapes tag identifiers to guard against KQL injection', () => {
    const csl = buildSignalProfileQuery({ tagId: "a'b", ...base });
    expect(csl).toContain("'a\\'b'");
  });
});
