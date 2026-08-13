import { entity, role, uuid, text, int, decimal, date } from '@microsoft/rayfin-core';

/**
 * **Governed per-signal process-health metadata** — the authoritative, shared
 * definition of "normal / healthy" for a tag: operating limits, specification
 * limits, setpoint, rate limit, plausible physical range, and the SPC/monitoring
 * defaults (preferred chart type, rule profile, recommended alert threshold and
 * confidence).
 *
 * This metadata is **workspace/org-governed**, not per-user scoped:
 *  - **Shared read.** Every authenticated user reads all rows (`@role(..,['read'])`)
 *    so limits are consistent across every page and the agent.
 *  - **Gated, versioned, audited writes.** Writes follow the baseline governance pattern:
 *    a new row is a `draft`; **approving** freezes it and stamps the approver;
 *    **revising** an approved row creates a *new version* (`version` incremented,
 *    `parent_id` linking the prior row) rather than mutating limits in place; every
 *    transition appends to the append-only `audit_json`.
 *
 * NOTE (deployment): the write role below grants create/update/delete to any
 * `authenticated` user for now — narrow it to an "author/approver" app-role / group
 * claim at deploy time (add a `policy` to the write `@role`). Approval immutability
 * and the version/audit trail are additionally enforced in the service layer
 * (`src/lib/signalMetadata.ts`), mirroring the SpcBaseline governance pattern.
 *
 * Control limits themselves are NOT duplicated here: `active_baseline_id` binds the
 * signal to an approved {@link SpcBaseline} (its UCL/LCL/CL/σ). This row carries the
 * broader operating/spec/monitoring policy.
 *
 * Persists to the `signal_metadata` table via the Rayfin data client. That table is
 * mirrored to OneLake and surfaced in the Eventhouse (KQL) DB as an external table,
 * then joined into the connection profile's "Signal Metadata" base query so these
 * fields arrive as first-class `TagInfo` fields everywhere.
 */
@entity()
@role('authenticated', ['read'])
@role('authenticated', ['create', 'update', 'delete'])
export class SignalMetadata {
  @uuid() id!: string;

  /** The signal/tag this metadata governs (matches TagInfo.tagId / SignalId). */
  @text() signal_id!: string;

  /**
   * Governance/visibility scope key (e.g. workspace or connection-profile id). Lets
   * a deployment partition governed metadata by workspace while keeping shared read.
   */
  @text({ optional: true }) scope_key?: string;

  /** Optional human-friendly label for this metadata record. */
  @text({ optional: true }) name?: string;

  // --- Operating envelope ---
  @decimal({ optional: true }) operating_setpoint?: number;
  @decimal({ optional: true }) upper_operating_limit?: number;
  @decimal({ optional: true }) lower_operating_limit?: number;
  /** Maximum expected rate of change (engineering units per minute). */
  @decimal({ optional: true }) max_rate_of_change?: number;

  // --- Specification limits (product/process spec; distinct from control limits) ---
  @decimal({ optional: true }) usl?: number;
  @decimal({ optional: true }) lsl?: number;
  @decimal({ optional: true }) target?: number;

  // --- Plausible physical range (sensor validation) ---
  @decimal({ optional: true }) physical_min?: number;
  @decimal({ optional: true }) physical_max?: number;
  /** Known sensor uncertainty / calibration error (± engineering units). */
  @decimal({ optional: true }) sensor_uncertainty?: number;

  // --- SPC binding & defaults ---
  /** Id of the approved {@link SpcBaseline} that supplies control limits. */
  @text({ optional: true }) active_baseline_id?: string;
  /** Preferred control-chart family: 'i-mr' | 'xbar-r' | 'xbar-s'. */
  @text({ optional: true }) preferred_chart_type?: string;
  /** Preferred special-cause rule profile key (e.g. 'nelson', 'weco'). */
  @text({ optional: true }) rule_profile?: string;

  // --- Monitoring defaults ---
  @decimal({ optional: true }) recommended_alert_threshold?: number;
  /** Recommended deviation-band confidence in (0,1). */
  @decimal({ optional: true }) recommended_confidence?: number;

  /** Free-form notes / engineering rationale. */
  @text({ optional: true }) notes?: string;

  // --- Governance / lifecycle ---
  /** 'draft' | 'approved' | 'retired'. */
  @text() status!: string;

  /** Monotonic version number; incremented when a new revision is created. */
  @int({ default: 1, min: 1 }) version!: number;

  /** Id of the prior version this record was revised from, if any. */
  @text({ optional: true }) parent_id?: string;

  @text({ optional: true }) approved_by?: string;
  @date({ optional: true }) approved_at?: Date;

  /** Effective window for this governed record. */
  @date({ optional: true }) effective_from?: Date;
  @date({ optional: true }) effective_to?: Date;

  /** Append-only JSON array of lifecycle actions (who/what/when/note). */
  @text({ optional: true }) audit_json?: string;

  /** Author of the current row (claims.sub); for audit, not access control. */
  @text({ optional: true }) authored_by?: string;

  @date() created_at!: Date;
  @date() updated_at!: Date;
}
