<#
    M1a Azure AI Foundry — provision the Foundry account, project, and chat
    model deployment via Terraform (deploy/terraform/foundry). Produces the
    project endpoint + model deployment name the agent (M5) and SPA (M6) consume.
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

$tfDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'terraform/foundry'

# Operator-supplied inputs (from config file). Fall back to env for CI.
$vars = @{}
if ($Config.ContainsKey('azureSubscriptionId')) { $vars.subscription_id = $Config.azureSubscriptionId }
if ($Config.ContainsKey('azureLocation'))        { $vars.location = $Config.azureLocation }
if ($Config.ContainsKey('resourceGroupName'))    { $vars.resource_group_name = $Config.resourceGroupName }
if ($Config.ContainsKey('foundryAccountName'))   { $vars.account_name = $Config.foundryAccountName }
if ($Config.ContainsKey('foundryProjectName'))   { $vars.project_name = $Config.foundryProjectName }
if ($Config.ContainsKey('foundryModelName'))     { $vars.model_name = $Config.foundryModelName }
if ($Config.ContainsKey('foundryModelVersion'))  { $vars.model_version = $Config.foundryModelVersion }
if ($Config.ContainsKey('foundryModelSku'))      { $vars.model_sku = $Config.foundryModelSku }

$tf = Invoke-TerraformApply -Dir $tfDir -Vars $vars

$values = @{
    foundryEndpoint        = $tf.project_endpoint
    foundryModelDeployment = $tf.model_deployment_name
    foundryProjectName     = $tf.project_name
}
Write-ModuleOutputs -ModuleId 'foundry' -Values $values -OutputsDir $OutputsDir | Out-Null
Write-Ok "Foundry endpoint: $($values.foundryEndpoint)"
