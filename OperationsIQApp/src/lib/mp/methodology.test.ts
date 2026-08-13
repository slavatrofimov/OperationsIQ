import { describe, it, expect } from 'vitest';
import { METHODOLOGY, methodologyFor } from './methodology';
import { JOB_TYPE_ORDER } from './naming';
import type { JobType } from './types';

describe('methodology', () => {
  it('has an entry for every job type in canonical order', () => {
    for (const type of JOB_TYPE_ORDER) {
      expect(METHODOLOGY[type]).toBeDefined();
    }
  });

  it('every entry provides non-empty method, interpretation, and metrics', () => {
    for (const type of JOB_TYPE_ORDER) {
      const m = METHODOLOGY[type];
      expect(m.algorithm.length).toBeGreaterThan(0);
      expect(m.method.length).toBeGreaterThan(0);
      expect(m.interpretation.length).toBeGreaterThan(0);
      expect(m.metrics.length).toBeGreaterThan(0);
      for (const metric of m.metrics) {
        expect(metric.label.length).toBeGreaterThan(0);
        expect(metric.meaning.length).toBeGreaterThan(0);
      }
    }
  });

  it('classifies families sensibly', () => {
    expect(METHODOLOGY.MOTIF_MOMP.family).toBe('motif');
    expect(METHODOLOGY.DISCORD_DAMP.family).toBe('discord');
    expect(METHODOLOGY.SEGMENTATION.family).toBe('segmentation');
    expect(METHODOLOGY.CHAIN.family).toBe('chain');
    expect(METHODOLOGY.CONSENSUS_MOTIF.family).toBe('consensus');
    expect(METHODOLOGY.AB_MOTIF.family).toBe('compare');
    expect(METHODOLOGY.AB_DISCORD.family).toBe('compare');
    expect(METHODOLOGY.PAN_MP.family).toBe('auto');
  });

  it('falls back to the full-profile description for unknown types', () => {
    const m = methodologyFor('NOT_A_TYPE' as JobType);
    expect(m.family).toBe('similarity');
  });
});
