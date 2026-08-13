import { describe, it, expect, vi } from 'vitest';

// series_detail pulls downsampleMinMax from lib/forecast, which transitively
// imports eventhouse -> msal (which touches `window`). Stub msal so the module
// graph loads under the node test environment; this test never fetches a token.
vi.mock('../msal', () => ({
  getEventhouseToken: vi.fn(),
  getFabricApiToken: vi.fn(),
  notifyEventhouseSignInRequired: vi.fn(),
  EventhouseSignInRequiredError: class extends Error {},
}));

import { putSeries, getSeries } from './seriesCache';
import { seriesDetailTool } from './tools/seriesDetail';
import type { ToolContext } from './types';

const ctx = { tags: [] } as unknown as ToolContext;

describe('seriesCache + series_detail drill-down', () => {
  it('round-trips a cached multi-track series and records trackNames', () => {
    const x = [0, 60_000, 120_000];
    const id = putSeries(x, { value: [1, 2, 3], baseline: [1, 1, 1] }, { kind: 'test', signalId: 't1' });
    const entry = getSeries(id);
    expect(entry).toBeDefined();
    expect(entry!.meta.trackNames).toEqual(['value', 'baseline']);
    expect(entry!.x).toHaveLength(3);
  });

  it('returns full-resolution points for the requested track and window', async () => {
    const x = [0, 60_000, 120_000, 180_000];
    const id = putSeries(x, { value: [10, 20, 30, 40] }, { kind: 'test' });
    const r = await seriesDetailTool.run(
      { seriesId: id, tracks: ['value'], fromIso: new Date(60_000).toISOString(), toIso: new Date(180_000).toISOString() },
      ctx,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { points: { value: number }[]; downsampled: boolean };
    expect(data.downsampled).toBe(false);
    expect(data.points.map((p) => p.value)).toEqual([20, 30, 40]);
  });

  it('errors clearly on an unknown seriesId', async () => {
    const r = await seriesDetailTool.run({ seriesId: 'sr_does_not_exist' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('not_found');
  });

  it('rejects a request for tracks that do not exist', async () => {
    const id = putSeries([0, 1], { value: [1, 2] }, { kind: 'test' });
    const r = await seriesDetailTool.run({ seriesId: id, tracks: ['missing'] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('bad_args');
  });
});
