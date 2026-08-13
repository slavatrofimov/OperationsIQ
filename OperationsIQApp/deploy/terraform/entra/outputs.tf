output "client_id" {
  description = "SPA application (client) id — VITE_MSAL_CLIENT_ID."
  value       = azuread_application.spa.client_id
}

output "tenant_id" {
  description = "Entra tenant id — VITE_MSAL_TENANT_ID."
  value       = data.azuread_client_config.current.tenant_id
}

output "object_id" {
  description = "Application object id."
  value       = azuread_application.spa.object_id
}

output "redirect_uris" {
  description = "Configured SPA redirect URIs."
  value       = local.blank_redirect_uris
}
