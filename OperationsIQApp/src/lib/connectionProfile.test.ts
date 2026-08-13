import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Rayfin client so profile CRUD runs without a real Fabric session.
const { create, select, update } = vi.hoisted(() => ({
  create: vi.fn(),
  select: vi.fn(() => ({ execute: () => Promise.resolve(rows) })),
  update: vi.fn(),
}));

// Mutable holder the mocked select() reads from.
let rows: Record<string, unknown>[] = [];

vi.mock('./rayfinClient', () => ({
  client: { data: { ConnectionProfile: { create, select, update, delete: vi.fn() } } },
  getFabricAccountId: vi.fn(() => 'user-1'),
}));

import { saveProfile, listProfiles, DEFAULT_LABELS } from './connectionProfile';

const baseInput = {
  name: 'Contoso',
  eventhouseQueryUri: 'https://eh.example.com',
  databaseName: 'ContosoMfg',
  fabricWorkspaceId: 'ws-guid',
  eventhouseId: 'eh-guid',
  kqlDatabaseId: 'db-guid',
  hierarchyQuery: 'h',
  metadataQuery: 'm',
  eventsQuery: 'e',
  timeseriesQuery: 't',
  labels: DEFAULT_LABELS,
};

beforeEach(() => {
  create.mockReset();
  update.mockReset();
  rows = [];
});

describe('connection profile Fabric id persistence', () => {
  it('writes the captured Fabric ids on create', async () => {
    await saveProfile(baseInput);
    const arg = create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.fabric_workspace_id).toBe('ws-guid');
    expect(arg.eventhouse_id).toBe('eh-guid');
    expect(arg.kql_database_id).toBe('db-guid');
  });

  it('maps the Fabric id columns back onto the client model on read', async () => {
    rows = [
      {
        id: 'p1',
        user_id: 'user-1',
        name: 'Contoso',
        eventhouse_query_uri: 'https://eh.example.com',
        database_name: 'ContosoMfg',
        fabric_workspace_id: 'ws-guid',
        eventhouse_id: 'eh-guid',
        kql_database_id: 'db-guid',
        hierarchy_query: 'h',
        metadata_query: 'm',
        events_query: 'e',
        timeseries_query: 't',
        labels_json: '{}',
        created_at: new Date('2026-07-01T00:00:00.000Z'),
      },
    ];
    const [p] = await listProfiles();
    expect(p.fabricWorkspaceId).toBe('ws-guid');
    expect(p.eventhouseId).toBe('eh-guid');
    expect(p.kqlDatabaseId).toBe('db-guid');
  });

  it('maps null Fabric id columns to undefined (legacy rows)', async () => {
    rows = [
      {
        id: 'p2',
        user_id: 'user-1',
        name: 'Legacy',
        eventhouse_query_uri: 'https://eh.example.com',
        database_name: 'Legacy',
        fabric_workspace_id: null,
        eventhouse_id: null,
        kql_database_id: null,
        hierarchy_query: 'h',
        metadata_query: 'm',
        events_query: 'e',
        timeseries_query: 't',
        labels_json: '{}',
        created_at: new Date('2026-07-01T00:00:00.000Z'),
      },
    ];
    const [p] = await listProfiles();
    expect(p.fabricWorkspaceId).toBeUndefined();
    expect(p.eventhouseId).toBeUndefined();
    expect(p.kqlDatabaseId).toBeUndefined();
  });
});

describe('wide time-series profile fields', () => {
  it('persists the wide flag and delimiter on create', async () => {
    await saveProfile({ ...baseInput, timeseriesIsWide: true, signalIdDelimiter: '::' });
    const arg = create.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.timeseries_is_wide).toBe(true);
    expect(arg.signal_id_delimiter).toBe('::');
  });

  it('maps the wide columns back onto the client model on read', async () => {
    rows = [
      {
        id: 'pw',
        user_id: 'user-1',
        name: 'Wide',
        eventhouse_query_uri: 'https://eh.example.com',
        database_name: 'Wide',
        hierarchy_query: 'h',
        metadata_query: 'm',
        events_query: 'e',
        timeseries_query: 't',
        timeseries_is_wide: true,
        signal_id_delimiter: '::',
        labels_json: '{}',
        created_at: new Date('2026-07-01T00:00:00.000Z'),
      },
    ];
    const [p] = await listProfiles();
    expect(p.timeseriesIsWide).toBe(true);
    expect(p.signalIdDelimiter).toBe('::');
  });

  it('maps missing wide columns to undefined (narrow/legacy rows)', async () => {
    rows = [
      {
        id: 'pn',
        user_id: 'user-1',
        name: 'Narrow',
        eventhouse_query_uri: 'https://eh.example.com',
        database_name: 'Narrow',
        hierarchy_query: 'h',
        metadata_query: 'm',
        events_query: 'e',
        timeseries_query: 't',
        timeseries_is_wide: null,
        signal_id_delimiter: null,
        labels_json: '{}',
        created_at: new Date('2026-07-01T00:00:00.000Z'),
      },
    ];
    const [p] = await listProfiles();
    expect(p.timeseriesIsWide).toBeUndefined();
    expect(p.signalIdDelimiter).toBeUndefined();
  });
});
