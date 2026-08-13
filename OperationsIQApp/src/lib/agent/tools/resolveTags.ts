/**
 * `resolve_tags` tool — the prerequisite for every analysis tool.
 *
 * The user (and therefore the agent) speaks in tag names, metrics, asset names,
 * or descriptions; the app's query builders need `TagId`s. This tool ranks the
 * cached tag catalog (already scoped to the user via RLS at load time) and
 * returns candidate ids. It issues no query — it reads `ctx.tags`.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import type { TagInfo } from '../../tags';

export interface ResolveTagsArgs {
  /** Free-text terms: tag names, metrics, descriptions, or hierarchy node names. */
  query: string;
  /** Optional asset-hierarchy filter (exact, case-insensitive) on level1..level10. */
  scope?: Partial<
    Record<
      | 'level1' | 'level2' | 'level3' | 'level4' | 'level5'
      | 'level6' | 'level7' | 'level8' | 'level9' | 'level10',
      string
    >
  >;
  /** Max matches to return (default 10). */
  limit?: number;
}

const HAYSTACK_KEYS: (keyof TagInfo)[] = [
  'tagId',
  'tagName',
  'metric',
  'description',
  'level1',
  'level2',
  'level3',
  'level4',
  'level5',
  'level6',
  'level7',
  'level8',
  'level9',
  'level10',
];

const LEVEL_KEYS = [
  'level1', 'level2', 'level3', 'level4', 'level5',
  'level6', 'level7', 'level8', 'level9', 'level10',
] as const;

/**
 * Build the labeled asset path for a tag so the agent sees where a resolved
 * signal sits in the organization, e.g. "Plant A › Line 3 › Station 7" (or with
 * the user's level labels: "Plant=Plant A › Line=Line 3"). Empty levels are
 * skipped. Returns null when the tag has no hierarchy assignment.
 */
function buildAssetPath(tag: TagInfo, ctx: ToolContext): string | null {
  const labels = ctx.terminology?.levelLabels ?? [];
  const parts: string[] = [];
  LEVEL_KEYS.forEach((k, i) => {
    const v = tag[k];
    if (typeof v === 'string' && v.trim()) {
      const label = labels[i];
      parts.push(label ? `${label}: ${v}` : v);
    }
  });
  return parts.length ? parts.join(' › ') : null;
}

/** Shape a catalog tag into a resolve_tags match, including its hierarchy path. */
function toMatch(tag: TagInfo, ctx: ToolContext) {
  return {
    tagId: tag.tagId,
    tagName: tag.tagName,
    metric: tag.metric,
    engUnits: tag.engUnits,
    samplingFrequency: tag.samplingFrequency ?? null,
    assetPath: buildAssetPath(tag, ctx),
  };
}

/** Count how many query terms appear in the tag's searchable text. */
function score(tag: TagInfo, terms: string[]): number {
  const hay = HAYSTACK_KEYS.map((k) => tag[k])
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
}

/** Rank a bounded candidate set by term score and shape the top `limit` matches. */
function rankMatches(candidates: TagInfo[], terms: string[], limit: number, ctx: ToolContext) {
  return candidates
    .map((t) => ({ t, s: score(t, terms) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => toMatch(r.t, ctx));
}

/** Compose the standard resolve_tags success result from shaped matches. */
function matchesResult(
  matches: ReturnType<typeof toMatch>[],
  query: string,
): ToolResult {
  return {
    ok: true,
    summary: matches.length
      ? `Matched ${matches.length} tag(s): ${matches.slice(0, 5).map((m) => m.tagName).join(', ')}${matches.length > 5 ? ', …' : ''}.`
      : `No tags matched "${query}".`,
    data: { matches },
  };
}

export const resolveTagsTool: AgentTool<ResolveTagsArgs> = {
  name: 'resolve_tags',
  readOnly: true,
  description:
    'Find time-series tags (signals) by name, metric, description, asset-hierarchy node, ' +
    'or exact tagId. ALWAYS call this first to turn user-mentioned names into the tagId ' +
    'values that other tools require. If you already have an exact tagId, pass it as the ' +
    'query to confirm it resolves. Each match returns tagId, tagName, metric, engUnits, ' +
    'samplingFrequency, and assetPath (where the tag sits in the asset hierarchy) so you ' +
    'understand what and where the signal is.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search terms — tag names, metrics, or asset names.',
      },
      scope: {
        type: 'object',
        description: 'Optional exact asset-hierarchy filter (level1..level10).',
        properties: {
          level1: { type: 'string' },
          level2: { type: 'string' },
          level3: { type: 'string' },
          level4: { type: 'string' },
          level5: { type: 'string' },
          level6: { type: 'string' },
          level7: { type: 'string' },
          level8: { type: 'string' },
          level9: { type: 'string' },
          level10: { type: 'string' },
        },
        additionalProperties: false,
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['query'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args.query ?? '').trim();
    if (!query) return { ok: false, summary: 'Provide search terms.', error: { code: 'bad_args', message: 'query is required' } };

    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const queryLower = query.toLowerCase();

    // Large-catalog path: let the service narrow the candidates server-side
    // (free-text `contains` + exact scope), then rank/shape the bounded page
    // client-side with the same term score. Note: the server search covers
    // name/id/metric/description, not hierarchy-level names — pure asset-name
    // queries are served by `browse_asset_hierarchy` in large mode.
    if (ctx.catalog) {
      try {
        // Over-fetch a candidate pool so client ranking has room to reorder.
        const take = Math.min(Math.max(limit * 5, 50), 200);
        const { rows } = await ctx.catalog.searchTags(
          { query, scope: args.scope, take },
          ctx.signal,
        );
        const exact = rows.find((t) => t.tagId.toLowerCase() === queryLower);
        if (exact) {
          const match = toMatch(exact, ctx);
          return { ok: true, summary: `Resolved tagId "${exact.tagId}" (${exact.tagName}).`, data: { matches: [match] } };
        }
        return matchesResult(rankMatches(rows, terms, limit, ctx), query);
      } catch (e) {
        return toolError('query_failed', `Tag search failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    let candidates = ctx.tags;
    if (args.scope) {
      candidates = candidates.filter((t) =>
        Object.entries(args.scope!).every(([k, v]) => {
          if (!v) return true;
          const actual = (t as unknown as Record<string, unknown>)[k];
          return typeof actual === 'string' && actual.toLowerCase() === v.toLowerCase();
        }),
      );
    }

    // Exact-id fast path: when the agent already holds a tagId (e.g. returned by
    // another tool), match it directly and short-circuit the fuzzy term scoring.
    const exact = candidates.find((t) => t.tagId.toLowerCase() === queryLower);
    if (exact) {
      const match = toMatch(exact, ctx);
      return {
        ok: true,
        summary: `Resolved tagId "${exact.tagId}" (${exact.tagName}).`,
        data: { matches: [match] },
      };
    }

    return matchesResult(rankMatches(candidates, terms, limit, ctx), query);
  },
};
