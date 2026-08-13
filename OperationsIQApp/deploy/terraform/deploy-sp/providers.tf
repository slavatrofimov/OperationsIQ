terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azuread = {
      source  = "hashicorp/azuread"
      version = ">= 3.0.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.0.0"
    }
  }
}

provider "azuread" {}

provider "azurerm" {
  subscription_id = var.subscription_id != "" ? var.subscription_id : null
  features {}
}
