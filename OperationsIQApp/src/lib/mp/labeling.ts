/**
 * Label propagation — "apply this label to all similar patterns" (design spec §7.5).
 *
 * When a user labels one motif instance ("healthy pump cycle"), we can auto-apply that
 * label to every other stretch that is *similar* to it, by walking the nearest-neighbor
 * graph the Matrix Profile already computed (`mpi[i]` = index of `i`'s nearest neighbor)
 * and keeping only nodes whose similarity (MP value) beats a threshold. Pure + testable —
 * no backend or raw signal required.
 */

export interface Span {
  startIndex: number;
  length: number;
}

/** Do two spans overlap (within an optional exclusion margin)? */
export function spansOverlap(a: Span, b: Span, margin = 0): boolean {
  const aEnd = a.startIndex + a.length + margin;
  const bEnd = b.startIndex + b.length + margin;
  return a.startIndex < bEnd && b.startIndex < aEnd;
}

/** The minimal shape shared by a saved label and a pattern's per-signal label target. */
export interface LabeledSpan {
  signalId: string;
  startIndex: number;
  length: number;
}

/**
 * Whether a saved label targets a specific pattern target. A label is always created at
 * its pattern instance's *exact* start on a given signal, so we match on identity (same
 * signal + same start index) rather than temporal overlap.
 *
 * Overlap-based matching is wrong here: discovered patterns (e.g. discords) commonly sit
 * less than one window apart, so their spans partially overlap. Matching by overlap made a
 * label created on one anomaly (D2) also appear on a neighbor whose window merely overlaps
 * it (D3). Identity matching attaches each label only to the instance it was created for.
 */
export function labelMatchesTarget(label: LabeledSpan, target: LabeledSpan): boolean {
  return label.signalId === target.signalId && label.startIndex === target.startIndex;
}

/**
 * Suggest a distance threshold for "similar" from the seed's own MP value: anything at
 * most `factor`× as far as the seed's nearest neighbor counts as similar. Falls back to a
 * small absolute value when the seed sits in a flat region.
 */
export function suggestThreshold(mp: number[], seedIndex: number, factor = 1.5): number {
  const seed = mp[seedIndex];
  if (seed === undefined || !Number.isFinite(seed) || seed <= 0) {
    const finite = mp.filter((v) => Number.isFinite(v) && v > 0);
    if (finite.length === 0) return Number.POSITIVE_INFINITY;
    const median = finite.slice().sort((a, b) => a - b)[Math.floor(finite.length / 2)];
    return median;
  }
  return seed * factor;
}

export interface PropagateOptions {
  seedIndex: number;
  length: number;
  mp: number[];
  mpi: number[];
  /** max MP value (distance) for a subsequence to be considered "similar". */
  distThreshold: number;
  /** minimum gap between reported spans to avoid trivial/overlapping matches. */
  exclusionZone: number;
  maxResults?: number;
}

/**
 * Expand from the seed over the nearest-neighbor graph, returning non-overlapping spans
 * (including the seed) whose MP value is within `distThreshold`. The graph is undirected:
 * we follow both `i -> mpi[i]` and any `j` that points back at a visited node.
 */
export function propagateLabel(opts: PropagateOptions): Span[] {
  const { seedIndex, length, mp, mpi, distThreshold, exclusionZone } = opts;
  const maxResults = opts.maxResults ?? 50;
  const n = mp.length;
  if (seedIndex < 0 || seedIndex >= n) return [];

  // Precompute reverse edges (who points at me) so expansion is bidirectional.
  const reverse = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const j = mpi[i];
    if (j >= 0 && j < n) {
      const list = reverse.get(j) ?? [];
      list.push(i);
      reverse.set(j, list);
    }
  }

  const visited = new Set<number>([seedIndex]);
  const queue: number[] = [seedIndex];
  const found: number[] = [];

  while (queue.length > 0) {
    const cur = queue.shift() as number;
    found.push(cur);
    const neighbors = [mpi[cur], ...(reverse.get(cur) ?? [])];
    for (const nb of neighbors) {
      if (nb < 0 || nb >= n || visited.has(nb)) continue;
      const d = mp[nb];
      if (Number.isFinite(d) && d <= distThreshold) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }

  // Greedily keep non-overlapping spans, closest-first, seed always included.
  found.sort((a, b) => {
    if (a === seedIndex) return -1;
    if (b === seedIndex) return 1;
    return mp[a] - mp[b];
  });

  const kept: Span[] = [];
  for (const idx of found) {
    const span: Span = { startIndex: idx, length };
    if (kept.some((k) => spansOverlap(k, span, exclusionZone))) continue;
    kept.push(span);
    if (kept.length >= maxResults) break;
  }
  return kept.sort((a, b) => a.startIndex - b.startIndex);
}
