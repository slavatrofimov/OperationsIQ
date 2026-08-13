import { entity, role, uuid, text, set, one } from '@microsoft/rayfin-core';
import { AnalysisJob } from './AnalysisJob.js';

/**
 * A finished job's result summary + KQL pointer (design spec §5).
 *
 * The small `summary` JSON (top-k indices, distances, best-so-far value) is cached here
 * for instant list rendering; the full arrays are pulled from the KQL table named by
 * `kqlTable`, filtered by `resultKey` (= jobId), only when a chart needs them.
 */
@entity()
@role('authenticated', ['create', 'read', 'update', 'delete'], {
  policy: (claims, item) => claims.sub.eq(item.createdBy),
})
export class ResultArtifact {
  @uuid() id!: string;

  /** Foreign key to the producing AnalysisJob. */
  @uuid() job_id!: string;
  @one(() => AnalysisJob) job?: AnalysisJob;

  /** Which KQL result table this artifact points at. */
  @set('MATRIX_PROFILE', 'MOTIF_PAIRS', 'DISCORDS', 'OVERVIEW')
  kind!: 'MATRIX_PROFILE' | 'MOTIF_PAIRS' | 'DISCORDS' | 'OVERVIEW';

  /** Name of the KQL table holding the full arrays. */
  @text() kqlTable!: string;

  /** KQL filter key for this artifact's rows (equals the job id). */
  @text() resultKey!: string;

  /** Small JSON summary cached for instant rendering (stringified). */
  @text({ optional: true }) summary?: string;

  /** System user id (claims.sub) of the job submitter; mirrors job ownership. */
  @text() createdBy!: string;
}
