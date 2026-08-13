/**
 * `get_screen_context` — ambient awareness of what the user is looking at.
 *
 * The panel already lets the user push a full screen snapshot ("Explain this
 * screen"), but that is a heavyweight, explicit action. This lightweight tool
 * lets the agent *pull* the active page's structured state (selected tags,
 * current time window, key settings) on demand, so "forecast this" or "why did
 * it spike here?" resolve against the actual view. Reads the published capture
 * context; no query, no state, no images.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';

export type GetScreenContextArgs = Record<string, never>;

export const getScreenContextTool: AgentTool<GetScreenContextArgs> = {
  name: 'get_screen_context',
  readOnly: true,
  description:
    'Return the active page\'s current UI state as labelled parameters (e.g. selected tags, the ' +
    'time window, key settings) so you can resolve deictic references like "this signal" or "the ' +
    'window on screen" without asking. Text only — no images. Returns empty when the page publishes ' +
    'no context; then ask the user what they mean.',
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx: ToolContext): Promise<ToolResult> {
    const summary = ctx.screenContext?.() ?? null;
    const sections = (summary?.sections ?? [])
      .map((s) => ({
        title: s.title,
        fields: s.fields
          .filter((f) => String(f.value ?? '').trim() !== '')
          .map((f) => ({ label: f.label, value: f.value })),
      }))
      .filter((s) => s.fields.length > 0);

    if (sections.length === 0) {
      return {
        ok: true,
        summary: 'The active page publishes no structured context right now.',
        data: { sections: [], hasContext: false },
      };
    }

    const flat = sections.flatMap((s) => s.fields.map((f) => `${f.label}: ${f.value}`));
    return {
      ok: true,
      summary: `On-screen context — ${flat.slice(0, 4).join('; ')}${flat.length > 4 ? '; …' : ''}.`,
      data: { sections, hasContext: true },
    };
  },
};
