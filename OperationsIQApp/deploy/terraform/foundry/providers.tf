terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      # kind = "AIServices" + azurerm_cognitive_account_project need a recent provider.
      version = ">= 4.81.0"
    }
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id != "" ? var.subscription_id : null
  features {}
}
