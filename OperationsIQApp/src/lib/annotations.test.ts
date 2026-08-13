import { describe, it, expect, vi, beforeEach } from 'vitest';

// annotations.ts imports rayfinClient / activeConnection / kql / queryTimezone at
// module scope; mock them so the pure helpers and the SQL-read path can be tested
// without a real Fabric session. A chainable Annotation.select().where().execute()
// stub lets us capture the server-side filter and drive the returned rows.
const h = vi.hoisted(() => {
  const executeMock = vi.fn(async (): Promise<unknown[]> => []);
  const whereMock = vi.fn((_filter: unknown) => ({ execute: executeMock }));
  const selectMock = vi.fn((_fields: string[]) => ({ where: whereMock }));
  return {
    executeMock,
    whereMock,
    selectMock,
    profileId: { value: 'profile-xyz' as string | undefined },
    offset: { value: 0 },
    eventRows: { value: [] as unknown[] },
  };
});

vi.mock('./rayfinClient', () => ({
  client: { data: { Annotation: { select: h.selectMock } } },
  getFabricAccountId: vi.fn(() => 'user-1'),
}));
vi.mock('./eventhouse', () => ({
  queryRows: vi.fn(async () => h.eventRows.value),
}));
vi.mock('./activeConnection', () => ({
  getActiveProfileId: () => h.profileId.value,
}));
vi.mock('./kql', () => ({
  buildEventsQuery: vi.fn(() => 'EVENTS_QUERY'),
}));
vi.mock('./queryTimezone', () => ({
  getQueryOffsetMinutes: () => h.offset.value,
}));

import { buildScopeKeys, loadAnnotationMarkers, loadTimeline } from './annotations';
import type { HierarchyLevel } from './tagTree';
import type { TagInfo } from './tags';

const tag = (overrides: Partial<TagInfo> = {}): TagInfo => ({
  tagId: 't1',
  tagName: 'Tag 1',
  metric: '',
  description: '',
  engUnits: '',
  ...overrides,
});

const levels: HierarchyLevel[] = [
  { key: 'level1', label: 'Plant', get: (t) => t.level1 },
  { key: 'level2', label: 'Factory', get: (t) => t.level2 },
  { key: 'level3', label: 'Line', get: (t) => t.level3 },
];

describe('buildScopeKeys', () => {
  it('builds a TagId key and one Level key per assigned level', () => {
    const tags = [tag({ level1: 'Contoso Plant 1', level2: 'Assembly', level3: 'Line A' })];
    const keys = buildScopeKeys(tags, levels);
    expect(keys).toContain('TagId|#|t1');
    expect(keys).toContain('Level1|#|Contoso Plant 1');
    expect(keys).toContain('Level2|#|Contoso Plant 1/Assembly');
    expect(keys).toContain('Level3|#|Contoso Plant 1/Assembly/Line A');
  });

  it('percent-escapes a level value containing a slash so it does not create a spurious level boundary', () => {
    const tags = [tag({ level1: 'Contoso Plant 1', level2: 'Assembly/Line A' })];
    const keys = buildScopeKeys(tags, levels);
    // The embedded '/' must be escaped to %2F, not treated as a path separator.
    expect(keys).toContain('Level2|#|Contoso Plant 1/Assembly%2FLine A');
    // The Level2 key must still resolve to exactly 2 path segments (levels.length would be 3
    // if it wrongly created an extra boundary from the embedded slash).
    const level2Key = keys.find((k) => k.startsWith('Level2|#|'));
    expect(level2Key).toBeDefined();
    const path = level2Key!.slice('Level2|#|'.length);
    expect(path.split('/')).toHaveLength(2);
    // No Level3 key should be produced since level3 is unassigned.
    expect(keys.some((k) => k.startsWith('Level3|#|'))).toBe(false);
  });
});

const range = { start: new Date('2020-01-01T00:00:00Z'), end: new Date('2020-01-02T00:00:00Z') };
const nameById = new Map<string, string>([['t1', 'Tag 1']]);

describe('loadAnnotationMarkers', () => {
  beforeEach(() => {
    h.selectMock.mockClear();
    h.whereMock.mockClear();
    h.executeMock.mockClear();
    h.executeMock.mockImplementation(async () => []);
    h.profileId.value = 'profile-xyz';
    h.offset.value = 0;
  });

  it('returns [] without querying when no scope keys are supplied', async () => {
    const res = await loadAnnotationMarkers([], range, nameById);
    expect(res).toEqual([]);
    expect(h.executeMock).not.toHaveBeenCalled();
  });

  it('returns [] without querying when no profile is active', async () => {
    h.profileId.value = undefined;
    const res = await loadAnnotationMarkers(['TagId|#|t1'], range, nameById);
    expect(res).toEqual([]);
    expect(h.executeMock).not.toHaveBeenCalled();
  });

  it('pushes profile, scope, and time-overlap filtering to the database', async () => {
    await loadAnnotationMarkers(['TagId|#|t1', 'Level1|#|Plant'], range, nameById);

    // Only the needed columns are selected.
    const fields = h.selectMock.mock.calls[0][0] as string[];
    expect(fields).toEqual(
      expect.arrayContaining([
        'id', 'timestamp', 'end_timestamp', 'scope_type', 'scope_id',
        'annotation_type', 'title', 'user_id',
      ]),
    );

    const filter = h.whereMock.mock.calls[0][0] as { and: Array<Record<string, unknown>> };
    const and = filter.and;
    // Profile isolation.
    expect(and).toContainEqual({ connection_profile_id: { eq: 'profile-xyz' } });
    // Upper time bound.
    expect(and).toContainEqual({ timestamp: { lte: range.end } });
    // Lower bound honoring point vs span annotations.
    expect(and).toContainEqual({
      or: [
        { end_timestamp: { isNull: true }, timestamp: { gte: range.start } },
        { end_timestamp: { gte: range.start } },
      ],
    });
    // Scope pairs OR'd together (the `or` whose members are (scope_type AND scope_id) clauses).
    const scopeClause = and.find(
      (c) =>
        Array.isArray((c as { or?: unknown[] }).or) &&
        (c as { or: Array<Record<string, unknown>> }).or.every((m) => 'and' in m),
    ) as { or: Array<{ and: Array<Record<string, unknown>> }> };
    expect(scopeClause.or).toContainEqual({
      and: [{ scope_type: { eq: 'TagId' } }, { scope_id: { eq: 't1' } }],
    });
    expect(scopeClause.or).toContainEqual({
      and: [{ scope_type: { eq: 'Level1' } }, { scope_id: { eq: 'Plant' } }],
    });
  });

  it('shifts fetched annotation timestamps into chart space by the active offset', async () => {
    h.offset.value = 60; // +60 minutes
    h.executeMock.mockImplementation(async () => [
      {
        id: 'a1',
        user_id: 'user-1',
        annotation_type: 'note',
        title: 'A',
        detail: null,
        timestamp: new Date('2020-01-01T05:00:00Z'),
        end_timestamp: null,
        scope_type: 'TagId',
        scope_id: 't1',
      },
    ]);
    const [m] = await loadAnnotationMarkers(['TagId|#|t1'], range, nameById);
    expect(m.source).toBe('annotation');
    expect(m.id).toBe('annotation:a1');
    expect(m.timestamp.toISOString()).toBe('2020-01-01T06:00:00.000Z');
    expect(m.scopeLabel).toBe('Tag 1');
  });
});

describe('loadTimeline merge', () => {
  const tags = [tag()];
  const noLevels: HierarchyLevel[] = [];

  beforeEach(() => {
    h.selectMock.mockClear();
    h.whereMock.mockClear();
    h.executeMock.mockClear();
    h.executeMock.mockImplementation(async () => []);
    h.profileId.value = 'profile-xyz';
    h.offset.value = 0;
    h.eventRows.value = [];
  });

  it('merges events with SQL annotations and de-duplicates by id (SQL wins)', async () => {
    h.eventRows.value = [
      {
        EventId: 'e1', ScopeId: 't1', ScopeType: 'TagId',
        StartTimestamp: '2020-01-01T01:00:00Z', EndTimestamp: null,
        EventType: 'alarm', Title: 'Event 1', Detail: null, Source: 'Event', UserId: '',
      },
      // A legacy KQL-unioned copy of annotation a1 (should be overridden by the SQL row).
      {
        EventId: 'a1', ScopeId: 't1', ScopeType: 'TagId',
        StartTimestamp: '2020-01-01T02:00:00Z', EndTimestamp: null,
        EventType: 'note', Title: 'KQL copy', Detail: null, Source: 'Annotation', UserId: 'user-1',
      },
    ];
    h.executeMock.mockImplementation(async () => [
      {
        id: 'a1', user_id: 'user-1', annotation_type: 'note', title: 'SQL wins', detail: null,
        timestamp: new Date('2020-01-01T02:00:00Z'), end_timestamp: null,
        scope_type: 'TagId', scope_id: 't1',
      },
    ]);

    const markers = await loadTimeline(tags, noLevels, range, nameById);
    expect(markers).toHaveLength(2);
    const a1 = markers.find((m) => m.id === 'annotation:a1');
    expect(a1?.title).toBe('SQL wins'); // SQL-sourced copy won the dedupe.
    expect(markers.find((m) => m.id === 'event:e1')).toBeDefined();
    // Sorted ascending by timestamp.
    expect(markers[0].timestamp.getTime()).toBeLessThanOrEqual(markers[1].timestamp.getTime());
  });
});
