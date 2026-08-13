/**
 * Module-level singleton holding the connection settings of the currently
 * active Connection Profile. This lets the low-level query layer
 * (eventhouse.executeKql) and the KQL builders (kql.ts) target the active
 * profile's Eventhouse cluster/database and timeseries schema WITHOUT every
 * page having to thread the profile through props.
 *
 * ProfileContext is the single writer: it calls {@link setActiveConnection}
 * whenever the active profile changes (and {@link clearActiveConnection} when
 * it is cleared). Readers only ever read. Explicit per-call overrides always
 * win over this fallback, so ConfigPage's Test Connection / preview and Fabric
 * discovery — which pass their own KqlOptions — are unaffected.
 */

import type { KqlOptions } from './connectionProfile';

interface ActiveConnection {
  kqlOpts: KqlOptions;
  /**
   * The active profile's id. Lets the data-client layer (Rayfin `client.data.*`)
   * stamp user-authored records with, and strictly filter reads by, the owning
   * profile WITHOUT every page threading the profile through props.
   */
  profileId?: string;
  /** The active profile's timeseries query, used as a `let Timeseries = (…)` ref. */
  timeseriesRef?: string;
  /**
   * True when `timeseriesRef` is a *wide* base query that the KQL builders must
   * unpivot to the narrow canonical shape at query time.
   */
  timeseriesIsWide?: boolean;
  /** Delimiter joining SignalIdPrefix + value-column name into a SignalId (wide mode). */
  signalIdDelimiter?: string;
  /** The active profile's hierarchy query, used as a `let Hierarchy = (…)` ref. */
  hierarchyRef?: string;
  /** The active profile's metadata query, used as a `let Metadata = (…)` ref. */
  metadataRef?: string;
  /** The active profile's events query, used as a `let Events = (…)` ref. */
  eventsRef?: string;
}

let current: ActiveConnection | null = null;

/** Set the active connection settings. Called by ProfileContext on switch. */
export function setActiveConnection(conn: ActiveConnection | null): void {
  current = conn;
}

/** Clear the active connection settings (no active profile). */
export function clearActiveConnection(): void {
  current = null;
}

/**
 * The active profile's KqlOptions, or undefined when no profile is active (so
 * queries fall back to the env-default cluster/database).
 */
export function getActiveKqlOpts(): KqlOptions | undefined {
  return current?.kqlOpts;
}

/**
 * The active profile's id, used by the data-client layer to stamp new
 * user-authored records and to strictly filter reads to the owning profile.
 * Undefined when no profile is active (callers then skip profile filtering).
 */
export function getActiveProfileId(): string | undefined {
  return current?.profileId;
}

/**
 * The active profile's timeseries query, used by kql.ts builders to `let`-bind
 * a custom `Timeseries` source. Undefined when no profile is active or the
 * profile has no custom timeseries query.
 */
export function getActiveTimeseriesRef(): string | undefined {
  return current?.timeseriesRef;
}

/**
 * True when the active profile's timeseries query is *wide* (fixed
 * `SignalIdPrefix` + `Timestamp` columns plus real value columns) and must be
 * unpivoted to the canonical narrow shape at query time. False/undefined for
 * narrow profiles or when no profile is active.
 */
export function getActiveTimeseriesIsWide(): boolean {
  return current?.timeseriesIsWide === true;
}

/**
 * The active profile's Signal Id delimiter (wide mode). Joins `SignalIdPrefix`
 * and a value-column name into a canonical `SignalId`. Undefined when no profile
 * is active or the profile is narrow.
 */
export function getActiveSignalIdDelimiter(): string | undefined {
  return current?.signalIdDelimiter;
}

/**
 * The active profile's hierarchy query, used by kql.ts builders to `let`-bind a
 * canonical `Hierarchy` source (SignalId + Level1..Level10). Undefined when no
 * profile is active.
 */
export function getActiveHierarchyRef(): string | undefined {
  return current?.hierarchyRef;
}

/**
 * The active profile's metadata query, used by kql.ts builders to `let`-bind a
 * canonical `Metadata` source (SignalId + MetricName + UnitOfMeasure + …).
 * Undefined when no profile is active.
 */
export function getActiveMetadataRef(): string | undefined {
  return current?.metadataRef;
}

/**
 * The active profile's events query, used by kql.ts builders to `let`-bind a
 * canonical `Events` source (EventId, ScopeId, ScopeType, StartTimestamp, …).
 * Undefined when no profile is active.
 */
export function getActiveEventsRef(): string | undefined {
  return current?.eventsRef;
}
