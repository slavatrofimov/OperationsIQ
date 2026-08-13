/**
 * `get_data_coverage` — the pre-flight check before analysis.
 *
 * The agent should never analyze a window blind. This returns, per tag, the
 * earliest/latest sample, raw row count, an estimated sampling cadence, the
 * fraction of the requested window that is covered, and how stale the last value
 * is. It lets the agent avoid empty/stale windows and hedge honestly when a
 * result rests on thin data. Read-only under the user's token/RLS.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { buildCoverageQuery } from '../../kql';
import { queryRows } from '../../eventhouse';
import { parseWindow, round } from '../toolUtils';
import { nowFrom } from '../clock';

export interface GetDataCoverageArgs {
  tagIds: string[];
  startIso: string;
  endIso: string;
  /** A window is considered "stale" if the last sample is older than this many minutes before now. Default 60. */
  staleAfterMinutes?: number;
}

interface CoverageRow {
  SignalId?: string;
  FirstTs?: string;
  LastTs?: string;
  Cnt?: number;
  MinV?: number | null;
  MaxV?: number | null;
  AvgV?: number | null;
}

const ms = (v: unknown): number | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

export const getDataCoverageTool: AgentTool<GetDataCoverageArgs> = {
  name: 'get_data_coverage',
  readOnly: true,
  description:
    'Pre-flight data check for tagId(s) over a window: first/last sample, raw row count, estimated ' +
    'sampling cadence, % of the window covered, and staleness (age of the last value). Call this ' +
    'BEFORE a heavier analysis to confirm the window actually has fresh data, and to caveat results ' +
    'that rest on sparse data. Times are ISO 8601 UTC. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      tagIds: { type: 'array', items: { type: 'string' }, description: 'Resolved tag ids.' },
      startIso: { type: 'string', description: 'Window start (ISO 8601, UTC).' },
      endIso: { type: 'string', description: 'Window end (ISO 8601, UTC).' },
      staleAfterMinutes: { type: 'integer', minimum: 1, default: 60 },
    },
    required: ['tagIds', 'startIso', 'endIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagIds = (args.tagIds ?? []).map((t) => String(t).trim()).filter(Boolean);
    if (tagIds.length === 0) return toolError('bad_args', 'tagIds is required (call resolve_tags first).');
    const win = parseWindow(args.startIso, args.endIso);
    if ('error' in win) return toolError('bad_args', win.error);
    const now = nowFrom(ctx.now);
    const staleMs = (args.staleAfterMinutes ?? 60) * 60_000;
    const windowMs = win.end.getTime() - win.start.getTime();

    let rows: CoverageRow[];
    try {
      rows = await queryRows<CoverageRow>(
        buildCoverageQuery({ tagIds, start: win.start, end: win.end, timeseriesRef: ctx.timeseriesRef }),
        ctx.kqlOpts,
        { signal: ctx.signal },
      );
    } catch (e) {
      return toolError('query_failed', e instanceof Error ? e.message : String(e));
    }

    const byId = new Map(rows.map((r) => [String(r.SignalId), r]));
    const tags = tagIds.map((id) => {
      const r = byId.get(id);
      const cnt = Number(r?.Cnt ?? 0);
      if (!r || cnt === 0) {
        return { tagId: id, hasData: false, count: 0, coveragePct: 0, stale: true };
      }
      const first = ms(r.FirstTs);
      const last = ms(r.LastTs);
      const spanMs = first != null && last != null ? last - first : 0;
      const cadenceSec = cnt > 1 && spanMs > 0 ? round(spanMs / (cnt - 1) / 1000) : null;
      // Coverage: observed span relative to the requested window.
      const coveragePct = windowMs > 0 && spanMs >= 0 ? round(Math.min(100, (spanMs / windowMs) * 100)) : null;
      const ageMs = last != null ? now.getTime() - last : null;
      return {
        tagId: id,
        hasData: true,
        firstIso: first != null ? new Date(first).toISOString() : undefined,
        lastIso: last != null ? new Date(last).toISOString() : undefined,
        count: cnt,
        cadenceSec,
        coveragePct,
        lastValueAgeMinutes: ageMs != null ? round(ageMs / 60_000) : null,
        stale: ageMs != null ? ageMs > staleMs : true,
        min: round(r.MinV ?? null),
        max: round(r.MaxV ?? null),
        avg: round(r.AvgV ?? null),
      };
    });

    const empties = tags.filter((t) => !t.hasData).map((t) => t.tagId);
    const stale = tags.filter((t) => t.hasData && t.stale).map((t) => t.tagId);

    return {
      ok: true,
      summary:
        `Coverage for ${tags.length} tag(s): ` +
        (empties.length ? `${empties.length} EMPTY (${empties.slice(0, 3).join(', ')}); ` : '') +
        (stale.length ? `${stale.length} stale; ` : '') +
        `${tags.filter((t) => t.hasData).length} with data.`,
      data: {
        tags,
        caveats:
          'Coverage % is the observed first→last span vs. the requested window, so an evenly-sampled ' +
          'but short-lived signal can read <100%. Cadence is an average (total span / (count-1)), not a ' +
          'guarantee of even sampling. Treat EMPTY or stale tags as not analyzable until data arrives.',
      },
    };
  },
};
