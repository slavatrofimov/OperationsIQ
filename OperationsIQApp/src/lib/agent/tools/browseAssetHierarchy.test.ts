import { describe, it, expect } from 'vitest';
import { browseAssetHierarchyTool } from './browseAssetHierarchy';
import type { ToolContext } from '../types';
import type { TagInfo } from '../../tags';

function tag(p: Partial<TagInfo>): TagInfo {
  return { tagId: 't', tagName: '', metric: '', engUnits: '', ...p } as TagInfo;
}

const TAGS: TagInfo[] = [
  tag({ tagId: 't1', tagName: 'A', level1: 'PlantA', level2: 'Line1' }),
  tag({ tagId: 't2', tagName: 'B', level1: 'PlantA', level2: 'Line1' }),
  tag({ tagId: 't3', tagName: 'C', level1: 'PlantA', level2: 'Line2' }),
  tag({ tagId: 't4', tagName: 'D', level1: 'PlantA' }), // direct tag at PlantA
];

const ctx = (tags: TagInfo[]): ToolContext => ({ tags });

const matchScope = (t: TagInfo, scope?: Record<string, string | undefined>) =>
  Object.entries(scope ?? {}).every(([k, v]) => {
    if (!v) return true;
    const actual = (t as unknown as Record<string, unknown>)[k];
    return typeof actual === 'string' && actual.toLowerCase() === v.toLowerCase();
  });

/** A stub CatalogAccess computed from an in-memory array (mirrors the service). */
function stubCatalog(rows: TagInfo[]): NonNullable<ToolContext['catalog']> {
  return {
    async searchTags(params) {
      const out = rows.filter((t) => matchScope(t, params.scope));
      const take = params.take ?? 200;
      return { rows: out.slice(0, take), hasMore: out.length > take };
    },
    async getTagsByIds(ids) {
      return rows.filter((t) => ids.includes(t.tagId));
    },
    async getHierarchyChildren(params) {
      const counts = new Map<string, number>();
      for (const t of rows.filter((r) => matchScope(r, params.scope))) {
        const v = (t as unknown as Record<string, unknown>)[params.childKey] as string | undefined;
        if (v && v.trim()) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      return [...counts.entries()].map(([value, count]) => ({ value, count }));
    },
    async countTags(filter) {
      return rows.filter((t) => matchScope(t, filter.scope)).length;
    },
  };
}

interface BrowseData {
  node: string | null;
  nextLevel: string | null;
  children: { name: string; tagCount: number }[];
  directTagCount: number;
  directTags: { tagId: string }[];
  totalTagsUnderNode: number;
}

describe('browseAssetHierarchyTool', () => {
  describe('in-memory path', () => {
    it('lists child nodes with counts and direct tags', async () => {
      const r = await browseAssetHierarchyTool.run({ node: { level1: 'PlantA' } }, ctx(TAGS));
      expect(r.ok).toBe(true);
      const d = r.data as BrowseData;
      expect(d.nextLevel).toBe('level2');
      expect(d.children).toEqual([
        { name: 'Line1', tagCount: 2 },
        { name: 'Line2', tagCount: 1 },
      ]);
      expect(d.directTagCount).toBe(1);
      expect(d.directTags.map((t) => t.tagId)).toEqual(['t4']);
      expect(d.totalTagsUnderNode).toBe(4);
    });

    it('errors when no tags match the node', async () => {
      const r = await browseAssetHierarchyTool.run({ node: { level1: 'Nope' } }, ctx(TAGS));
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('not_found');
    });
  });

  describe('large-catalog path (ctx.catalog present)', () => {
    it('produces the same shape as the in-memory path', async () => {
      const r = await browseAssetHierarchyTool.run(
        { node: { level1: 'PlantA' } },
        { tags: [], catalog: stubCatalog(TAGS) },
      );
      expect(r.ok).toBe(true);
      const d = r.data as BrowseData;
      expect(d.nextLevel).toBe('level2');
      expect(d.children).toEqual([
        { name: 'Line1', tagCount: 2 },
        { name: 'Line2', tagCount: 1 },
      ]);
      // directTagCount is exact (total − Σ child counts).
      expect(d.directTagCount).toBe(1);
      expect(d.directTags.map((t) => t.tagId)).toEqual(['t4']);
      expect(d.totalTagsUnderNode).toBe(4);
    });

    it('errors when the node has no tags server-side', async () => {
      const r = await browseAssetHierarchyTool.run(
        { node: { level1: 'Nope' } },
        { tags: [], catalog: stubCatalog(TAGS) },
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('not_found');
    });

    it('returns query_failed when the service throws', async () => {
      const failing: NonNullable<ToolContext['catalog']> = {
        searchTags: async () => ({ rows: [], hasMore: false }),
        getTagsByIds: async () => [],
        getHierarchyChildren: async () => [],
        countTags: async () => {
          throw new Error('boom');
        },
      };
      const r = await browseAssetHierarchyTool.run(
        { node: { level1: 'PlantA' } },
        { tags: [], catalog: failing },
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('query_failed');
    });
  });
});
