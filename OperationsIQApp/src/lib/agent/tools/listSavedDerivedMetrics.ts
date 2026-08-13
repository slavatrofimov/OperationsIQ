/**
 * `list_saved_derived_metrics` — recall the agreed formulas for the active
 * profile so the agent reuses them instead of re-deriving from scratch.
 *
 * Derived metrics (e.g. efficiency = power / flow) are scoped to a Connection
 * Profile, so this needs `ctx.profile.id`. Read-only under the user's token/RLS.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { listDerivedMetrics } from '../../savedDerivedMetrics';

export type ListSavedDerivedMetricsArgs = Record<string, never>;

export const listSavedDerivedMetricsTool: AgentTool<ListSavedDerivedMetricsArgs> = {
  name: 'list_saved_derived_metrics',
  readOnly: true,
  description:
    'List the saved derived metrics (named arithmetic formulas over base tags, e.g. "A - B") for the ' +
    'active Connection Profile, with each formula, its base tag ids, and any post-transform. Check ' +
    'here before re-deriving a metric so you reuse the team\'s agreed definition. Read-only.',
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx: ToolContext): Promise<ToolResult> {
    const profileId = ctx.profile?.id;
    if (!profileId) {
      return toolError('no_profile', 'No active Connection Profile id; cannot list profile-scoped derived metrics.');
    }
    let rows;
    try {
      rows = await listDerivedMetrics(profileId);
    } catch (e) {
      return toolError('query_failed', e instanceof Error ? e.message : String(e));
    }

    const nameOf = new Map(ctx.tags.map((t) => [t.tagId, t.tagName]));
    const metrics = rows.map((r) => ({
      id: r.id,
      name: r.name,
      formula: r.definition.formula,
      transform: r.definition.transform,
      baseTags: r.definition.tagIds.map((id) => ({ tagId: id, tagName: nameOf.get(id) ?? id })),
      createdIso: r.createdAt.toISOString(),
    }));

    return {
      ok: true,
      summary: metrics.length
        ? `${metrics.length} saved derived metric(s): ${metrics.slice(0, 4).map((m) => `${m.name} (${m.formula})`).join('; ')}${metrics.length > 4 ? '; …' : ''}.`
        : 'No saved derived metrics for this profile yet.',
      data: { metrics, count: metrics.length },
    };
  },
};
