// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { ConnectionProfile, ProfileLabels } from './connectionProfile';
import {
  catalogColumnForKey,
  buildSearchWhere,
  buildScopeWhere,
  buildFacetWhere,
  buildSearchTagsQuery,
  buildTagsByIdsQuery,
  buildCountTagsQuery,
  buildHierarchyChildrenQuery,
  buildFacetValuesQuery,
} from './catalog';

const labels: ProfileLabels = {
  entityLabel: 'Asset',
  metricIdLabel: 'Tag',
  level1Label: 'Plant',
  level2Label: 'Factory',
  level3Label: 'Line',
  level4Label: 'Station',
  level5Label: 'Level 5',
  level6Label: 'Level 6',
  level7Label: 'Level 7',
  level8Label: 'Level 8',
  level9Label: 'Level 9',
  level10Label: 'Level 10',
  unitOfMeasureLabel: 'Engineering Units',
  samplingFrequencyLabel: 'Sampling Frequency',
};

const profile: ConnectionProfile = {
  id: 'p1',
  userId: 'u1',
  name: 'Test',
  eventhouseQueryUri: 'https://example.kusto.fabric.microsoft.com',
  databaseName: 'DB',
  hierarchyQuery: 'HierarchyTable',
  metadataQuery: 'MetadataTable',
  eventsQuery: 'EventsTable',
  timeseriesQuery: 'TimeseriesTable',
  labels,
  createdAt: new Date('2024-01-01T00:00:00Z'),
};

describe('catalogColumnForKey', () => {
  it('maps default Contoso hierarchy keys to Level1..Level4', () => {
    expect(catalogColumnForKey('plant')).toBe('Level1');
    expect(catalogColumnForKey('factory')).toBe('Level2');
    expect(catalogColumnForKey('line')).toBe('Level3');
    expect(catalogColumnForKey('station')).toBe('Level4');
  });

  it('maps generic level keys and metric/units', () => {
    expect(catalogColumnForKey('level1')).toBe('Level1');
    expect(catalogColumnForKey('level10')).toBe('Level10');
    expect(catalogColumnForKey('metric')).toBe('MetricName');
    expect(catalogColumnForKey('engUnits')).toBe('UnitOfMeasure');
  });

  it('returns undefined for unknown or out-of-range keys', () => {
    expect(catalogColumnForKey('level0')).toBeUndefined();
    expect(catalogColumnForKey('level11')).toBeUndefined();
    expect(catalogColumnForKey('bogus')).toBeUndefined();
  });
});

describe('buildSearchWhere', () => {
  it('is empty for blank queries', () => {
    expect(buildSearchWhere()).toBe('');
    expect(buildSearchWhere('   ')).toBe('');
  });

  it('ORs across the searchable columns for a single term', () => {
    const w = buildSearchWhere('pump');
    expect(w).toContain("SignalName contains 'pump'");
    expect(w).toContain("SignalId contains 'pump'");
    expect(w).toContain("MetricName contains 'pump'");
    expect(w).toContain("Description contains 'pump'");
    expect(w.split('\n')).toHaveLength(1);
  });

  it('ANDs multiple terms as separate where clauses', () => {
    const w = buildSearchWhere('axial pressure');
    const lines = w.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("contains 'axial'");
    expect(lines[1]).toContain("contains 'pressure'");
  });

  it('escapes single quotes to prevent injection', () => {
    const w = buildSearchWhere("o'brien");
    expect(w).toContain("contains 'o\\'brien'");
  });
});

describe('buildScopeWhere / buildFacetWhere', () => {
  it('emits exact equality per scope entry', () => {
    const w = buildScopeWhere({ level1: 'Plant A', level2: 'Line 3' });
    expect(w).toContain("Level1 == 'Plant A'");
    expect(w).toContain("Level2 == 'Line 3'");
  });

  it('skips empty/unknown scope entries', () => {
    expect(buildScopeWhere({ level1: '  ', bogus: 'x' })).toBe('');
  });

  it('emits in(...) per facet selection and skips empties', () => {
    const w = buildFacetWhere({ metric: ['Temp', 'Flow'], engUnits: [] });
    expect(w).toContain("MetricName in (dynamic(['Temp', 'Flow']))");
    expect(w).not.toContain('UnitOfMeasure');
  });
});

describe('buildSearchTagsQuery', () => {
  it('includes the catalog prelude and a take of N+1 for hasMore detection', () => {
    const csl = buildSearchTagsQuery(profile, { query: 'pump', take: 50 });
    expect(csl).toContain('let Catalog = (');
    expect(csl).toContain('HierarchyTable');
    expect(csl).toContain('MetadataTable');
    expect(csl).toContain('| order by SignalName asc, SignalId asc');
    expect(csl).toContain('| take 51');
    expect(csl).toContain('| project-away Rn');
  });

  it('adds row_number paging only when skip > 0', () => {
    expect(buildSearchTagsQuery(profile, {})).not.toContain('| where Rn >');
    const paged = buildSearchTagsQuery(profile, { skip: 200, take: 100 });
    expect(paged).toContain('| serialize Rn = row_number()');
    expect(paged).toContain('| where Rn > 200');
    expect(paged).toContain('| take 101');
  });

  it('caps take at the maximum', () => {
    const csl = buildSearchTagsQuery(profile, { take: 100000 });
    expect(csl).toContain('| take 1001');
  });

  it('combines scope, facets and free text', () => {
    const csl = buildSearchTagsQuery(profile, {
      scope: { level1: 'Plant A' },
      facetSelections: { metric: ['Temp'] },
      query: 'inlet',
    });
    expect(csl).toContain("Level1 == 'Plant A'");
    expect(csl).toContain("MetricName in (dynamic(['Temp']))");
    expect(csl).toContain("contains 'inlet'");
  });
});

describe('buildTagsByIdsQuery', () => {
  it('filters by a dynamic id array with escaping', () => {
    const csl = buildTagsByIdsQuery(profile, ["a'b", 'c']);
    expect(csl).toContain('| where SignalId in (dynamic(');
    expect(csl).toContain("'a\\'b'");
    expect(csl).toContain("'c'");
  });
});

describe('buildCountTagsQuery', () => {
  it('ends with a count and applies the filter', () => {
    const csl = buildCountTagsQuery(profile, { query: 'pump' });
    expect(csl.trimEnd().endsWith('| count')).toBe(true);
    expect(csl).toContain("contains 'pump'");
  });

  it('counts the whole catalog with an empty filter', () => {
    const csl = buildCountTagsQuery(profile);
    expect(csl).toContain('| count');
    expect(csl).not.toContain('| where');
  });
});

describe('buildHierarchyChildrenQuery', () => {
  it('summarizes distinct child values within a parent scope', () => {
    const csl = buildHierarchyChildrenQuery(profile, {
      scope: { level1: 'Plant A' },
      childKey: 'level2',
      take: 25,
    });
    expect(csl).toContain("Level1 == 'Plant A'");
    expect(csl).toContain('| where isnotempty(Level2)');
    expect(csl).toContain('| summarize Count = count() by Value = Level2');
    expect(csl).toContain('| order by Value asc');
    expect(csl).toContain('| take 25');
  });

  it('throws on an unknown child level key', () => {
    expect(() => buildHierarchyChildrenQuery(profile, { childKey: 'bogus' })).toThrow();
  });
});

describe('buildFacetValuesQuery', () => {
  it('summarizes a facet with an optional prefix filter', () => {
    const csl = buildFacetValuesQuery(profile, { key: 'metric', prefix: 'temp', take: 20 });
    expect(csl).toContain('| where isnotempty(MetricName)');
    expect(csl).toContain("| where MetricName contains 'temp'");
    expect(csl).toContain('| summarize Count = count() by Value = MetricName');
    expect(csl).toContain('| take 20');
  });

  it('omits the prefix clause when absent', () => {
    const csl = buildFacetValuesQuery(profile, { key: 'engUnits' });
    expect(csl).toContain('| where isnotempty(UnitOfMeasure)');
    expect(csl).not.toContain('contains');
  });
});
