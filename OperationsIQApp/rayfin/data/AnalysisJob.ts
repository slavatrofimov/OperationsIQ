import { entity, role, uuid, text, int, decimal, date, set, many } from '@microsoft/rayfin-core';
import { ResultArtifact } from './ResultArtifact.js';

/**
 * The heart of the job-management module (design spec §5, §8): one asynchronous
 * MOMP / DAMP / MP compute request and its lifecycle state.
 *
 * Large result arrays are NOT stored here — they live in the KQL result tables keyed by
 * this job's id (see `kql/result_schema.kql`). This row holds only metadata, parameters,
 * status, and pointers. Users can read/update their own jobs.
 */
@entity()
@role('authenticated', ['create', 'read', 'update', 'delete'], {
  policy: (claims, item) => claims.sub.eq(item.submittedBy),
})
export class AnalysisJob {
  @uuid() id!: string;

  /**
   * Human-friendly analysis name shown in the run history so users can tell
   * sessions apart (e.g. "Repeating patterns · Pump-3 vib · Jan 1–7"). Optional:
   * the UI auto-generates a descriptive default at submit time when omitted.
   */
  @text({ optional: true }) name?: string;

  /**
   * Identifier of the analyzed signal. This is the source tag/point identifier
   * (as used throughout the app and in the Eventhouse `Timeseries.TagId`), not a
   * Rayfin Signal row id — hence a free-form string rather than a uuid FK.
   */
  @text() signal_id!: string;

  /** Analysis kind. Ships: motifs, discords, full MP, auto-length Pan MP, semantic
   *  segmentation (regime / mode changes, FLUSS), time-series chains (slow degradation),
   *  the two-series AB-join motif / novelty (compare two periods or machines), the
   *  multidimensional (mSTAMP) multi-sensor motif / novelty / segmentation, and the
   *  fleet-wide consensus (Ostinato) motif. */
  @set(
    'MOTIF_MOMP',
    'DISCORD_DAMP',
    'FULL_MP',
    'PAN_MP',
    'SEGMENTATION',
    'CHAIN',
    'AB_MOTIF',
    'AB_DISCORD',
    'MULTIDIM_MOTIF',
    'MULTIDIM_DISCORD',
    'MULTIDIM_SEGMENTATION',
    'CONSENSUS_MOTIF',
  )
  type!:
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
    | 'CONSENSUS_MOTIF';

  /** Analysis window (inclusive start, exclusive end) in source time. */
  @date() windowStart!: Date;
  @date() windowEnd!: Date;

  /**
   * AB-join (two-series) comparison series B. Series A is (`signal_id`, window); series B is
   * (`compareSignalId` ?? `signal_id`, `compareWindowStart`/`compareWindowEnd` ?? window).
   * "Two signals" mode sets a different `compareSignalId`; "two windows of one signal" mode
   * leaves `compareSignalId` unset and supplies a different compare window. Null for
   * single-series jobs.
   */
  @text({ optional: true }) compareSignalId?: string;
  @date({ optional: true }) compareWindowStart?: Date;
  @date({ optional: true }) compareWindowEnd?: Date;

  /**
   * Multi-series participating signals for the multidimensional (mSTAMP) and consensus
   * (Ostinato) analyses, stored as a JSON array of source tag identifiers. `signal_id`
   * stays the primary/first member for back-compat and single-series queries; this holds
   * the full ordered set. Null for single- and two-series jobs.
   */
  @text({ optional: true }) signalIds?: string;

  /**
   * Multidimensional: how many of the d channels a motif/discord must jointly share (the
   * "k" in k-of-d). Null lets the compute core use all channels.
   */
  @int({ optional: true, min: 1 }) nDims?: number;

  /**
   * Consensus: minimum number of the N series that must contain the shape (>= m of N).
   * Null requires all N (strict consensus).
   */
  @int({ optional: true, min: 2 }) minCount?: number;

  /** Subsequence length m; null when PAN_MP auto-scans the length. */
  @int({ optional: true, min: 4 }) subLen?: number;

  /**
   * Free-form JSON parameter bag (stringified): downsample rate, exclusion zone, k,
   * length range, timeBudgetMs, approximation flags. Kept as text so the schema stays
   * stable as the compute core gains options.
   */
  @text({ optional: true }) params?: string;

  /** Job lifecycle state machine (design spec §8). */
  @set('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
  status!: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

  /** Progress 0..100 for the anytime convergence meter. */
  @decimal({ default: 0, min: 0, max: 100 }) progressPct!: number;

  /** Spark application id once dispatched (for orchestration + orphan detection). */
  @text({ optional: true }) sparkAppId?: string;

  // -- Livy session transparency & troubleshooting (design spec §8) ------------

  /** The Fabric Livy session id running this job (for troubleshooting). */
  @text({ optional: true }) livySessionId?: string;

  /** The Livy statement id within the session executing the analysis. */
  @text({ optional: true }) livyStatementId?: string;

  /** Raw Livy state (e.g. starting, idle, busy, dead) for transparent status. */
  @text({ optional: true }) livyState?: string;

  /**
   * Coarse machine-readable stage (e.g. "session:starting", "statement:running")
   * so the UI can explain *why* a job is still waiting instead of a blank spinner.
   */
  @text({ optional: true }) stage?: string;

  /** Deep link to the Spark UI / driver log for this session, when available. */
  @text({ optional: true }) sparkUiUrl?: string;

  /** Tail of the driver log captured for troubleshooting (newline-joined). */
  @text({ optional: true }) driverLogTail?: string;

  /** KQL table holding this job's mp_result rows (usually the shared "mp_result"). */
  @text({ optional: true }) resultKqlTable?: string;

  /** KQL filter/partition key for this job's rows (equals the job id). */
  @text({ optional: true }) resultKey?: string;

  /** KQL table holding this job's overview envelopes. */
  @text({ optional: true }) overviewKqlTable?: string;

  @text({ optional: true }) errorMessage?: string;

  /** System user id (claims.sub) of the submitter; drives row-level access. */
  @text() submittedBy!: string;

  /**
   * Connection profile this analysis was run under (Fabric profile id). Scopes the
   * run so it is only surfaced under its owning profile. Optional for back-compat
   * with rows created before profile scoping (those are hidden until re-created).
   */
  @text({ optional: true }) connection_profile_id?: string;

  @date() submittedAt!: Date;
  @date({ optional: true }) startedAt?: Date;
  @date({ optional: true }) finishedAt?: Date;

  /** Billed compute seconds, surfaced for cost transparency (design spec §9). */
  @decimal({ optional: true, min: 0 }) computeSeconds?: number;

  @many(() => ResultArtifact) artifacts?: ResultArtifact[];
}
