import { describe, it, expect } from 'vitest';
import {
  generateSyntheticTags,
  searchPage,
  hierarchyChildren,
  DEFAULT_DIMS,
} from './catalogScale';
import { catalogSearchReducer, initialSearchState } from './catalogSearchState';
import {
  createLazyTree,
  setRootChildren,
  setNodeChildren,
  setNodeTags,
  type LazyLevel,
} from './lazyTreeState';
import { catalogModeForCount } from './catalogMode';

const LEVELS: LazyLevel[] = [
  { key: 'level1', label: 'Plant' },
  { key: 'level2', label: 'Area' },
  { key: 'level3', label: 'Unit' },
];

/** Drive the real search reducer through `pages` pages of `take` rows for `query`. */
function pageThroughSearch(catalog: ReturnType<typeof generateSyntheticTags>, query: string, take: number, pages: number) {
  let state = initialSearchState;
  let gen = 0;
  for (let p = 0; p < pages; p++) {
    const append = p > 0;
    gen += 1;
    state = catalogSearchReducer(state, { type: 'start', generation: gen, append });
    const { rows, hasMore } = searchPage(catalog, query, p * take, take);
    state = catalogSearchReducer(state, { type: 'success', generation: gen, rows, hasMore, append });
    if (!hasMore) break;
  }
  return state;
}

/** Build the root level then fully expand one root→area→unit path via the real transitions. */
function buildOnePath(catalog: ReturnType<typeof generateSyntheticTags>) {
  let state = createLazyTree(LEVELS);
  state = setRootChildren(state, hierarchyChildren(catalog, {}, 'level1'));
  const rootId = state.rootIds[0];
  const root = state.nodes[rootId];
  state = setNodeChildren(state, rootId, hierarchyChildren(catalog, root.scope, 'level2'));
  const areaId = state.nodes[rootId].childIds[0];
  const area = state.nodes[areaId];
  state = setNodeChildren(state, areaId, hierarchyChildren(catalog, area.scope, 'level3'));
  const unitId = state.nodes[areaId].childIds[0];
  const unit = state.nodes[unitId];
  // Deepest level → tag container: page in its signals.
  const page = searchPage(
    catalog.filter((t) => t.level1 === unit.scope.level1 && t.level2 === unit.scope.level2 && t.level3 === unit.scope.level3),
    '',
    0,
    50,
  );
  state = setNodeTags(state, unitId, page.rows, page.hasMore, false);
  return { state, unitId };
}

describe('synthetic catalog generator', () => {
  it('produces N unique tags spread across the hierarchy', () => {
    const tags = generateSyntheticTags(5_000);
    expect(tags).toHaveLength(5_000);
    expect(new Set(tags.map((t) => t.tagId)).size).toBe(5_000);
    // With default dims the first 5,000 ids cover every distinct leaf scope once.
    const scopes = new Set(tags.map((t) => `${t.level1}/${t.level2}/${t.level3}`));
    expect(scopes.size).toBe(DEFAULT_DIMS.plants * DEFAULT_DIMS.areasPerPlant * DEFAULT_DIMS.unitsPerArea);
  });
});

describe('server search page is bounded and correct', () => {
  it('returns at most `take` rows and reports hasMore', () => {
    const catalog = generateSyntheticTags(50_000);
    const first = searchPage(catalog, 'Temperature', 0, 100);
    expect(first.rows).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    // Page rows are drawn from the query matches, in order.
    expect(first.rows.every((t) => t.metric === 'Temperature')).toBe(true);
  });
});

describe('client retains only fetched pages, independent of catalog size', () => {
  it('search reducer holds exactly pages×take rows regardless of N', () => {
    const small = generateSyntheticTags(20_000);
    const large = generateSyntheticTags(200_000);
    const take = 100;
    const pages = 5;
    const s = pageThroughSearch(small, 'Plant', take, pages);
    const l = pageThroughSearch(large, 'Plant', take, pages);
    // A broad query matches far more than pages×take in both catalogs, so both
    // stop at the same bounded retained set — the size does not grow with N.
    expect(s.rows.length).toBe(take * pages);
    expect(l.rows.length).toBe(take * pages);
    expect(l.rows.length).toBe(s.rows.length);
  });

  it('overlapping pages are de-duplicated by tagId', () => {
    const catalog = generateSyntheticTags(10_000);
    let state = initialSearchState;
    state = catalogSearchReducer(state, { type: 'start', generation: 1, append: false });
    const page = searchPage(catalog, '', 0, 100);
    state = catalogSearchReducer(state, { type: 'success', generation: 1, rows: page.rows, hasMore: true, append: false });
    // Append the SAME page again: no growth, because ids already present.
    state = catalogSearchReducer(state, { type: 'start', generation: 2, append: true });
    state = catalogSearchReducer(state, { type: 'success', generation: 2, rows: page.rows, hasMore: true, append: true });
    expect(state.rows).toHaveLength(100);
  });
});

describe('lazy hierarchy tree is bounded by dims, not catalog size', () => {
  it('expanding one path retains O(level cardinality + page) nodes, identical across N', () => {
    // Same dims, very different N (10× more metrics per leaf → 10× more tags).
    const nSmall = 5_000; // one tag per leaf scope
    const nLarge = 50_000; // ten tags per leaf scope
    const small = buildOnePath(generateSyntheticTags(nSmall));
    const large = buildOnePath(generateSyntheticTags(nLarge));

    const smallNodeCount = Object.keys(small.state.nodes).length;
    const largeNodeCount = Object.keys(large.state.nodes).length;

    // Node count depends only on the hierarchy cardinality along the expanded
    // path, not on the number of signals — so it is identical for both catalogs.
    expect(largeNodeCount).toBe(smallNodeCount);
    // And it is a tiny fraction of even the smaller catalog.
    expect(smallNodeCount).toBeLessThan(nSmall);

    // The paged tag container holds only its bounded page (≤ 50).
    expect(small.state.nodes[small.unitId].tags.length).toBeLessThanOrEqual(50);
    expect(large.state.nodes[large.unitId].tags.length).toBeLessThanOrEqual(50);
  });
});

describe('mode selection scales as intended', () => {
  it('picks the server-backed path at 500K and the in-memory path when small', () => {
    expect(catalogModeForCount(500_000)).toBe('large');
    expect(catalogModeForCount(1_000)).toBe('small');
  });
});
