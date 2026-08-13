<#
.SYNOPSIS
    Operations IQ end-to-end deployment orchestrator.

.DESCRIPTION
    Runs the deployment modules declared in deploy/modules.psd1 in dependency
    order. Each module is idempotent, reads the inputs it consumes from
    outputs/*.json (produced by upstream modules, a teammate's hand-off, or
    manual entry), and writes what it produces back to outputs/<id>.json.

    The design is modular on purpose: a highly-permissioned operator can run
    everything with one command, while a less-permissioned operator can run only
    the modules they're allowed to (-Modules ...) and let someone else fill the
    gaps. -WhatIf prints the ordered plan and the permissions each step needs
    without changing anything.

.PARAMETER Modules
    Explicit module ids to run (e.g. foundry,agent). Omit to run every
    non-optional module. Unsatisfied dependencies are pulled in automatically.

.PARAMETER Skip
    Module ids to exclude even if they would otherwise be pulled in.

.PARAMETER ConfigFile
    Path to a .psd1 or .json of operator-supplied inputs (subscription id,
    workspace id, names, feature toggles). Seeded into outputs before the run.

.PARAMETER OutputsDir
    Directory for the inter-module JSON handoff. Defaults to deploy/outputs.

.PARAMETER WhatIf
    Print the ordered plan (module, tool, required role, deps) and exit without
    running anything.

.PARAMETER ListModules
    Print the full module catalog and exit.

.EXAMPLE
    ./Deploy-All.ps1 -ConfigFile ./deploy.config.psd1

.EXAMPLE
    ./Deploy-All.ps1 -Modules foundry,agent -WhatIf

.EXAMPLE
    ./Deploy-All.ps1 -Modules eventhouse-new,eventhouse -ConfigFile ./demo.psd1
#>
[CmdletBinding()]
param(
    [string[]]$Modules = @(),
    [string[]]$Skip = @(),
    [string]$ConfigFile,
    [string]$OutputsDir,
    [switch]$WhatIf,
    [switch]$ListModules
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. "$PSScriptRoot/lib/Common.ps1"
. "$PSScriptRoot/lib/Modules.ps1"

$registryPath = Join-Path $PSScriptRoot 'modules.psd1'
$registry = Import-ModuleRegistry -Path $registryPath

if ($ListModules) {
    Write-Host "`nOperations IQ deployment modules`n" -ForegroundColor Cyan
    $registry | ForEach-Object {
        $tag = if ($_.Optional) { '(optional)' } else { '' }
        Write-Host ("  {0,-14} {1} {2}" -f $_.Id, $_.Name, $tag) -ForegroundColor White
        Write-Host ("                 {0}" -f $_.Description)
        Write-Host ("                 tool: {0}  |  role: {1}" -f $_.Tool, $_.RequiredRole) -ForegroundColor DarkGray
        if ($_.DependsOn.Count) { Write-Host ("                 needs: {0}" -f ($_.DependsOn -join ', ')) -ForegroundColor DarkGray }
    }
    Write-Host ''
    return
}

# Seed outputs with operator config so downstream modules can resolve inputs
# (workspaceId, feature toggles, etc.) that have no upstream producer.
$config = Read-DeployConfig -ConfigFile $ConfigFile
$dir = Get-OutputsDir -OutputsDir $OutputsDir
if ($config.Count -gt 0) {
    Write-ModuleOutputs -ModuleId 'config-input' -Values $config -OutputsDir $dir | Out-Null
}

$outputs = Read-Outputs -OutputsDir $dir
$plan = Resolve-ModuleSelection -Registry $registry -Modules $Modules -Skip $Skip -Outputs $outputs

if ($plan.Count -eq 0) {
    Write-Warn 'No modules selected. Use -ListModules to see the catalog.'
    return
}

Write-Host "`n== Operations IQ deployment plan ==`n" -ForegroundColor Cyan
$i = 0
foreach ($m in $plan) {
    $i++
    Write-Host ("  {0}. {1,-14} {2}" -f $i, $m.Id, $m.Name) -ForegroundColor White
    Write-Host ("       tool: {0}  |  role: {1}" -f $m.Tool, $m.RequiredRole) -ForegroundColor DarkGray
}
Write-Host ''

if ($WhatIf) {
    Write-Info 'WhatIf: no modules were run.'
    return
}

$ran = @()
foreach ($m in $plan) {
    Write-Step "$($m.Id) — $($m.Name)"
    $scriptPath = Join-Path $PSScriptRoot $m.Script
    if (-not (Test-Path $scriptPath)) {
        throw "Module script not found: $scriptPath"
    }
    # Re-read outputs before each module so it sees upstream results.
    $current = Read-Outputs -OutputsDir $dir
    & $scriptPath -OutputsDir $dir -Outputs $current -Config $config
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "Module '$($m.Id)' failed (exit $LASTEXITCODE)."
    }
    $ran += $m.Id
    Write-Ok "$($m.Id) complete."
}

Write-Host "`n== Deployment complete ==" -ForegroundColor Green
Write-Info "Ran: $($ran -join ', ')"
Write-Info "Outputs written to: $dir"
