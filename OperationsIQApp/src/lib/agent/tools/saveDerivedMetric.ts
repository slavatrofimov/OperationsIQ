/**
 * `save_derived_metric` — WRITE. Persist a named arithmetic formula over base
 * tags (e.g. efficiency = A / B) so the team can reuse it on the Derived tab.
 *
 * Profile-scoped, so it needs `ctx.profile.id`. Low blast radius (one row). Gated:
 * refused unless `ctx.allowActions` is set after explicit user confirmation.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { saveDerivedMetric, type DerivedTransform } from '../../savedDerivedMetrics';

const TRANSFORMS: readonly DerivedTransform[] = ['none', 'roc', 'rollmean'];

export interface SaveDerivedMetricArgs {
  name: string;
  /** Base tag ids in alias order: index 0 → A, 1 → B, … */
  tagIds: string[];
  /** Arithmetic formula referencing the aliases, e.g. "A / B". */
  formula: string;
  transform?: DerivedTransform;
  /** Rolling-mean window in bins (only used when transform === 'rollmean'). */
  window?: number;
  maxBins?: number;
}

export const saveDerivedMetricTool: AgentTool<SaveDerivedMetricArgs> = {
  name: 'save_derived_metric',
  readOnly: false,
  sideEffect: 'write',
  description:
    'Save a named derived metric — an arithmetic formula (e.g. "A / B") over base tag ids in alias ' +
    'order (index 0 → A, 1 → B, …) — scoped to the active profile, returning its id. WRITE ACTION: ' +
    'only call after the user asks to save/persist a formula. Persists one user-owned record.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      tagIds: { type: 'array', items: { type: 'string' }, description: 'Base tag ids, alias order A,B,C…' },
      formula: { type: 'string', minLength: 1, maxLength: 500, description: 'e.g. "A / B" or "A - B".' },
      transform: { type: 'string', enum: ['none', 'roc', 'rollmean'], default: 'none' },
      window: { type: 'integer', minimum: 1, default: 5 },
      maxBins: { type: 'integer', minimum: 100, default: 1500 },
    },
    required: ['name', 'tagIds', 'formula'],
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const profileId = ctx.profile?.id;
    if (!profileId) return toolError('no_profile', 'No active Connection Profile id; cannot save a profile-scoped metric.');
    const name = (args.name ?? '').trim();
    const formula = (args.formula ?? '').trim();
    const tagIds = (args.tagIds ?? []).map((t) => String(t).trim()).filter(Boolean);
    if (!name) return toolError('bad_args', 'name is required.');
    if (!formula) return toolError('bad_args', 'formula is required.');
    if (tagIds.length === 0) return toolError('bad_args', 'tagIds is required (call resolve_tags first).');

    const transform: DerivedTransform = TRANSFORMS.includes(args.transform as DerivedTransform)
      ? (args.transform as DerivedTransform)
      : 'none';

    try {
      const id = await saveDerivedMetric(profileId, name, {
        tagIds,
        formula,
        transform,
        window: args.window ?? 5,
        maxBins: args.maxBins ?? 1500,
      });
      return {
        ok: true,
        summary: `Saved derived metric "${name}" = ${formula} (id ${id}).`,
        data: { id, name, formula, transform, tagIds },
      };
    } catch (e) {
      return toolError('create_failed', e instanceof Error ? e.message : String(e));
    }
  },
};
