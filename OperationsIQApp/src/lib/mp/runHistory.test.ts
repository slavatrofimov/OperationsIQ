import { describe, it, expect } from 'vitest';
import type { AnalysisJob } from './types';
import {
  shortRunId,
  runTitle,
  runDurationSeconds,
  runDurationLabel,
  runDateMs,
  runParameters,
  runResultCount,
  sortRuns,
  filterRuns,
} from './runHistory';

function job(overrides: Partial<AnalysisJob>): AnalysisJob {
  return {
    id: 'id',
    signalId: 'sig',
    type: 'MOTIF_MOMP',
    windowStart: '2024-07-01T00:00:00Z',
    windowEnd: '2024-07-02T00:00:00Z',
    status: 'SUCCEEDED',
    progressPct: 100,
    ...overrides,
  };
}

describe('runHistory identity + formatting', () => {
  it('derives a short uppercase run id', () => {
    expect(shortRunId('abcdef12-3456-7890-abcd-ef1234567890')).toBe('ABCDEF12');
    expect(shortRunId('')).toBe('—');
  });

  it('uses name then falls back to friendly type', () => {
    expect(runTitle(job({ name: 'My run' }))).toBe('My run');
    expect(runTitle(job({ name: '   ' }))).toBe('Repeating patterns');
  });

  it('prefers computeSeconds, else finished−started', () => {
    expect(runDurationSeconds(job({ computeSeconds: 42 }))).toBe(42);
    expect(
      runDurationSeconds(
        job({ startedAt: '2024-07-01T00:00:00Z', finishedAt: '2024-07-01T00:02:00Z' }),
      ),
    ).toBe(120);
    expect(runDurationSeconds(job({}))).toBeUndefined();
    expect(runDurationLabel(job({}))).toBeUndefined();
    expect(runDurationLabel(job({ computeSeconds: 5 }))).toBeTruthy();
  });

  it('reads a sortable submitted timestamp', () => {
    expect(runDateMs(job({ submittedAt: '2024-07-01T00:00:00Z' }))).toBe(
      Date.parse('2024-07-01T00:00:00Z'),
    );
    expect(runDateMs(job({ submittedAt: undefined }))).toBe(0);
  });
});

describe('runParameters', () => {
  const labelFor = (id: string) => ({ sig: 'Pump vib', s2: 'Pump temp', b: 'Baseline' }[id] ?? id);

  it('shows a single signal and window for a single-series run', () => {
    const p = runParameters(job({ subLen: 128 }), labelFor);
    const labels = p.map((x) => x.label);
    expect(labels).toContain('Signal');
    expect(labels).toContain('Window');
    expect(labels).toContain('Pattern length');
    expect(labels).not.toContain('Sensors required');
    expect(p.find((x) => x.label === 'Signal')?.value).toBe('Pump vib');
    expect(p.find((x) => x.label === 'Pattern length')?.value).toBe('128 samples');
  });

  it('lists multiple signals with a count and k-of-N for multidim runs', () => {
    const p = runParameters(
      job({ type: 'MULTIDIM_MOTIF', signalIds: ['sig', 's2'], nDims: 2 }),
      labelFor,
    );
    expect(p.find((x) => x.label === 'Signals (2)')?.value).toBe('Pump vib, Pump temp');
    expect(p.find((x) => x.label === 'Sensors required')?.value).toBe('2 of 2');
  });

  it('shows the comparison series for AB runs', () => {
    const p = runParameters(
      job({ type: 'AB_MOTIF', compareSignalId: 'b', compareWindowStart: '2024-06-01T00:00:00Z', compareWindowEnd: '2024-06-02T00:00:00Z' }),
      labelFor,
    );
    const cmp = p.find((x) => x.label === 'Comparison (B)');
    expect(cmp?.value).toContain('Baseline');
  });

  it('shows the consensus threshold for consensus runs', () => {
    const p = runParameters(
      job({ type: 'CONSENSUS_MOTIF', signalIds: ['sig', 's2', 'b'], minCount: 2 }),
      labelFor,
    );
    expect(p.find((x) => x.label === 'Consensus threshold')?.value).toBe('at least 2 of 3');
  });

  it('surfaces the full submitted params (results, separation, resolution, aggregation, missing data)', () => {
    const p = runParameters(
      job({
        subLen: 128,
        params: {
          k: 5,
          binSeconds: 60,
          aggregation: 'avg',
          gapFill: 'linear',
          minlag: 120,
        },
      }),
      labelFor,
    );
    expect(p.find((x) => x.label === 'Results returned')?.value).toBe('5');
    expect(p.find((x) => x.label === 'Minimum separation')?.value).toBe('120 samples (~2 h)');
    expect(p.find((x) => x.label === 'Resolution (bin width)')?.value).toBe('1 min');
    expect(p.find((x) => x.label === 'Aggregation')?.value).toBe('Average');
    expect(p.find((x) => x.label === 'Missing data')?.value).toBe('Filled by interpolation');
  });

  it('shows a Pan-MP length scan and "left as gaps" missing-data handling', () => {
    const p = runParameters(
      job({
        params: { lengthMin: 64, lengthMax: 512, lengthStep: 32, gapFill: 'none' },
      }),
      labelFor,
    );
    expect(p.find((x) => x.label === 'Length scan')?.value).toBe('64 → 512 samples, step 32');
    expect(p.find((x) => x.label === 'Missing data')?.value).toBe('Left as gaps');
  });

  it('omits submitted-param rows when no params were persisted', () => {
    const p = runParameters(job({}), labelFor);
    const labels = p.map((x) => x.label);
    expect(labels).not.toContain('Results returned');
    expect(labels).not.toContain('Resolution (bin width)');
    expect(labels).not.toContain('Missing data');
  });
});

describe('runResultCount (best-effort)', () => {
  it('is undefined until the run succeeds', () => {
    expect(runResultCount(job({ status: 'RUNNING' }))).toBeUndefined();
  });

  it('counts a discord list, a single motif, and a consensus shape', () => {
    expect(
      runResultCount(job({ summary: JSON.stringify({ discords: [{}, {}, {}] }) }))?.count,
    ).toBe(3);
    expect(
      runResultCount(job({ summary: JSON.stringify({ motif: { idxA: 1, idxB: 2, dist: 0.1, subLen: 8 } }) }))
        ?.count,
    ).toBe(1);
    expect(
      runResultCount(job({ summary: JSON.stringify({ consensus: true, members: [{}, {}] }) }))?.count,
    ).toBe(1);
  });

  it('is undefined when the summary carries no countable result', () => {
    expect(runResultCount(job({ summary: JSON.stringify({ quality: 0.5 }) }))).toBeUndefined();
    expect(runResultCount(job({ summary: 'not json' }))).toBeUndefined();
  });
});

describe('sortRuns + filterRuns', () => {
  const a = job({ id: 'a', name: 'Alpha', type: 'MOTIF_MOMP', submittedAt: '2024-07-01T00:00:00Z', computeSeconds: 10 });
  const b = job({ id: 'b', name: 'Bravo', type: 'DISCORD_DAMP', submittedAt: '2024-07-03T00:00:00Z', computeSeconds: 30 });
  const c = job({ id: 'c', name: 'Charlie', type: 'DISCORD_DAMP', submittedAt: '2024-07-02T00:00:00Z' });

  it('sorts by date descending by default use', () => {
    const out = sortRuns([a, b, c], 'date', 'desc').map((j) => j.id);
    expect(out).toEqual(['b', 'c', 'a']);
  });

  it('sorts undefined durations last regardless of direction', () => {
    expect(sortRuns([a, b, c], 'duration', 'asc').map((j) => j.id)).toEqual(['a', 'b', 'c']);
    expect(sortRuns([a, b, c], 'duration', 'desc').map((j) => j.id)).toEqual(['b', 'a', 'c']);
  });

  it('filters by type, status, and free text', () => {
    expect(filterRuns([a, b, c], { type: 'DISCORD_DAMP' }).map((j) => j.id)).toEqual(['b', 'c']);
    expect(filterRuns([a, b, c], { text: 'alpha' }).map((j) => j.id)).toEqual(['a']);
    expect(filterRuns([a, b, c], { text: 'b' }).map((j) => j.id)).toEqual(['b']);
  });
});
