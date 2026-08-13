# =============================================================================
# Azure AI Foundry (modern, hubless): a Cognitive Account of kind "AIServices"
# hosting an AI Foundry project, plus a chat model deployment for the agent.
# =============================================================================

resource "azurerm_resource_group" "rg" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

# The Foundry account. kind = "AIServices" gives the superset (OpenAI + Foundry
# agents). custom_subdomain_name is required so the account gets a stable
# *.services.ai.azure.com data-plane hostname used to build the project endpoint.
resource "azurerm_cognitive_account" "foundry" {
  name                  = var.account_name
  location              = azurerm_resource_group.rg.location
  resource_group_name   = azurerm_resource_group.rg.name
  kind                  = "AIServices"
  sku_name              = "S0"
  custom_subdomain_name = var.account_name

  identity {
    type = "SystemAssigned"
  }

  tags = var.tags
}

# The AI Foundry project (modern replacement for azurerm_ai_foundry_project).
resource "azurerm_cognitive_account_project" "project" {
  name                 = var.project_name
  cognitive_account_id = azurerm_cognitive_account.foundry.id
  location             = azurerm_cognitive_account.foundry.location

  identity {
    type = "SystemAssigned"
  }

  tags = var.tags
}

# The chat model deployment the agent runs on.
resource "azurerm_cognitive_deployment" "chat" {
  name                 = var.model_name
  cognitive_account_id = azurerm_cognitive_account.foundry.id

  model {
    format  = var.model_format
    name    = var.model_name
    version = var.model_version != "" ? var.model_version : null
  }

  sku {
    name     = var.model_sku
    capacity = var.model_capacity
  }
}
