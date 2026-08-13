/**
 * Connection Profile client logic: type definitions, default values, and
 * CRUD helpers backed by the Rayfin data API (client.data.ConnectionProfile).
 * A Connection Profile binds an Eventhouse endpoint + database to four
 * canonical KQL queries and a set of display-label overrides so the app can
 * work with any Eventhouse schema without code changes.
 */

import { client, getFabricAccountId } from './rayfinClient';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Display-label overrides for the active schema's terminology. */
export interface ProfileLabels {
  entityLabel: string;
  metricIdLabel: string;
  level1Label: string;
  level2Label: string;
  level3Label: string;
  level4Label: string;
  level5Label: string;
  level6Label: string;
  level7Label: string;
  level8Label: string;
  level9Label: string;
  level10Label: string;
  unitOfMeasureLabel: string;
  samplingFrequencyLabel: string;
}

/** A connection profile as used throughout the client code. */
export interface ConnectionProfile {
  id: string;
  userId: string;
  name: string;
  /** Optional free-text description of what this data represents; shown to the agent. */
  description?: string;
  eventhouseQueryUri: string;
  databaseName: string;
  fabricWorkspaceId?: string;
  eventhouseId?: string;
  kqlDatabaseId?: string;
  hierarchyQuery: string;
  metadataQuery: string;
  eventsQuery: string;
  timeseriesQuery: string;
  /**
   * When true, `timeseriesQuery` is a *wide* base query (fixed `SignalIdPrefix`
   * + `Timestamp` columns plus >= 2 real value columns) unpivoted to the narrow
   * canonical shape at query time. When false/undefined the query is narrow.
   */
  timeseriesIsWide?: boolean;
  /** Delimiter joining SignalIdPrefix + value-column name into a SignalId (wide mode). */
  signalIdDelimiter?: string;
  labels: ProfileLabels;
  lastUsedAt?: Date;
  createdAt: Date;
}

/**
 * Options forwarded to executeKql / queryRows to override the default
 * Eventhouse endpoint and database from the environment. When a connection
 * profile is active, these come from profileToKqlOpts(profile).
 */
export interface KqlOptions {
  queryUri?: string;
  db?: string;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

export const DEFAULT_LABELS: ProfileLabels = {
  entityLabel: 'Asset',
  metricIdLabel: 'Tag',
  level1Label: 'Plant',
  level2Label: 'Factory',
  level3Label: 'Line',
  level4Label: 'Station',
  level5Label: 'Level 5',
  level6Label: 'Level 6',
  level7Label: 'Level 7',
  level8Label: 'Level 8',
  level9Label: 'Level 9',
  level10Label: 'Level 10',
  unitOfMeasureLabel: 'Engineering Units',
  samplingFrequencyLabel: 'Sampling Frequency',
};

export const DEFAULT_HIERARCHY_QUERY = `TagHierarchy
| join kind=leftouter (TagMetadata | project TagId, TagName) on TagId
| project SignalId=TagId, SignalName=TagName, Level1=Plant, Level2=Factory, Level3=Line, Level4=Station`;

export const DEFAULT_METADATA_QUERY = `TagMetadata
| project SignalId=TagId, MetricName=Metric, UnitOfMeasure=EngUnits, Description=Description`;

/**
 * Reference template for surfacing governed Signal Metadata into the metadata base
 * query. The `SignalMetadata` RayFin table (Fabric App SQL DB) is mirrored to
 * OneLake and exposed in the Eventhouse as an external table (OneLake shortcut),
 * here named `SignalMetadataExternal`. A `leftouter` join keeps every catalog tag
 * even when it has no governed record, and the projected columns line up 1:1 with
 * the `column_ifexists` reads in `listTagsFromProfile` (src/lib/tags.ts) — so a
 * profile whose Eventhouse lacks the shortcut still works unchanged (the columns are
 * simply absent and fall back to null). Only the newest approved (or draft, if none
 * approved) non-retired version per signal should be exposed; the recommended
 * pattern is to define `SignalMetadataExternal` as a view/function that filters to
 * the effective row. Copy this into the profile's metadata query when the shortcut
 * is configured.
 *
 * **Multi-profile filter.** Because one shared RayFin SQL DB is mirrored once and
 * surfaced through a single `SignalMetadataExternal`, the template filters
 * `scope_key == _ConnectionProfileId` so a profile only sees the governed records
 * authored under it. `_ConnectionProfileId` is a `let` binding the KQL builders
 * prepend at query time (see `profileIdBinding` in src/lib/kql.ts) — do not
 * hard-code a profile id here.
 */
export const METADATA_QUERY_WITH_SIGNAL_METADATA = `TagMetadata
| project SignalId=TagId, MetricName=Metric, UnitOfMeasure=EngUnits, Description=Description
| join kind=leftouter (
    SignalMetadataExternal
    | where scope_key == _ConnectionProfileId
    | where status != "retired"
    | summarize arg_max(version, *) by signal_id
    | project SignalId=signal_id,
        OperatingSetpoint=operating_setpoint,
        UpperOperatingLimit=upper_operating_limit,
        LowerOperatingLimit=lower_operating_limit,
        MaxRateOfChange=max_rate_of_change,
        USL=usl, LSL=lsl, Target=target,
        PhysicalMin=physical_min, PhysicalMax=physical_max,
        SensorUncertainty=sensor_uncertainty,
        ActiveBaselineId=active_baseline_id,
        PreferredChartType=preferred_chart_type,
        RuleProfile=rule_profile,
        RecommendedAlertThreshold=recommended_alert_threshold,
        RecommendedConfidence=recommended_confidence
  ) on SignalId`;

/**
 * **Legacy / optional.** Reference template for UNIONing app-authored annotations
 * into the profile's Events query server-side in KQL.
 *
 * As of the SQL-DB annotation read path, this is **no longer required** and is
 * kept only for backward compatibility. The app now loads annotations directly
 * from the RayFin/DAB SQL DB — server-side filtered by profile, scope, and time
 * range — and merges them into the timeline client-side (see
 * `loadAnnotationMarkers` / `loadTimeline` in src/lib/annotations.ts). This
 * removes the need to stand up an `AnnotationsExternal` external table and hand-
 * wire it into every profile's Events query, and it makes new annotations appear
 * immediately rather than after OneLake-mirror latency. `loadTimeline`
 * de-duplicates by marker id, so a profile that still uses this template won't
 * double-count: the SQL-sourced annotation wins over the KQL-sourced copy.
 *
 * If you do use it: configure an `AnnotationsExternal` external table or shortcut
 * in Eventhouse that exposes the RayFin `Annotation` table, then paste this into
 * the connection profile's events query.
 *
 * `scope_id` maps straight to `ScopeId`: the tag id for `scope_type="TagId"`,
 * or the full '/'-joined hierarchy path through that level for `Level1".."LevelN"`
 * scopes (matching the same convention as the Events table). Each path segment
 * is percent-escaped (`%`→`%25`, `/`→`%2F`) before joining, so a level value
 * containing `/` or `%` can't be confused with a path boundary.
 *
 * **Multi-profile filter.** One shared RayFin SQL DB is mirrored once and surfaced
 * through a single `AnnotationsExternal`, so the template filters
 * `connection_profile_id == _ConnectionProfileId` to keep one profile's annotations
 * off another's timeline. `_ConnectionProfileId` is a `let` binding the KQL builders
 * prepend at query time (see `profileIdBinding` in src/lib/kql.ts) — do not
 * hard-code a profile id here.
 */
export const EVENTS_QUERY_WITH_ANNOTATIONS = `Events
| project EventId, ScopeId, ScopeType, StartTimestamp=Timestamp, EndTimestamp, EventType, Title, Detail, Source="Event", UserId=""
| union (
    AnnotationsExternal
    | where connection_profile_id == _ConnectionProfileId
    | project EventId=id, ScopeId=scope_id, ScopeType=scope_type, StartTimestamp=timestamp, EndTimestamp=end_timestamp, EventType=annotation_type, Title=title, Detail=detail, Source="Annotation", UserId=user_id
  )`;

export const DEFAULT_EVENTS_QUERY = `Events
| project EventId, ScopeId, ScopeType, StartTimestamp=Timestamp, EndTimestamp, EventType, Title, Detail`;

export const DEFAULT_TIMESERIES_QUERY = `Timeseries
| project Timestamp, SignalId=TagId, Value`;

/** Default Signal Id delimiter for wide time-series profiles. */
export const DEFAULT_SIGNAL_ID_DELIMITER = '-';

/** Maximum length of a Signal Id delimiter. */
export const MAX_SIGNAL_ID_DELIMITER_LENGTH = 3;

/**
 * Starter template for a *wide* time-series base query. A wide table has one row
 * per (SignalIdPrefix, Timestamp) with any number of real-typed value columns;
 * the app unpivots it to the canonical narrow shape at query time. The two fixed
 * column names (`SignalIdPrefix`, `Timestamp`) are required; add >= 2 value columns.
 */
export const DEFAULT_WIDE_TIMESERIES_QUERY = `WideTimeseries
| project SignalIdPrefix=AssetId, Timestamp, Temperature, Pressure, FlowRate`;

// ---------------------------------------------------------------------------
// Retrofit (companion-database) source templates
// ---------------------------------------------------------------------------

/**
 * Sentinel replaced with the customer's existing source KQL database name when
 * generating retrofit profile queries. See {@link buildRetrofitSourceQueries}.
 */
export const SOURCE_DB_PLACEHOLDER = '<SourceDatabase>';

/**
 * Retrofit deployment pattern (see docs/runbook.md §1 and the
 * `Retrofit-Eventhouse.ps1` tool): the app's functions, result tables and OneLake
 * external tables live in a dedicated **companion** KQL database, while the raw
 * sensor tables stay untouched in the customer's existing **source** database on
 * the same Eventhouse. The connection profile therefore points at the companion
 * database, and its four canonical queries read the source tables cross-database
 * via `database("<SourceDatabase>").<Table>` (same cluster, so the reference
 * resolves). The signed-in identity needs Database Viewer on both databases.
 *
 * These templates assume the stock Contoso source schema (`Timeseries`,
 * `TagMetadata`, `TagHierarchy`, `Events`); adapt the projections to the real
 * source column names when they differ. `buildRetrofitSourceQueries(db)`
 * substitutes the source database name into all four.
 */
export const RETROFIT_TIMESERIES_QUERY = `database("${SOURCE_DB_PLACEHOLDER}").Timeseries
| project Timestamp, SignalId=TagId, Value`;

export const RETROFIT_HIERARCHY_QUERY = `database("${SOURCE_DB_PLACEHOLDER}").TagHierarchy
| join kind=leftouter (database("${SOURCE_DB_PLACEHOLDER}").TagMetadata | project TagId, TagName) on TagId
| project SignalId=TagId, SignalName=TagName, Level1=Plant, Level2=Factory, Level3=Line, Level4=Station`;

export const RETROFIT_METADATA_QUERY = `database("${SOURCE_DB_PLACEHOLDER}").TagMetadata
| project SignalId=TagId, MetricName=Metric, UnitOfMeasure=EngUnits, Description=Description`;

export const RETROFIT_EVENTS_QUERY = `database("${SOURCE_DB_PLACEHOLDER}").Events
| project EventId, ScopeId, ScopeType, StartTimestamp=Timestamp, EndTimestamp, EventType, Title, Detail`;

/** The four canonical connection-profile queries. */
export interface ProfileQuerySet {
  hierarchyQuery: string;
  metadataQuery: string;
  eventsQuery: string;
  timeseriesQuery: string;
}

/**
 * Produce a retrofit profile query set that reads the customer's raw tables from
 * `sourceDatabase` cross-database. The source database name is validated to a
 * KQL-safe identifier (letters, digits, `_`, `-`, space) so it can't break out of
 * the `database("…")` reference. Callers still edit the projections to match the
 * real source column names before saving.
 */
export function buildRetrofitSourceQueries(sourceDatabase: string): ProfileQuerySet {
  const db = sourceDatabase.trim();
  if (!db) throw new Error('A source database name is required to build retrofit queries.');
  if (!/^[A-Za-z0-9 _-]+$/.test(db)) {
    throw new Error(
      `Invalid source database name "${sourceDatabase}". Use only letters, digits, spaces, "_" or "-".`,
    );
  }
  const sub = (t: string): string => t.split(SOURCE_DB_PLACEHOLDER).join(db);
  return {
    hierarchyQuery: sub(RETROFIT_HIERARCHY_QUERY),
    metadataQuery: sub(RETROFIT_METADATA_QUERY),
    eventsQuery: sub(RETROFIT_EVENTS_QUERY),
    timeseriesQuery: sub(RETROFIT_TIMESERIES_QUERY),
  };
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function parseLabels(json: string): ProfileLabels {
  try {
    const raw = JSON.parse(json) as Partial<ProfileLabels>;
    return { ...DEFAULT_LABELS, ...raw };
  } catch {
    return { ...DEFAULT_LABELS };
  }
}

interface DbRow {
  id: string;
  user_id: string;
  name: string;
  description?: string | null;
  eventhouse_query_uri: string;
  database_name: string;
  fabric_workspace_id?: string | null;
  eventhouse_id?: string | null;
  kql_database_id?: string | null;
  hierarchy_query: string;
  metadata_query: string;
  events_query: string;
  timeseries_query: string;
  timeseries_is_wide?: boolean | null;
  signal_id_delimiter?: string | null;
  labels_json: string;
  last_used_at?: Date | string | null;
  created_at: Date | string;
}

function fromRow(r: DbRow): ConnectionProfile {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    description: r.description ?? undefined,
    eventhouseQueryUri: r.eventhouse_query_uri,
    databaseName: r.database_name,
    fabricWorkspaceId: r.fabric_workspace_id ?? undefined,
    eventhouseId: r.eventhouse_id ?? undefined,
    kqlDatabaseId: r.kql_database_id ?? undefined,
    hierarchyQuery: r.hierarchy_query,
    metadataQuery: r.metadata_query,
    eventsQuery: r.events_query,
    timeseriesQuery: r.timeseries_query,
    timeseriesIsWide: r.timeseries_is_wide ?? undefined,
    signalIdDelimiter: r.signal_id_delimiter ?? undefined,
    labels: parseLabels(r.labels_json),
    lastUsedAt:
      r.last_used_at != null
        ? r.last_used_at instanceof Date
          ? r.last_used_at
          : new Date(r.last_used_at)
        : undefined,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as string),
  };
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/** List all connection profiles for the current user, MRU first. */
export async function listProfiles(): Promise<ConnectionProfile[]> {
  const rows = await client.data.ConnectionProfile.select([
    'id',
    'user_id',
    'name',
    'description',
    'eventhouse_query_uri',
    'database_name',
    'fabric_workspace_id',
    'eventhouse_id',
    'kql_database_id',
    'hierarchy_query',
    'metadata_query',
    'events_query',
    'timeseries_query',
    'timeseries_is_wide',
    'signal_id_delimiter',
    'labels_json',
    'last_used_at',
    'created_at',
  ]).execute();

  return (rows as DbRow[])
    .map(fromRow)
    .sort((a, b) => {
      const at = a.lastUsedAt?.getTime() ?? a.createdAt.getTime();
      const bt = b.lastUsedAt?.getTime() ?? b.createdAt.getTime();
      return bt - at;
    });
}

/** Create a new connection profile. Returns the created row's id. */
export async function saveProfile(
  data: Omit<ConnectionProfile, 'id' | 'userId' | 'createdAt' | 'lastUsedAt'>,
): Promise<string> {
  const userId = getFabricAccountId();
  if (!userId) throw new Error('Sign in with Fabric before saving a connection profile.');
  const id = crypto.randomUUID();
  await client.data.ConnectionProfile.create({
    id,
    user_id: userId,
    name: data.name,
    description: data.description ?? undefined,
    eventhouse_query_uri: data.eventhouseQueryUri,
    database_name: data.databaseName,
    fabric_workspace_id: data.fabricWorkspaceId ?? undefined,
    eventhouse_id: data.eventhouseId ?? undefined,
    kql_database_id: data.kqlDatabaseId ?? undefined,
    hierarchy_query: data.hierarchyQuery,
    metadata_query: data.metadataQuery,
    events_query: data.eventsQuery,
    timeseries_query: data.timeseriesQuery,
    timeseries_is_wide: data.timeseriesIsWide ?? undefined,
    signal_id_delimiter: data.signalIdDelimiter ?? undefined,
    labels_json: JSON.stringify(data.labels),
    created_at: new Date(),
  });
  return id;
}

/** Update an existing connection profile. */
export async function updateProfile(
  id: string,
  data: Partial<Omit<ConnectionProfile, 'id' | 'userId' | 'createdAt'>>,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.eventhouseQueryUri !== undefined) patch.eventhouse_query_uri = data.eventhouseQueryUri;
  if (data.databaseName !== undefined) patch.database_name = data.databaseName;
  if (data.fabricWorkspaceId !== undefined) patch.fabric_workspace_id = data.fabricWorkspaceId;
  if (data.eventhouseId !== undefined) patch.eventhouse_id = data.eventhouseId;
  if (data.kqlDatabaseId !== undefined) patch.kql_database_id = data.kqlDatabaseId;
  if (data.hierarchyQuery !== undefined) patch.hierarchy_query = data.hierarchyQuery;
  if (data.metadataQuery !== undefined) patch.metadata_query = data.metadataQuery;
  if (data.eventsQuery !== undefined) patch.events_query = data.eventsQuery;
  if (data.timeseriesQuery !== undefined) patch.timeseries_query = data.timeseriesQuery;
  if (data.timeseriesIsWide !== undefined) patch.timeseries_is_wide = data.timeseriesIsWide;
  if (data.signalIdDelimiter !== undefined) patch.signal_id_delimiter = data.signalIdDelimiter;
  if (data.labels !== undefined) patch.labels_json = JSON.stringify(data.labels);
  if (data.lastUsedAt !== undefined) patch.last_used_at = data.lastUsedAt;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.data.ConnectionProfile.update({ id } as any, patch as any);
}

/** Delete a connection profile by id. */
export async function deleteProfile(id: string): Promise<void> {
  await client.data.ConnectionProfile.delete({ id });
}

/** Stamp the last_used_at timestamp for a profile (call on Connect). */
export async function markProfileUsed(id: string): Promise<void> {
  await updateProfile(id, { lastUsedAt: new Date() });
}

// ---------------------------------------------------------------------------
// KQL options helper
// ---------------------------------------------------------------------------

/** Derive KqlOptions from a connection profile so it can be passed to executeKql / queryRows. */
export function profileToKqlOpts(profile: ConnectionProfile): KqlOptions {
  return {
    queryUri: profile.eventhouseQueryUri || undefined,
    db: profile.databaseName || undefined,
  };
}
