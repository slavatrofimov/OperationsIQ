---
id: data-model
title: Data model
sidebar_position: 4
---

# Data model (Rayfin entities)

User-facing state is persisted to Fabric SQL via Rayfin. The model is defined as
TypeScript classes with `@entity` / `@role` decorators in
`OperationsIQApp/rayfin/data/*.ts`, with the assembled schema in `schema.ts`.
Running `rayfin up db apply` generates the Fabric SQL schema and the GraphQL API
from these entities.

## Core entities

| Entity | Purpose |
| --- | --- |
| `DataSource` | A configured source / connection to time-series data. |
| `Signal` | A tag/measurement known to the app. |
| `SignalMetadata` | Governed per-tag limits, setpoints, ranges, monitoring defaults (versioned). |
| `SpcBaseline` | A saved SPC baseline (mean + limits) bound to a signal. |
| `AnalysisJob` | A Matrix Profile / Spark job and its lifecycle status. |
| `ResultArtifact` | Outputs produced by an analysis job. |
| `Label` / `LabelCategory` | User labels for patterns and their taxonomy. |
| `Investigation` | A named case study. |
| `Evidence` / `EvidenceArtifact` | Captured page snapshots, charts (PNG), data (CSV), notes. |

## Additional entities

The schema (`schema.ts`) assembles **21 entities** in total. Beyond the core set
above:

| Entity | Purpose |
| --- | --- |
| `ConnectionProfile` | Binds an Eventhouse endpoint + database to the four user-written KQL queries (hierarchy, metadata, events, timeseries) and display-label overrides — one profile per Eventhouse schema. |
| `SavedView` | A saved Exploration view (tags, time range, visualization settings) serialized in `config_json`. |
| `SavedDerivedMetric` | A saved Derived-metric definition (base tags, formula, post-transform, binning budget). |
| `Annotation` | A user-authored timeline annotation stored in SQL (contrast with `Events`, which live in the KQL DB). |
| `ScenarioRun` | A saved what-if scenario run (baseline clone + adjustments over a window). |
| `ModelOutput` | Traceability record for every derived/model output (forecasts, anomalies, root-cause hypotheses, scenario runs, validations). |
| `VsmModel` / `VsmModelTerm` | Metadata and term weights for a trained SAX-VSM classifier; terms are materialized into an inline KQL `datatable` at classify time. |
| `AlertRule` / `AlertEvent` | A standing alert definition and its fired occurrences (acknowledge / triage lifecycle). |

## Conventions

- Add or change entities in `rayfin/data/`, then regenerate with
  `rayfin up db apply`.
- Writes flow through `RayfinClient` (GraphQL); the browser never writes to the
  Eventhouse.
- `AnalysisJob` status transitions are constrained
  (`QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED`); the optional dispatcher's
  state machine enforces legal transitions.

## Wide time-series profile fields

`ConnectionProfile` carries two optional columns (added in
`rayfin/data/ConnectionProfile.ts`; run `rayfin up db apply` after pulling) that
describe a **wide** time-series layout:

| Column (DB) | Client field | Type | Meaning |
| --- | --- | --- | --- |
| `timeseries_is_wide` | `timeseriesIsWide` | boolean, optional | When `true`, `timeseries_query` is a *wide* base query that the app unpivots to the canonical narrow shape at query time. When absent/`false`, the profile is narrow (unchanged behavior). |
| `signal_id_delimiter` | `signalIdDelimiter` | text, optional | The delimiter (≤ 3 chars, default `-`) joining `SignalIdPrefix` and a value-column name to form the canonical `SignalId`. Only meaningful when wide. |

No value-column list is persisted — the columns to unpivot are derived at query
time from the in-scope `SignalId`s (each is split on the first delimiter occurrence
into prefix + column). See `docs-site/docs/admin/configuration.md` for the authoring
rules and `OperationsIQApp/docs/design-spec.md` for the transform architecture.

## Connection-profile scoping

User-authored records that reference signals from a specific Eventhouse are scoped
to the **connection profile** they were created under, so switching profiles shows
only that profile's data. This is carried by an optional `connection_profile_id`
column (the active profile's Fabric id) on the scoped entities:

- `Label` (saved patterns), `AnalysisJob` (deep-discovery runs), `SavedView`
  (Explore views), `VsmModel` (classifier models), `Investigation`, `SpcBaseline`,
  and `Annotation` (timeline annotations). (`SavedDerivedMetric` uses its
  pre-existing `profile_id`; governed `SignalMetadata` uses `scope_key`.)

The data-client layer stamps `connection_profile_id` from
`getActiveProfileId()` (`src/lib/activeConnection.ts`, populated by
`ProfileContext`) on create, and **strictly** filters list reads to the active
profile — rows from other profiles, and legacy rows created before this column
existed (`connection_profile_id = null`), are hidden.

### Profile scoping (annotations & governed metadata)

`Annotation` and `SignalMetadata` are read **directly from the shared RayFin SQL DB**
and scoped to the active profile in the query itself, so one app instance can serve
many profiles off one database:

- **Annotations** load at timeline-load time via the DAB/GraphQL client, **server-side
  filtered** by `connection_profile_id`, the selected `(scope_type, scope_id)` pairs,
  and the query time window (`loadAnnotationMarkers` in `src/lib/annotations.ts`),
  then merged into the timeline alongside Eventhouse events (deduped by id).
- **Governed metadata** is filtered by `scope_key == <profileId>` and overlaid onto
  the catalog client-side (`getEffectiveSignalMetadata` in `src/lib/signalMetadata.ts`).

Because these paths are authoritative, the app does **not** require the SQL tables to
be surfaced into the Eventhouse. They can optionally be exposed as OneLake external
tables (`AnnotationsExternal`, `SignalMetadataExternal`) for KQL-side joins — see the
legacy `EVENTS_QUERY_WITH_ANNOTATIONS` and the still-supported
`METADATA_QUERY_WITH_SIGNAL_METADATA` templates in `src/lib/connectionProfile.ts` —
but that wiring is optional and `Validate components` no longer probes for it. A
profile whose Events query still UNIONs `external_table("Annotations")` won't
double-count: the SQL-sourced annotation wins the id dedupe.

:::warning Redeploy + legacy data
Adding `connection_profile_id` requires a Fabric SQL redeploy (`rayfin up db
apply`) before the app can read it. Because filtering is strict, **existing rows
created before profile scoping disappear from the lists until they are re-created
under a profile** (they are not deleted — just no longer surfaced).
:::

## Related

- [Frontend architecture](./frontend-architecture) — how the client reads/writes.
- [Admin → Rayfin backend](/admin/rayfin-backend) — provisioning and applying schema.
