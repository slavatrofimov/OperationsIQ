/**
 * `list_capabilities` — runtime self-description of the toolset.
 *
 * As the toolbox grows the model tends to hallucinate or forget capabilities.
 * This lets the agent enumerate exactly which tools are registered right now,
 * each with a one-line purpose and whether it can change data — so it routes to
 * real tools and tells the user truthfully what it can do.
 *
 * The tool list is injected via `ctx.capabilities` (populated from the registry
 * at dispatch time) to avoid a static import cycle with `registry.ts`.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';

export interface ListCapabilitiesArgs {
  /** If true, include write (data-changing) tools too. Default true. */
  includeWrite?: boolean;
}

/** One line summarised from a tool's own description (first sentence, capped). */
function oneLine(desc: string): string {
  const first = desc.split(/(?<=\.)\s/)[0] ?? desc;
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

export const listCapabilitiesTool: AgentTool<ListCapabilitiesArgs> = {
  name: 'list_capabilities',
  readOnly: true,
  description:
    'Enumerate the tools you currently have, each with a one-line purpose and a readOnly/write flag. ' +
    'Call this when unsure whether a capability exists, before promising an action, or to give the ' +
    'user an accurate overview of what you can do. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      includeWrite: { type: 'boolean', default: true, description: 'Include data-changing tools.' },
    },
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const all = ctx.capabilities ?? [];
    const includeWrite = args.includeWrite ?? true;
    const tools = all
      .filter((t) => t.name !== 'list_capabilities')
      .filter((t) => (includeWrite ? true : t.readOnly))
      .map((t) => ({ name: t.name, purpose: oneLine(t.description), readOnly: t.readOnly }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const writeCount = tools.filter((t) => !t.readOnly).length;
    return {
      ok: true,
      summary: `${tools.length} tool(s) available — ${tools.length - writeCount} read-only, ${writeCount} write. e.g. ${tools.slice(0, 5).map((t) => t.name).join(', ')}.`,
      data: { tools, total: tools.length, writeCount },
    };
  },
};
