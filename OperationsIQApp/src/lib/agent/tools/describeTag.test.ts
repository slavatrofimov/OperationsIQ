import { describe, it, expect } from 'vitest';
import { describeTagTool } from './describeTag';
import type { ToolContext } from '../types';
import type { TagInfo } from '../../tags';

function tag(p: Partial<TagInfo>): TagInfo {
  return { tagId: 't', tagName: '', metric: '', engUnits: '', ...p } as TagInfo;
}

const ctx = (tags: TagInfo[]): ToolContext => ({ tags });

interface DescribedTag {
  tagId: string;
  governedMetadata?: Record<string, number | string>;
}

describe('describeTagTool', () => {
  it('errors when no tagIds given', async () => {
    const r = await describeTagTool.run({ tagIds: [] }, ctx([]));
    expect(r.ok).toBe(false);
  });

  it('surfaces governed metadata when present', async () => {
    const tags = [tag({ tagId: 't1', tagName: 'Boiler', usl: 100, lsl: 10, ruleProfile: 'nelson' })];
    const r = await describeTagTool.run({ tagIds: ['t1'] }, ctx(tags));
    expect(r.ok).toBe(true);
    const described = (r.data as { tags: DescribedTag[] }).tags[0];
    expect(described.governedMetadata).toEqual({ usl: 100, lsl: 10, ruleProfile: 'nelson' });
    expect(r.summary).toContain('governed limits');
  });

  it('omits governedMetadata when the tag carries none', async () => {
    const tags = [tag({ tagId: 't1', tagName: 'Boiler' })];
    const r = await describeTagTool.run({ tagIds: ['t1'] }, ctx(tags));
    const described = (r.data as { tags: DescribedTag[] }).tags[0];
    expect(described.governedMetadata).toBeUndefined();
  });

  it('reports missing ids', async () => {
    const tags = [tag({ tagId: 't1' })];
    const r = await describeTagTool.run({ tagIds: ['t1', 'tX'] }, ctx(tags));
    expect(r.ok).toBe(true);
    expect((r.data as { missing: string[] }).missing).toEqual(['tX']);
  });

  describe('large-catalog path (ctx.catalog present)', () => {
    it('resolves ids via the service and reports missing', async () => {
      const rows = [tag({ tagId: 't1', tagName: 'Boiler', usl: 100 })];
      const catalog: NonNullable<ToolContext['catalog']> = {
        searchTags: async () => ({ rows: [], hasMore: false }),
        getTagsByIds: async (ids) => rows.filter((t) => ids.includes(t.tagId)),
        getHierarchyChildren: async () => [],
        countTags: async () => 0,
      };
      const r = await describeTagTool.run({ tagIds: ['t1', 'tX'] }, { tags: [], catalog });
      expect(r.ok).toBe(true);
      const data = r.data as { tags: DescribedTag[]; missing: string[] };
      expect(data.tags[0].tagId).toBe('t1');
      expect(data.tags[0].governedMetadata).toEqual({ usl: 100 });
      expect(data.missing).toEqual(['tX']);
    });

    it('returns not_found when the service resolves none', async () => {
      const catalog: NonNullable<ToolContext['catalog']> = {
        searchTags: async () => ({ rows: [], hasMore: false }),
        getTagsByIds: async () => [],
        getHierarchyChildren: async () => [],
        countTags: async () => 0,
      };
      const r = await describeTagTool.run({ tagIds: ['tX'] }, { tags: [], catalog });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('not_found');
    });

    it('returns query_failed when the service throws', async () => {
      const catalog: NonNullable<ToolContext['catalog']> = {
        searchTags: async () => ({ rows: [], hasMore: false }),
        getTagsByIds: async () => {
          throw new Error('boom');
        },
        getHierarchyChildren: async () => [],
        countTags: async () => 0,
      };
      const r = await describeTagTool.run({ tagIds: ['t1'] }, { tags: [], catalog });
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('query_failed');
    });
  });
});
