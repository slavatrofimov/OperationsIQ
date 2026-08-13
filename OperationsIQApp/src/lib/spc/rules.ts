/**
 * Configurable special-cause rule engine (Phase 1 of the SPC integration).
 *
 * Implements the eight Nelson / Western Electric / Minitab "tests for special
 * causes" as toggleable, parameterized rules. The design goals from the SPC
 * spec are:
 *
 *   - **Configurable profiles, not hard-coded truth** — WECO, Nelson, and a
 *     3σ-only "basic" profile all select different subsets of the same tests.
 *   - **Explainable evidence** — every violation carries structured data (rule
 *     id, name, the points involved, which side of the centerline, the σ-zone,
 *     and a plain-language description) so the UI and alerting layer can show
 *     "why this fired" without re-deriving anything.
 *
 * The engine is a pure function over an ordered array of plotted statistics plus
 * the control limits/zones (from `controlChart.ts`). It has no UI or IO deps, so
 * it is equally usable by the control-chart page and the alert evaluator.
 */

import type { ControlLimits } from './controlChart';

/** Nelson/Minitab test numbers 1–8. */
export type RuleId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Which side of the centerline (or both) a violation sits on. */
export type ViolationSide = 'above' | 'below' | 'both';

/** A single detected special-cause pattern. */
export interface RuleViolation {
  ruleId: RuleId;
  ruleName: string;
  /** Indices (into the input values) that make up the violating window. */
  pointIndices: number[];
  /** The point whose plot the UI should flag (usually the last in the window). */
  flaggedIndex: number;
  side: ViolationSide;
  /** The most relevant σ-zone for the pattern (1, 2, or 3). */
  sigmaZone: number;
  description: string;
}

/** Tunable run lengths so profiles like WECO can override Nelson defaults. */
export interface RuleParams {
  /** Rule 2: points in a row on one side of the centerline (Nelson 9, WECO 8). */
  sameSideRun: number;
  /** Rule 3: points in a row steadily increasing or decreasing. */
  trendRun: number;
  /** Rule 4: points in a row alternating up and down. */
  alternatingRun: number;
  /** Rule 7: points in a row within 1σ of the centerline (stratification). */
  within1SigmaRun: number;
  /** Rule 8: points in a row beyond 1σ on either side (mixture). */
  beyond1SigmaRun: number;
}

export const DEFAULT_RULE_PARAMS: RuleParams = {
  sameSideRun: 9,
  trendRun: 6,
  alternatingRun: 14,
  within1SigmaRun: 15,
  beyond1SigmaRun: 8,
};

/** Human-facing metadata for each rule. */
export const RULE_DEFS: Record<RuleId, { name: string; describe: (p: RuleParams) => string }> = {
  1: { name: 'Beyond 3σ', describe: () => 'One point falls outside the 3σ control limits.' },
  2: {
    name: 'Same-side run',
    describe: (p) => `${p.sameSideRun} points in a row on the same side of the centerline.`,
  },
  3: {
    name: 'Trend',
    describe: (p) => `${p.trendRun} points in a row steadily increasing or decreasing.`,
  },
  4: {
    name: 'Alternating',
    describe: (p) => `${p.alternatingRun} points in a row alternating up and down.`,
  },
  5: { name: '2 of 3 beyond 2σ', describe: () => '2 of 3 consecutive points beyond 2σ on the same side.' },
  6: { name: '4 of 5 beyond 1σ', describe: () => '4 of 5 consecutive points beyond 1σ on the same side.' },
  7: {
    name: 'Stratification',
    describe: (p) => `${p.within1SigmaRun} points in a row within 1σ of the centerline.`,
  },
  8: {
    name: 'Mixture',
    describe: (p) => `${p.beyond1SigmaRun} points in a row beyond 1σ, none within 1σ.`,
  },
};

/** Named, editable rule-set profiles. `basic` is the plain 3σ Shewhart rule. */
export const RULE_PROFILES: Record<string, { label: string; ruleIds: RuleId[]; params?: Partial<RuleParams> }> = {
  basic: { label: 'Basic (3σ only)', ruleIds: [1] },
  // Rule ids follow the Nelson/Minitab numbering (tests 1-8). The classic Western
  // Electric Handbook defines only four zone rules, which map onto that numbering as:
  //   WE1 = one point beyond 3σ            -> rule 1
  //   WE2 = 2 of 3 consecutive beyond 2σ   -> rule 5 (same side)
  //   WE3 = 4 of 5 consecutive beyond 1σ   -> rule 6 (same side)
  //   WE4 = 8 in a row on one side         -> rule 2 (hence sameSideRun: 8; Nelson's default is 9)
  // Rules 3 (trend) and 4 (alternating/oscillation) are Nelson additions, not part of the
  // original Western Electric set, so they are intentionally excluded here (not skipped by mistake).
  weco: { label: 'Western Electric', ruleIds: [1, 5, 6, 2], params: { sameSideRun: 8 } },
  nelson: { label: 'Nelson (all 8)', ruleIds: [1, 2, 3, 4, 5, 6, 7, 8] },
  minitab: { label: 'Minitab Tests 1–8', ruleIds: [1, 2, 3, 4, 5, 6, 7, 8] },
};

/** Input to the engine: the plotted statistics plus their control limits. */
export interface RuleInput {
  /** Plotted statistic per point; nulls (gaps) break runs and are skipped. */
  values: (number | null)[];
  limits: ControlLimits;
}

/** Signed distance of a value from the centerline, in units of σ (may be ±∞ if σ=0). */
function zoneOf(value: number, limits: ControlLimits): number {
  if (limits.sigma <= 0) return value === limits.centerLine ? 0 : value > limits.centerLine ? Infinity : -Infinity;
  return (value - limits.centerLine) / limits.sigma;
}

/** Collect the indices of finite (non-gap) points, preserving order. */
function finiteIndices(values: (number | null)[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) out.push(i);
  }
  return out;
}

function ruleName(id: RuleId): string {
  return RULE_DEFS[id].name;
}

/** Rule 1: any single point beyond the 3σ control limits. */
function checkRule1(input: RuleInput): RuleViolation[] {
  const out: RuleViolation[] = [];
  const { values, limits } = input;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (v > limits.ucl || v < limits.lcl) {
      out.push({
        ruleId: 1,
        ruleName: ruleName(1),
        pointIndices: [i],
        flaggedIndex: i,
        side: v > limits.ucl ? 'above' : 'below',
        sigmaZone: 3,
        description: RULE_DEFS[1].describe(DEFAULT_RULE_PARAMS),
      });
    }
  }
  return out;
}

/** Rule 2: `run` points in a row all on the same side of the centerline. */
function checkRule2(input: RuleInput, params: RuleParams): RuleViolation[] {
  const out: RuleViolation[] = [];
  const { values, limits } = input;
  const idx = finiteIndices(values);
  const run = params.sameSideRun;
  let streak = 0;
  let sign = 0;
  for (let k = 0; k < idx.length; k++) {
    const v = values[idx[k]] as number;
    const s = v > limits.centerLine ? 1 : v < limits.centerLine ? -1 : 0;
    if (s !== 0 && s === sign) streak++;
    else {
      sign = s;
      streak = s === 0 ? 0 : 1;
    }
    if (streak >= run) {
      const window = idx.slice(k - run + 1, k + 1);
      out.push({
        ruleId: 2,
        ruleName: ruleName(2),
        pointIndices: window,
        flaggedIndex: idx[k],
        side: sign > 0 ? 'above' : 'below',
        sigmaZone: 1,
        description: RULE_DEFS[2].describe(params),
      });
    }
  }
  return out;
}

/** Rule 3: `run` points in a row monotonically increasing or decreasing. */
function checkRule3(input: RuleInput, params: RuleParams): RuleViolation[] {
  const out: RuleViolation[] = [];
  const { values } = input;
  const idx = finiteIndices(values);
  const run = params.trendRun;
  let upStreak = 1;
  let downStreak = 1;
  for (let k = 1; k < idx.length; k++) {
    const prev = values[idx[k - 1]] as number;
    const cur = values[idx[k]] as number;
    if (cur > prev) {
      upStreak++;
      downStreak = 1;
    } else if (cur < prev) {
      downStreak++;
      upStreak = 1;
    } else {
      upStreak = 1;
      downStreak = 1;
    }
    // A run of `run` points has run-1 consecutive same-direction steps.
    if (upStreak >= run || downStreak >= run) {
      const window = idx.slice(k - run + 1, k + 1);
      out.push({
        ruleId: 3,
        ruleName: ruleName(3),
        pointIndices: window,
        flaggedIndex: idx[k],
        side: upStreak >= run ? 'above' : 'below',
        sigmaZone: 1,
        description: RULE_DEFS[3].describe(params),
      });
    }
  }
  return out;
}

/** Rule 4: `run` points in a row alternating direction (up, down, up, ...). */
function checkRule4(input: RuleInput, params: RuleParams): RuleViolation[] {
  const out: RuleViolation[] = [];
  const { values } = input;
  const idx = finiteIndices(values);
  const run = params.alternatingRun;
  let altStreak = 1;
  let lastDir = 0;
  for (let k = 1; k < idx.length; k++) {
    const prev = values[idx[k - 1]] as number;
    const cur = values[idx[k]] as number;
    const dir = cur > prev ? 1 : cur < prev ? -1 : 0;
    if (dir === 0) {
      altStreak = 1;
      lastDir = 0;
      continue;
    }
    if (lastDir !== 0 && dir === -lastDir) altStreak++;
    else altStreak = 2; // current step plus its predecessor start a fresh alternation
    lastDir = dir;
    if (altStreak >= run) {
      const window = idx.slice(k - run + 1, k + 1);
      out.push({
        ruleId: 4,
        ruleName: ruleName(4),
        pointIndices: window,
        flaggedIndex: idx[k],
        side: 'both',
        sigmaZone: 1,
        description: RULE_DEFS[4].describe(params),
      });
    }
  }
  return out;
}

/**
 * Generic "m out of the last w points beyond `zone`σ on the same side" test,
 * shared by Rule 5 (2 of 3 beyond 2σ) and Rule 6 (4 of 5 beyond 1σ).
 */
function checkOutOfWindow(
  input: RuleInput,
  ruleId: 5 | 6,
  m: number,
  w: number,
  zone: number,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  const { values, limits } = input;
  const idx = finiteIndices(values);
  for (let k = w - 1; k < idx.length; k++) {
    const window = idx.slice(k - w + 1, k + 1);
    let above = 0;
    let below = 0;
    for (const j of window) {
      const z = zoneOf(values[j] as number, limits);
      if (z >= zone) above++;
      else if (z <= -zone) below++;
    }
    // The current point must itself be beyond the zone for the pattern to flag here.
    const zCur = zoneOf(values[idx[k]] as number, limits);
    if (above >= m && zCur >= zone) {
      out.push({
        ruleId,
        ruleName: ruleName(ruleId),
        pointIndices: window,
        flaggedIndex: idx[k],
        side: 'above',
        sigmaZone: zone,
        description: RULE_DEFS[ruleId].describe(DEFAULT_RULE_PARAMS),
      });
    } else if (below >= m && zCur <= -zone) {
      out.push({
        ruleId,
        ruleName: ruleName(ruleId),
        pointIndices: window,
        flaggedIndex: idx[k],
        side: 'below',
        sigmaZone: zone,
        description: RULE_DEFS[ruleId].describe(DEFAULT_RULE_PARAMS),
      });
    }
  }
  return out;
}

/** Rule 7: `run` points in a row all within 1σ of the centerline (stratification). */
function checkRule7(input: RuleInput, params: RuleParams): RuleViolation[] {
  const out: RuleViolation[] = [];
  const { values, limits } = input;
  const idx = finiteIndices(values);
  const run = params.within1SigmaRun;
  let streak = 0;
  for (let k = 0; k < idx.length; k++) {
    const z = Math.abs(zoneOf(values[idx[k]] as number, limits));
    if (z < 1) streak++;
    else streak = 0;
    if (streak >= run) {
      out.push({
        ruleId: 7,
        ruleName: ruleName(7),
        pointIndices: idx.slice(k - run + 1, k + 1),
        flaggedIndex: idx[k],
        side: 'both',
        sigmaZone: 1,
        description: RULE_DEFS[7].describe(params),
      });
    }
  }
  return out;
}

/** Rule 8: `run` points in a row all beyond 1σ (either side), none within 1σ (mixture). */
function checkRule8(input: RuleInput, params: RuleParams): RuleViolation[] {
  const out: RuleViolation[] = [];
  const { values, limits } = input;
  const idx = finiteIndices(values);
  const run = params.beyond1SigmaRun;
  let streak = 0;
  for (let k = 0; k < idx.length; k++) {
    const z = Math.abs(zoneOf(values[idx[k]] as number, limits));
    if (z > 1) streak++;
    else streak = 0;
    if (streak >= run) {
      out.push({
        ruleId: 8,
        ruleName: ruleName(8),
        pointIndices: idx.slice(k - run + 1, k + 1),
        flaggedIndex: idx[k],
        side: 'both',
        sigmaZone: 1,
        description: RULE_DEFS[8].describe(params),
      });
    }
  }
  return out;
}

/** Configuration for one evaluation pass. */
export interface RuleConfig {
  /** Which rules to run. */
  ruleIds: RuleId[];
  /** Run-length overrides (merged over {@link DEFAULT_RULE_PARAMS}). */
  params?: Partial<RuleParams>;
}

/** Resolve a named profile (or a custom config) into a concrete {@link RuleConfig}. */
export function resolveProfile(profile: string): RuleConfig {
  const p = RULE_PROFILES[profile] ?? RULE_PROFILES.nelson;
  return { ruleIds: p.ruleIds, params: p.params };
}

/**
 * Evaluate the enabled special-cause rules over the plotted statistics and
 * return every violation, in point order. Pure and side-effect free.
 */
export function evaluateRules(input: RuleInput, config: RuleConfig): RuleViolation[] {
  const params: RuleParams = { ...DEFAULT_RULE_PARAMS, ...(config.params ?? {}) };
  const enabled = new Set(config.ruleIds);
  const out: RuleViolation[] = [];
  if (enabled.has(1)) out.push(...checkRule1(input));
  if (enabled.has(2)) out.push(...checkRule2(input, params));
  if (enabled.has(3)) out.push(...checkRule3(input, params));
  if (enabled.has(4)) out.push(...checkRule4(input, params));
  if (enabled.has(5)) out.push(...checkOutOfWindow(input, 5, 2, 3, 2));
  if (enabled.has(6)) out.push(...checkOutOfWindow(input, 6, 4, 5, 1));
  if (enabled.has(7)) out.push(...checkRule7(input, params));
  if (enabled.has(8)) out.push(...checkRule8(input, params));
  return out.sort((a, b) => a.flaggedIndex - b.flaggedIndex || a.ruleId - b.ruleId);
}

/**
 * Distinct indices flagged by any rule — the set of points a chart should mark
 * as out-of-control.
 */
export function flaggedIndices(violations: RuleViolation[]): Set<number> {
  return new Set(violations.map((v) => v.flaggedIndex));
}

// ---------------------------------------------------------------------------
// False-alarm transparency (SPC spec §7, §8.2)
//
// Broader rule sets catch smaller shifts sooner, but every added test also
// raises the chance of a *false* alarm on a process that is actually in
// control. To make that tradeoff visible we estimate two quantities for the
// selected profile, assuming a normally distributed, independent in-control
// process:
//
//   - α (alpha): the per-point probability of at least one false signal.
//   - ARL₀:      the in-control Average Run Length, i.e. the expected number
//                of points between false alarms (≈ 1/α).
//
// Rather than hard-code literature ARLs that only hold for one fixed set of
// run-length parameters, we run the *same* `evaluateRules` engine — with the
// user's exact parameters — over simulated standard-normal data. This stays
// honest when a profile overrides a run length (e.g. WECO's 8-in-a-row).
// ---------------------------------------------------------------------------

/** In-control reference limits on the standard-normal (z) scale: CL=0, σ=1, ±3σ. */
export const STANDARD_NORMAL_LIMITS: ControlLimits = {
  centerLine: 0,
  ucl: 3,
  lcl: -3,
  sigma: 1,
  zoneUpper1: 1,
  zoneUpper2: 2,
  zoneLower1: -1,
  zoneLower2: -2,
};

export interface FalseAlarmEstimate {
  /** Per-point probability of a false signal on an in-control process. */
  alpha: number;
  /** In-control Average Run Length: expected points between false alarms (≈ 1/α). */
  arl0: number;
  /** The rules included in this estimate. */
  ruleIds: RuleId[];
  /** Total simulated in-control points behind the estimate. */
  samples: number;
}

/** Deterministic PRNG (mulberry32) so previews are stable across renders. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via the Box–Muller transform. */
function nextNormal(rng: () => number): number {
  let u = rng();
  const v = rng();
  if (u < 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const FALSE_ALARM_CACHE = new Map<string, FalseAlarmEstimate>();

/**
 * Estimate the in-control false-alarm rate (α) and ARL₀ for a rule config via a
 * deterministic Monte-Carlo simulation of standard-normal data through the same
 * rule engine. Results are cached per config so repeated calls are cheap.
 *
 * ARL₀ is estimated as a **first-passage** quantity — the mean number of points
 * from a fresh, in-control start until the first signal — which is the standard
 * definition practitioners expect. α is reported as its reciprocal.
 *
 * @param seriesLength length of each simulated in-control series; must be long
 *   relative to the ARL so that censoring (no signal in a series) is negligible.
 * @param seriesCount  number of independent fresh-start series to simulate.
 */
export function estimateFalseAlarm(
  config: RuleConfig,
  seriesLength = 4000,
  seriesCount = 300,
): FalseAlarmEstimate {
  const params: RuleParams = { ...DEFAULT_RULE_PARAMS, ...(config.params ?? {}) };
  const ruleIds = [...config.ruleIds].sort((a, b) => a - b);
  const key = `${ruleIds.join(',')}|${JSON.stringify(params)}|${seriesLength}x${seriesCount}`;
  const cached = FALSE_ALARM_CACHE.get(key);
  if (cached) return cached;

  const rng = mulberry32(0x5f3759df);
  const cfg: RuleConfig = { ruleIds, params };
  let runLengthSum = 0;
  for (let s = 0; s < seriesCount; s++) {
    const values = new Array<number>(seriesLength);
    for (let i = 0; i < seriesLength; i++) values[i] = nextNormal(rng);
    const violations = evaluateRules({ values, limits: STANDARD_NORMAL_LIMITS }, cfg);
    let first = Infinity;
    for (const v of violations) if (v.flaggedIndex < first) first = v.flaggedIndex;
    // Run length = points observed up to and including the first signal;
    // right-censored at the series length when no signal occurred.
    runLengthSum += Number.isFinite(first) ? first + 1 : seriesLength;
  }
  const arl0 = seriesCount > 0 ? runLengthSum / seriesCount : Infinity;
  const estimate: FalseAlarmEstimate = {
    alpha: arl0 > 0 && Number.isFinite(arl0) ? 1 / arl0 : 0,
    arl0,
    ruleIds,
    samples: seriesLength * seriesCount,
  };
  FALSE_ALARM_CACHE.set(key, estimate);
  return estimate;
}
