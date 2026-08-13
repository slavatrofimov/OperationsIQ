# Operations IQ

A Fabric app for turning operational time-series data into business-ready intelligence: finding
anomalies, discovering recurring patterns, forecasting signals, and searching for subsequences —
backed by a Fabric **Eventhouse** (KQL) and the **Rayfin** (Fabric Apps)
backend-as-a-service.

## Interfaces

1. **Visual exploration & time brushing** — adaptive-binned overview with
   anomaly and event overlays, brush-to-zoom.
2. **Similarity search** — brush a subsequence, pick a search space, rank
   matches (`sax_similarity_search_1d`). Select **two or more query tags** for a
   multivariate search (`sax_similarity_search_multidim`) in either of two modes:
   *recurrence* (scan the same tags for their combined pattern recurring) or
   *explicit tag mapping* (map each query tag to a different search-space tag to
   find the pattern on another asset), with per-track shape comparison and
   aligned timelines.
3. **Multi-dimensional pattern discovery** — aligned multi-track matches across
   entities (`sax_similarity_search_multidim`). _(shipped as the multivariate mode
   of Similarity search, above)_
4. **Discord / anomaly discovery** — rare-subsequence discovery
   (`sax_discords`). The Eventhouse also ships a pure-KQL, scheduled-query MVAD
   library for random-projection, residual-voting, change-point, and spectral
   anomaly detection (no UI integration yet). _(Patterns → Discover tab)_
5. **SAX-VSM classification & annotation** — train, classify, and label
   (`sax_vsm_train` / `sax_vsm_classify`). _(Patterns → Discover tab)_
6. **Matrix Profile Patterns** — Spark-powered MOMP/DAMP motif & discord
   discovery over long windows; wizard-driven with plain-language results,
   label propagation, and convergence meter. _(Patterns tab)_
7. **Investigations & Evidence** — capture any analysis page into a named
   *Investigation* (case study). "Add to investigation" saves a Markdown snapshot
   of the page's main content, every ECharts graph as PNG + CSV, your annotation,
   and a link that restores the view. Review it all in the **Investigations** tab.
   _(Investigations tab)_

## Architecture

Two independent auth contexts run in the SPA:

| Concern | Mechanism | Reaches |
| --- | --- | --- |
| Identity + persistence (labels, saved searches, VSM models) | Fabric SSO via `RayfinClient` (`src/lib/rayfinClient.ts`) | Rayfin GraphQL over Fabric SQL |
| Time-series reads + SAX functions | MSAL.js public client (`src/lib/msal.ts`) | Eventhouse `/v2/rest/query` |

Rayfin sessions are **opaque** and cannot mint a Kusto token, so a separate
MSAL public client (its own Entra SPA app registration) acquires a
Kusto-audience token and queries the Eventhouse directly. The browser stays
**read-only** against the Eventhouse; **all writes go to Rayfin SQL** via
GraphQL. SAX-VSM models are trained in the Eventhouse (read-only) and their term
weights are persisted to Rayfin SQL; classification passes the model back as an
inline KQL `datatable` literal — no Eventhouse write access required.

## Layout

```
OperationsIQApp/
  eventhouse/
    schema/00_tables.kql         # Timeseries, TagMetadata, TagHierarchy, Events
    schema/10_app_functions.kql  # adaptive binning + segment/search-space/events helpers
    schema/20_mp_result_tables.kql # Matrix Profile result tables (mp_result, motif_pairs, discords, overview)
    schema/30_sax_core.kql       # SAX core helpers (znorm, alphabet, breakpoints, PAA, symbolize)
    schema/40_sax_similarity_1d.kql        # 1-D SAX similarity search
    schema/50_sax_similarity_multidim.kql  # multivariate SAX similarity search
    schema/60_sax_discords.kql   # SAX-guided discord discovery
    schema/70_sax_vsm.kql        # SAX-VSM interpretable classification (wordbag/train/classify)
    schema/80_mvad_core.kql       # MVAD preparation, row-safe helpers, shared diagnostics/contracts
    schema/81_mvad_random_projection.kql # deterministic sparse projection ensemble
    schema/82_mvad_residual_voting.kql   # residual RMS + scalable track voting
    schema/83_mvad_change_points.kql     # causal FIR level/slope change ensemble
    schema/84_mvad_spectral.kql          # bounded historical FFT aggregation
    sample-data/contoso_sample.kql
    deploy/Deploy-Eventhouse.ps1 # deploys schema + SAX/MVAD libraries (+ optional sample data)
  rayfin/
    data/*.ts                    # entity classes (@entity/@role/...) + schema.ts
                                 # 21 entities: DataSource, Signal, SignalMetadata, SpcBaseline,
                                 #   AnalysisJob, ResultArtifact, ModelOutput, Label, LabelCategory,
                                 #   Investigation, Evidence, EvidenceArtifact, ConnectionProfile,
                                 #   SavedView, SavedDerivedMetric, Annotation, ScenarioRun,
                                 #   VsmModel, VsmModelTerm, AlertRule, AlertEvent
  spark/                         # PySpark Matrix Profile compute core (MOMP, DAMP, PAN-MP)
  orchestration/                 # Async job orchestration for Spark submissions
  src/
    lib/env.ts                   # typed env config
    lib/rayfinClient.ts          # Fabric SSO + GraphQL persistence client
    lib/msal.ts                  # Kusto-token acquisition (MSAL public client)
    lib/eventhouse.ts            # read-only KQL executor (v2 response parsing)
    lib/binning.ts               # f_bin_timespan port (adaptive bin selection)
    lib/kql.ts                   # safe KQL builders (explore / similarity / discords / VSM)
    lib/mp/                      # Matrix Profile helpers (interpret, recipes, labeling, signal, etc.)
    state/wizardState.ts         # Analysis wizard state machine + reducer
    components/mp/               # FluentUI+ECharts Matrix Profile components
    pages/MatrixProfilePage.tsx  # Patterns tab page
  .env.example                   # copy to .env.local and fill in
```

## Setup

### 0. Install dependencies (idempotent bootstrap)

Every worktree/session is a fresh directory with no `node_modules` or Python
`.venv` (both are git-ignored). Instead of reinstalling by hand each time, run
the bootstrap from the **repo root**:

```powershell
node scripts/bootstrap.mjs          # or: ./scripts/bootstrap.ps1  (bash: ./scripts/bootstrap.sh)
```

It installs dependencies for every project — `OperationsIQApp`, `docs-site`
(npm), and `OperationsIQApp/spark` (a Python `.venv`) — but only when they are
**missing or stale**. It fingerprints each project's lockfile and records the
hash next to the install, so re-running is a fast no-op when nothing changed.
That makes it safe to run on every session start and eliminates repeated
reinstalls.

```powershell
node scripts/bootstrap.mjs --only=npm      # skip the Python venv
node scripts/bootstrap.mjs --only=python   # only the spark venv
node scripts/bootstrap.mjs --force         # ignore hashes and reinstall
node scripts/bootstrap.mjs --verbose        # stream install output
```

> If a project's `package-lock.json` is out of sync with its `package.json`,
> `npm ci` would normally abort; the bootstrap automatically falls back to
> `npm install` (and warns) so a stale lockfile never blocks a session.

### 1. Eventhouse (KQL)

Deploy the schema, the SAX and MVAD function libraries, and sample data:

```powershell
cd OperationsIQApp/eventhouse/deploy
./Deploy-Eventhouse.ps1 `
  -ClusterUri "https://<guid>.<region>.kusto.fabric.microsoft.com" `
  -Database "<eventhouse-db>" `
  -IncludeSampleData
```

The SAX functions (`eventhouse/schema/30-70_sax_*.kql`) and MVAD functions
(`eventhouse/schema/80-84_mvad_*.kql`) deploy automatically with the schema.
They land in the Kusto `SAX/` and `MVAD/` folders; app helper functions land in
`OperationsIQ/Search` (the data tables live in `OperationsIQ/Data`). Verify with:

```kql
.show functions
| where Folder startswith "OperationsIQ/" or Folder startswith "SAX/" or Folder startswith "MVAD/"
| project Name, Folder | order by Folder asc, Name asc
```

#### Scheduled pure-KQL multivariate anomaly detection

MVAD functions consume one aligned row per entity/track. Adapt physical tables
outside the library, filter the historical interval before preparation, then
pass the canonical table to any detector. `range_end` is exclusive and the final
`detection_window` is scored without fitting its own baseline:

```kusto
let range_start = ago(7d);
let range_end = now();
let Source =
    Timeseries
    | where Timestamp >= range_start and Timestamp < range_end
    | lookup kind=inner (
        TagHierarchy
        | project TagId, EntityId = strcat(Plant, "/", Factory, "/", Line, "/", Station)
    ) on TagId
    | lookup kind=inner (
        TagMetadata
        | project TagId, Metric
    ) on TagId
    | project
        entity_id = EntityId,
        track_id = Metric,
        timestamp = Timestamp,
        value = Value;
let SeriesTable =
    mvad_make_series(Source, range_start, range_end, 5m, 0.95, 3);
mvad_residual_magnitude_voting(
    SeriesTable,
    30m,        // final interval to score
    0,          // known seasonality in bins; 0 disables it
    "linefit",
    "ctukey",
    1.5,        // per-track vote threshold
    1.2,        // entity RMS threshold
    2,          // absolute minimum track votes
    0.5,        // scalable minimum vote fraction
    3.0,        // extreme single-track threshold
    false       // anomalies + diagnostics only
)
```

All detectors return the same result columns. `status == "ok"` identifies scored
rows; invalid coverage, alignment, history, or guarded work produces an explicit
diagnostic row even when `emit_all_scores` is false. See the headers in
`eventhouse/schema/81-84_mvad_*.kql` for explicit parameter guidance and examples.

### 2. Entra SPA app registration (for Eventhouse access)

The browser queries the Eventhouse directly, so it needs its own **public SPA**
(PKCE, no secret) Entra app registration that mints a **Kusto-audience** token.
The delegated token means the user's own identity is used, so Eventhouse RLS and
database roles are honored. This registration is separate from the Rayfin/Fabric
SSO session.

#### 2a. Register the application

1. Open the [Entra admin center](https://entra.microsoft.com) → **Applications**
   → **App registrations** → **New registration**.
2. **Name:** e.g. `Operations IQ – Eventhouse SPA`.
3. **Supported account types:** _Accounts in this organizational directory only
   (single tenant)_.
4. **Redirect URI:** platform = **Single-page application (SPA)**, value =
   `http://localhost:5173/blank.html` (the local dev origin + `/blank.html` —
   see section 2b for why the `/blank.html` path is required).
5. **Register**, then from the **Overview** page copy the **Application (client)
   ID** (→ `VITE_MSAL_CLIENT_ID`) and **Directory (tenant) ID** (→
   `VITE_MSAL_TENANT_ID`).

#### 2b. Add every serving origin as a redirect URI

`redirectUri` is `${window.location.origin}/blank.html` — a dedicated blank page
(`public/blank.html`) that silent token-renewal iframes and popups navigate to,
so they do not reload the full SPA (which otherwise throws MSAL
**`block_iframe_reload`**, especially when embedded in the Fabric portal iframe).
So under **Authentication → Single-page application** add a **`/blank.html`** URI
for each origin the app is served from:

- `http://localhost:5173/blank.html` — local dev
- the Rayfin-hosted public URL + `/blank.html`, e.g.
  `https://<your-app>.webapp.fabricapps.net/blank.html`
- `https://app.fabric.microsoft.com/blank.html` — only if embedding the app in
  the Fabric portal

See also the deployment runbook's Eventhouse auth setup
(`docs/runbook.md`, "Redirect URIs") for the same requirement.

Leave the **Implicit grant** checkboxes **unchecked** (PKCE is used, not implicit
flow), then **Save**.

#### 2c. Grant delegated permission to Kusto (Azure Data Explorer)

The app requests the scope `${VITE_EVENTHOUSE_QUERY_URI}/.default`, i.e. the
Eventhouse cluster's own audience:

1. **API permissions** → **Add a permission** → **APIs my organization uses**.
2. Search for **Azure Data Explorer** (app id
   `2746ea77-4702-4b45-80ca-3c97e680e8b7`) and select it.
3. **Delegated permissions** → check **user_impersonation** → **Add
   permissions**.
4. (Recommended) **Grant admin consent for \<tenant\>** so users are not prompted
   individually. If you cannot, each user consents on first sign-in.

#### 2d. Grant the user read access on the Eventhouse

The Entra grant only lets the token be _issued_; the Eventhouse enforces its own
roles. In the Fabric portal, open the **Eventhouse / KQL Database** →
**Manage → Permissions** and ensure signing-in users have at least the
**Viewer** role (plus any applicable RLS policy).

### 3. Rayfin backend

If you don't already have a scaffolded Rayfin project, create one and copy the
`rayfin/data` entities and `src/lib` client into it:

```powershell
npm create @microsoft/rayfin@latest
```

Then install and apply the schema:

```powershell
npm install
npx rayfin up db apply   # generates Fabric SQL schema + GraphQL from rayfin/data
```

> The Rayfin packages are pinned to a patch range (`~1.33.2`) in `package.json`
> and resolved exactly by `package-lock.json`. Use `npm ci` in CI/deploys for a
> reproducible install; bump the pin deliberately when adopting a new Rayfin
> release.

#### Surfacing governed Signal Metadata into KQL (optional)

The **Signal Metadata** page persists governed per-tag limits (operating/spec limits,
setpoint, rate limit, plausible range, SPC binding, monitoring defaults) to the
`signal_metadata` RayFin table. The app overlays those values onto the tag catalog
directly from RayFin on load, so the manager and every analysis page (plus the agent
via `describe_tag`) see them immediately. To also make them available through the KQL
"Signal Metadata" base query (for profiles that read metadata from the Eventhouse):

1. In OneLake, create a shortcut to the mirrored `signal_metadata` table.
2. In the Eventhouse, expose it as an external table named `SignalMetadataExternal`.
3. Set the profile's metadata base query to the `METADATA_QUERY_WITH_SIGNAL_METADATA`
   template in `src/lib/connectionProfile.ts` — it `leftouter join`s the external
   table (keeping only the newest approved version per signal via `arg_max(version, *)`)
   and projects the fields with `column_ifexists(...)`, so profiles without the
   shortcut keep working unchanged.

### 4. Configure and run

```powershell
Copy-Item .env.example .env.local   # then fill in the values
npm run dev                         # frontend vs. the remote Fabric backend
```

The app reads its config from Vite `VITE_*` variables (see `.env.example` and
`src/lib/env.ts`). At startup `src/main.tsx` checks the required values
(`missingRequiredEnv()`); if any are missing it renders a "Configuration
incomplete" gate listing them instead of the app. `assertEnv()` provides the
same check in a throwing form for programmatic callers.

| Variable | Source |
| --- | --- |
| `VITE_MSAL_CLIENT_ID` | Application (client) ID from step 2a |
| `VITE_MSAL_TENANT_ID` | Directory (tenant) ID from step 2a |
| `VITE_EVENTHOUSE_QUERY_URI` | Eventhouse **System overview → Query URI** (no trailing slash / no path) |
| `VITE_EVENTHOUSE_DB` | KQL database name |
| `VITE_FABRIC_WORKSPACE_ID`, `VITE_FABRIC_ITEM_ID`, `VITE_RAYFIN_*` | Written by `rayfin up` (see below) |

> **`VITE_EVENTHOUSE_QUERY_URI` must be just the cluster host** (e.g.
> `https://<guid>.<region>.kusto.fabric.microsoft.com`). `env.ts` strips
> trailing slashes and builds the MSAL scope as `<uri>/.default`.

#### Where to put the MSAL / Eventhouse values

`rayfin up` (and `rayfin env`) **regenerate `.env.local`** from the
`RAYFIN_PUBLIC_*` keys in `rayfin/.env`, so hand-edits to `.env.local` are
overwritten. Two supported options:

- **Project-root `.env` (recommended).** Rayfin never touches a plain `.env`,
  and Vite merges `.env` + `.env.local`. Put the four SPA/Eventhouse keys — with
  the exact `VITE_*` names above — in `.env` at the project root. They survive
  every `rayfin up` and need no code change. (Add `.env` to `.gitignore` if you
  don't want the cluster URI committed; these are public SPA values, not
  secrets.)
- **`rayfin/.env` (single source of truth).** Add them with the `RAYFIN_PUBLIC_`
  prefix, but note the CLI renames unknown keys as
  `RAYFIN_PUBLIC_<NAME>` → `VITE_RAYFIN_<NAME>` (it injects `RAYFIN_`). So
  `RAYFIN_PUBLIC_MSAL_CLIENT_ID` becomes `VITE_RAYFIN_MSAL_CLIENT_ID`, and
  `src/lib/env.ts` + `src/lib/vite-env.d.ts` must be updated to read the
  `VITE_RAYFIN_*` names. There is no `RAYFIN_PUBLIC_*` name that maps to a bare
  `VITE_EVENTHOUSE_*` / `VITE_MSAL_*`.

## Notes

- Numeric query parameters are validated and string parameters escaped in
  `src/lib/kql.ts` before interpolation to prevent KQL injection; queries still
  run under the user's delegated token so Eventhouse RLS is enforced.
- Phasing: **v1** (exploration + 1-D similarity) and **v2** (multivariate
  similarity, discords, SAX-VSM) have both shipped; the SAX v2 capabilities live
  in the Similarity search and Patterns → Discover screens.
