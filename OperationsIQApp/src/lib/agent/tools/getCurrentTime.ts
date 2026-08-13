/**
 * `get_current_time` — hands the agent an authoritative clock.
 *
 * LLMs have no reliable notion of "now", so any relative window ("last week",
 * "since yesterday") is guesswork without this. Reads the shared clock from the
 * context (frozen in tests, real time in the app) and returns the current UTC
 * time plus a few ready-made rolling windows the agent can pass straight to
 * analysis tools. No query, no state.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { nowFrom } from '../clock';

export interface GetCurrentTimeArgs {
  /** Reserved for future timezone hints; unused today (all output is UTC). */
  timezone?: string;
}

const DAY = 86_400_000;

export const getCurrentTimeTool: AgentTool<GetCurrentTimeArgs> = {
  name: 'get_current_time',
  readOnly: true,
  description:
    'Return the authoritative current time (UTC, ISO 8601) plus ready-made rolling windows ' +
    '(last 24h / 7d / 30d). ALWAYS call this before building any relative time window — never ' +
    'assume what "now", "today", or "recent" mean. Pair with resolve_time_window for phrases ' +
    'like "last week".',
  parameters: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'Reserved; output is always UTC today.' },
    },
  },
  async run(_args, ctx: ToolContext): Promise<ToolResult> {
    const now = nowFrom(ctx.now);
    const nowIso = now.toISOString();
    const back = (ms: number) => new Date(now.getTime() - ms).toISOString();
    return {
      ok: true,
      summary: `Current time is ${nowIso} (UTC).`,
      data: {
        nowUtc: nowIso,
        timezone: 'UTC',
        today: nowIso.slice(0, 10),
        windows: {
          last24h: { startIso: back(DAY), endIso: nowIso },
          last7d: { startIso: back(7 * DAY), endIso: nowIso },
          last30d: { startIso: back(30 * DAY), endIso: nowIso },
        },
      },
    };
  },
};
