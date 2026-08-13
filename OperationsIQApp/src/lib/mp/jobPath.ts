/**
 * Pre-submit compute-path estimation (design spec §8). Before a user submits, the wizard
 * tells them whether the request will run "near-interactive" (driver-only, seconds) or as
 * a full async Spark job — setting expectations honestly. Pure heuristics, unit-tested.
 */

export type ComputePath = "interactive" | "async";

export interface JobEstimate {
  path: ComputePath;
  /** rough O(n * m) work units. */
  workUnits: number;
  /** human estimate string. */
  etaText: string;
  /** the message shown before submit. */
  message: string;
}

/**
 * Threshold (in n*m work units) below which we run on the driver interactively. MOMP's
 * pruning gives orders-of-magnitude speedups, so the effective threshold is generous;
 * this is deliberately conservative so we never *over*-promise interactivity.
 */
const INTERACTIVE_WORK_LIMIT = 5_000_000; // ~ n=25k, m=200

export function estimateJob(
  points: number,
  subLen: number,
  opts: { panScan?: boolean } = {},
): JobEstimate {
  const m = Math.max(1, subLen);
  // Pan-MP scans a range of lengths -> multiply work by an effective factor.
  const scanFactor = opts.panScan ? 8 : 1;
  const workUnits = points * m * scanFactor;

  if (workUnits <= INTERACTIVE_WORK_LIMIT) {
    return {
      path: "interactive",
      workUnits,
      etaText: "a few seconds",
      message:
        "As the analysis starts, you'll see preliminary results appear and can decide when to stop and refine — no need to wait for it to fully finish.",
    };
  }

  // Very rough async ETA bucket. The floor is "several minutes" because every async
  // job pays the Spark session start-up cost before compute begins.
  const etaText = workUnits < 2e9 ? "several minutes" : "many minutes";
  return {
    path: "async",
    workUnits,
    etaText,
    message: `This is a large analysis, so it runs as a background job (typically ${etaText}). We'll show a best-so-far result as it computes, and you can keep working.`,
  };
}
