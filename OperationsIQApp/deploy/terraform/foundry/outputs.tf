# The project data-plane endpoint the SPA + agent script consume, e.g.
# https://<account>.services.ai.azure.com/api/projects/<project>
output "project_endpoint" {
  description = "Foundry project endpoint (FOUNDRY_PROJECT_ENDPOINT / VITE_FOUNDRY_ENDPOINT)."
  value       = "https://${var.account_name}.services.ai.azure.com/api/projects/${var.project_name}"
}

output "project_name" {
  description = "Foundry project name."
  value       = azurerm_cognitive_account_project.project.name
}

output "account_endpoint" {
  description = "Foundry account control-plane endpoint."
  value       = azurerm_cognitive_account.foundry.endpoint
}

output "model_deployment_name" {
  description = "Chat model deployment name (FOUNDRY_MODEL)."
  value       = azurerm_cognitive_deployment.chat.name
}

output "resource_group_name" {
  value = azurerm_resource_group.rg.name
}
