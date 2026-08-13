<#
.SYNOPSIS
    Assemble a Vite .env file for Operations IQ from the deployment outputs.

.DESCRIPTION
    Reads .env.example as the template (so non-deployment defaults like
    VITE_FOUNDRY_SCOPE and VITE_TSMP_* are preserved), overrides the keys the
    deployment produced (mapped from outputs/*.json), validates that the
    REQUIRED keys are present, and writes the result to the target env file.

    Mapping (output key -> VITE_ var):
      rayfinApiUrl          -> VITE_RAYFIN_API_URL
      rayfinPublishableKey  -> VITE_RAYFIN_PUBLISHABLE_KEY
      workspaceId           -> VITE_FABRIC_WORKSPACE_ID
      fabricItemId          -> VITE_FABRIC_ITEM_ID
      eventhouseQueryUri    -> VITE_EVENTHOUSE_QUERY_URI
      companionDatabase     -> VITE_EVENTHOUSE_DB
      msalClientId          -> VITE_MSAL_CLIENT_ID
      tenantId              -> VITE_MSAL_TENANT_ID
      foundryEndpoint       -> VITE_FOUNDRY_ENDPOINT
      agentName             -> VITE_FOUNDRY_AGENT_NAME
      agentVersion          -> VITE_FOUNDRY_AGENT_VERSION
      lakehouseId           -> VITE_FABRIC_LAKEHOUSE_ID

.PARAMETER OutputsDir
    Directory holding the module outputs JSON. Defaults to deploy/outputs.

.PARAMETER TemplatePath
    .env template. Defaults to the app's .env.example.

.PARAMETER OutFile
    Destination env file. Defaults to <appRoot>/.env.production.

.PARAMETER RequireOptional
    Also require the "optional" integration keys (Foundry agent, lakehouse).
#>
[CmdletBinding()]
param(
    [string]$OutputsDir,
    [string]$TemplatePath,
    [string]$OutFile,
    [switch]$RequireOptional
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/Common.ps1"

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # -> OperationsIQApp
if (-not $TemplatePath) { $TemplatePath = Join-Path $appRoot '.env.example' }
if (-not $OutFile)      { $OutFile = Join-Path $appRoot '.env.production' }
if (-not (Test-Path $TemplatePath)) { throw "Template not found: $TemplatePath" }

$outputs = Read-Outputs -OutputsDir $OutputsDir

# output key -> [viteVar, required]
$map = @(
    @{ Key = 'rayfinApiUrl';         Var = 'VITE_RAYFIN_API_URL';         Required = $true },
    @{ Key = 'rayfinPublishableKey'; Var = 'VITE_RAYFIN_PUBLISHABLE_KEY'; Required = $true },
    @{ Key = 'workspaceId';          Var = 'VITE_FABRIC_WORKSPACE_ID';    Required = $true },
    @{ Key = 'fabricItemId';         Var = 'VITE_FABRIC_ITEM_ID';         Required = $true },
    @{ Key = 'eventhouseQueryUri';   Var = 'VITE_EVENTHOUSE_QUERY_URI';   Required = $true },
    @{ Key = 'companionDatabase';    Var = 'VITE_EVENTHOUSE_DB';          Required = $true },
    @{ Key = 'msalClientId';         Var = 'VITE_MSAL_CLIENT_ID';         Required = $true },
    @{ Key = 'tenantId';             Var = 'VITE_MSAL_TENANT_ID';         Required = $true },
    @{ Key = 'foundryEndpoint';      Var = 'VITE_FOUNDRY_ENDPOINT';       Required = $false },
    @{ Key = 'agentName';            Var = 'VITE_FOUNDRY_AGENT_NAME';     Required = $false },
    @{ Key = 'agentVersion';         Var = 'VITE_FOUNDRY_AGENT_VERSION';  Required = $false },
    @{ Key = 'lakehouseId';          Var = 'VITE_FABRIC_LAKEHOUSE_ID';    Required = $false }
)

# Build the override table + collect missing required keys.
$overrides = @{}
$missing = @()
foreach ($m in $map) {
    $val = $null
    if ($outputs.ContainsKey($m.Key) -and $null -ne $outputs[$m.Key] -and "$($outputs[$m.Key])" -ne '') {
        $val = "$($outputs[$m.Key])"
    }
    if ($val) {
        $overrides[$m.Var] = $val
    } elseif ($m.Required -or ($RequireOptional -and -not $m.Required)) {
        $missing += "$($m.Var) (from '$($m.Key)')"
    }
}

# Rewrite the template line-by-line, replacing KEY= with KEY=<value>.
$lines = Get-Content -Path $TemplatePath
$result = foreach ($line in $lines) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
        $key = $Matches[1]
        if ($overrides.ContainsKey($key)) {
            "$key=$($overrides[$key])"
        } else {
            $line
        }
    } else {
        $line
    }
}

if ($missing.Count -gt 0) {
    Write-Warn "Missing required config values:"
    $missing | ForEach-Object { Write-Warn "  - $_" }
    throw "Cannot assemble a complete env file: $($missing.Count) required value(s) missing. Run the producing modules or supply them in your config file."
}

$result | Out-File -FilePath $OutFile -Encoding utf8NoBOM
Write-Ok "Wrote $OutFile"
Write-Info "Set $($overrides.Count) values from deployment outputs."
return $OutFile
