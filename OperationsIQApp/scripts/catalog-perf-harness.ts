/**
 * Catalog scale harness (P6 — perf validation).
 *
 * Generates a synthetic 500K-tag catalog and contrasts the two data-access paths
 * the app chooses between:
 *
 *   • small mode  — the legacy in-memory path: build the full `buildTagTree` and
 *                   filter across every tag on the main thread. This is what the
 *                   app deliberately AVOIDS above the 50K threshold; the harness
 *                   runs it here only to quantify why.
 *   • large mode  — the server-backed path the app actually uses at scale: page
 *                   search results through the real reducer and expand the lazy
 *                   hierarchy one level at a time. The client only ever retains a
 *                   bounded page / level / selection.
 *
 * It prints wall-clock timings (including a P95 for simulated per-keystroke search
 * pages), retained-row counts, and process heap deltas so the numbers in
 * docs/catalog-scale-perf.md can be reproduced with:
 *
 *   npm run perf:catalog            # 500,000 tags (default)
 *   npm run perf:catalog -- 1000000 # override N
 *
 * Pure/Node-only; no Eventhouse or DOM. Run via vite-node.
 */

import { performance } from 'node:perf_hooks';
import {
  generateSyntheticTags,
  searchPage,
  hierarchyChildren,
  DEFAULT_DIMS,
} from '../src/lib/catalogScale';
import { buildTagTree, getHierarchyLevels, tagMatches } from '../src/lib/tagTree';
import { catalogSearchReducer, initialSearchState } from '../src/lib/catalogSearchState';
import {
  createLazyTree,
  setRootChildren,
  setNodeChildren,
  setNodeTags,
  type LazyLevel,
} from '../src/lib/lazyTreeState';
import { catalogModeForCount } from '../src/lib/catalogMode';
import type { TagInfo } from '../src/lib/tags';

const N = Number(process.argv[2] ?? 500_000);
const PAGE = 100;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const ms = (n: number) => `${n.toFixed(1)} ms`;
const heap = () => process.memoryUsage().heapUsed;

function pct(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

const LEVELS: LazyLevel[] = [
  { key: 'level1', label: 'Plant' },
  { key: 'level2', label: 'Area' },
  { key: 'level3', label: 'Unit' },
];

function heading(t: string) {
  console.log(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}`);
}

function main() {
  heading(`Catalog scale harness — N = ${N.toLocaleString()} tags`);
  console.log(
    `dims: ${DEFAULT_DIMS.plants} plants × ${DEFAULT_DIMS.areasPerPlant} areas × ` +
      `${DEFAULT_DIMS.unitsPerArea} units = ` +
      `${(DEFAULT_DIMS.plants * DEFAULT_DIMS.areasPerPlant * DEFAULT_DIMS.unitsPerArea).toLocaleString()} leaf scopes`,
  );
  console.log(`catalogModeForCount(${N.toLocaleString()}) → '${catalogModeForCount(N)}'`);

  // ---- Generate the "server-side" catalog ---------------------------------
  const g0 = heap();
  const gt0 = performance.now();
  const catalog: TagInfo[] = generateSyntheticTags(N);
  const gt1 = performance.now();
  const g1 = heap();
  console.log(
    `\nGenerated ${catalog.length.toLocaleString()} tags in ${ms(gt1 - gt0)} ` +
      `(retained ≈ ${mb(g1 - g0)} — this is the server's data, NOT the browser's)`,
  );

  // ---- small mode: full in-memory tree + filter (what we AVOID) ------------
  heading('small mode (legacy in-memory path — avoided above threshold)');
  const levels = getHierarchyLevels();
  const s0 = heap();
  const st0 = performance.now();
  const tree = buildTagTree(catalog, levels);
  const st1 = performance.now();
  const s1 = heap();
  console.log(`buildTagTree over all ${N.toLocaleString()} tags: ${ms(st1 - st0)} (root groups: ${tree.length})`);
  console.log(`  retained tree ≈ ${mb(s1 - s0)}`);

  const ft0 = performance.now();
  let matched = 0;
  for (const t of catalog) if (tagMatches(t, 'Temperature')) matched++;
  const ft1 = performance.now();
  console.log(`full-scan filter (tagMatches over all tags): ${ms(ft1 - ft0)} (${matched.toLocaleString()} matches)`);
  console.log('  ⇒ this per-keystroke main-thread cost is what freezes the UI at scale.');

  // ---- large mode: bounded server-backed path (what we DO) ----------------
  heading('large mode (server-backed path — actually used at scale)');

  // Simulated per-keystroke search. In production the filtering runs server-side
  // in KQL; the browser only applies the returned page to the reducer. We measure
  // those two costs separately: the CLIENT cost (reducer + retain the page) is
  // what determines main-thread responsiveness.
  const queries = ['Temp', 'Pressure', 'Plant 03', 'Vibration', 'Unit 010', 'Flow', 'kW', 'Area 12'];
  const clientSamples: number[] = [];
  const serverSamples: number[] = [];
  const k0 = heap();
  for (let i = 0; i < 200; i++) {
    const q = queries[i % queries.length];
    // Server stand-in (runs in KQL in production, not the browser):
    const sv0 = performance.now();
    const { rows, hasMore } = searchPage(catalog, q, 0, PAGE);
    const sv1 = performance.now();
    serverSamples.push(sv1 - sv0);
    // Client cost per keystroke: apply the page to the reducer.
    const t0 = performance.now();
    let state = initialSearchState;
    state = catalogSearchReducer(state, { type: 'start', generation: 1, append: false });
    state = catalogSearchReducer(state, { type: 'success', generation: 1, rows, hasMore, append: true });
    const t1 = performance.now();
    clientSamples.push(t1 - t0);
  }
  const k1 = heap();
  clientSamples.sort((a, b) => a - b);
  serverSamples.sort((a, b) => a - b);
  console.log(
    `search — CLIENT cost/keystroke (reducer applies one ${PAGE}-row page): ` +
      `p50 ${ms(pct(clientSamples, 50))}, p95 ${ms(pct(clientSamples, 95))}, max ${ms(clientSamples[clientSamples.length - 1])}`,
  );
  console.log(
    `        SERVER stand-in (full-catalog scan — runs in KQL in production): ` +
      `p50 ${ms(pct(serverSamples, 50))}, p95 ${ms(pct(serverSamples, 95))}`,
  );
  console.log(`  retained during search ≈ ${mb(Math.max(0, k1 - k0))} (bounded to one ${PAGE}-row page)`);

  // Page deep: append 20 pages of a broad query; retained set stays bounded.
  let paged = initialSearchState;
  let gen = 0;
  const pt0 = performance.now();
  for (let p = 0; p < 20; p++) {
    gen += 1;
    paged = catalogSearchReducer(paged, { type: 'start', generation: gen, append: p > 0 });
    const { rows, hasMore } = searchPage(catalog, 'Plant', p * PAGE, PAGE);
    paged = catalogSearchReducer(paged, { type: 'success', generation: gen, rows, hasMore, append: p > 0 });
    if (!hasMore) break;
  }
  const pt1 = performance.now();
  console.log(`scroll (20 pages appended) in ${ms(pt1 - pt0)}; retained rows: ${paged.rows.length.toLocaleString()} (independent of N)`);

  // Lazy hierarchy: root + expand one full path.
  const lt0 = performance.now();
  let ltree = createLazyTree(LEVELS);
  ltree = setRootChildren(ltree, hierarchyChildren(catalog, {}, 'level1'));
  const rootId = ltree.rootIds[0];
  ltree = setNodeChildren(ltree, rootId, hierarchyChildren(catalog, ltree.nodes[rootId].scope, 'level2'));
  const areaId = ltree.nodes[rootId].childIds[0];
  ltree = setNodeChildren(ltree, areaId, hierarchyChildren(catalog, ltree.nodes[areaId].scope, 'level3'));
  const unitId = ltree.nodes[areaId].childIds[0];
  const unit = ltree.nodes[unitId];
  const leafPage = searchPage(
    catalog.filter(
      (t) => t.level1 === unit.scope.level1 && t.level2 === unit.scope.level2 && t.level3 === unit.scope.level3,
    ),
    '',
    0,
    50,
  );
  ltree = setNodeTags(ltree, unitId, leafPage.rows, leafPage.hasMore, false);
  const lt1 = performance.now();
  console.log(
    `lazy tree: root + expand plant→area→unit + page signals in ${ms(lt1 - lt0)}; ` +
      `nodes retained: ${Object.keys(ltree.nodes).length.toLocaleString()} (bounded by dims, not N)`,
  );

  heading('summary');
  console.log(`Server catalog:            ${N.toLocaleString()} tags, ≈ ${mb(g1 - g0)} (server-side)`);
  console.log(`small-mode tree build:     ${ms(st1 - st0)}  + full-scan filter ${ms(ft1 - ft0)} per keystroke`);
  console.log(`large-mode search p95:     client ${ms(pct(clientSamples, 95))} per keystroke (server scan offloaded to KQL)`);
  console.log(`large-mode retained rows:  ${paged.rows.length.toLocaleString()} after 20 pages (vs ${N.toLocaleString()} in small mode)`);
  console.log(`large-mode tree nodes:     ${Object.keys(ltree.nodes).length.toLocaleString()} (vs full tree of all ${N.toLocaleString()} tags)`);
  console.log('\nConclusion: large-mode client cost/memory is bounded by the page and the');
  console.log('hierarchy fan-out along the expanded path — independent of catalog size.');
}

main();
