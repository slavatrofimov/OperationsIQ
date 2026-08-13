---
id: smoke
title: Smoke validation (manual)
sidebar_position: 8
---

# Smoke validation — manual checks

The `smoke` module (`deploy/modules/Invoke-Smoke.ps1`) runs headless post-deploy
checks and emits a PASS/FAIL summary. It exits non-zero on a required failure
(Eventhouse schema), and warns (non-fatal) on the best-effort reachability
checks. Reproduce each check by hand as follows.

## 1. Eventhouse schema (required)

Reuses `Validate-Eventhouse.ps1`:

```powershell
cd OperationsIQApp/eventhouse/deploy
pwsh ./Validate-Eventhouse.ps1 -ClusterUri <query-uri> -Database <companion-db>
```

This confirms the app's stored functions, result tables, and external-table
references are present on the connection profile's database.

## 2. SPA reachable (warn)

```powershell
Invoke-WebRequest -Uri <appOrigin> -Method Head -SkipHttpErrorCheck
```

Expect HTTP `200`/`302`. A non-2xx/3xx status is reported as a warning — the app
may still be finishing its first publish.

## 3. Foundry endpoint reachable (warn)

A TCP :443 probe against the Foundry endpoint host confirms basic connectivity
(it does not validate auth). Open the app's **Operations Advisor** panel to
verify the agent actually answers.

## 4. Sample query (manual)

Sign into the app, connect the seeded [connection profile](../eventhouse-deployment),
open **Explore**, and confirm the sample tags render a time series over the
`now()-60d … now()+60d` window.

## Inputs

The module reads `eventhouseQueryUri`, `companionDatabase`, `appOrigin`, and
`foundryEndpoint` from `outputs/*.json`. When run as the final step of a full
deployment these are already present; to run it standalone, supply them via the
config file or hand-authored outputs files.

## Output

`outputs/smoke.json`: `{ "smokeOk": true }` on success, or
`{ "smokeOk": false, "failures": [ … ] }` with a non-zero exit on a required
failure.
