/**
 * Alert Center: the operational lifecycle layer over fired alert events
 * (functional spec §Alert center). Provides:
 *  - dedup/alarm-storm collapse (fire → update existing or create new),
 *  - lifecycle transitions (acknowledge, assign, suppress, close) with an
 *    append-only audit trail,
 *  - evidence-bundle export for escalation/handover.
 *
 * Persists to the `alert_events` table via the Rayfin data client. Rows are
 * scoped to the signing-in user by the AlertEvent row-level policy.
 */
import { client, getFabricAccountId, getFabricAccountEmail } from './rayfinClient';
import { downloadText } from './export';

export type AlertStatus = 'OPEN' | 'ACK' | 'SUPPRESSED' | 'CLOSED';
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** One entry in an alert's append-only audit trail. */
export interface AuditEntry {
  action: string;
  by: string;
  at: string;
  note?: string;
}

/** An alert event as surfaced to the UI. */
export interface AlertEventView {
  id: string;
  ruleId?: string;
  tagId: string;
  severity: AlertSeverity;
  title: string;
  message?: string;
  dedupKey: string;
  status: AlertStatus;
  assignee?: string;
  occurrenceCount: number;
  currentValue?: number;
  openedAt: Date;
  updatedAt: Date;
  lastOccurrenceAt?: Date;
  closedAt?: Date;
  suppressedUntil?: Date;
  audit: AuditEntry[];
  evidence?: Record<string, unknown>;
}

/** Inputs used when an alert fires. */
export interface FireAlertInput {
  ruleId?: string;
  tagId: string;
  severity: AlertSeverity;
  title: string;
  message?: string;
  /** Stable grouping key; defaults to `${ruleId ?? tagId}:${severity}`. */
  dedupKey?: string;
  currentValue?: number;
  evidence?: Record<string, unknown>;
}

function requireUser(): string {
  const id = getFabricAccountId();
  if (!id) throw new Error('Sign in with Fabric to use Findings.');
  return id;
}

function parseAudit(json: string | undefined | null): AuditEntry[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as AuditEntry[]) : [];
  } catch {
    return [];
  }
}

function parseEvidence(json: string | undefined | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toView(r: any): AlertEventView {
  return {
    id: r.id,
    ruleId: r.rule_id ?? undefined,
    tagId: r.tag_id,
    severity: (r.severity as AlertSeverity) ?? 'info',
    title: r.title,
    message: r.message ?? undefined,
    dedupKey: r.dedup_key,
    status: (r.status as AlertStatus) ?? 'OPEN',
    assignee: r.assignee ?? undefined,
    occurrenceCount: Number(r.occurrence_count ?? 1),
    currentValue: r.current_value == null ? undefined : Number(r.current_value),
    openedAt: toDate(r.opened_at),
    updatedAt: toDate(r.updated_at),
    lastOccurrenceAt: r.last_occurrence_at ? toDate(r.last_occurrence_at) : undefined,
    closedAt: r.closed_at ? toDate(r.closed_at) : undefined,
    suppressedUntil: r.suppressed_until ? toDate(r.suppressed_until) : undefined,
    audit: parseAudit(r.audit_json),
    evidence: parseEvidence(r.evidence_json),
  };
}

const SELECT_FIELDS = [
  'id',
  'rule_id',
  'tag_id',
  'severity',
  'title',
  'message',
  'dedup_key',
  'status',
  'assignee',
  'occurrence_count',
  'current_value',
  'opened_at',
  'updated_at',
  'last_occurrence_at',
  'closed_at',
  'suppressed_until',
  'audit_json',
  'evidence_json',
] as const;

/** List the current user's alert events, newest activity first. */
export async function listAlertEvents(): Promise<AlertEventView[]> {
  const rows = await client.data.AlertEvent.select([...SELECT_FIELDS]).execute();
  return rows
    .map(toView)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Record an alert firing. If an active (OPEN/ACK) event with the same dedup_key
 * exists, increments its occurrence count instead of creating a duplicate
 * (alarm-storm collapse). SUPPRESSED events whose window is still active are
 * left untouched. Returns the event id.
 */
export async function fireAlert(input: FireAlertInput): Promise<string> {
  const userId = requireUser();
  const now = new Date();
  const dedupKey = input.dedupKey ?? `${input.ruleId ?? input.tagId}:${input.severity}`;

  const existing = (await client.data.AlertEvent.select([...SELECT_FIELDS]).execute())
    .map(toView)
    .filter((e) => e.dedupKey === dedupKey);

  const active = existing.find((e) => e.status === 'OPEN' || e.status === 'ACK');
  const suppressed = existing.find(
    (e) => e.status === 'SUPPRESSED' && e.suppressedUntil && e.suppressedUntil.getTime() > now.getTime(),
  );

  if (suppressed) {
    // Still suppressed: count the occurrence but keep it out of the queue.
    await client.data.AlertEvent.update(
      { id: suppressed.id },
      {
        occurrence_count: suppressed.occurrenceCount + 1,
        last_occurrence_at: now,
        current_value: input.currentValue,
        updated_at: now,
      },
    );
    return suppressed.id;
  }

  if (active) {
    await client.data.AlertEvent.update(
      { id: active.id },
      {
        occurrence_count: active.occurrenceCount + 1,
        last_occurrence_at: now,
        current_value: input.currentValue,
        updated_at: now,
      },
    );
    return active.id;
  }

  const audit: AuditEntry[] = [
    { action: 'OPENED', by: getFabricAccountEmail() ?? userId, at: now.toISOString() },
  ];
  const created = await client.data.AlertEvent.create({
    user_id: userId,
    rule_id: input.ruleId,
    tag_id: input.tagId,
    severity: input.severity,
    title: input.title,
    message: input.message,
    dedup_key: dedupKey,
    status: 'OPEN',
    occurrence_count: 1,
    current_value: input.currentValue,
    opened_at: now,
    updated_at: now,
    last_occurrence_at: now,
    audit_json: JSON.stringify(audit),
    evidence_json: input.evidence ? JSON.stringify(input.evidence) : undefined,
  });
  return (created as { id?: string })?.id ?? '';
}

async function appendAudit(
  event: AlertEventView,
  action: string,
  patch: Record<string, unknown>,
  note?: string,
): Promise<void> {
  const now = new Date();
  const by = getFabricAccountEmail() ?? getFabricAccountId() ?? 'unknown';
  const audit: AuditEntry[] = [...event.audit, { action, by, at: now.toISOString(), note }];
  await client.data.AlertEvent.update(
    { id: event.id },
    { ...patch, audit_json: JSON.stringify(audit), updated_at: now },
  );
}

/** Acknowledge an alert (OPEN → ACK). */
export async function acknowledgeAlert(event: AlertEventView, note?: string): Promise<void> {
  await appendAudit(event, 'ACK', { status: 'ACK' as AlertStatus }, note);
}

/** Assign an alert to a user for triage. */
export async function assignAlert(event: AlertEventView, assignee: string, note?: string): Promise<void> {
  await appendAudit(event, 'ASSIGNED', { assignee }, note ?? `Assigned to ${assignee}`);
}

/** Suppress an alert for a number of minutes (alarm-storm control). */
export async function suppressAlert(
  event: AlertEventView,
  minutes: number,
  note?: string,
): Promise<void> {
  const until = new Date(Date.now() + minutes * 60_000);
  await appendAudit(
    event,
    'SUPPRESSED',
    { status: 'SUPPRESSED' as AlertStatus, suppressed_until: until },
    note ?? `Suppressed for ${minutes} min`,
  );
}

/** Close an alert (resolved). */
export async function closeAlert(event: AlertEventView, note?: string): Promise<void> {
  await appendAudit(event, 'CLOSED', { status: 'CLOSED' as AlertStatus, closed_at: new Date() }, note);
}

/** Re-open a suppressed/closed alert. */
export async function reopenAlert(event: AlertEventView, note?: string): Promise<void> {
  await appendAudit(event, 'REOPENED', { status: 'OPEN' as AlertStatus, suppressed_until: undefined }, note);
}

/**
 * Assemble an evidence bundle (JSON) for escalation/shift handover: the event,
 * its full audit trail, and any captured context snapshot. Triggers a download.
 */
export function exportEvidenceBundle(event: AlertEventView): void {
  const bundle = {
    exportedAt: new Date().toISOString(),
    exportedBy: getFabricAccountEmail() ?? getFabricAccountId() ?? 'unknown',
    alert: {
      id: event.id,
      tagId: event.tagId,
      severity: event.severity,
      title: event.title,
      message: event.message,
      status: event.status,
      occurrenceCount: event.occurrenceCount,
      currentValue: event.currentValue,
      openedAt: event.openedAt.toISOString(),
      lastOccurrenceAt: event.lastOccurrenceAt?.toISOString(),
    },
    audit: event.audit,
    evidence: event.evidence ?? {},
  };
  downloadText(`alert_evidence_${event.id}.json`, JSON.stringify(bundle, null, 2));
}

/** Map alert severity to a work-order priority label. */
function workOrderPriority(sev: AlertSeverity): string {
  return sev === 'critical' ? 'P1 - Urgent' : sev === 'warning' ? 'P2 - High' : 'P3 - Routine';
}

export interface WorkOrderOptions {
  /** Optional human-readable asset/tag name for the work order header. */
  tagName?: string;
  /** Optional assignee/crew to note on the order. */
  assignedTo?: string;
  /** Extra instructions from the operator. */
  instructions?: string;
}

/**
 * Field-technician work order (functional spec §Field tech / work-order hook).
 *
 * Produces a self-contained Markdown work order from an alert — priority,
 * asset, symptom, evidence summary, and a checklist — and downloads it for
 * dispatch. Also appends a `WORK_ORDER` entry to the alert's audit trail so the
 * escalation is traceable (best-effort; skipped if the update fails). Returns
 * the generated work-order id.
 */
export async function createWorkOrder(event: AlertEventView, opts: WorkOrderOptions = {}): Promise<string> {
  const woId = `WO-${event.id.slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
  const asset = opts.tagName ?? event.tagId;
  const evidenceLines = event.evidence
    ? Object.entries(event.evidence).map(([k, v]) => `- **${k}:** ${JSON.stringify(v)}`)
    : [];
  const doc = [
    `# Work Order ${woId}`,
    '',
    `- **Priority:** ${workOrderPriority(event.severity)}`,
    `- **Asset / tag:** ${asset}`,
    `- **Raised from alert:** ${event.title} (${event.id})`,
    `- **Occurrences:** ${event.occurrenceCount}`,
    `- **First seen:** ${event.openedAt.toISOString()}`,
    event.lastOccurrenceAt ? `- **Last seen:** ${event.lastOccurrenceAt.toISOString()}` : '',
    opts.assignedTo ? `- **Assigned to:** ${opts.assignedTo}` : '',
    `- **Created:** ${new Date().toISOString()}`,
    `- **Created by:** ${getFabricAccountEmail() ?? getFabricAccountId() ?? 'unknown'}`,
    '',
    '## Symptom',
    '',
    event.message ?? '(no additional detail)',
    '',
    ...(opts.instructions ? ['## Instructions', '', opts.instructions, ''] : []),
    ...(evidenceLines.length ? ['## Evidence', '', ...evidenceLines, ''] : []),
    '## Field checklist',
    '',
    '- [ ] Confirm the reading at the asset',
    '- [ ] Inspect the sensor/instrument for fault',
    '- [ ] Verify the process condition',
    '- [ ] Record findings and close the alert',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
  downloadText(`${woId}.md`, doc, 'text/markdown');
  try {
    await appendAudit(event, 'WORK_ORDER', {}, `Created ${woId}${opts.assignedTo ? ` for ${opts.assignedTo}` : ''}`);
  } catch {
    // Audit append is best-effort; the work order was still generated.
  }
  return woId;
}


/** Whether an event should currently appear in the active queue. */
export function isActive(e: AlertEventView, now = new Date()): boolean {
  if (e.status === 'CLOSED') return false;
  if (e.status === 'SUPPRESSED') {
    return !e.suppressedUntil || e.suppressedUntil.getTime() <= now.getTime();
  }
  return true;
}
