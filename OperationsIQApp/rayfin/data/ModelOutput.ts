import { entity, role, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * A traceability record for every derived/model output the app produces
 * (forecasts, anomalies, root-cause hypotheses, scenario runs, validations).
 *
 * The functional spec makes traceability non-negotiable: every derived output
 * must carry the source window it was computed from, the model + feature
 * versions that produced it, the event time it pertains to, and the wall-clock
 * time it was generated. This entity is the common sink (`model_outputs`) that
 * records that provenance so results are auditable and reproducible.
 *
 * Bulk numeric payloads stay in KQL / result artifacts; this row holds the
 * lightweight provenance + a small summary JSON. Rows are owned by the
 * signing-in user (row-level policy on `user_id`).
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ModelOutput {
  @uuid() id!: string;

  /** System user id (claims.sub) of the producer; drives row-level access. */
  @text() user_id!: string;

  /**
   * The kind of derived output.
   * forecast | anomaly | root_cause | scenario | signal_validation | causality
   */
  @text() output_type!: string;

  /** The primary signal/tag this output pertains to (when applicable). */
  @text({ optional: true }) tag_id?: string;

  /** Logical name of the model/technique that produced this output. */
  @text() model_name!: string;

  /** Version string of the model/technique (semver or build id). */
  @text() model_version!: string;

  /** Version string of the feature set / query template used as input. */
  @text() feature_version!: string;

  /** Inclusive start of the source data window used to compute the output. */
  @date() source_window_start!: Date;

  /** Exclusive end of the source data window used to compute the output. */
  @date() source_window_end!: Date;

  /**
   * The event time the output pertains to (e.g. forecast origin, incident
   * time). Distinct from generated_at so late/backfilled compute is traceable.
   */
  @date() event_time!: Date;

  /** Wall-clock time the output was generated. */
  @date() generated_at!: Date;

  /** Small JSON summary of parameters + headline results (stringified). */
  @text({ optional: true }) summary_json?: string;

  /** Optional pointer to a larger result artifact (KQL table key, blob, etc.). */
  @text({ optional: true }) result_key?: string;
}
