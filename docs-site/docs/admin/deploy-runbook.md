---
id: deploy-runbook
title: Deploy runbook
sidebar_position: 10
---

# Deploy runbook (checklist)

A condensed end-to-end checklist. Each step links to the detailed page. The
authoritative, code-versioned runbook lives at `OperationsIQApp/docs/runbook.md`.

:::tip Automate it
Everything below can be run for you by the
[automated deployment orchestrator](./deploy/overview) — one command for a fully
permissioned operator, or a pick-and-choose subset when rights are split across
people. This manual checklist is the fallback and the reference for what each
module does.
:::

## 1. Provision the data plane (Eventhouse) ⚙️

- Create/identify an Eventhouse + KQL database for raw sensor series.
- Apply the schema, SAX library, and (optionally) sample data — see
  [Eventhouse deployment](./eventhouse-deployment).
- Grant the Spark identity **viewer** on the raw table and **ingestor** on the
  result tables.

## 2. Deploy the Spark compute plane ⚙️

- Smoke-test locally: `pytest spark/tests`.
- (Optional) Publish `spark/tsmp/jobs/spark_entry.py` as a Spark Job Definition —
  see [Spark compute](./spark-compute).

## 3. Deploy the control plane (Rayfin) ⚙️

- Fill in `rayfin/.env`, then:
  ```powershell
  npm ci
  npm run typecheck; npm test; npm run build
  npm run rayfin:up
  npm run rayfin:db:apply
  ```
- Verify SSO via `/auth`. See [Rayfin backend](./rayfin-backend).

## 4. Register identity (Entra) ⚙️

- Create the Eventhouse **SPA** app registration (client + tenant id).
- Add every origin **and** its `/blank.html` redirect URI.
- Grant Azure Data Explorer `user_impersonation` (admin consent recommended).
- See [Entra app registration](./entra-app-registration).

## 5. Configure & run

- Set the `VITE_*` variables (project-root `.env` recommended) — see
  [Configuration](./configuration).
- `npm run dev` for local, or serve from Rayfin static hosting.

## 6. Verify permissions & governance

- Eventhouse **Viewer** (+ RLS) for users; workspace **Contributor** for analysis
  runners; Livy API tenant setting enabled. See
  [Permissions & governance](./permissions-governance).

## Smoke test

- Sign in; confirm signals load in **Explore**.
- Run a small **Patterns** analysis; confirm the job progresses and results appear.
- Save an **Investigation**; confirm evidence persists.
