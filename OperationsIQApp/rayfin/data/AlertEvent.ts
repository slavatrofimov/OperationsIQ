import { entity, role, uuid, text, int, decimal, date } from '@microsoft/rayfin-core';

/**
 * An alert *occurrence* and its operational lifecycle (functional spec §Alert
 * center). Distinct from {@link AlertRule} (the standing definition): an
 * AlertEvent is a single fired instance that operators triage — acknowledge,
 * assign, suppress, or close — with a full audit trail.
 *
 * Alarm-storm control: repeated firings that share a `dedup_key` collapse into
 * one event with an incrementing `occurrence_count` rather than flooding the
 * queue. Suppressed events are hidden from the active queue until their
 * suppression window elapses.
 *
 * Rows are scoped to the owning user/workspace via row-level policy.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class AlertEvent {
  @uuid() id!: string;

  /** Owner/workspace scope; drives row-level access. */
  @text() user_id!: string;

  /** Optional link to the standing rule that produced this event. */
  @text({ optional: true }) rule_id?: string;

  /** The signal/tag this alert is about. */
  @text() tag_id!: string;

  /** info | warning | critical */
  @text() severity!: string;

  @text() title!: string;
  @text({ optional: true }) message?: string;

  /**
   * Stable grouping key for dedup/suppression. Repeated firings with the same
   * key update an existing OPEN/ACK event instead of creating a new one.
   */
  @text() dedup_key!: string;

  /** OPEN | ACK | SUPPRESSED | CLOSED */
  @text() status!: string;

  /** System user id the event is assigned to for triage (optional). */
  @text({ optional: true }) assignee?: string;

  /** Number of times this dedup_key has fired (alarm-storm collapse). */
  @int({ default: 1, min: 1 }) occurrence_count!: number;

  /** Most recent triggering value, for quick context. */
  @decimal({ optional: true }) current_value?: number;

  @date() opened_at!: Date;
  @date() updated_at!: Date;
  @date({ optional: true }) last_occurrence_at?: Date;
  @date({ optional: true }) closed_at?: Date;

  /** When set (and in the future), the event is suppressed until this time. */
  @date({ optional: true }) suppressed_until?: Date;

  /** Append-only JSON array of lifecycle actions (who/what/when/note). */
  @text({ optional: true }) audit_json?: string;

  /** JSON snapshot of supporting context for the evidence bundle. */
  @text({ optional: true }) evidence_json?: string;
}
