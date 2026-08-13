---
id: agent
title: Foundry agent (manual)
sidebar_position: 7
---

# Foundry agent — manual alternative

The `agent` module wraps the existing `agent:provision` script
(`scripts/provision-foundry-agent.ts`) to create or version the **Operations
Advisor** agent in the Foundry project created by [foundry](./foundry).

## Inputs

From `outputs/foundry.json` (or environment):

- `foundryEndpoint` → `FOUNDRY_PROJECT_ENDPOINT`
- `foundryModelDeployment` → `FOUNDRY_MODEL`

Plus `agentName` (config; default `operations-advisor`).

## Pipeline path

```powershell
pwsh ./Deploy-All.ps1 -Modules agent -ConfigFile ./config/deploy.config.json
```

## Manual / direct path

```powershell
cd OperationsIQApp
$env:FOUNDRY_PROJECT_ENDPOINT = "https://<account>.services.ai.azure.com/api/projects/<project>"
$env:FOUNDRY_MODEL = "<model-deployment-name>"
$env:FOUNDRY_AGENT_NAME = "operations-advisor"

npm run agent:provision -- --dry-run    # preview the agent body + tool schemas
npm run agent:provision                 # create/version the agent
```

The tool catalog and system instructions come from the app's own registry
(`src/lib/agent/registry.ts`) and `docs/agent-instructions.md` — this is the same
engine the app team uses, so the deployed agent always matches the app's tools.
Authentication uses an `az` token for the `https://ai.azure.com/.default` scope,
so `az login` with an identity that has the project **data-scientist** role.

See [foundry-tool-catalog-provisioning](https://github.com/slavatrofimov/TimeIQ)
(`OperationsIQApp/docs/foundry-tool-catalog-provisioning.md`) for the full
runbook.

## Outputs to hand off

`outputs/agent.json`: `{ "agentName": "operations-advisor", "agentVersion": "<n>" }`
— consumed by the SPA config (`VITE_FOUNDRY_AGENT_NAME` / `_VERSION`).
