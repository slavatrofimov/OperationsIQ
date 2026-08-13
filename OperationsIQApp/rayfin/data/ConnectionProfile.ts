import { entity, role, uuid, text, date, boolean } from '@microsoft/rayfin-core';

/**
 * Persisted connection profile: binds an Eventhouse endpoint + database to
 * four user-written KQL queries (hierarchy, metadata, events, timeseries) and
 * a set of display-label overrides. One profile = one Eventhouse schema the app
 * can talk to. Row-level security: only the owning user can read/write.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ConnectionProfile {
  @uuid() id!: string;
  @text() user_id!: string;
  @text() name!: string;
  /** Optional free-text description of what this data represents (surfaced to the agent). */
  @text({ optional: true }) description?: string;
  @text() eventhouse_query_uri!: string;
  @text() database_name!: string;
  /** Fabric workspace id hosting the source Eventhouse/KQL DB (captured during Discover from Fabric). */
  @text({ optional: true }) fabric_workspace_id?: string;
  /** Fabric item id of the source Eventhouse (captured during Discover from Fabric). */
  @text({ optional: true }) eventhouse_id?: string;
  /** Fabric item id of the source KQL database; used as eventhouseItem.itemId in Activator alerts. */
  @text({ optional: true }) kql_database_id?: string;
  @text() hierarchy_query!: string;
  @text() metadata_query!: string;
  @text() events_query!: string;
  @text() timeseries_query!: string;
  /**
   * When true, `timeseries_query` is a *wide* base query emitting a fixed
   * `SignalIdPrefix` (string) + `Timestamp` (datetime) plus >= 2 arbitrarily
   * named real-typed value columns. The app unpivots it to the canonical narrow
   * shape at query time. When false/absent the query is narrow (SignalId,
   * Timestamp, Value).
   */
  @boolean({ optional: true }) timeseries_is_wide?: boolean;
  /**
   * Delimiter (<= 3 chars, default "-") joining `SignalIdPrefix` and a value
   * column name to form a canonical `SignalId`. Must not occur in any prefix or
   * value-column name. Only meaningful when `timeseries_is_wide` is true.
   */
  @text({ optional: true }) signal_id_delimiter?: string;
  /** JSON-serialised ProfileLabels object. */
  @text() labels_json!: string;
  @date({ optional: true }) last_used_at?: Date;
  @date() created_at!: Date;
}
