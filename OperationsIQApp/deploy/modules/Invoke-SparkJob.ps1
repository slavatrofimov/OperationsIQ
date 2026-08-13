<#
    M2b Spark Job Definition (OPTIONAL). The SPA inlines the tsmp package into
    each Livy statement, so a standalone Spark Job Definition is only needed for
    headless/batch runs. Name it explicitly with -Modules spark-job.
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
$result = Invoke-FabricDeploy -WorkspaceId $workspaceId -Items 'sparkjob'

$sparkJobDefId = $result['sparkJobDefId']
Write-ModuleOutputs -ModuleId 'spark-job' -Values @{ sparkJobDefId = $sparkJobDefId } -OutputsDir $OutputsDir | Out-Null
Write-Ok "Spark Job Definition id: $sparkJobDefId"
