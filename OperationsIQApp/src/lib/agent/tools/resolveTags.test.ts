import { describe, it, expect } from 'vitest';
import { resolveTagsTool } from './resolveTags';
import type { ToolContext } from '../types';
import type { TagInfo } from '../../tags';

function tag(p: Partial<TagInfo>): TagInfo {
  return {
    tagId: 't?',
    tagName: '',
    metric: '',
    description: '',
    engUnits: '',
    ...p,
  } as TagInfo;
}

const TAGS: TagInfo[] = [
  tag({ tagId: 't1', tagName: 'Boiler Outlet Temp', metric: 'Temperature', engUnits: 'C', level1: 'PlantA' }),
  tag({ tagId: 't2', tagName: 'Boiler Pressure', metric: 'Pressure', engUnits: 'bar', level1: 'PlantA' }),
  tag({ tagId: 't3', tagName: 'Feedwater Flow', metric: 'Flow', engUnits: 'm3/h', level1: 'PlantB' }),
  tag({
    tagId: 't4',
    tagName: 'Reactor Coolant Temp',
    metric: 'Temperature',
    engUnits: 'C',
    level1: 'PlantA',
    level5: 'Subsystem5',
    level8: 'CoolingLoop',
    level10: 'DeepNode',
  }),
];

const ctx = (tags: TagInfo[]): ToolContext => ({ tags });

/** A stub CatalogAccess backed by an in-memory array, for the large-catalog path. */
function stubCatalog(rows: TagInfo[]): NonNullable<ToolContext['catalog']> {
  const contains = (t: TagInfo, term: string) => {
    const hay = [t.tagName, t.tagId, t.metric, t.description]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(term.toLowerCase());
  };
  return {
    async searchTags(params) {
      const terms = (params.query ?? '').trim().split(/\s+/).filter(Boolean);
      let out = rows.filter((t) => terms.every((term) => contains(t, term)));
      if (params.scope) {
        out = out.filter((t) =>
          Object.entries(params.scope!).every(([k, v]) => {
            if (!v) return true;
            const actual = (t as unknown as Record<string, unknown>)[k];
            return typeof actual === 'string' && actual.toLowerCase() === v.toLowerCase();
          }),
        );
      }
      const take = params.take ?? 200;
      return { rows: out.slice(0, take), hasMore: out.length > take };
    },
    async getTagsByIds(ids) {
      return rows.filter((t) => ids.includes(t.tagId));
    },
    async getHierarchyChildren() {
      return [];
    },
    async countTags() {
      return rows.length;
    },
  };
}

describe('resolveTagsTool', () => {
  it('ranks tags by how many query terms match', async () => {
    const r = await resolveTagsTool.run({ query: 'boiler temp' }, ctx(TAGS));
    expect(r.ok).toBe(true);
    const matches = (r.data as { matches: { tagId: string }[] }).matches;
    // "Boiler Outlet Temp" matches both terms; "Boiler Pressure" only one.
    expect(matches[0].tagId).toBe('t1');
    expect(matches.map((m) => m.tagId)).toContain('t2');
    expect(matches.map((m) => m.tagId)).not.toContain('t3');
  });

  it('returns an error when query is empty', async () => {
    const r = await resolveTagsTool.run({ query: '  ' }, ctx(TAGS));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('bad_args');
  });

  it('applies the asset-hierarchy scope filter (case-insensitive)', async () => {
    const r = await resolveTagsTool.run(
      { query: 'boiler', scope: { level1: 'planta' } },
      ctx(TAGS),
    );
    const matches = (r.data as { matches: { tagId: string }[] }).matches;
    expect(matches.every((m) => m.tagId === 't1' || m.tagId === 't2')).toBe(true);
  });

  it('matches deep hierarchy nodes (level5..level10) in the haystack', async () => {
    const r = await resolveTagsTool.run({ query: 'coolingloop' }, ctx(TAGS));
    expect(r.ok).toBe(true);
    const matches = (r.data as { matches: { tagId: string }[] }).matches;
    expect(matches.map((m) => m.tagId)).toEqual(['t4']);
  });

  it('applies a scope filter on a deep level (level10, case-insensitive)', async () => {
    const r = await resolveTagsTool.run(
      { query: 'temp', scope: { level10: 'deepnode' } },
      ctx(TAGS),
    );
    const matches = (r.data as { matches: { tagId: string }[] }).matches;
    expect(matches.map((m) => m.tagId)).toEqual(['t4']);
  });

  it('honors the limit', async () => {
    const r = await resolveTagsTool.run({ query: 'boiler', limit: 1 }, ctx(TAGS));
    const matches = (r.data as { matches: unknown[] }).matches;
    expect(matches).toHaveLength(1);
  });

  it('reports no matches cleanly', async () => {
    const r = await resolveTagsTool.run({ query: 'turbine' }, ctx(TAGS));
    expect(r.ok).toBe(true);
    expect((r.data as { matches: unknown[] }).matches).toHaveLength(0);
    expect(r.summary).toMatch(/No tags matched/);
  });

  it('resolves an exact tagId directly (case-insensitive)', async () => {
    const r = await resolveTagsTool.run({ query: 'T3' }, ctx(TAGS));
    expect(r.ok).toBe(true);
    const matches = (r.data as { matches: { tagId: string }[] }).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].tagId).toBe('t3');
    expect(r.summary).toMatch(/Resolved tagId/);
  });

  it('matches a tagId substring via the haystack', async () => {
    const tags = [
      tag({ tagId: 'SIG-8842-ABC', tagName: 'Some Signal', metric: 'Flow' }),
      tag({ tagId: 'SIG-9001-XYZ', tagName: 'Other Signal', metric: 'Flow' }),
    ];
    const r = await resolveTagsTool.run({ query: '8842' }, ctx(tags));
    expect(r.ok).toBe(true);
    const matches = (r.data as { matches: { tagId: string }[] }).matches;
    expect(matches.map((m) => m.tagId)).toEqual(['SIG-8842-ABC']);
  });

  it('does not return an exact tagId that falls outside the scope filter', async () => {
    // t3 is in PlantB; scoping to PlantA must not surface it via the id fast path.
    const r = await resolveTagsTool.run(
      { query: 't3', scope: { level1: 'PlantA' } },
      ctx(TAGS),
    );
    expect(r.ok).toBe(true);
    expect((r.data as { matches: unknown[] }).matches).toHaveLength(0);
  });

  it('includes samplingFrequency and a labeled asset path when terminology is present', async () => {
    const tags = [
      tag({
        tagId: 't9',
        tagName: 'Coolant Temp',
        metric: 'Temperature',
        samplingFrequency: '1m',
        level1: 'Plant A',
        level3: 'Line 3',
      }),
    ];
    const ctxWithTerm: ToolContext = {
      tags,
      terminology: {
        entityLabel: 'Asset',
        metricIdLabel: 'Signal',
        unitOfMeasureLabel: 'Units',
        samplingFrequencyLabel: 'Cadence',
        levelLabels: ['Plant', 'Factory', 'Line'],
      },
    };
    const r = await resolveTagsTool.run({ query: 'coolant' }, ctxWithTerm);
    const matches = (r.data as {
      matches: { assetPath: string | null; samplingFrequency: string | null }[];
    }).matches;
    expect(matches[0].samplingFrequency).toBe('1m');
    // level2 is empty, so only Plant and Line appear, each labeled.
    expect(matches[0].assetPath).toBe('Plant: Plant A › Line: Line 3');
  });

  it('builds an unlabeled asset path when no terminology is supplied', async () => {
    const r = await resolveTagsTool.run({ query: 'coolingloop' }, ctx(TAGS));
    const matches = (r.data as { matches: { assetPath: string | null }[] }).matches;
    // t4: level1=PlantA, level5=Subsystem5, level8=CoolingLoop, level10=DeepNode.
    expect(matches[0].assetPath).toBe('PlantA › Subsystem5 › CoolingLoop › DeepNode');
  });

  it('returns a null asset path for a tag with no hierarchy', async () => {
    const tags = [tag({ tagId: 'x1', tagName: 'Loose Signal', metric: 'Flow' })];
    const r = await resolveTagsTool.run({ query: 'loose' }, ctx(tags));
    const matches = (r.data as { matches: { assetPath: string | null }[] }).matches;
    expect(matches[0].assetPath).toBeNull();
  });

  describe('large-catalog path (ctx.catalog present)', () => {
    it('ranks server-returned candidates by term score', async () => {
      const r = await resolveTagsTool.run(
        { query: 'boiler temp' },
        { tags: [], catalog: stubCatalog(TAGS) },
      );
      expect(r.ok).toBe(true);
      const matches = (r.data as { matches: { tagId: string }[] }).matches;
      // "Boiler Outlet Temp" matches both terms; ranks first.
      expect(matches[0].tagId).toBe('t1');
      expect(matches.map((m) => m.tagId)).not.toContain('t3');
    });

    it('resolves an exact tagId via the service (short-circuits)', async () => {
      const r = await resolveTagsTool.run(
        { query: 't3' },
        { tags: [], catalog: stubCatalog(TAGS) },
      );
      expect(r.ok).toBe(true);
      const matches = (r.data as { matches: { tagId: string }[] }).matches;
      expect(matches).toHaveLength(1);
      expect(matches[0].tagId).toBe('t3');
      expect(r.summary).toMatch(/Resolved tagId/);
    });

    it('applies the scope filter server-side', async () => {
      const r = await resolveTagsTool.run(
        { query: 'boiler', scope: { level1: 'PlantA' } },
        { tags: [], catalog: stubCatalog(TAGS) },
      );
      const matches = (r.data as { matches: { tagId: string }[] }).matches;
      expect(matches.every((m) => m.tagId === 't1' || m.tagId === 't2')).toBe(true);
    });

    it('honors the limit against the service pool', async () => {
      const r = await resolveTagsTool.run(
        { query: 'boiler', limit: 1 },
        { tags: [], catalog: stubCatalog(TAGS) },
      );
      expect((r.data as { matches: unknown[] }).matches).toHaveLength(1);
    });

    it('returns a query_failed error when the service throws', async () => {
      const failing: NonNullable<ToolContext['catalog']> = {
        searchTags: async () => {
          throw new Error('boom');
        },
        getTagsByIds: async () => [],
        getHierarchyChildren: async () => [],
        countTags: async () => 0,
      };
      const r = await resolveTagsTool.run({ query: 'boiler' }, { tags: [], catalog: failing });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('query_failed');
    });
  });
});
