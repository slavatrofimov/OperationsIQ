/**
 * `create_investigation` — WRITE. Start a named case to collect findings under.
 *
 * The first half of "close the loop": before the agent can persist evidence or
 * annotations against a case, that case has to exist. Low blast radius (creates
 * one user-owned row). Gated: refused unless `ctx.allowActions` is set by the
 * UI after explicit user confirmation, and never reachable from captured content.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { createInvestigation } from '../../evidence';
import { getActiveInvestigationAccessor } from '../evidenceBridge';

export interface CreateInvestigationArgs {
  name: string;
  description?: string;
}

export const createInvestigationTool: AgentTool<CreateInvestigationArgs> = {
  name: 'create_investigation',
  readOnly: false,
  sideEffect: 'write',
  description:
    'Create a new named investigation (case folder) to collect findings under, returning its id. ' +
    'WRITE ACTION: only call this after the user has clearly asked to start/open an investigation. ' +
    'Prefer an existing investigation when one fits. Persists one user-owned record.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200, description: 'Short, human-friendly case name.' },
      description: { type: 'string', maxLength: 2000, description: 'Optional context for the case.' },
    },
    required: ['name'],
  },
  async run(args, _ctx: ToolContext): Promise<ToolResult> {
    const name = (args.name ?? '').trim();
    if (!name) return toolError('bad_args', 'An investigation needs a non-empty name.');
    try {
      const inv = await createInvestigation(name, args.description?.trim() || undefined);
      // A freshly created case becomes the active capture target (mirrors the
      // manual "Add to investigation" flow), so capture_evidence files into it.
      getActiveInvestigationAccessor()?.set({ id: inv.id, name: inv.name });
      return {
        ok: true,
        summary: `Created investigation "${inv.name}" (id ${inv.id}); it is now the active capture target.`,
        data: { id: inv.id, name: inv.name, description: inv.description, createdIso: inv.created_at.toISOString() },
      };
    } catch (e) {
      return toolError('create_failed', e instanceof Error ? e.message : String(e));
    }
  },
};
