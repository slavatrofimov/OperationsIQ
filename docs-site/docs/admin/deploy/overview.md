---
id: overview
title: Automated deployment
sidebar_position: 1
---

# Automated deployment

The `OperationsIQApp/deploy/` orchestrator turns the manual runbook into a set of
**independently runnable modules** driven by one PowerShell entry point,
`Deploy-All.ps1`. A highly-permissioned operator can deploy the whole solution
with a single command; a less-permissioned operator can run just the modules they
have rights for and hand the rest off to a teammate.

## The one-command path

```powershell
cd OperationsIQApp/deploy
pwsh ./Deploy-All.ps1 -ConfigFile ./config/deploy.config.json
```

That runs every non-optional module in dependency order:

**preflight → foundry → entra → lakehouse → app-backend → eventhouse → agent → config → smoke**

Optional modules (`deploy-sp`, `spark-job`, `eventhouse-new`) are **excluded**
from the default run and must be named explicitly.

## Inspecting before you run

```powershell
pwsh ./Deploy-All.ps1 -ListModules          # print the registry (id, tool, role, deps)
pwsh ./Deploy-All.ps1 -WhatIf               # print the ordered plan, run nothing
pwsh ./Deploy-All.ps1 -Modules agent -WhatIf   # plan just the agent + its unmet deps
```

## How modularity works

Each module is a thin wrapper over the existing engines (`Retrofit-Eventhouse.ps1`,
`rayfin up`, `agent:provision`, Terraform, fabric-cicd). It:

1. **Reads its inputs** (`Consumes`) from `deploy/outputs/*.json`, or from the
   config file / environment.
2. Does **idempotent** create-or-update work (safe to re-run).
3. **Writes its outputs** (`Produces`) back to `deploy/outputs/<id>.json`.

A dependency is considered **satisfied without running** when all of its output
keys already exist in `outputs/`. This is the mechanism that lets differently
permissioned people split the work: a teammate who owns Azure runs `foundry` and
`entra`, commits (or hands you) the small `outputs/foundry.json` +
`outputs/entra.json`, and you run the Fabric-side modules — which pick those
values up automatically.

See the [permissions decision guide](./permissions-decision-guide) to map *"what
you can deploy given your permissions"* to a concrete `-Modules` list.

## Module matrix

| Id | Module | Tool | Required role | Optional | Manual page |
|----|--------|------|---------------|----------|-------------|
| `preflight` | Preflight checks | PowerShell | none | no | [preflight](./preflight) |
| `foundry` | Azure AI Foundry | Terraform | Subscription Contributor + Cognitive Services | no | [foundry](./foundry) |
| `entra` | Entra MSAL SPA app | Terraform | App Administrator (+ consent) | no | [entra-app-registration](../entra-app-registration) |
| `deploy-sp` | Deployment service principal | Terraform | App Administrator | **yes** | [deploy-sp](./deploy-sp) |
| `lakehouse` | Fabric Lakehouse | fabric-cicd | Workspace Admin/Member | no | [fabric-items](./fabric-items) |
| `spark-job` | Spark Job Definition | fabric-cicd | Workspace Member | **yes** | [fabric-items](./fabric-items) |
| `eventhouse-new` | New Eventhouse + KQL DB (sample) | fabric-cicd + REST | Workspace Member | **yes** | [fabric-items](./fabric-items) |
| `app-backend` | Fabric App backend (RayFin) | rayfin (REST fallback) | Workspace Member | no | [rayfin-backend](../rayfin-backend) |
| `eventhouse` | Eventhouse enablement + seed + profile | PowerShell + node | KQL DB Admin / Ingestor | no | [eventhouse-deployment](../eventhouse-deployment) |
| `agent` | Foundry agent | node (`agent:provision`) | Foundry project data scientist | no | [agent](./agent) |
| `config` | Config assembly + build/publish | PowerShell + rayfin | Workspace Member | no | [configuration](../configuration) |
| `smoke` | Smoke validation | PowerShell | user read access | no | [smoke](./smoke) |

## Configuration file

`Deploy-All.ps1 -ConfigFile` accepts a JSON object whose keys seed module inputs
(anything a module can also read from `outputs/`). Common keys:

```json
{
  "workspaceId": "<fabric-workspace-guid>",
  "subscriptionId": "<azure-subscription-guid>",
  "location": "westus2",
  "eventhouseMode": "retrofit",
  "clusterUri": "https://<cluster>.kusto.fabric.microsoft.com",
  "eventhouseId": "<existing-eventhouse-item-id>",
  "sourceDatabase": "<customer-source-kql-db>",
  "companionDatabase": "OperationsIQ",
  "connectionProfileName": "Sample (Contoso)",
  "seedConnectionProfile": true
}
```

Set `"eventhouseMode": "greenfield-sample"` (and run `-Modules eventhouse-new`)
to provision a brand-new Eventhouse seeded with the richer, time-relative sample
data instead of retrofitting an existing one.

## What each module hands off

The end goal of the pipeline is a populated `.env.production` (see
[Configuration](../configuration)) and a published SPA. The `config` module
merges every `outputs/*.json` into that file, validating that all required
`VITE_*` keys are present and reporting which module supplied each one.
