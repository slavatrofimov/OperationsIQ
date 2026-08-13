/**
 * Plain-language interpretation of Matrix Profile results (design spec §7.3).
 *
 * This is the heart of "democratizing" MP: it turns raw distances/indices into words a
 * reliability engineer understands, with **no** MP jargon. Pure functions only, so the
 * whole interpretation layer is unit-tested without a browser or backend.
 */

export type Strength = "strong" | "moderate" | "weak";

/** A motif/discord summary as returned by the compute core, in UI terms. */
export interface MotifSummary {
  /** z-normalized Euclidean distance of the best motif pair (lower = more similar). */
  distance: number;
  /** subsequence length (samples) the motif was found at. */
  subLen: number;
  /** optional 2nd-best motif distance, used for a significance ratio. */
  secondDistance?: number;
}

export interface DiscordSummary {
  /** nearest-neighbor distance of the discord (higher = more isolated/unusual). */
  nnDistance: number;
  subLen: number;
}

/**
 * A motif's raw z-normalized distance is roughly `sqrt(subLen) * d_per_sample`. To judge
 * "how strong is this repeat?" independent of length we normalize by `sqrt(subLen)` and
 * compare against empirically reasonable per-sample thresholds. Small = very similar.
 */
export function normalizedMotifDistance(distance: number, subLen: number): number {
  if (subLen <= 0) return Number.POSITIVE_INFINITY;
  return distance / Math.sqrt(subLen);
}

/**
 * Translate a motif into a plain confidence badge. Thresholds are on the per-sample
 * normalized distance so they hold across window lengths. A strong Top-1/Top-2 ratio
 * (the best pair is much tighter than the next) also boosts confidence.
 */
export function motifStrength(m: MotifSummary): Strength {
  const nd = normalizedMotifDistance(m.distance, m.subLen);
  let level: Strength = nd < 0.15 ? "strong" : nd < 0.35 ? "moderate" : "weak";

  if (m.secondDistance !== undefined && m.secondDistance > 0) {
    const ratio = m.distance / m.secondDistance; // <1 means best is tighter than 2nd
    if (ratio < 0.6 && level === "moderate") level = "strong";
    if (ratio > 0.95 && level === "strong") level = "moderate";
  }
  return level;
}

const MOTIF_BADGE: Record<Strength, string> = {
  strong: "Strong repeat",
  moderate: "Moderate repeat",
  weak: "Weak repeat",
};

/** Human sentence explaining a motif result — no MP vocabulary. */
export function describeMotif(m: MotifSummary): string {
  const s = motifStrength(m);
  switch (s) {
    case "strong":
      return "These stretches look almost identical — a clear, repeating pattern.";
    case "moderate":
      return "These stretches look similar — a likely repeating pattern worth a look.";
    default:
      return "These stretches are only loosely similar — the repeat is weak; try a different length or sensor.";
  }
}

export function motifBadge(m: MotifSummary): string {
  return MOTIF_BADGE[motifStrength(m)];
}

/**
 * A 0..100 "consistency" score for display: how tightly the two matched stretches agree
 * in shape. 100 ≈ identical; it falls off with the length-normalized per-sample distance
 * so it is comparable across window lengths. Uses the same per-sample scale as
 * {@link motifStrength} (strong < 0.15, weak ≥ 0.35), mapping nd=0 → 100% and nd≥0.5 → 0%.
 */
export function motifConsistencyPct(m: MotifSummary): number {
  const nd = normalizedMotifDistance(m.distance, m.subLen);
  if (!Number.isFinite(nd)) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - nd / 0.5) * 100)));
}

/**
 * Discord severity relative to the surrounding data. We normalize the nearest-neighbor
 * distance by `sqrt(subLen)` (same reasoning as motifs) into a 0..1 severity used both
 * for the badge and the color scale. `refDistance` (e.g. the median NN distance of the
 * series) calibrates what "unusual" means for this signal.
 */
export function discordSeverity(d: DiscordSummary, refDistance: number): number {
  const nd = normalizedMotifDistance(d.nnDistance, d.subLen);
  const ref = refDistance > 0 ? refDistance / Math.sqrt(d.subLen) : 1;
  const ratio = ref > 0 ? nd / ref : nd;
  // Map ratio 1..3 -> 0..1 (at/below reference = 0, >=3x reference = maxed out).
  return Math.max(0, Math.min(1, (ratio - 1) / 2));
}

export function discordStrength(severity: number): Strength {
  return severity > 0.66 ? "strong" : severity > 0.33 ? "moderate" : "weak";
}

export function describeDiscord(severity: number): string {
  switch (discordStrength(severity)) {
    case "strong":
      return "This stretch is very unlike anything else in the window — a strong anomaly.";
    case "moderate":
      return "This stretch stands out from the rest — a possible anomaly.";
    default:
      return "This stretch is only mildly unusual — likely normal variation.";
  }
}

/**
 * Colorblind-safe severity color (design spec §7.5). Blue → yellow → red ramp on a
 * 0..1 severity. Returned as an rgb() string.
 */
export function severityColor(severity: number): string {
  const s = Math.max(0, Math.min(1, severity));
  // Two-segment ramp: blue(#2c7bb6) -> yellow(#ffffbf) -> red(#d7191c).
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  if (s < 0.5) {
    const t = s / 0.5;
    return `rgb(${lerp(44, 255, t)}, ${lerp(123, 255, t)}, ${lerp(182, 191, t)})`;
  }
  const t = (s - 0.5) / 0.5;
  return `rgb(${lerp(255, 215, t)}, ${lerp(255, 25, t)}, ${lerp(191, 28, t)})`;
}

/** UI relabeling of the Matrix Profile lane (valleys vs peaks). */
export function mpLaneLabel(kind: "low" | "high"): string {
  return kind === "low" ? "most repeated" : "most unusual";
}

// --- Regime / mode changes (segmentation) -------------------------------------------

export interface RegimeSummary {
  /** number of distinct operating modes found (= boundaries + 1). */
  numRegimes: number;
}

/** Human sentence explaining a segmentation result — no MP vocabulary. */
export function describeRegimes(s: RegimeSummary): string {
  const n = Math.max(1, Math.round(s.numRegimes));
  if (n <= 1)
    return "The signal keeps a single, steady character across this window — no clear mode changes.";
  if (n === 2)
    return "The signal switches behavior once, splitting the window into two operating modes.";
  return `The signal changes character ${n - 1} times, splitting the window into ${n} operating modes (for example start-up, steady running, and shutdown).`;
}

export function regimeBadge(s: RegimeSummary): string {
  const n = Math.max(1, Math.round(s.numRegimes));
  return n <= 1 ? "Single mode" : `${n} modes`;
}

// --- Slow degradation (time-series chains) ------------------------------------------

/** Chain drift summary as emitted by `chain_drift` in the compute core. */
export interface ChainDriftSummary {
  /** number of links (members) in the chain. */
  links: number;
  /** least-squares slope of the per-link mean level along the chain. */
  meanSlope: number;
  /** least-squares slope of the per-link peak-to-peak amplitude along the chain. */
  amplitudeSlope: number;
  meanStart?: number | null;
  meanEnd?: number | null;
  amplitudeStart?: number | null;
  amplitudeEnd?: number | null;
}

/**
 * How pronounced the head→tail drift is, from the relative change in level/amplitude
 * across the chain. A longer chain with a larger relative change is a stronger, more
 * trustworthy degradation signal.
 */
export function chainDriftStrength(d: ChainDriftSummary): Strength {
  if (d.links < 3) return "weak";
  const rel = (start?: number | null, end?: number | null): number => {
    if (start == null || end == null) return 0;
    const denom = Math.max(Math.abs(start), Math.abs(end), 1e-9);
    return Math.abs(end - start) / denom;
  };
  const change = Math.max(
    rel(d.meanStart, d.meanEnd),
    rel(d.amplitudeStart, d.amplitudeEnd),
  );
  if (change > 0.4 && d.links >= 4) return "strong";
  if (change > 0.15) return "moderate";
  return "weak";
}

/** Which way the pattern is drifting, for a plain-language direction word. */
export function chainDriftDirection(d: ChainDriftSummary): "rising" | "falling" | "flat" {
  const dominant =
    Math.abs(d.amplitudeSlope) > Math.abs(d.meanSlope) ? d.amplitudeSlope : d.meanSlope;
  if (dominant > 0) return "rising";
  if (dominant < 0) return "falling";
  return "flat";
}

/** Human sentence explaining a chain / degradation result — no MP vocabulary. */
export function describeChainDrift(d: ChainDriftSummary): string {
  if (d.links < 2)
    return "We couldn't link this pattern into an evolving chain — no clear drift over time.";
  const strength = chainDriftStrength(d);
  const dir = chainDriftDirection(d);
  const what =
    Math.abs(d.amplitudeSlope) > Math.abs(d.meanSlope) ? "swing" : "level";
  const dirWord = dir === "rising" ? "growing" : dir === "falling" ? "shrinking" : "steady";
  switch (strength) {
    case "strong":
      return `The pattern repeats ${d.links} times and its ${what} keeps ${dirWord} — a clear, steady drift that often signals developing wear or fouling.`;
    case "moderate":
      return `The pattern repeats ${d.links} times with a gradually ${dirWord} ${what} — a possible slow drift worth watching.`;
    default:
      return `The pattern repeats ${d.links} times but barely changes shape — no meaningful degradation yet.`;
  }
}

export function chainDriftBadge(d: ChainDriftSummary): string {
  const strength = chainDriftStrength(d);
  if (strength === "weak") return "Stable";
  const dir = chainDriftDirection(d);
  const arrow = dir === "rising" ? "↑" : dir === "falling" ? "↓" : "→";
  return strength === "strong" ? `Strong drift ${arrow}` : `Mild drift ${arrow}`;
}
