/**
 * What-if scenario helpers (functional spec §Simulation / what-if).
 *
 * A scenario takes a baseline signal and applies a chain of adjustments to
 * project an alternative trajectory, then compares KPIs (mean, peak, integral,
 * time-above-limit) between baseline and scenario and raises risk flags. This
 * is deterministic client-side math over the fetched baseline — no server model
 * — so results are transparent and reproducible from the saved inputs.
 */
import { client, getFabricAccountId } from './rayfinClient';

export type AdjustmentKind = 'scale' | 'offset' | 'ramp' | 'clamp';

export interface Adjustment {
  kind: AdjustmentKind;
  /** scale: multiplier (1 = no change). offset: additive constant. */
  value?: number;
  /** ramp: total additive change applied linearly from start (0) to end. */
  rampTo?: number;
  /** clamp: lower/upper bounds (either optional). */
  min?: number;
  max?: number;
  enabled: boolean;
}

/** Apply the enabled adjustments in order to a baseline value array. */
export function applyAdjustments(baseline: (number | null)[], adjustments: Adjustment[]): (number | null)[] {
  const n = baseline.length;
  let out = baseline.slice();
  for (const adj of adjustments) {
    if (!adj.enabled) continue;
    switch (adj.kind) {
      case 'scale': {
        const f = adj.value ?? 1;
        out = out.map((v) => (v == null ? null : v * f));
        break;
      }
      case 'offset': {
        const c = adj.value ?? 0;
        out = out.map((v) => (v == null ? null : v + c));
        break;
      }
      case 'ramp': {
        const total = adj.rampTo ?? 0;
        out = out.map((v, i) => (v == null ? null : v + (n > 1 ? (total * i) / (n - 1) : total)));
        break;
      }
      case 'clamp': {
        out = out.map((v) => {
          if (v == null) return null;
          let w = v;
          if (adj.min != null) w = Math.max(adj.min, w);
          if (adj.max != null) w = Math.min(adj.max, w);
          return w;
        });
        break;
      }
    }
  }
  return out;
}

export interface Kpis {
  mean: number;
  min: number;
  max: number;
  /** Time-weighted integral (Σ value · binSeconds), in value·seconds. */
  integral: number;
  /** Seconds spent at or above the limit (0 when no limit given). */
  timeAboveLimit: number;
}

export function computeKpis(values: (number | null)[], binSeconds: number, limit?: number): Kpis {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length === 0) {
    return { mean: 0, min: 0, max: 0, integral: 0, timeAboveLimit: 0 };
  }
  const sum = nums.reduce((s, v) => s + v, 0);
  const integral = sum * binSeconds;
  const timeAboveLimit =
    limit != null ? nums.filter((v) => v >= limit).length * binSeconds : 0;
  return {
    mean: sum / nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
    integral,
    timeAboveLimit,
  };
}

export interface KpiComparison {
  baseline: Kpis;
  scenario: Kpis;
}

export function compareKpis(
  baseline: (number | null)[],
  scenario: (number | null)[],
  binSeconds: number,
  limit?: number,
): KpiComparison {
  return {
    baseline: computeKpis(baseline, binSeconds, limit),
    scenario: computeKpis(scenario, binSeconds, limit),
  };
}

export interface RiskFlag {
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

/**
 * Derive risk flags from the scenario projection. Flags are heuristic and
 * advisory — they surface things worth a human's attention, not verdicts.
 */
export function riskFlags(
  cmp: KpiComparison,
  scenario: (number | null)[],
  opts: { upperLimit?: number; lowerLimit?: number } = {},
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const { upperLimit, lowerLimit } = opts;
  if (upperLimit != null && cmp.scenario.max > upperLimit) {
    flags.push({
      severity: 'critical',
      message: `Scenario peak ${cmp.scenario.max.toFixed(2)} exceeds upper limit ${upperLimit}.`,
    });
  }
  if (lowerLimit != null && cmp.scenario.min < lowerLimit) {
    flags.push({
      severity: 'warning',
      message: `Scenario minimum ${cmp.scenario.min.toFixed(2)} falls below lower limit ${lowerLimit}.`,
    });
  }
  const hasNegative = scenario.some((v) => v != null && v < 0);
  if (hasNegative && cmp.baseline.min >= 0) {
    flags.push({ severity: 'warning', message: 'Scenario introduces negative values not present in the baseline.' });
  }
  const meanBase = cmp.baseline.mean;
  if (meanBase !== 0) {
    const relChange = (cmp.scenario.mean - meanBase) / Math.abs(meanBase);
    if (Math.abs(relChange) >= 0.5) {
      flags.push({
        severity: 'info',
        message: `Mean shifts by ${(relChange * 100).toFixed(0)}% vs. baseline.`,
      });
    }
  }
  if (flags.length === 0) {
    flags.push({ severity: 'info', message: 'No risk thresholds breached under this scenario.' });
  }
  return flags;
}

/** Persist a scenario run (best-effort; skips when not signed in). */
export async function saveScenarioRun(input: {
  name: string;
  baseTagId: string;
  windowStart: Date;
  windowEnd: Date;
  adjustments: Adjustment[];
  kpis: KpiComparison;
  flags: RiskFlag[];
  featureVersion?: string;
}): Promise<string | undefined> {
  const userId = getFabricAccountId();
  if (!userId) return undefined;
  const created = await client.data.ScenarioRun.create({
    user_id: userId,
    name: input.name,
    base_tag_id: input.baseTagId,
    base_window_start: input.windowStart,
    base_window_end: input.windowEnd,
    adjustments_json: JSON.stringify(input.adjustments),
    kpi_json: JSON.stringify(input.kpis),
    risk_flags_json: JSON.stringify(input.flags),
    feature_version: input.featureVersion,
    created_at: new Date(),
  });
  return (created as { id?: string })?.id;
}
