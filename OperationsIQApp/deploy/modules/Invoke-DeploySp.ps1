<#
    M1c Deployment service principal (OPTIONAL, off by default).

    Many tenants forbid app/SP creation, so this is not part of a default run —
    name it explicitly with -Modules deploy-sp. Creates an SP + role assignments
    for CI or a hand-off identity via Terraform (deploy/terraform/deploy-sp).

    The client secret is sensitive: Terraform marks it so and this module writes
    only the client id to outputs. Retrieve the secret from Terraform state /
    the configured Key Vault out of band (see the manual doc).
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

$tfDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'terraform/deploy-sp'

$vars = @{}
if ($Config.ContainsKey('deploySpDisplayName')) { $vars.display_name = $Config.deploySpDisplayName }
if ($Config.ContainsKey('azureSubscriptionId')) { $vars.subscription_id = $Config.azureSubscriptionId }
if ($Config.ContainsKey('resourceGroupName'))   { $vars.resource_group_name = $Config.resourceGroupName }

$tf = Invoke-TerraformApply -Dir $tfDir -Vars $vars

$values = @{ deploySpClientId = $tf.client_id }
Write-ModuleOutputs -ModuleId 'deploy-sp' -Values $values -OutputsDir $OutputsDir | Out-Null
Write-Ok "Deployment SP client id: $($values.deploySpClientId)"
Write-Warn "Retrieve the SP secret from Terraform state or Key Vault — it is not written to outputs."
