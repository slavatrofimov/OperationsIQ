/**
 * Curve segmentation and clustering utilities.
 * Provides SAX (Symbolic Aggregate Approximation) symbolization
 * and clustering algorithms for time-series cycle analysis.
 */

/**
 * Gaussian breakpoints for SAX alphabet sizes 3-8.
 * These are standard normal quantiles that divide the distribution
 * into equal-probability regions.
 */
export const SAX_BREAKPOINTS: Record<number, number[]> = {
  3: [-0.43, 0.43],
  4: [-0.67, 0, 0.67],
  5: [-0.84, -0.25, 0.25, 0.84],
  6: [-0.97, -0.43, 0, 0.43, 0.97],
  7: [-1.07, -0.57, -0.18, 0.18, 0.57, 1.07],
  8: [-1.15, -0.67, -0.32, 0, 0.32, 0.67, 1.15],
};

/**
 * Piecewise Aggregate Approximation: reduce a series to `segments` averages.
 * Each PAA segment is the mean of the corresponding sub-window.
 */
export function paa(series: number[], segments: number): number[] {
  if (series.length === 0 || segments <= 0) return [];
  if (segments >= series.length) return series;

  const result: number[] = [];
  const segmentSize = series.length / segments;

  for (let i = 0; i < segments; i++) {
    const start = Math.floor(i * segmentSize);
    const end = Math.floor((i + 1) * segmentSize);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += series[j];
      count++;
    }
    result.push(count > 0 ? sum / count : 0);
  }

  return result;
}

/**
 * Z-normalize a series (subtract mean, divide by stddev).
 * Returns normalized series or original if stddev is too small.
 */
export function znormalize(series: number[], threshold = 0.001): number[] {
  if (series.length === 0) return [];

  const mean = series.reduce((sum, v) => sum + v, 0) / series.length;
  const variance = series.reduce((sum, v) => sum + (v - mean) ** 2, 0) / series.length;
  const stddev = Math.sqrt(variance);

  if (stddev < threshold) {
    // Series is essentially flat, return zeros
    return series.map(() => 0);
  }

  return series.map((v) => (v - mean) / stddev);
}

/**
 * Convert a PAA vector to a SAX string using Gaussian breakpoints.
 * The PAA vector should be z-normalized before calling this.
 */
export function saxWord(paaVector: number[], alphabetSize: number): string {
  const breakpoints = SAX_BREAKPOINTS[alphabetSize];
  if (!breakpoints) {
    throw new Error(`Alphabet size ${alphabetSize} not supported (use 3-8)`);
  }

  const chars: string[] = [];
  for (const value of paaVector) {
    let symbol = 0;
    for (let i = 0; i < breakpoints.length; i++) {
      if (value >= breakpoints[i]) {
        symbol = i + 1;
      } else {
        break;
      }
    }
    // Map to ASCII letters: 0='a', 1='b', etc.
    chars.push(String.fromCharCode(97 + symbol));
  }

  return chars.join('');
}

/**
 * Compute the full SAX representation of a time series.
 * Handles z-normalization, PAA, and symbolization in one step.
 */
export function toSax(
  series: number[],
  paaSize: number,
  alphabetSize: number,
  znormThreshold = 0.001,
): string {
  const normalized = znormalize(series, znormThreshold);
  const paaVec = paa(normalized, paaSize);
  return saxWord(paaVec, alphabetSize);
}

/**
 * Compute MINDIST between two SAX words.
 * This is a lower bound on the Euclidean distance between the original series.
 */
export function saxDistance(
  a: string,
  b: string,
  alphabetSize: number,
  seriesLength: number,
): number {
  if (a.length !== b.length) {
    throw new Error('SAX words must have the same length');
  }

  const breakpoints = SAX_BREAKPOINTS[alphabetSize];
  if (!breakpoints) {
    throw new Error(`Alphabet size ${alphabetSize} not supported`);
  }

  // Build lookup table for symbol distances
  const distTable: number[][] = [];
  const numSymbols = alphabetSize;
  for (let i = 0; i < numSymbols; i++) {
    distTable[i] = [];
    for (let j = 0; j < numSymbols; j++) {
      if (Math.abs(i - j) <= 1) {
        distTable[i][j] = 0;
      } else {
        const r = Math.max(i, j);
        const c = Math.min(i, j);
        distTable[i][j] = breakpoints[r - 1] - breakpoints[c];
      }
    }
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const symA = a.charCodeAt(i) - 97;
    const symB = b.charCodeAt(i) - 97;
    sum += distTable[symA][symB] ** 2;
  }

  const scaleFactor = Math.sqrt(seriesLength / a.length);
  return scaleFactor * Math.sqrt(sum);
}

export interface Cluster {
  /** Cluster ID (0-based). */
  clusterId: number;
  /** Indices of cycles in this cluster. */
  members: number[];
  /** Index of the cycle closest to the cluster centroid. */
  centroidIndex: number;
}

/**
 * Simple K-Means clustering on cycles using SAX distance.
 * Returns cluster assignments.
 */
export function clusterCycles(
  cycles: { index: number; series: number[]; saxWord: string }[],
  k: number,
  alphabetSize: number,
  seriesLength: number,
  maxIterations = 20,
): Cluster[] {
  if (cycles.length === 0) return [];
  if (k <= 0) return [];
  if (k >= cycles.length) {
    // Each cycle is its own cluster
    return cycles.map((c, i) => ({
      clusterId: i,
      members: [c.index],
      centroidIndex: c.index,
    }));
  }

  // Build distance matrix once (symmetric)
  const distMatrix: number[][] = [];
  for (let i = 0; i < cycles.length; i++) {
    distMatrix[i] = [];
    for (let j = 0; j < cycles.length; j++) {
      if (i === j) {
        distMatrix[i][j] = 0;
      } else if (j < i) {
        distMatrix[i][j] = distMatrix[j][i];
      } else {
        distMatrix[i][j] = saxDistance(
          cycles[i].saxWord,
          cycles[j].saxWord,
          alphabetSize,
          seriesLength,
        );
      }
    }
  }

  // Initialize: pick k random cycles as initial centroids
  const centroidIndices = new Set<number>();
  while (centroidIndices.size < k) {
    const idx = Math.floor(Math.random() * cycles.length);
    centroidIndices.add(idx);
  }
  let centroids = Array.from(centroidIndices);

  let assignments = new Array(cycles.length).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign each cycle to nearest centroid
    const newAssignments = cycles.map((_, i) => {
      let bestCluster = 0;
      let bestDist = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const dist = distMatrix[i][centroids[c]];
        if (dist < bestDist) {
          bestDist = dist;
          bestCluster = c;
        }
      }
      return bestCluster;
    });

    // Check for convergence
    if (iter > 0 && newAssignments.every((a, i) => a === assignments[i])) {
      assignments = newAssignments;
      break;
    }
    assignments = newAssignments;

    // Update centroids: pick the cycle with minimum average distance to cluster members
    const newCentroids: number[] = [];
    for (let c = 0; c < k; c++) {
      const memberIndices = assignments
        .map((a, i) => (a === c ? i : -1))
        .filter((i) => i >= 0);

      if (memberIndices.length === 0) {
        // Empty cluster, keep old centroid or pick a random point
        newCentroids.push(centroids[c] ?? 0);
        continue;
      }

      // Find member with minimum average distance to all other members
      let bestIdx = memberIndices[0];
      let bestAvgDist = Infinity;
      for (const candidateIdx of memberIndices) {
        let sumDist = 0;
        for (const otherIdx of memberIndices) {
          sumDist += distMatrix[candidateIdx][otherIdx];
        }
        const avgDist = sumDist / memberIndices.length;
        if (avgDist < bestAvgDist) {
          bestAvgDist = avgDist;
          bestIdx = candidateIdx;
        }
      }
      newCentroids.push(bestIdx);
    }
    centroids = newCentroids;
  }

  // Build result clusters
  const clusters: Cluster[] = [];
  for (let c = 0; c < k; c++) {
    const members = assignments
      .map((a, i) => (a === c ? cycles[i].index : -1))
      .filter((idx) => idx >= 0);
    clusters.push({
      clusterId: c,
      members,
      centroidIndex: cycles[centroids[c]]?.index ?? members[0] ?? 0,
    });
  }

  return clusters.filter((cl) => cl.members.length > 0);
}

/**
 * Hierarchical clustering (agglomerative, average linkage).
 * Returns merge order for dendrogram visualization.
 * Each entry: [leftCluster, rightCluster, distance]
 */
export function hierarchicalCluster(
  distanceMatrix: number[][],
): { mergeOrder: [number, number, number][] } {
  const n = distanceMatrix.length;
  if (n === 0) return { mergeOrder: [] };

  // Start with each point as its own cluster
  const clusters: Set<number>[] = Array.from({ length: n }, (_, i) => new Set([i]));
  const mergeOrder: [number, number, number][] = [];

  // Build a working distance matrix (will be modified)
  const dists: number[][] = distanceMatrix.map((row) => [...row]);

  while (clusters.length > 1) {
    // Find the pair of clusters with minimum distance
    let minDist = Infinity;
    let minI = 0;
    let minJ = 1;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        // Compute average linkage distance
        let sum = 0;
        let count = 0;
        for (const pi of clusters[i]) {
          for (const pj of clusters[j]) {
            sum += dists[pi][pj];
            count++;
          }
        }
        const avgDist = count > 0 ? sum / count : 0;
        if (avgDist < minDist) {
          minDist = avgDist;
          minI = i;
          minJ = j;
        }
      }
    }

    // Merge clusters minI and minJ
    mergeOrder.push([minI, minJ, minDist]);

    // Merge minJ into minI
    for (const p of clusters[minJ]) {
      clusters[minI].add(p);
    }
    clusters.splice(minJ, 1);
  }

  return { mergeOrder };
}