---
id: spark-compute
title: Spark compute
sidebar_position: 7
---

# Spark compute (Matrix Profile)

The Patterns / Matrix Profile module runs Spark jobs for scalable motif and
discord discovery. In the current architecture the SPA submits and monitors these
jobs **directly** against the Fabric **Livy** REST endpoint using the user's
delegated token — there is **no server-side dispatcher to run**.

## How it works

`src/lib/mp/livyClient.ts` + `src/lib/mp/livyDispatch.ts`:

1. **Submit** — after a `QUEUED` `AnalysisJob` row is created, the SPA opens a
   PySpark Livy **session** and submits a **statement**. The statement is a small
   stub that base64-decodes a file-free payload and calls
   `tsmp.jobs.spark_entry.run_payload`. Session/statement ids, status, and the
   Spark UI URL are persisted onto the row.
2. **Poll** (~15 s loop) — for each unfinished job the SPA reads the Livy session
   + statement, maps them to a transparent status, and persists
   `status`/`stage`/`progressPct`/`errorMessage` (plus a driver-log tail on
   failure).
3. **Delete / cancel** — best-effort cancels the statement and deletes the Livy
   session so stuck sessions stop consuming capacity, then deletes the row.

## Required configuration

The browser reads `VITE_*` values (see [Configuration](./configuration)):

- `VITE_FABRIC_WORKSPACE_ID` + `VITE_FABRIC_LAKEHOUSE_ID` — the lakehouse whose
  Livy endpoint runs analyses. The lakehouse id is **not** required at app
  startup (it's not in `REQUIRED_ENV`); it's checked when you submit a Pattern
  analysis, so other tabs work without it but submitting shows a clear config
  error if it's missing.
- `VITE_FABRIC_ENVIRONMENT_ID` *(optional)* — a Fabric Spark **Environment** for
  extra libraries/config. **Not required** for `tsmp`: the SPA embeds the tsmp
  package in every Livy statement, so `run_payload` is importable with no wheel or
  Environment.
- The Spark job reads source series via the **active connection profile's
  canonical timeseries query**, projecting raw data onto canonical
  `Timestamp` / `SignalId` / `Value` columns.

## Managed identity

The Spark job reads/writes the Eventhouse using the cluster's **managed identity**
(`auth: "managed_identity"`), so that identity needs **read** on the source table
and **ingest** on the result tables.

## Prerequisites

- The signed-in user is a workspace **Contributor**.
- The tenant **Livy API** admin setting is enabled.
- The Livy delegated scopes are consented (the submit gesture prompts for them
  incrementally). See [Entra app registration](./entra-app-registration).

## Local smoke test

The Spark core is pure Python and testable without a cluster:

```bash
pytest spark/tests
```

## Optional: publish as a Spark Job Definition

For headless/batch use you can package `spark/tsmp/` and publish
`spark/tsmp/jobs/spark_entry.py` as a **Spark Job Definition**, configure its
lakehouse/pool, and add the `azure-kusto-data` / `azure-kusto-ingest` libraries.

## Legacy: standalone dispatcher

The original design used a long-lived server-side poller in `orchestration/`. It
still works and is kept for headless/batch scenarios, but is **not required** for
the direct-Livy SPA path:

```bash
cp orchestration/.env.dispatcher.example orchestration/.env.dispatcher
python -m orchestration.dispatcher
```

It uses an Entra **service principal** (workspace Contributor) with the same Livy
scopes. The state machine guarantees only legal transitions
(`QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED`).
