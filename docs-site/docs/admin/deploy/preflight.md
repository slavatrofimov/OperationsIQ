---
id: preflight
title: Preflight (manual)
sidebar_position: 3
---

# Preflight — manual checklist

The `preflight` module (`deploy/modules/Invoke-Preflight.ps1`) just verifies the
CLIs and login state the rest of the pipeline needs. To reproduce it by hand,
confirm each of the following.

## Required for every run

- **Azure CLI (`az`)** — used for Fabric/Kusto REST calls and token acquisition
  by every module. Run `az login` and select the correct tenant/subscription:

  ```powershell
  az login --tenant <tenant-id>
  az account set --subscription <subscription-id>
  az account show
  ```

## Required only for specific modules

| Tool | Needed by | Install |
|------|-----------|---------|
| **Terraform** | `foundry`, `entra`, `deploy-sp` | [developer.hashicorp.com/terraform/install](https://developer.hashicorp.com/terraform/install) |
| **Python 3.10+** | `lakehouse`, `spark-job`, `eventhouse-new` (fabric-cicd) | [python.org/downloads](https://www.python.org/downloads/) then `pip install -r deploy/fabric/requirements.txt` |
| **Node.js 18+ / npm** | `agent`, `eventhouse` seed, `app-backend`, `config` | [nodejs.org](https://nodejs.org) |

If a tool is only used by modules you are **not** running, you can skip it — the
module you skip has its outputs supplied by a teammate (see the
[permissions decision guide](./permissions-decision-guide)).

## Output

On success the module writes `outputs/preflight.json` with
`{ "preflightOk": true, "azLoggedIn": true }`. Downstream modules don't strictly
require this file, but running preflight first surfaces missing tooling before a
long deployment starts.
