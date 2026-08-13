import { describe, it, expect } from 'vitest';
import { checkToolPolicy } from './policy';
import type { AnyAgentTool, SideEffect, ToolContext } from './types';

function fakeTool(readOnly: boolean, sideEffect?: SideEffect): AnyAgentTool {
  return {
    name: 'demo',
    description: '',
    readOnly,
    sideEffect,
    parameters: { type: 'object', properties: {} },
    run: async () => ({ ok: true, summary: 'ok' }),
  };
}

describe('checkToolPolicy', () => {
  it('allows read-only tools', () => {
    expect(checkToolPolicy(fakeTool(true), {} as ToolContext)).toEqual({ ok: true });
  });

  it('refuses side-effecting tools by default', () => {
    const r = checkToolPolicy(fakeTool(false, 'write'), {} as ToolContext);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_permitted');
  });

  it('unlocks a write tool only with the actions grant', () => {
    const write = fakeTool(false, 'write');
    expect(checkToolPolicy(write, { allowActions: true } as ToolContext)).toEqual({ ok: true });
    // The app-control grant must NOT leak into writes.
    expect(checkToolPolicy(write, { allowAppControl: true } as ToolContext).ok).toBe(false);
  });

  it('unlocks an app-control tool only with the app-control grant', () => {
    const ctrl = fakeTool(false, 'appControl');
    expect(checkToolPolicy(ctrl, { allowAppControl: true } as ToolContext)).toEqual({ ok: true });
    // The actions grant must NOT leak into UI control.
    expect(checkToolPolicy(ctrl, { allowActions: true } as ToolContext).ok).toBe(false);
  });

  it('treats an unclassified side-effecting tool as a write (needs actions grant)', () => {
    const unclassified = fakeTool(false);
    expect(checkToolPolicy(unclassified, { allowActions: true } as ToolContext)).toEqual({ ok: true });
    expect(checkToolPolicy(unclassified, { allowAppControl: true } as ToolContext).ok).toBe(false);
  });

  it('names the required toggle in the refusal message', () => {
    const write = checkToolPolicy(fakeTool(false, 'write'), {} as ToolContext);
    if (!write.ok) expect(write.message).toContain('Allow actions on your behalf');
    const ctrl = checkToolPolicy(fakeTool(false, 'appControl'), {} as ToolContext);
    if (!ctrl.ok) expect(ctrl.message).toContain('Allow app control');
  });
});
