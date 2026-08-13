/**
 * Guided recipes (design spec §7.4) and the sensitivity slider mapping (§7.1 step 4).
 *
 * A recipe turns a plain-language goal card into a concrete job configuration, so the
 * user never picks an algorithm by name. Only the shipping recipes are enabled; roadmap
 * ones are surfaced as "coming soon".
 */

export type JobType =
  | "MOTIF_MOMP"
  | "DISCORD_DAMP"
  | "FULL_MP"
  | "PAN_MP"
  | "SEGMENTATION"
  | "CHAIN"
  | "RULE_DISCOVERY"
  | "CONSENSUS"
  | "MULTIDIM"
  | "MULTIDIM_MOTIF"
  | "MULTIDIM_DISCORD"
  | "MULTIDIM_SEGMENTATION"
  | "CONSENSUS_MOTIF"
  | "AB_MOTIF"
  | "AB_DISCORD";

export interface Recipe {
  id: string;
  /** user-facing card title — no jargon. */
  title: string;
  /** one-sentence plain description. */
  blurb: string;
  jobType: JobType;
  /** whether this recipe ships now (design spec §11 phasing). */
  available: boolean;
  /** why & how to read it. */
  explainer: string;
  /** true for two-series (AB-join) recipes: the signal step collects series A and B. */
  compare?: boolean;
  /** true for multi-series recipes (multidimensional / consensus): the signal step
   *  collects a set of signals rather than one. */
  multi?: boolean;
  /** multidimensional recipes require time-aligned channels (a common bin width). */
  requiresAlignment?: boolean;
  /** consensus recipes offer an optional "at least m of N" partial-consensus control. */
  allowMinCount?: boolean;
}

export const RECIPES: Recipe[] = [
  {
    id: "normal-cycles",
    title: "Find normal operating cycles",
    blurb: "Discover the repeating patterns that make up healthy, routine behavior.",
    jobType: "MOTIF_MOMP",
    available: true,
    explainer:
      "We look for the two stretches of signal that are most alike. Repeating shapes usually mean a normal, healthy cycle — a baseline you can compare against later.",
  },
  {
    id: "anomalies",
    title: "Catch anomalies / faults",
    blurb: "Find the most unusual stretches — early signs of faults or upsets.",
    jobType: "DISCORD_DAMP",
    available: true,
    explainer:
      "We look for the stretch that is least like anything else in the window. These stand-out events are often the earliest sign of a developing fault.",
  },
  {
    id: "auto-length",
    title: "Not sure? Auto-find patterns",
    blurb: "Let the app scan many pattern lengths and surface the best ones.",
    jobType: "PAN_MP",
    available: true,
    explainer:
      "If you don't know how long the pattern is, we try a whole range of lengths and keep the clearest results — so you never have to guess a number.",
  },
  {
    id: "regime-changes",
    title: "Detect regime / mode changes",
    blurb: "See when the machine switched behavior (start-up, steady, shutdown).",
    jobType: "SEGMENTATION",
    available: true,
    explainer:
      "We track how the signal's shape repeats and flag the moments its character changes, splitting the timeline into distinct operating modes — start-up, steady running, shutdown. The dips in the change-score line under the signal mark the switch-over points.",
  },
  {
    id: "degradation",
    title: "Track slow degradation",
    blurb: "Follow a pattern that drifts over time — bearing wear, fouling, drift.",
    jobType: "CHAIN",
    available: true,
    explainer:
      "We find a recurring pattern and link each repeat to the next, forming a chain that tracks how the shape slowly evolves. A steady drift along the chain is the fingerprint of gradual wear — bearing degradation, fouling, or sensor drift.",
  },
  {
    id: "compare-shared",
    title: "Compare two periods or machines",
    blurb: "Find where a second signal (or a later period) repeats shapes from the first.",
    jobType: "AB_MOTIF",
    available: true,
    compare: true,
    explainer:
      "Pick a baseline (series A) and a comparison (series B) — two different signals, or the same signal in two time windows (before/after). We find the stretches that look most alike across the two, so you can confirm a machine behaves like its healthy sibling, or that this week matches last week.",
  },
  {
    id: "compare-novelty",
    title: "See what changed vs a baseline",
    blurb: "Spot stretches of a signal that are unlike anything in a reference period.",
    jobType: "AB_DISCORD",
    available: true,
    compare: true,
    explainer:
      "Pick a known-good baseline (series A) and the period you want to check (series B). We flag the stretches of B that have no close match anywhere in A — the genuinely new behavior that emerged relative to the baseline.",
  },
  {
    id: "multi-sensor-events",
    title: "Find multi-sensor events",
    blurb: "Discover moments where several sensors on one asset move together in a repeating way.",
    jobType: "MULTIDIM_MOTIF",
    available: true,
    multi: true,
    requiresAlignment: true,
    explainer:
      "Pick several sensors from the same asset. We line them up on a common clock and find the moment their shapes repeat together, then tell you exactly which sensors took part. Great for spotting a coordinated operating event that no single sensor makes obvious.",
  },
  {
    id: "multi-sensor-anomalies",
    title: "Catch multi-sensor anomalies",
    blurb: "Flag stretches where several sensors jointly look unlike anything else.",
    jobType: "MULTIDIM_DISCORD",
    available: true,
    multi: true,
    requiresAlignment: true,
    explainer:
      "Pick several sensors from the same asset. We line them up on a common clock and flag the stretch that is most unlike the rest across the sensors together — a joint anomaly that stands out only when the sensors are read as a group, and we name which sensors drive it.",
  },
  {
    id: "multi-sensor-segments",
    title: "Segment multi-sensor behavior",
    blurb: "Split the timeline where several sensors change their joint behavior at once.",
    jobType: "MULTIDIM_SEGMENTATION",
    available: true,
    multi: true,
    requiresAlignment: true,
    explainer:
      "Pick several sensors from the same asset. We track how their combined shape repeats and flag the moments the joint behavior changes — start-up, steady running, shutdown — so the boundaries reflect the whole asset, not just one channel.",
  },
  {
    id: "fleet-common-shape",
    title: "Find a shape common across a fleet",
    blurb: "Find the one shape that shows up in every asset across a fleet of signals.",
    jobType: "CONSENSUS_MOTIF",
    available: true,
    multi: true,
    allowMinCount: true,
    explainer:
      "Pick the same measurement from several assets. We find the single shape that appears in all of them (no time alignment needed), so you can confirm a behavior is fleet-wide rather than a quirk of one machine. Optionally relax it to a shape shared by at least a chosen number of the assets.",
  },
];

export function recipeById(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export function availableRecipes(): Recipe[] {
  return RECIPES.filter((r) => r.available);
}

/**
 * Sensitivity slider (0..1) → top-k results to return. "Just the best" (0) → 1 result;
 * "show me several" (1) → up to 8. Presented to the user as a friendly slider, never as
 * a `top-k`/exclusion-zone number.
 */
export function sensitivityToTopK(sensitivity: number): number {
  const s = Math.max(0, Math.min(1, sensitivity));
  return Math.max(1, Math.round(1 + s * 7));
}

export function sensitivityLabel(sensitivity: number): string {
  const s = Math.max(0, Math.min(1, sensitivity));
  if (s < 0.2) return "Just the single best";
  if (s < 0.6) return "The clearest few";
  return "Show me several";
}
