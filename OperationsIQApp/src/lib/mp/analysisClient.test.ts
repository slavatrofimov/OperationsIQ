import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Rayfin client so submitJob/listJobs run without a real Fabric session.
// vi.mock is hoisted, so the fakes are created via vi.hoisted to be available inside it.
const { create, execute, select } = vi.hoisted(() => {
  const execute = vi.fn();
  return {
    create: vi.fn(),
    execute,
    select: vi.fn(() => ({ execute })),
  };
});

vi.mock('../rayfinClient', () => ({
  client: { data: { AnalysisJob: { create, select } } },
  getFabricAccountId: vi.fn(() => 'user-1'),
  ensureFabricSession: vi.fn(async () => true),
}));

import { submitJob, listJobs } from './analysisClient';

beforeEach(() => {
  create.mockReset();
  execute.mockReset();
  select.mockClear();
  create.mockResolvedValue({ id: 'job-1' });
});

describe('submitJob multi-series persistence', () => {
  it('serializes the multi-series selection (signalIds + minCount) into the create payload', async () => {
    // Regression: the submit path used to drop signalIds/minCount, so multidimensional
    // and consensus jobs were dispatched with a single series and Spark rejected them
    // ("requires at least two series"). The full selection must reach persistence.
    await submitJob({
      signalId: 'pressure-01',
      type: 'CONSENSUS_MOTIF',
      windowStart: '2026-06-01T00:00:00.000Z',
      windowEnd: '2026-07-16T00:00:00.000Z',
      signalIds: ['pressure-01', 'pressure-02', 'pressure-03'],
      minCount: 2,
      subLen: 64,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const row = create.mock.calls[0][0];
    expect(row.signalIds).toBe(JSON.stringify(['pressure-01', 'pressure-02', 'pressure-03']));
    expect(row.minCount).toBe(2);
    expect(row.signal_id).toBe('pressure-01');
    expect(row.type).toBe('CONSENSUS_MOTIF');
  });

  it('returns the persisted signalIds on the created job', async () => {
    const job = await submitJob({
      signalId: 's1',
      type: 'MULTIDIM_MOTIF',
      windowStart: '2026-07-01T00:00:00.000Z',
      windowEnd: '2026-07-16T00:00:00.000Z',
      signalIds: ['s1', 's2'],
    });
    expect(job.signalIds).toEqual(['s1', 's2']);
  });

  it('omits signalIds when no multi-series selection is provided (single-series job)', async () => {
    await submitJob({
      signalId: 's1',
      type: 'MOTIF_MOMP',
      windowStart: '2026-07-01T00:00:00.000Z',
      windowEnd: '2026-07-16T00:00:00.000Z',
    });
    const row = create.mock.calls[0][0];
    expect(row.signalIds).toBeUndefined();
  });
});

describe('listJobs signalIds round-trip', () => {
  it('parses the persisted JSON signalIds back into a string array', async () => {
    execute.mockResolvedValue([
      {
        id: 'job-1',
        name: 'Fleet-wide shape',
        signal_id: 'pressure-01',
        type: 'CONSENSUS_MOTIF',
        windowStart: new Date('2026-06-01T00:00:00.000Z'),
        windowEnd: new Date('2026-07-16T00:00:00.000Z'),
        signalIds: JSON.stringify(['pressure-01', 'pressure-02']),
        status: 'QUEUED',
        progressPct: 0,
      },
    ]);

    const jobs = await listJobs();
    expect(jobs[0].signalIds).toEqual(['pressure-01', 'pressure-02']);
  });

  it('leaves signalIds undefined for single-series rows', async () => {
    execute.mockResolvedValue([
      {
        id: 'job-2',
        signal_id: 's1',
        type: 'MOTIF_MOMP',
        windowStart: new Date('2026-07-01T00:00:00.000Z'),
        windowEnd: new Date('2026-07-16T00:00:00.000Z'),
        signalIds: null,
        status: 'QUEUED',
        progressPct: 0,
      },
    ]);

    const jobs = await listJobs();
    expect(jobs[0].signalIds).toBeUndefined();
  });
});
