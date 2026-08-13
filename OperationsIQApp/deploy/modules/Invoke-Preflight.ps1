<#
    M0 Preflight — verify the tools and login state the selected deployment
    needs. Non-fatal for tools only used by optional modules; reports what's
    missing so the operator can install before a real run.
#>
[CmdletBinding()]
param(
    [string]$OutputsDir,
    [hashtable]$Outputs = @{},
    [hashtable]$Config = @{}
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/Common.ps1"

$checks = @(
    @{ Name = 'az';        Why = 'Fabric/Kusto REST + tokens (all modules)';        Required = $true },
    @{ Name = 'terraform'; Why = 'Azure resources (foundry, entra, deploy-sp)';     Required = $false },
    @{ Name = 'python';    Why = 'fabric-cicd driver (lakehouse, spark-job, eventhouse-new)'; Required = $false },
    @{ Name = 'node';      Why = 'agent provisioning + connection-profile seed';    Required = $false },
    @{ Name = 'npm';       Why = 'build + rayfin CLI (app-backend, config)';        Required = $false }
)

$missingRequired = @()
foreach ($c in $checks) {
    if (Test-Command $c.Name) {
        Write-Ok ("{0,-10} found — {1}" -f $c.Name, $c.Why)
    } elseif ($c.Required) {
        Write-Err ("{0,-10} MISSING (required) — {1}" -f $c.Name, $c.Why)
        $missingRequired += $c.Name
    } else {
        Write-Warn ("{0,-10} not found (needed only by some modules) — {1}" -f $c.Name, $c.Why)
    }
}

# Azure login state (best-effort — only when az exists).
$azLoggedIn = $false
if (Test-Command 'az') {
    try {
        $acct = az account show 2>$null | ConvertFrom-Json
        if ($acct) {
            $azLoggedIn = $true
            Write-Ok "az logged in as $($acct.user.name) (sub $($acct.name))."
        }
    } catch { }
    if (-not $azLoggedIn) { Write-Warn "az is installed but not logged in. Run 'az login'." }
}

if ($missingRequired.Count -gt 0) {
    throw "Preflight failed: install $($missingRequired -join ', ') and re-run."
}

Write-ModuleOutputs -ModuleId 'preflight' -Values @{ preflightOk = $true; azLoggedIn = $azLoggedIn } -OutputsDir $OutputsDir | Out-Null
