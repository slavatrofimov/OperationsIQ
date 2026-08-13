/**
 * Read access to AlertRule monitoring definitions via the Rayfin data client
 * (`client.data.AlertRule`). An AlertRule arms ongoing monitoring of one tag —
 * threshold, deviation-band, or rate-of-change — with an optional notification
 * target. Rows are owned by the signing-in user (RLS policy on `user_id`).
 */

import { client } from './rayfinClient';

/** Condition parameters (only the fields relevant to the condition are used). */
export interface AlertRuleParams {
  /** For threshold_above / threshold_below. */
  threshold?: number;
  /** For deviation_band (0..1). */
  confidence?: number;
  /** For rate_of_change. */
  ratePerMinute?: number;
  /** Evaluation window in minutes (all conditions). */
  window?: number;
}

/** An alert rule as surfaced to callers. */
export interface AlertRuleView {
  id: string;
  name: string;
  tagId: string;
  conditionType: string;
  params: AlertRuleParams;
  notificationType?: string;
  notificationTarget?: string;
  status: string;
  createdAt: Date;
  lastTriggeredAt?: Date;
}

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

function parseParams(json: unknown): AlertRuleParams {
  if (typeof json !== 'string' || !json) return {};
  try {
    const raw = JSON.parse(json);
    return raw && typeof raw === 'object' ? (raw as AlertRuleParams) : {};
  } catch {
    return {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(r: any): AlertRuleView {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    tagId: String(r.tag_id ?? ''),
    conditionType: String(r.condition_type ?? ''),
    params: parseParams(r.params_json),
    notificationType: r.notification_type ?? undefined,
    notificationTarget: r.notification_target ?? undefined,
    status: String(r.status ?? 'active'),
    createdAt: toDate(r.created_at),
    lastTriggeredAt: r.last_triggered_at ? toDate(r.last_triggered_at) : undefined,
  };
}

const SELECT_FIELDS = [
  'id',
  'name',
  'tag_id',
  'condition_type',
  'params_json',
  'notification_type',
  'notification_target',
  'status',
  'created_at',
  'last_triggered_at',
] as const;

/** List the current user's alert rules, newest first. */
export async function listAlertRules(): Promise<AlertRuleView[]> {
  const rows = await client.data.AlertRule.select([...SELECT_FIELDS]).execute();
  return rows.map(toView).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
