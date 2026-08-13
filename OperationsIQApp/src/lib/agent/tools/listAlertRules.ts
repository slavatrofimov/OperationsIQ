/**
 * `list_alert_rules` — recall what monitoring already exists so the agent does
 * not propose a duplicate alert (or can point the user at an existing one).
 *
 * Read-only wrapper over the shared AlertRule service; runs under the user's
 * token/RLS and only ever sees the user's own rules.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { listAlertRules } from '../../alertRules';

export interface ListAlertRulesArgs {
  /** If provided, only rules watching this tag id are returned. */
  tagId?: string;
}

export const listAlertRulesTool: AgentTool<ListAlertRulesArgs> = {
  name: 'list_alert_rules',
  readOnly: true,
  description:
    'List the current user\'s alert rules (ongoing monitoring: threshold / deviation-band / ' +
    'rate-of-change) with their condition, parameters, status, and notification target. Optionally ' +
    'filter by tagId. Check here before proposing a new alert so you avoid duplicates. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Only return rules watching this tag id.' },
    },
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    let rows;
    try {
      rows = await listAlertRules();
    } catch (e) {
      return toolError('query_failed', e instanceof Error ? e.message : String(e));
    }

    const filterTag = (args.tagId ?? '').trim();
    const nameOf = new Map(ctx.tags.map((t) => [t.tagId, t.tagName]));
    const rules = rows
      .filter((r) => !filterTag || r.tagId === filterTag)
      .map((r) => ({
        id: r.id,
        name: r.name,
        tagId: r.tagId,
        tagName: nameOf.get(r.tagId) ?? r.tagId,
        conditionType: r.conditionType,
        params: r.params,
        status: r.status,
        notificationType: r.notificationType ?? 'in_app',
        notificationTarget: r.notificationTarget,
        createdIso: r.createdAt.toISOString(),
        lastTriggeredIso: r.lastTriggeredAt?.toISOString(),
      }));

    return {
      ok: true,
      summary: rules.length
        ? `${rules.length} alert rule(s)${filterTag ? ` for tag ${filterTag}` : ''}: ${rules.slice(0, 4).map((r) => `${r.name} [${r.conditionType}, ${r.status}]`).join('; ')}${rules.length > 4 ? '; …' : ''}.`
        : `No alert rules${filterTag ? ` for tag ${filterTag}` : ''} yet.`,
      data: { rules, count: rules.length },
    };
  },
};
