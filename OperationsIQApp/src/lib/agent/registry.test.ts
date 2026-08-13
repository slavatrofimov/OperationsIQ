import { describe, it, expect, vi } from 'vitest';

// Neutralize the heavy/browser-only transitive imports pulled in via the real
// tools (echarts for chart rendering, msal for the Kusto token). The dispatcher
// paths under test (policy -> JSON parse -> schema validation -> resolve_tags)
// never touch them.
vi.mock('echarts', () => ({}));
vi.mock('../msal', () => ({
  getEventhouseToken: vi.fn(),
  getFabricApiToken: vi.fn(),
  notifyEventhouseSignInRequired: vi.fn(),
  EventhouseSignInRequiredError: class extends Error {},
}));
vi.mock('../rayfinClient', () => ({
  client: {},
  getFabricAccountId: vi.fn(() => ''),
  getFabricAccountEmail: vi.fn(() => ''),
}));

import { dispatchTool } from './registry';
import type { ToolContext } from './types';
import type { TagInfo } from '../tags';

function tag(p: Partial<TagInfo>): TagInfo {
  return { tagId: 't?', tagName: '', metric: '', description: '', engUnits: '', ...p } as TagInfo;
}

const ctx: ToolContext = {
  tags: [tag({ tagId: 't1', tagName: 'Boiler Temp', metric: 'Temperature' })],
};

describe('dispatchTool', () => {
  it('rejects an unknown tool', async () => {
    const r = await dispatchTool('does_not_exist', '{}', ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('unknown_tool');
  });

  it('rejects invalid JSON arguments', async () => {
    const r = await dispatchTool('resolve_tags', '{ not json', ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('bad_args');
  });

  it('rejects arguments that violate the advertised schema', async () => {
    const r = await dispatchTool('resolve_tags', JSON.stringify({}), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('bad_args');
    expect(r.error?.message).toMatch(/query is required/);
  });

  it('runs a valid, schema-conformant call', async () => {
    const r = await dispatchTool('resolve_tags', JSON.stringify({ query: 'boiler' }), ctx);
    expect(r.ok).toBe(true);
    const matches = (r.data as { matches: { tagId: string }[] }).matches;
    expect(matches[0].tagId).toBe('t1');
  });

  it('refuses a write tool unless the context opts in', async () => {
    const r = await dispatchTool('create_investigation', JSON.stringify({ name: 'Case 1' }), ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('not_permitted');
  });

  it('injects the toolset self-description for list_capabilities', async () => {
    const r = await dispatchTool('list_capabilities', '{}', ctx);
    expect(r.ok).toBe(true);
    const data = r.data as { total: number; tools: { name: string }[] };
    expect(data.total).toBeGreaterThan(10);
    // The registry-derived list must include a well-known analysis tool.
    expect(data.tools.some((t) => t.name === 'forecast')).toBe(true);
    // And must never advertise list_capabilities itself.
    expect(data.tools.some((t) => t.name === 'list_capabilities')).toBe(false);
  });
});
