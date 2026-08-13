<#
    M4 Eventhouse enablement + sample seed + connection profile.

    Two sub-paths, chosen automatically:

    * greenfield-sample: if the optional 'eventhouse-new' module ran (or Config
      requests it), deploy the app schema WITH base tables and seed the richer
      time-relative sample data into the new KQL database.

    * retrofit (default): create an app-owned companion KQL database on the
      EXISTING customer Eventhouse and deploy the app schema only (no base
      tables) — the raw data stays in the source DB and is read cross-database.

    Then (optional) seed a ConnectionProfile row via deploy/seed so the app opens
    ready-to-use. Idempotent: reuses the companion DB and updates the profile.
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
$deployDir = Join-Path $appRoot 'eventhouse/deploy'

$mode = Get-OutputValue -Outputs $Outputs -Key 'eventhouseMode' -Default (
    $(if ($Config.ContainsKey('eventhouseMode')) { [string]$Config.eventhouseMode } else { 'retrofit' })
)
$clusterUri = Get-OutputValue -Outputs $Outputs -Key 'clusterUri' -EnvVar 'EVENTHOUSE_QUERY_URI'
if (-not $clusterUri -and $Config.ContainsKey('clusterUri')) { $clusterUri = [string]$Config.clusterUri }
if (-not $clusterUri) { throw "Eventhouse 'clusterUri' not found. Provide it via config, or run 'eventhouse-new'." }

$companionDb = ''

if ($mode -eq 'greenfield-sample') {
    $companionDb = Get-OutputValue -Outputs $Outputs -Key 'sampleDatabaseName' -Default 'OperationsIQSample'
    Write-Info "Greenfield sample deploy into '$companionDb' on $clusterUri"
    $deployArgs = @{
        ClusterUri        = $clusterUri
        Database          = $companionDb
        CreateBaseTables  = $true
        IncludeSampleData = $true
    }
    & (Join-Path $deployDir 'Deploy-Eventhouse.ps1') @deployArgs
    & (Join-Path $deployDir 'Validate-Eventhouse.ps1') -ClusterUri $clusterUri -Database $companionDb -RequireBaseTables
} else {
    # Retrofit an existing Eventhouse.
    $workspaceId  = Get-OutputValue -Outputs $Outputs -Key 'workspaceId' -EnvVar 'FABRIC_WORKSPACE_ID'
    if (-not $workspaceId -and $Config.ContainsKey('workspaceId')) { $workspaceId = [string]$Config.workspaceId }
    $eventhouseId = Get-OutputValue -Outputs $Outputs -Key 'eventhouseId'
    if (-not $eventhouseId -and $Config.ContainsKey('eventhouseId')) { $eventhouseId = [string]$Config.eventhouseId }
    $sourceDb     = if ($Config.ContainsKey('sourceDatabase')) { [string]$Config.sourceDatabase } else { '' }
    $companionDb  = if ($Config.ContainsKey('companionDatabase')) { [string]$Config.companionDatabase } else { 'OperationsIQ' }

    foreach ($req in @(@{n='workspaceId';v=$workspaceId}, @{n='eventhouseId';v=$eventhouseId}, @{n='sourceDatabase';v=$sourceDb})) {
        if (-not $req.v) { throw "Retrofit needs '$($req.n)'. Supply it in the config file (or run 'eventhouse-new' for the sample path)." }
    }

    Write-Info "Retrofit companion '$companionDb' on Eventhouse $eventhouseId (source '$sourceDb')"
    $retroArgs = @{
        WorkspaceId       = $workspaceId
        EventhouseId      = $eventhouseId
        ClusterUri        = $clusterUri
        SourceDatabase    = $sourceDb
        CompanionDatabase = $companionDb
    }
    & (Join-Path $deployDir 'Retrofit-Eventhouse.ps1') @retroArgs
}

$values = @{
    companionDatabase  = $companionDb
    eventhouseQueryUri = $clusterUri
}

# --- Optional: seed a connection profile via the RayFin data API -------------
$seedProfile = $true
if ($Config.ContainsKey('seedConnectionProfile')) { $seedProfile = [bool]$Config.seedConnectionProfile }

if ($seedProfile) {
    $rayfinApiUrl = Get-OutputValue -Outputs $Outputs -Key 'rayfinApiUrl' -EnvVar 'RAYFIN_API_URL'
    $rayfinKey    = Get-OutputValue -Outputs $Outputs -Key 'rayfinPublishableKey' -EnvVar 'RAYFIN_PUBLISHABLE_KEY'
    if ($rayfinApiUrl -and $rayfinKey -and (Test-Command 'node')) {
        $seedScript = Join-Path $appRoot 'deploy/seed/Seed-ConnectionProfile.ts'
        $profileName = if ($Config.ContainsKey('connectionProfileName')) { [string]$Config.connectionProfileName } else { 'Sample (Contoso)' }
        $sourceDb = if ($Config.ContainsKey('sourceDatabase')) { [string]$Config.sourceDatabase } else { $companionDb }
        $env:SEED_RAYFIN_API_URL = $rayfinApiUrl
        $env:SEED_RAYFIN_PUBLISHABLE_KEY = $rayfinKey
        $env:SEED_EVENTHOUSE_QUERY_URI = $clusterUri
        $env:SEED_COMPANION_DB = $companionDb
        $env:SEED_SOURCE_DB = $sourceDb
        $env:SEED_PROFILE_NAME = $profileName
        $env:SEED_MODE = $mode
        try {
            Invoke-External -FilePath 'npx' -Arguments @('vite-node', '--config', 'scripts/provision.vite.config.ts', 'deploy/seed/Seed-ConnectionProfile.ts') -WorkingDirectory $appRoot
            $values.connectionProfileId = 'seeded'
        } catch {
            Write-Warn "Connection-profile seeding failed: $($_.Exception.Message). Create the profile in the app UI (queries printed by the retrofit tool)."
        }
    } else {
        Write-Warn "Skipping connection-profile seed (need rayfinApiUrl + rayfinPublishableKey + node). Create it in the app UI instead."
    }
}

Write-ModuleOutputs -ModuleId 'eventhouse' -Values $values -OutputsDir $OutputsDir | Out-Null
Write-Ok "Eventhouse ready: db '$companionDb' on $clusterUri"
