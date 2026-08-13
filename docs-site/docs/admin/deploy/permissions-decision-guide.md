---
id: permissions-decision-guide
title: Permissions decision guide
sidebar_position: 2
---

# Permissions decision guide

Use this guide to decide **which modules you can run yourself** and **which you
must hand off** to someone with more privileges. Because every module reads its
inputs from `deploy/outputs/*.json`, splitting the work is just a matter of
exchanging a few small JSON files.

## Roles at a glance

| You have… | You can run | You hand off |
|-----------|-------------|--------------|
| Azure subscription Contributor + Cognitive Services | `foundry`, `agent` | Fabric-side modules |
| Entra Application Administrator | `entra`, `deploy-sp` | everything else |
| Fabric Workspace Admin/Member | `lakehouse`, `spark-job`, `eventhouse-new`, `app-backend`, `config` | Azure/Entra modules |
| KQL Database Admin / Ingestor | `eventhouse` (retrofit + seed) | app-backend, config |
| Foundry project data scientist | `agent` | Azure account creation |
| End-user read access | `smoke` | all provisioning |

## Splitting the work

The pattern is always the same:

1. The privileged party runs their modules, e.g.:

   ```powershell
   pwsh ./Deploy-All.ps1 -Modules foundry,entra
   ```

2. They send you the produced files from `deploy/outputs/` — for the example
   above, `foundry.json` and `entra.json`. Each is a small key/value document:

   ```json
   { "msalClientId": "…", "tenantId": "…" }
   ```

3. You drop those files into **your** `deploy/outputs/` directory and run the
   modules you own:

   ```powershell
   pwsh ./Deploy-All.ps1 -Modules lakehouse,app-backend,eventhouse,config
   ```

   The orchestrator sees the upstream outputs already present, marks those
   dependencies satisfied, and skips re-running them.

## Filling gaps by hand

If a value can't be produced by a module in your environment (for example, the
Foundry endpoint was created for you out-of-band), you don't need to run that
module at all — just author the outputs file yourself:

```powershell
'{ "foundryEndpoint": "https://acct.services.ai.azure.com/api/projects/proj",
   "foundryModelDeployment": "gpt-4o" }' |
  Set-Content deploy/outputs/foundry.json
```

Then run the downstream modules. The [per-module manual pages](./overview#module-matrix)
list the exact outputs each module must supply, so you always know which keys a
hand-authored file needs.

## When a hard dependency is missing

If you request a module whose dependency is neither run nor satisfiable from
`outputs/`, the orchestrator **stops with an explicit error** naming the missing
module and the keys it must produce — it never silently deploys a half-configured
system. Resolve it by running that dependency, importing its outputs file, or
hand-authoring the required keys as shown above.
