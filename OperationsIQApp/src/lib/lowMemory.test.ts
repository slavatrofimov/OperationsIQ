import { describe, expect, it } from 'vitest';
import {
  EVENTHOUSE_CAPACITY_DOC_URL,
  errorText,
  getLowMemoryGuidance,
  isLowMemoryError,
} from './lowMemory';

describe('isLowMemoryError', () => {
  it('detects the canonical Kusto low-memory conditions', () => {
    const positives = [
      'Eventhouse query failed: Partial query failure: Low memory condition (E_LOW_MEMORY_CONDITION)',
      'bad allocation',
      'The query exceeded the memory budget',
      'Runaway query: memory allocation exceeded',
      'E_RUNAWAY_QUERY',
      'Out Of Memory while executing',
      'MemoryBudgetExceeded',
    ];
    for (const msg of positives) {
      expect(isLowMemoryError(msg), msg).toBe(true);
    }
  });

  it('is case-insensitive and matches inside a wrapped message', () => {
    expect(
      isLowMemoryError('Eventhouse query failed (500): e_low_memory_condition at node 3'),
    ).toBe(true);
  });

  it('accepts Error instances and objects with a message', () => {
    expect(isLowMemoryError(new Error('Low memory condition'))).toBe(true);
    expect(isLowMemoryError({ message: 'bad allocation' })).toBe(true);
  });

  it('does not flag unrelated errors', () => {
    const negatives = [
      '',
      null,
      undefined,
      'Eventhouse query failed (404): resource not found',
      'Invalid numeric parameter: NaN',
      'Network request failed',
      'The Fabric capacity backing this Eventhouse is paused.',
      'Semantic error: cannot resolve column',
    ];
    for (const msg of negatives) {
      expect(isLowMemoryError(msg), String(msg)).toBe(false);
    }
  });
});

describe('errorText', () => {
  it('extracts text from strings, Errors, and message objects', () => {
    expect(errorText('boom')).toBe('boom');
    expect(errorText(new Error('kaboom'))).toBe('kaboom');
    expect(errorText({ message: 'obj' })).toBe('obj');
    expect(errorText(null)).toBe('');
    expect(errorText(undefined)).toBe('');
  });
});

describe('getLowMemoryGuidance', () => {
  it('returns four ordered, non-empty remediation groups', () => {
    const g = getLowMemoryGuidance();
    expect(g.title.length).toBeGreaterThan(0);
    expect(g.intro.length).toBeGreaterThan(0);
    expect(g.groups).toHaveLength(4);
    for (const group of g.groups) {
      expect(group.title.length).toBeGreaterThan(0);
      expect(group.items.length).toBeGreaterThan(0);
      expect(group.items.every((i) => i.trim().length > 0)).toBe(true);
    }
  });

  it('links the last group to the smart capacity control docs', () => {
    const g = getLowMemoryGuidance();
    const capacityGroup = g.groups[g.groups.length - 1];
    expect(capacityGroup.link?.url).toBe(EVENTHOUSE_CAPACITY_DOC_URL);
    expect(EVENTHOUSE_CAPACITY_DOC_URL).toMatch(/^https:\/\/learn\.microsoft\.com\//);
  });

  it('covers the four headline strategies the product promises', () => {
    const g = getLowMemoryGuidance();
    const haystack = (
      g.title +
      ' ' +
      g.intro +
      ' ' +
      g.groups.map((x) => x.title + ' ' + x.items.join(' ')).join(' ')
    ).toLowerCase();
    expect(haystack).toContain('time range');
    expect(haystack).toContain('signals');
    expect(haystack).toContain('deep discovery');
    expect(haystack).toContain('capacity');
  });
});
