/**
 * `resolve_time_window` — turn a natural-language time phrase into concrete
 * ISO-8601 UTC start/end datetimes the analysis tools require.
 *
 * The user speaks in phrases ("last week", "yesterday", "the past 3 months");
 * every analysis tool needs explicit startIso/endIso. This tool bridges the gap
 * using the shared clock, so the agent never invents a window. Returns null-safe
 * failure (ok:false) when a phrase is not understood so the agent asks for
 * explicit dates instead of guessing.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { nowFrom, resolveRelativeWindow } from '../clock';

export interface ResolveTimeWindowArgs {
  /** e.g. "last 7 days", "yesterday", "this month", "last quarter". */
  phrase: string;
}

export const resolveTimeWindowTool: AgentTool<ResolveTimeWindowArgs> = {
  name: 'resolve_time_window',
  readOnly: true,
  description:
    'Convert a natural-language time phrase into an explicit { startIso, endIso } UTC window ' +
    'for the analysis tools. Understands "today", "yesterday", "last|past N minutes|hours|days|' +
    'weeks|months|quarters|years", "this/last week|month|quarter|year", and "YTD/MTD". Resolved ' +
    'against the current time. Returns ok:false when the phrase is ambiguous — then ask the user ' +
    'for explicit dates rather than guessing.',
  parameters: {
    type: 'object',
    properties: {
      phrase: { type: 'string', description: 'The time phrase to resolve, e.g. "last 7 days".' },
    },
    required: ['phrase'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const phrase = String(args.phrase ?? '').trim();
    if (!phrase) return toolError('bad_args', 'phrase is required.');
    const now = nowFrom(ctx.now);
    const win = resolveRelativeWindow(phrase, now);
    if (!win) {
      return toolError(
        'unresolved',
        `Could not interpret "${phrase}" as a time window. Ask the user for explicit start/end dates (ISO 8601, UTC).`,
      );
    }
    return {
      ok: true,
      summary: `"${phrase}" → ${win.label}: ${win.startIso} to ${win.endIso} (UTC).`,
      data: { startIso: win.startIso, endIso: win.endIso, label: win.label, resolvedAgainst: now.toISOString() },
    };
  },
};
