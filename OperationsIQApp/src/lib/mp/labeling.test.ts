import { describe, it, expect } from 'vitest';
import { propagateLabel, spansOverlap, labelMatchesTarget, type Span } from './labeling';

describe('propagateLabel seed inclusion', () => {
  it('always includes the seed span even when nothing else is similar', () => {
    // A flat MP with a high threshold-independent seed: the seed is in bounds but no
    // neighbor beats the threshold, so only the seed itself should come back.
    const mp = [5, 5, 5, 5];
    const mpi = [-1, -1, -1, -1];
    const spans = propagateLabel({
      seedIndex: 2,
      length: 1,
      mp,
      mpi,
      distThreshold: 0, // nothing is "similar"
      exclusionZone: 0,
    });
    expect(spans).toEqual([{ startIndex: 2, length: 1 }]);
  });

  it('returns an empty array when the seed is out of bounds (the only empty case)', () => {
    const mp = [1, 1, 1];
    const mpi = [1, 2, 0];
    expect(propagateLabel({ seedIndex: -1, length: 1, mp, mpi, distThreshold: 10, exclusionZone: 0 }))
      .toEqual([]);
    expect(propagateLabel({ seedIndex: 3, length: 1, mp, mpi, distThreshold: 10, exclusionZone: 0 }))
      .toEqual([]);
  });

  it('follows the nearest-neighbor graph to collect similar, non-overlapping spans', () => {
    // Seed 0 points at 5 (similar); reverse edges keep expansion bidirectional.
    const mp = [0.1, 9, 9, 9, 9, 0.1];
    const mpi = [5, 0, 0, 0, 0, 0];
    const spans = propagateLabel({
      seedIndex: 0,
      length: 1,
      mp,
      mpi,
      distThreshold: 0.5,
      exclusionZone: 0,
    });
    expect(spans.map((s) => s.startIndex)).toEqual([0, 5]);
  });
});

describe('spansOverlap', () => {
  it('detects overlap and respects the exclusion margin', () => {
    const a: Span = { startIndex: 0, length: 10 };
    expect(spansOverlap(a, { startIndex: 5, length: 3 })).toBe(true);
    expect(spansOverlap(a, { startIndex: 10, length: 3 })).toBe(false);
    // With a margin, adjacent spans are treated as overlapping.
    expect(spansOverlap(a, { startIndex: 12, length: 3 }, 5)).toBe(true);
  });
});

describe('labelMatchesTarget', () => {
  it('matches a label to the target at the same signal + exact start index', () => {
    const label = { signalId: 'vibration-01', startIndex: 655, length: 48 };
    const target = { signalId: 'vibration-01', startIndex: 655, length: 48 };
    expect(labelMatchesTarget(label, target)).toBe(true);
  });

  it('does NOT match a neighboring pattern whose window merely overlaps (D2 label vs D3)', () => {
    // Regression: labeling D2 (start 655) must not tag D3 (start 682) just because their
    // 48-sample windows overlap. Different start index → not the same instance.
    const d2Label = { signalId: 'vibration-01', startIndex: 655, length: 48 };
    const d3Target = { signalId: 'vibration-01', startIndex: 682, length: 48 };
    expect(spansOverlap(d2Label, d3Target)).toBe(true); // windows do overlap…
    expect(labelMatchesTarget(d2Label, d3Target)).toBe(false); // …but it's a different instance
  });

  it('does not match across signals even at the same start index', () => {
    const label = { signalId: 'vibration-01', startIndex: 655, length: 48 };
    const target = { signalId: 'pressure-02', startIndex: 655, length: 48 };
    expect(labelMatchesTarget(label, target)).toBe(false);
  });
});
