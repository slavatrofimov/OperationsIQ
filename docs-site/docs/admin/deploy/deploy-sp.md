---
id: deploy-sp
title: Deployment service principal (manual)
sidebar_position: 5
---

# Deployment service principal — optional

`deploy-sp` is **optional and off by default** — many tenants forbid app/SP
creation, so it is never part of a default `Deploy-All.ps1` run. Use it only when
you want a dedicated identity for CI or to hand deployment rights to a
lower-privileged operator. Name it explicitly:

```powershell
pwsh ./Deploy-All.ps1 -Modules deploy-sp -ConfigFile ./config/deploy.config.json
```

## What it creates

Terraform in `deploy/terraform/deploy-sp` (azuread provider) creates an
application + service principal and assigns the Azure/Fabric roles the pipeline
needs. Config keys: `deploySpDisplayName`, `azureSubscriptionId`,
`resourceGroupName`.

## Handling the secret

The client **secret is sensitive**. Terraform marks it sensitive and the module
writes only `deploySpClientId` to `outputs/deploy-sp.json` — never the secret.
Retrieve the secret out of band:

```powershell
cd OperationsIQApp/deploy/terraform/deploy-sp
terraform output -raw client_secret        # or read it from your Key Vault
```

Store it in a secret store (Key Vault / GitHub Actions secret), not in the repo
or the outputs directory.

## Manual portal path

1. **Entra ID → App registrations → New registration**; note the
   **Application (client) ID** and **Directory (tenant) ID**.
2. **Certificates & secrets → New client secret**; copy the value immediately.
3. Assign the roles the deployment needs (e.g. Fabric workspace **Member**,
   subscription **Contributor** on the target resource group).
4. Record `deploySpClientId` in `deploy/outputs/deploy-sp.json` if downstream
   automation consumes it.
