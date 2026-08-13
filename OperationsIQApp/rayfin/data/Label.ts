import { entity, role, uuid, text, int, decimal, date, set, one } from '@microsoft/rayfin-core';
import { AnalysisJob } from './AnalysisJob.js';

/**
 * A user annotation over a span of a Signal (design spec §5, §7.5): a labeled motif
 * ("healthy pump cycle") or discord ("bearing spall").
 *
 * Labels persist, re-overlay on future sessions, and power "apply this label to all
 * similar patterns" via the motif neighbor list. They are shared workspace-wide so
 * teammates see each other's findings; owner-only edit/delete is a per-action DAB
 * policy applied at deploy time (design spec §9 hardening).
 */
@entity()
@role('authenticated', ['create', 'read', 'update', 'delete'])
export class Label {
  @uuid() id!: string;

  /**
   * Identifier of the annotated signal — the source tag/point identifier used
   * across the app (matches `Timeseries.TagId`), not a Rayfin Signal row id.
   */
  @text() signal_id!: string;

  /** Optional foreign key to the job that surfaced this pattern. */
  @uuid({ optional: true }) job_id?: string;
  @one(() => AnalysisJob) job?: AnalysisJob;

  /**
   * Optional taxonomy category for consistent, reusable labeling.
   *
   * SOFT reference (intentionally NOT a typed foreign key): this stores either a
   * built-in category id (`builtin:*`, e.g. `builtin:healthy`) or a workspace
   * `LabelCategory` UUID. Built-in categories have no backing `LabelCategory` rows,
   * so a real FK with referential integrity — and the `@uuid()` column a typed
   * relationship would demand — cannot represent them. The value is resolved by
   * name/id in the client, never traversed as a navigation property.
   */
  @text({ optional: true }) labelCategory_id?: string;

  @set('MOTIF', 'DISCORD') kind!: 'MOTIF' | 'DISCORD';

  /** Span start (subsequence/sample index) and length within the signal window. */
  @int({ min: 0 }) startIndex!: number;
  @int({ min: 1 }) length!: number;

  /** Free-text annotation. */
  @text({ optional: true, max: 2000 }) text?: string;

  /** Display color (hex); falls back to the category color when unset. */
  @text({ optional: true, max: 9 }) color?: string;

  /** Annotator confidence 0..1. */
  @decimal({ optional: true, min: 0, max: 1 }) confidence?: number;

  /**
   * Temporal resolution at which this pattern was discovered: the number of seconds
   * represented by each sample/index in the originating analysis window. Persisted as a
   * first-class field so the Pattern library can reconstruct real durations and wall-clock
   * timing independent of the run — `startIndex`/`length` are sample indices, and this is the
   * bin width that maps them back to time. Optional for back-compat with labels saved before
   * this field existed (those fall back to a per-run estimate).
   */
  @decimal({ optional: true, min: 0 }) secondsPerSample?: number;

  /** System user id (claims.sub) of the annotator; drives row-level write access. */
  @text() createdBy!: string;

  /**
   * Connection profile this pattern was saved under (Fabric profile id). Scopes the
   * pattern so it is only surfaced under its owning profile. Optional for back-compat
   * with rows created before profile scoping (those are hidden until re-created).
   */
  @text({ optional: true }) connection_profile_id?: string;

  @date() createdAt!: Date;
}
