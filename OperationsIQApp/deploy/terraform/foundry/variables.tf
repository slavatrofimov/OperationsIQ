variable "subscription_id" {
  type        = string
  description = "Azure subscription id. Leave empty to use the az CLI's current subscription."
  default     = ""
}

variable "location" {
  type        = string
  description = "Azure region for the Foundry account + project."
  default     = "eastus"
}

variable "resource_group_name" {
  type        = string
  description = "Resource group to hold the Foundry resources. Created if it does not exist."
  default     = "rg-operations-iq"
}

variable "account_name" {
  type        = string
  description = "Foundry (Cognitive/AIServices) account name. Must be globally unique."
  default     = "operations-iq-foundry"
}

variable "project_name" {
  type        = string
  description = "Foundry project name."
  default     = "operations-iq"
}

variable "model_name" {
  type        = string
  description = "Chat model to deploy for the agent (e.g. gpt-4o, gpt-4.1)."
  default     = "gpt-4o"
}

variable "model_version" {
  type        = string
  description = "Model version. Leave empty to let Azure pick the default for the model."
  default     = ""
}

variable "model_format" {
  type        = string
  description = "Model publisher/format."
  default     = "OpenAI"
}

variable "model_sku" {
  type        = string
  description = "Deployment SKU name (e.g. GlobalStandard, Standard, DataZoneStandard)."
  default     = "GlobalStandard"
}

variable "model_capacity" {
  type        = number
  description = "Deployment capacity in thousands of TPM."
  default     = 20
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to created resources."
  default     = { app = "operations-iq" }
}
