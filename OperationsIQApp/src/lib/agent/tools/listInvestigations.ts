/**
 * `list_investigations` — read-only recall of the user's investigation cases so
 * the agent can propose reusing an existing case (and see which one is the
 * active capture target) before starting a new one.
 *
 * Read-only under the user's token / RLS: only the signed-in user's own
 * investigations are ever returned.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { listInvestigations } from '../../evidence';
import { getActiveInvestigationAccessor } from '../evidenceBridge';

export type ListInvestigationsArgs = Record<string, never>;

export const listInvestigationsTool: AgentTool<ListInvestigationsArgs> = {
  name: 'list_investigations',
  readOnly: true,
  description:
    'List the current user\'s investigations (case folders for collecting evidence), most recently ' +
    'updated first, and flag which one is the active capture target. Check here before creating a new ' +
    'investigation so you can reuse an existing one, or to find the id to pass to ' +
    'set_active_investigation / capture_evidence. Read-only.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, _ctx: ToolContext): Promise<ToolResult> {
    let rows;
    try {
      rows = await listInvestigations();
    } catch (e) {
      return toolError('query_failed', e instanceof Error ? e.message : String(e));
    }

    const activeId = getActiveInvestigationAccessor()?.get()?.id;
    const investigations = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isActive: r.id === activeId,
      updatedIso: r.updated_at.toISOString(),
    }));

    const activeName = investigations.find((i) => i.isActive)?.name;
    return {
      ok: true,
      summary: investigations.length
        ? `${investigations.length} investigation(s)${activeName ? `; active: "${activeName}"` : '; none active'}.`
        : 'No investigations yet. Create one with create_investigation to start collecting evidence.',
      data: { investigations, count: investigations.length, activeId: activeId ?? null },
    };
  },
};
