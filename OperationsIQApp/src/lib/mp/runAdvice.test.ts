import { describe, expect, it } from 'vitest';
import { runAdvice } from './runAdvice';

describe('runAdvice', () => {
  it('withholds advice while the job is running', () => {
    expect(runAdvice({ family: 'motif', resultCount: 0, running: true })).toBeUndefined();
  });

  it('suggests a longer pattern when a motif run finds nothing', () => {
    const a = runAdvice({ family: 'motif', resultCount: 0 });
    expect(a?.tone).toBe('suggestion');
    expect(a?.detail.toLowerCase()).toContain('longer pattern');
  });

  it('reassures when a discord run finds nothing', () => {
    const a = runAdvice({ family: 'discord', resultCount: 0 });
    expect(a?.tone).toBe('suggestion');
    expect(a?.headline.toLowerCase()).toContain('anomalous');
  });

  it('is positive for a strong motif', () => {
    const a = runAdvice({ family: 'motif', resultCount: 3, topMotifStrength: 'strong' });
    expect(a?.tone).toBe('positive');
    expect(a?.headline).toContain('3 patterns');
  });

  it('suggests tuning for a weak motif', () => {
    const a = runAdvice({ family: 'motif', resultCount: 1, topMotifStrength: 'weak' });
    expect(a?.tone).toBe('suggestion');
    expect(a?.headline).toContain('1 pattern');
    expect(a?.headline).not.toContain('1 patterns');
  });

  it('is positive for a strong discord and pluralizes correctly', () => {
    const a = runAdvice({ family: 'discord', resultCount: 2, topDiscordStrength: 'strong' });
    expect(a?.tone).toBe('positive');
    expect(a?.headline).toContain('2 anomalies');
    const one = runAdvice({ family: 'discord', resultCount: 1, topDiscordStrength: 'strong' });
    expect(one?.headline).toContain('1 anomaly');
  });

  it('treats consensus and chain families as motif-style', () => {
    expect(runAdvice({ family: 'consensus', resultCount: 2, topMotifStrength: 'strong' })?.tone).toBe('positive');
    expect(runAdvice({ family: 'chain', resultCount: 0 })?.tone).toBe('suggestion');
  });

  it('does not warn "no repeating patterns" for a consensus run that found a fleet-wide shape', () => {
    // Guards the ResultsView contract: a consensus job with one fleet-wide shape
    // reports resultCount: 1 (and no motifPairs, so topMotifStrength is undefined),
    // which must yield the neutral "Found 1 pattern." verdict, not the empty-state warning.
    const a = runAdvice({ family: 'consensus', resultCount: 1 });
    expect(a?.headline).not.toBe('No repeating patterns were found.');
    expect(a?.headline).toBe('Found 1 pattern.');
    expect(a?.tone).toBe('neutral');
  });

  it('reports regimes for segmentation runs', () => {
    const a = runAdvice({ family: 'segmentation', resultCount: 3 });
    expect(a?.tone).toBe('positive');
    expect(a?.headline).toContain('3 regimes');
    expect(runAdvice({ family: 'segmentation', resultCount: 0 })?.tone).toBe('suggestion');
  });

  it('reports differences for compare runs', () => {
    expect(runAdvice({ family: 'compare', resultCount: 1 })?.headline).toContain('1 difference');
    expect(runAdvice({ family: 'compare', resultCount: 0 })?.tone).toBe('suggestion');
  });
});
