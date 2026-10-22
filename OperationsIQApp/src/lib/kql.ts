/**
 * KQL query builders for the app's read-only Eventhouse calls. Every dynamic
 * value is either escaped (strings) or validated as a finite number (numeric
 * params) before interpolation, so untrusted UI input cannot inject KQL.
 * All queries run under the user's delegated token, so RLS is still enforced.
 *
 * When a Connection Profile is active, callers pass `timeseriesRef` (the
 * profile's timeseriesQuery) into the options of queries that reference the
 * `Timeseries` table. The `withTimeseriesRef` helper prepends a `let` binding
 * so profile-specific source tables are seamlessly substituted.
 *
 * The similarity (app_extract_segment, app_search_space), discords
 * (sax_discords), and SAX-VSM queries call KQL stored functions deployed in the
 * Eventhouse. Those helper functions take the timeseries source as a TABULAR
 * PARAMETER carrying the canonical (SignalId, Timestamp, Value) shape, so they
 * are agnostic to the underlying physical column names. Each builder binds the
 * profile's canonical timeseries query via `withTimeseriesRef` and passes the
 * resulting `Timeseries` binding into the function call — the same mechanism the
 * direct-`Timeseries` builders use.
 */

import {
  getActiveTimeseriesRef,
  getActiveTimeseriesIsWide,
  getActiveSignalIdDelimiter,
  getActiveHierarchyRef,
  getActiveMetadataRef,
  getActiveEventsRef,
  getActiveProfileId,
} from './activeConnection';
import { getQueryOffsetMinutes } from './queryTimezone';
import { computeLookbackSeconds } from './activator/frequency';

// --- literal helpers ---------------------------------------------------------

/** Single-quote and escape a KQL string literal. */
export function kqlString(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** A KQL dynamic() array of strings. */
export function kqlStringArray(values: string[]): string {
  return `dynamic([${values.map(kqlString).join(', ')}])`;
}

/**
 * KQL datetime() literal from a JS Date, shifted into the preferred analysis
 * timezone. Every window bound/anchor emitted by the builders flows through
 * here, so shifting the literal by +offset (matching the Timestamp-column shift
 * in {@link withTimeseriesRef}) localizes the whole query in one place. With the
 * default UTC offset (0) this is an exact ISO-8601 UTC literal as before.
 */
export function kqlDatetime(d: Date): string {
  const offset = getQueryOffsetMinutes();
  const shifted = offset === 0 ? d : new Date(d.getTime() + offset * 60_000);
  return `datetime(${shifted.toISOString()})`;
}

/**
 * KQL datetime() literal in RAW UTC — deliberately *not* shifted by the analysis
 * timezone offset. Used only for the early window pre-filter that runs against the
 * source's original `Timestamp`, before the shift applied in
 * {@link withTimeseriesRef}.
 */
function kqlDatetimeUtc(d: Date): string {
  return `datetime(${d.toISOString()})`;
}

/** Validated real number literal (guards against injection via NaN/Infinity/strings). */
export function kqlNum(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`Invalid numeric parameter: ${n}`);
  }
  return String(n);
}

/** Validated integer literal. */
export function kqlInt(n: number): string {
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid integer parameter: ${n}`);
  }
  return String(n);
}

// --- timeseries ref helper ---------------------------------------------------

/**
 * Prepend a `let Timeseries = (…)` binding that maps the active Connection
 * Profile's timeseries source onto the canonical `Timeseries` name so every
 * builder below can filter/project the canonical `SignalId`/`Timestamp`/`Value`
 * columns regardless of the underlying schema.
 *
 * An active Connection Profile is mandatory: when no explicit `ref` is passed
 * the profile's `timeseriesQuery` is read from the active-connection singleton.
 * If neither is available this throws — the app must not silently fall back to
 * any default/raw schema.
 *
 * When a non-UTC query timezone offset is active, the canonical `Timestamp`
 * column is shifted by +offset here so every downstream operation
 * (bin/make-series, hourofday/dayofweek/startofday) computes in the preferred
 * zone's wall clock. The datetime literals compared against it are shifted by
 * the same amount in {@link kqlDatetime}, so row selection is unchanged while
 * bin alignment moves to the preferred zone.
 *
 * For performance the window is *also* pushed down onto the source's raw,
 * unshifted `Timestamp` (with raw UTC literals) ahead of that shift whenever a
 * `scope` is supplied — filtering an `extend`-redefined column is evaluated after
 * the scan and would forfeit Kusto's datetime index / extent elimination. The two
 * filters are algebraically identical, so this changes cost, never results.
 */
export function withTimeseriesRef(
  csl: string,
  ref?: string,
  scope?: TimeseriesScope,
  wide?: WideTimeseriesConfig,
  preAgg?: WidePreAggregation,
): string {
  const resolved = ref ?? getActiveTimeseriesRef();
  if (!resolved) {
    throw new Error(
      'No active connection profile: a profile with a canonical timeseries query is required before running analyses.',
    );
  }
  const isWide = wide?.isWide ?? getActiveTimeseriesIsWide();
  const offset = getQueryOffsetMinutes();

  if (isWide) {
    const delim = wide?.delimiter ?? getActiveSignalIdDelimiter() ?? DEFAULT_WIDE_DELIMITER;
    if (!scope || scope.signalIds.length === 0) {
      throw new Error(
        'Wide time-series profiles require an explicit, bounded signal selection; this analysis did not supply one. ' +
          'Select the specific signals to analyze (within the multi-select limit) and try again.',
      );
    }
    // `count` re-aggregation is not preservable across a pre-bin (each pre-bin
    // collapses to a single row, so a downstream count would return 1/bin), so
    // fall back to a raw projection for it.
    const effectivePreAgg = preAgg && preAgg.aggregation !== 'count' ? preAgg : undefined;
    const binding = buildWideTimeseriesBinding(resolved.trim(), delim, scope, offset, effectivePreAgg);
    return `${binding}\n${csl}`;
  }

  const trimmed = resolved.trim();

  if (offset === 0) {
    if (trimmed === 'Timeseries') return csl;
    return `let Timeseries = (\n${trimmed}\n);\n${csl}`;
  }

  // Bind the source to an intermediate name first, then derive the shifted
  // canonical `Timeseries` from it. The intermediate avoids a self-referential
  // `let Timeseries = (Timeseries | …)` when the source is the raw table name.
  const shift = `datetime_add('minute', ${kqlInt(offset)}, Timestamp)`;
  const shiftClause = `| extend Timestamp = ${shift}`;
  // Push the window down onto the source's RAW `Timestamp` (raw UTC literals)
  // *ahead* of the shift. A filter on a column that `extend` has redefined is
  // evaluated after the scan, forfeiting Kusto's datetime index and extent
  // elimination — the dominant cost on long histories. Downstream builders still
  // re-filter the shifted column with shifted literals; because
  // `T + offset ∈ [s + offset, e + offset]` ⟺ `T ∈ [s, e]`, this pre-filter selects
  // exactly the same rows and is purely an optimization. `scope` is a covering
  // bound of everything the builder reads (see tsScope / tsScope2) — the wide path
  // already depends on that invariant.
  const body = scope
    ? `_TimeseriesBase\n  | where Timestamp between (${kqlDatetimeUtc(scope.start)} .. ${kqlDatetimeUtc(scope.end)})\n  ${shiftClause}`
    : `_TimeseriesBase ${shiftClause}`;
  return `let _TimeseriesBase = (\n${trimmed}\n);\nlet Timeseries = (${body});\n${csl}`;
}

/** Default Signal Id delimiter for wide time-series profiles (mirrors connectionProfile.ts). */
const DEFAULT_WIDE_DELIMITER = '-';

/**
 * The in-scope signals + time window an analysis is about to query. Required to
 * build the query-time wide→narrow transform (see {@link buildWideTimeseriesBinding}):
 * the distinct value columns to unpivot are derived from `signalIds`, and the
 * window drives the early timestamp pre-filter. Narrow profiles ignore it.
 */
export interface TimeseriesScope {
  /** The exact canonical SignalIds the analysis will filter to. */
  signalIds: string[];
  /** Inclusive window start. */
  start: Date;
  /** Inclusive window end. */
  end: Date;
}

/** Wide-profile config override for {@link withTimeseriesRef} (defaults read from the active connection). */
export interface WideTimeseriesConfig {
  isWide: boolean;
  delimiter: string;
}

/**
 * Optional pre-aggregation hint for a *wide* profile's query-time transform. When
 * supplied, the wide→narrow binding bins (summarizes) the pre-filtered, pre-projected
 * wide subset *before* materializing it, using the same bin width and aggregation the
 * downstream analysis will apply. For dense raw data this shrinks the materialized set
 * from raw resolution to (#prefixes × #bins), which can be a large reduction.
 *
 * Correctness: the pre-bin uses `bin_at(Timestamp, binKql, <window start>)`, aligning
 * its buckets to the exact grid the downstream `make-series … from <window start> …
 * step <binKql>` produces. Each downstream bin therefore maps to exactly one pre-bin
 * value per signal, so re-applying `avg`/`min`/`max`/`sum` over that single value is
 * lossless. `count` is not preservable this way and callers must not request it here
 * (it is ignored if they do). Only apply this for analyses whose whole `Timeseries`
 * consumption is a single `make-series`/`summarize` at exactly `binKql`.
 */
export interface WidePreAggregation {
  /** Bin width KQL literal — must match the downstream make-series step (e.g. from chooseBin().kql). */
  binKql: string;
  /** Aggregation applied per bin; must match the downstream aggregation. `count` disables pre-aggregation. */
  aggregation: Aggregation;
}

/** Build a {@link TimeseriesScope} (terse call-site helper). */
function tsScope(signalIds: string[], start: Date, end: Date): TimeseriesScope {
  return { signalIds, start, end };
}

/** Build a {@link TimeseriesScope} spanning two windows (e.g. similarity query + search). */
function tsScope2(
  signalIds: string[],
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): TimeseriesScope {
  const start = aStart.getTime() <= bStart.getTime() ? aStart : bStart;
  const end = aEnd.getTime() >= bEnd.getTime() ? aEnd : bEnd;
  return { signalIds, start, end };
}

/**
 * Split the in-scope canonical SignalIds into the distinct `SignalIdPrefix`
 * values and distinct value-column names needed to build a wide→narrow
 * transform. Each SignalId is `prefix + delimiter + column`; because the
 * delimiter is chosen to never occur inside a prefix or column name, splitting
 * on the FIRST delimiter occurrence is unambiguous.
 */
export function deriveWideColumns(
  signalIds: string[],
  delimiter: string,
): { prefixes: string[]; columns: string[] } {
  if (!delimiter) {
    throw new Error('A Signal Id delimiter is required for wide time-series profiles.');
  }
  const prefixes = new Set<string>();
  const columns = new Set<string>();
  for (const id of signalIds) {
    const i = id.indexOf(delimiter);
    if (i < 0) {
      throw new Error(
        `Signal id "${id}" does not contain the wide-profile delimiter "${delimiter}"; ` +
          'wide-profile catalog queries must emit SignalId = SignalIdPrefix + delimiter + valueColumn.',
      );
    }
    prefixes.add(id.slice(0, i));
    columns.add(id.slice(i + delimiter.length));
  }
  return { prefixes: [...prefixes], columns: [...columns] };
}

/** Reference a KQL column by name with bracket-quoting so spaces/specials are safe: `['My Col']`. */
function kqlColumn(name: string): string {
  return `[${kqlString(name)}]`;
}

/**
 * Build the `let` statement list that unpivots a *wide* base query into the
 * canonical narrow (SignalId, Timestamp, Value) shape at query time, applying
 * filters and projections as early as possible for performance. Emits three
 * top-level bindings (so they compose cleanly with the `_ConnectionProfileId`
 * binding the builders prepend):
 *
 *   let _TimeseriesBase = ( <user base wide query> );
 *   let _wb = materialize(
 *       _TimeseriesBase
 *     | extend Timestamp = …            // tz shift, offset ≠ 0 only
 *     | where Timestamp between (window) // early time pre-filter
 *     | where SignalIdPrefix in (…)      // early prefix pre-filter
 *     | project SignalIdPrefix, Timestamp, <in-scope value columns>  // drop unused columns
 *   );
 *   let Timeseries = (
 *       union (one leg per in-scope value column: SignalId = strcat(prefix, delim, col), Value = toreal(col))
 *     | where SignalId in (exact in-scope ids)  // final signal filter
 *   );
 *
 * Binding the base to `_TimeseriesBase` first (rather than inlining it inside
 * `materialize((…))`) avoids two problems: (1) a Kusto parse error — inside a
 * function-call argument, `materialize((base) | …)` parses `(base)` as a complete
 * argument and then rejects the trailing `|` ("Expected: )"); and (2) a
 * self-reference when the user's base reads from a table literally named
 * `Timeseries` (the base is resolved before `let Timeseries` comes into scope).
 * Only the value columns referenced by the in-scope signals are kept and
 * unpivoted, so columns the analysis will not use are neither materialized nor
 * expanded.
 *
 * When `preAgg` is supplied, the final projection is replaced by an early
 * `summarize <col> = <agg>(<col>), … by SignalIdPrefix, Timestamp = bin_at(Timestamp,
 * <binKql>, <window start>)`. This bins the pre-filtered wide subset *before* it is
 * materialized, so for dense raw data the materialized set collapses from raw
 * resolution to (#prefixes × #bins). `bin_at` is anchored to the window start so the
 * pre-bins align exactly with the downstream `make-series … from <window start> …
 * step <binKql>` grid (see {@link WidePreAggregation}).
 */
function buildWideTimeseriesBinding(
  base: string,
  delimiter: string,
  scope: TimeseriesScope,
  offset: number,
  preAgg?: WidePreAggregation,
): string {
  const { prefixes, columns } = deriveWideColumns(scope.signalIds, delimiter);
  const shift =
    offset === 0
      ? ''
      : `\n  | extend Timestamp = datetime_add('minute', ${kqlInt(offset)}, Timestamp)`;
  // RAW UTC literals: this filter runs against the source's original `Timestamp`,
  // *before* the shift below, so Kusto's datetime index and extent elimination
  // still apply. Equivalent to filtering the shifted column with shifted literals
  // (both sides move by the same offset), but without defeating the index.
  const timeFilter = `\n  | where Timestamp between (${kqlDatetimeUtc(scope.start)} .. ${kqlDatetimeUtc(scope.end)})`;
  const prefixFilter = `\n  | where SignalIdPrefix in (${kqlStringArray(prefixes)})`;
  // Reduce the pre-filtered wide subset before materializing. Without a pre-agg
  // hint, keep only the fixed columns + the distinct in-scope value columns so the
  // materialized set carries nothing the union legs will not read. With a pre-agg
  // hint, bin each in-scope value column to the downstream grain up front — the
  // union legs then read one aggregated value per (prefix, bin) instead of every
  // raw row. `bin_at(…, <window start>)` anchors buckets to the make-series grid so
  // the later re-aggregation over each single pre-binned value is lossless.
  const reduce = preAgg
    ? `\n  | summarize ${columns
        .map((col) => `${kqlColumn(col)} = ${preAgg.aggregation}(${kqlColumn(col)})`)
        .join(', ')} by SignalIdPrefix, Timestamp = bin_at(Timestamp, ${preAgg.binKql}, ${kqlDatetime(scope.start)})`
    : `\n  | project SignalIdPrefix, Timestamp, ${columns.map(kqlColumn).join(', ')}`;
  const baseBinding = `let _TimeseriesBase = (\n${base}\n);`;
  // Order matters: both pre-filters run against raw, indexed source columns; the
  // tz shift is then applied only to the surviving rows, still ahead of `reduce`
  // so `bin_at` (and every downstream bin/hourofday/startofday) aligns to the
  // preferred zone's wall clock.
  const wb = `let _wb = materialize(\n  _TimeseriesBase${timeFilter}${prefixFilter}${shift}${reduce}\n);`;
  const legs = columns
    .map(
      (col) =>
        `    (_wb | project Timestamp, SignalId = strcat(SignalIdPrefix, ${kqlString(delimiter)}, ${kqlString(col)}), Value = toreal(${kqlColumn(col)}))`,
    )
    .join(',\n');
  const signalFilter = `  | where SignalId in (${kqlStringArray(scope.signalIds)})`;
  const tsBinding = `let Timeseries = (\n  union\n${legs}\n${signalFilter}\n);`;
  return `${baseBinding}\n${wb}\n${tsBinding}`;
}

/** Canonical hierarchy level column names, used to validate an entity-level selector. */
const LEVEL_COLUMNS = new Set([
  'Level1', 'Level2', 'Level3', 'Level4', 'Level5',
  'Level6', 'Level7', 'Level8', 'Level9', 'Level10',
]);

/**
 * Build a `let _ConnectionProfileId = '<id>';` binding so profile-scoped
 * external-table templates (`AnnotationsExternal`, `SignalMetadataExternal`) can
 * filter to the active profile's rows. The id is bound at query time rather than
 * baked into the stored query text, so a single app instance + single shared
 * RayFin SQL DB (mirrored once to OneLake) can serve many connection profiles:
 * each profile's queries only ever see the annotations / governed metadata that
 * were authored under it.
 *
 * When no profile is active (e.g. the ConfigPage preview of an as-yet-unsaved
 * profile) the id binds to the empty string, which simply matches no external
 * rows. The binding is always emitted; an unused `let` is valid KQL, so queries
 * whose templates don't reference `_ConnectionProfileId` are unaffected.
 */
function profileIdBinding(profileId?: string): string {
  const pid = profileId ?? getActiveProfileId() ?? '';
  return `let _ConnectionProfileId = ${kqlString(pid)};\n`;
}

/**
 * Build `let Hierarchy = (…);` and `let Metadata = (…);` bindings from the
 * active Connection Profile (or explicit overrides), mirroring
 * {@link withTimeseriesRef}. Both are required — the app must not fall back to
 * any raw/default table. A `let _ConnectionProfileId` binding is prepended so a
 * metadata query that joins `SignalMetadataExternal` can filter it to the active
 * profile.
 */
function dimensionBindings(hierarchyRef?: string, metadataRef?: string): string {
  const h = hierarchyRef ?? getActiveHierarchyRef();
  const m = metadataRef ?? getActiveMetadataRef();
  if (!h || !m) {
    throw new Error(
      'No active connection profile: hierarchy and metadata queries are required before running multivariate analyses.',
    );
  }
  return `${profileIdBinding()}let Hierarchy = (\n${h.trim()}\n);\nlet Metadata = (\n${m.trim()}\n);\n`;
}

/** Validate/normalize a canonical entity-level column name (defaults to Level4). */
function entityLevelColumn(level?: string): string {
  if (!level) return 'Level4';
  if (!LEVEL_COLUMNS.has(level)) {
    throw new Error(`Invalid entity level "${level}": expected one of Level1..Level10.`);
  }
  return level;
}

// --- exploration -------------------------------------------------------------

export type Aggregation = 'avg' | 'min' | 'max' | 'sum' | 'count';

const AGG_EXPR: Record<Aggregation, string> = {
  avg: 'avg(Value)',
  min: 'min(Value)',
  max: 'max(Value)',
  sum: 'sum(Value)',
  count: 'count()',
};

export interface ExploreOptions {
  tagIds: string[];
  start: Date;
  end: Date;
  /** Bin width KQL literal, e.g. from chooseBin().kql. */
  binKql: string;
  aggregation?: Aggregation;
  /** series_decompose_anomalies sensitivity (lower = more sensitive). Default 1.5. */
  sensitivity?: number;
  /**
   * Connection-Profile timeseries query. When provided, a `let Timeseries = (…)`
   * binding is prepended so the query targets the profile's source table instead
   * of the default `Timeseries` table.
   */
  timeseriesRef?: string;
}

/**
 * Adaptive-binned exploration query with unsupervised anomaly overlay.
 * Returns rows: SignalId, Timestamp (dynamic array), Value (dynamic array),
 * AnomalyFlags, AnomalyScore, Baseline — one row per signal.
 */
export function buildExploreQuery(opts: ExploreOptions): string {
  const agg = AGG_EXPR[opts.aggregation ?? 'avg'];
  const sensitivity = kqlNum(opts.sensitivity ?? 1.5);
  const from = kqlDatetime(opts.start);
  const to = kqlDatetime(opts.end);
  const csl = `Timeseries
| where SignalId in (${kqlStringArray(opts.tagIds)})
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${opts.binKql} by SignalId
| extend Value = series_fill_linear(Value)
| extend (AnomalyFlags, AnomalyScore, Baseline) = series_decompose_anomalies(Value, ${sensitivity}, -1, 'linefit')
| project SignalId, Timestamp, Value, AnomalyFlags, AnomalyScore, Baseline`;
  return withTimeseriesRef(csl, opts.timeseriesRef, tsScope(opts.tagIds, opts.start, opts.end), undefined, {
    binKql: opts.binKql,
    aggregation: opts.aggregation ?? 'avg',
  });
}

export interface RobustOutliersOptions {
  tagId: string;
  start: Date;
  end: Date;
  /** Bin width KQL literal, e.g. from chooseBin().kql. */
  binKql: string;
  aggregation?: Aggregation;
  timeseriesRef?: string;
}

/**
 * Robust (model-free) outlier scoring via `series_outliers`. It needs no trend or
 * seasonal model: each bin is scored with Tukey's fences ("ctukey",
 * 10th/90th-percentile inter-quantile range), so it suits aperiodic signals and
 * level shifts. Returns one row per (single) signal with the gap-filled `Value`
 * and a parallel `AnomalyScore` array (>1.5 rise, <-1.5 decline by convention).
 */
export function buildRobustOutliersQuery(o: RobustOutliersOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const csl = `Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql} by SignalId
| extend Value = series_fill_linear(Value)
| extend AnomalyScore = series_outliers(Value)
| project SignalId, Timestamp, Value, AnomalyScore`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end), undefined, {
    binKql: o.binKql,
    aggregation: o.aggregation ?? 'avg',
  });
}

/**
 * Events (point + span) intersecting a range, filtered to the given scope keys
 * (`<ScopeType>|#|<ScopeId>`). Binds the active Connection Profile's canonical
 * events query (`let Events = (…)`) so it works against any schema, and projects
 * the canonical event columns plus optional Source/UserId fields when a profile
 * unions annotations in-server. An event overlaps the range when it starts
 * at/before `end` and either is a point event within the range or a span event
 * ending at/after `start`. An empty `scopeKeys` array still yields a valid
 * query that matches nothing, though callers should usually avoid querying with
 * none.
 */
export function buildEventsQuery(
  scopeKeys: string[],
  start: Date,
  end: Date,
  eventsRef?: string,
): string {
  const resolved = eventsRef ?? getActiveEventsRef();
  if (!resolved) {
    throw new Error(
      'No active connection profile: an events query is required before loading events.',
    );
  }
  const from = kqlDatetime(start);
  const to = kqlDatetime(end);
  // Shift event timestamps into the preferred zone to match the shifted range
  // bounds (see kqlDatetime). datetime_add on a null EndTimestamp stays null.
  const offset = getQueryOffsetMinutes();
  const shiftExtend =
    offset === 0
      ? ''
      : `\n| extend StartTimestamp = datetime_add('minute', ${kqlInt(offset)}, StartTimestamp), EndTimestamp = datetime_add('minute', ${kqlInt(offset)}, EndTimestamp)`;
  return `${profileIdBinding()}let Events = (\n${resolved.trim()}${shiftExtend}\n);
Events
| where strcat(ScopeType, '|#|', ScopeId) in (${kqlStringArray(scopeKeys)})
| where StartTimestamp <= ${to}
| where iff(isnull(EndTimestamp), StartTimestamp >= ${from}, EndTimestamp >= ${from})
| project EventId, ScopeId, ScopeType, StartTimestamp, EndTimestamp, EventType, Title, Detail, Source=column_ifexists('Source', 'Event'), UserId=column_ifexists('UserId', '')`;
}

export interface RawCountOptions {
  tagIds: string[];
  start: Date;
  end: Date;
  /** Connection-Profile timeseries query (see ExploreOptions.timeseriesRef). */
  timeseriesRef?: string;
}

/**
 * Resolve the wide-native probe context for the given options, or `null` when
 * the active profile is narrow (so callers keep the canonical `Timeseries`
 * path). Wide profiles answer the density/coverage probes directly on the wide
 * base — see {@link buildWideProbeScan} — so the raw rows are never unpivoted
 * or materialized and the 5 GB per-cluster materialize cap cannot be hit.
 */
function resolveWideProbe(
  o: RawCountOptions,
): { base: string; delim: string; prefixes: string[]; columns: string[]; offset: number } | null {
  if (!getActiveTimeseriesIsWide()) return null;
  const resolved = o.timeseriesRef ?? getActiveTimeseriesRef();
  if (!resolved) {
    throw new Error(
      'No active connection profile: a profile with a canonical timeseries query is required before running analyses.',
    );
  }
  if (o.tagIds.length === 0) {
    throw new Error(
      'Wide time-series profiles require an explicit, bounded signal selection; this analysis did not supply one. ' +
        'Select the specific signals to analyze (within the multi-select limit) and try again.',
    );
  }
  const delim = getActiveSignalIdDelimiter() ?? DEFAULT_WIDE_DELIMITER;
  const { prefixes, columns } = deriveWideColumns(o.tagIds, delim);
  return { base: resolved.trim(), delim, prefixes, columns, offset: getQueryOffsetMinutes() };
}

/**
 * Build the two parts of a wide-native probe scan: the top-level
 * `let _TimeseriesBase = (…);` binding (which must stay OUTSIDE any
 * `materialize(...)` — a `let` is illegal inside a function-call argument), and
 * the filtered pipeline body that reads it: apply the early time +
 * `SignalIdPrefix` pre-filters, then shift the timestamp into the query zone
 * (offset ≠ 0 only). Callers append the probe-specific `summarize`.
 *
 * The time filter uses RAW UTC bounds against the source's unshifted `Timestamp`
 * and runs *before* the shift, so Kusto's datetime index / extent elimination
 * still applies — this is a full-window scan, so that pruning is the dominant
 * cost factor. The shift still precedes the caller's `summarize`, so aggregates
 * over `Timestamp` (e.g. coverage's `FirstTs`/`LastTs`) report the preferred
 * zone's wall clock. This is a streaming scan of the wide table — no
 * `materialize` of raw rows, no unpivot — so it stays well under the materialize
 * cap even on very dense sources.
 */
function buildWideProbeScan(
  w: { base: string; prefixes: string[]; offset: number },
  start: Date,
  end: Date,
): { baseBinding: string; filtered: string } {
  const shift =
    w.offset === 0
      ? ''
      : `\n| extend Timestamp = datetime_add('minute', ${kqlInt(w.offset)}, Timestamp)`;
  return {
    baseBinding: `let _TimeseriesBase = (\n${w.base}\n);`,
    filtered: `_TimeseriesBase
| where Timestamp between (${kqlDatetimeUtc(start)} .. ${kqlDatetimeUtc(end)})
| where SignalIdPrefix in (${kqlStringArray(w.prefixes)})${shift}`,
  };
}

/**
 * Lightweight count of raw (un-binned) records for the given tags in a range,
 * reduced to the **highest per-tag count** — i.e. how many records the densest
 * single selected signal contributes. Used to estimate the data's native
 * sampling frequency so we can warn when a chosen resolution is finer than the
 * underlying data supports.
 *
 * We take the max per tag (rather than the total across tags) because selecting
 * more tags inflates the total without implying the data is sampled any more
 * frequently; the densest single tag is what actually bounds a usable
 * resolution. Returns a single row with the max per-tag count.
 *
 * This is the one exploration query that always runs against the *canonical*,
 * profile-bound `Timeseries` (the density hook passes `timeseriesRef`), so it
 * filters on the canonical `SignalId` column — NOT the raw source's `TagId`.
 * The `tagIds` are canonical SignalId values, which only match a custom
 * profile's remapped signals when we filter the canonical column.
 *
 * For **wide** profiles the count is answered directly on the wide base: because
 * every value column shares one `Timestamp`/row, the raw record count of any
 * signal derived from a prefix equals that prefix's wide row count, so the
 * densest signal's count is `max(count() by SignalIdPrefix)`. This never
 * materializes or unpivots raw rows (see {@link buildWideProbeScan}).
 */
export function buildMaxTagCountQuery(o: RawCountOptions): string {
  const wide = resolveWideProbe(o);
  if (wide) {
    const { baseBinding, filtered } = buildWideProbeScan(wide, o.start, o.end);
    return `${baseBinding}\n${filtered}
| summarize Cnt = count() by SignalIdPrefix
| summarize MaxTagCount = max(Cnt)`;
  }
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const csl = `Timeseries
| where SignalId in (${kqlStringArray(o.tagIds)})
| where Timestamp between (${from} .. ${to})
| summarize Cnt = count() by SignalId
| summarize MaxTagCount = max(Cnt)`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope(o.tagIds, o.start, o.end));
}

/**
 * Per-tag data-coverage summary over a window: earliest/latest sample, raw row
 * count, and the value min/max/avg. Feeds the `get_data_coverage` tool so the
 * agent can check that a window actually has data (and how fresh it is) before
 * it analyzes. Returns one row per tag: SignalId, FirstTs, LastTs, Cnt, MinV,
 * MaxV, AvgV. Filters the canonical `SignalId` column (see buildMaxTagCountQuery).
 *
 * For **wide** profiles the summary is computed directly on the wide base
 * (see {@link buildWideCoverageQuery}): the per-column aggregates are reduced by
 * `SignalIdPrefix` first, then the small per-prefix result is unpivoted into the
 * per-signal rows the tool expects. Raw rows are never materialized or
 * unpivoted, so the 5 GB materialize cap cannot be reached. `FirstTs`/`LastTs`
 * are reduced per prefix (canonical wide co-samples every column, so they match
 * each derived signal); `AvgV` is recovered as `sum/count`.
 */
export function buildCoverageQuery(o: RawCountOptions): string {
  const wide = resolveWideProbe(o);
  if (wide) return buildWideCoverageQuery(o, wide);
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const csl = `Timeseries
| where SignalId in (${kqlStringArray(o.tagIds)})
| where Timestamp between (${from} .. ${to})
| summarize FirstTs = min(Timestamp), LastTs = max(Timestamp), Cnt = count(),
    MinV = min(Value), MaxV = max(Value), AvgV = avg(Value) by SignalId`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope(o.tagIds, o.start, o.end));
}

/**
 * Wide-native coverage: reduce per-column min/max/count/sum by `SignalIdPrefix`
 * on the wide base, materialize that *tiny* per-prefix aggregate (one row per
 * prefix, far under the materialize cap), then unpivot it into the canonical
 * per-signal coverage rows (SignalId, FirstTs, LastTs, Cnt, MinV, MaxV, AvgV).
 * The final `where SignalId in (…)` trims the prefix×column cross-product back
 * to exactly the requested signals.
 */
function buildWideCoverageQuery(
  o: RawCountOptions,
  w: { base: string; delim: string; prefixes: string[]; columns: string[]; offset: number },
): string {
  // Per-column aggregates, aliased by column index so arbitrary column names
  // (spaces/specials) can't collide or need identifier-quoting on the alias.
  const aggs = w.columns
    .map((c, i) => {
      const col = kqlColumn(c);
      return `c${i}_cnt = count(${col}), c${i}_min = min(${col}), c${i}_max = max(${col}), c${i}_sum = sum(${col})`;
    })
    .join(',\n    ');
  const { baseBinding, filtered } = buildWideProbeScan(w, o.start, o.end);
  const agg = `${baseBinding}\nlet _wcov = materialize(\n${filtered}
| summarize FirstTs = min(Timestamp), LastTs = max(Timestamp),
    ${aggs}
    by SignalIdPrefix
);`;
  const legs = w.columns
    .map(
      (c, i) =>
        `  (_wcov | project SignalId = strcat(SignalIdPrefix, ${kqlString(w.delim)}, ${kqlString(c)}), ` +
        `FirstTs, LastTs, Cnt = c${i}_cnt, MinV = c${i}_min, MaxV = c${i}_max, ` +
        `AvgV = iff(c${i}_cnt > 0, todouble(c${i}_sum) / c${i}_cnt, real(null)))`,
    )
    .join(',\n');
  return `${agg}\nunion\n${legs}\n| where SignalId in (${kqlStringArray(o.tagIds)})`;
}

export interface BinnedSeriesOptions {
  tagId: string;
  start: Date;
  end: Date;
  /** Bin width KQL literal, e.g. from chooseBin().kql or a fixed '1d'. */
  binKql: string;
  aggregation?: Aggregation;
  /** Linearly interpolate gaps (default true). Set false to keep nulls (e.g. calendar). */
  fill?: boolean;
  /** Connection-Profile timeseries query (see ExploreOptions.timeseriesRef). */
  timeseriesRef?: string;
}

/**
 * Plain adaptive-binned series for one signal, without the anomaly decomposition —
 * used by views (calendar rollup, horizon graph) that only need the values.
 * Returns one row: SignalId, Timestamp (dynamic array), Value (dynamic array).
 */
export function buildBinnedSeriesQuery(o: BinnedSeriesOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const fillLine = o.fill === false ? '' : `\n| extend Value = series_fill_linear(Value)`;
  const csl = `Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql} by SignalId${fillLine}
| project SignalId, Timestamp, Value`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end), undefined, {
    binKql: o.binKql,
    aggregation: o.aggregation ?? 'avg',
  });
}

export interface BinnedMultiSeriesOptions {
  tagIds: string[];
  start: Date;
  end: Date;
  /** Bin width KQL literal, e.g. from chooseBin().kql or a fixed '1d'. */
  binKql: string;
  aggregation?: Aggregation;
  /** Linearly interpolate gaps (default true). Set false to keep nulls (e.g. calendar). */
  fill?: boolean;
  /** Connection-Profile timeseries query (see ExploreOptions.timeseriesRef). */
  timeseriesRef?: string;
}

/**
 * Plain adaptive-binned series for many signals in a single query, without the
 * anomaly decomposition. `make-series ... by SignalId` returns one row per
 * signal (same shape as {@link buildBinnedSeriesQuery}), so views that would
 * otherwise fan out one query per tag (calendar rollup, horizon graph) can issue
 * a single query and split the rows with `parseExploreRows`. Signals with no
 * data in the range simply produce no row.
 */
export function buildBinnedMultiSeriesQuery(o: BinnedMultiSeriesOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const fillLine = o.fill === false ? '' : `\n| extend Value = series_fill_linear(Value)`;
  const csl = `Timeseries
| where SignalId in (${kqlStringArray(o.tagIds)})
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql} by SignalId${fillLine}
| project SignalId, Timestamp, Value`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope(o.tagIds, o.start, o.end), undefined, {
    binKql: o.binKql,
    aggregation: o.aggregation ?? 'avg',
  });
}

// --- candlestick (OHLC) ------------------------------------------------------

export interface CandlestickOptions {
  tagId: string;
  start: Date;
  end: Date;
  /** Bin width KQL literal, e.g. from chooseBin().kql or a fixed '1d'. */
  binKql: string;
  /** Connection-Profile timeseries query (see ExploreOptions.timeseriesRef). */
  timeseriesRef?: string;
}

/**
 * Per-bin OHLC (open/high/low/close) + volume for a single tag, pre-aggregated
 * to the chosen grain. Open is the earliest raw reading in the bin and Close the
 * latest (via arg_min/arg_max on Timestamp); High/Low are the extremes and
 * Volume the raw-record count. Only non-empty bins are returned (candlesticks
 * are discrete), ordered ascending by bin start. All candlestick metrics —
 * including the moving averages the client derives from Close — come from the
 * original series.
 *
 * Returns rows: Bin (datetime), Open, High, Low, Close, Volume.
 */
export function buildCandlestickQuery(o: CandlestickOptions): string {
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const csl = `Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| summarize (_openTs, Open) = arg_min(Timestamp, Value), (_closeTs, Close) = arg_max(Timestamp, Value), Low = min(Value), High = max(Value), Volume = count() by Bin = bin(Timestamp, ${o.binKql})
| project Bin, Open, High, Low, Close, Volume
| order by Bin asc`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

// --- forecasting -------------------------------------------------------------

export interface ForecastOptions {
  tagId: string;
  start: Date;
  end: Date;
  /** End of the forecast horizon: `end + horizonPoints * binSeconds`. */
  futureEnd: Date;
  binKql: string;
  /** Number of future bins to predict. */
  horizonPoints: number;
  aggregation?: Aggregation;
  /**
   * Seasonality period in bins passed to `series_decompose_forecast`. Omit (or
   * pass -1) to auto-detect, 0 to disable seasonality. Lets the Forecast page
   * apply a period discovered via `series_periods_detect`.
   */
  seasonality?: number;
  /** When set, winsorize the model input: isolated Tukey outliers (|series_outliers| >= threshold, default 1.5) are replaced by the series_decompose baseline before forecasting. Raw Value is unaffected. */
  cleanOutliers?: { threshold?: number };
  /** Connection-Profile timeseries query (see ExploreOptions.timeseriesRef). */
  timeseriesRef?: string;
}

/**
 * Adaptive-binned history plus a `series_decompose_forecast` extrapolation over
 * `horizonPoints` future bins. The series is built over the extended axis
 * (history + horizon) with the future bins left null so the forecaster fills
 * them. Returns BOTH the raw observed series (`Value`, nulls preserved so the
 * client can show real data gaps) AND the linearly-filled model input
 * (`ModelValue`) that the forecaster actually consumes; keeping them separate
 * lets the chart plot imputed spans distinctly instead of hiding gaps. Also
 * returns the in-sample residual standard deviation (`Sigma`) so the client can
 * draw a horizon-widening prediction interval, AND the full history-region
 * residual array (`Residuals`, the same slice used for `Sigma`) so the client can
 * build an empirical, asymmetric (fat-tail-aware) calibration of the band; the
 * client falls back to the normal `Sigma` path when there are too few residual
 * samples. One row keyed by canonical `SignalId`.
 *
 * The residual SD is estimated from a companion `series_decompose` that is made
 * consistent with the point model: it uses the SAME seasonality the forecast
 * used (`o.seasonality ?? -1`), an `avg` trend to MATCH the effective trend of
 * `series_decompose_forecast` (whose default Trend is `avg`, not `linefit`), and
 * `Test_points = horizonPoints` so the forecasted horizon is EXCLUDED from the
 * decomposition's fit — the residual SD therefore reflects only observed
 * history. It is a rough in-sample error estimate, NOT a backtested/validated
 * forecast error.
 */
export function buildForecastQuery(o: ForecastOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const hp = kqlInt(o.horizonPoints);
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const futureEnd = kqlDatetime(o.futureEnd);
  // Only pass the optional seasonality argument when the caller supplied one, so
  // the default behavior (auto-detect) is preserved byte-for-byte.
  const seasonalityArg = o.seasonality != null ? `, ${kqlInt(o.seasonality)}` : '';
  const cleanForecastInput = o.cleanOutliers
    ? `| extend ModelValue = series_fill_linear(Value, real(null), true)
| extend (_obl, _ose, _otr, _ore) = series_decompose(ModelValue)
| extend _okeep = series_less(series_abs(series_outliers(ModelValue)), ${kqlNum(o.cleanOutliers.threshold ?? 1.5)})
| extend ModelValue = series_add(series_multiply(ModelValue, _okeep), series_multiply(_obl, series_subtract(1.0, _okeep)))`
    : '| extend ModelValue = series_fill_linear(Value, real(null), false)';
  const csl = `Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null), Cnt = count() default = long(0) on Timestamp from ${from} to ${futureEnd} step ${o.binKql}
${cleanForecastInput}
| extend Forecast = series_decompose_forecast(ModelValue, ${hp}${seasonalityArg})
| extend (FcBaseline, FcSeasonal, FcTrend, FcResidual) = series_decompose(Forecast, ${kqlInt(o.seasonality ?? -1)}, 'avg', ${hp})
| extend _n = array_length(Forecast)
| extend Sigma = toreal(series_stats_dynamic(array_slice(FcResidual, 0, _n - ${hp} - 1)).stdev)
| project SignalId = ${kqlString(o.tagId)}, Timestamp, Value, ModelValue, Forecast, Sigma, Residuals = array_slice(FcResidual, 0, _n - ${hp} - 1), HorizonPoints = ${hp}, Cnt`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

export interface BacktestOptions {
  tagId: string;
  start: Date;
  end: Date;
  binKql: string;
  /** Horizon length in bins (H) — same as the forecast horizon. */
  horizonPoints: number;
  /** Fit-window length in bins fed to each fold's forecast (L). */
  historyPoints: number;
  /** Origin spacing in bins between folds (S). */
  foldStep: number;
  aggregation?: Aggregation;
  seasonality?: number;
  /** When set, fit each fold on a winsorized series (isolated Tukey outliers replaced by the series_decompose baseline); held-out actuals stay RAW so error measures true predictive error. */
  cleanOutliers?: { threshold?: number };
  /** Fit each fold on only the most recent `fitWindowPoints` bins (a 'recent-regime' candidate) instead of the full `historyPoints`. Fold origins and held-out actuals are unchanged, so a candidate shares the same evaluation set as the full-window baseline. Default = historyPoints (byte-identical query). */
  fitWindowPoints?: number;
  timeseriesRef?: string;
}

/**
 * TRUE rolling-origin BACKTEST of the forecast model. Unlike
 * {@link buildForecastQuery}'s in-sample residual σ, this measures GENUINE
 * out-of-sample forecast error per horizon step by repeatedly forecasting from
 * earlier origins inside the history window and comparing to the held-out
 * actuals that follow each origin.
 *
 * For each origin `o` in `range(L, _n - H, S)` the query fits the model on the
 * L bins ending at `o` (`array_slice(V, o - L, o - 1)`), forecasts H steps, and
 * scores those H predictions against the true actuals at `[o, o + H - 1]`. The
 * error is `err = actual - forecast` (signed), so downstream (B3b) can build an
 * asymmetric, bias-aware band from the empirical error distribution. Output is
 * one row per horizon step `h` (1-based) carrying `Errors` (the array of that
 * step's per-fold errors across all origins) and `Folds` (the fold count).
 *
 * Two KQL gotchas are baked into the shape below and must not be "simplified":
 *  1. `array_slice(series_decompose_forecast(...), a, b)` INLINE returns nulls
 *     inside `mv-apply`. The forecast is therefore assigned to a NAMED column
 *     (`fcArr = series_decompose_forecast(...)`) FIRST and sliced afterwards.
 *  2. Actual vs forecast are zipped via `series_subtract(actual, fcSlice)` then a
 *     SINGLE `mv-expand with_itemindex`. Multi-column `mv-expand` of two
 *     `array_slice` results silently null-fills one side, so it is avoided.
 *
 * The fit window is padded with `repeat(0.0, H)` future placeholders before
 * `series_decompose_forecast`, exactly like the point model, so the forecaster
 * extends the last L observed bins by H steps; the forecasted tail is then
 * `array_slice(fcArr, L, L + H - 1)`.
 */
export function buildBacktestQuery(o: BacktestOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const H = kqlInt(o.horizonPoints);
  const L = kqlInt(o.historyPoints);
  const fitWin = o.fitWindowPoints != null ? kqlInt(o.fitWindowPoints) : L;
  const S = kqlInt(o.foldStep);
  const seasonalityArg = o.seasonality != null ? `, ${kqlInt(o.seasonality)}` : '';
  const cleanBacktestExtra = o.cleanOutliers
    ? `
| extend (_bl, _se, _tr, _re) = series_decompose(V)
| extend _keep = series_less(series_abs(series_outliers(V)), ${kqlNum(o.cleanOutliers.threshold ?? 1.5)})
| extend Vfit = series_add(series_multiply(V, _keep), series_multiply(_bl, series_subtract(1.0, _keep)))`
    : '';
  const fitSource = o.cleanOutliers ? 'Vfit' : 'V';
  const csl = `Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series V = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql}
| extend V = series_fill_linear(V, real(null), false)${cleanBacktestExtra}
| extend _n = array_length(V)
| extend origins = range(${L}, _n - ${H}, ${S})
| mv-apply o = origins to typeof(long) on (
    project o, actual = array_slice(V, o, o + ${H} - 1),
      fcArr = series_decompose_forecast(array_concat(array_slice(${fitSource}, o - ${fitWin}, o - 1), repeat(0.0, ${H})), ${H}${seasonalityArg})
    | extend err = series_subtract(actual, array_slice(fcArr, ${fitWin}, ${fitWin} + ${H} - 1))
    | mv-expand with_itemindex = idx e = err to typeof(real)
    | project h = idx + 1, err = todouble(e)
  )
| summarize Errors = make_list(err), Folds = count() by h
| order by h asc
| project SignalId = ${kqlString(o.tagId)}, h, Errors, Folds`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

// --- 1-D similarity search ---------------------------------------------------

export interface Similarity1dOptions {
  queryId?: string;
  queryTagId: string;
  queryStart: Date;
  queryEnd: Date;
  searchTagIds: string[];
  searchStart: Date;
  searchEnd: Date;
  binKql: string;
  queryLengthSymbols: number;
  alphabetSize: number;
  minScale: number;
  maxScale: number;
  scaleSteps: number;
  symbolTolerance: number;
  topK: number;
  znormThreshold: number;
  /**
   * Connection-Profile timeseries query (see ExploreOptions.timeseriesRef).
   * Bound as `let Timeseries = (…)` and passed as the canonical (SignalId,
   * Timestamp, Value) tabular argument to app_extract_segment / app_search_space.
   */
  timeseriesRef?: string;
}

/**
 * Compose app_extract_segment (query) + app_search_space (search space) and feed
 * them to sax_similarity_search_1d.
 */
export function buildSimilarity1dQuery(o: Similarity1dOptions): string {
  const queryId = kqlString(o.queryId ?? o.queryTagId);
  const csl = `let Query = app_extract_segment(Timeseries, ${kqlString(o.queryTagId)}, ${kqlDatetime(o.queryStart)}, ${kqlDatetime(o.queryEnd)}, ${o.binKql})
    | project query_id = ${queryId}, series;
let SearchSpace = app_search_space(Timeseries, ${kqlStringArray(o.searchTagIds)}, ${kqlDatetime(o.searchStart)}, ${kqlDatetime(o.searchEnd)}, ${o.binKql});
sax_similarity_search_1d(Query, SearchSpace, ${kqlInt(o.queryLengthSymbols)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.minScale)}, ${kqlNum(o.maxScale)}, ${kqlInt(o.scaleSteps)}, ${kqlInt(o.symbolTolerance)}, ${kqlInt(o.topK)}, ${kqlNum(o.znormThreshold)})`;
  return withTimeseriesRef(
    csl,
    o.timeseriesRef,
    tsScope2([o.queryTagId, ...o.searchTagIds], o.queryStart, o.queryEnd, o.searchStart, o.searchEnd),
  );
}

/**
 * Fetch the raw (binned, gap-filled) sample array for the query pattern — the
 * exact series the similarity search encodes. One row: (series_id, series).
 */
export function buildSegmentSeriesQuery(o: {
  tagId: string;
  start: Date;
  end: Date;
  binKql: string;
  timeseriesRef?: string;
}): string {
  const csl = `app_extract_segment(Timeseries, ${kqlString(o.tagId)}, ${kqlDatetime(o.start)}, ${kqlDatetime(o.end)}, ${o.binKql})
    | project series_id, series`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

/**
 * Descriptive profile for a single signal, computed server-side by the
 * `app_signal_profile` stored function (count/min/max/mean/stdev/max rate).
 * Powers the SignalMetadata "suggest from data" envelope without pulling the raw
 * series to the browser. One row: SignalId, Count, Min, Max, Mean, Stdev,
 * MaxAbsStep, MaxRatePerMin.
 */
export function buildSignalProfileQuery(o: {
  tagId: string;
  start: Date;
  end: Date;
  binKql: string;
  timeseriesRef?: string;
}): string {
  const csl = `app_signal_profile(Timeseries, ${kqlString(o.tagId)}, ${kqlDatetime(o.start)}, ${kqlDatetime(o.end)}, ${o.binKql})`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

/**
 * Fetch the full (binned, gap-filled) sample array for every search-space tag —
 * the exact series the matches index into. One row per tag: (series_id, series).
 * Matched subsequences are sliced client-side using each match's start/end index.
 */
export function buildSearchSpaceSeriesQuery(o: {
  tagIds: string[];
  start: Date;
  end: Date;
  binKql: string;
  timeseriesRef?: string;
}): string {
  const csl = `app_search_space(Timeseries, ${kqlStringArray(o.tagIds)}, ${kqlDatetime(o.start)}, ${kqlDatetime(o.end)}, ${o.binKql})
    | project series_id, series`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope(o.tagIds, o.start, o.end));
}

// --- discord / anomaly discovery --------------------------------------------

export interface DiscordsOptions {
  tagIds: string[];
  start: Date;
  end: Date;
  binKql: string;
  windowSize: number;
  numDiscords: number;
  paaSize: number;
  alphabetSize: number;
  znormThreshold: number;
  candidateLimit: number;
  /**
   * Most-recent bins to confine discord candidates to (novelty detection: recent
   * windows scored against the preceding history only). Omitted or <= 0 scans the
   * whole range (explore mode). Must be >= windowSize for any candidate to exist.
   */
  detectionWindowBins?: number;
  /**
   * Connection-Profile timeseries query. Bound as `let Timeseries = (…)` and
   * passed as the canonical tabular argument to app_search_space.
   */
  timeseriesRef?: string;
}

export function buildDiscordsQuery(o: DiscordsOptions): string {
  const csl = `let SeriesTable = app_search_space(Timeseries, ${kqlStringArray(o.tagIds)}, ${kqlDatetime(o.start)}, ${kqlDatetime(o.end)}, ${o.binKql});
sax_discords(SeriesTable, ${kqlInt(o.windowSize)}, ${kqlInt(o.numDiscords)}, ${kqlInt(o.paaSize)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.znormThreshold)}, ${kqlInt(o.candidateLimit)}, ${kqlInt(o.detectionWindowBins ?? 0)})`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope(o.tagIds, o.start, o.end));
}

// --- multivariate (multidim) similarity search ------------------------------

export interface MultidimOptions {
  /** Entity (a hierarchy node value at `entityLevel`) whose tracks (Metrics) form the query template. */
  queryEntity: string;
  queryStart: Date;
  queryEnd: Date;
  searchStart: Date;
  searchEnd: Date;
  binKql: string;
  aggregation?: Aggregation;
  queryLengthSymbols: number;
  alphabetSize: number;
  minScale: number;
  maxScale: number;
  scaleSteps: number;
  symbolTolerance: number;
  maxInterTrackDelay: number;
  perTrackTopK: number;
  topK: number;
  znormThreshold: number;
  /**
   * Canonical hierarchy level whose values identify an entity (default Level4).
   * Must be one of Level1..Level10.
   */
  entityLevel?: string;
  /** Connection-Profile timeseries query (see ExploreOptions.timeseriesRef). */
  timeseriesRef?: string;
  /** Connection-Profile hierarchy query (defaults to the active profile's). */
  hierarchyRef?: string;
  /** Connection-Profile metadata query (defaults to the active profile's). */
  metadataRef?: string;
}

/**
 * Compose a per-entity query template and an all-entity search space (mapping
 * entity_id = the configured hierarchy level, track_id = MetricName) and feed
 * them to sax_similarity_search_multidim. The entity/track dimension is derived
 * from the active Connection Profile's canonical Hierarchy + Metadata queries
 * (SignalId, Level1..Level10, MetricName). The same bin width is used for both
 * sides so their sample axes align, mirroring the 1-D builder.
 */
export function buildMultidimQuery(o: MultidimOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const qs = kqlDatetime(o.queryStart);
  const qe = kqlDatetime(o.queryEnd);
  const ss = kqlDatetime(o.searchStart);
  const se = kqlDatetime(o.searchEnd);
  const entityCol = entityLevelColumn(o.entityLevel);
  const csl = `${dimensionBindings(o.hierarchyRef, o.metadataRef)}let SignalDim = Hierarchy
    | join kind=inner (Metadata | project SignalId, MetricName) on SignalId
    | project SignalId, Entity = ${entityCol}, MetricName;
let QueryTracks = Timeseries
    | where Timestamp between (${qs} .. ${qe})
    | lookup kind=inner SignalDim on SignalId
    | where Entity == ${kqlString(o.queryEntity)}
    | make-series series = ${agg} default = real(null) on Timestamp from ${qs} to ${qe} step ${o.binKql} by MetricName
    | extend series = series_fill_linear(series)
    | project query_id = ${kqlString(o.queryEntity)}, track_id = MetricName, series;
let SearchTracks = Timeseries
    | where Timestamp between (${ss} .. ${se})
    | lookup kind=inner SignalDim on SignalId
    | make-series series = ${agg} default = real(null) on Timestamp from ${ss} to ${se} step ${o.binKql} by Entity, MetricName
    | extend series = series_fill_linear(series)
    | project entity_id = Entity, track_id = MetricName, series;
sax_similarity_search_multidim(QueryTracks, SearchTracks, ${kqlInt(o.queryLengthSymbols)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.minScale)}, ${kqlNum(o.maxScale)}, ${kqlInt(o.scaleSteps)}, ${kqlInt(o.symbolTolerance)}, ${kqlInt(o.maxInterTrackDelay)}, ${kqlInt(o.perTrackTopK)}, ${kqlInt(o.topK)}, ${kqlNum(o.znormThreshold)})`;
  // No TimeseriesScope: SearchTracks scans every entity's tracks, so there is no
  // bounded, user-selected signal set — incompatible with wide profiles by design
  // (withTimeseriesRef throws), the guardrail against whole-catalog analyses.
  // This builder is currently unused by the pages.
  return withTimeseriesRef(csl, o.timeseriesRef);
}

export interface MultidimSearchSeriesOptions {
  /** Entity values (at `entityLevel`) whose tracks to fetch — typically the entities that appear in matches. */
  entities: string[];
  /** Metrics (track_id) to fetch — typically the tracks that appear in matches. */
  metrics: string[];
  searchStart: Date;
  searchEnd: Date;
  binKql: string;
  aggregation?: Aggregation;
  /** Canonical hierarchy level whose values identify an entity (default Level4). */
  entityLevel?: string;
  timeseriesRef?: string;
  hierarchyRef?: string;
  metadataRef?: string;
}

/**
 * Fetch the full (binned, gap-filled) sample array for every (entity, Metric)
 * track over the search window — the exact series the multivariate matches index
 * into. Returns one row per track: (entity_id, track_id = MetricName, series).
 *
 * The make-series bounds (from/to/step), aggregation, and linear fill mirror the
 * SearchTracks binding inside `buildMultidimQuery`, so a match's start/end index
 * lines up sample-for-sample with these arrays and can be sliced client-side.
 */
export function buildMultidimSearchSeriesQuery(o: MultidimSearchSeriesOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const ss = kqlDatetime(o.searchStart);
  const se = kqlDatetime(o.searchEnd);
  const entityCol = entityLevelColumn(o.entityLevel);
  const csl = `${dimensionBindings(o.hierarchyRef, o.metadataRef)}let SignalDim = Hierarchy
    | join kind=inner (Metadata | project SignalId, MetricName) on SignalId
    | project SignalId, Entity = ${entityCol}, MetricName;
Timeseries
    | where Timestamp between (${ss} .. ${se})
    | lookup kind=inner SignalDim on SignalId
    | where Entity in (${kqlStringArray(o.entities)}) and MetricName in (${kqlStringArray(o.metrics)})
    | make-series series = ${agg} default = real(null) on Timestamp from ${ss} to ${se} step ${o.binKql} by Entity, MetricName
    | extend series = series_fill_linear(series)
    | project entity_id = Entity, track_id = MetricName, series`;
  // No TimeseriesScope: keyed by entity/metric rather than an explicit signal set,
  // so it is incompatible with wide profiles by design (companion fetch for the
  // unused whole-catalog multidim search).
  return withTimeseriesRef(csl, o.timeseriesRef);
}

export interface MultiSeriesSimilarityOptions {
  /** Query tags whose combined shape forms the multivariate pattern. Each tag = one track. */
  queryTagIds: string[];
  queryStart: Date;
  queryEnd: Date;
  searchStart: Date;
  searchEnd: Date;
  binKql: string;
  queryLengthSymbols: number;
  alphabetSize: number;
  minScale: number;
  maxScale: number;
  scaleSteps: number;
  symbolTolerance: number;
  maxInterTrackDelay: number;
  perTrackTopK: number;
  topK: number;
  znormThreshold: number;
  /**
   * Connection-Profile timeseries query. Bound as `let Timeseries = (…)` and
   * passed as the canonical tabular argument to app_search_space.
   */
  timeseriesRef?: string;
}

const MULTI_SERIES_QUERY_ID = 'query';
const MULTI_SERIES_ENTITY_ID = 'search';

/**
 * Multi-time-series (temporal recurrence) similarity search: the user hand-picks
 * a set of query tags whose combined shape forms a multivariate pattern, and we
 * search the SAME set of tags over the (wider) search window for where that
 * combined pattern recurs. Each tag maps to one track; the whole search window is
 * treated as a single synthetic entity, so the multidim search slides windows over
 * that entity's tracks. The same bin width is used for query and search so their
 * sample axes align, mirroring the 1-D builder.
 */
export function buildMultiSeriesSimilarityQuery(o: MultiSeriesSimilarityOptions): string {
  const csl = `let QueryTracks = app_search_space(Timeseries, ${kqlStringArray(o.queryTagIds)}, ${kqlDatetime(o.queryStart)}, ${kqlDatetime(o.queryEnd)}, ${o.binKql})
    | project query_id = ${kqlString(MULTI_SERIES_QUERY_ID)}, track_id = series_id, series;
let SearchTracks = app_search_space(Timeseries, ${kqlStringArray(o.queryTagIds)}, ${kqlDatetime(o.searchStart)}, ${kqlDatetime(o.searchEnd)}, ${o.binKql})
    | project entity_id = ${kqlString(MULTI_SERIES_ENTITY_ID)}, track_id = series_id, series;
sax_similarity_search_multidim(QueryTracks, SearchTracks, ${kqlInt(o.queryLengthSymbols)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.minScale)}, ${kqlNum(o.maxScale)}, ${kqlInt(o.scaleSteps)}, ${kqlInt(o.symbolTolerance)}, ${kqlInt(o.maxInterTrackDelay)}, ${kqlInt(o.perTrackTopK)}, ${kqlInt(o.topK)}, ${kqlNum(o.znormThreshold)})`;
  return withTimeseriesRef(
    csl,
    o.timeseriesRef,
    tsScope2(o.queryTagIds, o.queryStart, o.queryEnd, o.searchStart, o.searchEnd),
  );
}

/**
 * One explicit query-tag → search-tag mapping for the mapped multivariate mode.
 * `trackId` is a synthetic label shared by both sides so the multidim search
 * (which pairs QueryTracks and SearchTracks by `track_id`) compares the query
 * tag's shape against the mapped search tag's series.
 */
export interface TagTrackMapping {
  trackId: string;
  queryTagId: string;
  searchTagId: string;
}

export interface MappedMultiSeriesSimilarityOptions {
  /** Explicit query-tag → search-tag mappings. Each mapping = one track. */
  mappings: TagTrackMapping[];
  queryStart: Date;
  queryEnd: Date;
  searchStart: Date;
  searchEnd: Date;
  binKql: string;
  queryLengthSymbols: number;
  alphabetSize: number;
  minScale: number;
  maxScale: number;
  scaleSteps: number;
  symbolTolerance: number;
  maxInterTrackDelay: number;
  perTrackTopK: number;
  topK: number;
  znormThreshold: number;
  /**
   * Connection-Profile timeseries query. Bound as `let Timeseries = (…)` and
   * passed as the canonical tabular argument to app_search_space.
   */
  timeseriesRef?: string;
}

/** A KQL datatable(series_id, track_id) mapping tag ids onto synthetic track ids. */
function trackMapDatatable(rows: { tagId: string; trackId: string }[]): string {
  const body = rows.map((r) => `    ${kqlString(r.tagId)}, ${kqlString(r.trackId)}`).join(',\n');
  return `datatable(series_id:string, track_id:string) [\n${body}\n]`;
}

/**
 * Mapped multivariate similarity search: the user explicitly maps each query tag
 * to a (typically different) search-space tag — letting a pattern found on one
 * asset be located on another. Each mapping becomes a track sharing a synthetic
 * `track_id`; the query tag defines the shape and the mapped search tag is scanned
 * for it. A datatable remaps each side's `series_id` onto the shared track id so
 * `sax_similarity_search_multidim` pairs the intended query/search tracks. The same
 * bin width is used for query and search so their sample axes align.
 */
export function buildMappedMultiSeriesSimilarityQuery(
  o: MappedMultiSeriesSimilarityOptions,
): string {
  const queryTagIds = o.mappings.map((m) => m.queryTagId);
  const searchTagIds = o.mappings.map((m) => m.searchTagId);
  const queryMap = trackMapDatatable(
    o.mappings.map((m) => ({ tagId: m.queryTagId, trackId: m.trackId })),
  );
  const searchMap = trackMapDatatable(
    o.mappings.map((m) => ({ tagId: m.searchTagId, trackId: m.trackId })),
  );
  const csl = `let QueryMap = ${queryMap};
let SearchMap = ${searchMap};
let QueryTracks = app_search_space(Timeseries, ${kqlStringArray(queryTagIds)}, ${kqlDatetime(o.queryStart)}, ${kqlDatetime(o.queryEnd)}, ${o.binKql})
    | join kind=inner QueryMap on series_id
    | project query_id = ${kqlString(MULTI_SERIES_QUERY_ID)}, track_id, series;
let SearchTracks = app_search_space(Timeseries, ${kqlStringArray(searchTagIds)}, ${kqlDatetime(o.searchStart)}, ${kqlDatetime(o.searchEnd)}, ${o.binKql})
    | join kind=inner SearchMap on series_id
    | project entity_id = ${kqlString(MULTI_SERIES_ENTITY_ID)}, track_id, series;
sax_similarity_search_multidim(QueryTracks, SearchTracks, ${kqlInt(o.queryLengthSymbols)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.minScale)}, ${kqlNum(o.maxScale)}, ${kqlInt(o.scaleSteps)}, ${kqlInt(o.symbolTolerance)}, ${kqlInt(o.maxInterTrackDelay)}, ${kqlInt(o.perTrackTopK)}, ${kqlInt(o.topK)}, ${kqlNum(o.znormThreshold)})`;
  return withTimeseriesRef(
    csl,
    o.timeseriesRef,
    tsScope2([...queryTagIds, ...searchTagIds], o.queryStart, o.queryEnd, o.searchStart, o.searchEnd),
  );
}

/**
 * Fetch the raw (binned, gap-filled) sample array for a set of tags, projected
 * under a synthetic `series_id = track_id` so mapped-mode viz maps track id →
 * series (mirroring buildSearchSpaceSeriesQuery, but for query/search tags that
 * carry a shared synthetic track id rather than their own tag id).
 */
export function buildMappedSeriesQuery(o: {
  pairs: { tagId: string; trackId: string }[];
  start: Date;
  end: Date;
  binKql: string;
  timeseriesRef?: string;
}): string {
  const tagIds = o.pairs.map((p) => p.tagId);
  const map = trackMapDatatable(o.pairs);
  const csl = `let TrackMap = ${map};
app_search_space(Timeseries, ${kqlStringArray(tagIds)}, ${kqlDatetime(o.start)}, ${kqlDatetime(o.end)}, ${o.binKql})
    | join kind=inner TrackMap on series_id
    | project series_id = track_id, series`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope(tagIds, o.start, o.end));
}

// --- SAX-VSM classification --------------------------------------------------

export interface VsmTerm {
  class_label: string;
  word: string;
  weight: number;
}

/** Materialize model terms (read back from Rayfin SQL) into an inline datatable. */
export function buildVsmModelDatatable(terms: VsmTerm[]): string {
  const rows = terms
    .map((t) => `    ${kqlString(t.class_label)}, ${kqlString(t.word)}, real(${kqlNum(t.weight)})`)
    .join(',\n');
  return `datatable(class_label:string, word:string, weight:real)[\n${rows}\n]`;
}

export interface VsmClassifyOptions {
  terms: VsmTerm[];
  inputSeriesId?: string;
  inputTagId: string;
  start: Date;
  end: Date;
  binKql: string;
  windowSize: number;
  paaSize: number;
  alphabetSize: number;
  znormThreshold: number;
  numerosityReduction: string;
  topWords: number;
  /** Connection-Profile timeseries query, bound and passed to app_extract_segment. */
  timeseriesRef?: string;
}

/**
 * Classify an input series against a persisted SAX-VSM model. The model is
 * passed inline as a datatable literal — no Eventhouse-side model table needed.
 */
export function buildVsmClassifyQuery(o: VsmClassifyOptions): string {
  const inputId = kqlString(o.inputSeriesId ?? o.inputTagId);
  const csl = `let Model = ${buildVsmModelDatatable(o.terms)};
let Input = app_extract_segment(Timeseries, ${kqlString(o.inputTagId)}, ${kqlDatetime(o.start)}, ${kqlDatetime(o.end)}, ${o.binKql})
    | project series_id = ${inputId}, series;
sax_vsm_classify(Model, Input, ${kqlInt(o.windowSize)}, ${kqlInt(o.paaSize)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.znormThreshold)}, ${kqlString(o.numerosityReduction)}, ${kqlInt(o.topWords)})`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.inputTagId], o.start, o.end));
}

// --- SAX-VSM training --------------------------------------------------------

export interface VsmTrainingExample {
  classLabel: string;
  tagId: string;
  start: Date;
  end: Date;
}

/**
 * Build a Training table expression (class_label, series_id, series) from a set
 * of labeled segments, as a union of app_extract_segment projections. Feeds the
 * `trainingTableExpr` argument of buildVsmTrainQuery.
 */
export function buildVsmTrainingTableExpr(examples: VsmTrainingExample[], binKql: string): string {
  const parts = examples.map(
    (ex, i) =>
      `(app_extract_segment(Timeseries, ${kqlString(ex.tagId)}, ${kqlDatetime(ex.start)}, ${kqlDatetime(ex.end)}, ${binKql})
    | project class_label = ${kqlString(ex.classLabel)}, series_id = ${kqlString(`${ex.classLabel}#${i}`)}, series)`,
  );
  return `union\n${parts.join(',\n')}`;
}

/**
 * Derive the {@link TimeseriesScope} covering a set of SAX-VSM training examples:
 * the distinct tag ids and the min/max window across all examples. Pass the
 * result as `VsmTrainOptions.scope` so wide-table profiles can build the
 * query-time unpivot for the `app_extract_segment` calls in the training table.
 */
export function vsmTrainingScope(examples: VsmTrainingExample[]): TimeseriesScope {
  const signalIds = [...new Set(examples.map((e) => e.tagId))];
  let start = examples[0]?.start ?? new Date(0);
  let end = examples[0]?.end ?? new Date(0);
  for (const e of examples) {
    if (e.start.getTime() < start.getTime()) start = e.start;
    if (e.end.getTime() > end.getTime()) end = e.end;
  }
  return { signalIds, start, end };
}

export interface VsmTrainOptions {
  /** (class_label, series_id) pairs with the range for each training series. */
  windowSize: number;
  paaSize: number;
  alphabetSize: number;
  znormThreshold: number;
  numerosityReduction: string;
  dropTermsInAllClasses: boolean;
  /** Pre-built Training table expression producing (class_label, series_id, series). */
  trainingTableExpr: string;
  /**
   * In-scope signals + window covering all training examples. Required for wide
   * profiles so the query-time unpivot knows which value columns to expand;
   * narrow profiles ignore it. Derive it from the same VsmTrainingExample[] used
   * to build `trainingTableExpr` (see {@link vsmTrainingScope}).
   */
  scope?: TimeseriesScope;
  /**
   * Connection-Profile timeseries query. Bound as `let Timeseries = (…)` so the
   * app_extract_segment calls inside `trainingTableExpr` resolve against the
   * profile's canonical (SignalId, Timestamp, Value) source.
   */
  timeseriesRef?: string;
}

/**
 * Train a SAX-VSM model. `trainingTableExpr` must be a KQL expression yielding
 * rows (class_label:string, series_id:string, series:dynamic) — build it from
 * labeled segments (e.g. via app_extract_segment unions). Returned rows
 * (class_label, word, weight, ...) are then persisted to Rayfin SQL.
 */
export function buildVsmTrainQuery(o: VsmTrainOptions): string {
  const csl = `let Training = ${o.trainingTableExpr};
sax_vsm_train(Training, ${kqlInt(o.windowSize)}, ${kqlInt(o.paaSize)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.znormThreshold)}, ${kqlString(o.numerosityReduction)}, ${o.dropTermsInAllClasses ? 'true' : 'false'})`;
  return withTimeseriesRef(csl, o.timeseriesRef, o.scope);
}

// --- regression and sensitivity analysis ------------------------------------

export interface CorrelationMatrixOptions {
  tagIds: string[];
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  timeseriesRef?: string;
}

/**
 * Compute pairwise Pearson correlation between all tag pairs. Returns upper
 * triangle of the correlation matrix: (TagA, TagB, Correlation) rows.
 */
export function buildCorrelationMatrixQuery(opts: CorrelationMatrixOptions): string {
  const agg = AGG_EXPR[opts.aggregation ?? 'avg'];
  const from = kqlDatetime(opts.start);
  const to = kqlDatetime(opts.end);
  const csl = `let Data = Timeseries
| where SignalId in (${kqlStringArray(opts.tagIds)})
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${opts.binKql} by SignalId
| extend Value = series_fill_linear(Value), _k = 1;
Data
| join kind=inner (Data) on _k
| where strcmp(SignalId, SignalId1) < 0
| project TagA = SignalId, TagB = SignalId1, Correlation = series_pearson_correlation(Value, Value1)
| order by TagA asc, TagB asc`;
  return withTimeseriesRef(csl, opts.timeseriesRef, tsScope(opts.tagIds, opts.start, opts.end));
}

export interface RegressionOptions {
  targetTagId: string;
  featureTagIds: string[];
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  /** Polynomial degree (1=linear, 2=quadratic, etc). Default 1. */
  degree?: number;
  timeseriesRef?: string;
}

/**
 * Fit a regression: target ~ feature. For each feature, computes an ordinary
 * least-squares fit of the target on that feature (KQL lacks native multivariate
 * regression, so multivariate is handled as a set of univariate fits ranked by R²).
 *
 * KQL's `series_fit_line` only fits a series against its ordinal index (a single
 * argument), so it cannot regress one series on another. Instead we derive the
 * slope/intercept from the series' first and second moments:
 *   slope     = cov(X, Y) / var(X)
 *   intercept = mean(Y) - slope * mean(X)
 *   R²        = corr(X, Y)²
 * and build the fitted line as X * slope + intercept.
 *
 * Returns: TargetTagId, FeatureTagId, RSq, Slope, Intercept, Variance, RVariance,
 * Timestamp (aligned axis), TargetSeries, FittedSeries. Rows are ordered by RSq
 * descending (then FeatureTagId) so the feature ranking is deterministic across
 * runs — a bare `union` leaves row order unspecified, which otherwise makes the
 * displayed coefficients appear to shuffle on each re-run of the same inputs.
 */
export function buildRegressionQuery(opts: RegressionOptions): string {
  const agg = AGG_EXPR[opts.aggregation ?? 'avg'];
  const from = kqlDatetime(opts.start);
  const to = kqlDatetime(opts.end);
  
  // Build aligned dataset (target + all features).
  let csl = `let Data = Timeseries
| where SignalId in (${kqlStringArray([opts.targetTagId, ...opts.featureTagIds])})
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${opts.binKql} by SignalId
| extend Value = series_fill_linear(Value);
let Target = Data | where SignalId == ${kqlString(opts.targetTagId)} | project Timestamp, TargetSeries = Value, _k = 1;
`;

  // For each feature, regress TargetSeries on FeatureSeries via series moments.
  const featureJoins = opts.featureTagIds.map((fid, i) => {
    return `let F${i} = Data | where SignalId == ${kqlString(fid)}
    | project FeatureSeries${i} = Value, _k = 1;
let Fit${i} = Target
    | join kind=inner (F${i}) on _k
    | project Timestamp, TargetSeries, FeatureSeries = FeatureSeries${i}
    | extend _meanX = todouble(series_stats_dynamic(FeatureSeries).avg), _meanY = todouble(series_stats_dynamic(TargetSeries).avg)
    | extend _sdX = todouble(series_stats_dynamic(FeatureSeries).stdev), _sdY = todouble(series_stats_dynamic(TargetSeries).stdev)
    | extend _meanXY = todouble(series_stats_dynamic(series_multiply(FeatureSeries, TargetSeries)).avg)
    | extend _cov = _meanXY - _meanX * _meanY
    | extend _corr = todouble(series_pearson_correlation(FeatureSeries, TargetSeries))
    | extend Slope = iff(_sdX == 0.0, real(0), _cov / (_sdX * _sdX)), RSq = _corr * _corr, Variance = _sdY * _sdY
    | extend Intercept = _meanY - Slope * _meanX
    | extend RVariance = Variance * (1.0 - RSq)
    | extend FittedSeries = series_add(series_multiply(FeatureSeries, Slope), Intercept)
    | project TargetTagId = ${kqlString(opts.targetTagId)}, FeatureTagId = ${kqlString(fid)}, RSq = toreal(RSq), Slope = toreal(Slope), Intercept = toreal(Intercept), Variance = toreal(Variance), RVariance = toreal(RVariance), Timestamp, TargetSeries, FittedSeries;
`;
  });

  csl += featureJoins.join('\n');
  csl += `union ${opts.featureTagIds.map((_, i) => `Fit${i}`).join(', ')}
| order by RSq desc, FeatureTagId asc`;

  return withTimeseriesRef(
    csl,
    opts.timeseriesRef,
    tsScope([opts.targetTagId, ...opts.featureTagIds], opts.start, opts.end),
  );
}

export interface SensitivityOptions {
  targetTagId: string;
  featureTagIds: string[];
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  timeseriesRef?: string;
}

/**
 * Feature importance via individual R² (univariate regression) for ranking.
 * Returns: FeatureTagId, RSq, Slope, Intercept — one row per feature, sorted
 * descending by RSq.
 */
export function buildSensitivityQuery(opts: SensitivityOptions): string {
  const agg = AGG_EXPR[opts.aggregation ?? 'avg'];
  const from = kqlDatetime(opts.start);
  const to = kqlDatetime(opts.end);
  
  let csl = `let Data = Timeseries
| where SignalId in (${kqlStringArray([opts.targetTagId, ...opts.featureTagIds])})
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${opts.binKql} by SignalId
| extend Value = series_fill_linear(Value);
let Target = Data | where SignalId == ${kqlString(opts.targetTagId)} | project Timestamp, TargetSeries = Value, _k = 1;
`;

  // For each feature, regress the target on that feature and project R², slope, intercept.
  const featureFits = opts.featureTagIds.map((fid, i) => {
    return `let F${i} = Data | where SignalId == ${kqlString(fid)}
    | project FeatureSeries${i} = Value, _k = 1;
let Rank${i} = Target
    | join kind=inner (F${i}) on _k
    | project TargetSeries, FeatureSeries = FeatureSeries${i}
    | extend _meanX = todouble(series_stats_dynamic(FeatureSeries).avg), _meanY = todouble(series_stats_dynamic(TargetSeries).avg)
    | extend _sdX = todouble(series_stats_dynamic(FeatureSeries).stdev)
    | extend _meanXY = todouble(series_stats_dynamic(series_multiply(FeatureSeries, TargetSeries)).avg)
    | extend _cov = _meanXY - _meanX * _meanY
    | extend _corr = todouble(series_pearson_correlation(FeatureSeries, TargetSeries))
    | extend Slope = iff(_sdX == 0.0, real(0), _cov / (_sdX * _sdX)), RSq = _corr * _corr
    | extend Intercept = _meanY - Slope * _meanX
    | project FeatureTagId = ${kqlString(fid)}, RSq = toreal(RSq), Slope = toreal(Slope), Intercept = toreal(Intercept);
`;
  });

  csl += featureFits.join('\n');
  csl += `union ${opts.featureTagIds.map((_, i) => `Rank${i}`).join(', ')}
| order by RSq desc, FeatureTagId asc`;

  return withTimeseriesRef(
    csl,
    opts.timeseriesRef,
    tsScope([opts.targetTagId, ...opts.featureTagIds], opts.start, opts.end),
  );
}

// --- root cause: aligned multi-signal series --------------------------------

export interface AlignedSeriesOptions {
  tagIds: string[];
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  timeseriesRef?: string;
}

/**
 * Fetch several signals on a single common, gap-filled time grid. Returns one
 * row per signal: (SignalId, Timestamp[], Value[]). Used by root-cause analysis to
 * compute lagged cross-correlation between a target and candidate drivers on the
 * client, where arbitrary lags are simpler and cheaper than in KQL.
 */
export function buildAlignedSeriesQuery(opts: AlignedSeriesOptions): string {
  const agg = AGG_EXPR[opts.aggregation ?? 'avg'];
  const from = kqlDatetime(opts.start);
  const to = kqlDatetime(opts.end);
  const csl = `Timeseries
| where SignalId in (${kqlStringArray(opts.tagIds)})
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${opts.binKql} by SignalId
| extend Value = series_fill_linear(Value)`;
  return withTimeseriesRef(csl, opts.timeseriesRef, tsScope(opts.tagIds, opts.start, opts.end));
}

// --- anomaly diagnosis (series_decompose_anomalies -> diffpatterns) ----------

export interface AnomalyDiagnosisOptions {
  /** Target signal whose anomalous bins we explain. */
  targetTagId: string;
  /** Candidate driver signals; each becomes a discrete regime dimension. */
  candidateTagIds: string[];
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  /** series_decompose_anomalies sensitivity (lower = more sensitive). Default 1.5. */
  sensitivity?: number;
  timeseriesRef?: string;
}

/**
 * Diagnose which operating regimes of candidate driver signals differentiate a
 * target signal's *anomalous* time bins from its *normal* ones.
 *
 * The target is flagged bin-by-bin with `series_decompose_anomalies` (label
 * 'anomalous' / 'normal'). Each candidate driver is discretized per bin into a
 * 'low' / 'normal' / 'high' regime relative to its own mean ± ½·σ over the
 * window. The per-bin label and candidate regimes are joined into one wide
 * table and fed to the `diffpatterns` plugin, which returns the regime
 * combinations most over-represented in anomalous bins.
 *
 * Candidate columns are builder-generated static names (Cand0..CandN) so the
 * client can map them back to tag ids by index; only the tag literals and the
 * numeric sensitivity are interpolated, all through the injection guards.
 */
export function buildAnomalyDiagnosisQuery(o: AnomalyDiagnosisOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const sensitivity = kqlNum(o.sensitivity ?? 1.5);

  const target = `let _Target = (
Timeseries
| where SignalId == ${kqlString(o.targetTagId)}
| where Timestamp between (${from} .. ${to})
| make-series V = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql}
| extend V = series_fill_linear(V)
| extend (Flags, Score, Base) = series_decompose_anomalies(V, ${sensitivity}, -1, 'linefit')
| mv-expand Timestamp to typeof(datetime), Flags to typeof(long)
| extend Label = iff(Flags != 0, 'anomalous', 'normal')
| project Timestamp, Label
);`;

  const candBindings = o.candidateTagIds
    .map(
      (tagId, i) => `let _Cand${i} = (
Timeseries
| where SignalId == ${kqlString(tagId)}
| where Timestamp between (${from} .. ${to})
| make-series V = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql}
| extend V = series_fill_linear(V)
| extend (Cmin, CminIdx, Cmax, CmaxIdx, Cavg, Cstdev, Cvar) = series_stats(V)
| mv-expand Timestamp to typeof(datetime), V to typeof(real)
| extend Cand${i} = case(V > Cavg + 0.5 * Cstdev, 'high', V < Cavg - 0.5 * Cstdev, 'low', 'normal')
| project Timestamp, Cand${i}
);`,
    )
    .join('\n');

  const joins = o.candidateTagIds.map((_, i) => `| join kind=inner (_Cand${i}) on Timestamp`).join('\n');
  const projectCols = ['Label', ...o.candidateTagIds.map((_, i) => `Cand${i}`)].join(', ');

  const csl = `${target}
${candBindings}
_Target
${joins}
| project ${projectCols}
| evaluate diffpatterns(Label, 'anomalous', 'normal')`;
  return withTimeseriesRef(
    csl,
    o.timeseriesRef,
    tsScope([o.targetTagId, ...o.candidateTagIds], o.start, o.end),
  );
}

// --- process mining (threshold states + scan operator) ----------------------

export interface ProcessMiningOptions {
  /** Signal whose values are discretized into operating states. */
  tagId: string;
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  /** Ascending cut points; N thresholds produce N+1 bands. */
  thresholds: number[];
  /**
   * Band labels, lowest to highest. Must contain exactly `thresholds.length + 1`
   * entries (one more label than thresholds).
   */
  bandLabels: string[];
  timeseriesRef?: string;
}

/**
 * Derive discrete operating states from a signal's value thresholds and collapse
 * consecutive same-state bins into episodes using the KQL `scan` operator.
 *
 * Each bin is classified into one of `bandLabels` relative to the ascending
 * `thresholds`: N thresholds define N+1 half-open bands, where each threshold is
 * the inclusive lower bound of the band above it (band k covers
 * `[thresholds[k-1], thresholds[k])`, the lowest band is everything below
 * `thresholds[0]`). This generalizes the classic low / normal / high setup to
 * any number of operating modes (e.g. off / idle / run / overload).
 *
 * `scan` walks the time-ordered bins maintaining a segment id that increments
 * whenever the state changes (the same fill-forward technique the Learn docs
 * use), so consecutive bins of one state share a SegId. The result is one row
 * per episode (SegId, State, StartTime, EndTime, Bins) which the client turns
 * into a state timeline and mines for recurring sequences.
 *
 * Only the tag literal, the numeric thresholds, and the band labels are
 * interpolated, all through the injection guards.
 */
export function buildProcessMiningQuery(o: ProcessMiningOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const thresholds = o.thresholds ?? [];
  const labels = o.bandLabels ?? [];
  if (labels.length < 2) {
    throw new Error('buildProcessMiningQuery: at least two bands (one threshold) are required.');
  }
  if (labels.length !== thresholds.length + 1) {
    throw new Error('buildProcessMiningQuery: bandLabels length must equal thresholds length + 1.');
  }
  for (let i = 1; i < thresholds.length; i++) {
    if (thresholds[i] <= thresholds[i - 1]) {
      throw new Error('buildProcessMiningQuery: thresholds must be strictly ascending.');
    }
  }
  // case(V >= t[n-1], L[n], …, V >= t[0], L[1], L[0]) — half-open bands, each
  // threshold is the inclusive lower bound of the band above it.
  const clauses: string[] = [];
  for (let i = thresholds.length - 1; i >= 0; i--) {
    clauses.push(`V >= ${kqlNum(thresholds[i])}, ${kqlString(labels[i + 1])}`);
  }
  const caseExpr = `case(${clauses.join(', ')}, ${kqlString(labels[0])})`;

  const csl = `Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series V = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql}
| extend V = series_fill_linear(V)
| mv-expand Timestamp to typeof(datetime), V to typeof(real)
| extend State = ${caseExpr}
| sort by Timestamp asc
| scan declare (SegId: long = 0, PrevState: string = '') with (
    step s: true =>
      SegId = iff(isempty(s.PrevState) or State == s.PrevState, s.SegId, s.SegId + 1),
      PrevState = State;
  )
| summarize StartTime = min(Timestamp), EndTime = max(Timestamp), Bins = count() by SegId, State
| order by StartTime asc`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

// --- decomposition ----------------------------------------------------------

export interface DecompositionOptions {
  tagId: string;
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  /**
   * Seasonality period in bins. Use -1 to auto-detect (default), 0 to disable.
   */
  seasonality?: number;
  timeseriesRef?: string;
}

/**
 * Decompose a signal into baseline, seasonal, trend, and residual components
 * via `series_decompose`. Returns a single row with the aligned Timestamp axis
 * and each component as a parallel array, ready for the 4-panel decomposition
 * view. Trend uses a linear fit; seasonality auto-detects by default.
 */
export function buildDecompositionQuery(opts: DecompositionOptions): string {
  const agg = AGG_EXPR[opts.aggregation ?? 'avg'];
  const from = kqlDatetime(opts.start);
  const to = kqlDatetime(opts.end);
  const seasonality = opts.seasonality ?? -1;
  const csl = `Timeseries
| where SignalId == ${kqlString(opts.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${opts.binKql} by SignalId
| extend Value = series_fill_linear(Value)
| extend (Baseline, Seasonal, Trend, Residual) = series_decompose(Value, ${kqlInt(seasonality)}, 'linefit')
| project SignalId, Timestamp, Value, Baseline, Seasonal, Trend, Residual`;
  return withTimeseriesRef(csl, opts.timeseriesRef, tsScope([opts.tagId], opts.start, opts.end));
}

// --- change points ----------------------------------------------------------

export interface ChangePointsOptions {
  tagId: string;
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  timeseriesRef?: string;
}

/**
 * Detect the single best level-shift / slope-break in a signal via
 * `series_fit_2lines`, which fits two line segments and returns the split that
 * maximizes total R-square. Returns one row with the gap-filled `Value`, the
 * combined two-line `LineFit` series (for charting), the break index
 * (`SplitIdx`), fit quality (`RSquare`), and the per-side slopes/interceptions
 * so the client can quantify the change (level shift vs slope break).
 */
export function buildChangePointsQuery(o: ChangePointsOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const csl = `Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql} by SignalId
| extend Value = series_fill_linear(Value)
| extend (RSquare, SplitIdx, Variance, RVariance, LineFit, RightRSquare, RightSlope, RightInterception, RightVariance, RightRVariance, LeftRSquare, LeftSlope, LeftInterception) = series_fit_2lines(Value)
| project SignalId, Timestamp, Value, LineFit, RSquare, SplitIdx, Variance, RVariance, LeftSlope, RightSlope, LeftInterception, RightInterception`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

// --- spectrum (FFT) ---------------------------------------------------------

export interface SpectrumOptions {
  tagId: string;
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  timeseriesRef?: string;
}

/**
 * Frequency spectrum of a signal via `series_fft`. The signal is aggregated
 * onto a uniform, gap-filled grid (a constant sample interval is required for
 * the frequency axis to be meaningful), then transformed to the frequency
 * domain. Returns one row with the gap-filled `Value` plus the real/imaginary
 * FFT components as parallel arrays; the client computes magnitude
 * (sqrt(re²+im²)) and maps each bin to a frequency / equivalent period.
 */
export function buildSpectrumQuery(o: SpectrumOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const csl = `Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql} by SignalId
| extend Value = series_fill_linear(Value)
| extend (FreqReal, FreqImag) = series_fft(Value)
| project SignalId, Timestamp, Value, FreqReal, FreqImag`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

export interface SpectrogramOptions {
  tagId: string;
  start: Date;
  end: Date;
  binKql: string;
  /** Frame (window) length in samples/bins fed to each FFT. */
  windowBins: number;
  /** Advance between successive frame starts, in samples/bins (hop size). */
  hopBins: number;
  aggregation?: Aggregation;
  timeseriesRef?: string;
}

/**
 * Short-Time Fourier Transform (spectrogram) of a signal. The signal is
 * aggregated onto a uniform, gap-filled grid (same as {@link buildSpectrumQuery}),
 * then sliced into overlapping frames of `windowBins` samples advancing by
 * `hopBins`, and each frame is transformed with `series_fft`. This reveals how
 * the frequency content evolves over time, which a single whole-window spectrum
 * cannot show.
 *
 * Framing reuses the same primitives as the cycle-extraction query: a per-row
 * frame index is generated with `range`, exploded with `mv-expand`, and each
 * frame is a fixed-length `array_slice` of the gap-filled series. The row is
 * dropped when the series is shorter than one window (`N >= windowBins` guard),
 * which the client treats as "not enough samples for a spectrogram".
 *
 * Returns one row per frame with the frame's real/imaginary FFT components as
 * parallel arrays; the client computes magnitude and maps each frame to a
 * center time and each bin to a frequency.
 */
export function buildSpectrogramQuery(o: SpectrogramOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const w = kqlInt(o.windowBins);
  const h = kqlInt(o.hopBins);
  const csl = `let _series = Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql} by SignalId
| extend Value = series_fill_linear(Value)
| extend N = array_length(Value)
| where N >= ${w};
_series
| extend NumFrames = (N - ${w}) / ${h} + 1
| mv-expand FrameIndex = range(0, NumFrames - 1, 1) to typeof(long)
| extend FrameStartIdx = FrameIndex * ${h}
| extend Frame = array_slice(Value, FrameStartIdx, FrameStartIdx + ${w} - 1)
| extend (FreqReal, FreqImag) = series_fft(Frame)
| project SignalId, FrameIndex = toint(FrameIndex), FrameStartIdx = toint(FrameStartIdx), FreqReal, FreqImag
| order by FrameIndex asc`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

// --- seasonality / period detection -----------------------------------------

export interface PeriodsOptions {
  tagId: string;
  start: Date;
  end: Date;
  binKql: string;
  aggregation?: Aggregation;
  /** Maximum number of candidate periods to return (default 3). */
  numPeriods?: number;
  timeseriesRef?: string;
}

/**
 * Detect the most significant recurring periods in a signal via
 * `series_periods_detect`, over the same avg-binned, gap-filled series the
 * Decomposition and Forecast pages use. Returns one row with `Periods` (period
 * lengths in bins, ordered by score) and `Scores` (0..1 significance).
 *
 * The algorithm needs periods of at least 4 points and at most half the series
 * length, so we bound `max_period` at `n/2` and drop series shorter than 8 bins
 * (where no valid period can exist) — those simply return no rows, which the
 * client treats as "no cycles detected".
 *
 * `series_periods_detect` requires `min_period`/`max_period` to be scalar
 * *constants*, so the series length is resolved once via `toscalar` (which Kusto
 * folds to a constant) rather than a per-row `array_length` column. `max_of(_n, 8)`
 * keeps `max_period >= min_period` (4.0) even for short windows, where the
 * `_n >= 8` filter already suppresses any output.
 *
 * The series is linearly detrended (the `series_fit_line` fit is subtracted)
 * before detection, because a strong trend otherwise dominates the
 * autocorrelation and masks real cycles; this is detection-only and does not
 * affect the forecast, which models trend itself.
 */
export function buildPeriodsQuery(o: PeriodsOptions): string {
  const agg = AGG_EXPR[o.aggregation ?? 'avg'];
  const from = kqlDatetime(o.start);
  const to = kqlDatetime(o.end);
  const num = kqlInt(o.numPeriods ?? 3);
  const csl = `let _series = Timeseries
| where SignalId == ${kqlString(o.tagId)}
| where Timestamp between (${from} .. ${to})
| make-series Value = ${agg} default = real(null) on Timestamp from ${from} to ${to} step ${o.binKql} by SignalId
| extend Value = series_fill_linear(Value);
let _n = toscalar(_series | project _len = array_length(Value) | take 1);
_series
| where _n >= 8
| extend _detr = series_subtract(Value, series_fit_line_dynamic(Value).line_fit)
| extend (Periods, Scores) = series_periods_detect(_detr, 4.0, todouble(max_of(_n, 8)) / 2.0, ${num})
| project SignalId, Periods, Scores`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope([o.tagId], o.start, o.end));
}

// --- cycle extraction ------------------------------------------------------------------

export interface CycleExtractionOptions {
  tagId: string;
  start: Date;
  end: Date;
  /** Cycle duration as KQL timespan, e.g. '1d', '8h', '1h'. */
  cycleDuration: string;
  binKql: string;
  aggregation?: Aggregation;
  timeseriesRef?: string;
}

/**
 * Extract fixed-length cycles from a signal. Each cycle is one row with
 * (CycleIndex: int, CycleStart: datetime, series: dynamic).
 * The cycles are aligned to the start time with the given duration.
 */
export function buildCycleExtractionQuery(opts: CycleExtractionOptions): string {
  const agg = opts.aggregation ?? 'avg';
  const aggExpr = AGG_EXPR[agg];
  // make-series requires CONSTANT from/to/step bounds; per-row CycleStart/CycleEnd
  // are illegal and make Kusto's internal bin() fail. Instead, map every sample
  // onto a common per-cycle offset window anchored at a fixed datetime so all
  // cycles share the same constant grid (and stay aligned for SAX downstream).
  const query = `
Timeseries
| where SignalId == ${kqlString(opts.tagId)}
| where Timestamp between (${kqlDatetime(opts.start)} .. ${kqlDatetime(opts.end)})
| extend CycleLen = ${opts.cycleDuration}
// KQL has no 1-arg floor(): floor() is an ALIAS for bin() and requires 2 args,
// so floor(x) fails with "bin(): function expects 2 argument(s)". Use bin(x, 1)
// to floor the (non-negative, since Timestamp >= start) cycle offset to an int.
| extend CycleIndex = toint(bin((Timestamp - ${kqlDatetime(opts.start)}) / CycleLen, 1))
| extend CycleStart = ${kqlDatetime(opts.start)} + CycleLen * CycleIndex
| extend OffsetTime = datetime(2000-01-01) + (Timestamp - CycleStart)
| make-series series = ${aggExpr} default=real(null) on OffsetTime from datetime(2000-01-01) to (datetime(2000-01-01) + ${opts.cycleDuration}) step ${opts.binKql} by CycleIndex, CycleStart
| extend series = series_fill_linear(series)
| project CycleIndex, CycleStart, series
| order by CycleIndex asc
| take 500
`;
  return withTimeseriesRef(query.trim(), opts.timeseriesRef, tsScope([opts.tagId], opts.start, opts.end));
}

export interface CycleSaxOptions {
  tagId: string;
  start: Date;
  end: Date;
  cycleDuration: string;
  binKql: string;
  paaSize: number;
  alphabetSize: number;
  znormThreshold: number;
  aggregation?: Aggregation;
  timeseriesRef?: string;
}

/**
 * Extract cycles from a signal for SAX analysis.
 * Returns (CycleIndex, CycleStart, series).
 *
 * SAX symbolization stays CLIENT-SIDE (lib/segmentation.ts) on purpose:
 *  - The deployed SAX word helpers (sax_paa / sax_symbolize_values / sax_word in
 *    schema/30_sax_core.kql) are `toscalar`-based SINGLE-series functions. KQL's
 *    toscalar() is evaluated once and cannot vary per row, so they cannot symbolize
 *    many cycle rows in one pass (this is exactly why 40_sax_similarity_1d.kql
 *    re-implements window symbolization inline via mv-apply instead of calling
 *    sax_word). Emitting a per-cycle word server-side would require re-implementing
 *    fractional PAA + symbolization inline per row.
 *  - There is no data-transfer win: clusterCycles()/saxDistance() operate on the
 *    word strings, but the numeric `series` must still be returned to the browser to
 *    draw each cycle, so the raw arrays cross the wire regardless.
 *  - Clustering (k-means over the SAX MINDIST matrix) is a cheap, interactive,
 *    client-only step and not a natural KQL fit.
 * Given a marginal (dedup-only) benefit against a real risk of behavioural change,
 * this stays client-side per the "don't move if it risks functionality" guardrail.
 */
export function buildCycleSaxQuery(opts: CycleSaxOptions): string {
  return buildCycleExtractionQuery({
    tagId: opts.tagId,
    start: opts.start,
    end: opts.end,
    cycleDuration: opts.cycleDuration,
    binKql: opts.binKql,
    aggregation: opts.aggregation,
    timeseriesRef: opts.timeseriesRef,
  });
}

// --- Activator (Reflex) self-contained similarity KQL ------------------------
//
// These builders generate a SELF-CONTAINED KQL query for a Fabric Activator
// alert: the reviewed query pattern is HARD-CODED inline as a datatable (the
// source series may not be retained), while the search space stays LIVE via the
// existing app_search_space stored function so each scheduled run finds new
// matches. The queries are always PURE UTC — they use only relative ago()/now()
// bounds and never the query-timezone offset shift applied by kqlDatetime /
// withTimeseriesRef, so no local-time skew can leak into a standing alert.

/**
 * Result column names emitted by the generated Activator KQL. Kept in one place
 * so the KQL generator and the Reflex definition builder (which references these
 * fields in the email subject / context) never drift.
 */
export const ACTIVATOR_COLUMNS = {
  tagId: 'TagId',
  entity: 'Entity',
  subjectTags: 'SubjectTags',
  matchStart: 'MatchStart',
  matchEnd: 'MatchEnd',
  distance: 'Distance',
  similarity: 'Similarity',
  meanDistance: 'MeanDistance',
  score: 'Score',
  scale: 'Scale',
  matchedLength: 'MatchLength',
  matchedTracks: 'MatchedTracks',
} as const;

/** A `dynamic([...])` array of validated numeric literals (nulls → real(null)). */
function kqlNumberArray(values: number[]): string {
  const body = values
    .map((v) => (v == null || !Number.isFinite(v) ? 'real(null)' : kqlNum(v)))
    .join(', ');
  return `dynamic([${body}])`;
}

/**
 * Bind the profile timeseries query onto the canonical `Timeseries` name with NO
 * timezone offset — Activator KQL is always pure UTC (unlike {@link
 * withTimeseriesRef}, which shifts Timestamp by the active query offset).
 */
function activatorTimeseriesBinding(ref: string): string {
  const trimmed = (ref ?? '').trim();
  if (!trimmed) {
    throw new Error('An active connection profile timeseries query is required to build an Activator alert.');
  }
  if (trimmed === 'Timeseries') return '';
  return `let Timeseries = (\n${trimmed}\n);\n`;
}

/**
 * Summarize a set of tag ids for the alert subject line: the first id, plus
 * "+ N more signal(s)" when there is more than one (e.g. "vibration-01" or
 * "vibration-01 + 3 more signals").
 */
export function summarizeSubjectTags(tagIds: string[]): string {
  const ids = tagIds.filter((t) => t != null && t !== '');
  if (ids.length === 0) return '';
  if (ids.length === 1) return ids[0];
  const rest = ids.length - 1;
  return `${ids[0]} + ${rest} more signal${rest === 1 ? '' : 's'}`;
}

export interface ActivatorSimilarityBase {
  /** Profile timeseries query (canonical SignalId/Timestamp/Value); bound as UTC. */
  timeseriesRef: string;
  /** Search granularity as a KQL timespan literal (e.g. '5m'), inherited from the search. */
  binKql: string;
  /** The same granularity in seconds, for the incremental-lookback math. */
  binSeconds: number;
  /** Chosen run frequency in seconds (= executionIntervalInSeconds). */
  frequencySeconds: number;
  queryLengthSymbols: number;
  alphabetSize: number;
  minScale: number;
  maxScale: number;
  scaleSteps: number;
  symbolTolerance: number;
  topK: number;
  znormThreshold: number;
  /** Optional query-id literal used inside the inlined datatable. */
  queryId?: string;
  /** Minimum similarity score (0..1) a match must reach to fire the alert. When >0, adds a post-filter on the projected similarity/score column. Omitted or <=0 means no filter. */
  minSimilarity?: number;
}

export interface ActivatorSimilarity1dOptions extends ActivatorSimilarityBase {
  /** Raw binned query pattern (the reviewed series); inlined into the query. */
  queryValues: number[];
  /** Live search-space tags scanned every run. */
  searchTagIds: string[];
}

export interface ActivatorSimilarityMultidimOptions extends ActivatorSimilarityBase {
  /**
   * One track per dimension: its synthetic track id, the live search tag it is
   * scanned on, and the inlined raw binned query pattern. For a recurrence
   * search track_id === searchTagId; for a mapped search they differ.
   */
  tracks: { trackId: string; searchTagId: string; values: number[] }[];
  maxInterTrackDelay: number;
  perTrackTopK: number;
}

/** The generated Activator KQL plus the metadata the Reflex builder needs. */
export interface ActivatorKql {
  /** The self-contained KQL query string. */
  queryString: string;
  /** Result column whose value is appended to the email subject. */
  subjectField: string;
  /** Result columns surfaced (fixed) in the Activator context area. */
  contextFields: string[];
  /** Incremental lookback used, in seconds (for notes / diagnostics). */
  lookbackSeconds: number;
}

/**
 * Build the self-contained single-dimensional Activator similarity KQL. The
 * reviewed pattern is inlined as `Query`; `app_search_space` rebuilds the search
 * space live over `ago(lookback) .. now()` at the inherited bin. Emits the tag
 * id (per-match, from series_id), a subject-tags column, absolute match start /
 * end timestamps derived from the sample index, and the essential score columns.
 */
export function buildActivatorSimilarityKql(o: ActivatorSimilarity1dOptions): ActivatorKql {
  const c = ACTIVATOR_COLUMNS;
  const minSim = o.minSimilarity ?? 0;
  const lookbackSeconds = computeLookbackSeconds(o.frequencySeconds, o.queryValues.length, o.binSeconds);
  const queryId = kqlString(o.queryId ?? 'query');
  const binding = activatorTimeseriesBinding(o.timeseriesRef);
  const simFilter = minSim > 0 ? `\n  | where ${c.similarity} >= ${kqlNum(minSim)}` : '';
  const queryString = `${binding}let _lookback = ${kqlInt(lookbackSeconds)}s;
let _bin = ${o.binKql};
let _t0 = ago(_lookback);
let Query = datatable(query_id:string, series:dynamic) [
    ${queryId}, ${kqlNumberArray(o.queryValues)}
];
let SearchSpace = app_search_space(Timeseries, ${kqlStringArray(o.searchTagIds)}, _t0, now(), _bin);
sax_similarity_search_1d(Query, SearchSpace, ${kqlInt(o.queryLengthSymbols)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.minScale)}, ${kqlNum(o.maxScale)}, ${kqlInt(o.scaleSteps)}, ${kqlInt(o.symbolTolerance)}, ${kqlInt(o.topK)}, ${kqlNum(o.znormThreshold)})
| extend ${c.matchStart} = _t0 + start_index * _bin
| extend ${c.matchEnd} = _t0 + (end_index + 1) * _bin
| project ${c.tagId} = series_id, ${c.subjectTags} = series_id, ${c.matchStart}, ${c.matchEnd}, ${c.distance} = distance, ${c.similarity} = similarity, ${c.scale} = scale, ${c.matchedLength} = matched_length${simFilter}`;
  return {
    queryString,
    subjectField: c.subjectTags,
    contextFields: [c.tagId, c.matchStart, c.matchEnd, c.distance, c.similarity, c.scale, c.matchedLength],
    lookbackSeconds,
  };
}

/**
 * Build the self-contained multidimensional Activator similarity KQL. Each
 * track's reviewed pattern is inlined into `QueryTracks`; a `TrackMap` datatable
 * remaps each live search tag onto its synthetic track id so `SearchTracks`
 * (rebuilt live via app_search_space over `ago(lookback) .. now()`) pairs with
 * the query tracks. Emits a static subject-tags summary, absolute match start /
 * end timestamps, and the essential aggregate score columns.
 */
export function buildActivatorSimilarityKqlMultidim(
  o: ActivatorSimilarityMultidimOptions,
): ActivatorKql {
  const c = ACTIVATOR_COLUMNS;
  const minSim = o.minSimilarity ?? 0;
  const queryBins = o.tracks.reduce((max, t) => Math.max(max, t.values.length), 0);
  const lookbackSeconds = computeLookbackSeconds(o.frequencySeconds, queryBins, o.binSeconds);
  const queryId = kqlString(o.queryId ?? 'query');
  const binding = activatorTimeseriesBinding(o.timeseriesRef);
  const simFilter = minSim > 0 ? `\n  | where ${c.score} >= ${kqlNum(minSim)}` : '';
  const searchTags = [...new Set(o.tracks.map((t) => t.searchTagId))];
  const subject = summarizeSubjectTags(o.tracks.map((t) => t.searchTagId));
  const queryRows = o.tracks
    .map((t) => `    ${queryId}, ${kqlString(t.trackId)}, ${kqlNumberArray(t.values)}`)
    .join(',\n');
  const remapRows = o.tracks
    .map((t) => `    ${kqlString(t.searchTagId)}, ${kqlString(t.trackId)}`)
    .join(',\n');
  const queryString = `${binding}let _lookback = ${kqlInt(lookbackSeconds)}s;
let _bin = ${o.binKql};
let _t0 = ago(_lookback);
let QueryTracks = datatable(query_id:string, track_id:string, series:dynamic) [
${queryRows}
];
let TrackMap = datatable(series_id:string, track_id:string) [
${remapRows}
];
let SearchTracks = app_search_space(Timeseries, ${kqlStringArray(searchTags)}, _t0, now(), _bin)
    | join kind=inner TrackMap on series_id
    | project entity_id = ${kqlString('search')}, track_id, series;
sax_similarity_search_multidim(QueryTracks, SearchTracks, ${kqlInt(o.queryLengthSymbols)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.minScale)}, ${kqlNum(o.maxScale)}, ${kqlInt(o.scaleSteps)}, ${kqlInt(o.symbolTolerance)}, ${kqlInt(o.maxInterTrackDelay)}, ${kqlInt(o.perTrackTopK)}, ${kqlInt(o.topK)}, ${kqlNum(o.znormThreshold)})
| extend ${c.matchStart} = _t0 + start_index * _bin
| extend ${c.matchEnd} = _t0 + (end_index + 1) * _bin
| extend ${c.subjectTags} = ${kqlString(subject)}
| project ${c.entity} = entity_id, ${c.subjectTags}, ${c.matchStart}, ${c.matchEnd}, ${c.meanDistance} = mean_distance, ${c.score} = exact_score, ${c.matchedTracks} = matched_track_count${simFilter}`;
  return {
    queryString,
    subjectField: c.subjectTags,
    contextFields: [c.entity, c.matchStart, c.matchEnd, c.meanDistance, c.score, c.matchedTracks],
    lookbackSeconds,
  };
}

// --- MVAD (multivariate anomaly detection) ----------------------------------

/**
 * The four MVAD detectors exposed by the pure-KQL library
 * (`eventhouse/schema/80_mvad_core.kql` .. `84_mvad_spectral.kql`). Each value is
 * the result-contract `algorithm` string emitted by the corresponding detector,
 * except `spectral` whose KQL function is `mvad_spectral_aggregation` and whose
 * result `algorithm` string is `spectral_aggregation` (see src/lib/mvad.ts).
 */
export type MvadAlgorithm = 'residual_voting' | 'random_projection' | 'change_point' | 'spectral';

/**
 * Superset of every detector's tunable parameters. Only the fields relevant to
 * the selected {@link MvadOptions.algorithm} are read; the rest are ignored.
 * `detection_window` (from {@link MvadOptions.detectionWindowKql}) and
 * `emit_all_scores` (from {@link MvadOptions.emitAllScores}) are NOT part of this
 * bag — they are top-level options. Per-algorithm validated defaults live in
 * {@link MVAD_DEFAULT_PARAMS}.
 */
export interface MvadDetectorParams {
  // residual_voting + random_projection + change_point (0 => auto; -1 => none)
  seasonality?: number;
  // residual_voting + random_projection ('avg' | 'linefit' | 'none')
  trend?: string;
  // residual_voting
  outlierKind?: string;
  featureScoreThreshold?: number;
  residualRmsThreshold?: number;
  extremeFeatureThreshold?: number;
  // random_projection
  projectionCount?: number;
  projectionDensity?: number;
  projectionSeed?: string;
  projectionScoreThreshold?: number;
  projectionRmsThreshold?: number;
  minProjectionVotes?: number;
  extremeProjectionThreshold?: number;
  stdevFloor?: number;
  maxWorkRows?: number;
  // change_point
  contrastWindowBins?: number;
  changeRmsThreshold?: number;
  detectSlopeChanges?: boolean;
  // spectral
  baselineWindowCount?: number;
  minBaselineWindows?: number;
  useHannWindow?: boolean;
  spectralRmsThreshold?: number;
  // change_point + spectral
  trackScoreThreshold?: number;
  extremeTrackThreshold?: number;
  // residual_voting + change_point + spectral
  minTrackVotes?: number;
  minVoteFraction?: number;
}

interface ResidualParams {
  seasonality: number;
  trend: string;
  outlierKind: string;
  featureScoreThreshold: number;
  residualRmsThreshold: number;
  minTrackVotes: number;
  minVoteFraction: number;
  extremeFeatureThreshold: number;
}

interface RandomProjectionParams {
  seasonality: number;
  trend: string;
  projectionCount: number;
  projectionDensity: number;
  projectionSeed: string;
  projectionScoreThreshold: number;
  projectionRmsThreshold: number;
  minProjectionVotes: number;
  extremeProjectionThreshold: number;
  stdevFloor: number;
  maxWorkRows: number;
}

interface ChangePointParams {
  seasonality: number;
  contrastWindowBins: number;
  trackScoreThreshold: number;
  changeRmsThreshold: number;
  minTrackVotes: number;
  minVoteFraction: number;
  extremeTrackThreshold: number;
  detectSlopeChanges: boolean;
}

interface SpectralParams {
  baselineWindowCount: number;
  minBaselineWindows: number;
  useHannWindow: boolean;
  trackScoreThreshold: number;
  spectralRmsThreshold: number;
  minTrackVotes: number;
  minVoteFraction: number;
  extremeTrackThreshold: number;
}

/** Validated defaults for mvad_residual_magnitude_voting. */
const RESIDUAL_DEFAULTS: ResidualParams = {
  seasonality: 0,
  trend: 'linefit',
  outlierKind: 'ctukey',
  featureScoreThreshold: 1.5,
  residualRmsThreshold: 1.2,
  minTrackVotes: 2,
  minVoteFraction: 0.5,
  extremeFeatureThreshold: 3.0,
};

/** Validated defaults for mvad_random_projection_ensemble. */
const RANDOM_PROJECTION_DEFAULTS: RandomProjectionParams = {
  seasonality: 0,
  trend: 'linefit',
  projectionCount: 16,
  projectionDensity: 0.25,
  projectionSeed: 'ops-iq-v1',
  projectionScoreThreshold: 1.5,
  projectionRmsThreshold: 1.2,
  minProjectionVotes: 2,
  extremeProjectionThreshold: 3.0,
  stdevFloor: 1e-6,
  maxWorkRows: 5000000,
};

/** Validated defaults for mvad_change_point_ensemble. */
const CHANGE_POINT_DEFAULTS: ChangePointParams = {
  seasonality: 0,
  contrastWindowBins: 8,
  trackScoreThreshold: 1.5,
  changeRmsThreshold: 1.2,
  minTrackVotes: 2,
  minVoteFraction: 0.5,
  extremeTrackThreshold: 3.0,
  detectSlopeChanges: true,
};

/** Validated defaults for mvad_spectral_aggregation. */
const SPECTRAL_DEFAULTS: SpectralParams = {
  baselineWindowCount: 8,
  minBaselineWindows: 3,
  useHannWindow: true,
  trackScoreThreshold: 2.0,
  spectralRmsThreshold: 1.5,
  minTrackVotes: 2,
  minVoteFraction: 0.5,
  extremeTrackThreshold: 4.0,
};

/**
 * Per-algorithm validated default parameters, matching the deployed KQL
 * detectors' declared defaults exactly. Exposed as plain data so PR-1b's UI can
 * seed parameter controls without duplicating the numbers.
 */
export const MVAD_DEFAULT_PARAMS: Record<MvadAlgorithm, MvadDetectorParams> = {
  residual_voting: { ...RESIDUAL_DEFAULTS },
  random_projection: { ...RANDOM_PROJECTION_DEFAULTS },
  change_point: { ...CHANGE_POINT_DEFAULTS },
  spectral: { ...SPECTRAL_DEFAULTS },
};

export interface MvadOptions {
  algorithm: MvadAlgorithm;
  /** Tags to analyse. Each becomes a track (track_id = SignalId) of one entity. */
  tagIds: string[];
  start: Date;
  /** Exclusive upper bound (matches mvad_make_series' exclusive range_end). */
  end: Date;
  /** Bin width KQL literal, e.g. '15m'. */
  binKql: string;
  /**
   * Bin width in milliseconds. When provided (> 0), the interactive query window
   * is snapped so its exclusive `end` lands on a whole number of bins from
   * `start` (see alignMvadWindowEnd). This keeps mvad_make_series' range_end on
   * the same grid as its point count (range_end == start + point_count*bin),
   * avoiding a spurious `misaligned_series` diagnostic when the user's selected
   * range is not an exact bin multiple. Omit to pass start/end through unchanged.
   */
  binMillis?: number;
  /**
   * Detection window KQL literal, e.g. '1h'. MUST be an integer multiple of
   * `binKql`; otherwise every detector returns a single `misaligned_series`
   * diagnostic row. Spectral additionally requires detection_window/bin_size
   * >= 32 bins, else `insufficient_history`. This builder passes the literal
   * through verbatim and never rewrites user input.
   */
  detectionWindowKql: string;
  /** Entity id all tracks are grouped under (default 'selection'). */
  entityId?: string;
  /** mvad_make_series min_coverage (default 0.95). */
  minCoverage?: number;
  /** mvad_make_series max_gap_bins (default 3). */
  maxGapBins?: number;
  /** Emit all scored rows, not just anomalies (default false). */
  emitAllScores?: boolean;
  /** Detector parameter overrides layered onto {@link MVAD_DEFAULT_PARAMS}. */
  params?: Partial<MvadDetectorParams>;
  /** Connection-Profile timeseries query (see other builders). */
  timeseriesRef?: string;
}

/**
 * Merge caller overrides onto a fully-typed per-algorithm defaults object,
 * copying only keys that exist on the defaults and whose override value is
 * defined. Keeps the returned type's fields required (no `undefined` leaks).
 */
function mergeMvadParams<T extends object>(defaults: T, overrides?: Partial<MvadDetectorParams>): T {
  const out = { ...defaults };
  if (overrides) {
    for (const key of Object.keys(defaults) as (keyof T & keyof MvadDetectorParams)[]) {
      const v = overrides[key];
      if (v !== undefined) {
        (out as Record<string, unknown>)[key as string] = v;
      }
    }
  }
  return out;
}

/**
 * Build a multivariate anomaly-detection query: bind the selected tags as tracks
 * (entity_id = `entityId`, track_id = SignalId) of a single entity, prep them with
 * `mvad_make_series`, then call the chosen detector with all parameters in the
 * exact validated order the deployed KQL declares. The emitted result matches
 * the common 16-column MVAD contract; parse it with `parseMvadRows` from
 * `src/lib/mvad.ts`.
 *
 * IMPORTANT: `detectionWindowKql` must be an integer multiple of `binKql` (and
 * for `spectral`, >= 32 bins); this builder deliberately does not validate or
 * rewrite those literals, so a misconfiguration surfaces as a KQL diagnostic
 * row rather than a silently altered query.
 */
/**
 * Build a single MVAD detector call string in the exact validated parameter
 * order the deployed KQL declares. Shared by {@link buildMvadQuery} (which passes
 * a timespan literal such as `4h` for `detectionWindowExpr`) and the Activator
 * anomaly builder (which passes the `_dw` let-binding name). `emitAllScores`
 * toggles the trailing `emit_all_scores` argument.
 */
function buildMvadDetectorCall(
  algorithm: MvadAlgorithm,
  params: Partial<MvadDetectorParams> | undefined,
  detectionWindowExpr: string,
  emitAllScores: boolean,
): string {
  const emit = emitAllScores ? 'true' : 'false';
  const dw = detectionWindowExpr;
  switch (algorithm) {
    case 'residual_voting': {
      const d = mergeMvadParams(RESIDUAL_DEFAULTS, params);
      return `mvad_residual_magnitude_voting(SeriesTable, ${dw}, ${kqlInt(d.seasonality)}, ${kqlString(d.trend)}, ${kqlString(d.outlierKind)}, ${kqlNum(d.featureScoreThreshold)}, ${kqlNum(d.residualRmsThreshold)}, ${kqlInt(d.minTrackVotes)}, ${kqlNum(d.minVoteFraction)}, ${kqlNum(d.extremeFeatureThreshold)}, ${emit})`;
    }
    case 'random_projection': {
      const d = mergeMvadParams(RANDOM_PROJECTION_DEFAULTS, params);
      return `mvad_random_projection_ensemble(SeriesTable, ${dw}, ${kqlInt(d.seasonality)}, ${kqlString(d.trend)}, ${kqlInt(d.projectionCount)}, ${kqlNum(d.projectionDensity)}, ${kqlString(d.projectionSeed)}, ${kqlNum(d.projectionScoreThreshold)}, ${kqlNum(d.projectionRmsThreshold)}, ${kqlInt(d.minProjectionVotes)}, ${kqlNum(d.extremeProjectionThreshold)}, ${kqlNum(d.stdevFloor)}, ${kqlInt(d.maxWorkRows)}, ${emit})`;
    }
    case 'change_point': {
      const d = mergeMvadParams(CHANGE_POINT_DEFAULTS, params);
      return `mvad_change_point_ensemble(SeriesTable, ${dw}, ${kqlInt(d.seasonality)}, ${kqlInt(d.contrastWindowBins)}, ${kqlNum(d.trackScoreThreshold)}, ${kqlNum(d.changeRmsThreshold)}, ${kqlInt(d.minTrackVotes)}, ${kqlNum(d.minVoteFraction)}, ${kqlNum(d.extremeTrackThreshold)}, ${d.detectSlopeChanges ? 'true' : 'false'}, ${emit})`;
    }
    case 'spectral': {
      const d = mergeMvadParams(SPECTRAL_DEFAULTS, params);
      return `mvad_spectral_aggregation(SeriesTable, ${dw}, ${kqlInt(d.baselineWindowCount)}, ${kqlInt(d.minBaselineWindows)}, ${d.useHannWindow ? 'true' : 'false'}, ${kqlNum(d.trackScoreThreshold)}, ${kqlNum(d.spectralRmsThreshold)}, ${kqlInt(d.minTrackVotes)}, ${kqlNum(d.minVoteFraction)}, ${kqlNum(d.extremeTrackThreshold)}, ${emit})`;
    }
  }
}

/**
 * Snap an interactive MVAD window's exclusive `end` DOWN to a whole number of
 * bins so mvad_make_series' range_end lands on the same grid as its point count
 * (range_end == start + point_count*bin). Without this, a window whose duration
 * is not an exact bin multiple makes `_clock_aligned` false in
 * mvad_entity_profile and every detector returns a spurious `misaligned_series`
 * diagnostic. A no-op when `binMillis` is missing/<= 0, when the span is under
 * one bin, or when the window is already an exact bin multiple.
 */
function alignMvadWindowEnd(start: Date, end: Date, binMillis?: number): Date {
  if (!binMillis || binMillis <= 0) return end;
  const span = end.getTime() - start.getTime();
  const bins = Math.floor(span / binMillis);
  if (bins < 1) return end;
  const alignedMs = start.getTime() + bins * binMillis;
  return alignedMs === end.getTime() ? end : new Date(alignedMs);
}

/**
 * Inputs for {@link buildMvadCoverageQuery}. A subset of {@link MvadOptions} — the
 * companion coverage query needs only the make-series inputs (no detector,
 * detection window, or params), so it can run in parallel with the detector query.
 */
export interface MvadCoverageOptions {
  tagIds: string[];
  start: Date;
  /** Exclusive upper bound (matches mvad_make_series' exclusive range_end). */
  end: Date;
  /** Bin width KQL literal, e.g. '15m'. */
  binKql: string;
  /** Bin width in ms; snaps `end` to a whole bin count (see alignMvadWindowEnd). */
  binMillis?: number;
  /** mvad_make_series min_coverage (default 0.95). */
  minCoverage?: number;
  /** mvad_make_series max_gap_bins (default 3). */
  maxGapBins?: number;
  /** Entity id all tracks are grouped under (default 'selection'). */
  entityId?: string;
  /** Connection-Profile timeseries query (see other builders). */
  timeseriesRef?: string;
}

/**
 * Build a lightweight companion query that reports per-track data-quality metrics
 * for the SAME window/bin/gate as {@link buildMvadQuery}. It reuses the deployed
 * `mvad_make_series` function and projects only its quality columns (dropping the
 * series payload), so it can run in parallel with the detector query to power a
 * coverage badge WITHOUT any Eventhouse schema change. `is_valid` /
 * `validation_error` reflect the supplied `minCoverage` / `maxGapBins` gate;
 * `coverage` and `max_missing_run` are gate-independent raw metrics.
 */
export function buildMvadCoverageQuery(o: MvadCoverageOptions): string {
  const entityId = o.entityId ?? 'selection';
  const minCoverage = o.minCoverage ?? 0.95;
  const maxGapBins = o.maxGapBins ?? 3;
  const tagList = o.tagIds.map(kqlString).join(', ');
  const alignedEnd = alignMvadWindowEnd(o.start, o.end, o.binMillis);
  const csl = `let Source = Timeseries
    | where Timestamp >= ${kqlDatetime(o.start)} and Timestamp < ${kqlDatetime(alignedEnd)}
    | where SignalId in (${tagList})
    | project entity_id = ${kqlString(entityId)}, track_id = SignalId, timestamp = Timestamp, value = Value;
mvad_make_series(Source, ${kqlDatetime(o.start)}, ${kqlDatetime(alignedEnd)}, ${o.binKql}, ${kqlNum(minCoverage)}, ${kqlInt(maxGapBins)})
| project track_id, point_count, observed_bins, coverage, max_missing_run, is_valid, validation_error`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope(o.tagIds, o.start, alignedEnd));
}

export function buildMvadQuery(o: MvadOptions): string {
  const entityId = o.entityId ?? 'selection';
  const minCoverage = o.minCoverage ?? 0.95;
  const maxGapBins = o.maxGapBins ?? 3;

  const detector = buildMvadDetectorCall(
    o.algorithm,
    o.params,
    o.detectionWindowKql,
    o.emitAllScores ?? false,
  );

  // NB: a plain escaped comma list (not kqlStringArray's dynamic([...])) to
  // match the live-validated CSL contract exactly. `where col in (...)` accepts
  // either form in Kusto, but the deployed/validated query uses the plain list.
  const tagList = o.tagIds.map(kqlString).join(', ');
  const alignedEnd = alignMvadWindowEnd(o.start, o.end, o.binMillis);
  const csl = `let Source = Timeseries
    | where Timestamp >= ${kqlDatetime(o.start)} and Timestamp < ${kqlDatetime(alignedEnd)}
    | where SignalId in (${tagList})
    | project entity_id = ${kqlString(entityId)}, track_id = SignalId, timestamp = Timestamp, value = Value;
let SeriesTable = mvad_make_series(Source, ${kqlDatetime(o.start)}, ${kqlDatetime(alignedEnd)}, ${o.binKql}, ${kqlNum(minCoverage)}, ${kqlInt(maxGapBins)});
${detector}`;
  return withTimeseriesRef(csl, o.timeseriesRef, tsScope(o.tagIds, o.start, alignedEnd));
}

// --- Activator (Reflex) self-contained anomaly (MVAD) KQL --------------------
//
// Turn an MVAD anomaly-detection run into a SELF-CONTAINED, PURE-UTC, INCREMENTAL
// KQL query for a Fabric Activator alert. Unlike buildMvadQuery (which pins an
// absolute [start, end) window for an interactive run), this builder emits only
// relative now()-anchored bounds so a standing scheduled alert always looks at
// the live tail. The make_series window spans enough history for the detector to
// clear its insufficient-history guard, while a post-filter keeps only anomalies
// whose event_time falls inside the newest run's incremental slice so repeated
// runs never re-fire on the same event.

/**
 * Result column names emitted by the generated Activator anomaly KQL. Kept in one
 * place so the KQL generator and the Reflex definition builder never drift.
 */
export const ANOMALY_ACTIVATOR_COLUMNS = {
  entity: 'Entity',
  subjectTags: 'SubjectTags',
  algorithm: 'Algorithm',
  eventTime: 'EventTime',
  score: 'Score',
  threshold: 'Threshold',
  severity: 'Severity',
  voteCount: 'VoteCount',
  trackCount: 'TrackCount',
  contributors: 'Contributors',
} as const;

export interface ActivatorAnomalyOptions {
  /** Profile timeseries query bound as pure UTC (no offset). */
  timeseriesRef: string;
  algorithm: MvadAlgorithm;
  /** Tags analysed as tracks of one entity (>=2 required by MVAD; not enforced here). */
  tagIds: string[];
  /** Bin width KQL literal, e.g. '15m'. */
  binKql: string;
  /** Same bin width in seconds, for history/emit math. */
  binSeconds: number;
  /** Detection-window length in bins (integer >=1; spectral expects >=32). Detection window = detectionBins*binSeconds seconds, guaranteeing bin alignment. */
  detectionBins: number;
  /** Chosen run frequency in seconds. */
  frequencySeconds: number;
  entityId?: string;      // default 'selection'
  minCoverage?: number;   // default 0.95
  maxGapBins?: number;    // default 3
  /**
   * Minimum severity an anomaly must reach to fire the alert. Severity is a
   * detector-agnostic ratio (max of score/threshold, votes/min-votes, and
   * extreme-score/extreme-threshold), so 1.0 is the detection boundary — every
   * confirmed anomaly. Values > 1 require the anomaly to exceed its threshold by
   * that multiple, alerting only on progressively stronger events. Default 1
   * (no extra gating; byte-identical to the ungated query).
   */
  minSeverity?: number;
  /** Detector parameter overrides layered onto MVAD_DEFAULT_PARAMS[algorithm]. */
  params?: Partial<MvadDetectorParams>;
}

/** Extra bins of history requested beyond the detector's minimum, for safety. */
const MVAD_ANOMALY_SAFETY_BINS = 4;

/**
 * Bins of series history the make_series window must span so the selected
 * detector clears its insufficient_history guard. Combines the detection window
 * (in bins) with each detector's baseline/warm-up requirement plus a small
 * safety margin. Pure integer math so tests can assert exact counts.
 */
export function mvadAnomalyHistoryBins(
  algorithm: MvadAlgorithm,
  detectionBins: number,
  params?: Partial<MvadDetectorParams>,
): number {
  switch (algorithm) {
    case 'residual_voting': {
      const d = mergeMvadParams(RESIDUAL_DEFAULTS, params);
      const season = d.seasonality ?? 0;
      const minHist = Math.max(16, season > 0 ? 2 * season : 16);
      return detectionBins + minHist + MVAD_ANOMALY_SAFETY_BINS;
    }
    case 'random_projection': {
      const d = mergeMvadParams(RANDOM_PROJECTION_DEFAULTS, params);
      const season = d.seasonality ?? 0;
      const minHist = Math.max(16, season > 0 ? 2 * season : 16);
      return detectionBins + minHist + MVAD_ANOMALY_SAFETY_BINS;
    }
    case 'change_point': {
      const d = mergeMvadParams(CHANGE_POINT_DEFAULTS, params);
      const cwb = d.contrastWindowBins ?? 8;
      const minHist = Math.max(16, 2 * cwb + 8);
      return detectionBins + minHist + MVAD_ANOMALY_SAFETY_BINS;
    }
    case 'spectral': {
      const d = mergeMvadParams(SPECTRAL_DEFAULTS, params);
      const bwc = d.baselineWindowCount ?? 8;
      return detectionBins * (bwc + 1) + MVAD_ANOMALY_SAFETY_BINS;
    }
  }
}

/**
 * Build the self-contained Activator anomaly (MVAD) KQL. Binds the selected tags
 * as tracks of one entity, prepares them with `mvad_make_series` over a
 * now()-anchored history window sized by {@link mvadAnomalyHistoryBins}, calls
 * the chosen detector (with `emit_all_scores=false`), then keeps only ok-status
 * anomalies whose `event_time` lands inside the newest incremental slice
 * (frequency + one bin). All bounds are relative UTC — no datetime literals, no
 * timezone offset — so it is safe to run on a fixed schedule.
 */
export function buildActivatorAnomalyKql(o: ActivatorAnomalyOptions): ActivatorKql {
  const c = ANOMALY_ACTIVATOR_COLUMNS;
  const entityId = o.entityId ?? 'selection';
  const minCoverage = o.minCoverage ?? 0.95;
  const maxGapBins = o.maxGapBins ?? 3;

  const historyBins = mvadAnomalyHistoryBins(o.algorithm, o.detectionBins, o.params);
  const historySeconds = historyBins * o.binSeconds;
  const emitSeconds = o.frequencySeconds + o.binSeconds;
  const detectionWindowSeconds = o.detectionBins * o.binSeconds;
  // Severity gate: 1.0 = the detection boundary (every confirmed anomaly), so it
  // is only materialized when the user raises it above 1 — keeping the default
  // query byte-identical to the ungated form.
  const minSeverity = o.minSeverity ?? 1;
  const severityLet = minSeverity > 1 ? `let _min_severity = ${kqlNum(minSeverity)};\n` : '';
  const severityFilter = minSeverity > 1 ? `\n| where severity >= _min_severity` : '';

  const binding = activatorTimeseriesBinding(o.timeseriesRef);
  const tagList = o.tagIds.map(kqlString).join(', ');
  const subject = summarizeSubjectTags(o.tagIds);
  const detectorCall = buildMvadDetectorCall(o.algorithm, o.params, '_dw', false);

  const queryString = `${binding}let _history = ${kqlInt(historySeconds)}s;
let _bin = ${o.binKql};
let _dw = ${kqlInt(detectionWindowSeconds)}s;
let _emit = ${kqlInt(emitSeconds)}s;
${severityLet}let _end = now();
let _start = _end - _history;
let Source = Timeseries
    | where Timestamp >= _start and Timestamp < _end
    | where SignalId in (${tagList})
    | project entity_id = ${kqlString(entityId)}, track_id = SignalId, timestamp = Timestamp, value = Value;
let SeriesTable = mvad_make_series(Source, _start, _end, _bin, ${kqlNum(minCoverage)}, ${kqlInt(maxGapBins)});
${detectorCall}
| where status == 'ok' and event_time > _end - _emit${severityFilter}
| extend ${c.subjectTags} = ${kqlString(subject)}
| project ${c.entity} = entity_id, ${c.subjectTags}, ${c.algorithm} = algorithm, ${c.eventTime} = event_time, ${c.score} = score, ${c.threshold} = threshold, ${c.severity} = severity, ${c.voteCount} = vote_count, ${c.trackCount} = track_count, ${c.contributors} = contributors`;

  return {
    queryString,
    subjectField: c.subjectTags,
    contextFields: [
      c.entity,
      c.algorithm,
      c.eventTime,
      c.score,
      c.threshold,
      c.severity,
      c.voteCount,
      c.trackCount,
      c.contributors,
    ],
    lookbackSeconds: historySeconds,
  };
}

// --- SAX discord anomaly alerting -------------------------------------------

/** Baseline bins of history (beyond the detection window) SAX discords needs so
 * the most-recent windows are scored against a meaningful stretch of prior data. */
export const SAX_ANOMALY_MIN_BASELINE_BINS = 200;

/**
 * Bins of series history the SAX discord alert (and its threshold helper) must
 * span so recent detection-window candidates are compared against enough prior
 * history to be meaningful. The same value is used by BOTH the alert query and
 * the self-calibrating threshold helper so the suggested threshold matches the
 * runtime baseline. Pure integer math so tests can assert exact counts.
 */
export function saxAnomalyHistoryBins(detectionBins: number): number {
  const baseline = Math.max(detectionBins * 4, SAX_ANOMALY_MIN_BASELINE_BINS);
  return detectionBins + baseline;
}

/** Canonical output column names for the generated SAX discord alert query. */
export const SAX_ANOMALY_ACTIVATOR_COLUMNS = {
  entity: 'Entity',
  subjectTags: 'SubjectTags',
  algorithm: 'Algorithm',
  eventTime: 'EventTime',
  distance: 'Distance',
  threshold: 'Threshold',
  windowStart: 'WindowStart',
  windowEnd: 'WindowEnd',
  word: 'Word',
  rank: 'Rank',
} as const;

/** SAX discord parameters shared by the alert builder and the threshold helper. */
export interface SaxDiscordParams {
  windowSize: number;
  numDiscords: number;
  paaSize: number;
  alphabetSize: number;
  znormThreshold: number;
  candidateLimit: number;
}

export interface ActivatorSaxDiscordOptions extends SaxDiscordParams {
  /** Profile timeseries query bound as pure UTC (no offset). */
  timeseriesRef: string;
  /** Signals scanned independently for discords in the live search space. */
  tagIds: string[];
  /** Bin width KQL literal, e.g. '15m'. */
  binKql: string;
  /** Same bin width in seconds, for history/emit math. */
  binSeconds: number;
  /** Detection-window length in bins (integer >= windowSize). */
  detectionBins: number;
  /** Chosen run frequency in seconds. */
  frequencySeconds: number;
  /** Frozen discord-distance threshold; a recent window with nn_distance >= this fires the alert. */
  distanceThreshold: number;
}

/**
 * Build the self-contained Activator SAX-discord KQL. Runs `sax_discords` with a
 * positional detection window (most-recent detectionBins) over a now()-anchored
 * history window sized by {@link saxAnomalyHistoryBins}, then keeps only recent
 * discords whose nearest-neighbor distance meets the frozen threshold and whose
 * window END lands inside the newest incremental slice (frequency + one bin).
 * All bounds are relative UTC — no datetime literals, no timezone offset — so it
 * is safe to run on a fixed schedule. The distance threshold is a frozen
 * constant baked into the alert; re-calibrate manually with the threshold helper.
 */
export function buildActivatorSaxDiscordKql(o: ActivatorSaxDiscordOptions): ActivatorKql {
  const c = SAX_ANOMALY_ACTIVATOR_COLUMNS;
  const historyBins = saxAnomalyHistoryBins(o.detectionBins);
  const historySeconds = historyBins * o.binSeconds;
  const emitSeconds = o.frequencySeconds + o.binSeconds;

  const binding = activatorTimeseriesBinding(o.timeseriesRef);

  const queryString = `${binding}let _history = ${kqlInt(historySeconds)}s;
let _bin = ${o.binKql};
let _emit = ${kqlInt(emitSeconds)}s;
let _threshold = ${kqlNum(o.distanceThreshold)};
let _end = now();
let _start = _end - _history;
let SeriesTable = app_search_space(Timeseries, ${kqlStringArray(o.tagIds)}, _start, _end, _bin);
sax_discords(SeriesTable, ${kqlInt(o.windowSize)}, ${kqlInt(o.numDiscords)}, ${kqlInt(o.paaSize)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.znormThreshold)}, ${kqlInt(o.candidateLimit)}, ${kqlInt(o.detectionBins)})
| where nn_distance >= _threshold
| extend event_time = _start + end_index * _bin
| where event_time > _end - _emit
| project ${c.entity} = series_id, ${c.subjectTags} = series_id, ${c.algorithm} = 'sax_discords', ${c.eventTime} = event_time, ${c.distance} = nn_distance, ${c.threshold} = _threshold, ${c.windowStart} = start_index, ${c.windowEnd} = end_index, ${c.word} = word, ${c.rank} = rank`;

  return {
    queryString,
    subjectField: c.subjectTags,
    contextFields: [
      c.entity,
      c.algorithm,
      c.eventTime,
      c.distance,
      c.threshold,
      c.windowStart,
      c.windowEnd,
      c.word,
      c.rank,
    ],
    lookbackSeconds: historySeconds,
  };
}

export interface SaxDiscordThresholdOptions extends SaxDiscordParams {
  /** Profile timeseries query bound as pure UTC (no offset). */
  timeseriesRef: string;
  /** Signals scanned independently for discords in the live search space. */
  tagIds: string[];
  /** Bin width KQL literal, e.g. '15m'. */
  binKql: string;
  /** Same bin width in seconds, for the history math. */
  binSeconds: number;
  /** Detection-window length in bins — determines the history span (parity with the alert). */
  detectionBins: number;
  /** How many discords per signal to sample when estimating the baseline. Defaults to 20. */
  sampleDiscords?: number;
}

/** Distance columns returned by {@link buildSaxDiscordThresholdQuery}. */
export const SAX_THRESHOLD_COLUMNS = {
  p50: 'P50',
  p90: 'P90',
  p95: 'P95',
  max: 'MaxDistance',
  samples: 'Samples',
} as const;

/**
 * Authoring-time self-calibrating helper. Runs `sax_discords` over the SAME
 * now()-anchored history the alert uses (detection window OFF — whole range) and
 * returns nearest-neighbor distance percentiles across the search space. The UI
 * pre-fills the alert's distance threshold from a percentile (p90) of this
 * baseline. Not run at alert time — the chosen threshold is frozen into the
 * reflex definition.
 */
export function buildSaxDiscordThresholdQuery(o: SaxDiscordThresholdOptions): string {
  const t = SAX_THRESHOLD_COLUMNS;
  const historyBins = saxAnomalyHistoryBins(o.detectionBins);
  const historySeconds = historyBins * o.binSeconds;
  const sample = o.sampleDiscords ?? 20;

  const binding = activatorTimeseriesBinding(o.timeseriesRef);

  return `${binding}let _history = ${kqlInt(historySeconds)}s;
let _bin = ${o.binKql};
let _end = now();
let _start = _end - _history;
let SeriesTable = app_search_space(Timeseries, ${kqlStringArray(o.tagIds)}, _start, _end, _bin);
sax_discords(SeriesTable, ${kqlInt(o.windowSize)}, ${kqlInt(sample)}, ${kqlInt(o.paaSize)}, ${kqlInt(o.alphabetSize)}, ${kqlNum(o.znormThreshold)}, ${kqlInt(o.candidateLimit)}, 0)
| summarize ${t.p50} = percentile(nn_distance, 50), ${t.p90} = percentile(nn_distance, 90), ${t.p95} = percentile(nn_distance, 95), ${t.max} = max(nn_distance), ${t.samples} = count()`;
}
