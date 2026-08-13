/**
 * `describe_tag` — full metadata for one or more resolved tag ids.
 *
 * `resolve_tags` returns only id/name/metric/units — enough to route, but not to
 * reason. This tool returns the complete catalog record (description, native
 * sampling frequency, engineering units, and the full asset-hierarchy path) from
 * the already-scoped tag catalog. It reads `ctx.tags`; no query, no state.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import type { TagInfo } from '../../tags';

export interface DescribeTagArgs {
  /** Resolved tag ids (from resolve_tags). */
  tagIds: string[];
}

const LEVELS: (keyof TagInfo)[] = [
  'level1', 'level2', 'level3', 'level4', 'level5',
  'level6', 'level7', 'level8', 'level9', 'level10',
];

function hierarchyPath(tag: TagInfo): string[] {
  const parts: string[] = [];
  for (const lvl of LEVELS) {
    const v = tag[lvl];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    else break;
  }
  return parts;
}

/**
 * Extract the governed process-health metadata present on a tag into a compact
 * object, or `undefined` when the tag carries none. These fields are the org-wide
 * governed "normal / healthy" envelope surfaced from the SignalMetadata store; the
 * agent should prefer them over guessed limits.
 */
function governedMetadata(t: TagInfo): Record<string, number | string> | undefined {
  const m: Record<string, number | string> = {};
  const add = (k: string, v: number | string | undefined) => {
    if (v !== undefined) m[k] = v;
  };
  add('operatingSetpoint', t.operatingSetpoint);
  add('upperOperatingLimit', t.upperOperatingLimit);
  add('lowerOperatingLimit', t.lowerOperatingLimit);
  add('maxRateOfChange', t.maxRateOfChange);
  add('usl', t.usl);
  add('lsl', t.lsl);
  add('target', t.target);
  add('physicalMin', t.physicalMin);
  add('physicalMax', t.physicalMax);
  add('sensorUncertainty', t.sensorUncertainty);
  add('preferredChartType', t.preferredChartType);
  add('ruleProfile', t.ruleProfile);
  add('activeBaselineId', t.activeBaselineId);
  add('recommendedAlertThreshold', t.recommendedAlertThreshold);
  add('recommendedConfidence', t.recommendedConfidence);
  return Object.keys(m).length ? m : undefined;
}

export const describeTagTool: AgentTool<DescribeTagArgs> = {
  name: 'describe_tag',
  readOnly: true,
  description:
    'Return full catalog metadata for resolved tagId(s): tagName, metric, engineering units, ' +
    'description, native sampling frequency, the asset-hierarchy path, and any governed process-health ' +
    'metadata (operating limits, specification limits USL/LSL/target, setpoint, max rate of change, plausible ' +
    'physical range, preferred control-chart profile, and recommended alert threshold/confidence). Call ' +
    'resolve_tags first to get the ids. Use this to ground interpretation (units, where the sensor sits) and to ' +
    'obtain governed limits before an analysis — e.g. feed them into forecast breach ' +
    'thresholds, or alert rules instead of guessing. Reads the catalog only — no time-series query.',
  parameters: {
    type: 'object',
    properties: {
      tagIds: { type: 'array', items: { type: 'string' }, description: 'Resolved tag ids.' },
    },
    required: ['tagIds'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const ids = (args.tagIds ?? []).map((t) => String(t).trim()).filter(Boolean);
    if (ids.length === 0) return toolError('bad_args', 'tagIds is required (call resolve_tags first).');

    // Large-catalog path: resolve the bounded id set server-side instead of
    // scanning the in-memory catalog (which, in large mode, holds only the
    // current selection).
    if (ctx.catalog) {
      try {
        const rows = await ctx.catalog.getTagsByIds(ids, ctx.signal);
        const byId = new Map(rows.map((t) => [t.tagId, t]));
        const found = ids.map((id) => byId.get(id)).filter((t): t is TagInfo => !!t);
        const missing = ids.filter((id) => !byId.has(id));
        return describeResult(found, missing, ids);
      } catch (e) {
        return toolError('query_failed', `Tag lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const byId = new Map(ctx.tags.map((t) => [t.tagId, t]));
    const found = ids.map((id) => byId.get(id)).filter((t): t is TagInfo => !!t);
    const missing = ids.filter((id) => !byId.has(id));
    return describeResult(found, missing, ids);
  },
};

/** Shape resolved tags + missing ids into the describe_tag result (path-agnostic). */
function describeResult(found: TagInfo[], missing: string[], ids: string[]): ToolResult {
  if (found.length === 0) {
    return toolError('not_found', `None of the given tagIds are in the catalog: ${ids.join(', ')}.`);
  }

  const tags = found.map((t) => {
    const path = hierarchyPath(t);
    return {
      tagId: t.tagId,
      tagName: t.tagName,
      metric: t.metric || undefined,
      engUnits: t.engUnits || undefined,
      description: t.description || undefined,
      samplingFrequency: t.samplingFrequency || undefined,
      hierarchyPath: path,
      hierarchyPathLabel: path.join(' / ') || undefined,
      governedMetadata: governedMetadata(t),
    };
  });

  const withLimits = tags.filter((t) => t.governedMetadata).length;
  return {
    ok: true,
    summary:
      `Described ${tags.length} tag(s): ` +
      tags.map((t) => `${t.tagName}${t.engUnits ? ` (${t.engUnits})` : ''}`).slice(0, 5).join(', ') +
      (withLimits ? ` (${withLimits} with governed limits)` : '') +
      (missing.length ? `. ${missing.length} id(s) not found.` : '.'),
    data: { tags, missing },
  };
}
