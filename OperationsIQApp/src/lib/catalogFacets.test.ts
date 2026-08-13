import { describe, it, expect } from 'vitest';
import { getServerFacetDefs, facetContextFilter } from './catalogFacets';
import type { HierarchyLevel } from './tagTree';

const levels: HierarchyLevel[] = [
  { key: 'level1', label: 'Site', get: (t) => t.level1 },
  { key: 'level2', label: 'Area', get: (t) => t.level2 },
];

describe('getServerFacetDefs', () => {
  it('lists hierarchy levels in order, then Metric and Engineering Units', () => {
    const defs = getServerFacetDefs(levels);
    expect(defs.map((d) => d.key)).toEqual(['level1', 'level2', 'metric', 'engUnits']);
    expect(defs.map((d) => d.label)).toEqual(['Site', 'Area', 'Metric', 'Engineering Units']);
  });

  it('applies metric and units label overrides', () => {
    const defs = getServerFacetDefs(levels, { metricLabel: 'Measure', unitsLabel: 'Units' });
    const byKey = Object.fromEntries(defs.map((d) => [d.key, d.label]));
    expect(byKey.metric).toBe('Measure');
    expect(byKey.engUnits).toBe('Units');
  });

  it('keeps a facet per level even when there are no hierarchy levels', () => {
    const defs = getServerFacetDefs([]);
    expect(defs.map((d) => d.key)).toEqual(['metric', 'engUnits']);
  });

  it('does not drop facets (unlike the in-memory getFacets)', () => {
    const defs = getServerFacetDefs(levels);
    expect(defs).toHaveLength(4);
  });
});

describe('facetContextFilter', () => {
  it('includes other facets active selections but not its own', () => {
    const f = facetContextFilter('metric', {
      metric: ['Temperature'],
      level1: ['Site A'],
      engUnits: ['degC'],
    });
    expect(f.facetSelections).toEqual({ level1: ['Site A'], engUnits: ['degC'] });
    expect(f.facetSelections?.metric).toBeUndefined();
  });

  it('omits empty selections', () => {
    const f = facetContextFilter('metric', { level1: [], level2: ['X'] });
    expect(f.facetSelections).toEqual({ level2: ['X'] });
  });

  it('never sets a free-text query', () => {
    const f = facetContextFilter('level1', { level2: ['X'] });
    expect(f.query).toBeUndefined();
  });

  it('returns an empty facetSelections map when nothing else is selected', () => {
    const f = facetContextFilter('level1', { level1: ['only self'] });
    expect(f.facetSelections).toEqual({});
  });
});
