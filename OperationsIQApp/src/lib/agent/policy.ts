/**
 * Tool execution policy — the guardrail seam for side effects.
 *
 * Side-effecting tools fall into two independent families, each unlocked by its
 * own user toggle (least privilege — one grant never leaks into the other):
 *   - `'appControl'` tools DRIVE the visible app (navigate / set params / run).
 *     Unlocked by "Allow app control" → `ctx.allowAppControl`.
 *   - `'write'` tools PERSIST data (create / capture / add / save). Unlocked by
 *     "Allow actions on your behalf" → `ctx.allowActions`.
 *
 * This module centralizes that decision so:
 *   - the rule is enforced in one place (the dispatcher calls `checkToolPolicy`);
 *   - it is unit-testable without the whole registry;
 *   - each grant is a localized, auditable change here plus the UI toggle that
 *     sets it (never a silent bypass).
 *
 * This is also a prompt-injection guardrail: a captured-screen turn carries
 * neither grant, so it can only run read-only tools.
 */

import type { AnyAgentTool, SideEffect, ToolContext } from './types';

export type PolicyResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/** Whether `ctx` holds the grant that unlocks the given side-effect family. */
function hasGrant(kind: SideEffect, ctx: ToolContext): boolean {
  return kind === 'appControl' ? !!ctx.allowAppControl : !!ctx.allowActions;
}

/** The user-facing name of the toggle that unlocks a side-effect family. */
function grantLabel(kind: SideEffect): string {
  return kind === 'appControl' ? '"Allow app control"' : '"Allow actions on your behalf"';
}

/** Decide whether `tool` may run under `ctx`. */
export function checkToolPolicy(tool: AnyAgentTool, ctx: ToolContext): PolicyResult {
  if (tool.readOnly) return { ok: true };

  // A side-effecting tool that omits `sideEffect` defaults to the more sensitive
  // 'write' family, so an unclassified mutator can never run on the lighter grant.
  const kind: SideEffect = tool.sideEffect ?? 'write';
  if (hasGrant(kind, ctx)) return { ok: true };

  return {
    ok: false,
    code: 'not_permitted',
    message:
      `Tool ${tool.name} requires the user to enable ${grantLabel(kind)} for this session, ` +
      `which is not on. Ask them to turn it on (or use a read-only tool instead).`,
  };
}
