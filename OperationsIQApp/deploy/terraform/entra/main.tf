# =============================================================================
# Entra SPA app registration for direct read-only Eventhouse (Kusto) access.
# PKCE, no client secret. Redirect URIs are <origin>/blank.html for every origin
# so MSAL's iframe silent-token renewal doesn't reload the app (block_iframe_reload).
# =============================================================================

data "azuread_client_config" "current" {}

# Look up the Azure Data Explorer service principal so we can reference its
# user_impersonation delegated scope id by name (no hardcoded scope GUID).
data "azuread_service_principal" "adx" {
  client_id = var.adx_application_id
}

locals {
  blank_redirect_uris = [for o in var.redirect_origins : "${trimsuffix(o, "/")}/blank.html"]
}

resource "azuread_application" "spa" {
  display_name     = var.display_name
  sign_in_audience = "AzureADMyOrg"

  single_page_application {
    redirect_uris = local.blank_redirect_uris
  }

  required_resource_access {
    resource_app_id = var.adx_application_id

    resource_access {
      id   = data.azuread_service_principal.adx.oauth2_permission_scope_ids["user_impersonation"]
      type = "Scope"
    }
  }
}

resource "azuread_service_principal" "spa" {
  client_id = azuread_application.spa.client_id
}

# Optional tenant-wide admin consent for the ADX user_impersonation scope.
resource "azuread_service_principal_delegated_permission_grant" "adx_consent" {
  count                                = var.grant_admin_consent ? 1 : 0
  service_principal_object_id          = azuread_service_principal.spa.object_id
  resource_service_principal_object_id = data.azuread_service_principal.adx.object_id
  claim_values                         = ["user_impersonation"]
}
