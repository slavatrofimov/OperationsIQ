<#
    M6 Config assembly + build/publish. Assembles .env.production from all module
    outputs (deploy/config/Write-EnvFile.ps1), then optionally rebuilds and
    republishes the SPA via the rayfin CLI so the deployed app carries the config.
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
$writeEnv = Join-Path $appRoot 'deploy/config/Write-EnvFile.ps1'

$envArgs = @{ OutputsDir = $OutputsDir }
if ($Config.ContainsKey('envFile')) { $envArgs.OutFile = [string]$Config.envFile }
if ($Config.ContainsKey('requireOptionalConfig') -and [bool]$Config.requireOptionalConfig) { $envArgs.RequireOptional = $true }

$envPath = & $writeEnv @envArgs

$publish = $true
if ($Config.ContainsKey('publishSpa')) { $publish = [bool]$Config.publishSpa }

if ($publish) {
    if (-not (Test-Command 'npm')) { throw "npm required to build + publish the SPA." }
    Write-Info 'Rebuilding + republishing the SPA (rayfin up)...'
    Invoke-External -FilePath 'npm' -Arguments @('run', 'rayfin:up') -WorkingDirectory $appRoot
} else {
    Write-Info 'publishSpa=false — env assembled but SPA not republished.'
}

Write-ModuleOutputs -ModuleId 'config' -Values @{ envFile = "$envPath"; published = $publish } -OutputsDir $OutputsDir | Out-Null
Write-Ok "Config assembled at $envPath"
