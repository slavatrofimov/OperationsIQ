variable "display_name" {
  type        = string
  description = "Display name of the SPA app registration used to mint Kusto-audience tokens."
  default     = "Operations IQ Eventhouse SPA"
}

variable "redirect_origins" {
  type        = list(string)
  description = "Serving origins. Each becomes an <origin>/blank.html SPA redirect URI (avoids MSAL block_iframe_reload)."
  default     = ["http://localhost:5173"]
}

variable "grant_admin_consent" {
  type        = bool
  description = "Grant tenant-wide admin consent for the Azure Data Explorer user_impersonation scope. Requires a privileged role."
  default     = true
}

# Azure Data Explorer (Kusto) first-party application id. The SPA requests its
# delegated user_impersonation scope to query Eventhouse directly.
variable "adx_application_id" {
  type        = string
  description = "Azure Data Explorer first-party app id."
  default     = "2746ea77-4702-4b45-80ca-3c97e680e8b7"
}
