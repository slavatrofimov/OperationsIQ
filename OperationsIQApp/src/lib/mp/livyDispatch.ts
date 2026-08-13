/**
 * Direct-Livy orchestration for the Patterns tab (design spec §4).
 *
 * Glues together three pure/IO layers so the page stays thin:
 *   - {@link LivyClient} (REST, ./livyClient) — talks to the Fabric Livy endpoint.
 *   - AnalysisJob row patches (../mp/analysisClient) — persists transparent status.
 *   - {@link interpretLivyStatus} — maps raw Livy docs to a human status.
 *
 * The flow is:
 *   dispatchJob(job)  -> create session + submit statement, persist ids + RUNNING/QUEUED.
 *   pollJobStatus(job) -> read session + statement, persist status/stage/progress/logs.
 *   deleteJob(job)     -> best-effort cancel + delete session, then delete the row.
 *
 * This replaces the never-run standalone Python dispatcher: a Fabric User Data Function
 * cannot call the Livy endpoint, so the browser drives it directly under the user's token.
 */

import { env } from '../env';
import type { KqlOptions } from '../connectionProfile';
import { getActiveTimeseriesRef } from '../activeConnection';
import { patchJobFields, deleteJobRow, type JobLivyPatch } from './analysisClient';
import type { AnalysisJob } from './types';
import {
  LivyClient,
  interpretLivyStatus,
  isSessionReady,
  sparkUiUrl,
  buildJobPayload,
  buildLivyCode,
  DISPATCHABLE_TYPES,
  type LivySource,
  type LivyStatusView,
  type LivySessionDoc,
  type LivyStatementDoc,
} from './livyClient';

/** Missing configuration required to reach the Livy endpoint. */
export class LivyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LivyConfigError';
  }
}

/** Build a LivyClient from env, or throw a clear, actionable config error. */
export function makeLivyClient(): LivyClient {
  const workspaceId = env.fabricWorkspaceId;
  const lakehouseId = env.fabricLakehouseId;
  const missing: string[] = [];
  if (!workspaceId) missing.push('VITE_FABRIC_WORKSPACE_ID');
  if (!lakehouseId) missing.push('VITE_FABRIC_LAKEHOUSE_ID');
  if (missing.length > 0) {
    throw new LivyConfigError(
      `Cannot submit to Spark: missing ${missing.join(', ')}. Set the lakehouse whose ` +
        'Livy endpoint should run the analyses.',
    );
  }
  return new LivyClient({ workspaceId: workspaceId!, lakehouseId: lakehouseId! });
}

/** Session config: attach a Fabric Spark Environment when one is configured. */
function sessionConfig(): Record<string, unknown> | undefined {
  const environmentId = env.fabricEnvironmentId;
  if (!environmentId) return undefined;
  return {
    conf: {
      'spark.fabric.environmentDetails': JSON.stringify({ id: environmentId }),
    },
  };
}

/**
 * Resolve the physical KQL source the Spark job reads from. Cluster/db come from the
 * active connection profile when present, else from env. The series itself is read
 * through the active profile's **canonical timeseries adapter** (`sourceQuery`), exactly
 * like the app's client-side KQL builders (`withTimeseriesRef`): Spark binds that query
 * and filters/projects the canonical `Timestamp` / `SignalId` / `Value` columns, so it
 * works against any underlying schema — not just the legacy Timeseries table. An active
 * profile is therefore mandatory (consistent with the rest of the app); we never fall back
 * to a raw env-default table/column schema. The signal + analysis window come from the job.
 */
export function resolveSource(job: AnalysisJob, kqlOpts?: KqlOptions): LivySource {
  const cluster = (kqlOpts?.queryUri || env.eventhouseQueryUri || '').replace(/\/+$/, '');
  const database = kqlOpts?.db || env.eventhouseDb || '';
  if (!cluster || !database) {
    throw new LivyConfigError(
      'Cannot submit to Spark: no Eventhouse cluster/database resolved from the active ' +
        'connection profile or environment.',
    );
  }
  const sourceQuery = getActiveTimeseriesRef();
  if (!sourceQuery) {
    throw new LivyConfigError(
      'Cannot submit to Spark: no active connection profile. A profile with a canonical ' +
        'timeseries query (projecting Timestamp, SignalId, Value) is required so Spark reads ' +
        'through the same adapter as the rest of the app.',
    );
  }
  return {
    kqlClusterUri: cluster,
    database,
    // Spark reads via the profile's canonical adapter (sourceQuery below), so the columns
    // are always the canonical names the adapter emits. `table` is a canonical placeholder
    // that the reader ignores whenever sourceQuery is set.
    table: 'Timeseries',
    timeColumn: 'Timestamp',
    valueColumn: 'Value',
    tagColumn: 'SignalId',
    sourceQuery,
    tag: job.signalId,
    windowStart: job.windowStart,
    windowEnd: job.windowEnd,
  };
}

/**
 * Resolve the AB-join comparison series (series B) source, or return undefined for a
 * single-series job. Series B shares series A's cluster/database/table/columns; only the
 * tag and/or window differ: "two signals" mode overrides the tag (`compareSignalId`),
 * "two windows of one signal" mode keeps the tag and overrides the window
 * (`compareWindowStart`/`compareWindowEnd`). Returns undefined when the job carries no
 * comparison selection.
 */
export function resolveCompareSource(
  job: AnalysisJob,
  kqlOpts?: KqlOptions,
): LivySource | undefined {
  const hasCompare =
    !!job.compareSignalId || (!!job.compareWindowStart && !!job.compareWindowEnd);
  if (!hasCompare) return undefined;
  const base = resolveSource(job, kqlOpts);
  return {
    ...base,
    tag: job.compareSignalId ?? base.tag,
    windowStart: job.compareWindowStart ?? base.windowStart,
    windowEnd: job.compareWindowEnd ?? base.windowEnd,
  };
}

/**
 * Resolve the ordered list of per-signal sources for a multi-series job (multidimensional
 * mSTAMP / consensus Ostinato), or return undefined for single/two-series jobs. Every signal
 * shares series A's cluster/database/table/columns and analysis window; only the tag differs
 * (one per `signalIds` member). For multidimensional the shared window + a common bin width
 * (applied in {@link buildJobPayload}) lay the channels on a common clock; consensus needs no
 * alignment. Returns undefined when the job carries fewer than two signals.
 */
export function resolveMultiSource(
  job: AnalysisJob,
  kqlOpts?: KqlOptions,
): LivySource[] | undefined {
  const ids = job.signalIds ?? [];
  if (ids.length < 2) return undefined;
  const base = resolveSource(job, kqlOpts);
  return ids.map((tag) => ({ ...base, tag }));
}

export interface DispatchOptions {
  kqlOpts?: KqlOptions;
  client?: LivyClient;
}

/**
 * Submit a QUEUED job to Livy by **creating the Spark session only**. The analysis
 * statement is NOT submitted here: Fabric rejects statements until the session reaches
 * `idle` (it returns 409 while `AcquiringSession`/`starting`). The browser poll loop
 * ({@link pollJobStatus}) submits the statement once the session is ready. Returns the
 * patch applied so the caller can update local state without a round-trip. On failure
 * the row is marked FAILED with a human error message.
 */
export async function dispatchJob(
  job: AnalysisJob,
  opts: DispatchOptions = {},
): Promise<JobLivyPatch> {
  if (!DISPATCHABLE_TYPES.has(job.type)) {
    const patch: JobLivyPatch = {
      status: 'FAILED',
      errorMessage: `Analysis type ${job.type} is not supported for direct Livy dispatch.`,
      finishedAt: new Date(),
    };
    await patchJobFields(job.id, patch);
    return patch;
  }

  let client: LivyClient;
  try {
    client = opts.client ?? makeLivyClient();
    // Resolve the source now so a config/source error fails fast at submit time
    // (rather than surfacing later mid-poll), even though the statement that uses
    // it is built later once the session is ready.
    resolveSource(job, opts.kqlOpts);
  } catch (err) {
    const patch: JobLivyPatch = {
      status: 'FAILED',
      errorMessage: err instanceof Error ? err.message : String(err),
      finishedAt: new Date(),
    };
    await patchJobFields(job.id, patch);
    return patch;
  }

  try {
    const session = await client.createSession(sessionConfig());
    const sessionId = String(session.id ?? '');
    if (!sessionId) throw new Error('Livy did not return a session id.');

    const view = interpretLivyStatus(session);
    const patch: JobLivyPatch = {
      status: view.jobStatus,
      progressPct: view.progressPct,
      stage: view.stage,
      livySessionId: sessionId,
      livyState: session.state,
      sparkUiUrl: sparkUiUrl(session),
      startedAt: new Date(),
    };
    await patchJobFields(job.id, patch);
    return patch;
  } catch (err) {
    const patch: JobLivyPatch = {
      status: 'FAILED',
      errorMessage:
        (err instanceof Error ? err.message : String(err)) ||
        'Failed to create a Spark session on the Livy endpoint.',
      finishedAt: new Date(),
    };
    await patchJobFields(job.id, patch);
    return patch;
  }
}

/**
 * Poll a dispatched job once. Reads the Livy session; then:
 *   - if the session is ready (idle/busy) and no statement has been submitted yet,
 *     builds and submits the analysis statement (this is the deferred submit that
 *     avoids the 409 "session not in Idle state" error), persisting the statement id;
 *   - otherwise reads the existing statement (if any).
 * The interpreted status is persisted onto the row. Returns the interpreted view (or
 * null if the job has no session to poll). Errors are captured onto the row rather than
 * thrown, so the caller's poll loop keeps running across transient failures.
 */
export async function pollJobStatus(
  job: AnalysisJob,
  opts: DispatchOptions = {},
): Promise<LivyStatusView | null> {
  if (!job.livySessionId) return null;

  let client: LivyClient;
  try {
    client = opts.client ?? makeLivyClient();
  } catch (err) {
    const patch: JobLivyPatch = {
      status: 'FAILED',
      errorMessage: err instanceof Error ? err.message : String(err),
      finishedAt: new Date(),
    };
    await patchJobFields(job.id, patch);
    return interpretLivyStatus(null);
  }

  try {
    const session: LivySessionDoc = await client.getSession(job.livySessionId);

    // Deferred statement submit: once the session is ready and we have not yet
    // submitted the analysis, do it now. This is intentionally driven by the poll
    // loop because Fabric returns 409 if a statement is posted before `idle`.
    let statementId = job.livyStatementId;
    if (!statementId && isSessionReady(session.state)) {
      try {
        const source = resolveSource(job, opts.kqlOpts);
        const compareSource = resolveCompareSource(job, opts.kqlOpts);
        const signalSources = resolveMultiSource(job, opts.kqlOpts);
        const code = buildLivyCode(
          buildJobPayload(job, source, compareSource, signalSources),
        );
        const statement = await client.submitStatement(job.livySessionId, code);
        statementId = String(statement.id ?? '');
        // Persist the statement id immediately so a later poll never re-submits.
        await patchJobFields(job.id, {
          livyStatementId: statementId,
          livyState: session.state,
        });
      } catch (err) {
        const patch: JobLivyPatch = {
          status: 'FAILED',
          errorMessage:
            (err instanceof Error ? err.message : String(err)) ||
            'Failed to submit the analysis statement to the Spark session.',
          finishedAt: new Date(),
        };
        await patchJobFields(job.id, patch);
        await client.deleteSession(job.livySessionId).catch(() => undefined);
        return interpretLivyStatus(session);
      }
    }

    let statement: LivyStatementDoc | undefined;
    if (statementId) {
      statement = await client
        .getStatement(job.livySessionId, statementId)
        .catch(() => undefined);
    }

    const view = interpretLivyStatus(session, statement);
    const patch: JobLivyPatch = {
      status: view.jobStatus,
      progressPct: view.progressPct,
      stage: view.stage,
      livyState: session.state,
      sparkUiUrl: sparkUiUrl(session) ?? job.sparkUiUrl,
    };
    if (view.errorMessage) {
      patch.errorMessage = view.errorMessage;
    } else if (!view.isTerminal) {
      // Clear any lingering transient read error once the job is healthy again so an
      // old "Livy GET failed" message doesn't stick to an actively-running job.
      patch.errorMessage = '';
    }

    if (view.isTerminal) {
      patch.finishedAt = new Date();
      // Capture a log tail for post-mortem troubleshooting of failed sessions.
      if (view.jobStatus === 'FAILED') {
        const log = await client.getSessionLog(job.livySessionId, 100).catch(() => []);
        if (log.length > 0) patch.driverLogTail = log.slice(-40).join('\n');
      }
      // The interactive session stays alive (idle) after the statement finishes and
      // keeps holding Spark capacity, so tear it down best-effort once terminal.
      await client.deleteSession(job.livySessionId).catch(() => undefined);
    } else if (statementId) {
      // Live transparency: once the analysis statement is running, surface the driver
      // log tail on every poll so a long-running or stuck session can be inspected
      // in the diagnostics panel without waiting for it to fail first.
      const log = await client.getSessionLog(job.livySessionId, 100).catch(() => []);
      if (log.length > 0) patch.driverLogTail = log.slice(-40).join('\n');
    }

    await patchJobFields(job.id, patch);
    return view;
  } catch (err) {
    // Transient read error: record it but do not flip the job to a terminal state.
    await patchJobFields(job.id, {
      errorMessage: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return null;
  }
}

/**
 * Stop a running job early while **keeping** its row and any best-so-far progress
 * already streamed to KQL (design spec §7.2). Best-effort cancels the Livy statement
 * and tears down the session so it stops consuming Spark capacity, while keeping the
 * control-plane row and reviewable partial result. Livy failures are swallowed.
 */
export async function stopJob(job: AnalysisJob, opts: DispatchOptions = {}): Promise<void> {
  if (job.livySessionId) {
    let client: LivyClient | undefined;
    try {
      client = opts.client ?? makeLivyClient();
    } catch {
      client = undefined;
    }
    if (client) {
      if (job.livyStatementId) {
        await client
          .cancelStatement(job.livySessionId, job.livyStatementId)
          .catch(() => undefined);
      }
      await client.deleteSession(job.livySessionId).catch(() => undefined);
    }
  }
}

/**
 * Tear down a job: best-effort cancel the statement + delete the Livy session (so it
 * stops consuming capacity), then delete the control-plane row. Livy teardown failures
 * are ignored so a stuck/unauthorized session never blocks removing the row.
 */
export async function deleteJob(job: AnalysisJob, opts: DispatchOptions = {}): Promise<void> {
  if (job.livySessionId) {
    let client: LivyClient | undefined;
    try {
      client = opts.client ?? makeLivyClient();
    } catch {
      client = undefined;
    }
    if (client) {
      if (job.livyStatementId) {
        await client
          .cancelStatement(job.livySessionId, job.livyStatementId)
          .catch(() => undefined);
      }
      await client.deleteSession(job.livySessionId).catch(() => undefined);
    }
  }
  await deleteJobRow(job.id);
}

/** True when a job is in a non-terminal state that the poll loop should watch. */
export function isUnfinished(job: AnalysisJob): boolean {
  return job.status === 'QUEUED' || job.status === 'RUNNING';
}
