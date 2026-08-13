output "client_id" {
  description = "Deployment SP application (client) id."
  value       = azuread_application.deployer.client_id
}

output "tenant_id" {
  description = "Entra tenant id."
  value       = data.azuread_client_config.current.tenant_id
}

output "object_id" {
  description = "Deployment SP object id (use to grant Fabric workspace membership)."
  value       = azuread_service_principal.deployer.object_id
}

output "client_secret" {
  description = "Deployment SP client secret. SENSITIVE — store in Key Vault; not written to outputs JSON."
  value       = azuread_service_principal_password.deployer.value
  sensitive   = true
}
