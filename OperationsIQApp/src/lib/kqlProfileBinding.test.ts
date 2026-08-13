import { describe, it, expect, vi, beforeEach } from 'vitest';

// The KQL builders reach activeConnection (which transitively pulls in
// eventhouse/msal/env). Stub the singleton so the pure builders run headless.
// getActiveProfileId is a vi.fn so individual tests can vary the active id.
const getActiveProfileId = vi.fn((): string | undefined => 'profile-xyz');
vi.mock('./activeConnection', () => ({
  getActiveKqlOpts: () => undefined,
  getActiveProfileId: () => getActiveProfileId(),
  getActiveTimeseriesRef: () => 'Timeseries',
  getActiveTimeseriesIsWide: () => false,
  getActiveSignalIdDelimiter: () => '-',
  getActiveHierarchyRef: () => 'TagHierarchy',
  getActiveMetadataRef: () => 'TagMetadata',
  getActiveEventsRef: () => 'Events',
}));

import { buildEventsQuery } from './kql';

describe('_ConnectionProfileId binding injection', () => {
  const start = new Date('2024-01-01T00:00:00Z');
  const end = new Date('2024-01-02T00:00:00Z');

  beforeEach(() => {
    getActiveProfileId.mockReturnValue('profile-xyz');
  });

  it('prepends the active profile id as a let binding before the Events binding', () => {
    const csl = buildEventsQuery(['TagId|#|t1'], start, end);
    expect(csl.startsWith("let _ConnectionProfileId = 'profile-xyz';\n")).toBe(true);
    // The binding must sit before the Events binding so external-table
    // templates that reference it resolve.
    expect(csl.indexOf('_ConnectionProfileId')).toBeLessThan(csl.indexOf('let Events'));
  });

  it('binds the empty string when no profile is active (matches no external rows)', () => {
    getActiveProfileId.mockReturnValue(undefined);
    const csl = buildEventsQuery(['TagId|#|t1'], start, end);
    expect(csl.startsWith("let _ConnectionProfileId = '';\n")).toBe(true);
  });

  it('escapes a single quote in the profile id so it cannot break the literal', () => {
    getActiveProfileId.mockReturnValue("p'; drop");
    const csl = buildEventsQuery(['TagId|#|t1'], start, end);
    expect(csl.startsWith("let _ConnectionProfileId = 'p\\'; drop';\n")).toBe(true);
  });
});
