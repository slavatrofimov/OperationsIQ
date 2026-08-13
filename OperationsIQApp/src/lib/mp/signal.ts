/**
 * Signal-processing helpers for the Pattern Inspector (design spec §7.3 item 3).
 *
 * To let a user *visually confirm* a motif, we draw the matched subsequences
 * **z-normalized and superimposed** so only shape (not offset/scale) matters. Pure array
 * math, unit-tested.
 */

/** z-normalize a subsequence: subtract mean, divide by (population) std. */
export function zNormalize(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const std = Math.sqrt(variance);
  if (std < 1e-12) return values.map(() => 0); // flat line -> all zeros
  return values.map((v) => (v - mean) / std);
}

/**
 * Point-wise disagreement between two z-normalized subsequences, for the "aligned so we
 * can see where they differ" highlight. Returns |a_i - b_i| after z-normalizing both to
 * the shorter length.
 */
export function shapeDivergence(a: number[], b: number[]): number[] {
  const za = zNormalize(a);
  const zb = zNormalize(b);
  const n = Math.min(za.length, zb.length);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.abs(za[i] - zb[i]);
  return out;
}

/** Convergence-meter helper: map a best-so-far quality 0..1 to a friendly percent + word. */
export function convergenceText(quality: number): { pct: number; label: string } {
  const q = Math.max(0, Math.min(1, quality));
  const pct = Math.round(q * 100);
  const label = q >= 0.99 ? "Exact" : q >= 0.9 ? "Nearly exact" : q >= 0.5 ? "Refining…" : "Searching…";
  return { pct, label };
}
