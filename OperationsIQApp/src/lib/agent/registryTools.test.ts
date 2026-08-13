import { describe, it, expect, vi } from 'vitest';

// Neutralize browser-only transitive imports pulled in by the real tools
// (echarts for chart rendering, msal for the Kusto token). These metadata-only
// assertions never render a chart or fetch a token.
vi.mock('echarts', () => ({ init: vi.fn() }));
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

import { AGENT_TOOLS, toolDefinitions, functionToolDefs } from './registry';

const NAME_RE = /^[a-z][a-z0-9_]*$/;

interface PropShape {
  type?: string;
  items?: unknown;
  enum?: unknown[];
}

describe('agent tool registry metadata', () => {
  it('registers a healthy set of tools with unique names', () => {
    expect(AGENT_TOOLS.length).toBeGreaterThanOrEqual(19);
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('advertises the expected page-backed analysis tools', () => {
    const names = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const expected of [
      'resolve_tags',
      'forecast',
      'forecast_detail',
      'series_detail',
      'explore_signals',
      'decompose_signal',
      'monitor_deviation',
      'control_chart',
      'detect_discords',
      'find_similar_patterns',
      'rank_causes',
      'causality_matrix',
      'regression_analysis',
      'validate_signal',
      'segment_cycles',
      'compute_derived_metric',
      'compare_periods',
      'run_scenario',
      'temporal_heatmap',
    ]) {
      expect(names.has(expected), `missing tool: ${expected}`).toBe(true);
    }
  });

  it('every tool is snake_cased and richly described; only known mutators are side-effecting', () => {
    // Two families of side-effecting tools are allowed, each gated INDEPENDENTLY
    // by policy.checkToolPolicy + its own consent toggle: (1) the UI-control tools
    // that DRIVE the app (navigate/set/run → sideEffect 'appControl'), and (2) the
    // persistence "write" tools (create/add/save → sideEffect 'write'). Everything
    // else must be read-only.
    const EXPECTED_SIDE_EFFECTING: Record<string, 'appControl' | 'write'> = {
      navigate_to_page: 'appControl',
      set_page_params: 'appControl',
      run_current_page: 'appControl',
      create_investigation: 'write',
      set_active_investigation: 'write',
      capture_evidence: 'write',
      add_annotation: 'write',
      save_derived_metric: 'write',
    };
    for (const t of AGENT_TOOLS) {
      const expectedKind = EXPECTED_SIDE_EFFECTING[t.name];
      const shouldBeReadOnly = !expectedKind;
      expect(t.readOnly, `${t.name} readOnly should be ${shouldBeReadOnly}`).toBe(shouldBeReadOnly);
      // Side-effecting tools must declare the grant family that unlocks them so the
      // policy can enforce least privilege; read-only tools must not.
      if (expectedKind) {
        expect(t.sideEffect, `${t.name} must declare sideEffect '${expectedKind}'`).toBe(expectedKind);
      } else {
        expect(t.sideEffect, `${t.name} (read-only) must not declare a sideEffect`).toBeUndefined();
      }
      expect(t.name, `${t.name} name shape`).toMatch(NAME_RE);
      // A useful, disambiguating description per the design guide.
      expect(t.description.length, `${t.name} description too short`).toBeGreaterThan(40);
      expect(typeof t.run).toBe('function');
    }
  });

  it('advertises the expected read-only side tools', () => {
    const names = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const expected of [
      'get_current_time',
      'resolve_time_window',
      'describe_tag',
      'browse_asset_hierarchy',
      'list_events',
      'get_data_coverage',
      'get_screen_context',
      'get_active_profile',
      'list_capabilities',
      'explain_method',
      'list_saved_derived_metrics',
      'list_alert_rules',
    ]) {
      expect(names.has(expected), `missing tool: ${expected}`).toBe(true);
      expect(AGENT_TOOLS.find((t) => t.name === expected)?.readOnly, `${expected} should be read-only`).toBe(true);
    }
  });

  it('advertises the gated write tools as non-read-only', () => {
    const byName = new Map(AGENT_TOOLS.map((t) => [t.name, t]));
    for (const expected of [
      'create_investigation',
      'set_active_investigation',
      'capture_evidence',
      'add_annotation',
      'save_derived_metric',
    ]) {
      const tool = byName.get(expected);
      expect(tool, `missing write tool: ${expected}`).toBeDefined();
      expect(tool?.readOnly, `${expected} must be readOnly:false`).toBe(false);
      // Persistence writes must announce themselves with a write-verb prefix and
      // flag the blast radius in the description, per the tool design guide.
      expect(/^(create|save|add|apply|update|delete|set|capture)_/.test(expected), `${expected} needs a write-verb prefix`).toBe(true);
      expect(tool?.description, `${expected} must flag itself as a WRITE ACTION`).toMatch(/WRITE/);
    }
  });

  it('advertises the UI-control tools that let the agent drive the app', () => {
    const names = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const expected of [
      'describe_current_page',
      'read_current_results',
      'navigate_to_page',
      'set_page_params',
      'run_current_page',
    ]) {
      expect(names.has(expected), `missing tool: ${expected}`).toBe(true);
    }
  });

  it('every tool exposes a structurally valid object schema', () => {
    for (const t of AGENT_TOOLS) {
      const schema = t.parameters;
      expect(schema.type, `${t.name} params must be an object`).toBe('object');
      const props = schema.properties ?? {};
      // Required fields must actually be declared as properties.
      for (const req of schema.required ?? []) {
        expect(props[req], `${t.name}: required '${req}' missing from properties`).toBeDefined();
      }
      // Every property must declare a type, and enums/items must be well-formed.
      for (const [key, def] of Object.entries(props)) {
        const p = def as PropShape;
        expect(p.type, `${t.name}.${key} needs a type`).toBeTruthy();
        if (p.type === 'array') {
          expect(p.items, `${t.name}.${key} array needs items`).toBeDefined();
        }
        if (p.enum) {
          expect(Array.isArray(p.enum) && p.enum.length > 0, `${t.name}.${key} enum`).toBe(true);
        }
      }
    }
  });

  it('emits one function definition per registered tool', () => {
    const defs = toolDefinitions();
    expect(defs.length).toBe(AGENT_TOOLS.length);
    for (const d of defs) {
      expect(d.type).toBe('function');
      expect(d.function.name).toMatch(NAME_RE);
      expect(d.function.parameters).toBeDefined();
    }
  });

  it('emits flattened function-tool defs (Foundry agents shape)', () => {
    const defs = functionToolDefs();
    expect(defs.length).toBe(AGENT_TOOLS.length);
    const names = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const d of defs) {
      expect(d.type).toBe('function');
      // Flattened: name/description/parameters at the top level, no nesting.
      expect(d).not.toHaveProperty('function');
      expect(names.has(d.name)).toBe(true);
      expect(d.name).toMatch(NAME_RE);
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.parameters).toBeDefined();
      expect(d.strict).toBeUndefined();
    }
  });
});
