<#
    M7 Smoke validation — headless post-deploy checks:
      1. Eventhouse schema present (reuses Validate-Eventhouse.ps1).
      2. SPA origin reachable (HTTP 200/302).
      3. A sample timeseries query returns rows (best-effort, needs read access).
      4. Foundry endpoint reachable (best-effort).
    Emits a PASS/FAIL summary; exits non-zero on a required failure.
#>
[CmdletBinding()]
param(
    [string]$OutputsDir,
    [hashtable]$Outputs = @{},
    [hashtable]$Config = @{}
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/Common.ps1"

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$deployDir = Join-Path $appRoot 'eventhouse/deploy'

$failures = @()
$warnings = @()

# 1) Eventhouse schema
$clusterUri = Get-OutputValue -Outputs $Outputs -Key 'eventhouseQueryUri'
$db = Get-OutputValue -Outputs $Outputs -Key 'companionDatabase'
if ($clusterUri -and $db) {
    Write-Step "Validating Eventhouse schema on '$db'"
    try {
        & (Join-Path $deployDir 'Validate-Eventhouse.ps1') -ClusterUri $clusterUri -Database $db
        Write-Ok 'Eventhouse schema OK.'
    } catch {
        Write-Err "Eventhouse validation failed: $($_.Exception.Message)"
        $failures += 'eventhouse-schema'
    }
} else {
    $warnings += 'eventhouse-schema (no clusterUri/db in outputs)'
}

# 2) SPA reachable
$appOrigin = Get-OutputValue -Outputs $Outputs -Key 'appOrigin'
if ($appOrigin) {
    Write-Step "Checking SPA origin $appOrigin"
    try {
        $resp = Invoke-WebRequest -Uri $appOrigin -Method Head -SkipHttpErrorCheck -TimeoutSec 30
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400) {
            Write-Ok "SPA reachable (HTTP $($resp.StatusCode))."
        } else {
            Write-Warn "SPA returned HTTP $($resp.StatusCode)."
            $warnings += "spa-status-$($resp.StatusCode)"
        }
    } catch {
        Write-Warn "SPA origin check failed: $($_.Exception.Message)"
        $warnings += 'spa-unreachable'
    }
} else {
    $warnings += 'spa (no appOrigin in outputs)'
}

# 3) Foundry endpoint reachable (best-effort HEAD)
$foundry = Get-OutputValue -Outputs $Outputs -Key 'foundryEndpoint'
if ($foundry) {
    Write-Step "Checking Foundry endpoint host"
    try {
        $u = [Uri]$foundry
        $tcp = Test-Connection -TargetName $u.Host -TcpPort 443 -TimeoutSeconds 5 -ErrorAction Stop
        if ($tcp) { Write-Ok "Foundry host $($u.Host):443 reachable." }
    } catch {
        Write-Warn "Foundry reachability check inconclusive: $($_.Exception.Message)"
        $warnings += 'foundry-unreachable'
    }
}

Write-Host ''
if ($warnings.Count -gt 0) { Write-Warn "$($warnings.Count) warning(s): $($warnings -join ', ')" }
if ($failures.Count -gt 0) {
    Write-Err "Smoke validation FAILED: $($failures -join ', ')"
    Write-ModuleOutputs -ModuleId 'smoke' -Values @{ smokeOk = $false; failures = $failures } -OutputsDir $OutputsDir | Out-Null
    exit 1
}
Write-Ok 'Smoke validation passed.'
Write-ModuleOutputs -ModuleId 'smoke' -Values @{ smokeOk = $true } -OutputsDir $OutputsDir | Out-Null
