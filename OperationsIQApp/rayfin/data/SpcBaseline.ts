import { entity, role, uuid, text, int, decimal, date } from '@microsoft/rayfin-core';

/**
 * A **governed control-chart baseline** (SPC design spec §8.3, AC-2).
 *
 * A baseline captures the control limits, chart configuration, rule profile, and
 * specification limits that define "normal" for a signal, together with the
 * lifecycle metadata that makes those limits *governed* rather than ad-hoc:
 *
 *  - **Versioned & immutable once approved.** Approved baselines never have their
 *    limit fields rewritten. Recomputing limits creates a *new version* (a new
 *    row, `version` incremented, `parent_id` pointing at the prior row) so there
 *    is never a silent limit change — the whole point of Phase I → Phase II
 *    governance.
 *  - **Audited.** `audit_json` is an append-only log of lifecycle actions
 *    (created / approved / revised / retired) with who/when/note, mirroring the
 *    {@link AlertEvent} audit pattern.
 *  - **Phase-aware.** `phase` records whether the limits were established as a
 *    Phase I study or are being applied as a frozen Phase II baseline.
 *
 * Rows are scoped to the owning user/workspace via row-level policy.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class SpcBaseline {
  @uuid() id!: string;

  /** Owner/workspace scope; drives row-level access. */
  @text() user_id!: string;

  /**
   * Connection profile this baseline was established under (Fabric profile id).
   * Scopes the baseline so it is only surfaced under its owning profile. Optional
   * for back-compat with rows created before profile scoping (those are hidden
   * until re-created).
   */
  @text({ optional: true }) connection_profile_id?: string;

  /** Human-readable name for the baseline. */
  @text() name!: string;

  /** The signal/tag this baseline governs. */
  @text() tag_id!: string;

  /** Control-chart family: 'i-mr' | 'xbar-r' | 'xbar-s'. */
  @text() chart_type!: string;

  /** Nominal subgroup size (1 for I-MR). */
  @int({ default: 1, min: 1 }) subgroup_size!: number;

  // --- Primary-panel (individuals / X̄) control limits ---
  @decimal() center_line!: number;
  @decimal() ucl!: number;
  @decimal() lcl!: number;
  /** Estimated σ of the plotted statistic: (UCL − CL) / 3. */
  @decimal() sigma!: number;

  // --- Secondary-panel (MR / R / S) control limits ---
  @decimal({ optional: true }) secondary_center_line?: number;
  @decimal({ optional: true }) secondary_ucl?: number;
  @decimal({ optional: true }) secondary_lcl?: number;

  /** Selected special-cause rule profile key (e.g. 'nelson'). */
  @text() rule_profile!: string;

  /** JSON array of subgroup indices excluded from the baseline estimate. */
  @text({ optional: true }) excluded_points_json?: string;

  // --- Specification limits (kept separate from control limits) ---
  @decimal({ optional: true }) lsl?: number;
  @decimal({ optional: true }) usl?: number;
  @decimal({ optional: true }) target?: number;

  // --- Baseline window / sufficiency ---
  @date({ optional: true }) baseline_start?: Date;
  @date({ optional: true }) baseline_end?: Date;
  /** Number of subgroups used to estimate the limits (sufficiency check). */
  @int({ optional: true, min: 0 }) baseline_subgroup_count?: number;

  /** 'I' (limits estimated) | 'II' (frozen limits applied to new data). */
  @text() phase!: string;

  /** Lifecycle: 'draft' | 'approved' | 'retired'. */
  @text() status!: string;

  /** Monotonic version number; incremented when limits are revised. */
  @int({ default: 1, min: 1 }) version!: number;

  /** Id of the prior version this baseline was revised from, if any. */
  @text({ optional: true }) parent_id?: string;

  @text({ optional: true }) approved_by?: string;
  @date({ optional: true }) approved_at?: Date;

  /** Append-only JSON array of lifecycle actions (who/what/when/note). */
  @text({ optional: true }) audit_json?: string;

  @date() created_at!: Date;
  @date() updated_at!: Date;
}
