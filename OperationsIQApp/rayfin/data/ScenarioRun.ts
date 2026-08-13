import { entity, role, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * A saved what-if scenario run (functional spec §Simulation / what-if).
 *
 * A scenario clones a baseline signal over a window and applies a set of
 * adjustments (scale, offset, ramp, clamp) to project an alternative outcome.
 * We persist the inputs (adjustments) and the computed KPI deltas and risk
 * flags so a run is reproducible and auditable — the same traceability the
 * spec requires for model outputs.
 *
 * Series arrays are NOT stored here (they are re-derivable from the baseline
 * window + adjustments); only compact JSON summaries are kept. Rows are
 * user/workspace scoped via row-level security.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ScenarioRun {
  @uuid() id!: string;

  /** Owner/workspace scope; drives row-level access. */
  @text() user_id!: string;

  /** Human-friendly scenario name. */
  @text() name!: string;

  /** Baseline signal the scenario is derived from. */
  @text() base_tag_id!: string;

  @date() base_window_start!: Date;
  @date() base_window_end!: Date;

  /** JSON array of adjustment operations applied to the baseline. */
  @text() adjustments_json!: string;

  /** JSON of KPI values for baseline vs. scenario and their deltas. */
  @text({ optional: true }) kpi_json?: string;

  /** JSON array of triggered risk flags. */
  @text({ optional: true }) risk_flags_json?: string;

  /** Feature/template version used to build the baseline. */
  @text({ optional: true }) feature_version?: string;

  @date() created_at!: Date;
}
