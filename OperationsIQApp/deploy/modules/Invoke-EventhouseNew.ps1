<#
    M2c New Eventhouse + KQL DB (OPTIONAL, off by default).

    For demos/trials where no data Eventhouse exists: provision a NEW Eventhouse
    and a KQL database via fabric-cicd (REST fallback for the KQL DB creation
    payload). The follow-on M4 (eventhouse) module deploys the schema and seeds
    the richer sample data into it; M4 reads clusterUri + sampleDatabaseName from
    this module's outputs. Name it explicitly with -Modules eventhouse-new.
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
$sampleDbName = if ($Config.ContainsKey('sampleDatabaseName')) { [string]$Config.sampleDatabaseName } else { 'OperationsIQSample' }

$extra = @{ 'kql-database-name' = $sampleDbName }
$result = Invoke-FabricDeploy -WorkspaceId $workspaceId -Items 'eventhouse' -ExtraArgs $extra

$values = @{
    eventhouseId       = $result['eventhouseId']
    clusterUri         = $result['clusterUri']
    kqlDatabaseId      = $result['kqlDatabaseId']
    sampleDatabaseName = $sampleDbName
    # Signal to M4 that it should deploy base tables + seed sample data here.
    eventhouseMode     = 'greenfield-sample'
}
Write-ModuleOutputs -ModuleId 'eventhouse-new' -Values $values -OutputsDir $OutputsDir | Out-Null
Write-Ok "New Eventhouse: $($values.eventhouseId)  cluster: $($values.clusterUri)  db: $sampleDbName"
