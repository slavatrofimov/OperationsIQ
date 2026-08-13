<#
    M3 Fabric App backend (RayFin control plane).

    Primary path: the rayfin CLI (`npm run rayfin:up` then `rayfin:db:apply`),
    which provisions the Fabric App item + SQL DB + GraphQL + static hosting AND
    applies the @entity schema (ConnectionProfile / Annotation / SignalMetadata /
    ...). This is the recommended path because the REST API does NOT apply the
    SQL schema.

    Fallback path (Config.appBackendMode = 'rest'): create the App Backend item
    via the Fabric REST API (POST .../appBackends) using deploy/fabric/rest/
    create_app_backend.py, then apply the schema separately with rayfin:db:apply.

    Redirect URIs: rayfin.yml's allowedRedirectUris must include every serving
    origin. This module ensures the configured origins are present before
    `rayfin up` publishes.
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
$rayfinYml = Join-Path $appRoot 'rayfin/rayfin.yml'

$workspaceId = Get-OutputValue -Outputs $Outputs -Key 'workspaceId' -EnvVar 'FABRIC_WORKSPACE_ID'
$mode = if ($Config.ContainsKey('appBackendMode')) { [string]$Config.appBackendMode } else { 'cli' }

# --- Ensure configured redirect origins are present in rayfin.yml -------------
$origins = New-Object System.Collections.Generic.List[string]
if ($Config.ContainsKey('appRedirectOrigins')) {
    foreach ($o in @($Config.appRedirectOrigins)) { $origins.Add([string]$o) }
}
if ($origins.Count -gt 0 -and (Test-Path $rayfinYml)) {
    $yml = Get-Content -Path $rayfinYml -Raw
    foreach ($o in $origins) {
        if ($yml -notmatch [regex]::Escape($o)) {
            Write-Warn "rayfin.yml is missing redirect origin '$o'. Add it under services.auth.allowedRedirectUris before publishing."
        }
    }
}

if (-not (Test-Command 'npm')) {
    throw "npm is not installed. Install Node.js LTS, or follow the manual rayfin-backend doc."
}

if ($mode -eq 'rest') {
    Write-Info 'App backend mode: REST fallback.'
    if (-not $workspaceId) { throw "REST app-backend creation needs 'workspaceId' (config or upstream outputs)." }
    $py = if (Test-Command 'python') { 'python' } elseif (Test-Command 'python3') { 'python3' } else { throw 'Python required for the REST fallback.' }
    $restScript = Join-Path $appRoot 'deploy/fabric/rest/create_app_backend.py'
    $displayName = if ($Config.ContainsKey('appDisplayName')) { [string]$Config.appDisplayName } else { 'Operations IQ' }
    & $py $restScript '--workspace-id' $workspaceId '--display-name' $displayName
    if ($LASTEXITCODE -ne 0) { throw "REST app-backend creation failed (exit $LASTEXITCODE)." }
    Write-Info 'Applying entity schema via rayfin CLI...'
    Invoke-External -FilePath 'npm' -Arguments @('run', 'rayfin:db:apply') -WorkingDirectory $appRoot
} else {
    Write-Info 'App backend mode: rayfin CLI (recommended).'
    Invoke-External -FilePath 'npm' -Arguments @('run', 'rayfin:up') -WorkingDirectory $appRoot
    Invoke-External -FilePath 'npm' -Arguments @('run', 'rayfin:db:apply') -WorkingDirectory $appRoot
}

# rayfin surfaces the deployed app origin / api url / publishable key in its own
# output. When the operator has them (from the CLI output or the Fabric portal),
# they can be supplied via config so downstream modules resolve automatically.
$values = @{ workspaceId = $workspaceId }
foreach ($pair in @(
    @{ k = 'appOrigin';            c = 'appOrigin' },
    @{ k = 'rayfinApiUrl';         c = 'rayfinApiUrl' },
    @{ k = 'rayfinPublishableKey'; c = 'rayfinPublishableKey' },
    @{ k = 'fabricItemId';         c = 'fabricItemId' }
)) {
    if ($Config.ContainsKey($pair.c)) { $values[$pair.k] = $Config[$pair.c] }
}

Write-ModuleOutputs -ModuleId 'app-backend' -Values $values -OutputsDir $OutputsDir | Out-Null

if (-not $values.ContainsKey('appOrigin')) {
    Write-Warn "App origin/api-url/publishable-key not captured. Copy them from the rayfin output (or Fabric portal) into your config file and re-run 'entra' + 'config', or add them to outputs/app-backend.json."
}
Write-Ok 'App backend provisioned.'
