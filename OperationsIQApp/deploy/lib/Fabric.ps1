<#
    Shared helper for the Fabric-item modules. Runs deploy/fabric/deploy_fabric.py
    (the fabric-cicd driver) for a set of item types and returns the JSON id map
    it prints on its last stdout line.

    . "$PSScriptRoot/../lib/Fabric.ps1"
#>

Set-StrictMode -Version Latest

function Get-PythonExe {
    foreach ($candidate in 'python', 'python3', 'py') {
        if (Test-Command $candidate) { return $candidate }
    }
    throw "Python is not installed. Install Python 3.10+ and 'pip install -r deploy/fabric/requirements.txt', or follow the manual Fabric-items doc."
}

# Invoke the fabric-cicd driver. $Items is a comma list understood by the driver
# (lakehouse, sparkjob, eventhouse). Returns a hashtable parsed from the driver's
# final JSON line (item display name/type -> id).
function Invoke-FabricDeploy {
    param(
        [Parameter(Mandatory)] [string]$WorkspaceId,
        [Parameter(Mandatory)] [string]$Items,
        [hashtable]$ExtraArgs = @{}
    )
    $py = Get-PythonExe
    $fabricDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'fabric'
    $script = Join-Path $fabricDir 'deploy_fabric.py'
    if (-not (Test-Path $script)) { throw "Fabric driver not found: $script" }

    $args = @($script, '--workspace-id', $WorkspaceId, '--items', $Items)
    foreach ($key in $ExtraArgs.Keys) {
        $args += @("--$key", "$($ExtraArgs[$key])")
    }

    Write-Info "$py $($args -join ' ')"
    $out = & $py @args
    if ($LASTEXITCODE -ne 0) {
        $out | ForEach-Object { Write-Host $_ }
        throw "fabric deploy failed (exit $LASTEXITCODE)."
    }
    # The driver prints human logs then a final line beginning RESULT_JSON=.
    $resultLine = @($out) | Where-Object { $_ -like 'RESULT_JSON=*' } | Select-Object -Last 1
    if (-not $resultLine) {
        $out | ForEach-Object { Write-Host $_ }
        throw "fabric driver did not emit RESULT_JSON."
    }
    $json = $resultLine.Substring('RESULT_JSON='.Length)
    $parsed = $json | ConvertFrom-Json
    $ht = @{}
    foreach ($prop in $parsed.PSObject.Properties) { $ht[$prop.Name] = $prop.Value }
    return $ht
}
