/**
 * `set_active_investigation` — WRITE. Make an existing investigation the active
 * capture target, so subsequent `capture_evidence` calls file into it.
 *
 * Changes app state (the app-wide active-investigation preference), so it is
 * `readOnly:false` and refused unless `ctx.allowActions` is set after the
 * user enabled actions/control, and never reachable from a captured-screen turn.
 * Low blast radius (a client-side preference), but gated for consistency.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { listInvestigations } from '../../evidence';
import { getActiveInvestigationAccessor } from '../evidenceBridge';

export interface SetActiveInvestigationArgs {
  investigationId: string;
}

export const setActiveInvestigationTool: AgentTool<SetActiveInvestigationArgs> = {
  name: 'set_active_investigation',
  readOnly: false,
  sideEffect: 'write',
  description:
    'Make an existing investigation the active capture target, so later capture_evidence calls file ' +
    'into it. WRITE ACTION: use list_investigations to find the id first, and only switch when the user ' +
    'asked to work in that case. To start a brand-new case, use create_investigation instead (it becomes ' +
    'active automatically).',
  parameters: {
    type: 'object',
    properties: {
      investigationId: {
        type: 'string',
        minLength: 1,
        description: 'Id of an existing investigation (see list_investigations).',
      },
    },
    required: ['investigationId'],
    additionalProperties: false,
  },
  async run(args, _ctx: ToolContext): Promise<ToolResult> {
    const id = (args.investigationId ?? '').trim();
    if (!id) return toolError('bad_args', 'An investigationId is required.');

    const accessor = getActiveInvestigationAccessor();
    if (!accessor) {
      return toolError('unavailable', 'Investigation activation is not available right now.');
    }

    let rows;
    try {
      rows = await listInvestigations();
    } catch (e) {
      return toolError('query_failed', e instanceof Error ? e.message : String(e));
    }
    const match = rows.find((r) => r.id === id);
    if (!match) {
      return toolError('not_found', `No investigation with id "${id}". Use list_investigations to see valid ids.`);
    }

    accessor.set({ id: match.id, name: match.name });
    return {
      ok: true,
      summary: `Active investigation is now "${match.name}". New evidence will be captured here.`,
      data: { id: match.id, name: match.name },
    };
  },
};
