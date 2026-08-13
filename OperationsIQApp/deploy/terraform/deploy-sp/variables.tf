variable "display_name" {
  type        = string
  description = "Display name of the deployment service principal."
  default     = "operations-iq-deployer"
}

variable "subscription_id" {
  type        = string
  description = "Azure subscription id for the optional Azure role assignment. Empty = az CLI default."
  default     = ""
}

variable "resource_group_name" {
  type        = string
  description = "Resource group to scope the Azure role assignment to. Empty = subscription scope."
  default     = ""
}

variable "assign_azure_role" {
  type        = bool
  description = "Assign an Azure RBAC role (Contributor) so the SP can run the Azure Terraform modules. Fabric workspace membership is granted separately in Fabric."
  default     = false
}

variable "azure_role" {
  type        = string
  description = "Azure RBAC role to assign when assign_azure_role is true."
  default     = "Contributor"
}
