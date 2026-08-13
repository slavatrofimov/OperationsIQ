# Catalog scale — performance validation (500K tags)

This is the perf-validation milestone (P6) of the large-catalog scaling work. It
confirms the goal of the refactor: **above a size threshold the browser no longer
loads the whole catalog**, and the client-side cost/memory of every catalog
interaction is bounded by what the user fetched — a page of results, one expanded
hierarchy level, and the resolved-selection cache — *independent of how many tags
exist on the server*.

## How to reproduce

```bash
cd OperationsIQApp
npm run perf:catalog             # 500,000 synthetic tags (default)
npm run perf:catalog -- 1000000  # override N
```

The harness (`scripts/catalog-perf-harness.ts`) and its bounded-ness tests
(`src/lib/catalogScale.test.ts`) are pure and network-free — no Eventhouse or DOM.
A deterministic generator (`src/lib/catalogScale.ts`) stands in for the server:
`searchPage` / `hierarchyChildren` carve the same bounded slices out of the
synthetic catalog that `catalog.searchTags` / `catalog.getHierarchyChildren`
return from KQL, so the real `catalogSearchReducer` and `lazyTreeState`
transitions are exercised exactly as they run in the app.

## Results — N = 500,000 (Node, representative laptop run)

| Path | Metric | Result |
|---|---|---|
| **small** (legacy in-memory, *avoided* above threshold) | `buildTagTree` over all tags | **~3,850 ms** (blocks main thread) |
| small | full-scan filter per keystroke (`tagMatches`) | **~555 ms / keystroke** |
| small | retained tree | ~76 MB (plus the ~290 MB catalog array itself) |
| **large** (server-backed, *used* at scale) | search — CLIENT cost / keystroke (reducer applies one 100-row page) | **~0.1 ms p95** |
| large | search — SERVER stand-in (full-catalog scan; runs in KQL in production) | ~187 ms p95 |
| large | memory retained during search | **~6 MB** (one 100-row page) |
| large | rows retained after scrolling 20 pages | **2,000** (independent of N) |
| large | lazy-tree nodes after expanding plant→area→unit + paging signals | **55** (bounded by hierarchy fan-out, not N) |

Absolute milliseconds vary by machine; the **ratios and bounds** are the point.

## Interpretation against the P6 targets

- **Search latency < ~300 ms P95** — the *client-side* work per keystroke is
  ~0.1 ms (apply a page to the reducer). The heavy filtering is offloaded to KQL,
  where an indexed/`has`-friendly catalog table answers a `take`-limited page
  cheaply. In small mode the equivalent work is a ~555 ms **main-thread**
  full-scan on every keystroke.
- **Memory < ~400 MB** — the browser retains only bounded working sets: a result
  page (~6 MB), a handful of expanded hierarchy nodes (55), and the
  resolved-selection cache. The ~290 MB full-catalog array is never materialized
  client-side; it stays in the Eventhouse.
- **No main-thread freezes** — large mode does no O(N) main-thread work. Small
  mode's ~3.85 s `buildTagTree` and per-keystroke ~555 ms filter are precisely the
  jank the threshold exists to avoid.

## Why the threshold (50K)

`catalogModeForCount` switches to the server-backed path at 50,000 tags. Below it,
the in-memory build/filter is fast enough to keep the zero-risk, zero-UX-change
legacy path (and its instant client-side facets/tree); above it, the O(N)
main-thread costs shown above become user-visible, so the app auto-switches. The
probe is best-effort: if it fails, the app stays in small mode (safe default).

## What this validates end-to-end

The bounded-ness proven here is what makes the earlier slices safe at scale:
server-backed picker search + virtualization + lazy tree + facets (P2/P3), the
selection-resolution cache and agent tools (P1/P4), auto mode selection (P5a), and
finally skipping the full `listTags` load with the resolved-selection compat shim
(P5d). Together they keep the client's cost and memory flat as the catalog grows
toward — and past — 500K tags.
