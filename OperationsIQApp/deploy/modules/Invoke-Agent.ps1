<#
    M5 Foundry agent — create/version the Operations Advisor agent in the Foundry
    project, reusing the existing scripts/provision-foundry-agent.ts engine. The
    Foundry project endpoint + model deployment come from M1a (foundry) outputs.
#>
[CmdletBinding()]
param(
    [string]$OutputsDir,
    [hashtable]$Outputs = @{},
    [hashtable]$Config = @{}
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/Common.ps1"

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # -> OperationsIQApp

$endpoint = Get-OutputValue -Outputs $Outputs -Key 'foundryEndpoint' -EnvVar 'FOUNDRY_PROJECT_ENDPOINT' -Required
$model    = Get-OutputValue -Outputs $Outputs -Key 'foundryModelDeployment' -EnvVar 'FOUNDRY_MODEL' -Required
$agentName = if ($Config.ContainsKey('agentName')) { [string]$Config.agentName } else { 'operations-advisor' }

if (-not (Test-Command 'npm')) { throw "npm required to run agent:provision." }

$env:FOUNDRY_PROJECT_ENDPOINT = $endpoint
$env:FOUNDRY_MODEL = $model
$env:FOUNDRY_AGENT_NAME = $agentName
if ($Config.ContainsKey('agentDescription')) { $env:FOUNDRY_AGENT_DESCRIPTION = [string]$Config.agentDescription }

$dryRun = $false
if ($Config.ContainsKey('agentDryRun')) { $dryRun = [bool]$Config.agentDryRun }

$args = @('run', 'agent:provision')
if ($dryRun) { $args += @('--', '--dry-run') }
Invoke-External -FilePath 'npm' -Arguments $args -WorkingDirectory $appRoot

$values = @{ agentName = $agentName }
if ($Config.ContainsKey('agentVersion')) { $values.agentVersion = $Config.agentVersion }
Write-ModuleOutputs -ModuleId 'agent' -Values $values -OutputsDir $OutputsDir | Out-Null
Write-Ok "Agent '$agentName' provisioned in $endpoint"
