/**
 * Canonical data model specification for the four KQL queries the app expects
 * from every Connection Profile. Used by the KqlQueryBuilder component to
 * display inline documentation and expected column tables, and to validate
 * preview results.
 */

/** Describes one expected output column for a canonical KQL query. */
export interface ColumnSpec {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** Full specification for one canonical query (hierarchy / metadata / events / timeseries). */
export interface CanonicalQuerySpec {
  key: 'hierarchy' | 'metadata' | 'events' | 'timeseries';
  label: string;
  description: string;
  columns: ColumnSpec[];
}

/** Canonical query specifications — shown in the KqlQueryBuilder help panel. */
export const CANONICAL_SPECS: Record<CanonicalQuerySpec['key'], CanonicalQuerySpec> = {
  hierarchy: {
    key: 'hierarchy',
    label: 'Signal Hierarchy',
    description:
      'Returns the full signal catalog with up to ten hierarchy levels. Every row is one signal. ' +
      'The SignalId column must uniquely identify the signal and must match the SignalId produced ' +
      'by the Metadata query so the two can be joined.',
    columns: [
      { name: 'SignalId',   type: 'string',  required: true,  description: 'Unique signal identifier. Used as the join key between all four canonical queries.' },
      { name: 'SignalName', type: 'string',  required: true,  description: 'Human-readable display name shown in the signal browser.' },
      { name: 'Level1',     type: 'string',  required: false, description: 'First hierarchy grouping level (e.g. Plant, Site, Region).' },
      { name: 'Level2',     type: 'string',  required: false, description: 'Second hierarchy grouping level (e.g. Factory, Building).' },
      { name: 'Level3',     type: 'string',  required: false, description: 'Third hierarchy grouping level (e.g. Line, Floor).' },
      { name: 'Level4',     type: 'string',  required: false, description: 'Fourth hierarchy grouping level (e.g. Station, Unit).' },
      { name: 'Level5',     type: 'string',  required: false, description: 'Fifth hierarchy grouping level.' },
      { name: 'Level6',     type: 'string',  required: false, description: 'Sixth hierarchy grouping level.' },
      { name: 'Level7',     type: 'string',  required: false, description: 'Seventh hierarchy grouping level.' },
      { name: 'Level8',     type: 'string',  required: false, description: 'Eighth hierarchy grouping level.' },
      { name: 'Level9',     type: 'string',  required: false, description: 'Ninth hierarchy grouping level.' },
      { name: 'Level10',    type: 'string',  required: false, description: 'Tenth hierarchy grouping level.' },
    ],
  },

  metadata: {
    key: 'metadata',
    label: 'Signal Metadata',
    description:
      'Returns engineering metadata for each signal: metric type, units of measure, and description. ' +
      'SignalId must match the SignalId from the Hierarchy query.',
    columns: [
      { name: 'SignalId',          type: 'string', required: true,  description: 'Unique signal identifier matching the Hierarchy query.' },
      { name: 'MetricName',        type: 'string', required: true,  description: 'Metric/measurement name (e.g. Temperature, Pressure).' },
      { name: 'UnitOfMeasure',     type: 'string', required: false, description: 'Engineering units (e.g. °C, bar, rpm).' },
      { name: 'SamplingFrequency', type: 'string', required: false, description: 'Sampling frequency as a human-readable string (e.g. "1 min", "1 hz").' },
      { name: 'Description',       type: 'string', required: false, description: 'Free-text description of the signal.' },
    ],
  },

  events: {
    key: 'events',
    label: 'Events',
    description:
      'Returns point events and time-span events (alarms, work orders, maintenance periods, …). ' +
      'EndTimestamp is optional — null/missing means the event is a point event.',
    columns: [
      { name: 'EventId',        type: 'string',   required: true,  description: 'Unique event identifier.' },
      { name: 'ScopeId',        type: 'string',   required: true,  description: 'The signal or asset the event belongs to.' },
      { name: 'ScopeType',      type: 'string',   required: true,  description: 'Category of the scope (e.g. "Tag", "Asset").' },
      { name: 'StartTimestamp', type: 'datetime', required: true,  description: 'Event start (or occurrence) time.' },
      { name: 'EndTimestamp',   type: 'datetime', required: false, description: 'Event end time. Null for point events.' },
      { name: 'EventType',      type: 'string',   required: false, description: 'Event category (e.g. Alarm, Maintenance).' },
      { name: 'Title',          type: 'string',   required: true,  description: 'Short display title shown in the events table.' },
      { name: 'Detail',         type: 'string',   required: false, description: 'Optional extended detail / description.' },
    ],
  },

  timeseries: {
    key: 'timeseries',
    label: 'Time Series',
    description:
      'Returns raw (or pre-aggregated) time-series samples. All analytical queries ' +
      '(explore, forecast, similarity, discords) are built on top of this query using ' +
      'a `let Timeseries = (…)` binding. SignalId must match the Hierarchy and Metadata queries.',
    columns: [
      { name: 'Timestamp', type: 'datetime', required: true, description: 'Sample timestamp (UTC).' },
      { name: 'SignalId',  type: 'string',   required: true, description: 'Signal identifier matching the Hierarchy query.' },
      { name: 'Value',     type: 'real',     required: true, description: 'Numeric sample value.' },
    ],
  },
};

/**
 * Spec for a *wide* time-series base query. Unlike the narrow specs above, a wide
 * table has two fixed columns plus any number of arbitrarily-named `real` value
 * columns (>= 2). The app unpivots it to the canonical narrow shape at query time:
 * `SignalId = SignalIdPrefix + <delimiter> + <value-column name>`. Reuses the
 * 'timeseries' key so the KqlQueryBuilder treats it as the time-series editor.
 */
export const WIDE_TIMESERIES_SPEC: CanonicalQuerySpec = {
  key: 'timeseries',
  label: 'Time Series (wide)',
  description:
    'Returns wide time-series rows: one row per (SignalIdPrefix, Timestamp) with two or more ' +
    'real value columns. The app unpivots this to the canonical narrow shape at query time, ' +
    'building SignalId = SignalIdPrefix + <delimiter> + <value-column name>. The two fixed ' +
    'columns must be named exactly "SignalIdPrefix" and "Timestamp"; all other columns are ' +
    'treated as value columns.',
  columns: [
    { name: 'SignalIdPrefix', type: 'string',   required: true, description: 'Fixed name. Prefix shared by every value column in the row; combined with the delimiter and a value-column name to form the canonical SignalId.' },
    { name: 'Timestamp',      type: 'datetime', required: true, description: 'Fixed name. Sample timestamp (UTC).' },
    { name: '<value columns>', type: 'real',    required: true, description: 'Two or more arbitrarily-named real columns. Each becomes one signal (SignalIdPrefix + delimiter + column name) after unpivot.' },
  ],
};
