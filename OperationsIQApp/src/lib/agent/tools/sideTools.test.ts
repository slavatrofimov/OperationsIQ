import { describe, it, expect, vi } from 'vitest';

// get_data_coverage issues a KQL query; stub the eventhouse client so the tool
// logic (staleness, cadence, coverage math) is what's under test — not I/O.
vi.mock('../../eventhouse', () => ({
  queryRows: vi.fn(),
}));
vi.mock('../msal', () => ({
  getEventhouseToken: vi.fn(),
  getFabricApiToken: vi.fn(),
  notifyEventhouseSignInRequired: vi.fn(),
  EventhouseSignInRequiredError: class extends Error {},
}));

import { queryRows } from '../../eventhouse';
import type { ToolContext } from '../types';
import type { TagInfo } from '../../tags';
import { explainMethodTool } from './explainMethod';
import { getScreenContextTool } from './getScreenContext';
import { getActiveProfileTool } from './getActiveProfile';
import { resolveTimeWindowTool } from './resolveTimeWindow';
import { listCapabilitiesTool } from './listCapabilities';
import { getDataCoverageTool } from './getDataCoverage';

const NOW = new Date('2024-03-13T12:00:00.000Z');
const baseCtx = (over: Partial<ToolContext> = {}): ToolContext => ({ tags: [], now: () => NOW, ...over });

function tag(p: Partial<TagInfo>): TagInfo {
  return { tagId: 't?', tagName: '', metric: '', description: '', engUnits: '', ...p } as TagInfo;
}

describe('explain_method', () => {
  it('lists terms when called without an argument', async () => {
    const r = await explainMethodTool.run({}, baseCtx());
    expect(r.ok).toBe(true);
    expect((r.data as { terms: unknown[] }).terms.length).toBeGreaterThan(3);
  });

  it('returns a grounded definition for a known term', async () => {
    const r = await explainMethodTool.run({ term: 'granger' }, baseCtx());
    expect((r.data as { found: boolean; term: string }).found).toBe(true);
    expect((r.data as { term: string }).term).toBe('granger_causality');
  });

  it('reports found:false for an unknown term without throwing', async () => {
    const r = await explainMethodTool.run({ term: 'wavelet' }, baseCtx());
    expect(r.ok).toBe(true);
    expect((r.data as { found: boolean }).found).toBe(false);
  });
});

describe('get_screen_context', () => {
  it('reports no context when the page publishes none', async () => {
    const r = await getScreenContextTool.run({}, baseCtx({ screenContext: () => null }));
    expect((r.data as { hasContext: boolean }).hasContext).toBe(false);
  });

  it('flattens published sections and drops empty fields', async () => {
    const r = await getScreenContextTool.run(
      {},
      baseCtx({
        screenContext: () => ({
          sections: [
            { title: 'View', fields: [{ label: 'Page', value: 'Explore' }, { label: 'Empty', value: '  ' }] },
          ],
        }),
      }),
    );
    const sections = (r.data as { sections: { fields: unknown[] }[] }).sections;
    expect(sections[0].fields).toHaveLength(1);
  });
});

describe('get_active_profile', () => {
  it('reports the active profile name and tag count', async () => {
    const r = await getActiveProfileTool.run(
      {},
      baseCtx({ tags: [tag({ tagId: 't1' })], profile: { name: 'Plant A', scopeDescription: 'db@uri' } }),
    );
    expect(r.summary).toMatch(/Plant A/);
    expect((r.data as { tagCount: number }).tagCount).toBe(1);
  });

  it('surfaces the business description and terminology when present', async () => {
    const r = await getActiveProfileTool.run(
      {},
      baseCtx({
        tags: [tag({ tagId: 't1' })],
        profile: { name: 'Plant A', scopeDescription: 'db@uri', description: 'North boiler house' },
        terminology: {
          entityLabel: 'Asset',
          metricIdLabel: 'Signal',
          unitOfMeasureLabel: 'Units',
          samplingFrequencyLabel: 'Cadence',
          levelLabels: ['Plant', 'Line'],
        },
      }),
    );
    const data = r.data as {
      description: string | null;
      terminology: { entity: string; hierarchyLevels: string[] } | null;
    };
    expect(data.description).toBe('North boiler house');
    expect(data.terminology?.entity).toBe('Asset');
    expect(data.terminology?.hierarchyLevels).toEqual(['Plant', 'Line']);
  });

  it('returns null description and terminology when none are set', async () => {
    const r = await getActiveProfileTool.run(
      {},
      baseCtx({ tags: [tag({ tagId: 't1' })], profile: { name: 'Plant A' } }),
    );
    const data = r.data as { description: string | null; terminology: unknown };
    expect(data.description).toBeNull();
    expect(data.terminology).toBeNull();
  });
});

describe('resolve_time_window', () => {
  it('resolves a phrase against the shared clock', async () => {
    const r = await resolveTimeWindowTool.run({ phrase: 'yesterday' }, baseCtx());
    expect(r.ok).toBe(true);
    expect((r.data as { startIso: string }).startIso).toBe('2024-03-12T00:00:00.000Z');
  });

  it('fails cleanly on an uninterpretable phrase', async () => {
    const r = await resolveTimeWindowTool.run({ phrase: 'when the line tripped' }, baseCtx());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('unresolved');
  });
});

describe('list_capabilities', () => {
  it('enumerates injected capabilities and can hide write tools', async () => {
    const caps = [
      { name: 'forecast', description: 'Forecast a signal into the future with a prediction band.', readOnly: true },
      { name: 'save_derived_metric', description: 'WRITE: persist a named arithmetic formula for the active profile.', readOnly: false },
      { name: 'list_capabilities', description: 'Enumerate the tools you currently have available.', readOnly: true },
    ];
    const all = await listCapabilitiesTool.run({}, baseCtx({ capabilities: caps }));
    // Excludes itself; keeps the other two.
    expect((all.data as { total: number }).total).toBe(2);
    expect((all.data as { writeCount: number }).writeCount).toBe(1);

    const readOnly = await listCapabilitiesTool.run({ includeWrite: false }, baseCtx({ capabilities: caps }));
    expect((readOnly.data as { writeCount: number }).writeCount).toBe(0);
    expect((readOnly.data as { total: number }).total).toBe(1);
  });
});

describe('get_data_coverage', () => {
  const mockRows = vi.mocked(queryRows);
  const ctx = baseCtx({ timeseriesRef: 'Timeseries' });

  it('flags a tag as fresh with a plausible cadence', async () => {
    mockRows.mockResolvedValueOnce([
      {
        SignalId: 't1',
        FirstTs: '2024-03-13T00:00:00.000Z',
        LastTs: '2024-03-13T11:59:00.000Z', // 1 min before NOW → fresh
        Cnt: 720, // ~one sample/min over ~12h
        MinV: 10,
        MaxV: 20,
        AvgV: 15,
      },
    ]);
    const r = await getDataCoverageTool.run(
      { tagIds: ['t1'], startIso: '2024-03-13T00:00:00Z', endIso: '2024-03-13T12:00:00Z' },
      ctx,
    );
    expect(r.ok).toBe(true);
    const t = (r.data as { tags: { hasData: boolean; stale: boolean; cadenceSec: number }[] }).tags[0];
    expect(t.hasData).toBe(true);
    expect(t.stale).toBe(false);
    expect(t.cadenceSec).toBeGreaterThan(0);
  });

  it('marks a missing tag as empty and stale', async () => {
    mockRows.mockResolvedValueOnce([]); // no rows for the requested tag
    const r = await getDataCoverageTool.run(
      { tagIds: ['t2'], startIso: '2024-03-13T00:00:00Z', endIso: '2024-03-13T12:00:00Z' },
      ctx,
    );
    const t = (r.data as { tags: { hasData: boolean; stale: boolean }[] }).tags[0];
    expect(t.hasData).toBe(false);
    expect(t.stale).toBe(true);
  });

  it('rejects an empty tag list', async () => {
    const r = await getDataCoverageTool.run(
      { tagIds: [], startIso: '2024-03-13T00:00:00Z', endIso: '2024-03-13T12:00:00Z' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('bad_args');
  });
});
