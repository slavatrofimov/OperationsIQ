# Orchestration — async job control plane

Pure, dependency-free glue that turns a submitted `AnalysisJob` into a running Spark job
and back into a finished result (design spec §8, §9). Importing this package never
requires network libraries; only `fabric_spark` lazily imports `requests`, and only when
it actually calls Fabric.

## Modules

- **`state_machine.py`** — the `QUEUED → RUNNING → SUCCEEDED|FAILED|CANCELLED` state
  machine as pure functions over a frozen `JobState`. Illegal moves (skipping `RUNNING`,
  resurrecting a terminal job) raise `InvalidTransition`; progress is monotonic + clamped.
- **`callbacks.py`** — builders for the GraphQL request bodies Spark POSTs back to the
  Rayfin Data API: `progress_callback` (streams best-so-far for anytime UX) and
  `completion_callback` (records KQL result pointers + summary, or the error).
- **`cost.py`** — `estimate_compute_seconds` / `estimate_cu_cost` for pre-submit cost,
  `QuotaLedger` for per-user/day budgets, and `cache_key(...)` for deduping identical
  requests to an existing result.
- **`fabric_spark.py`** — a lazily-imported REST client that submits the Spark Job
  Definition run and polls it to a terminal state with a max-runtime guard (orphan
  protection). Not unit-tested — it needs a live Fabric workspace + Entra token.
- **`fabric_livy.py`** — the **Livy** sibling of `fabric_spark`: creates an interactive
  Spark **session**, submits the analysis as a **statement**, and reports *transparent,
  granular* status the whole way. The status mapping (`interpret_livy_status`) is a **pure**
  function of the raw Livy session/statement documents, so it *is* unit-tested. The
  `LivyJobMonitor` poll loop fixes the "waiting forever" bug with three guards
  (`session_start_timeout_s`, `statement_timeout_s`, `max_runtime_s`) and exposes
  `diagnose(...)` → `LivyDiagnostics` (session id, Spark app id, driver-log tail, statement
  traceback) for troubleshooting a stuck/failed session.
- **`dispatcher.py`** — the **runtime that was missing**: a long-running service that
  claims `QUEUED` `AnalysisJob` rows from the Rayfin control plane and actually *submits
  them to Livy* (previously nothing did, so jobs sat in "Waiting…" forever). It resolves
  the physical source from `SourceMapping` config (the job row only carries a `signal_id`
  tag), builds a file-free Spark payload, base64-embeds it into a Livy statement that calls
  `tsmp.jobs.spark_entry.run_payload`, streams non-terminal status back via
  `progress_callback`, and posts a terminal `completion_callback` **with diagnostics**. One
  failing job can never kill the loop. `ControlPlaneClient` (GraphQL) and the
  `LivyJobMonitor` factory are injectable, so `poll_once`/`dispatch_job`/the pure builders
  (`build_job_payload`, `build_livy_code`, `parse_params`) are unit-tested with fakes.

## Running the dispatcher

```bash
cp orchestration/.env.dispatcher.example orchestration/.env.dispatcher   # then fill in
python -m orchestration.dispatcher            # run the polling loop
python -m orchestration.dispatcher preflight  # probe connectivity, exit non-zero on failure
```

**Stuck at "waiting for a Spark session" with nothing on the Livy endpoint?** The job row is
never being claimed, so the fault is upstream of Spark. First confirm the dispatcher process
is actually running (submitting from the UI only writes a QUEUED row), then run
`python -m orchestration.dispatcher preflight`: it checks `config` -> `fabric-token` ->
`livy` (a non-destructive `GET /sessions`) -> `control-plane` (the `analysisJobs` list query,
and reports the QUEUED depth) and prints a PASS/FAIL line for each so you can see exactly
which link is broken. The loop also logs `poll: N queued, M dispatched` every pass — a steady
`0 queued` while the UI shows a stuck job means the list query name does not match the schema.

Prerequisites (all documented in `.env.dispatcher.example`):

- The tenant **Livy API** admin setting is enabled.
- An Entra **service principal** that is a workspace **Contributor**, granted the Livy
  scopes `Lakehouse.Execute.All`, `Lakehouse.Read.All`, `Code.AccessFabric.All`,
  `Code.AccessStorage.All` (`AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`).
- `FABRIC_WORKSPACE_ID` + `FABRIC_LAKEHOUSE_ID` (and optionally `FABRIC_ENVIRONMENT_ID` so
  the `tsmp` wheel is importable on the cluster).
- `RAYFIN_GRAPHQL_URL` for the control plane, plus the `TSMP_*` source/result mapping.

> **Verify against your deployment:** the list query in `ControlPlaneClient` assumes Rayfin
> generates a plural `analysisJobs` query; the control-plane auth strategy
> (`RAYFIN_API_TOKEN` vs. the SPN token) is deployment-specific. Both are overridable.

## Test

```bash
pytest orchestration/tests    # state machine + callbacks + cost + Livy monitor + dispatcher
```

The pure modules hold all testable logic; the two network shells (`fabric_spark`,
`fabric_livy`) lazily import `requests`, and the Livy monitor is exercised through a fake
in-memory transport so its submit→wait→run→terminal flow and anti-hang guards are covered
without a live cluster.
