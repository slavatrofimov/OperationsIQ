/**
 * Governed per-signal metadata lifecycle.
 *
 * `SignalMetadata` is the authoritative, **workspace/org-governed** definition of
 * "normal / healthy" for a tag: operating limits, specification limits, setpoint,
 * rate limit, plausible physical range, and SPC/monitoring defaults. It is shared
 * for read across every user (so limits are consistent everywhere and available to
 * the agent) while writes follow the baseline governance pattern:
 *
 *  - A newly saved record is a **draft** (version 1).
 *  - **Approving** a draft freezes it (`status = 'approved'`) and stamps the
 *    approver; approved records' limit fields are never rewritten in place.
 *  - **Revising** an approved record creates a *new version* (a new row, `version`
 *    incremented, `parent_id` linking the prior row) rather than mutating it.
 *  - Every transition appends to an append-only `audit_json` trail.
 *
 * Control limits themselves live on an approved {@link SpcBaseline}; this record
 * binds to one via `activeBaselineId`.
 *
 * Persists to the `signal_metadata` table via the Rayfin data client (the Fabric
 * App SQL DB). That table is mirrored to OneLake and surfaced in the Eventhouse as
 * an external table joined into the "Signal Metadata" base query — but this module
 * reads/writes RayFin directly so an editor sees changes immediately (the KQL path
 * is eventually consistent through the mirror).
 */
import { EntityNameResolver } from '@microsoft/rayfin-lib';
import { client, getFabricAccountId, getFabricAccountEmail } from './rayfinClient';

/**
 * Align the client's collection (list) query field name with the DAB backend.
 *
 * The Rayfin client derives the GraphQL *list* query field from the **pluralized**
 * entity name (`EntityNameResolver.getPlural`, backed by the JS `pluralize` lib).
 * `pluralize` treats "metadata" as already-plural, so it leaves `SignalMetadata`
 * unchanged and the client queries `signalMetadata`. The DAB backend, however,
 * pluralizes the entity with Humanizer (.NET) and exposes the list query as
 * `signalMetadatas`. That mismatch makes every read fail with
 * "The field `signalMetadata` does not exist on the type `Query`".
 *
 * Mutations are unaffected because they use the SINGULAR name (`createSignalMetadata`,
 * `updateSignalMetadata`, ...), which matches DAB — that is why saves succeed while
 * reads come back empty. Registering the custom plural once here fixes both the
 * page-load error and the "blank on re-open" symptom for every consumer of this
 * module. Idempotent, so it is safe to run at import time.
 */
EntityNameResolver.setCustomPlural('SignalMetadata', 'SignalMetadatas');

export type SignalMetadataStatus = 'draft' | 'approved' | 'retired';

/** One entry in a record's append-only audit trail. */
export interface SignalMetadataAuditEntry {
  action: string;
  by: string;
  at: string;
  note?: string;
}

/** The governed metadata fields (no identity/governance columns). */
export interface SignalMetadataValues {
  name?: string;
  operatingSetpoint?: number;
  upperOperatingLimit?: number;
  lowerOperatingLimit?: number;
  maxRateOfChange?: number;
  usl?: number;
  lsl?: number;
  target?: number;
  physicalMin?: number;
  physicalMax?: number;
  sensorUncertainty?: number;
  activeBaselineId?: string;
  preferredChartType?: string;
  ruleProfile?: string;
  recommendedAlertThreshold?: number;
  recommendedConfidence?: number;
  notes?: string;
  effectiveFrom?: Date;
  effectiveTo?: Date;
}

/** A metadata record as surfaced to the UI. */
export interface SignalMetadataView extends SignalMetadataValues {
  id: string;
  signalId: string;
  scopeKey?: string;
  status: SignalMetadataStatus;
  version: number;
  parentId?: string;
  approvedBy?: string;
  approvedAt?: Date;
  authoredBy?: string;
  audit: SignalMetadataAuditEntry[];
  createdAt: Date;
  updatedAt: Date;
}

/** Fields needed to persist a metadata record. */
export interface SaveSignalMetadataInput extends SignalMetadataValues {
  signalId: string;
  scopeKey?: string;
}

const SELECT_FIELDS = [
  'id',
  'signal_id',
  'scope_key',
  'name',
  'operating_setpoint',
  'upper_operating_limit',
  'lower_operating_limit',
  'max_rate_of_change',
  'usl',
  'lsl',
  'target',
  'physical_min',
  'physical_max',
  'sensor_uncertainty',
  'active_baseline_id',
  'preferred_chart_type',
  'rule_profile',
  'recommended_alert_threshold',
  'recommended_confidence',
  'notes',
  'status',
  'version',
  'parent_id',
  'approved_by',
  'approved_at',
  'effective_from',
  'effective_to',
  'audit_json',
  'authored_by',
  'created_at',
  'updated_at',
] as const;

function requireUser(): string {
  const id = getFabricAccountId();
  if (!id) throw new Error('Sign in with Fabric to manage signal metadata.');
  return id;
}

function optNum(v: unknown): number | undefined {
  return v == null || v === '' ? undefined : Number(v);
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function optDate(v: unknown): Date | undefined {
  return v == null ? undefined : toDate(v);
}

function parseAudit(json: string | undefined | null): SignalMetadataAuditEntry[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as SignalMetadataAuditEntry[]) : [];
  } catch {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(r: any): SignalMetadataView {
  return {
    id: r.id,
    signalId: r.signal_id,
    scopeKey: r.scope_key ?? undefined,
    name: r.name ?? undefined,
    operatingSetpoint: optNum(r.operating_setpoint),
    upperOperatingLimit: optNum(r.upper_operating_limit),
    lowerOperatingLimit: optNum(r.lower_operating_limit),
    maxRateOfChange: optNum(r.max_rate_of_change),
    usl: optNum(r.usl),
    lsl: optNum(r.lsl),
    target: optNum(r.target),
    physicalMin: optNum(r.physical_min),
    physicalMax: optNum(r.physical_max),
    sensorUncertainty: optNum(r.sensor_uncertainty),
    activeBaselineId: r.active_baseline_id ?? undefined,
    preferredChartType: r.preferred_chart_type ?? undefined,
    ruleProfile: r.rule_profile ?? undefined,
    recommendedAlertThreshold: optNum(r.recommended_alert_threshold),
    recommendedConfidence: optNum(r.recommended_confidence),
    notes: r.notes ?? undefined,
    effectiveFrom: optDate(r.effective_from),
    effectiveTo: optDate(r.effective_to),
    status: (r.status as SignalMetadataStatus) ?? 'draft',
    version: Number(r.version ?? 1),
    parentId: r.parent_id ?? undefined,
    approvedBy: r.approved_by ?? undefined,
    approvedAt: optDate(r.approved_at),
    authoredBy: r.authored_by ?? undefined,
    audit: parseAudit(r.audit_json),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

/** Reduce a save input to the persisted metadata column values. */
function toColumns(input: SignalMetadataValues) {
  return {
    name: input.name,
    operating_setpoint: input.operatingSetpoint,
    upper_operating_limit: input.upperOperatingLimit,
    lower_operating_limit: input.lowerOperatingLimit,
    max_rate_of_change: input.maxRateOfChange,
    usl: input.usl,
    lsl: input.lsl,
    target: input.target,
    physical_min: input.physicalMin,
    physical_max: input.physicalMax,
    sensor_uncertainty: input.sensorUncertainty,
    active_baseline_id: input.activeBaselineId,
    preferred_chart_type: input.preferredChartType,
    rule_profile: input.ruleProfile,
    recommended_alert_threshold: input.recommendedAlertThreshold,
    recommended_confidence: input.recommendedConfidence,
    notes: input.notes,
    effective_from: input.effectiveFrom,
    effective_to: input.effectiveTo,
  };
}

/** List all governed metadata records (shared read), newest activity first. */
export async function listSignalMetadata(
  signalId?: string,
  scopeKey?: string,
): Promise<SignalMetadataView[]> {
  const rows = await client.data.SignalMetadata.select([...SELECT_FIELDS]).execute();
  return rows
    .map(toView)
    .filter((m) => (signalId ? m.signalId === signalId : true))
    // Scope to the active connection profile when a scopeKey is supplied. Legacy
    // records that predate profile tagging carry no scope_key and stay visible
    // in every profile so historical metadata is never hidden.
    .filter((m) => (scopeKey ? m.scopeKey == null || m.scopeKey === scopeKey : true))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * The single governed record that applies to each signal: the newest **approved**
 * record per signal id, falling back to the newest draft when none is approved.
 * This is the map consumer pages / the tag catalog merge should use for defaults.
 */
export async function getEffectiveSignalMetadata(
  scopeKey?: string,
): Promise<Map<string, SignalMetadataView>> {
  const all = await listSignalMetadata(undefined, scopeKey);
  const bySignal = new Map<string, SignalMetadataView>();
  for (const m of all) {
    if (m.status === 'retired') continue;
    const existing = bySignal.get(m.signalId);
    if (!existing) {
      bySignal.set(m.signalId, m);
      continue;
    }
    // Prefer approved over draft; then newer version / activity.
    const better =
      (m.status === 'approved' && existing.status !== 'approved') ||
      (m.status === existing.status && m.version > existing.version);
    if (better) bySignal.set(m.signalId, m);
  }
  return bySignal;
}

/** Persist a new metadata record as an unapproved **draft** (version 1). */
export async function saveSignalMetadata(input: SaveSignalMetadataInput): Promise<string> {
  const userId = requireUser();
  if (!input.signalId) throw new Error('Signal metadata needs a signalId.');
  const now = new Date();
  const by = getFabricAccountEmail() ?? userId;
  const audit: SignalMetadataAuditEntry[] = [{ action: 'CREATED', by, at: now.toISOString() }];
  const created = await client.data.SignalMetadata.create({
    signal_id: input.signalId,
    scope_key: input.scopeKey,
    ...toColumns(input),
    status: 'draft',
    version: 1,
    authored_by: by,
    audit_json: JSON.stringify(audit),
    created_at: now,
    updated_at: now,
  });
  return (created as { id?: string })?.id ?? '';
}

async function appendAudit(
  view: SignalMetadataView,
  action: string,
  patch: Record<string, unknown>,
  note?: string,
): Promise<void> {
  const now = new Date();
  const by = getFabricAccountEmail() ?? getFabricAccountId() ?? 'unknown';
  const audit: SignalMetadataAuditEntry[] = [
    ...view.audit,
    { action, by, at: now.toISOString(), note },
  ];
  await client.data.SignalMetadata.update(
    { id: view.id },
    { ...patch, audit_json: JSON.stringify(audit), updated_at: now },
  );
}

/**
 * Update an unapproved **draft** in place. Approved records are immutable — use
 * {@link reviseSignalMetadata} to supersede them with a new version.
 */
export async function updateDraftSignalMetadata(
  view: SignalMetadataView,
  values: SignalMetadataValues,
  note?: string,
): Promise<void> {
  if (view.status !== 'draft') {
    throw new Error(`Only draft metadata can be edited (this record is ${view.status}). Revise instead.`);
  }
  await appendAudit(view, 'UPDATED', { ...toColumns(values) }, note);
}

/** Approve a draft record, freezing its values (draft → approved). */
export async function approveSignalMetadata(view: SignalMetadataView, note?: string): Promise<void> {
  if (view.status !== 'draft') {
    throw new Error(`Only draft metadata can be approved (this record is ${view.status}).`);
  }
  const by = getFabricAccountEmail() ?? getFabricAccountId() ?? 'unknown';
  await appendAudit(
    view,
    'APPROVED',
    { status: 'approved' as SignalMetadataStatus, approved_by: by, approved_at: new Date() },
    note,
  );
}

/** Retire a record so it no longer applies to the signal. */
export async function retireSignalMetadata(view: SignalMetadataView, note?: string): Promise<void> {
  await appendAudit(view, 'RETIRED', { status: 'retired' as SignalMetadataStatus }, note);
}

/**
 * Create a **new version** of an existing record from edited values, rather than
 * mutating the existing (possibly approved) row. The new row starts as a draft with
 * `version = prior + 1` and `parent_id` linking the prior row. Returns the new id.
 */
export async function reviseSignalMetadata(
  prior: SignalMetadataView,
  values: SignalMetadataValues,
  note?: string,
): Promise<string> {
  const userId = requireUser();
  const now = new Date();
  const by = getFabricAccountEmail() ?? userId;
  const audit: SignalMetadataAuditEntry[] = [
    {
      action: 'REVISED',
      by,
      at: now.toISOString(),
      note: note ?? `Revised from v${prior.version}`,
    },
  ];
  const created = await client.data.SignalMetadata.create({
    signal_id: prior.signalId,
    scope_key: prior.scopeKey,
    ...toColumns(values),
    status: 'draft',
    version: prior.version + 1,
    parent_id: prior.id,
    authored_by: by,
    audit_json: JSON.stringify(audit),
    created_at: now,
    updated_at: now,
  });
  return (created as { id?: string })?.id ?? '';
}

/**
 * Re-exported from {@link module:signalMetadataMerge} (a client-free module) so the
 * pure overlay logic is unit-testable without RayFin configuration, while existing
 * `./signalMetadata` importers keep working unchanged.
 */
export { applySignalMetadataToTags, metadataOverlayWarning } from './signalMetadataMerge';

