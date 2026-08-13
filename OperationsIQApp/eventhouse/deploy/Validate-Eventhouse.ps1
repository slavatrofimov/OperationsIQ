<#
.SYNOPSIS
    Authoritative post-deployment validation for an Operations IQ companion KQL
    database. Confirms that every required stored function, result/state table,
    and OneLake external table is present.

.DESCRIPTION
    Parses the repo's eventhouse/schema/*.kql files to derive the set of expected
    object names (the deployment source of truth), then queries the live database
    via management commands (.show functions / .show tables / .show external
    tables) and reports any missing objects. Exits non-zero when a REQUIRED object
    is missing so it can gate CI / the retrofit tool.

    External tables (SignalMetadataExternal, AnnotationsExternal) are treated as
    OPTIONAL by default: the app degrades gracefully without them (governed
    metadata / annotation overlay simply don't surface in KQL). Pass
    -RequireExternalTables to make them required.

.PARAMETER ClusterUri
    Eventhouse query URI, e.g. https://<guid>.<region>.kusto.fabric.microsoft.com

.PARAMETER Database
    Companion KQL database name to validate.

.PARAMETER RequireExternalTables
    Treat the OneLake external tables as required (fail if absent).

.PARAMETER RequireBaseTables
    Also require the base data tables (Timeseries, TagMetadata, TagHierarchy,
    Events). Use for greenfield deployments; omit for retrofit deployments where
    those tables live in the source database and are referenced cross-database.

.EXAMPLE
    ./Validate-Eventhouse.ps1 -ClusterUri "https://abc.eastus.kusto.fabric.microsoft.com" -Database "OperationsIQ"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ClusterUri,

    [Parameter(Mandatory = $true)]
    [string]$Database,

    [switch]$RequireExternalTables,

    [switch]$RequireBaseTables
)

$ErrorActionPreference = 'Stop'

$eventhouseRoot = Split-Path -Parent $PSScriptRoot
$schemaDir = Join-Path $eventhouseRoot 'schema'

# The base data tables live in schema/00_tables.kql; in a retrofit they are NOT
# deployed to the companion DB (they stay in the source DB).
$baseTables = @('Timeseries', 'TagMetadata', 'TagHierarchy', 'Events')

function Get-ExpectedFunctions {
    # A function name is the identifier that follows the (possibly multi-line)
    # '.create-or-alter function with (...)' block, i.e. ') <name>(...args...)'.
    # We accumulate the declaration text (from the .create-or-alter line up to the
    # body's opening brace), strip double-quoted docstrings so their prose can't
    # produce a false ') word(' match, then take the identifier before the arg list.
    $names = New-Object System.Collections.Generic.List[string]
    Get-ChildItem -Path $schemaDir -Filter '*.kql' | Sort-Object Name | ForEach-Object {
        $lines = Get-Content -Path $_.FullName
        $inDecl = $false
        $decl = ''
        foreach ($line in $lines) {
            if (-not $inDecl) {
                if ($line.Trim() -match '^\.create-or-alter\s+function') {
                    $inDecl = $true
                    $decl = $line
                }
                continue
            }
            $decl += "`n$line"
            if ($line -match '\{') {
                $clean = [regex]::Replace($decl, '"[^"]*"', '""')
                if ($clean -match '\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(') {
                    $names.Add($Matches[1])
                }
                $inDecl = $false
                $decl = ''
            }
        }
    }
    $names | Select-Object -Unique
}

function Get-ExpectedTables {
    $names = New-Object System.Collections.Generic.List[string]
    Get-ChildItem -Path $schemaDir -Filter '*.kql' | ForEach-Object {
        Get-Content -Path $_.FullName | ForEach-Object {
            if ($_ -match '^\s*\.create-merge\s+table\s+([A-Za-z_][A-Za-z0-9_]*)') {
                $names.Add($Matches[1])
            }
        }
    }
    $names | Select-Object -Unique
}

function Get-ExpectedExternalTables {
    $names = New-Object System.Collections.Generic.List[string]
    Get-ChildItem -Path $schemaDir -Filter '*.kql' | ForEach-Object {
        Get-Content -Path $_.FullName | ForEach-Object {
            if ($_ -match '^\s*\.create-or-alter\s+external\s+table\s+([A-Za-z_][A-Za-z0-9_]*)') {
                $names.Add($Matches[1])
            }
        }
    }
    $names | Select-Object -Unique
}

function Invoke-KustoQuery {
    param([string]$Csl)

    $body = @{ db = $Database; csl = $Csl } | ConvertTo-Json -Compress
    $bodyPath = Join-Path $env:TEMP 'kql_validate_body.json'
    $body | Out-File -FilePath $bodyPath -Encoding utf8NoBOM

    $result = az rest `
        --method POST `
        --url "$ClusterUri/v1/rest/mgmt" `
        --resource "https://kusto.kusto.windows.net" `
        --headers "Content-Type=application/json" `
        --body "@$bodyPath" 2>&1

    if ($LASTEXITCODE -ne 0) {
        $result | ForEach-Object { Write-Host $_ }
        throw "Management query failed: $Csl"
    }
    return ($result | ConvertFrom-Json)
}

# Extract the first column of a Kusto v1 management response as a string[].
function Get-Column0 {
    param($Response)
    $rows = $Response.Tables[0].Rows
    if (-not $rows) { return @() }
    return @($rows | ForEach-Object { [string]$_[0] })
}

Write-Host "Validating companion database '$Database' on $ClusterUri`n"

$actualFunctions = Get-Column0 (Invoke-KustoQuery '.show functions | project Name')
$actualTables    = Get-Column0 (Invoke-KustoQuery '.show tables | project TableName')
$actualExternal  = Get-Column0 (Invoke-KustoQuery '.show external tables | project TableName')

$expectedFunctions = @(Get-ExpectedFunctions)
$expectedTables    = @(Get-ExpectedTables) | Where-Object { $RequireBaseTables -or ($baseTables -notcontains $_) }
$expectedExternal  = @(Get-ExpectedExternalTables)

$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Test-Group {
    param(
        [string]$Label,
        [string[]]$Expected,
        [string[]]$Actual,
        [bool]$Required
    )
    $missing = @($Expected | Where-Object { $Actual -notcontains $_ })
    $present = $Expected.Count - $missing.Count
    Write-Host ("{0}: {1}/{2} present" -f $Label, $present, $Expected.Count)
    foreach ($m in $missing) {
        if ($Required) {
            Write-Host "  [MISSING] $m" -ForegroundColor Red
            $script:failures.Add("$Label/$m")
        } else {
            Write-Host "  [absent]  $m (optional)" -ForegroundColor Yellow
            $script:warnings.Add("$Label/$m")
        }
    }
}

Test-Group -Label 'Functions'       -Expected $expectedFunctions -Actual $actualFunctions -Required $true
Test-Group -Label 'Tables'          -Expected $expectedTables    -Actual $actualTables    -Required $true
Test-Group -Label 'External tables' -Expected $expectedExternal  -Actual $actualExternal  -Required ([bool]$RequireExternalTables)

Write-Host ''
if ($warnings.Count -gt 0) {
    Write-Host "$($warnings.Count) optional component(s) absent (app degrades gracefully)." -ForegroundColor Yellow
}
if ($failures.Count -gt 0) {
    Write-Host "Validation FAILED: $($failures.Count) required component(s) missing." -ForegroundColor Red
    exit 1
}
Write-Host "Validation passed: all required components present." -ForegroundColor Green
