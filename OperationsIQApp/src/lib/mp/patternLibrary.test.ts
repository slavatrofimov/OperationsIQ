import { describe, it, expect } from 'vitest';
import type { Label, JobType } from './types';
import {
  patternName,
  patternDuration,
  libraryCategories,
  librarySignals,
  libraryAnalysisTypes,
  filterLibrary,
  sortLibrary,
} from './patternLibrary';

function label(overrides: Partial<Label>): Label {
  return {
    id: 'l1',
    signalId: 'sig-a',
    kind: 'MOTIF',
    startIndex: 10,
    length: 32,
    text: '',
    ...overrides,
  };
}

const labels: Label[] = [
  label({ id: '1', text: 'Startup ramp', category: 'cycle', signalId: 'sig-a', kind: 'MOTIF', createdAt: '2024-07-01T00:00:00Z' }),
  label({ id: '2', text: 'Bearing spike', category: 'fault', signalId: 'sig-b', kind: 'DISCORD', createdAt: '2024-07-03T00:00:00Z' }),
  label({ id: '3', text: '', category: 'cycle', signalId: 'sig-a', kind: 'MOTIF', startIndex: 99, createdAt: '2024-07-02T00:00:00Z' }),
];

describe('patternLibrary', () => {
  it('names a pattern by text, else a kind + location fallback', () => {
    expect(patternName(labels[0])).toBe('Startup ramp');
    expect(patternName(labels[2])).toBe('Pattern @99');
    expect(patternName(label({ text: '', kind: 'DISCORD', startIndex: 5 }))).toBe('Anomaly @5');
  });

  it('lists distinct categories and signals in first-seen order', () => {
    expect(libraryCategories(labels)).toEqual(['cycle', 'fault']);
    expect(librarySignals(labels)).toEqual(['sig-a', 'sig-b']);
  });

  it('filters by kind, category, and signal', () => {
    expect(filterLibrary(labels, { kind: 'DISCORD' }).map((l) => l.id)).toEqual(['2']);
    expect(filterLibrary(labels, { category: 'cycle' }).map((l) => l.id)).toEqual(['1', '3']);
    expect(filterLibrary(labels, { signalId: 'sig-b' }).map((l) => l.id)).toEqual(['2']);
  });

  it('filters by analysis type via the typeFor resolver', () => {
    // Patterns carry only a jobId; typeFor maps that to the run's analysis type.
    const typed: Label[] = [
      label({ id: '1', jobId: 'j-motif' }),
      label({ id: '2', jobId: 'j-discord', kind: 'DISCORD' }),
      label({ id: '3', jobId: 'j-motif' }),
    ];
    const typeFor = (l: Label): JobType | undefined =>
      l.jobId === 'j-motif' ? 'MOTIF_MOMP' : l.jobId === 'j-discord' ? 'DISCORD_DAMP' : undefined;

    expect(libraryAnalysisTypes(typed, typeFor)).toEqual(['MOTIF_MOMP', 'DISCORD_DAMP']);
    expect(
      filterLibrary(typed, { analysisType: 'MOTIF_MOMP' }, undefined, typeFor).map((l) => l.id),
    ).toEqual(['1', '3']);
    expect(
      filterLibrary(typed, { analysisType: 'DISCORD_DAMP' }, undefined, typeFor).map((l) => l.id),
    ).toEqual(['2']);
    // 'all' ignores the resolver entirely.
    expect(filterLibrary(typed, { analysisType: 'all' }, undefined, typeFor)).toHaveLength(3);
  });

  it('text search matches name, category, signal, and friendly name', () => {
    expect(filterLibrary(labels, { text: 'bearing' }).map((l) => l.id)).toEqual(['2']);
    expect(filterLibrary(labels, { text: 'fault' }).map((l) => l.id)).toEqual(['2']);
    const nameFor = (id: string) => (id === 'sig-a' ? 'Pump vib' : id);
    expect(filterLibrary(labels, { text: 'pump' }, nameFor).map((l) => l.id)).toEqual(['1', '3']);
  });

  it('sorts by date, name, kind, and signal', () => {
    expect(sortLibrary(labels, 'date', 'asc').map((l) => l.id)).toEqual(['1', '3', '2']);
    expect(sortLibrary(labels, 'date', 'desc').map((l) => l.id)).toEqual(['2', '3', '1']);
    expect(sortLibrary(labels, 'name', 'asc').map((l) => l.id)[0]).toBe('2'); // "Bearing spike"
    expect(sortLibrary(labels, 'kind', 'asc').map((l) => l.id)[0]).toBe('2'); // DISCORD < MOTIF
  });

  it('derives a real duration from the persisted temporal resolution', () => {
    // 60 samples at 60s/sample = 3600s = 1h.
    expect(patternDuration(label({ length: 60, secondsPerSample: 60 }))).toBe('1 h');
    // No resolution stored -> undefined (caller falls back to sample count).
    expect(patternDuration(label({ length: 60 }))).toBeUndefined();
    // Guard against nonsense resolutions.
    expect(patternDuration(label({ length: 60, secondsPerSample: 0 }))).toBeUndefined();
    expect(patternDuration(label({ length: 0, secondsPerSample: 60 }))).toBeUndefined();
  });
});
