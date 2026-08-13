import {
  EventhouseSignInRequiredError,
  getEventhouseToken,
  notifyEventhouseSignInRequired,
} from './msal';
import { env } from './env';
import { getActiveKqlOpts } from './activeConnection';
import type { KqlOptions } from './connectionProfile';

/**
 * Raised when a query fails because the Fabric capacity backing the Eventhouse
 * is paused / inactive. Surfaced as a friendly, actionable message instead of a
 * raw `CapacityNotActive` error.
 */
export class CapacityPausedError extends Error {
  constructor(detail?: string) {
    super(
      'The Fabric capacity backing this Eventhouse is paused. Resume the capacity in the Fabric portal (or Azure), then try again.' +
        (detail ? `\n\nDetails: ${detail}` : ''),
    );
    this.name = 'CapacityPausedError';
  }
}

/** Heuristic: does this error text describe a paused / inactive capacity? */
function isCapacityPaused(text: string): boolean {
  const t = (text || '').toLowerCase();
  return (
    t.includes('capacitynotactive') ||
    t.includes('capacity is not active') ||
    t.includes('capacity not active') ||
    (t.includes('premium capacity') && t.includes('health')) ||
    (t.includes('capacity') && t.includes('paused')) ||
    (t.includes('capacity') && t.includes('suspended'))
  );
}

/** A parsed Kusto result table (columns + row tuples). */
export interface KustoTable {
  name: string;
  columns: { name: string; type: string }[];
  rows: unknown[][];
}

/** Parse the Kusto v2 response frames and return the PrimaryResult table. */
function parsePrimaryResult(frames: unknown): KustoTable {
  if (!Array.isArray(frames)) {
    throw new Error('Unexpected Kusto response shape (expected an array of frames).');
  }
  const objFrames = frames.filter(
    (f): f is Record<string, unknown> => !!f && typeof f === 'object',
  );
  // A query can FAIL or PARTIALLY FAIL after the HTTP layer already returned
  // 200 OK: runtime conditions such as E_LOW_MEMORY_CONDITION (bad allocation)
  // or runaway-query limits are reported inside the frames, not as an HTTP
  // error. Without this check the (empty) PrimaryResult would look like a
  // successful "no rows" result and callers would silently show nothing.
  const failure = extractV2Failure(objFrames);
  if (failure) {
    throw new Error(`Eventhouse query failed: ${failure}`);
  }
  const dataTables = objFrames.filter((f) => f.FrameType === 'DataTable');
  const primary =
    dataTables.find((f) => f.TableKind === 'PrimaryResult') ?? dataTables[dataTables.length - 1];
  if (!primary) {
    throw new Error('Kusto response contained no PrimaryResult table.');
  }
  const columns = ((primary.Columns as { ColumnName: string; ColumnType: string }[]) ?? []).map(
    (c) => ({ name: c.ColumnName, type: c.ColumnType }),
  );
  const rows = (primary.Rows as unknown[][]) ?? [];
  return { name: (primary.TableName as string) ?? 'PrimaryResult', columns, rows };
}

/**
 * Inspect the terminal `DataSetCompletion` frame of a Kusto v2 response and, if
 * the query failed / partially failed / was cancelled, return a human-readable
 * error message. Kusto surfaces these as HTTP 200 with the detail buried in the
 * frame's `OneApiErrors` array, so we dig out the most descriptive message
 * (`@message` carries text like "Partial query failure: Low memory condition
 * (E_LOW_MEMORY_CONDITION)").
 */
function extractV2Failure(frames: Record<string, unknown>[]): string | undefined {
  const completion = frames.find((f) => f.FrameType === 'DataSetCompletion');
  if (!completion) return undefined;
  const hasErrors = completion.HasErrors === true;
  const cancelled = completion.Cancelled === true;
  if (!hasErrors && !cancelled) return undefined;
  const oneApiErrors = Array.isArray(completion.OneApiErrors) ? completion.OneApiErrors : [];
  const messages = oneApiErrors
    .map((entry) => {
      const err = (entry as { error?: Record<string, unknown> })?.error;
      if (!err || typeof err !== 'object') return undefined;
      const msg =
        (typeof err['@message'] === 'string' && (err['@message'] as string)) ||
        (typeof err.message === 'string' && (err.message as string)) ||
        (typeof err.code === 'string' && (err.code as string)) ||
        undefined;
      return msg && msg.trim().length > 0 ? msg.trim() : undefined;
    })
    .filter((m): m is string => !!m);
  if (messages.length > 0) return messages.join('; ');
  if (cancelled) return 'Query was cancelled by the service.';
  return 'Query failed with an unspecified Kusto error.';
}

/** True when KQL text is a management command (control command), i.e. its first
 * non-whitespace character is a dot. The SPA never executes these; database
 * discovery uses Fabric REST APIs instead. */
function isManagementCommand(csl: string): boolean {
  return csl.trimStart().startsWith('.');
}

/**
 * Execute a read-only KQL query against the Eventhouse and return the primary
 * result table. Uses a delegated Kusto token (MSAL) so RLS is enforced. This is
 * the ONLY path the browser uses to read time-series data.
 *
 * Queries always go to `/v2/rest/query`. Kusto management/control commands
 * (dot-prefixed commands) are rejected locally and are never routed to the
 * management endpoint.
 *
 * Pass `opts` to target a Connection-Profile endpoint instead of the default
 * env-var values. When `opts.queryUri` is set, a token for that specific cluster
 * is acquired (MSAL caches by scope so re-acquisition is cheap).
 *
 * Pass `exec.signal` (an AbortSignal) to make an in-flight query cancellable —
 * when the signal aborts, the underlying `fetch` is aborted so a long Kusto
 * query is actually torn down (used by the Operations Advisor's per-tool timeout and the
 * user "stop" affordance). The parameter is optional and back-compatible: every
 * existing caller that omits it behaves exactly as before.
 */
export async function executeKql(
  csl: string,
  opts?: KqlOptions,
  exec?: { signal?: AbortSignal },
): Promise<KustoTable> {
  if (isManagementCommand(csl)) {
    throw new Error(
      'KQL management commands are not supported in Operations IQ. Database discovery uses Fabric REST APIs, and analysis queries must be read-only KQL query statements.',
    );
  }
  // Explicit opts (e.g. ConfigPage Test Connection, KqlQueryBuilder preview,
  // profile query preview) always win; otherwise fall back to the active Connection
  // Profile's endpoint so every page targets the selected cluster/database.
  const resolved = opts ?? getActiveKqlOpts();
  const queryUri = (resolved?.queryUri || env.eventhouseQueryUri).replace(/\/+$/, '');
  const db = resolved?.db || env.eventhouseDb;
  const token = await getEventhouseToken({ clusterUri: queryUri });
  const endpoint = `${queryUri}/v2/rest/query`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ db, csl }),
    signal: exec?.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    // A 401/403 means the delegated Kusto token expired or is for the wrong
    // identity — re-gate the UI so the user can re-sign from a gesture rather
    // than seeing an opaque error.
    if (response.status === 401 || response.status === 403) {
      notifyEventhouseSignInRequired();
      throw new EventhouseSignInRequiredError();
    }
    if (isCapacityPaused(detail)) throw new CapacityPausedError(detail);
    throw new Error(`Eventhouse query failed (${response.status}): ${detail}`);
  }

  const json = await response.json();
  return parsePrimaryResult(json);
}

/** Convert a KustoTable into an array of row objects keyed by column name. */
export function rowsToObjects<T = Record<string, unknown>>(table: KustoTable): T[] {
  return table.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    table.columns.forEach((col, i) => {
      obj[col.name] = row[i];
    });
    return obj as T;
  });
}

/** Convenience: run a query and return typed row objects. */
export async function queryRows<T = Record<string, unknown>>(
  csl: string,
  opts?: KqlOptions,
  exec?: { signal?: AbortSignal },
): Promise<T[]> {
  return rowsToObjects<T>(await executeKql(csl, opts, exec));
}
