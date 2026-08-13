/**
 * Process-capability compute core (Phase 2 of the SPC integration).
 *
 * Pure, dependency-free math — mirroring `controlChart.ts` and `rules.ts` — that
 * turns a set of observations plus **specification limits** into the standard
 * capability indices (Cp, Cpk, Pp, Ppk, Cpm) and an expected/observed
 * nonconformance rate in parts-per-million (PPM).
 *
 * Two principles from the SPC design spec are enforced here:
 *
 *  1. **Control limits and specification limits are kept strictly separate.**
 *     This module never sees control limits. It works only from the observed
 *     data (for the overall / long-term spread and the mean) plus a caller-
 *     supplied *within-subgroup* sigma (the short-term spread the control chart
 *     estimates). Cp/Cpk use the within sigma; Pp/Ppk/Cpm use the overall sigma.
 *
 *  2. **Capability is gated on stability (AR-003).** Capability indices are only
 *     meaningful for a process in statistical control. The caller declares
 *     whether the process is in control, or sets an explicit `exploratory` flag
 *     to compute indices anyway with an attached caveat. The result carries the
 *     gate decision so the UI can present (or withhold) the numbers honestly.
 */

/** What the caller knows about the process's statistical control state. */
export interface CapabilityStability {
  /** Whether the control chart shows the process to be in statistical control. */
  inControl: boolean;
  /** Compute indices even when not in control, flagged as exploratory. */
  exploratory?: boolean;
}

/** Inputs for a capability study. Spec limits are optional but at least one is
 *  needed to produce indices. */
export interface CapabilityInput {
  /** Individual observations (non-finite values are ignored). */
  values: number[];
  /** Lower specification limit (customer/engineering requirement). */
  lsl?: number;
  /** Upper specification limit. */
  usl?: number;
  /** Target / nominal value (used by Cpm). */
  target?: number;
  /**
   * Short-term, within-subgroup σ estimated by the control chart (e.g. MR̄/d₂ or
   * R̄/d₂). Drives the *potential* indices Cp/Cpk. When omitted, only the
   * *performance* indices Pp/Ppk/Cpm (which use the overall σ) are produced.
   */
  withinSigma?: number;
}

/** Minimum subgroup/sample counts before a capability estimate is trustworthy. */
export interface SufficiencyPolicy {
  /** Below this, a soft warning is attached. Default 20. */
  warnBelow: number;
  /** At/above this, the sample is considered comfortable. Default 25. */
  recommend: number;
}

export const DEFAULT_SUFFICIENCY: SufficiencyPolicy = { warnBelow: 20, recommend: 25 };

/**
 * Capability indices. Potential indices (Cp/Cpk/CPU/CPL) use the within σ;
 * performance indices (Pp/Ppk/PPU/PPL/Cpm) use the overall σ. Any index that
 * cannot be formed from the supplied spec limits / σ is left undefined.
 */
export interface CapabilityIndices {
  /** Potential capability (needs both spec limits + within σ). */
  cp?: number;
  /** Potential capability index (worst of CPU/CPL). */
  cpk?: number;
  /** One-sided potential capability, upper spec. */
  cpu?: number;
  /** One-sided potential capability, lower spec. */
  cpl?: number;
  /** Performance capability (needs both spec limits + overall σ). */
  pp?: number;
  /** Performance capability index (worst of PPU/PPL). */
  ppk?: number;
  /** One-sided performance, upper spec. */
  ppu?: number;
  /** One-sided performance, lower spec. */
  ppl?: number;
  /** Taguchi capability index (needs both spec limits, a target, overall σ). */
  cpm?: number;
}

/** Expected/observed nonconformance in parts-per-million against the spec. */
export interface NonconformancePpm {
  /** Expected PPM below LSL (normal model). Undefined when no LSL. */
  below?: number;
  /** Expected PPM above USL (normal model). Undefined when no USL. */
  above?: number;
  /** Expected total PPM outside spec (normal model). */
  total: number;
  /** Observed PPM outside spec, counted directly from the sample. */
  observed: number;
}

export interface CapabilityResult {
  /** Count of finite observations used. */
  n: number;
  mean: number;
  /** Overall (long-term) sample standard deviation. */
  overallSigma: number;
  /** Within-subgroup (short-term) σ as supplied, if any. */
  withinSigma?: number;
  lsl?: number;
  usl?: number;
  target?: number;
  indices: CapabilityIndices;
  /** Performance nonconformance (overall σ). */
  expectedPpm: NonconformancePpm;
  /** Potential nonconformance (within σ), when a within σ was supplied. */
  potentialPpm?: NonconformancePpm;
  /** Whether capability numbers should be treated as valid vs exploratory. */
  gate: { allowed: boolean; exploratory: boolean; reason: string };
  /** Non-fatal caveats (small sample, one-sided spec, not in control, ...). */
  warnings: string[];
}

/** Standard normal CDF via an erf approximation (Abramowitz & Stegun 7.1.26). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sampleStdev(values: number[], m: number): number {
  const n = values.length;
  if (n < 2) return 0;
  const ss = values.reduce((s, v) => s + (v - m) ** 2, 0);
  return Math.sqrt(ss / (n - 1));
}

/** Clamp a probability to [0,1] then scale to PPM. */
function toPpm(prob: number): number {
  return Math.max(0, Math.min(1, prob)) * 1e6;
}

/**
 * Expected nonconformance under a normal model with the given mean/σ, plus the
 * directly-observed fraction outside spec.
 */
function nonconformance(
  values: number[],
  m: number,
  sigma: number,
  lsl: number | undefined,
  usl: number | undefined,
): NonconformancePpm {
  let below: number | undefined;
  let above: number | undefined;
  if (sigma > 0) {
    if (lsl != null) below = toPpm(normalCdf((lsl - m) / sigma));
    if (usl != null) above = toPpm(1 - normalCdf((usl - m) / sigma));
  } else {
    // Degenerate (zero spread): everything is at the mean.
    if (lsl != null) below = m < lsl ? 1e6 : 0;
    if (usl != null) above = m > usl ? 1e6 : 0;
  }
  const total = (below ?? 0) + (above ?? 0);

  const outside = values.filter((v) => (lsl != null && v < lsl) || (usl != null && v > usl)).length;
  const observed = values.length > 0 ? (outside / values.length) * 1e6 : 0;

  return { below, above, total, observed };
}

/**
 * Compute the process-capability study. Returns undefined only when there are
 * fewer than two observations (no spread can be estimated).
 */
export function computeCapability(
  input: CapabilityInput,
  stability: CapabilityStability,
  policy: SufficiencyPolicy = DEFAULT_SUFFICIENCY,
): CapabilityResult | null {
  const values = input.values.filter((v) => Number.isFinite(v));
  const n = values.length;
  if (n < 2) return null;

  const { lsl, usl, target, withinSigma } = input;
  const m = mean(values);
  const overallSigma = sampleStdev(values, m);

  const indices: CapabilityIndices = {};

  // Potential (within-σ) indices — Cp / Cpk.
  if (withinSigma != null && withinSigma > 0) {
    if (usl != null) indices.cpu = (usl - m) / (3 * withinSigma);
    if (lsl != null) indices.cpl = (m - lsl) / (3 * withinSigma);
    if (lsl != null && usl != null) indices.cp = (usl - lsl) / (6 * withinSigma);
    if (indices.cpu != null || indices.cpl != null) {
      indices.cpk = Math.min(
        indices.cpu ?? Number.POSITIVE_INFINITY,
        indices.cpl ?? Number.POSITIVE_INFINITY,
      );
    }
  }

  // Performance (overall-σ) indices — Pp / Ppk / Cpm.
  if (overallSigma > 0) {
    if (usl != null) indices.ppu = (usl - m) / (3 * overallSigma);
    if (lsl != null) indices.ppl = (m - lsl) / (3 * overallSigma);
    if (lsl != null && usl != null) indices.pp = (usl - lsl) / (6 * overallSigma);
    if (indices.ppu != null || indices.ppl != null) {
      indices.ppk = Math.min(
        indices.ppu ?? Number.POSITIVE_INFINITY,
        indices.ppl ?? Number.POSITIVE_INFINITY,
      );
    }
    if (lsl != null && usl != null && target != null) {
      const tau = Math.sqrt(overallSigma ** 2 + (m - target) ** 2);
      indices.cpm = tau > 0 ? (usl - lsl) / (6 * tau) : undefined;
    }
  }

  const expectedPpm = nonconformance(values, m, overallSigma, lsl, usl);
  const potentialPpm =
    withinSigma != null && withinSigma > 0
      ? nonconformance(values, m, withinSigma, lsl, usl)
      : undefined;

  // Gating (AR-003): capability is only valid for a stable process.
  const exploratory = !!stability.exploratory;
  const allowed = stability.inControl || exploratory;
  const reason = stability.inControl
    ? 'Process is in statistical control; capability indices are valid.'
    : exploratory
      ? 'Process is NOT in statistical control — indices shown are exploratory only and may not predict future output.'
      : 'Process is NOT in statistical control. Capability indices are suppressed until the process is stabilized or exploratory mode is enabled.';

  const warnings: string[] = [];
  if (!stability.inControl) {
    warnings.push(
      'The process is not in statistical control. Stabilize it before trusting capability indices — an unstable process has no single, predictable capability.',
    );
  }
  if (n < policy.warnBelow) {
    warnings.push(
      `Only ${n} observations. Capability estimates are unreliable below ~${policy.warnBelow}; aim for ${policy.recommend}+ for a dependable study.`,
    );
  }
  if (lsl == null || usl == null) {
    warnings.push(
      'Only one specification limit supplied. Cp/Pp and two-sided PPM are unavailable; only the one-sided index is reported.',
    );
  }
  if (withinSigma == null) {
    warnings.push(
      'No within-subgroup σ supplied, so only performance indices (Pp/Ppk) are computed — not the potential indices (Cp/Cpk).',
    );
  }

  return {
    n,
    mean: m,
    overallSigma,
    withinSigma,
    lsl,
    usl,
    target,
    indices,
    expectedPpm,
    potentialPpm,
    gate: { allowed, exploratory, reason },
    warnings,
  };
}

/**
 * Recover the within-subgroup (short-term) process σ from a control chart's
 * primary-panel σ. The control chart reports the σ of the *plotted statistic*:
 * for individuals (I-MR, n=1) that is already the process σ, but for an X̄ chart
 * it is σ/√n. Multiplying by √n recovers the process σ for capability use.
 */
export function withinSigmaFromChart(primarySigma: number, subgroupSize: number): number {
  const n = Math.max(1, subgroupSize);
  return primarySigma * Math.sqrt(n);
}
