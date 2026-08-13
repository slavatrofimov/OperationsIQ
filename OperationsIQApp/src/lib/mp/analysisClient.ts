/**
 * CRUD helpers for the Matrix Profile analysis entities (AnalysisJob, Label, DataSource,
 * Signal, LabelCategory) using the typed Rayfin client. Mirrors the pattern in savedViews.ts.
 *
 * All entity access goes through Operations IQ's `client` from rayfinClient.ts — never through the
 * Motif Explorer's own graphql.ts (design note §7 of the merge spec).
 */

import { client, getFabricAccountId, ensureFabricSession } from '../rayfinClient';
import { getActiveProfileId } from '../activeConnection';
import type {
  AnalysisJob,
  Label,
  LabelInput,
  LabelCategory,
  DataSource,
  Signal,
} from './types';

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Parse the persisted signalIds JSON array (stored as text) back into a string[]. */
function parseSignalIds(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return undefined;
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Parse the persisted params JSON (stored as text) back into a plain object. */
function parseParamsObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return undefined;
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** List all analysis jobs submitted by the current user. */
export async function listJobs(): Promise<AnalysisJob[]> {
  const rows = await client.data.AnalysisJob.select([
    'id',
    'name',
    'signal_id',
    'type',
    'windowStart',
    'windowEnd',
    'compareSignalId',
    'compareWindowStart',
    'compareWindowEnd',
    'signalIds',
    'nDims',
    'minCount',
    'subLen',
    'params',
    'status',
    'progressPct',
    'sparkAppId',
    'livySessionId',
    'livyStatementId',
    'livyState',
    'stage',
    'sparkUiUrl',
    'driverLogTail',
    'resultKqlTable',
    'resultKey',
    'overviewKqlTable',
    'errorMessage',
    'submittedAt',
    'startedAt',
    'finishedAt',
    'computeSeconds',
    'connection_profile_id',
  ]).execute();

  const pid = getActiveProfileId();
  const scoped = pid
    ? rows.filter((r) => (r as { connection_profile_id?: string }).connection_profile_id === pid)
    : rows;

  return scoped.map((r) => ({
    id: r.id,
    name: r.name ?? undefined,
    signalId: r.signal_id,
    type: r.type as AnalysisJob['type'],
    windowStart: r.windowStart instanceof Date ? r.windowStart.toISOString() : String(r.windowStart),
    windowEnd: r.windowEnd instanceof Date ? r.windowEnd.toISOString() : String(r.windowEnd),
    compareSignalId: r.compareSignalId ?? undefined,
    compareWindowStart:
      r.compareWindowStart instanceof Date
        ? r.compareWindowStart.toISOString()
        : r.compareWindowStart
          ? String(r.compareWindowStart)
          : undefined,
    compareWindowEnd:
      r.compareWindowEnd instanceof Date
        ? r.compareWindowEnd.toISOString()
        : r.compareWindowEnd
          ? String(r.compareWindowEnd)
          : undefined,
    signalIds: parseSignalIds(r.signalIds),
    nDims: r.nDims ?? undefined,
    minCount: r.minCount ?? undefined,
    subLen: r.subLen ?? undefined,
    status: r.status as AnalysisJob['status'],
    progressPct: r.progressPct ?? 0,
    sparkAppId: r.sparkAppId ?? undefined,
    livySessionId: r.livySessionId ?? undefined,
    livyStatementId: r.livyStatementId ?? undefined,
    livyState: r.livyState ?? undefined,
    stage: r.stage ?? undefined,
    sparkUiUrl: r.sparkUiUrl ?? undefined,
    driverLogTail: r.driverLogTail ?? undefined,
    resultKqlTable: r.resultKqlTable ?? undefined,
    resultKey: r.resultKey ?? undefined,
    overviewKqlTable: r.overviewKqlTable ?? undefined,
    // summary is surfaced via ResultArtifact; expose params as summary proxy
    summary: r.params ?? undefined,
    params: parseParamsObject(r.params),
    errorMessage: r.errorMessage ?? undefined,
    submittedAt:
      r.submittedAt instanceof Date
        ? r.submittedAt.toISOString()
        : r.submittedAt
          ? String(r.submittedAt)
          : undefined,
    startedAt:
      r.startedAt instanceof Date
        ? r.startedAt.toISOString()
        : r.startedAt
          ? String(r.startedAt)
          : undefined,
    finishedAt:
      r.finishedAt instanceof Date
        ? r.finishedAt.toISOString()
        : r.finishedAt
          ? String(r.finishedAt)
          : undefined,
    computeSeconds: r.computeSeconds ?? undefined,
  }));
}

/** Submit a new analysis job. */
export async function submitJob(input: {
  signalId: string;
  type: AnalysisJob['type'];
  windowStart: string;
  windowEnd: string;
  compareSignalId?: string;
  compareWindowStart?: string;
  compareWindowEnd?: string;
  signalIds?: string[];
  nDims?: number;
  minCount?: number;
  subLen?: number;
  name?: string;
  params?: Record<string, unknown>;
}): Promise<AnalysisJob> {
  // The page gate tracks the Eventhouse (Kusto) session, but persistence uses
  // the separate Rayfin/Fabric SSO session — hydrate it before reading the id.
  await ensureFabricSession();
  const userId = getFabricAccountId();
  if (!userId) throw new Error('Sign in before submitting a job.');

  const name = input.name?.trim() || undefined;
  // Persist the multi-series set as a JSON array of tag ids (null for single/two-series).
  const signalIdsJson =
    input.signalIds && input.signalIds.length > 0 ? JSON.stringify(input.signalIds) : undefined;

  const row = await client.data.AnalysisJob.create({
    name,
    signal_id: input.signalId,
    type: input.type as
      | 'MOTIF_MOMP'
      | 'DISCORD_DAMP'
      | 'FULL_MP'
      | 'PAN_MP'
      | 'SEGMENTATION'
      | 'CHAIN'
      | 'AB_MOTIF'
      | 'AB_DISCORD'
      | 'MULTIDIM_MOTIF'
      | 'MULTIDIM_DISCORD'
      | 'MULTIDIM_SEGMENTATION'
      | 'CONSENSUS_MOTIF',
    windowStart: new Date(input.windowStart),
    windowEnd: new Date(input.windowEnd),
    compareSignalId: input.compareSignalId,
    compareWindowStart: input.compareWindowStart ? new Date(input.compareWindowStart) : undefined,
    compareWindowEnd: input.compareWindowEnd ? new Date(input.compareWindowEnd) : undefined,
    signalIds: signalIdsJson,
    nDims: input.nDims,
    minCount: input.minCount,
    subLen: input.subLen,
    params: input.params ? JSON.stringify(input.params) : undefined,
    status: 'QUEUED',
    progressPct: 0,
    submittedBy: userId,
    connection_profile_id: getActiveProfileId(),
    submittedAt: new Date(),
  });

  return {
    id: row.id,
    name,
    signalId: input.signalId,
    type: input.type,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    compareSignalId: input.compareSignalId,
    compareWindowStart: input.compareWindowStart,
    compareWindowEnd: input.compareWindowEnd,
    signalIds: input.signalIds,
    nDims: input.nDims,
    minCount: input.minCount,
    subLen: input.subLen,
    status: 'QUEUED',
    progressPct: 0,
    params: input.params,
    submittedAt: new Date().toISOString(),
  };
}

/** Rename an analysis so it is easy to find in the run history. */
export async function renameJob(id: string, name: string): Promise<void> {
  await client.data.AnalysisJob.update({ id }, { name: name.trim() || undefined });
}

/** Cancel a running job by setting its status to CANCELLED. */
export async function cancelJob(id: string): Promise<void> {
  await client.data.AnalysisJob.update({ id }, { status: 'CANCELLED' });
}

/** Livy transparency fields patched by the dispatch + browser poll loop. */
export interface JobLivyPatch {
  status?: AnalysisJob['status'];
  progressPct?: number;
  livySessionId?: string;
  livyStatementId?: string;
  livyState?: string;
  stage?: string;
  sparkUiUrl?: string;
  driverLogTail?: string;
  errorMessage?: string;
  startedAt?: Date;
  finishedAt?: Date;
}

/** Patch the Livy monitoring fields on an AnalysisJob row (dispatch + polling). */
export async function patchJobFields(id: string, patch: JobLivyPatch): Promise<void> {
  await client.data.AnalysisJob.update({ id }, patch);
}

/** Permanently delete an analysis job row (after its Livy session is torn down). */
export async function deleteJobRow(id: string): Promise<void> {
  await client.data.AnalysisJob.delete({ id });
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** List all labels for a given signal. */
const LABEL_COLUMNS = [
  'id',
  'signal_id',
  'job_id',
  'labelCategory_id',
  'kind',
  'startIndex',
  'length',
  'text',
  'color',
  'confidence',
  'secondsPerSample',
  'createdAt',
  'connection_profile_id',
] as const;

type LabelRow = {
  id: string;
  signal_id: string;
  job_id?: string | null;
  labelCategory_id?: string | null;
  kind: string;
  startIndex: number;
  length: number;
  text?: string | null;
  color?: string | null;
  confidence?: number | null;
  secondsPerSample?: number | null;
  createdAt?: string | Date | null;
  connection_profile_id?: string | null;
};

function mapLabelRow(r: LabelRow): Label {
  const created =
    r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt ?? undefined;
  return {
    id: r.id,
    signalId: r.signal_id,
    jobId: r.job_id ?? undefined,
    kind: r.kind as Label['kind'],
    startIndex: r.startIndex,
    length: r.length,
    text: r.text ?? '',
    category: r.labelCategory_id ?? undefined,
    color: r.color ?? undefined,
    confidence: r.confidence ?? undefined,
    secondsPerSample: r.secondsPerSample ?? undefined,
    createdAt: created,
  };
}

/** All saved labels/patterns across every signal and run — powers the Pattern library. */
export async function listAllLabels(): Promise<Label[]> {
  const rows = await client.data.Label.select([...LABEL_COLUMNS]).execute();
  const pid = getActiveProfileId();
  const scoped = pid ? rows.filter((r) => (r as LabelRow).connection_profile_id === pid) : rows;
  return scoped.map((r) => mapLabelRow(r as LabelRow));
}

export async function listLabels(signalId: string): Promise<Label[]> {
  const rows = await client.data.Label.select([...LABEL_COLUMNS]).execute();
  const pid = getActiveProfileId();
  const scoped = pid ? rows.filter((r) => (r as LabelRow).connection_profile_id === pid) : rows;
  return scoped
    .map((r) => mapLabelRow(r as LabelRow))
    .filter((l) => l.signalId === signalId);
}

/** Create a single label. */
export async function createLabel(input: LabelInput): Promise<Label> {
  // The page gate tracks the Eventhouse (Kusto) session, but persistence uses
  // the separate Rayfin/Fabric SSO session — hydrate it before reading the id.
  await ensureFabricSession();
  const userId = getFabricAccountId();
  if (!userId) throw new Error('Sign in before creating a label.');

  const row = await client.data.Label.create({
    signal_id: input.signalId,
    job_id: input.jobId,
    labelCategory_id: input.category,
    kind: input.kind,
    startIndex: input.startIndex,
    length: input.length,
    text: input.text,
    color: input.color,
    confidence: input.confidence,
    secondsPerSample: input.secondsPerSample,
    createdBy: userId,
    connection_profile_id: getActiveProfileId(),
    createdAt: new Date(),
  });

  // Trust the persisted row as the source of truth: a real write echoes back the
  // server-assigned id. If it doesn't, the write did not land — surface that as an
  // error instead of fabricating a "successful" label the caller would show and store.
  if (!row?.id) {
    throw new Error('The label was not saved — the store did not return a persisted row.');
  }

  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : typeof row.createdAt === 'string'
        ? row.createdAt
        : undefined;

  return {
    id: row.id,
    signalId: input.signalId,
    jobId: input.jobId,
    kind: input.kind,
    startIndex: input.startIndex,
    length: input.length,
    text: input.text,
    category: input.category,
    color: input.color,
    confidence: input.confidence,
    secondsPerSample: input.secondsPerSample,
    createdAt,
  };
}

/** Create multiple labels in parallel. */
export async function createLabels(inputs: LabelInput[]): Promise<Label[]> {
  return Promise.all(inputs.map(createLabel));
}

/** Editable fields of an existing label — its labeled span/signal/kind are immutable. */
export interface LabelUpdate {
  text?: string;
  category?: string;
  color?: string;
  confidence?: number;
}

/** Update the editable fields (name/category/color/confidence) of an existing label. */
export async function updateLabel(id: string, patch: LabelUpdate): Promise<void> {
  // Persistence uses the Rayfin/Fabric SSO session (see createLabel) — hydrate it first.
  await ensureFabricSession();
  const userId = getFabricAccountId();
  if (!userId) throw new Error('Sign in before editing a label.');

  await client.data.Label.update(
    { id },
    {
      text: patch.text,
      labelCategory_id: patch.category,
      color: patch.color,
      confidence: patch.confidence,
    },
  );
}

/** Delete a label by id. */
export async function deleteLabel(id: string): Promise<void> {
  await client.data.Label.delete({ id });
}

// ---------------------------------------------------------------------------
// Label Categories
// ---------------------------------------------------------------------------

/**
 * Built-in label taxonomy for the operations-analyst persona. These give people labeling patterns
 * meaningful, reusable choices out of the box (before anyone curates workspace-specific
 * categories). They are surfaced alongside any control-plane {@link LabelCategory} rows;
 * a workspace category with the same name overrides its built-in counterpart. The ids are
 * stable `builtin:*` strings so a label's stored `labelCategory_id` resolves back to the
 * same name/color on read without needing a persisted row.
 */
export const DEFAULT_LABEL_CATEGORIES: LabelCategory[] = [
  { id: 'builtin:healthy', name: 'Healthy / normal', color: '#16a34a', description: 'Expected, healthy operating behavior.' },
  { id: 'builtin:anomaly', name: 'Anomaly / fault', color: '#dc2626', description: 'Abnormal behavior or a developing fault.' },
  { id: 'builtin:startup', name: 'Startup', color: '#2563eb', description: 'Equipment start-up / ramp-up.' },
  { id: 'builtin:shutdown', name: 'Shutdown', color: '#475569', description: 'Equipment shutdown / ramp-down.' },
  { id: 'builtin:setpoint', name: 'Setpoint change', color: '#d97706', description: 'Operator or control setpoint change.' },
  { id: 'builtin:transition', name: 'Mode transition', color: '#0d9488', description: 'Transition between operating modes.' },
  { id: 'builtin:sensor', name: 'Sensor issue', color: '#7c3aed', description: 'Suspected sensor drift, dropout, or noise.' },
  { id: 'builtin:maintenance', name: 'Maintenance', color: '#0891b2', description: 'Maintenance activity or intervention.' },
  { id: 'builtin:investigate', name: 'Needs investigation', color: '#ea580c', description: 'Flagged for follow-up review.' },
];

/**
 * List label categories: control-plane rows merged over the built-in defaults so the
 * labeling UI always offers a diverse, consistent taxonomy. Workspace categories win
 * on name collisions; otherwise the built-ins fill the list.
 */
export async function listLabelCategories(): Promise<LabelCategory[]> {
  let fetched: LabelCategory[] = [];
  try {
    const rows = await client.data.LabelCategory.select([
      'id',
      'name',
      'color',
      'description',
    ]).execute();
    fetched = rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      description: r.description ?? undefined,
    }));
  } catch {
    // Control-plane read unavailable — fall back to the built-in taxonomy alone.
  }

  const byName = new Map<string, LabelCategory>();
  for (const c of DEFAULT_LABEL_CATEGORIES) byName.set(c.name.toLowerCase(), c);
  for (const c of fetched) byName.set(c.name.toLowerCase(), c); // workspace rows override
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// Signals (DataSource-backed tag catalog)
// ---------------------------------------------------------------------------

/**
 * List signals registered under a given DataSource.
 * Falls back to empty when the DataSource entity is not populated; callers
 * should use the active ConnectionProfile's tag catalog instead.
 */
export async function listSignalsForDataSource(dataSourceId: string): Promise<Signal[]> {
  const rows = await client.data.Signal.select([
    'id',
    'dataSource_id',
    'tagName',
    'unit',
    'description',
  ]).execute();

  return rows
    .filter((r) => r.dataSource_id === dataSourceId)
    .map((r) => ({
      id: r.id,
      dataSourceId: r.dataSource_id,
      tagName: r.tagName,
      unit: r.unit ?? undefined,
      description: r.description ?? undefined,
    }));
}

/** List all DataSources visible to the current user (power-user / data engineer view). */
export async function listDataSources(): Promise<DataSource[]> {
  const rows = await client.data.DataSource.select([
    'id',
    'name',
    'kqlClusterUri',
    'database',
    'table',
    'timeColumn',
    'valueColumn',
    'tagColumn',
    'defaultSampleRateHz',
  ]).execute();

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kqlClusterUri: r.kqlClusterUri,
    database: r.database,
    table: r.table,
    timeColumn: r.timeColumn,
    valueColumn: r.valueColumn,
    tagColumn: r.tagColumn ?? undefined,
    defaultSampleRateHz: r.defaultSampleRateHz,
  }));
}
