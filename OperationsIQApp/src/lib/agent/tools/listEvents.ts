/**
 * `list_events` — operational events (maintenance, trips, interventions, batch
 * boundaries) overlapping a time window, for one or more scope ids.
 *
 * Anomalies mean little without operational context; this lets the agent say
 * "the spike coincides with a logged shutdown" instead of just "there is a
 * spike". Reuses the app's canonical events query builder (profile-bound via the
 * active connection) and runs read-only under the user's token/RLS.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildEventsQuery } from '../../kql';
import { queryRows } from '../../eventhouse';
import { parseWindow } from '../toolUtils';

export interface ListEventsArgs {
  /** Scope ids to match against Event.ScopeId — tag ids and/or asset-node ids. */
  scopeIds: string[];
  startIso: string;
  endIso: string;
  /** Max events to return (default 50). */
  limit?: number;
}

interface EventRow {
  EventId?: string;
  ScopeId?: string;
  ScopeType?: string;
  StartTimestamp?: string;
  EndTimestamp?: string | null;
  EventType?: string;
  Title?: string;
  Detail?: string;
}

const iso = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

export const listEventsTool: AgentTool<ListEventsArgs> = {
  name: 'list_events',
  readOnly: true,
  description:
    'List operational events (maintenance, incidents, interventions, batch markers) overlapping a ' +
    'window for the given scopeIds (tag ids from resolve_tags and/or asset-node ids). Times are ISO ' +
    '8601 UTC. Returns each event\'s type, title, detail, and start/end. Use it to explain WHY a ' +
    'signal behaves oddly at a point in time. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      scopeIds: { type: 'array', items: { type: 'string' }, description: 'Tag ids and/or asset-node ids.' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
    },
    required: ['scopeIds', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const scopeIds = (args.scopeIds ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (scopeIds.length === 0) return toolError('bad_args', 'scopeIds is required.');
    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);

    let rows: EventRow[];
    try {
      const scopeKeys = scopeIds.flatMap((scopeId) => [
        `TagId|#|${scopeId}`,
        ...Array.from({ length: 10 }, (_, i) => `Level${i + 1}|#|${scopeId}`),
      ]);
      rows = await queryRows<EventRow>(buildEventsQuery(scopeKeys, win.start, win.end), ctx.kqlOpts, {
        signal: ctx.signal,
      });
    } catch (e) {
      return toolError('query_failed', e instanceof Error ? e.message : String(e));
    }

    const events = rows
      .map((r) => ({
        eventId: r.EventId,
        scopeId: r.ScopeId,
        scopeType: r.ScopeType,
        eventType: r.EventType,
        title: r.Title,
        detail: r.Detail || undefined,
        startIso: iso(r.StartTimestamp),
        endIso: iso(r.EndTimestamp),
        kind: r.EndTimestamp ? 'span' : 'point',
      }))
      .sort((a, b) => (a.startIso ?? '').localeCompare(b.startIso ?? ''))
      .slice(0, limit);

    return {
      ok: true,
      summary: events.length
        ? `${events.length} event(s) in ${win.start.toISOString()}..${win.end.toISOString()}: ${events.slice(0, 4).map((e) => e.title || e.eventType).join('; ')}${events.length > 4 ? '; …' : ''}.`
        : `No events for the given scope in that window.`,
      data: { events, count: events.length, truncated: rows.length > limit },
    };
  },
};
