import { describe, it, expect } from 'vitest';
import { patternId, shortPatternId } from './patternId';

describe('patternId', () => {
  it('builds a traceable id from run, kind, and rank', () => {
    expect(patternId('abcdef12-3456-7890', 'motif', 1)).toBe('P-ABCDEF12-M1');
    expect(patternId('abcdef12-3456-7890', 'discord', 2)).toBe('P-ABCDEF12-D2');
    expect(patternId('abcdef12-3456-7890', 'chain', 3)).toBe('P-ABCDEF12-L3');
    expect(patternId('abcdef12-3456-7890', 'regime', 1)).toBe('P-ABCDEF12-R1');
    expect(patternId('abcdef12-3456-7890', 'consensus', 1)).toBe('P-ABCDEF12-C1');
  });

  it('defends against bad ranks', () => {
    expect(patternId('id', 'motif', 0)).toBe('P-ID-M1');
    expect(patternId('id', 'motif', NaN)).toBe('P-ID-M1');
    expect(patternId('id', 'motif', 2.9)).toBe('P-ID-M2');
  });

  it('short form omits the run segment', () => {
    expect(shortPatternId('motif', 1)).toBe('M1');
    expect(shortPatternId('discord', 4)).toBe('D4');
  });

  it('is stable for the same inputs', () => {
    expect(patternId('run-x', 'motif', 1)).toBe(patternId('run-x', 'motif', 1));
  });
});
