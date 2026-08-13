# =============================================================================
# Optional CI / hand-off deployment service principal. Off by default at the
# orchestrator level (module is Optional). Grants an Azure RBAC role for the
# Azure Terraform modules; Fabric workspace membership is assigned in Fabric.
# =============================================================================

data "azuread_client_config" "current" {}

data "azurerm_subscription" "current" {}

resource "azuread_application" "deployer" {
  display_name = var.display_name
}

resource "azuread_service_principal" "deployer" {
  client_id = azuread_application.deployer.client_id
}

resource "azuread_service_principal_password" "deployer" {
  service_principal_id = azuread_service_principal.deployer.id
}

locals {
  role_scope = var.resource_group_name != "" ? "${data.azurerm_subscription.current.id}/resourceGroups/${var.resource_group_name}" : data.azurerm_subscription.current.id
}

resource "azurerm_role_assignment" "deployer" {
  count                = var.assign_azure_role ? 1 : 0
  scope                = local.role_scope
  role_definition_name = var.azure_role
  principal_id         = azuread_service_principal.deployer.object_id
}
