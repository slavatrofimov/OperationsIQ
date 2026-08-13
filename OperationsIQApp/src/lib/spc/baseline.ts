/**
 * Governed SPC baseline lifecycle (SPC design spec §8.3, AC-2).
 *
 * A baseline records the control limits, chart configuration, rule profile, and
 * specification limits that define "normal" for a signal — plus the governance
 * metadata (version, approval, audit) that keeps limits from changing silently.
 *
 * Governance rules enforced here:
 *  - A newly saved baseline is a **draft** (version 1).
 *  - **Approving** a draft freezes it (`status = 'approved'`) and stamps the
 *    approver; approved baselines' limit fields are never rewritten in place.
 *  - **Revising** an existing baseline creates a *new version* (a new row,
 *    `version` incremented, `parent_id` linking the prior row) rather than
 *    mutating it — so limit changes are always explicit and auditable.
 *  - Every transition appends to an append-only `audit_json` trail.
 *
 * Persists to the `spc_baseline` table via the Rayfin data client; rows are
 * scoped to the signing-in user by the SpcBaseline row-level policy.
 */
import { client, getFabricAccountId, getFabricAccountEmail } from '../rayfinClient';
import { getActiveProfileId } from '../activeConnection';
import type { ControlChartType, ControlLimits, EstimatedLimits } from './controlChart';
import { DEFAULT_SUFFICIENCY, type SufficiencyPolicy } from './capability';

export type BaselineStatus = 'draft' | 'approved' | 'retired';
export type BaselinePhase = 'I' | 'II';

/** One entry in a baseline's append-only audit trail. */
export interface BaselineAuditEntry {
  action: string;
  by: string;
  at: string;
  note?: string;
}

/** A baseline as surfaced to the UI. */
export interface SpcBaselineView {
  id: string;
  name: string;
  tagId: string;
  chartType: ControlChartType;
  subgroupSize: number;
  centerLine: number;
  ucl: number;
  lcl: number;
  sigma: number;
  secondaryCenterLine?: number;
  secondaryUcl?: number;
  secondaryLcl?: number;
  ruleProfile: string;
  excludedPoints: number[];
  lsl?: number;
  usl?: number;
  target?: number;
  baselineStart?: Date;
  baselineEnd?: Date;
  baselineSubgroupCount?: number;
  phase: BaselinePhase;
  status: BaselineStatus;
  version: number;
  parentId?: string;
  approvedBy?: string;
  approvedAt?: Date;
  audit: BaselineAuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

/** Fields needed to persist a baseline from the control chart page. */
export interface SaveBaselineInput {
  name: string;
  tagId: string;
  chartType: ControlChartType;
  subgroupSize: number;
  /** Primary + secondary control limits to freeze. */
  primary: ControlLimits;
  secondary: ControlLimits;
  ruleProfile: string;
  excludedPoints?: number[];
  lsl?: number;
  usl?: number;
  target?: number;
  baselineStart?: Date;
  baselineEnd?: Date;
  baselineSubgroupCount?: number;
  phase: BaselinePhase;
}

const SELECT_FIELDS = [
  'id',
  'name',
  'tag_id',
  'chart_type',
  'subgroup_size',
  'center_line',
  'ucl',
  'lcl',
  'sigma',
  'secondary_center_line',
  'secondary_ucl',
  'secondary_lcl',
  'rule_profile',
  'excluded_points_json',
  'lsl',
  'usl',
  'target',
  'baseline_start',
  'baseline_end',
  'baseline_subgroup_count',
  'phase',
  'status',
  'version',
  'parent_id',
  'approved_by',
  'approved_at',
  'audit_json',
  'created_at',
  'updated_at',
  'connection_profile_id',
] as const;

function requireUser(): string {
  const id = getFabricAccountId();
  if (!id) throw new Error('Sign in with Fabric to manage SPC baselines.');
  return id;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

function optNum(v: unknown): number | undefined {
  return v == null ? undefined : Number(v);
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function optDate(v: unknown): Date | undefined {
  return v == null ? undefined : toDate(v);
}

function parseAudit(json: string | undefined | null): BaselineAuditEntry[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as BaselineAuditEntry[]) : [];
  } catch {
    return [];
  }
}

function parseExcluded(json: string | undefined | null): number[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function toView(r: any): SpcBaselineView {
  return {
    id: r.id,
    name: r.name,
    tagId: r.tag_id,
    chartType: r.chart_type as ControlChartType,
    subgroupSize: num(r.subgroup_size ?? 1),
    centerLine: num(r.center_line),
    ucl: num(r.ucl),
    lcl: num(r.lcl),
    sigma: num(r.sigma),
    secondaryCenterLine: optNum(r.secondary_center_line),
    secondaryUcl: optNum(r.secondary_ucl),
    secondaryLcl: optNum(r.secondary_lcl),
    ruleProfile: r.rule_profile,
    excludedPoints: parseExcluded(r.excluded_points_json),
    lsl: optNum(r.lsl),
    usl: optNum(r.usl),
    target: optNum(r.target),
    baselineStart: optDate(r.baseline_start),
    baselineEnd: optDate(r.baseline_end),
    baselineSubgroupCount: optNum(r.baseline_subgroup_count),
    phase: (r.phase as BaselinePhase) ?? 'I',
    status: (r.status as BaselineStatus) ?? 'draft',
    version: num(r.version ?? 1),
    parentId: r.parent_id ?? undefined,
    approvedBy: r.approved_by ?? undefined,
    approvedAt: optDate(r.approved_at),
    audit: parseAudit(r.audit_json),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

/** List the current user's baselines, newest activity first, optionally by tag. */
export async function listBaselines(tagId?: string): Promise<SpcBaselineView[]> {
  const rows = await client.data.SpcBaseline.select([...SELECT_FIELDS]).execute();
  const pid = getActiveProfileId();
  const scoped = pid
    ? rows.filter((r) => (r as { connection_profile_id?: string }).connection_profile_id === pid)
    : rows;
  return scoped
    .map(toView)
    .filter((b) => (tagId ? b.tagId === tagId : true))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** Reduce a save input to the persisted column values (shared by save/revise). */
function toColumns(input: SaveBaselineInput) {
  return {
    name: input.name,
    tag_id: input.tagId,
    chart_type: input.chartType,
    subgroup_size: input.subgroupSize,
    center_line: input.primary.centerLine,
    ucl: input.primary.ucl,
    lcl: input.primary.lcl,
    sigma: input.primary.sigma,
    secondary_center_line: input.secondary.centerLine,
    secondary_ucl: input.secondary.ucl,
    secondary_lcl: input.secondary.lcl,
    rule_profile: input.ruleProfile,
    excluded_points_json:
      input.excludedPoints && input.excludedPoints.length > 0
        ? JSON.stringify(input.excludedPoints)
        : undefined,
    lsl: input.lsl,
    usl: input.usl,
    target: input.target,
    baseline_start: input.baselineStart,
    baseline_end: input.baselineEnd,
    baseline_subgroup_count: input.baselineSubgroupCount,
    phase: input.phase,
  };
}

/**
 * Persist a new baseline as an unapproved **draft** (version 1). Returns the new
 * baseline id.
 */
export async function saveBaseline(input: SaveBaselineInput): Promise<string> {
  const userId = requireUser();
  const now = new Date();
  const by = getFabricAccountEmail() ?? userId;
  const audit: BaselineAuditEntry[] = [{ action: 'CREATED', by, at: now.toISOString() }];
  const created = await client.data.SpcBaseline.create({
    user_id: userId,
    connection_profile_id: getActiveProfileId(),
    ...toColumns(input),
    status: 'draft',
    version: 1,
    audit_json: JSON.stringify(audit),
    created_at: now,
    updated_at: now,
  });
  return (created as { id?: string })?.id ?? '';
}

async function appendAudit(
  view: SpcBaselineView,
  action: string,
  patch: Record<string, unknown>,
  note?: string,
): Promise<void> {
  const now = new Date();
  const by = getFabricAccountEmail() ?? getFabricAccountId() ?? 'unknown';
  const audit: BaselineAuditEntry[] = [...view.audit, { action, by, at: now.toISOString(), note }];
  await client.data.SpcBaseline.update(
    { id: view.id },
    { ...patch, audit_json: JSON.stringify(audit), updated_at: now },
  );
}

/**
 * Approve a draft baseline, freezing its limits (draft → approved). Throws if the
 * baseline is not currently a draft — approved baselines are immutable and must
 * be superseded via {@link reviseBaseline} rather than re-approved.
 */
export async function approveBaseline(view: SpcBaselineView, note?: string): Promise<void> {
  if (view.status !== 'draft') {
    throw new Error(`Only draft baselines can be approved (this one is ${view.status}).`);
  }
  const by = getFabricAccountEmail() ?? getFabricAccountId() ?? 'unknown';
  await appendAudit(
    view,
    'APPROVED',
    { status: 'approved' as BaselineStatus, approved_by: by, approved_at: new Date() },
    note,
  );
}

/** Retire a baseline so it is no longer offered for monitoring. */
export async function retireBaseline(view: SpcBaselineView, note?: string): Promise<void> {
  await appendAudit(view, 'RETIRED', { status: 'retired' as BaselineStatus }, note);
}

/**
 * Create a **new version** of an existing baseline from freshly computed limits,
 * rather than mutating the existing (possibly approved) row. The new row starts
 * as a draft with `version = prior + 1` and `parent_id` linking the prior row —
 * this is the governed way to change limits without a silent overwrite. Returns
 * the new baseline id.
 */
export async function reviseBaseline(
  prior: SpcBaselineView,
  input: SaveBaselineInput,
  note?: string,
): Promise<string> {
  const userId = requireUser();
  const now = new Date();
  const by = getFabricAccountEmail() ?? userId;
  const audit: BaselineAuditEntry[] = [
    {
      action: 'REVISED',
      by,
      at: now.toISOString(),
      note: note ?? `Revised from ${prior.name} v${prior.version}`,
    },
  ];
  const created = await client.data.SpcBaseline.create({
    user_id: userId,
    connection_profile_id: getActiveProfileId(),
    ...toColumns(input),
    status: 'draft',
    version: prior.version + 1,
    parent_id: prior.id,
    audit_json: JSON.stringify(audit),
    created_at: now,
    updated_at: now,
  });
  return (created as { id?: string })?.id ?? '';
}

/** Rebuild the 1σ/2σ zone boundaries around a center line for a given σ. */
function reconstructLimits(centerLine: number, ucl: number, lcl: number, sigma: number): ControlLimits {
  return {
    centerLine,
    ucl,
    lcl,
    sigma,
    zoneUpper1: centerLine + sigma,
    zoneUpper2: centerLine + 2 * sigma,
    // Variation charts floor the lower zones at the (non-negative) LCL.
    zoneLower1: Math.max(lcl, centerLine - sigma),
    zoneLower2: Math.max(lcl, centerLine - 2 * sigma),
  };
}

/**
 * Convert a stored baseline into the frozen {@link EstimatedLimits} shape that
 * `buildControlChart(type, subgroups, frozen)` needs to apply Phase II limits to
 * new data without recomputation.
 */
export function toFrozenLimits(view: SpcBaselineView): EstimatedLimits {
  const primary = reconstructLimits(view.centerLine, view.ucl, view.lcl, view.sigma);
  const secCl = view.secondaryCenterLine ?? 0;
  const secUcl = view.secondaryUcl ?? secCl;
  const secLcl = view.secondaryLcl ?? 0;
  const secSigma = (secUcl - secCl) / 3;
  const secondary = reconstructLimits(secCl, secUcl, secLcl, secSigma);
  return {
    type: view.chartType,
    subgroupSize: view.subgroupSize,
    primary,
    secondary,
  };
}

/** Result of the baseline-sufficiency policy check. */
export interface SufficiencyCheck {
  sufficient: boolean;
  warning?: string;
}

/**
 * Baseline-sufficiency policy (spec: configurable ≥20 / ≥25 subgroups). Returns a
 * warning when the estimating window is thinner than recommended.
 */
export function baselineSufficiency(
  subgroupCount: number,
  policy: SufficiencyPolicy = DEFAULT_SUFFICIENCY,
): SufficiencyCheck {
  if (subgroupCount >= policy.recommend) return { sufficient: true };
  if (subgroupCount >= policy.warnBelow) {
    return {
      sufficient: true,
      warning: `Baseline uses ${subgroupCount} subgroups. ${policy.recommend}+ is recommended for stable limit estimates.`,
    };
  }
  return {
    sufficient: false,
    warning: `Baseline uses only ${subgroupCount} subgroups. At least ${policy.warnBelow} (ideally ${policy.recommend}) is recommended before limits can be trusted.`,
  };
}
