<#
    M2a Fabric Lakehouse — publish the Lakehouse that runs the Livy/Spark pattern
    analyses (fabric-cicd). Produces lakehouseId consumed by the SPA config (M6).
#>
[CmdletBinding()]
param(
    [string]$OutputsDir,
    [hashtable]$Outputs = @{},
    [hashtable]$Config = @{}
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/Common.ps1"
. "$PSScriptRoot/../lib/Fabric.ps1"

$workspaceId = Get-OutputValue -Outputs $Outputs -Key 'workspaceId' -EnvVar 'FABRIC_WORKSPACE_ID' -Required
$result = Invoke-FabricDeploy -WorkspaceId $workspaceId -Items 'lakehouse'

$lakehouseId = $result['lakehouseId']
if (-not $lakehouseId) { throw "fabric driver did not return a lakehouse id." }

Write-ModuleOutputs -ModuleId 'lakehouse' -Values @{ lakehouseId = $lakehouseId; workspaceId = $workspaceId } -OutputsDir $OutputsDir | Out-Null
Write-Ok "Lakehouse id: $lakehouseId"
