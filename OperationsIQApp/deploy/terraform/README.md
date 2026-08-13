# Azure Terraform modules

Three independent Terraform roots, each with its own state so a differently
permissioned operator can apply just the ones they're allowed to:

| Dir          | Creates | Provider(s) | Orchestrator module |
|--------------|---------|-------------|---------------------|
| `foundry/`   | Foundry account (`azurerm_cognitive_account` kind AIServices) + project + chat model deployment | azurerm ≥ 4.81 | `foundry` (M1a) |
| `entra/`     | SPA app registration (Kusto tokens) + `/blank.html` redirect URIs + ADX `user_impersonation` + admin consent | azuread ≥ 3.0 | `entra` (M1b) |
| `deploy-sp/` | Optional CI/hand-off service principal + optional Azure role assignment | azuread + azurerm | `deploy-sp` (M1c, off by default) |

## Run a module directly

```bash
cd foundry
terraform init
terraform apply -var subscription_id=<sub> -var location=eastus
terraform output -json
```

The orchestrator drives these the same way and reads `terraform output -json`
into the shared `deploy/outputs/` handoff (see `deploy/lib/Terraform.ps1`).

## Notes

- `entra/` looks up the Azure Data Explorer service principal at plan time to
  resolve the `user_impersonation` scope id by name — no hardcoded scope GUID.
- `foundry/` sets `custom_subdomain_name` so the account gets a stable
  `*.services.ai.azure.com` host; the project endpoint output is
  `https://<account>.services.ai.azure.com/api/projects/<project>`.
- The deployment SP secret is a **sensitive** Terraform output and is NOT
  written to `deploy/outputs/`. Retrieve it from state or Key Vault.
- Fabric workspace **membership** for the SP is granted in Fabric (portal or
  REST), not via Azure RBAC.
