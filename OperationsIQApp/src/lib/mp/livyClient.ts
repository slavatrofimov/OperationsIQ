/**
 * Browser-side Fabric **Livy** client (design spec §4, §8).
 *
 * The SPA now submits and monitors Spark analyses by calling the Fabric Livy REST
 * endpoint directly, using the user's delegated token (see {@link getLivyToken} and
 * the `FABRIC_LIVY_SCOPES` in ../msal). This is the TypeScript port of the reference
 * Python implementation in `orchestration/fabric_livy.py` + `orchestration/dispatcher.py`
 * — that logic could not run as a Fabric User Data Function (a UDF cannot call the Livy
 * endpoint), so it lives here instead, driven by the browser.
 *
 * This module is split into two halves:
 *   - Pure, network-free helpers ({@link interpretLivyStatus}, {@link buildJobPayload},
 *     {@link buildLivyCode}) that turn raw Livy documents / job rows into app values.
 *   - A thin REST client ({@link LivyClient}) that wraps the session/statement endpoints.
 *
 * Livy REST shape (Fabric):
 *   sessions:   POST/GET  .../livyApi/versions/2023-12-01/sessions[/{id}]
 *   session log: GET      .../sessions/{id}/log?size=N
 *   statements: POST/GET  .../sessions/{id}/statements[/{id}]
 *   cancel:     POST       .../sessions/{id}/statements/{id}/cancel
 */

import { getLivyToken } from '../msal';
import { env } from '../env';
import { backoffDelayMs } from '../agent/retry';
import { TSMP_BUNDLE_B64 } from './tsmpBundle';
import type { AnalysisJob, JobStatus, JobType } from './types';

export const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1';
export const LIVY_API_VERSION = '2023-12-01';

/**
 * The Fabric Livy gateway intermittently answers a well-formed request with
 * `415 Unsupported Media Type` while a cold session/gateway is still warming up
 * (typically the first call or two after a page mounts or a session has gone
 * idle). A 415 means the request was rejected BEFORE it was processed, so it is
 * always safe to replay — even a non-idempotent POST cannot have committed a
 * side effect. We absorb it with a few backed-off retries rather than a single
 * fixed short wait, which is often too brief for the gateway to warm up. Only
 * after these are exhausted does the 415 surface to the caller (as a friendly,
 * actionable message rather than the raw gateway HTML).
 */
export const LIVY_TRANSIENT_STATUS = 415;
export const LIVY_MAX_TRANSIENT_RETRIES = 3;

// ---------------------------------------------------------------------------
// Livy state vocabulary (see Livy docs). Kept as sets so the interpretation
// below is a pure, table-driven mapping — mirrors orchestration/fabric_livy.py.
// States are compared after normalization (lowercased, underscores stripped) so
// Fabric variants like "AcquiringSession" / "not_started" match the same key.
// ---------------------------------------------------------------------------

/** Normalize a raw Livy state for comparison: lowercase, drop underscores/spaces. */
export function normalizeState(state?: string | null): string {
  return String(state ?? '').toLowerCase().replace(/[\s_]/g, '');
}

const SESSION_STARTING = new Set([
  'notstarted',
  'starting',
  'recovering',
  // Fabric-specific: capacity is being acquired for the session.
  'acquiringsession',
  'acquiring',
]);
const SESSION_READY = new Set(['idle', 'busy']);
const SESSION_FAILED = new Set(['error', 'dead', 'killed']);
const SESSION_ENDED = new Set(['shuttingdown', 'success']);

const STATEMENT_RUNNING = new Set(['waiting', 'running']);

/** True when the session can accept statement submissions (idle/busy). */
export function isSessionReady(state?: string | null): boolean {
  return SESSION_READY.has(normalizeState(state));
}


// ---------------------------------------------------------------------------
// Raw Livy document shapes (only the fields we read).
// ---------------------------------------------------------------------------

export interface LivySessionDoc {
  id?: number | string;
  state?: string;
  appId?: string;
  log?: string[];
  appInfo?: Record<string, string | undefined> | null;
}

export interface LivyStatementDoc {
  id?: number | string;
  state?: string;
  progress?: number;
  output?: {
    status?: string;
    ename?: string;
    evalue?: string;
    traceback?: string[] | string;
  } | null;
}

/** A transparent snapshot of where a Livy-backed job is right now. */
export interface LivyStatusView {
  jobStatus: JobStatus;
  /** Coarse machine-readable stage, e.g. "session:starting" / "statement:running". */
  stage: string;
  /** Plain-language "why is this still waiting?" message. */
  message: string;
  /** Best-effort 0..100 progress (Livy has no native percentage). */
  progressPct: number;
  /** True once the job has reached a terminal state. */
  isTerminal: boolean;
  errorMessage?: string;
}

function statementError(doc: LivyStatementDoc): { message: string; traceback: string[] } | null {
  const output = doc.output ?? {};
  if (output.status === 'error' || doc.state === 'error') {
    const ename = output.ename || 'Error';
    const evalue = output.evalue || doc.state || 'statement failed';
    let traceback = output.traceback ?? [];
    if (!Array.isArray(traceback)) traceback = [String(traceback)];
    return { message: `${ename}: ${evalue}`.trim(), traceback: traceback.map(String) };
  }
  return null;
}

function statementProgress(doc: LivyStatementDoc): number {
  const raw = doc.progress;
  const pct = typeof raw === 'number' ? raw * 100 : 0;
  return Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
}

function sessionFailureMessage(doc: LivySessionDoc, state: string): string {
  const log = doc.log;
  if (Array.isArray(log) && log.length > 0) {
    const tail = log.slice(-8).map(String).join('\n');
    return `Spark session ${state}. Last log lines:\n${tail}`;
  }
  return `Spark session ${state}.`;
}

/**
 * Map raw Livy session/statement documents to a transparent {@link LivyStatusView}.
 * Pure and defensive: unknown/missing fields degrade to an informative status rather
 * than throwing, because a poller must never crash on a surprising payload. Faithful
 * port of `interpret_livy_status` in orchestration/fabric_livy.py.
 */
export function interpretLivyStatus(
  sessionDoc: LivySessionDoc | null | undefined,
  statementDoc?: LivyStatementDoc | null,
): LivyStatusView {
  if (!sessionDoc) {
    return {
      jobStatus: 'QUEUED',
      stage: 'submitting',
      message: 'Submitting the analysis to Spark…',
      progressPct: 0,
      isTerminal: false,
    };
  }

  const sessionState = normalizeState(sessionDoc.state);

  // 1. Session still spinning up — the classic "stuck waiting" case.
  if (SESSION_STARTING.has(sessionState)) {
    return {
      jobStatus: 'QUEUED',
      stage: `session:${sessionState}`,
      message: 'Waiting for a Spark session to start (acquiring capacity)…',
      progressPct: 0,
      isTerminal: false,
    };
  }

  // 2. Session failed to start / died.
  if (SESSION_FAILED.has(sessionState)) {
    return {
      jobStatus: 'FAILED',
      stage: `session:${sessionState}`,
      message: `The Spark session ${sessionState} before the analysis finished.`,
      progressPct: 0,
      isTerminal: true,
      errorMessage: sessionFailureMessage(sessionDoc, sessionState),
    };
  }

  // 3. Session is alive — the statement drives the status.
  if (statementDoc) {
    const statementState = normalizeState(statementDoc.state);

    if (statementState === 'available') {
      const err = statementError(statementDoc);
      if (err) {
        return {
          jobStatus: 'FAILED',
          stage: 'statement:error',
          message: 'The analysis ran but reported an error.',
          progressPct: 0,
          isTerminal: true,
          errorMessage: [err.message, ...err.traceback].join('\n').trim(),
        };
      }
      return {
        jobStatus: 'SUCCEEDED',
        stage: 'statement:available',
        message: 'Analysis complete.',
        progressPct: 100,
        isTerminal: true,
      };
    }

    if (statementState === 'error' || statementState === 'cancelled' || statementState === 'cancelling') {
      const err = statementError(statementDoc);
      const errorMessage = err ? [err.message, ...err.traceback].join('\n').trim() : undefined;
      const cancelled = statementState === 'cancelled';
      return {
        jobStatus:
          statementState === 'error' ? 'FAILED' : cancelled ? 'CANCELLED' : 'RUNNING',
        stage: `statement:${statementState}`,
        message: cancelled
          ? 'The analysis was cancelled.'
          : statementState === 'error'
            ? 'The analysis reported an error.'
            : 'Cancelling the analysis…',
        progressPct: 0,
        isTerminal: statementState === 'error' || cancelled,
        errorMessage,
      };
    }

    if (STATEMENT_RUNNING.has(statementState)) {
      // A statement still "running" while the session has already ended means the
      // session closed out from under the analysis — treat it as a terminal failure.
      if (SESSION_ENDED.has(sessionState)) {
        return {
          jobStatus: 'FAILED',
          stage: `session:${sessionState}`,
          message: 'The Spark session ended before the analysis finished.',
          progressPct: 0,
          isTerminal: true,
          errorMessage: sessionFailureMessage(sessionDoc, sessionState),
        };
      }
      const waiting = statementState === 'waiting';
      return {
        jobStatus: 'RUNNING',
        stage: `statement:${statementState}`,
        message: waiting
          ? 'Queued behind another statement on this session…'
          : 'Analyzing the signal on Spark…',
        progressPct: statementProgress(statementDoc),
        isTerminal: false,
      };
    }
  }

  // 4. Session ready but no statement yet (or an unrecognized statement state).
  if (SESSION_READY.has(sessionState)) {
    return {
      jobStatus: 'RUNNING',
      stage: `session:${sessionState}`,
      message: 'Spark session ready — starting the analysis…',
      progressPct: 1,
      isTerminal: false,
    };
  }

  // 5. Session ended/closed without a completed statement — cannot finish the job.
  if (SESSION_ENDED.has(sessionState)) {
    return {
      jobStatus: 'FAILED',
      stage: `session:${sessionState}`,
      message: 'The Spark session ended before the analysis produced a result.',
      progressPct: 0,
      isTerminal: true,
      errorMessage: sessionFailureMessage(sessionDoc, sessionState),
    };
  }

  return {
    jobStatus: 'QUEUED',
    stage: `session:${sessionState || 'unknown'}`,
    message: 'Waiting on the Spark session…',
    progressPct: 0,
    isTerminal: false,
  };
}

/** Extract a Spark UI / driver-log URL from a session document if present. */
export function sparkUiUrl(sessionDoc: LivySessionDoc): string | undefined {
  const appInfo = sessionDoc.appInfo ?? {};
  for (const key of ['sparkUiUrl', 'driverLogUrl']) {
    const v = appInfo[key];
    if (v) return String(v);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure payload / statement builders (port of dispatcher.build_job_payload /
// build_livy_code). The payload matches tsmp.jobs.spark_entry.run_payload.
// ---------------------------------------------------------------------------

/** The resolved physical source the analysis reads from (KQL / Eventhouse). */
export interface LivySource {
  kqlClusterUri: string;
  database: string;
  table: string;
  timeColumn: string;
  valueColumn: string;
  tagColumn?: string;
  /**
   * The active Connection Profile's canonical timeseries adapter query, projecting the
   * underlying schema onto canonical `Timestamp` / `SignalId` / `Value` columns. When set,
   * the Spark reader binds it as the source (via `tsmp.io.kql`) instead of reading `table`
   * directly, so Spark reads through the same adapter as the app's client-side KQL builders
   * regardless of the raw table/column names.
   */
  sourceQuery?: string;
  tag?: string;
  windowStart?: string;
  windowEnd?: string;
  /** When set, the source read aggregates into fixed-width bins of this many seconds. */
  binSeconds?: number;
  /** Aggregation applied within each bin (e.g. 'avg', 'max'). Defaults server-side to avg. */
  aggregation?: string;
  /** How post-bin empty buckets are filled ('linear' | 'none'). */
  gapFill?: string;
}

/** Parse the job's stringified `params` JSON bag; tolerant of null/blank/bad JSON. */
export function parseParams(params?: string | null): Record<string, unknown> {
  if (!params) return {};
  try {
    const parsed = JSON.parse(params);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Merge an AnalysisJob + resolved source into the Spark job spec payload.
 *
 * ``compareSource`` is the AB-join series-B source (a second signal and/or window). When
 * present it is emitted as ``compareSource`` and read by ``spark_entry.run_payload`` as
 * ``series_b``; ``abTarget`` (novelty direction) is passed through from params.
 *
 * ``signalSources`` is the ordered list of per-signal sources for the multi-series analyses
 * (multidimensional mSTAMP / consensus Ostinato). When present it is emitted as
 * ``signalSources`` and read by ``spark_entry.run_payload`` as ``series_list``; ``minCount``
 * (consensus partial-consensus threshold) and ``nDims`` (multidim k-of-d) are passed through
 * from the job.
 */
export function buildJobPayload(
  job: AnalysisJob,
  source: LivySource,
  compareSource?: LivySource,
  signalSources?: LivySource[],
): Record<string, unknown> {
  const params = parseParams(job.summary ?? undefined);
  const payload: Record<string, unknown> = {
    jobId: job.id,
    type: job.type,
    source,
    // How the Spark job authenticates to the Eventhouse. Defaults to 'fabric_token'
    // (notebookutils token provider) because Fabric Spark has no IMDS endpoint, so
    // managed-identity auth fails. Override via VITE_TSMP_KUSTO_AUTH if needed.
    auth: env.tsmpKustoAuth,
  };
  if (typeof params.abTarget === 'string') payload.abTarget = params.abTarget;

  // Thread source-level binning (from the wizard's adaptive-binning panel) into the
  // resolved source so `read_series` aggregates + gap-fills onto a uniform grid.
  const binSeconds = params.binSeconds;
  const applyBinning = (src: LivySource): LivySource => {
    if (binSeconds == null || !Number.isFinite(Number(binSeconds)) || Number(binSeconds) <= 0) {
      return src;
    }
    const merged = { ...src } as LivySource;
    merged.binSeconds = Number(binSeconds);
    if (typeof params.aggregation === 'string') merged.aggregation = params.aggregation;
    if (typeof params.gapFill === 'string') merged.gapFill = params.gapFill;
    return merged;
  };
  payload.source = applyBinning(source);

  // Series B (AB-join comparison) MUST be binned onto the SAME uniform grid as series A.
  // Without this, a binned run analyzes A on the binSeconds grid but B on its raw native
  // points, which breaks the join two ways: (1) `subLen` samples span binSeconds·subLen of
  // wall-clock in A but only the native cadence in B, so the matrix profile compares
  // mismatched physical durations (yielding misleading matches — e.g. opposite-slope
  // "shared" patterns); and (2) B's emitted indices (idxB) become native-point offsets that
  // no longer map to the binSeconds clock the results view uses, so B's overlays drift or
  // overflow off-chart. Binning B here keeps both series on one clock end-to-end.
  if (compareSource) payload.compareSource = applyBinning(compareSource);

  // Multi-series (multidimensional / consensus): each signal is read with the SAME binning
  // so their samples land on a common clock (required for multidim alignment). minCount and
  // nDims steer the consensus threshold and multidim k-of-d subset respectively.
  if (signalSources && signalSources.length > 0) {
    payload.signalSources = signalSources.map(applyBinning);
  }
  if (job.minCount != null && Number.isFinite(job.minCount)) {
    payload.minCount = Math.trunc(job.minCount);
  }
  if (job.nDims != null && Number.isFinite(job.nDims)) {
    payload.nDims = Math.trunc(job.nDims);
  }

  let subLen = job.subLen;
  if (subLen == null) {
    const p = params.subLen ?? params.m;
    if (p != null) subLen = Number(p);
  }
  if (subLen != null && Number.isFinite(subLen)) payload.subLen = Math.trunc(subLen);

  const knobs: Array<[string, 'int' | 'bool']> = [
    ['k', 'int'],
    ['minlag', 'int'],
    ['includeProfile', 'bool'],
    ['buildOverview', 'bool'],
    ['lengthMin', 'int'],
    ['lengthMax', 'int'],
    ['lengthStep', 'int'],
    ['nBlocks', 'int'],
  ];
  for (const [key, kind] of knobs) {
    const raw = params[key];
    if (raw == null) continue;
    payload[key] = kind === 'bool' ? Boolean(raw) : Math.trunc(Number(raw));
  }

  return payload;
}

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * PySpark bootstrap that ensures the runtime pip dependencies the analysis needs
 * are importable on the Spark **driver**. The job reads the source series from and
 * ingests results into the Eventhouse via the `azure-kusto-data`/`azure-kusto-ingest`
 * SDKs (see `tsmp.io.kusto`), which a bare Fabric Spark pool does not ship — that is
 * what caused `ImportError: azure-kusto-data is required for Kusto execution`.
 *
 * Only the driver touches Kusto (executors run the numpy-only decompose mapper), so a
 * driver-side install is sufficient. The install is skipped entirely when the modules
 * already import (e.g. a Fabric Environment provides them) and is a no-op when the
 * configured package list is empty. Failures are printed but do not abort the bootstrap
 * so the real error (if the SDK truly is unavailable) surfaces at the import site.
 */
function depsBootstrap(): string {
  const packages = (env.tsmpPipPackages ?? '').trim();
  if (!packages) return '';
  // Space-separated -> a Python list literal, so pip receives them as argv.
  const pipArgs = packages
    .split(/\s+/)
    .map((p: string) => JSON.stringify(p))
    .join(', ');
  return (
    'import importlib, subprocess, sys\n' +
    '_tsmp_need = []\n' +
    'for _m in ("azure.kusto.data", "azure.kusto.ingest"):\n' +
    '    try:\n' +
    '        importlib.import_module(_m)\n' +
    '    except Exception:\n' +
    '        _tsmp_need.append(_m)\n' +
    'if _tsmp_need:\n' +
    '    try:\n' +
    '        subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", ' +
    `"--disable-pip-version-check", ${pipArgs}])\n` +
    '    except Exception as _e:\n' +
    '        print("TSMP_PIP_WARN " + repr(_e))\n'
  );
}

/**
 * PySpark bootstrap prepended to every statement. It rebuilds the `tsmp` package
 * from the embedded {@link TSMP_BUNDLE_B64} bundle (gzip+base64 of the package
 * source), writes it to a zip in the driver temp dir, puts that zip on the driver
 * import path, and hands it to the SparkContext via `addPyFile` so executors can
 * import it too. This makes each job fully self-contained: the cluster does NOT
 * need a pre-published `tsmp` wheel or a custom Fabric Spark Environment, which is
 * what previously caused `ModuleNotFoundError: No module named 'tsmp'`.
 */
function tsmpBootstrap(): string {
  return (
    'import base64, gzip, json, os, sys, tempfile, zipfile\n' +
    `_tsmp_b64 = "${TSMP_BUNDLE_B64}"\n` +
    '_tsmp_files = json.loads(gzip.decompress(base64.b64decode(_tsmp_b64)).decode("utf-8"))\n' +
    '_tsmp_zip = os.path.join(tempfile.gettempdir(), "tsmp_bundle.zip")\n' +
    'with zipfile.ZipFile(_tsmp_zip, "w", zipfile.ZIP_DEFLATED) as _z:\n' +
    '    for _rel, _src in sorted(_tsmp_files.items()):\n' +
    '        _z.writestr(_rel, _src)\n' +
    'if _tsmp_zip not in sys.path:\n' +
    '    sys.path.insert(0, _tsmp_zip)\n' +
    'try:\n' +
    '    from pyspark.sql import SparkSession as _SS\n' +
    '    _SS.builder.getOrCreate().sparkContext.addPyFile(_tsmp_zip)\n' +
    'except Exception as _e:\n' +
    '    print("TSMP_BOOTSTRAP_WARN " + repr(_e))\n'
  );
}

/**
 * Return the PySpark statement that runs one analysis on the Livy session. The
 * payload is base64-encoded into the statement so no amount of quoting in table
 * names / ids / ISO timestamps can break the generated code. It first runs the
 * {@link tsmpBootstrap} so the `tsmp` package is importable on the cluster, then
 * calls the tested `tsmp.jobs.spark_entry.run_and_print`, which prints a tagged
 * `TSMP_RESULT` line on success or a `TSMP_TRACEBACK_BEGIN`/`_END`-bracketed full
 * traceback (to stdout *and* stderr, so it lands in the retrievable Spark driver log)
 * before re-raising on failure.
 */
export function buildLivyCode(payload: Record<string, unknown>): string {
  const encoded = utf8ToBase64(JSON.stringify(payload));
  return (
    depsBootstrap() +
    tsmpBootstrap() +
    'import base64, json\n' +
    'from tsmp.jobs.spark_entry import run_and_print\n' +
    `_payload = json.loads(base64.b64decode("${encoded}").decode("utf-8"))\n` +
    'run_and_print(_payload)\n'
  );
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

/** Raised when the Livy endpoint rejects the request for auth/permission reasons. */
export class LivyAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LivyAuthError';
  }
}

export interface LivyClientOptions {
  workspaceId: string;
  lakehouseId: string;
  apiVersion?: string;
  baseUrl?: string;
  /** Acquire a bearer token carrying the Livy scopes. Defaults to {@link getLivyToken}. */
  getToken?: () => Promise<string>;
}

/** Submit and monitor a Fabric Livy interactive session + statement from the browser. */
export class LivyClient {
  private readonly workspaceId: string;
  private readonly lakehouseId: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;

  constructor(opts: LivyClientOptions) {
    this.workspaceId = opts.workspaceId;
    this.lakehouseId = opts.lakehouseId;
    this.apiVersion = opts.apiVersion ?? LIVY_API_VERSION;
    this.baseUrl = (opts.baseUrl ?? FABRIC_BASE).replace(/\/+$/, '');
    this.getToken = opts.getToken ?? (() => getLivyToken());
  }

  private get root(): string {
    return (
      `${this.baseUrl}/workspaces/${this.workspaceId}` +
      `/lakehouses/${this.lakehouseId}/livyApi/versions/${this.apiVersion}`
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH';
    // Always advertise a JSON content type on write verbs, even for a bodiless POST
    // (e.g. statement cancel): some Fabric Livy gateways reject a POST that lacks a
    // Content-Type with 415 Unsupported Media Type.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(isWrite ? { 'Content-Type': 'application/json' } : {}),
    };
    const doFetch = () =>
      fetch(`${this.root}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

    let resp = await doFetch();
    // Absorb the transient cold-gateway 415 (see LIVY_TRANSIENT_STATUS note) with
    // a few exponentially backed-off retries. A 415 is rejected before processing,
    // so replaying is safe even for a non-idempotent write.
    for (
      let attempt = 0;
      resp.status === LIVY_TRANSIENT_STATUS && attempt < LIVY_MAX_TRANSIENT_RETRIES;
      attempt++
    ) {
      await new Promise((r) => setTimeout(r, backoffDelayMs(attempt)));
      resp = await doFetch();
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new LivyAuthError(
        'The Livy endpoint rejected the request (401/403). The token may lack the ' +
          'Livy scopes, or you are not a Contributor on the workspace, or the tenant ' +
          'Livy API setting is disabled.',
        resp.status,
      );
    }
    if (resp.status === LIVY_TRANSIENT_STATUS) {
      // Still 415 after every retry: surface a clear, actionable message instead
      // of the raw gateway HTML body so the UI can show something meaningful.
      throw new Error(
        `The Fabric Livy endpoint rejected the request with 415 (Unsupported Media Type) ` +
          `after ${LIVY_MAX_TRANSIENT_RETRIES + 1} attempts. This is usually a transient ` +
          `gateway/cold-start condition — wait a moment and try again.`,
      );
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Livy ${method} ${path} failed (${resp.status}): ${detail}`.trim());
    }
    if (resp.status === 204) return undefined as T;
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // -- sessions ---------------------------------------------------------------
  listSessions(): Promise<{ from?: number; total?: number; sessions?: LivySessionDoc[] }> {
    return this.request('GET', '/sessions');
  }

  createSession(config?: Record<string, unknown>): Promise<LivySessionDoc> {
    return this.request('POST', '/sessions', { kind: 'pyspark', ...(config ?? {}) });
  }

  getSession(sessionId: string | number): Promise<LivySessionDoc> {
    return this.request('GET', `/sessions/${sessionId}`);
  }

  async getSessionLog(sessionId: string | number, size = 100): Promise<string[]> {
    const doc = await this.request<{ log?: string[] | string }>(
      'GET',
      `/sessions/${sessionId}/log?size=${size}`,
    );
    const log = doc?.log ?? [];
    return Array.isArray(log) ? log.map(String) : [String(log)];
  }

  deleteSession(sessionId: string | number): Promise<void> {
    return this.request('DELETE', `/sessions/${sessionId}`);
  }

  // -- statements -------------------------------------------------------------
  submitStatement(sessionId: string | number, code: string): Promise<LivyStatementDoc> {
    // Fabric Livy requires an explicit statement `kind`; generated jobs submit
    // Python into a PySpark session.
    return this.request('POST', `/sessions/${sessionId}/statements`, {
      code,
      kind: 'pyspark',
    });
  }

  getStatement(sessionId: string | number, statementId: string | number): Promise<LivyStatementDoc> {
    return this.request('GET', `/sessions/${sessionId}/statements/${statementId}`);
  }

  cancelStatement(sessionId: string | number, statementId: string | number): Promise<void> {
    return this.request('POST', `/sessions/${sessionId}/statements/${statementId}/cancel`);
  }
}

/** Convenience: does this job type / row have a Livy session we can poll? */
export function hasLivySession(job: Pick<AnalysisJob, 'livySessionId'>): boolean {
  return !!job.livySessionId;
}

/** Job types the direct-Livy dispatch supports (matches the AnalysisJob set). */
export const DISPATCHABLE_TYPES: ReadonlySet<JobType> = new Set([
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
]);
