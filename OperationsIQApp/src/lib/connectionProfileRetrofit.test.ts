import { describe, it, expect, vi } from 'vitest';

// connectionProfile.ts imports rayfinClient at module scope (needs a real Fabric
// session), so stub it out — these tests only exercise pure template helpers.
vi.mock('./rayfinClient', () => ({
  client: { data: { ConnectionProfile: {} } },
  getFabricAccountId: vi.fn(() => 'user-1'),
}));

import {
  buildRetrofitSourceQueries,
  SOURCE_DB_PLACEHOLDER,
  EVENTS_QUERY_WITH_ANNOTATIONS,
  METADATA_QUERY_WITH_SIGNAL_METADATA,
} from './connectionProfile';

describe('buildRetrofitSourceQueries', () => {
  it('substitutes the source database into every cross-database reference', () => {
    const qs = buildRetrofitSourceQueries('ContosoMfg');
    for (const q of [qs.hierarchyQuery, qs.metadataQuery, qs.eventsQuery, qs.timeseriesQuery]) {
      expect(q).toContain('database("ContosoMfg").');
      expect(q).not.toContain(SOURCE_DB_PLACEHOLDER);
    }
    // Hierarchy joins TagMetadata in the same source DB.
    expect(qs.hierarchyQuery).toContain('database("ContosoMfg").TagHierarchy');
    expect(qs.hierarchyQuery).toContain('database("ContosoMfg").TagMetadata');
    expect(qs.timeseriesQuery).toContain('database("ContosoMfg").Timeseries');
    expect(qs.eventsQuery).toContain('database("ContosoMfg").Events');
  });

  it('trims surrounding whitespace from the database name', () => {
    const qs = buildRetrofitSourceQueries('  Contoso Mfg  ');
    expect(qs.timeseriesQuery).toContain('database("Contoso Mfg").Timeseries');
  });

  it('rejects an empty database name', () => {
    expect(() => buildRetrofitSourceQueries('   ')).toThrow(/source database name is required/i);
  });

  it.each([
    'db"; drop',
    'db).Timeseries //',
    'db;evil',
    'db/other',
    'db\\other',
  ])('rejects an unsafe database name %j', (bad) => {
    expect(() => buildRetrofitSourceQueries(bad)).toThrow(/Invalid source database name/);
  });

  it.each(['ContosoMfg', 'Contoso Mfg', 'contoso_mfg-01'])(
    'accepts a KQL-safe database name %j',
    (ok) => {
      expect(() => buildRetrofitSourceQueries(ok)).not.toThrow();
    },
  );
});

describe('external-table templates filter to the active profile', () => {
  it('the events+annotations template filters AnnotationsExternal by _ConnectionProfileId', () => {
    expect(EVENTS_QUERY_WITH_ANNOTATIONS).toContain('AnnotationsExternal');
    expect(EVENTS_QUERY_WITH_ANNOTATIONS).toContain(
      'where connection_profile_id == _ConnectionProfileId',
    );
  });

  it('the metadata+signalmetadata template filters SignalMetadataExternal by _ConnectionProfileId', () => {
    expect(METADATA_QUERY_WITH_SIGNAL_METADATA).toContain('SignalMetadataExternal');
    expect(METADATA_QUERY_WITH_SIGNAL_METADATA).toContain(
      'where scope_key == _ConnectionProfileId',
    );
  });
});
