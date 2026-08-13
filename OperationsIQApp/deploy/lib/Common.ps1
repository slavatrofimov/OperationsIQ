<#
    Shared helpers for the Operations IQ deployment orchestrator.

    Dot-source this file from Deploy-All.ps1 and the per-module scripts:

        . "$PSScriptRoot/lib/Common.ps1"

    The functions here implement the module "outputs contract": every module
    reads the inputs it *consumes* from outputs/*.json and writes the values it
    *produces* back to outputs/<module>.json. That JSON handoff is what lets a
    less-permissioned operator run a subset of modules and let a teammate (or a
    manual step) supply the rest.

    Requires PowerShell 7+ (uses utf8NoBOM encoding, matching the existing
    eventhouse/deploy scripts).
#>

Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Console helpers
# ---------------------------------------------------------------------------
function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Info { param([string]$Message) Write-Host "    $Message" }
function Write-Ok   { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "    $Message" -ForegroundColor Yellow }
function Write-Err  { param([string]$Message) Write-Host "    $Message" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# Outputs store (the inter-module JSON handoff)
# ---------------------------------------------------------------------------

# Resolve the outputs directory, creating it on first use.
function Get-OutputsDir {
    param([string]$OutputsDir)
    if (-not $OutputsDir) {
        $OutputsDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'outputs'
    }
    if (-not (Test-Path $OutputsDir)) {
        New-Item -ItemType Directory -Path $OutputsDir -Force | Out-Null
    }
    return (Resolve-Path $OutputsDir).Path
}

# Merge every outputs/*.json into a single hashtable (later files win on key
# collisions, but modules are namespaced enough that collisions are rare). This
# is the "resolved deployment state" every module reads its inputs from.
function Read-Outputs {
    param([string]$OutputsDir)
    $dir = Get-OutputsDir -OutputsDir $OutputsDir
    $merged = @{}
    Get-ChildItem -Path $dir -Filter '*.json' -ErrorAction SilentlyContinue |
        Sort-Object Name | ForEach-Object {
            try {
                $obj = Get-Content -Path $_.FullName -Raw | ConvertFrom-Json
            } catch {
                Write-Warn "Ignoring malformed outputs file $($_.Name): $($_.Exception.Message)"
                return
            }
            foreach ($prop in $obj.PSObject.Properties) {
                $merged[$prop.Name] = $prop.Value
            }
        }
    return $merged
}

# Persist the values a module produced to outputs/<ModuleId>.json (merging with
# anything already there so re-runs are additive). Returns the file path.
function Write-ModuleOutputs {
    param(
        [Parameter(Mandatory)] [string]$ModuleId,
        [Parameter(Mandatory)] [hashtable]$Values,
        [string]$OutputsDir
    )
    $dir = Get-OutputsDir -OutputsDir $OutputsDir
    $path = Join-Path $dir "$ModuleId.json"
    $existing = @{}
    if (Test-Path $path) {
        try {
            $obj = Get-Content -Path $path -Raw | ConvertFrom-Json
            foreach ($prop in $obj.PSObject.Properties) { $existing[$prop.Name] = $prop.Value }
        } catch { }
    }
    foreach ($key in $Values.Keys) { $existing[$key] = $Values[$key] }
    ($existing | ConvertTo-Json -Depth 12) | Out-File -FilePath $path -Encoding utf8NoBOM
    return $path
}

# Fetch a single value from the merged outputs, optionally falling back to an
# environment variable, and throwing when a required value is absent.
function Get-OutputValue {
    param(
        [Parameter(Mandatory)] [hashtable]$Outputs,
        [Parameter(Mandatory)] [string]$Key,
        [string]$EnvVar,
        [switch]$Required,
        [string]$Default
    )
    if ($Outputs.ContainsKey($Key) -and $null -ne $Outputs[$Key] -and "$($Outputs[$Key])" -ne '') {
        return $Outputs[$Key]
    }
    if ($EnvVar) {
        $envVal = [Environment]::GetEnvironmentVariable($EnvVar)
        if ($envVal) { return $envVal }
    }
    if ($PSBoundParameters.ContainsKey('Default')) { return $Default }
    if ($Required) {
        $hint = "Run the module that produces it, or supply it manually in outputs/manual.json."
        if ($EnvVar) { $hint = "Set env $EnvVar, or $hint" }
        throw "Required input '$Key' not found. $hint"
    }
    return $null
}

# ---------------------------------------------------------------------------
# Config file (operator-supplied inputs)
# ---------------------------------------------------------------------------

# Load the deployment config (a .psd1 or .json). These are the operator-supplied
# inputs (subscription id, workspace id, names, feature toggles) that seed the
# modules that have no upstream producer.
function Read-DeployConfig {
    param([string]$ConfigFile)
    if (-not $ConfigFile) { return @{} }
    if (-not (Test-Path $ConfigFile)) {
        throw "Config file not found: $ConfigFile"
    }
    $ext = [IO.Path]::GetExtension($ConfigFile).ToLowerInvariant()
    if ($ext -eq '.psd1') {
        return Import-PowerShellDataFile -Path $ConfigFile
    }
    $obj = Get-Content -Path $ConfigFile -Raw | ConvertFrom-Json
    $ht = @{}
    foreach ($prop in $obj.PSObject.Properties) { $ht[$prop.Name] = $prop.Value }
    return $ht
}

# ---------------------------------------------------------------------------
# External tooling
# ---------------------------------------------------------------------------

# Return $true when a command is resolvable on PATH.
function Test-Command {
    param([Parameter(Mandatory)] [string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Run an external command, streaming output, and throw on non-zero exit.
function Invoke-External {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory
    )
    $prev = $null
    if ($WorkingDirectory) {
        $prev = Get-Location
        Set-Location $WorkingDirectory
    }
    try {
        Write-Info "$FilePath $($Arguments -join ' ')"
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$FilePath exited with code $LASTEXITCODE."
        }
    } finally {
        if ($prev) { Set-Location $prev }
    }
}
