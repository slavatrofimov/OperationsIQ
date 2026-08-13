/**
 * `browse_asset_hierarchy` — enumerate the asset tree one level at a time.
 *
 * `resolve_tags` is fuzzy search; this is deterministic navigation. Given an
 * (optional) hierarchy node, it lists the distinct child node names at the next
 * level and how many tags sit under each, so the agent can orient itself in an
 * unfamiliar plant ("what lines are under Factory 1?") before drilling in. Reads
 * `ctx.tags`; no query, no state.
 */

import type { AgentTool, ToolContext, ToolResult, CatalogAccess } from '../types';
import { toolError } from '../types';
import type { TagInfo } from '../../tags';

/** The hierarchy levels an agent can pin to navigate down the tree. */
export interface BrowseAssetHierarchyArgs {
  /** Exact node selection for levels already chosen, e.g. { level1: "Plant A" }. */
  node?: Partial<Record<
    'level1' | 'level2' | 'level3' | 'level4' | 'level5' |
    'level6' | 'level7' | 'level8' | 'level9' | 'level10', string>>;
}

const LEVELS = [
  'level1', 'level2', 'level3', 'level4', 'level5',
  'level6', 'level7', 'level8', 'level9', 'level10',
] as const;

type LevelKey = (typeof LEVELS)[number];

export const browseAssetHierarchyTool: AgentTool<BrowseAssetHierarchyArgs> = {
  name: 'browse_asset_hierarchy',
  readOnly: true,
  description:
    'Navigate the asset hierarchy deterministically. Given an optional node (exact level1..level10 ' +
    'selections already made), returns the distinct child node names at the NEXT level with a tag ' +
    'count for each, plus any tags directly at the current node. Use this to orient in an unfamiliar ' +
    'plant before resolve_tags. Reads the catalog only.',
  parameters: {
    type: 'object',
    properties: {
      node: {
        type: 'object',
        description: 'Exact hierarchy selections already made (level1..level10).',
        properties: Object.fromEntries(LEVELS.map((l) => [l, { type: 'string' }])),
        additionalProperties: false,
      },
    },
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const node = args.node ?? {};
    // The pinned levels and the next unpinned level are the same regardless of
    // which backing store answers the query.
    const pinned = LEVELS.filter((l) => node[l] && String(node[l]).trim());
    const deepestPinned = pinned.length ? LEVELS.indexOf(pinned[pinned.length - 1] as LevelKey) : -1;
    const nextLevel = LEVELS[deepestPinned + 1];
    const pathLabel = pinned.map((l) => node[l]).join(' / ');

    // Large-catalog path: enumerate the level server-side (summarize by the next
    // level + counts) instead of scanning the in-memory catalog.
    if (ctx.catalog) {
      try {
        return await browseViaService(ctx.catalog, node, nextLevel, pathLabel, ctx.signal);
      } catch (e) {
        return toolError('query_failed', `Hierarchy navigation failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Filter tags that match every pinned level (case-insensitive exact).
    const matches = ctx.tags.filter((t) =>
      pinned.every((l) => {
        const v = (t as unknown as Record<string, unknown>)[l];
        return typeof v === 'string' && v.toLowerCase() === String(node[l]).toLowerCase();
      }),
    );
    if (matches.length === 0) {
      return toolError('not_found', 'No tags match the given hierarchy node.');
    }

    const childCounts = new Map<string, number>();
    let directTags = 0;
    for (const t of matches) {
      const child = nextLevel ? ((t as unknown as Record<string, unknown>)[nextLevel] as string | undefined) : undefined;
      if (child && child.trim()) childCounts.set(child, (childCounts.get(child) ?? 0) + 1);
      else directTags += 1;
    }

    const children = [...childCounts.entries()]
      .map(([name, tagCount]) => ({ name, tagCount }))
      .sort((a, b) => b.tagCount - a.tagCount);

    const directTagList =
      directTags > 0
        ? matches
            .filter((t) => !nextLevel || !((t as unknown as Record<string, unknown>)[nextLevel] as string | undefined)?.trim())
            .slice(0, 25)
            .map((t: TagInfo) => ({ tagId: t.tagId, tagName: t.tagName }))
        : [];

    return shapeBrowse({
      pathLabel,
      nextLevel,
      children,
      directTagCount: directTags,
      directTagList,
      totalTagsUnderNode: matches.length,
    });
  },
};

/** Computed fields shared by the in-memory and service paths. */
interface BrowseComputed {
  pathLabel: string;
  nextLevel: LevelKey | undefined;
  children: { name: string; tagCount: number }[];
  directTagCount: number;
  directTagList: { tagId: string; tagName: string }[];
  totalTagsUnderNode: number;
}

/** Shape computed hierarchy fields into the browse_asset_hierarchy result. */
function shapeBrowse(c: BrowseComputed): ToolResult {
  return {
    ok: true,
    summary: c.children.length
      ? `${c.pathLabel || 'Root'} → ${c.children.length} child node(s) at ${c.nextLevel}: ${c.children.slice(0, 6).map((x) => x.name).join(', ')}${c.children.length > 6 ? ', …' : ''}.`
      : `${c.pathLabel || 'Root'} has ${c.totalTagsUnderNode} tag(s) and no deeper hierarchy level.`,
    data: {
      node: c.pathLabel || null,
      nextLevel: c.children.length ? c.nextLevel : null,
      children: c.children,
      directTagCount: c.directTagCount,
      directTags: c.directTagList,
      totalTagsUnderNode: c.totalTagsUnderNode,
    },
  };
}

/**
 * Enumerate one hierarchy node via the catalog service: a count for the total
 * under the node, a summarize-by-next-level for child counts, and (when tags sit
 * directly at the node) a bounded sample of their ids. `directTagCount` is exact
 * (total − Σ child counts); the `directTags` list is a best-effort name-ordered
 * sample.
 */
async function browseViaService(
  catalog: CatalogAccess,
  node: BrowseAssetHierarchyArgs['node'] & object,
  nextLevel: LevelKey | undefined,
  pathLabel: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const scope = node as Record<string, string | undefined>;
  const total = await catalog.countTags({ scope }, signal);
  if (total === 0) {
    return toolError('not_found', 'No tags match the given hierarchy node.');
  }

  let children: { name: string; tagCount: number }[] = [];
  let childSum = 0;
  if (nextLevel) {
    const values = await catalog.getHierarchyChildren({ scope, childKey: nextLevel }, signal);
    children = values
      .map((v) => ({ name: v.value, tagCount: v.count }))
      .sort((a, b) => b.tagCount - a.tagCount);
    childSum = children.reduce((s, c) => s + c.tagCount, 0);
  }
  const directTagCount = Math.max(0, total - childSum);

  let directTagList: { tagId: string; tagName: string }[] = [];
  if (directTagCount > 0) {
    const { rows } = await catalog.searchTags({ scope }, signal);
    directTagList = rows
      .filter((t) => !nextLevel || !((t as unknown as Record<string, unknown>)[nextLevel] as string | undefined)?.trim())
      .slice(0, 25)
      .map((t) => ({ tagId: t.tagId, tagName: t.tagName }));
  }

  return shapeBrowse({
    pathLabel,
    nextLevel,
    children,
    directTagCount,
    directTagList,
    totalTagsUnderNode: total,
  });
}
