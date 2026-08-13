---
id: foundry
title: Azure AI Foundry (manual)
sidebar_position: 4
---

# Azure AI Foundry — manual alternative

The `foundry` module runs Terraform in `deploy/terraform/foundry` to create the
Azure AI Foundry account, a project, and a chat model deployment for the
Operations Advisor agent. If you can't run Terraform (or the resources already
exist), reproduce it in the portal / CLI and hand the outputs downstream.

## What gets created

- An **Azure AI Foundry** resource (`azurerm_cognitive_account`, kind
  `AIServices`, SKU `S0`, with a custom subdomain).
- A **project** under that account (`azurerm_cognitive_account_project`).
- One **model deployment** (`azurerm_cognitive_deployment`) for the agent's chat
  model (e.g. `gpt-4o`).
- A role assignment so the operator (and optional deployment SP) can author
  agents in the project.

## Terraform path

```powershell
cd OperationsIQApp/deploy/terraform/foundry
Copy-Item ../terraform.tfvars.example ./terraform.tfvars   # then edit
terraform init
terraform apply
```

Or drive it through the orchestrator, passing values via the config file
(`azureSubscriptionId`, `azureLocation`, `resourceGroupName`,
`foundryAccountName`, `foundryProjectName`, `foundryModelName`,
`foundryModelVersion`, `foundryModelSku`):

```powershell
pwsh ./Deploy-All.ps1 -Modules foundry -ConfigFile ./config/deploy.config.json
```

## Manual portal path

1. In the [Azure AI Foundry portal](https://ai.azure.com), create a new **hub/
   project** (or an AI Foundry resource in the Azure portal under **Azure AI
   services**).
2. Create a project inside it.
3. Under **Deployments**, deploy a chat model (e.g. `gpt-4o`); note the
   **deployment name**.
4. Copy the **project endpoint** — the
   `https://<account>.services.ai.azure.com/api/projects/<project>` URL.
5. Grant yourself (and any deployment identity) the **Azure AI Developer** /
   project data-scientist role.

## Outputs to hand off

Create `deploy/outputs/foundry.json`:

```json
{
  "foundryEndpoint": "https://<account>.services.ai.azure.com/api/projects/<project>",
  "foundryModelDeployment": "<model-deployment-name>",
  "foundryProjectName": "<project-name>"
}
```

These feed the [agent](./agent) module (`FOUNDRY_PROJECT_ENDPOINT` / `FOUNDRY_MODEL`)
and the SPA config (`VITE_FOUNDRY_ENDPOINT`).
