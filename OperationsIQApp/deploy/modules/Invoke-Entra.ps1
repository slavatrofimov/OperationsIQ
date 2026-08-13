<#
    M1b Entra MSAL SPA app registration — the SPA-platform app used only to mint
    Kusto-audience tokens for direct read-only Eventhouse queries (PKCE, no
    secret). Terraform (deploy/terraform/entra) creates the app, its /blank.html
    redirect URIs, the Azure Data Explorer user_impersonation permission, and the
    admin-consent grant.

    Redirect URIs must include every serving origin. The app origin comes from
    M3 (app-backend) once known; on a first pass without it, only localhost is
    registered and this module can be re-run after M3 to add the deployed origin.
#>
[CmdletBinding()]
param(
    [string]$OutputsDir,
    [hashtable]$Outputs = @{},
    [hashtable]$Config = @{}
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/Common.ps1"
. "$PSScriptRoot/../lib/Terraform.ps1"

$tfDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'terraform/entra'

# Assemble the redirect origins: always localhost dev, plus the deployed app
# origin if a prior module produced it.
$origins = New-Object System.Collections.Generic.List[string]
$origins.Add('http://localhost:5173')
$appOrigin = Get-OutputValue -Outputs $Outputs -Key 'appOrigin'
if ($appOrigin) { $origins.Add([string]$appOrigin) }
if ($Config.ContainsKey('extraRedirectOrigins')) {
    foreach ($o in @($Config.extraRedirectOrigins)) { $origins.Add([string]$o) }
}

$vars = @{
    display_name    = if ($Config.ContainsKey('msalAppDisplayName')) { $Config.msalAppDisplayName } else { 'Operations IQ Eventhouse SPA' }
    redirect_origins = @($origins | Select-Object -Unique)
}
if ($Config.ContainsKey('grantAdminConsent')) { $vars.grant_admin_consent = [bool]$Config.grantAdminConsent }

$tf = Invoke-TerraformApply -Dir $tfDir -Vars $vars

$values = @{
    msalClientId = $tf.client_id
    tenantId     = $tf.tenant_id
}
Write-ModuleOutputs -ModuleId 'entra' -Values $values -OutputsDir $OutputsDir | Out-Null
Write-Ok "MSAL client id: $($values.msalClientId)"
if (-not $appOrigin) {
    Write-Warn "No app origin yet — re-run 'entra' after 'app-backend' to add the deployed redirect URI."
}
