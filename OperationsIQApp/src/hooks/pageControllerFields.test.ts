import { describe, it, expect } from 'vitest';
import { tagField, rangeField, binningFields } from './pageControllerFields';
import { coerce } from './usePageController';
import type { TagInfo } from '../lib/tags';
import type { TimeRange } from '../components/TimeRangePicker';
import type { PageBinning } from '../context/BinningContext';
import { DEFAULT_BINNING_SETTINGS } from '../lib/binningSettings';

const TAGS: TagInfo[] = [
  { tagId: 'temp.reactor', tagName: 'Reactor Temperature' } as TagInfo,
  { tagId: 'flow.inlet', tagName: 'Inlet Flow' } as TagInfo,
];

describe('coerce', () => {
  it('coerces numbers with bounds', () => {
    expect(coerce.number('12')).toBe(12);
    expect(() => coerce.number('abc')).toThrow();
    expect(() => coerce.number(5, { min: 10 })).toThrow(/≥ 10/);
    expect(() => coerce.number(50, { max: 10 })).toThrow(/≤ 10/);
  });
  it('coerces integers by flooring', () => {
    expect(coerce.integer('7.9')).toBe(7);
  });
  it('coerces booleans from strings', () => {
    expect(coerce.boolean('true')).toBe(true);
    expect(coerce.boolean(false)).toBe(false);
    expect(() => coerce.boolean('maybe')).toThrow();
  });
  it('coerces string arrays', () => {
    expect(coerce.stringArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(coerce.stringArray('x')).toEqual(['x']);
    expect(coerce.stringArray('')).toEqual([]);
  });
  it('validates enum values (string or number)', () => {
    expect(coerce.enumValue('avg', ['avg', 'sum'])).toBe('avg');
    expect(coerce.enumValue('0.9', [0.8, 0.9])).toBe(0.9);
    expect(() => coerce.enumValue('nope', ['avg'])).toThrow();
  });
});

describe('tagField', () => {
  it('resolves tag ids and names (single-select)', () => {
    let out: string[] = [];
    const spec = tagField({ tags: TAGS, current: [], set: (ids) => (out = ids) });
    expect(spec.apply(['Reactor Temperature'])).toBeUndefined();
    expect(out).toEqual(['temp.reactor']);
    // ids pass through too; single-select keeps only the first
    spec.apply(['temp.reactor', 'flow.inlet']);
    expect(out).toEqual(['temp.reactor']);
  });

  it('keeps multiple tags when multi=true', () => {
    let out: string[] = [];
    const spec = tagField({ tags: TAGS, current: [], set: (ids) => (out = ids), multi: true });
    spec.apply(['temp.reactor', 'Inlet Flow']);
    expect(out).toEqual(['temp.reactor', 'flow.inlet']);
  });

  it('throws a helpful error for unknown tags', () => {
    const spec = tagField({ tags: TAGS, current: [], set: () => {} });
    expect(() => spec.apply(['ghost.tag'])).toThrow(/unknown tag/i);
  });
});

describe('rangeField', () => {
  it('parses ISO start/end into Dates', () => {
    let out: TimeRange | null = null;
    const now = new Date();
    const spec = rangeField({
      current: { start: now, end: now },
      set: (r) => (out = r),
    });
    const err = spec.apply({ start: '2024-01-01T00:00:00Z', end: '2024-01-02T00:00:00Z' });
    expect(err).toBeUndefined();
    expect(out!.start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('rejects an inverted or invalid range', () => {
    const now = new Date();
    const spec = rangeField({ current: { start: now, end: now }, set: () => {} });
    expect(spec.apply({ start: '2024-01-02T00:00:00Z', end: '2024-01-01T00:00:00Z' })).toMatch(
      /before/,
    );
    expect(spec.apply({ start: 'not-a-date', end: '2024-01-01T00:00:00Z' })).toMatch(/invalid/);
  });
});

describe('binningFields', () => {
  function fakeBinning(): { binning: PageBinning; patches: Record<string, unknown>[] } {
    const patches: Record<string, unknown>[] = [];
    const binning: PageBinning = {
      settings: { ...DEFAULT_BINNING_SETTINGS },
      patch: (p) => patches.push(p),
      saveAsDefault: () => {},
      resetToDefault: () => {},
      isCustom: false,
    };
    return { binning, patches };
  }

  it('exposes aggregation + resolution fields', () => {
    const { binning } = fakeBinning();
    const specs = binningFields(binning);
    expect(specs.map((s) => s.field.name)).toEqual(['aggregation', 'resolution']);
  });

  it('maps resolution 0 to auto (null preferredMillis)', () => {
    const { binning, patches } = fakeBinning();
    const [, resolution] = binningFields(binning);
    resolution.apply(0);
    expect(patches.at(-1)).toEqual({ preferredMillis: null });
    resolution.apply(3600);
    expect(patches.at(-1)).toEqual({ preferredMillis: 3600 });
  });

  it('validates aggregation against allowed values', () => {
    const { binning, patches } = fakeBinning();
    const [aggregation] = binningFields(binning);
    aggregation.apply('sum');
    expect(patches.at(-1)).toEqual({ aggregation: 'sum' });
    expect(() => aggregation.apply('bogus')).toThrow();
  });
});
