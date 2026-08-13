# Deploy Runbook — Operations IQ

This runbook takes the app from source to a running Fabric deployment. It assumes a
Fabric tenant with the **Fabric Apps (Rayfin)** workload enabled, a Fabric **capacity**,
and an **Eventhouse/KQL database** holding sensor time series. Steps that require live
Fabric services are marked ⚙️; everything else is validated by the repo's test suites.

> Prerequisites: Node ≥ 20, Python ≥ 3.10, the Rayfin CLI (`npm i -g @microsoft/rayfin`),
> and `az` logged in to the target tenant. Entra app scope:
> `https://api.fabric.microsoft.com/.default`.

## 1. Provision data plane (KQL / Eventhouse) ⚙️

There are two paths. **Greenfield** creates a fresh KQL database and loads the app's
base tables plus functions. **Retrofit** targets an Eventhouse that already holds the
customer's sensor data and must not be modified — the recommended pattern for
existing deployments.

### 1a. Greenfield (new database)

1. Create (or identify) an Eventhouse + KQL database for raw sensor series.
2. Apply the base tables, functions, result tables, and (optionally) sample data.
   Pass `-CreateBaseTables` so `schema/00_tables.kql` (Timeseries, TagMetadata,
   TagHierarchy, Events) is created:
   ```powershell
   ./Deploy-Eventhouse.ps1 `
     -ClusterUri "https://<guid>.<region>.kusto.fabric.microsoft.com" `
     -Database "<eventhouse-db>" `
     -CreateBaseTables `
     -IncludeSampleData
   ```
   The result-table schema (`eventhouse/schema/20_mp_result_tables.kql`) creates
   `mp_result`, `motif_pairs`, `discords`, `overview` (keyed by `jobId`) and
   sets batching so results land within ~10 s of a job finishing. It also creates
   `job_progress` — the best-so-far progress stream the anytime UI polls while a job runs
   (design spec §6.6/§7.2), batched at ~5 s so live convergence + the partial motif feel
   responsive. The app degrades gracefully if `job_progress` is absent (progress writes are
   best-effort), but the live convergence meter and stop-early "keep partial" behaviour
   require it, so apply the current schema.
3. Grant the app's service identity **database viewer** on the raw table and **database
   ingestor** on the result tables (least privilege, design spec §9).

### 1b. Retrofit an existing Eventhouse (companion database)

To connect to an Eventhouse whose KQL database(s) already hold the customer's data,
deploy the app's objects into a **dedicated companion database** on the same
Eventhouse and read the raw tables cross-database. This never touches the existing
databases.

```powershell
./Retrofit-Eventhouse.ps1 `
  -WorkspaceId "<ws-guid>" `
  -EventhouseId "<eventhouse-item-guid>" `
  -ClusterUri "https://<guid>.<region>.kusto.fabric.microsoft.com" `
  -SourceDatabase "<existing-db-with-raw-data>" `
  -CompanionDatabase "OperationsIQ" `
  -AnnotationsDeltaUri "https://onelake.dfs.fabric.microsoft.com/<ws>/<db>.MirroredDatabase/Tables/dbo/Annotation" `
  -SignalMetadataDeltaUri "https://onelake.dfs.fabric.microsoft.com/<ws>/<db>.MirroredDatabase/Tables/dbo/SignalMetadata"
```

The tool: (a) creates the companion KQL DB via the Fabric Items REST API (idempotent);
(b) deploys functions + result tables + the OneLake external tables **without** the
base data tables; (c) runs `Validate-Eventhouse.ps1`; (d) prints ready-to-paste
connection-profile queries that read the source DB via `database("<SourceDatabase>").<Table>`.
The `-AnnotationsDeltaUri` / `-SignalMetadataDeltaUri` pair is optional — omit it to
skip the external tables (governed-metadata / annotation overlay then simply don't
surface server-side).

**Grants:** the signing-in identity needs **Database Viewer** on both the companion DB
and the source DB, and **Database Ingestor** on the companion DB (result-table writes).

**Multi-profile note.** One app instance + one RayFin SQL DB can serve many
Eventhouses/profiles: annotations and governed metadata are stamped with the owning
`connection_profile_id` / `scope_key` and the external-table joins are filtered to the
active profile at query time (see §3 and the [data model](/dev/data-model)).

After deploy, open the app's connection-profile editor, paste the printed queries, and
click **Validate components** to confirm the profile resolves before saving.

## 2. Deploy the Spark compute plane ⚙️

1. Package `spark/tsmp/` and publish `spark/tsmp/jobs/spark_entry.py` as a **Spark Job
   Definition** in the workspace.
2. Configure its default lakehouse/pool and add the `azure-kusto-data` /
   `azure-kusto-ingest` (or the Kusto Spark connector) libraries.
3. Note the **Spark Job Definition item id** and **workspace id** — the orchestrator needs
   both (see step 4).
4. Smoke-test locally first (no cluster needed):
   ```bash
   pytest spark/tests      # 90 passed, 3 skipped
   ```

## 3. Deploy the control plane (Rayfin) ⚙️

1. Fill in `rayfin/.env` from `rayfin/.env.example` (auth, data connection).
2. Type-check and build the SPA:
   ```bash
   npm ci
   npm run typecheck && npm test && npm run build   # -> rayfin/dist
   ```
3. Provision the SQL database + GraphQL API + static hosting:
   ```bash
   npm run rayfin:up            # rayfin up
   npm run rayfin:db:apply      # apply @entity schema to the Fabric SQL DB
   ```
4. Verify SSO: sign in through `/auth`; confirm the SPA loads from static hosting.

> **One-time cleanup — obsolete `WorkflowConfig` table.** The guided-workflow
> settings feature (and its `WorkflowConfig` entity) was removed. A plain
> `db:apply` is non-destructive and will leave the now-orphaned `dbo.WorkflowConfig`
> table (and any rows) in place. To drop it during reconciliation, run a forced
> apply **once** on an environment that has the old table:
> ```bash
> rayfin up db apply --force   # accepts schema changes that may drop data
> ```
> Alternatively, drop it directly: `DROP TABLE IF EXISTS [dbo].[WorkflowConfig];`.
> New deployments never create the table, so this step is unnecessary for them.

### 3a. Eventhouse SPA app registration (MSAL) ⚙️

The browser queries the Eventhouse directly using a **delegated** Kusto-audience token
so Eventhouse RLS / database roles are honored. This uses a **second** Entra app
registration (a public SPA client, PKCE, no secret) separate from the Rayfin/Fabric SSO
session. Configure it once:

1. Create (or reuse) a **Single-page application** registration in Entra ID. Note its
   **Application (client) ID** and **Directory (tenant) ID** → set `VITE_MSAL_CLIENT_ID`
   and `VITE_MSAL_TENANT_ID`.
2. Under **Authentication → Single-page application → Redirect URIs**, add a
   **`/blank.html`** URI for every origin the app runs from. The app points MSAL at a
   dedicated blank page (`public/blank.html`) so silent token-renewal iframes and popups
   do not reload the full SPA — without this the app throws MSAL
   **`block_iframe_reload`**, especially when embedded in the Fabric portal iframe. Add:
   - `http://localhost:5173/blank.html` (local `npm run dev`)
   - `https://<your-deployed-app-origin>/blank.html` (the `rayfin up` static-hosting URL)
3. Grant delegated permissions and admin consent for the Eventhouse (Kusto) audience so
   the browser can read time-series data.
4. For **Discover from Fabric** (enumerate workspaces + Eventhouses), the SPA requests the
   Fabric REST API **delegated** scopes below. It uses *incremental/dynamic consent*: the
   user is prompted to consent the first time they click **Discover from Fabric** (from the
   button's user gesture), so these do not have to be pre-added to the app registration —
   but if your tenant requires admin consent, an admin must approve them once:
   - `https://api.fabric.microsoft.com/Workspace.Read.All`
   - `https://api.fabric.microsoft.com/Item.Read.All`

5. For **running an analysis** (Patterns tab), the SPA submits the Spark job and polls its
   status **directly against the Fabric Livy endpoint**, so it requests the delegated **Livy
   API** scopes below. Same *incremental/dynamic consent*: the user is prompted to approve
   them the first time they **submit an analysis** (from the submit button's user gesture),
   so they do not have to be pre-added to the app registration — but if your tenant requires
   admin consent, an admin must approve them once. Required for every Livy API operation
   (see [Livy API docs](https://learn.microsoft.com/fabric/data-engineering/get-started-api-livy)):
   - `https://api.fabric.microsoft.com/Lakehouse.Execute.All` — create Livy sessions / submit statements
   - `https://api.fabric.microsoft.com/Lakehouse.Read.All` — read lakehouse metadata (discover the Livy endpoint)
   - `https://api.fabric.microsoft.com/Code.AccessFabric.All` — **required for all** Livy API operations
   - `https://api.fabric.microsoft.com/Code.AccessStorage.All` — read/write lakehouse (OneLake) data
   - `https://api.fabric.microsoft.com/Code.AccessAzureDataExplorer.All` — the pattern-finding
     Spark job ingests its results into the Eventhouse (Kusto / Azure Data Explorer), so the
     Spark runtime needs an ADX token on the user's behalf

   > The authenticated user must be a **Contributor** on the workspace that hosts both the
   > Livy API lakehouse and the Eventhouse. The tenant admin must also enable the **Livy API**
   > tenant setting. The optional `Code.Access*` scopes for Key Vault, Data Lake Gen1, and
   > SQL are **not** requested — this workload only touches Fabric, OneLake, and the Eventhouse.

> **If submitting an analysis does nothing / errors on consent:** the account most likely has
> not consented to (or been admin-consented for) the Livy scopes above. Submitting now triggers
> an interactive consent popup on click; if it is dismissed, blocked, or the tenant blocks user
> consent, the Patterns tab shows *"Permission to run the analysis was not granted."* An admin
> can pre-consent the scopes on the SPA app registration to skip the per-user prompt.

> **If Discover from Fabric does nothing / returns no workspaces:** the account most likely
> has not consented to (or been admin-consented for) the two Fabric read scopes above. The
> button now triggers an interactive consent popup on click; if it is dismissed, blocked, or
> the tenant blocks user consent, discovery surfaces the underlying error. As a fallback,
> enter the Eventhouse **Query URI** and **Database** manually in the same panel — discovery
> is purely a convenience.
>
> **Alternative (no Fabric delegated scopes):** proxy discovery through a **Fabric User Data
> Function** that lists workspaces/Eventhouses server-side using the item's own identity,
> and have the SPA call the UDF instead of `api.fabric.microsoft.com`. This avoids granting
> the browser Fabric API scopes at the cost of maintaining a small backend function.


> If you add new origins later (custom domain, staging), you must add the matching
> `/blank.html` redirect URI to this app registration or sign-in and Test Connection
> will fail.

## 4. Wire orchestration ⚙️

**Current architecture (direct-Livy SPA).** Pattern Analysis submits and monitors Spark
jobs **directly from the browser** against the Fabric **Livy REST endpoint**, using the
user's delegated token (the Livy scopes from §3a). There is **no server-side dispatcher to
run** for this path — this is what closes the "Waiting for a Spark session forever" gap that
the earlier design left open (a QUEUED row that nothing picked up).

How it works (`src/lib/mp/livyClient.ts` + `src/lib/mp/livyDispatch.ts`):

1. **Submit** (`MatrixProfilePage.handleSubmit` → `dispatchJob`): after the QUEUED
   `AnalysisJob` row is created, the SPA creates a pyspark Livy **session**, then submits a
   **statement**. The statement is a small PySpark stub that base64-decodes a file-free
   payload and calls `tsmp.jobs.spark_entry.run_payload`. The session/statement ids, initial
   status and `sparkUiUrl` are persisted back onto the row.
2. **Poll** (background loop, ~15s): for every unfinished job with a live session, the SPA
   reads the Livy session + statement, maps them to a transparent status via
   `interpretLivyStatus`, and persists `status`/`stage`/`progressPct`/`livyState`/`errorMessage`
   (plus a driver-log tail on failure) onto the row. The existing `describeJobStatus`
   (`src/lib/mp/livyStatus.ts`) renders this in the JobPanel, including elapsed/stuck hints.
3. **Delete/cancel** (trash button in the JobPanel → `deleteJob`): best-effort cancels the
   statement + deletes the Livy session (so a stuck session stops consuming capacity), then
   deletes the control-plane row.

**Required config** (`.env.example`; the browser reads `VITE_*`):
- `VITE_FABRIC_WORKSPACE_ID` + `VITE_FABRIC_LAKEHOUSE_ID` — the lakehouse whose Livy endpoint
  runs the analyses. Without the lakehouse id, submitting shows a clear config error.
- `VITE_FABRIC_ENVIRONMENT_ID` (optional) — a Fabric Spark **Environment** for *extra* Spark
  libraries/config. It is **not** required for `tsmp`: the SPA embeds the tsmp package in every
  Livy statement (see "tsmp bundling" below), so `run_payload` is importable with no wheel or
  Environment set up. Set it only if your analyses need additional cluster libraries.
- The Spark job reads its source series through the **active connection profile's canonical
  timeseries query** (the same adapter the app's KQL builders use), so it works against any
  underlying schema — it projects the raw data onto the canonical `Timestamp` / `SignalId` /
  `Value` columns. An active profile is required to submit; the source **cluster/database**
  also come from the active profile (else `VITE_EVENTHOUSE_QUERY_URI`/`VITE_EVENTHOUSE_DB`).
- Prerequisites: the signed-in user is a workspace **Contributor**, the tenant **Livy API**
  admin setting is enabled, and the Livy scopes in §3a are consented (the submit gesture
  prompts for them incrementally).

> The Spark job reads/writes the Eventhouse (Kusto) using the cluster's **managed identity**
> (`auth: "managed_identity"` in the payload), so that identity needs read on the source table
> and ingest on the result tables.

---

**Legacy alternative — standalone Python dispatcher (`orchestration/`).** The original design
used a long-lived server-side poller. It still works and its pure logic is the reference the
TypeScript client was ported from, but it is **not required** for the direct-Livy SPA path
above and is kept for headless/batch scenarios. To run it instead of (or alongside) the SPA:
   ```bash
   cp orchestration/.env.dispatcher.example orchestration/.env.dispatcher   # then fill in
   python -m orchestration.dispatcher
   ```
   It polls the Rayfin control plane, and per queued job resolves the physical source from
   `SourceMapping`/`TSMP_*` config (the job row carries only a `signal_id` tag), builds a
   file-free payload, base64-embeds it into a Livy statement that calls
   `tsmp.jobs.spark_entry.run_payload`, and submits it via `LivyJobMonitor.run`.
2. **Prerequisites for Livy** (all in `.env.dispatcher.example`):
   - Enable the tenant **Livy API** admin setting.
   - Use an Entra **service principal** that is a workspace **Contributor**, granted
     `Lakehouse.Execute.All`, `Lakehouse.Read.All`, `Code.AccessFabric.All`,
     `Code.AccessStorage.All`.
   - Set `FABRIC_WORKSPACE_ID` + `FABRIC_LAKEHOUSE_ID` (and `FABRIC_ENVIRONMENT_ID` so the
     `tsmp` wheel from step 2 is importable on the cluster).
3. **Transparency + troubleshooting:** the dispatcher streams non-terminal status via
   `orchestration.callbacks.progress_callback` (stage/progress → JobPanel) and posts the
   terminal state via `completion_callback` **with `LivyDiagnostics`** (session/statement id,
   Spark UI URL, driver-log tail) that the `JobDiagnosticsPanel` renders. Three anti-hang
   guards (`LIVY_SESSION_START_TIMEOUT_S`, `LIVY_STATEMENT_TIMEOUT_S`, `LIVY_MAX_RUNTIME_S`)
   convert an indefinite wait into a FAILED job with a diagnostic message. One failing job
   never kills the loop.
4. The state machine (`orchestration.state_machine`) guarantees only legal transitions
   (`QUEUED → RUNNING → SUCCEEDED|FAILED|CANCELLED`).
5. Validate the pure glue locally:
   ```bash
   pytest orchestration/tests    # state machine + callbacks + cost + Livy monitor + dispatcher
   ```

> **Verify against your deployment:** `ControlPlaneClient` assumes Rayfin exposes a plural
> `analysisJobs` list query; the control-plane auth (`RAYFIN_API_TOKEN` vs. reusing the SPN
> token) is deployment-specific. Both are overridable via env/constructor args.

### 4a. Troubleshoot "waiting for a Spark session" (nothing on the Livy endpoint) 🩺

If a job sits in **QUEUED** ("waiting for a Spark session") and **nothing appears in Fabric
monitoring**, the Livy session was never created. For the **direct-Livy SPA path** (default),
check these first, in order of likelihood:

1. **Consent / permissions.** Open the browser devtools **Network** tab and submit again. A
   `401`/`403` on `.../livyApi/.../sessions` means the token lacks the Livy scopes, the user is
   not a workspace **Contributor**, or the tenant **Livy API** setting is off (§3a). The
   Patterns tab surfaces this as *"Permission to run the analysis was not granted"* or a Livy
   auth error on the job row.
2. **Missing lakehouse id.** If submitting immediately marks the job FAILED with a
   *"missing VITE_FABRIC_LAKEHOUSE_ID"* message, set that env var to the lakehouse whose Livy
   endpoint should run the analyses and rebuild.
3. **`404` on the sessions URL.** Wrong `VITE_FABRIC_WORKSPACE_ID` / `VITE_FABRIC_LAKEHOUSE_ID`.
4. **Session stuck in `starting`.** If the row shows `session:starting` for many minutes, the
   workspace is waiting on Spark capacity — check capacity/quotas in the Fabric portal. The
   `stage`/`livyState` fields and the driver-log tail (captured on failure) are shown in the
   job's troubleshooting panel, and `sparkUiUrl` deep-links to the Spark UI.
5. **Statement error.** A session that reaches `idle`/`busy` but whose statement goes to
   `error` means the analysis code failed on the cluster. Two dependency cases are handled
   automatically (see "tsmp bundling & runtime deps" below):
   - `ModuleNotFoundError: No module named 'tsmp'` — the compute package is shipped inside the
     statement, so this should not occur; if it does, the SPA build did not regenerate the
     bundle, so run `npm run build` (which runs `bundle:tsmp` first) and redeploy.
   - `ImportError: azure-kusto-data is required...` — the statement pip-installs the Kusto SDKs
     on the driver at startup. If it persists, the Spark pool likely blocks PyPI egress: either
     allow it, or bake `azure-kusto-data`/`azure-kusto-ingest` into a Fabric Environment and set
     `VITE_FABRIC_ENVIRONMENT_ID` (the install auto-skips when the modules already import).
   - `KustoAuthenticationError ... no response from the IMDS endpoint` — Fabric Spark has no IMDS
     endpoint, so managed-identity auth to Kusto fails. The default `VITE_TSMP_KUSTO_AUTH=fabric_token`
     obtains the token via `notebookutils.credentials.getToken("kusto")` on the driver instead.
     If you still see this, confirm the SPA was rebuilt with `fabric_token` (not `managed_identity`)
     and that the signed-in identity has query/ingest rights on the Eventhouse.
   - `REQUEST_INVALID_RESOURCE_NONRETRIABLE` / "Resource is not valid" / "Token for resource
     &lt;guid&gt; is not allowed as user token doesn't have required scopes" in the Spark driver log
     (from `TokenLibrary`) — the token was requested for the wrong audience. Fabric's
     `notebookutils.credentials.getToken` only accepts the fixed audience *keywords*
     `storage` / `pbi` / `keyvault` / `kusto`; passing the full cluster URI resolves to a resource
     the delegated user token has no scope for. `tsmp.io.kusto` requests the `"kusto"` keyword
     audience for the KQL DB resource — rebuild the SPA so the regenerated bundle carries the fix.
   Other statement errors show the traceback in the job's troubleshooting panel via the captured
   driver-log tail. That tail is now captured on **every poll of a running statement** (not only on
   failure), so a long-running or stuck session can be inspected live from the "Session details"
   panel. Because Fabric's Livy API does not stream per-statement progress, a running job shows
   honest elapsed time (e.g. "running for 4 min 10 s") rather than a stuck 0% bar, and is only
   flagged for a closer look after it runs unusually long.
   - **Retrieving a failed statement's Python traceback from Fabric.** The Livy statement now runs
     through `tsmp.jobs.spark_entry.run_and_print`, which on any failure prints the full traceback
     bracketed by `TSMP_TRACEBACK_BEGIN` / `TSMP_TRACEBACK_END` to **both stdout and stderr** before
     re-raising. That means the exact failing call is captured in the Livy statement error *and* in
     the Spark driver log — so even when the app's diagnostics panel is unavailable (e.g. an older
     deployed build), you can open the session's driver log in Fabric monitoring and search for
     `TSMP_TRACEBACK_BEGIN` to see precisely which call failed (read vs. ingest vs. token). On
     success the same wrapper prints the `TSMP_RESULT <json>` completion line the control plane
     already recovers.
   - Long window "analyzing" for many minutes but never finishing — a scale issue, not a hang.
     The matrix profile is O(n^2); a 30-day window has ~30x the samples of a 1-day window, so
     ~900x the compute. The motif (top-1) path now fans this work across executors via the
     distributed parallel matrix profile (see below), and `nBlocks` auto-scales to the pool's
     `defaultParallelism`, so long windows scale with the cluster. If a long run is still slow,
     add executor cores / a larger pool (more `defaultParallelism` = more concurrent diagonal
     blocks), or narrow the window. The `TokenLibrary` background-refresh 400 above is unrelated
     noise and does not block or slow the analysis.

### Distributed matrix-profile compute (scaling to long windows)

Every analysis lane runs the exact self-join matrix profile as a **diagonal-block map/reduce**
(`tsmp.parallel.decompose.parallel_matrix_profile`): the independent MPX diagonals are split into
`nBlocks` disjoint ranges, each block runs as one Spark task on an executor, and the driver does a
tiny deterministic argmax reduce. The result is bit-for-bit identical to the monolithic algorithm.

- **Motif discovery** (top-k repeating patterns, the "Auto-find patterns" lane) reads the top-k
  motif straight off this distributed profile on a cluster. Small/local windows still use the
  single-driver anytime MOMP (streams a best-so-far convergence meter); the switch is purely a
  performance decision guarded by `should_distribute(n, m)` and has no effect on the result.
- **Variable-length scan** (`PAN_MP`, the "I'm not sure how long" / auto-length lane) computes a
  full matrix profile for *each* candidate length (~12 of them), so it is inherently the most
  expensive lane — a known-length motif is one profile, an auto-length scan is ~12. On a cluster
  each length's profile is now fanned across executors via the same distributed path; only the
  small/local (serial-mapper) fallback runs the single-threaded driver MOMP once per length. If
  auto-length feels slow, prefer specifying an approximate length (one profile instead of ~12) or
  add executor cores.
- **`nBlocks`** defaults to 4 in the job spec but `spark_entry.run_payload` raises it to the
  pool's `defaultParallelism` at runtime (unless the payload pins `nBlocks`), so the self-join
  uses all executor cores instead of capping at 4 tasks. The diagonal splitter clamps `nBlocks`
  to the profile length internally, so oversizing it is safe.

### tsmp bundling & runtime deps (self-contained analyses)

The SPA embeds the entire `tsmp` compute package into every Livy statement, so the cluster
needs **no pre-published wheel and no custom Environment**. At build time
`scripts/bundle-tsmp.mjs` (wired into the `prebuild`/`predev` npm hooks) gzips every
`spark/tsmp/**/*.py` file into `src/lib/mp/tsmpBundle.ts` (~24 KB gzip). At submit time the
`buildLivyCode` bootstrap decodes that bundle, rebuilds a `tsmp` zip in the driver temp dir,
puts it on `sys.path`, and calls `SparkContext.addPyFile` so executors import it too. Editing
any Python source under `spark/tsmp/` therefore only requires a rebuild + redeploy of the SPA —
there is nothing to publish to Fabric. `VITE_FABRIC_ENVIRONMENT_ID` remains available for
*additional* cluster libraries but is not needed for `tsmp`.

The analysis reads the source series from and ingests results into the Eventhouse via the
`azure-kusto-data`/`azure-kusto-ingest` SDKs, which a bare Fabric Spark pool may lack. The
statement bootstrap therefore pip-installs `VITE_TSMP_PIP_PACKAGES` (default
`azure-kusto-data azure-kusto-ingest`) on the **driver only** (executors run numpy-only work),
skipping the install when the modules already import. Pin versions via that env var, or set it
empty to skip entirely when a Fabric Environment already provides them.

---

**Legacy dispatcher path only.** If you are running the standalone Python dispatcher instead,
the row is never being *claimed* — the fault is upstream of Spark. In order of likelihood:

1. **The dispatcher is not running.** It is a standalone process; submitting from the UI only
   writes a QUEUED row. Confirm `python -m orchestration.dispatcher` is up and watch its log —
   each pass prints `poll: N queued, M dispatched`. A steady `0 queued` while the UI shows a
   stuck job is the fingerprint of a control-plane/list-query mismatch (see step 3).
2. **Run the built-in preflight** to probe every link without submitting a real job:
   ```bash
   python -m orchestration.dispatcher preflight
   ```
   It prints a PASS/FAIL line per check (`config`, `fabric-token`, `livy`, `control-plane`)
   and exits non-zero on any failure. Interpret failures as:
   - **fabric-token FAIL** — the SPN cannot mint an Entra token. Check
     `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`.
   - **livy FAIL (401/403)** — the token lacks the Livy scopes (`Lakehouse.Execute.All`,
     `Lakehouse.Read.All`, `Code.AccessFabric.All`, `Code.AccessStorage.All`), the SPN is not
     a workspace **Contributor**, or the tenant **Livy API** admin setting is off.
   - **livy FAIL (404)** — wrong `FABRIC_WORKSPACE_ID` / `FABRIC_LAKEHOUSE_ID`.
   - **control-plane FAIL** — wrong `RAYFIN_GRAPHQL_URL`, bad control-plane token, or the
     generated list query is not named `analysisJobs` (override `list_query` on
     `ControlPlaneClient`). A green `control-plane` check also reports the QUEUED depth, so
     you can confirm the dispatcher sees the same job the UI does.
3. **If preflight is all green but jobs still don't move,** the list query name is the usual
   culprit: the dispatcher queries `analysisJobs` and filters to QUEUED in Python, so a
   wrong query name returns an empty list silently (visible as `poll: 0 queued`). Verify the
   name against the deployed Rayfin schema and override if needed.

Once a job *is* claimed, it transitions to RUNNING and, on any Livy failure/timeout, to
FAILED with `LivyDiagnostics` (session/statement id, Spark UI URL, driver-log tail) on the
row — open the job's troubleshooting panel for that detail.

## 5. Cost controls & quotas (design spec §9)

- Before dispatch, call `orchestration.cost.estimate_compute_seconds` /
  `estimate_cu_cost` and surface the estimate in the wizard's review step (already wired
  client-side via `lib/jobPath.ts`).
- Enforce a per-user/day budget with `orchestration.cost.QuotaLedger`, seeding `used`
  from the day's job rows.
- Dedupe identical requests with `orchestration.cost.cache_key(...)`: if a `SUCCEEDED`
  job with the same key exists, return its result pointers instead of recomputing.

## 6. Post-deploy verification

1. Register a `DataSource` + `Signal` pointing at the KQL table.
2. Run the wizard end-to-end on a small window → expect an interactive result in seconds.
3. Run a large window → expect an async job with streaming best-so-far + convergence.
4. Label a motif and use **"apply to all similar"**; confirm labels persist and re-overlay.
5. Confirm cost/quota estimates appear pre-submit and the daily budget blocks over-limit
   submissions.

## Rollback

- Control plane: redeploy the previous build (`git checkout <prev> && npm run rayfin:up`).
- Data plane: result tables are keyed by `jobId`; drop a bad job's rows with
  `.<table> | where jobId == '<id>'`-scoped purges. Raw series are never modified.
- Compute plane: revert the Spark Job Definition to the prior package version.

## Accessibility & telemetry checklist (design spec §7.5, §9)

- ✅ Keyboard navigation, colorblind-safe severity palette, empty/loading/error states in
  the SPA.
- ⚙️ Emit per-job telemetry (submit, dispatch, progress, completion, compute-seconds) to
  the workspace's monitoring; alert on FAILED-rate and orphan detection.
