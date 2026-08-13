import { describe, it, expect, vi } from 'vitest';

// spectrum.ts -> eventhouse.ts pulls in msal/env; stub them so the pure parser
// can be imported headless (mirrors periods.test / robustDeviation.test).
vi.mock('./msal', () => ({
  getEventhouseToken: vi.fn(async () => 'fake'),
  EventhouseSignInRequiredError: class extends Error {},
  notifyEventhouseSignInRequired: vi.fn(),
}));
vi.mock('./env', () => ({ env: { eventhouseQueryUri: 'https://c', eventhouseDb: 'db' } }));
vi.mock('./activeConnection', () => ({
  getActiveKqlOpts: () => undefined,
  getActiveProfileId: () => undefined,
  getActiveTimeseriesRef: () => 'Timeseries',
  getActiveTimeseriesIsWide: () => false,
  getActiveSignalIdDelimiter: () => '-',
  getActiveHierarchyRef: () => 'TagHierarchy',
  getActiveMetadataRef: () => 'TagMetadata',
  getActiveEventsRef: () => 'Events',
}));

import type { KustoTable } from './eventhouse';
import { parseSpectrum, findPeaks, type SpectrumBin } from './spectrum';
import {
  parseSpectrogram,
  nearestPow2,
  largestPow2AtMost,
  chooseSpectrogramWindow,
  hopFromOverlap,
} from './spectrum';
import { buildSpectrumQuery, buildSpectrogramQuery } from './kql';

function fftTable(re: number[], im: number[]): KustoTable {
  return {
    name: 'PrimaryResult',
    columns: [
      { name: 'SignalId', type: 'string' },
      { name: 'Timestamp', type: 'dynamic' },
      { name: 'Value', type: 'dynamic' },
      { name: 'FreqReal', type: 'dynamic' },
      { name: 'FreqImag', type: 'dynamic' },
    ],
    rows: [['tag-1', [], [], re, im]],
  };
}

describe('parseSpectrum', () => {
  it('returns null on an empty table', () => {
    const empty: KustoTable = { name: 'PrimaryResult', columns: [], rows: [] };
    expect(parseSpectrum(empty, 60)).toBeNull();
  });

  it('drops the DC bin and keeps the lower half of the spectrum', () => {
    // N=8: half = 4, so bins index 1..4 are kept.
    const re = [10, 0, 5, 0, 1, 0, 5, 0];
    const im = [0, 0, 0, 0, 0, 0, 0, 0];
    const s = parseSpectrum(fftTable(re, im), 60)!;
    expect(s).not.toBeNull();
    expect(s.n).toBe(8);
    expect(s.bins.map((b) => b.index)).toEqual([1, 2, 3, 4]);
  });

  it('computes magnitude, frequency, and equivalent period per bin', () => {
    // N=4, binSeconds=60. Bin 1: mag=sqrt(3²+4²)=5, freq=1/4 cyc/bin,
    // period=4 bins=240s.
    const re = [0, 3, 0, 3];
    const im = [0, 4, 0, -4];
    const s = parseSpectrum(fftTable(re, im), 60)!;
    const b1 = s.bins.find((b) => b.index === 1)!;
    expect(b1.magnitude).toBeCloseTo(5);
    expect(b1.freqPerBin).toBeCloseTo(0.25);
    expect(b1.freqHz).toBeCloseTo(0.25 / 60);
    expect(b1.periodBins).toBeCloseTo(4);
    expect(b1.periodSeconds).toBeCloseTo(240);
  });

  it('ranks the dominant peak first', () => {
    // A clear spike at bin 2 dominates.
    const re = [0, 1, 20, 1, 0, 1, 2, 1];
    const im = new Array(8).fill(0);
    const s = parseSpectrum(fftTable(re, im), 30)!;
    expect(s.peaks[0].index).toBe(2);
    expect(s.peaks[0].magnitude).toBeCloseTo(20);
  });

  it('treats null FFT components as zero', () => {
    const re = [0, 5, null as unknown as number, 0];
    const im = [0, 0, 0, 0];
    const s = parseSpectrum(fftTable(re, im), 60)!;
    expect(s.bins.find((b) => b.index === 2)!.magnitude).toBe(0);
  });
});

describe('findPeaks', () => {
  const mk = (mags: number[]): SpectrumBin[] =>
    mags.map((m, i) => ({
      index: i + 1,
      freqPerBin: 0,
      freqHz: 0,
      periodBins: 0,
      periodSeconds: 0,
      magnitude: m,
    }));

  it('returns strict local maxima ranked by magnitude, capped at max', () => {
    const peaks = findPeaks(mk([1, 5, 1, 3, 1, 8, 1]), 2);
    expect(peaks.map((p) => p.magnitude)).toEqual([8, 5]);
  });

  it('ignores zero-magnitude bins', () => {
    expect(findPeaks(mk([0, 0, 0]))).toHaveLength(0);
  });
});

describe('buildSpectrumQuery', () => {
  it('runs series_fft on the gap-filled series and guards the tag literal', () => {
    const q = buildSpectrumQuery({
      tagId: 'motor-1',
      start: new Date('2024-01-01T00:00:00Z'),
      end: new Date('2024-01-02T00:00:00Z'),
      binKql: '1m',
    });
    expect(q).toContain('series_fft(Value)');
    expect(q).toContain('series_fill_linear(Value)');
    expect(q).toContain("where SignalId == 'motor-1'");
    expect(q).toContain('project SignalId, Timestamp, Value, FreqReal, FreqImag');
  });
});

describe('spectrogram framing helpers', () => {
  it('largestPow2AtMost returns the largest power of two <= n', () => {
    expect(largestPow2AtMost(0)).toBe(0);
    expect(largestPow2AtMost(1)).toBe(1);
    expect(largestPow2AtMost(31)).toBe(16);
    expect(largestPow2AtMost(256)).toBe(256);
    expect(largestPow2AtMost(300)).toBe(256);
  });

  it('nearestPow2 rounds to the nearest power of two (ties up)', () => {
    expect(nearestPow2(1)).toBe(1);
    expect(nearestPow2(3)).toBe(4); // tie between 2 and 4 rounds up
    expect(nearestPow2(60)).toBe(64);
    expect(nearestPow2(100)).toBe(128);
  });

  it('chooseSpectrogramWindow returns 0 when too short and a clamped pow2 otherwise', () => {
    expect(chooseSpectrogramWindow(31)).toBe(0);
    // n/16 = 64 -> 64, within [32, 256]
    expect(chooseSpectrogramWindow(1024)).toBe(64);
    // very large series clamp at 256
    expect(chooseSpectrogramWindow(100000)).toBe(256);
    // small-but-valid series never exceeds the series length
    expect(chooseSpectrogramWindow(40)).toBeLessThanOrEqual(40);
    expect(chooseSpectrogramWindow(40)).toBeGreaterThanOrEqual(32);
  });

  it('hopFromOverlap maps overlap percent to a bounded hop', () => {
    expect(hopFromOverlap(64, 0)).toBe(64); // no overlap -> full window
    expect(hopFromOverlap(64, 50)).toBe(32);
    expect(hopFromOverlap(64, 75)).toBe(16);
    expect(hopFromOverlap(64, 100)).toBe(1); // clamped to >= 1
  });
});

describe('buildSpectrogramQuery', () => {
  it('frames the gap-filled series and runs series_fft per frame', () => {
    const q = buildSpectrogramQuery({
      tagId: 'motor-1',
      start: new Date('2024-01-01T00:00:00Z'),
      end: new Date('2024-01-02T00:00:00Z'),
      binKql: '1m',
      windowBins: 64,
      hopBins: 32,
    });
    expect(q).toContain('series_fill_linear(Value)');
    expect(q).toContain("where SignalId == 'motor-1'");
    // guard: drop the row when the series is shorter than one window
    expect(q).toContain('where N >= 64');
    // framing via range/mv-expand/array_slice with the hop and window constants
    expect(q).toContain('NumFrames = (N - 64) / 32 + 1');
    expect(q).toContain('mv-expand FrameIndex = range(0, NumFrames - 1, 1)');
    expect(q).toContain('array_slice(Value, FrameStartIdx, FrameStartIdx + 64 - 1)');
    expect(q).toContain('series_fft(Frame)');
    expect(q).toContain('project SignalId, FrameIndex = toint(FrameIndex)');
  });

  it('rejects non-integer window/hop constants', () => {
    expect(() =>
      buildSpectrogramQuery({
        tagId: 't',
        start: new Date('2024-01-01T00:00:00Z'),
        end: new Date('2024-01-02T00:00:00Z'),
        binKql: '1m',
        windowBins: 64.5,
        hopBins: 32,
      }),
    ).toThrow();
  });
});

function spectrogramTable(
  frames: { frameIndex: number; startIdx: number; re: number[]; im: number[] }[],
): KustoTable {
  return {
    name: 'PrimaryResult',
    columns: [
      { name: 'SignalId', type: 'string' },
      { name: 'FrameIndex', type: 'int' },
      { name: 'FrameStartIdx', type: 'int' },
      { name: 'FreqReal', type: 'dynamic' },
      { name: 'FreqImag', type: 'dynamic' },
    ],
    rows: frames.map((f) => ['tag-1', f.frameIndex, f.startIdx, f.re, f.im]),
  };
}

describe('parseSpectrogram', () => {
  const start = new Date('2024-01-01T00:00:00Z');

  it('returns null on an empty table', () => {
    const empty: KustoTable = { name: 'PrimaryResult', columns: [], rows: [] };
    expect(parseSpectrogram(empty, 60, start)).toBeNull();
  });

  it('drops DC + mirror half and computes per-frame magnitudes, freqs and center times', () => {
    // Window of 4 -> half = 2 bins per frame. Two frames, hop = 2.
    const t = spectrogramTable([
      { frameIndex: 0, startIdx: 0, re: [0, 3, 0, 3], im: [0, 4, 0, -4] },
      { frameIndex: 1, startIdx: 2, re: [0, 0, 5, 0], im: [0, 0, 0, 0] },
    ]);
    const sg = parseSpectrogram(t, 60, start)!;
    expect(sg).not.toBeNull();
    expect(sg.windowBins).toBe(4);
    expect(sg.half).toBe(2);
    expect(sg.hopBins).toBe(2);
    expect(sg.frames).toHaveLength(2);
    // bin 1 magnitude = sqrt(3^2 + 4^2) = 5
    expect(sg.frames[0].magnitudes[0]).toBeCloseTo(5);
    // freq of bin k=1 with window 4, 60s bins: (1/4)/60
    expect(sg.freqHz[0]).toBeCloseTo(0.25 / 60);
    // frame 0 center = start + (0 + 4/2)*60s = +120s
    expect(sg.frames[0].centerMs).toBe(start.getTime() + 120_000);
    // frame 1 center = start + (2 + 2)*60s = +240s
    expect(sg.frames[1].centerMs).toBe(start.getTime() + 240_000);
  });

  it('sorts frames by frame index regardless of row order', () => {
    const t = spectrogramTable([
      { frameIndex: 2, startIdx: 4, re: [0, 1, 0, 1], im: [0, 0, 0, 0] },
      { frameIndex: 0, startIdx: 0, re: [0, 2, 0, 2], im: [0, 0, 0, 0] },
      { frameIndex: 1, startIdx: 2, re: [0, 3, 0, 3], im: [0, 0, 0, 0] },
    ]);
    const sg = parseSpectrogram(t, 30, start)!;
    expect(sg.frames.map((f) => f.frameIndex)).toEqual([0, 1, 2]);
    expect(sg.hopBins).toBe(2);
  });

  it('treats null FFT components as zero', () => {
    const t = spectrogramTable([
      { frameIndex: 0, startIdx: 0, re: [0, null as unknown as number, 0, 0], im: [0, 0, 0, 0] },
    ]);
    const sg = parseSpectrogram(t, 60, start)!;
    expect(sg.frames[0].magnitudes[0]).toBe(0);
  });
});
