---
id: configuration
title: Configuration
sidebar_position: 8
---

# Configuration

The app reads its config from Vite `VITE_*` variables. `assertEnv()` fails fast
at startup if any required value is missing, showing the **"Configuration
incomplete"** gate.

## Run locally

```powershell
Copy-Item .env.example .env.local   # then fill in the values
npm run dev                         # frontend vs. the remote Fabric backend
```

## Environment variables

| Variable | Source |
| --- | --- |
| `VITE_MSAL_CLIENT_ID` | Application (client) ID from the [Entra SPA registration](./entra-app-registration) |
| `VITE_MSAL_TENANT_ID` | Directory (tenant) ID from the Entra SPA registration |
| `VITE_EVENTHOUSE_QUERY_URI` | Eventhouse **System overview → Query URI** (no trailing slash / no path) |
| `VITE_EVENTHOUSE_DB` | KQL database name |
| `VITE_FABRIC_WORKSPACE_ID` | Workspace hosting the lakehouse + Eventhouse |
| `VITE_FABRIC_LAKEHOUSE_ID` | Lakehouse whose Livy endpoint runs Spark analyses |
| `VITE_FABRIC_ENVIRONMENT_ID` | *(optional)* Spark Environment for extra libraries |
| `VITE_RAYFIN_PUBLISHABLE_KEY` | **Required.** Rayfin client publishable key — written by `rayfin up` |
| `VITE_FABRIC_ITEM_ID`, `VITE_RAYFIN_*` | Written by `rayfin up` |

All of `VITE_RAYFIN_PUBLISHABLE_KEY`, `VITE_FABRIC_WORKSPACE_ID`,
`VITE_FABRIC_ITEM_ID`, `VITE_EVENTHOUSE_QUERY_URI`, `VITE_EVENTHOUSE_DB`,
`VITE_MSAL_CLIENT_ID`, and `VITE_MSAL_TENANT_ID` are **required** at startup (see
`REQUIRED_ENV` in `src/lib/env.ts`); missing any one triggers the "Configuration
incomplete" gate.

:::warning
`VITE_EVENTHOUSE_QUERY_URI` must be **just the cluster host** (e.g.
`https://<guid>.<region>.kusto.fabric.microsoft.com`). `env.ts` strips trailing
slashes and builds the MSAL scope as `<uri>/.default`.
:::

## Where to put the MSAL / Eventhouse values

`rayfin up` (and `rayfin env`) **regenerate `.env.local`** from the
`RAYFIN_PUBLIC_*` keys in `rayfin/.env`, so hand-edits to `.env.local` are
overwritten. Two supported options:

- **Project-root `.env` (recommended).** Rayfin never touches a plain `.env`, and
  Vite merges `.env` + `.env.local`. Put the four SPA/Eventhouse keys — with the
  exact `VITE_*` names above — in `.env` at the project root. They survive every
  `rayfin up`. (Add `.env` to `.gitignore` if you don't want the cluster URI
  committed; these are public SPA values, not secrets.)
- **`rayfin/.env` (single source of truth).** Add them with the `RAYFIN_PUBLIC_`
  prefix, but note the CLI renames unknown keys `RAYFIN_PUBLIC_<NAME>` →
  `VITE_RAYFIN_<NAME>`. So `RAYFIN_PUBLIC_MSAL_CLIENT_ID` becomes
  `VITE_RAYFIN_MSAL_CLIENT_ID`, and `src/lib/env.ts` + `src/lib/vite-env.d.ts`
  must be updated to read the `VITE_RAYFIN_*` names.

## Retrofit an existing Eventhouse (companion database)

To point the app at an Eventhouse that already holds a customer's sensor data — without
modifying their existing KQL databases — deploy the app's objects into a dedicated
**companion** KQL database on the same Eventhouse and read the raw tables
cross-database. Run `eventhouse/deploy/Retrofit-Eventhouse.ps1` (see the
[deploy runbook §1b](/admin/deploy-runbook) for parameters). It:

1. Creates the companion KQL DB via the Fabric Items REST API (idempotent).
2. Deploys the app functions, result/state tables, and the OneLake external tables —
   **not** the base data tables (those stay in the source database).
3. Validates every required component and prints ready-to-paste connection-profile
   queries that read the source DB via `database("<SourceDatabase>").<Table>`.

Grant the signing-in identity **Database Viewer** on both the companion and source
databases, and **Database Ingestor** on the companion database.

### One app instance, many profiles

Annotations and governed Signal Metadata live in a single shared RayFin SQL DB, and
each row is stamped with its owning profile (`connection_profile_id` on annotations,
`scope_key` on metadata) so a single deployment can serve many Eventhouses without
one profile's data leaking into another's views.

The app reads both **directly from that SQL DB** and filters by the active profile
in the query itself — so no Eventhouse wiring is required to keep profiles isolated:

- **Annotations** are fetched from the SQL DB at timeline-load time, server-side
  filtered by profile, scope, and time range, and merged into the exploration
  timeline alongside Eventhouse events. You do **not** need to stand up an
  `AnnotationsExternal` external table or UNION it into the profile's Events query;
  new annotations also appear immediately rather than after OneLake-mirror latency.
- **Signal Metadata** is overlaid client-side from the SQL DB on top of the catalog,
  with governed values winning. Exposing it in the Eventhouse (see below) is an
  optional convenience for KQL-side joins, not a requirement.

Because neither path depends on an Eventhouse external table, the **Validate
components** action no longer probes for `AnnotationsExternal` / `SignalMetadataExternal`.

### Narrow vs. wide time-series layout

The **Time Series** query has a **narrow / wide** toggle that describes how your
source table is physically shaped:

- **Narrow** (default) — one row per sample. The base query must emit the canonical
  `SignalId` (string), `Timestamp` (datetime), and `Value` (real) columns. Nothing
  else changes.
- **Wide** — one row per `(SignalIdPrefix, Timestamp)` carrying many measurements at
  once. The base query must emit two fixed columns named exactly **`SignalIdPrefix`**
  (string) and **`Timestamp`** (datetime), plus **at least two** arbitrarily-named
  `real` value columns. If you only have one value per signal, use narrow instead.

  | SignalIdPrefix | Timestamp | Temperature | Pressure |
  | --- | --- | --- | --- |
  | Pump7 | 08:00 | 72.4 | 13.1 |
  | Pump7 | 08:01 | 72.6 | 13.0 |

In wide mode the app unpivots the table to the canonical narrow shape **at query
time**, deriving the canonical signal id as:

```
SignalId = SignalIdPrefix + <Signal Id Delimiter> + <value-column name>
```

So the row above yields `Pump7-Temperature` and `Pump7-Pressure` when the delimiter
is the default `-`.

**Signal Id Delimiter.** Up to 3 characters (default `-`). Pick a delimiter that
**never** occurs inside a `SignalIdPrefix` value or a value-column name — otherwise
the split back into prefix + column is ambiguous. The editor's **Validate wide
schema** button runs a read-only `getschema` probe that confirms the two fixed
columns exist with the right types, that there are ≥ 2 numeric value columns, and
warns if the delimiter collides with any value-column name.

**Catalog convention (important).** The wide transform only rewrites the time-series
query. Your **Hierarchy** and **Metadata** queries are still authored by you and must
emit `SignalId` values that match the derived ids — i.e. `prefix + delimiter + column`
— so the catalog, metadata, and samples join correctly. There is no auto-generated
catalog for wide profiles.

**Bounded selections only.** Wide profiles require every analysis to run over an
explicitly-selected, bounded set of signals (the multi-select limit). Whole-catalog
analyses are rejected in wide mode, because unpivoting every column across the whole
catalog would be prohibitively expensive.

**Query-time performance pipeline.** The transform pushes work as early as possible
so the `materialize`d subset stays small: it applies the time-window filter, filters
to the in-scope `SignalIdPrefix` values, and projects only the value columns the
selected signals actually reference — *before* unpivoting. For adaptive-binned
analyses (Explore, calendar/horizon rollups, robust outliers) it also **pre-bins the
subset** in that same early stage: instead of materializing every raw row, it
`summarize`s each in-scope value column to the analysis's chosen bin width and
aggregation, anchored with `bin_at(…, <window start>)` so the pre-bins line up exactly
with the downstream `make-series` grid. When raw data is dense this collapses the
materialized set from raw resolution to roughly *(signals × bins)*, a large reduction,
while the re-aggregation over each single pre-binned value stays lossless. (Raw-count
probes and OHLC/candlestick views keep raw resolution, so they are never pre-binned.)

**Dense wide sources.** The un-binned density and data-coverage pre-checks are
answered on the wide table *before* it is unpivoted (a streaming `summarize` grouped
by `SignalIdPrefix`), so they never materialize the raw rows. This keeps those checks
well under the engine's per-cluster materialized-results limit even when a single
signal has tens of millions of samples in the window.

### Validate components

The connection-profile editor's **Validate components** button runs read-only probe
queries (`| take 0`) that confirm the four canonical queries resolve (including
cross-DB source access) and that the required result tables and optional external
tables exist on the selected database. Required failures block a usable profile;
missing optional components (external tables, feature-specific result tables) are
reported as warnings because the app degrades gracefully. Authoritative
function/table verification (which needs management commands) is done by
`eventhouse/deploy/Validate-Eventhouse.ps1`.

## Surfacing governed Signal Metadata into KQL (optional)

The **Signal Metadata** page persists governed per-tag limits to the
`signal_metadata` Rayfin table, and the app overlays them from Rayfin on load. To
also make them available through the KQL "Signal Metadata" base query:

1. In OneLake, create a shortcut to the mirrored `signal_metadata` table.
2. In the Eventhouse, expose it as an external table `SignalMetadataExternal`
   (the retrofit tool does this automatically when given `-SignalMetadataDeltaUri`;
   otherwise apply `eventhouse/schema/05_external_tables.kql`).
3. Set the profile's metadata base query to
   `METADATA_QUERY_WITH_SIGNAL_METADATA` in `src/lib/connectionProfile.ts` — it
   `leftouter join`s the external table (keeping the newest approved version per
   signal via `arg_max(version, *)`), filters `scope_key == _ConnectionProfileId`
   so only this profile's records surface, and projects fields with
   `column_ifexists(...)`, so profiles without the shortcut keep working.

## Security notes

- Numeric query parameters are validated and string parameters escaped in
  `src/lib/kql.ts` before interpolation to prevent KQL injection; queries still
  run under the user's delegated token so Eventhouse RLS is enforced.
