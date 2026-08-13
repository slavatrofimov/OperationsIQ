# Operations IQ — deployment automation

Modular, idempotent deployment for Operations IQ. One PowerShell orchestrator
(`Deploy-All.ps1`) runs a set of independently runnable **modules** in dependency
order. A fully permissioned operator deploys everything with one command; a
less-permissioned operator runs only the modules they own and picks up the rest
from small JSON hand-off files.

> Full documentation, per-module manual fallbacks, and a permissions decision
> guide live in the docs site under **Admin → Automated deployment**
> (`docs-site/docs/admin/deploy/`).

## Quick start

```powershell
cd OperationsIQApp/deploy

# Inspect first
pwsh ./Deploy-All.ps1 -ListModules
pwsh ./Deploy-All.ps1 -WhatIf

# Deploy everything (non-optional modules) in order
pwsh ./Deploy-All.ps1 -ConfigFile ./config/deploy.config.json

# Or run a subset (deps are pulled in / satisfied from outputs/)
pwsh ./Deploy-All.ps1 -Modules foundry,agent
pwsh ./Deploy-All.ps1 -Skip smoke
```

## Layout

```
deploy/
  Deploy-All.ps1        Orchestrator: -Modules, -Skip, -ConfigFile, -OutputsDir, -WhatIf, -ListModules
  modules.psd1          Module registry (id, deps, tool, role, produces, consumes, manual doc)
  lib/                  Common helpers, module selection + topo-sort, Terraform + Fabric drivers
  modules/              One Invoke-*.ps1 per module (thin wrappers over existing engines)
  terraform/            foundry / entra / deploy-sp roots (independent state each)
  fabric/               fabric-cicd driver + item definitions + REST fallback (app backend)
  config/               Write-EnvFile.ps1 — assemble .env.production from outputs/
  seed/                 Seed-ConnectionProfile.ts — create a ConnectionProfile via the RayFin data API
  outputs/              Inter-module JSON hand-off (git-ignored)
```

## How modules hand off

Each module reads its `Consumes` inputs from `outputs/*.json` (or the config file
/ environment) and writes its `Produces` keys to `outputs/<id>.json`. A
dependency is treated as **satisfied without running** when all its output keys
already exist — so a teammate can run the modules they have rights for, hand you
the resulting JSON, and you run the rest. If a hard dependency is neither run nor
satisfiable, the orchestrator stops with an explicit error.

## Modules

| Id | Tool | Required role | Optional |
|----|------|---------------|----------|
| `preflight` | PowerShell | none | no |
| `foundry` | Terraform | Subscription Contributor + Cognitive Services | no |
| `entra` | Terraform | App Administrator (+ consent) | no |
| `deploy-sp` | Terraform | App Administrator | **yes** |
| `lakehouse` | fabric-cicd | Workspace Admin/Member | no |
| `spark-job` | fabric-cicd | Workspace Member | **yes** |
| `eventhouse-new` | fabric-cicd + REST | Workspace Member | **yes** |
| `app-backend` | rayfin (REST fallback) | Workspace Member | no |
| `eventhouse` | PowerShell + node | KQL DB Admin / Ingestor | no |
| `agent` | node (`agent:provision`) | Foundry project data scientist | no |
| `config` | PowerShell + rayfin | Workspace Member | no |
| `smoke` | PowerShell | user read access | no |

## Prerequisites

- **PowerShell 7+**, **Azure CLI** (`az login`).
- **Terraform ≥ 1.6** for `foundry` / `entra` / `deploy-sp`.
- **Python 3.10+** + `pip install -r fabric/requirements.txt` for the fabric-cicd
  modules.
- **Node.js 18+ / npm** for `agent`, the connection-profile seed, `app-backend`,
  and `config`.

The `preflight` module checks all of these and reports what's missing.

## Tests

- Pester: `deploy/tests/*.Tests.ps1` (module selection, topo order, outputs
  hand-off, `Write-EnvFile`).
- pytest: `deploy/fabric` argument/parameter shaping (mocked REST).
- vitest: the connection-profile seeder payload.
