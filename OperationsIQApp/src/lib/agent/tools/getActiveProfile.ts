/**
 * `get_active_profile` — report the data scope the agent is confined to.
 *
 * Lets the Operations Advisor answer "what can you see?" honestly: the active Connection
 * Profile's name and a one-line scope description. It never widens access — it
 * only describes the boundary the user's token + RLS already enforce. Reads
 * `ctx.profile`; no query, no state.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';

export type GetActiveProfileArgs = Record<string, never>;

export const getActiveProfileTool: AgentTool<GetActiveProfileArgs> = {
  name: 'get_active_profile',
  readOnly: true,
  description:
    'Return the active Connection Profile (name, business description, and technical scope) plus ' +
    'the size of the tag catalog and the domain terminology in effect (what each hierarchy level ' +
    'and entity/signal is called). Use it to tell the user what data is in scope, speak their ' +
    'vocabulary, and explain that you cannot see other profiles/tenants. Read-only.',
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx: ToolContext): Promise<ToolResult> {
    const p = ctx.profile;
    const tagCount = ctx.tags.length;
    const terminology = ctx.terminology
      ? {
          entity: ctx.terminology.entityLabel,
          signal: ctx.terminology.metricIdLabel,
          unitOfMeasure: ctx.terminology.unitOfMeasureLabel,
          samplingFrequency: ctx.terminology.samplingFrequencyLabel,
          hierarchyLevels: ctx.terminology.levelLabels,
        }
      : null;
    if (!p?.name) {
      return {
        ok: true,
        summary: `No named Connection Profile is active; ${tagCount} tag(s) are in scope.`,
        data: { profileName: null, description: null, scopeDescription: null, tagCount, terminology },
      };
    }
    return {
      ok: true,
      summary: `Active profile "${p.name}"${p.scopeDescription ? ` — ${p.scopeDescription}` : ''}; ${tagCount} tag(s) in scope.`,
      data: {
        profileName: p.name,
        description: p.description ?? null,
        scopeDescription: p.scopeDescription ?? null,
        tagCount,
        terminology,
      },
    };
  },
};
