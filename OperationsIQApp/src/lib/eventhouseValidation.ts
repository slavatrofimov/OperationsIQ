/**
 * Read-only validation of a Connection Profile's target (companion) Eventhouse
 * database. Confirms that the components the app relies on are present and that
 * the profile's four canonical queries resolve against the selected
 * cluster/database — using ONLY read-only `| take 0` probe queries, because the
 * browser never issues Kusto management commands.
 *
 * Authoritative function/table verification (which needs `.show functions` etc.)
 * lives in the PowerShell tooling (eventhouse/deploy/Validate-Eventhouse.ps1);
 * this client check is the interactive, profile-configuration-time counterpart
 * surfaced by the ConfigPage "Validate components" button.
 */

import { queryRows } from './eventhouse';
import type { KqlOptions } from './connectionProfile';

export type CheckSeverity = 'required' | 'recommended';
export type CheckStatus = 'pass' | 'warn' | 'fail';
export type CheckCategory = 'query' | 'resultTable';

export interface ComponentCheck {
  /** Human-readable component name (query label, table name). */
  name: string;
  category: CheckCategory;
  severity: CheckSeverity;
  status: CheckStatus;
  /** Error / explanation shown when not passing. */
  detail?: string;
}

export interface ValidationResult {
  /** True when no `required` check failed. */
  ok: boolean;
  checks: ComponentCheck[];
}

export interface ValidateInput {
  queryUri: string;
  db: string;
  /** Active/pending profile id, bound as `_ConnectionProfileId` for external-table filters. */
  profileId?: string;
  hierarchyQuery: string;
  metadataQuery: string;
  eventsQuery: string;
  timeseriesQuery: string;
}

/** Core result tables the analytics read paths require. */
const REQUIRED_RESULT_TABLES = ['mp_result', 'motif_pairs', 'discords', 'overview'];

/** Feature-specific result tables; absence only disables that one feature. */
const RECOMMENDED_RESULT_TABLES = [
  'motif_occurrences',
  'job_progress',
  'arc_curve',
  'segments',
  'chain_links',
  'md_dimensions',
  'consensus_members',
];

/** Single-quote/escape a KQL string literal (kept local to avoid a kql.ts import cycle). */
function kqlLiteral(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Prepend the profile-id binding so probes of queries that reference external
 *  tables (filtered by `_ConnectionProfileId`) compile. */
function withProfileId(csl: string, profileId?: string): string {
  return `let _ConnectionProfileId = ${kqlLiteral(profileId ?? '')};\n${csl}`;
}

/** Run a probe query; resolve to an error message string, or null on success. */
async function probe(csl: string, opts: KqlOptions): Promise<string | null> {
  try {
    await queryRows(csl, opts);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Validate every component of a connection profile against its target database.
 * Never throws for individual component failures — they surface as per-check
 * `fail`/`warn` entries so the UI can render a full report in one pass.
 */
export async function validateProfileComponents(input: ValidateInput): Promise<ValidationResult> {
  const opts: KqlOptions = { queryUri: input.queryUri.replace(/\/+$/, ''), db: input.db };
  const checks: ComponentCheck[] = [];

  // 1) Canonical queries (required): wrap each with `| take 0` so we validate
  //    parse + name resolution (cross-DB source access, projected columns,
  //    external-table joins) without pulling any data.
  const queries: { name: string; csl: string }[] = [
    { name: 'Hierarchy query', csl: input.hierarchyQuery },
    { name: 'Metadata query', csl: input.metadataQuery },
    { name: 'Events query', csl: input.eventsQuery },
    { name: 'Timeseries query', csl: input.timeseriesQuery },
  ];
  const queryResults = await Promise.all(
    queries.map((q) =>
      probe(withProfileId(`${q.csl.trim()}\n| take 0`, input.profileId), opts),
    ),
  );
  queries.forEach((q, i) => {
    const err = queryResults[i];
    checks.push({
      name: q.name,
      category: 'query',
      severity: 'required',
      status: err ? 'fail' : 'pass',
      detail: err ?? undefined,
    });
  });

  // 2) Result tables.
  const resultTableGroups: { tables: string[]; severity: CheckSeverity }[] = [
    { tables: REQUIRED_RESULT_TABLES, severity: 'required' },
    { tables: RECOMMENDED_RESULT_TABLES, severity: 'recommended' },
  ];
  for (const group of resultTableGroups) {
    const results = await Promise.all(group.tables.map((t) => probe(`${t} | take 0`, opts)));
    group.tables.forEach((t, i) => {
      const err = results[i];
      checks.push({
        name: t,
        category: 'resultTable',
        severity: group.severity,
        status: err ? (group.severity === 'required' ? 'fail' : 'warn') : 'pass',
        detail: err ?? undefined,
      });
    });
  }

  // 3) External tables are intentionally NOT probed here. The app no longer
  //    depends on `AnnotationsExternal` (annotations load directly from the SQL
  //    DB, server-side filtered — see loadAnnotationMarkers) or on
  //    `SignalMetadataExternal` (governed metadata is overlaid client-side from
  //    the SQL DB — see getEffectiveSignalMetadata). Probing for them produced
  //    misleading warnings: a present table doesn't imply it's wired in, and an
  //    absent one no longer disables any feature.

  const ok = !checks.some((c) => c.severity === 'required' && c.status === 'fail');
  return { ok, checks };
}

// ---------------------------------------------------------------------------
// Wide time-series base-query validation
// ---------------------------------------------------------------------------

/** Fixed column names a wide base query must emit. */
export const WIDE_FIXED_COLUMNS = { prefix: 'SignalIdPrefix', timestamp: 'Timestamp' } as const;

/** KQL scalar types accepted as (unpivotable) value columns. `toreal(...)` coerces them. */
const WIDE_NUMERIC_TYPES = new Set(['real', 'long', 'int', 'decimal']);

export interface WideValidationResult {
  status: CheckStatus;
  /** True when the base query emits the fixed columns and >= 2 numeric value columns. */
  ok: boolean;
  /** Discovered value (numeric) column names. */
  valueColumns: string[];
  /** Value column names (or the fixed prefix) that contain the delimiter — a parse hazard. */
  collisions: string[];
  /** Human-readable explanation shown in the UI. */
  detail: string;
}

/**
 * Validate a *wide* time-series base query with a read-only `getschema` probe:
 * it must emit the fixed `SignalIdPrefix` (string) and `Timestamp` (datetime)
 * columns plus at least two numeric value columns. Also flags any value column
 * (or the prefix) whose NAME contains the chosen delimiter, since that would make
 * the canonical `SignalId = prefix + delimiter + column` split ambiguous.
 *
 * Read-only only (browser never issues management commands); `getschema` is a
 * tabular operator, so it is safe.
 */
export async function validateWideTimeseries(input: {
  queryUri: string;
  db: string;
  baseQuery: string;
  delimiter: string;
}): Promise<WideValidationResult> {
  const opts: KqlOptions = { queryUri: input.queryUri.replace(/\/+$/, ''), db: input.db };
  if (!input.baseQuery.trim()) {
    return { status: 'fail', ok: false, valueColumns: [], collisions: [], detail: 'Enter a base wide query first.' };
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await queryRows(`${input.baseQuery.trim()}\n| getschema | project ColumnName, ColumnType`, opts);
  } catch (e) {
    return {
      status: 'fail',
      ok: false,
      valueColumns: [],
      collisions: [],
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  const cols = rows.map((r) => ({
    name: String(r.ColumnName ?? ''),
    type: String(r.ColumnType ?? '').toLowerCase(),
  }));
  const byName = new Map(cols.map((c) => [c.name, c.type]));

  const problems: string[] = [];
  const prefixType = byName.get(WIDE_FIXED_COLUMNS.prefix);
  if (prefixType == null) {
    problems.push(`Missing required "${WIDE_FIXED_COLUMNS.prefix}" column.`);
  } else if (prefixType !== 'string') {
    problems.push(`"${WIDE_FIXED_COLUMNS.prefix}" must be a string (found ${prefixType}).`);
  }
  const tsType = byName.get(WIDE_FIXED_COLUMNS.timestamp);
  if (tsType == null) {
    problems.push(`Missing required "${WIDE_FIXED_COLUMNS.timestamp}" column.`);
  } else if (tsType !== 'datetime') {
    problems.push(`"${WIDE_FIXED_COLUMNS.timestamp}" must be a datetime (found ${tsType}).`);
  }

  const valueColumns = cols
    .filter(
      (c) =>
        c.name !== WIDE_FIXED_COLUMNS.prefix &&
        c.name !== WIDE_FIXED_COLUMNS.timestamp &&
        WIDE_NUMERIC_TYPES.has(c.type),
    )
    .map((c) => c.name);
  if (valueColumns.length < 2) {
    problems.push(
      `At least two numeric value columns are required for a wide table (found ${valueColumns.length}). ` +
        'Use the narrow layout instead if you only have one value per signal.',
    );
  }

  // Delimiter collisions: the delimiter must not appear in the prefix column name
  // or any value column name, or the SignalId split becomes ambiguous.
  const delim = input.delimiter || '-';
  const collisions = [WIDE_FIXED_COLUMNS.prefix, ...valueColumns].filter((n) => n.includes(delim));

  if (problems.length > 0) {
    return { status: 'fail', ok: false, valueColumns, collisions, detail: problems.join(' ') };
  }
  if (collisions.length > 0) {
    return {
      status: 'warn',
      ok: true,
      valueColumns,
      collisions,
      detail:
        `Delimiter "${delim}" appears in: ${collisions.join(', ')}. ` +
        'Choose a delimiter that never occurs in the prefix or value-column names, ' +
        'or the SignalId split may be ambiguous.',
    };
  }
  return {
    status: 'pass',
    ok: true,
    valueColumns,
    collisions,
    detail: `Found ${valueColumns.length} value columns: ${valueColumns.join(', ')}.`,
  };
}
