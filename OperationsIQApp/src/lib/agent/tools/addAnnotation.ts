/**
 * `add_annotation` — WRITE. Pin a free-text note to a tag at a point or span in
 * time (e.g. "bearing replaced here", "flagged discord — verify").
 *
 * Tag-scoped only: scope `id`/`label` are set to the tag's id/name so the agent
 * never has to plumb hierarchy levels. Low blast radius (one user-owned row). Gated:
 * refused unless `ctx.allowActions` is set after explicit user confirmation.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { createAnnotation } from '../../annotations';

export interface AddAnnotationArgs {
  tagId: string;
  title: string;
  detail?: string;
  /** Point-in-time (ISO 8601 UTC). */
  timestampIso: string;
  /** Optional span end (ISO 8601 UTC); omit for a point annotation. */
  endTimestampIso?: string;
  /** Free-form category, e.g. "note", "maintenance", "discord". Default "note". */
  annotationType?: string;
}

export const addAnnotationTool: AgentTool<AddAnnotationArgs> = {
  name: 'add_annotation',
  readOnly: false,
  sideEffect: 'write',
  description:
    'Pin a free-text annotation to a tag at a point or span in time, returning its id. Times are ISO ' +
    '8601 UTC; omit endTimestampIso for a point note. WRITE ACTION: only call after the user asks to ' +
    'record/note something. Persists one user-owned record.',
  parameters: {
    type: 'object',
    properties: {
      tagId: { type: 'string', description: 'Tag id to attach the note to (from resolve_tags).' },
      title: { type: 'string', minLength: 1, maxLength: 200, description: 'Short note title.' },
      detail: { type: 'string', maxLength: 4000, description: 'Optional longer note body.' },
      timestampIso: { type: 'string', description: 'Point time (ISO 8601, UTC).' },
      endTimestampIso: { type: 'string', description: 'Optional span end (ISO 8601, UTC).' },
      annotationType: { type: 'string', maxLength: 64, default: 'note' },
    },
    required: ['tagId', 'title', 'timestampIso'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const tagId = (args.tagId ?? '').trim();
    const title = (args.title ?? '').trim();
    if (!tagId) return toolError('bad_args', 'tagId is required (call resolve_tags first).');
    if (!title) return toolError('bad_args', 'title is required.');

    const ts = new Date(args.timestampIso);
    if (Number.isNaN(ts.getTime())) return toolError('bad_args', 'timestampIso must be a valid ISO 8601 datetime.');
    let end: Date | undefined;
    if (args.endTimestampIso) {
      end = new Date(args.endTimestampIso);
      if (Number.isNaN(end.getTime())) return toolError('bad_args', 'endTimestampIso must be a valid ISO 8601 datetime.');
      if (end <= ts) return toolError('bad_args', 'endTimestampIso must be after timestampIso.');
    }

    const tag = ctx.tags.find((t) => t.tagId === tagId);
    const label = tag?.tagName ?? tagId;

    try {
      const created = await createAnnotation({
        annotationType: (args.annotationType ?? 'note').trim() || 'note',
        title,
        detail: args.detail?.trim() || undefined,
        timestamp: ts,
        endTimestamp: end,
        scope: { type: 'TagId', id: tagId, label },
      });
      return {
        ok: true,
        summary: `Added ${end ? 'span' : 'point'} annotation "${title}" to ${label} (id ${created.id}).`,
        data: { id: created.id, tagId, label, timestampIso: ts.toISOString(), endTimestampIso: end?.toISOString() },
      };
    } catch (e) {
      return toolError('create_failed', e instanceof Error ? e.message : String(e));
    }
  },
};
