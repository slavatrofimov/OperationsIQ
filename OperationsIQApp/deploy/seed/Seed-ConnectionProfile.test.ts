import { describe, it, expect, vi } from 'vitest';

// The seeder imports the app's connectionProfile helpers (which transitively
// import the browser Rayfin client) and the server SDK. Neither is needed for
// the pure helpers under test, so stub both to keep the suite Node-only.
vi.mock('@microsoft/rayfin-client', () => ({ RayfinServerClient: class {} }));
vi.mock('../../src/lib/rayfinClient', () => ({
  client: {},
  getFabricAccountId: () => '',
  getFabricAccountEmail: () => '',
}));

import { buildQuerySet, subjectFromToken } from './Seed-ConnectionProfile';

describe('buildQuerySet', () => {
  it('builds cross-database retrofit queries from the source DB', () => {
    const q = buildQuerySet('retrofit', 'OperationsIQ', 'ContosoRaw');
    expect(q.timeseriesIsWide).toBe(false);
    expect(q.timeseriesQuery).toContain('database("ContosoRaw").Timeseries');
    expect(q.hierarchyQuery).toContain('database("ContosoRaw").TagHierarchy');
    expect(q.metadataQuery).toContain('database("ContosoRaw").TagMetadata');
    expect(q.eventsQuery).toContain('database("ContosoRaw").Events');
  });

  it('falls back to the companion DB when no source DB is given (retrofit)', () => {
    const q = buildQuerySet('retrofit', 'CompanionDb', '');
    expect(q.timeseriesQuery).toContain('database("CompanionDb").Timeseries');
  });

  it('uses direct base-table queries for the greenfield sample mode', () => {
    const q = buildQuerySet('greenfield-sample', 'OperationsIQSample', '');
    expect(q.timeseriesIsWide).toBe(false);
    expect(q.timeseriesQuery).toContain('Timeseries');
    expect(q.timeseriesQuery).not.toContain('database(');
    expect(q.hierarchyQuery).toContain('TagHierarchy');
  });
});

describe('subjectFromToken', () => {
  function jwt(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
  }

  it('prefers the oid claim', () => {
    expect(subjectFromToken(jwt({ oid: 'obj-123', sub: 'sub-999' }))).toBe('obj-123');
  });

  it('falls back to sub when oid is absent', () => {
    expect(subjectFromToken(jwt({ sub: 'sub-999' }))).toBe('sub-999');
  });

  it('throws for a non-JWT token', () => {
    expect(() => subjectFromToken('not-a-jwt')).toThrow();
  });

  it('throws when neither oid nor sub is present', () => {
    expect(() => subjectFromToken(jwt({ name: 'x' }))).toThrow();
  });
});
