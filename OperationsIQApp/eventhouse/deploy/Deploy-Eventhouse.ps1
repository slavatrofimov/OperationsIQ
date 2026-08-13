<#
.SYNOPSIS
    Deploys the Operations IQ app schema, helper functions, SAX and
    multivariate anomaly detection (MVAD) function libraries, and (optionally)
    synthetic sample data to a Fabric Eventhouse / KQL database.

.DESCRIPTION
    Posts each KQL management command to the cluster's /v1/rest/mgmt endpoint
    using an az-acquired token for the Kusto resource audience
    (https://kusto.kusto.windows.net). Commands are split on top-level dot
    boundaries so multi-line blocks (.set-or-append <| ...) stay intact.

.PARAMETER ClusterUri
    Eventhouse query URI, e.g. https://<guid>.<region>.kusto.fabric.microsoft.com

.PARAMETER Database
    KQL database name.

.PARAMETER IncludeSampleData
    Also load the synthetic Contoso sample data (appends rows).

.EXAMPLE
    ./Deploy-Eventhouse.ps1 -ClusterUri "https://abc.eastus.kusto.fabric.microsoft.com" -Database "tsi" -IncludeSampleData
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ClusterUri,

    [Parameter(Mandatory = $true)]
    [string]$Database,

    # Deprecated / no-op: the SAX function library now ships inside this repo
    # (eventhouse/schema/30-70_sax_*.kql) and always deploys with the schema.
    [switch]$IncludeSax,

    [switch]$IncludeSampleData,

    # Create the base data tables (Timeseries, TagMetadata, TagHierarchy, Events)
    # from schema/00_tables.kql. Use for GREENFIELD deployments. Omit for RETROFIT
    # deployments into a companion database, where those tables already exist in
    # the customer's source database and are referenced cross-database from the
    # connection profile's canonical queries.
    [switch]$CreateBaseTables,

    # OneLake Delta URIs of the mirrored RayFin SQL tables. When BOTH are provided,
    # the OneLake external tables (schema/05_external_tables.kql) are deployed with
    # these URIs substituted, exposing AnnotationsExternal / SignalMetadataExternal
    # in this database. Leave unset to skip external tables (the app degrades
    # gracefully without them).
    [string]$AnnotationsDeltaUri,

    [string]$SignalMetadataDeltaUri
)

$ErrorActionPreference = 'Stop'

$eventhouseRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $eventhouseRoot

function Invoke-KustoFile {
    param(
        [string]$Path,
        [string]$Label
    )

    Write-Host "Deploying $Label ($Path)"
    $raw = Get-Content -Path $Path -Raw

    # Split into individual dot-commands. Each command begins at a line that
    # starts with '.' and runs until the next such line (keeps <| blocks whole).
    $commands = $raw -split "(?m)(?=^\.)"

    foreach ($command in $commands) {
        $command = $command.Trim()
        if ([string]::IsNullOrWhiteSpace($command) -or -not $command.StartsWith('.')) {
            continue
        }

        # Strip trailing comment-only / blank lines. A split chunk ends right
        # before the next dot-command, so it drags along the following command's
        # leading // comment block. Trailing content after a function's brace
        # body makes Kusto reject the whole command (General_BadRequest).
        $lines = $command -split "`r?`n"
        $lastCode = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $trimmed = $lines[$i].Trim()
            if ($trimmed -ne '' -and -not $trimmed.StartsWith('//')) {
                $lastCode = $i
            }
        }
        $command = ($lines[0..$lastCode] -join "`n").Trim()

        # First token of the command (e.g. '.create-merge', '.set-or-append').
        $verb = ($command -split '\s', 2)[0]
        Write-Host "  $verb"

        $body = @{ db = $Database; csl = $command } | ConvertTo-Json -Compress
        $bodyPath = Join-Path $env:TEMP 'kql_tsi_body.json'
        $body | Out-File -FilePath $bodyPath -Encoding utf8NoBOM

        $result = az rest `
            --method POST `
            --url "$ClusterUri/v1/rest/mgmt" `
            --resource "https://kusto.kusto.windows.net" `
            --headers "Content-Type=application/json" `
            --body "@$bodyPath" 2>&1

        if ($LASTEXITCODE -ne 0) {
            $result | ForEach-Object { Write-Host $_ }
            throw "Failed to run '$verb' from $Label (exit code $LASTEXITCODE)."
        }
    }
}

# Deploy a KQL file after substituting a set of tokens (e.g. the OneLake Delta
# URIs in schema/05_external_tables.kql). Writes the substituted content to a temp
# file and hands it to Invoke-KustoFile.
function Invoke-KustoFileWithTokens {
    param(
        [string]$Path,
        [string]$Label,
        [hashtable]$Tokens
    )
    $raw = Get-Content -Path $Path -Raw
    foreach ($key in $Tokens.Keys) {
        $raw = $raw.Replace($key, $Tokens[$key])
    }
    $tmp = Join-Path $env:TEMP ("kql_" + [IO.Path]::GetFileNameWithoutExtension($Path) + "_subst.kql")
    $raw | Out-File -FilePath $tmp -Encoding utf8NoBOM
    Invoke-KustoFile -Path $tmp -Label $Label
}

# 1) Tables (greenfield only). In a retrofit, the base data tables live in the
#    customer's source database and are referenced cross-database from the profile.
if ($CreateBaseTables) {
    Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\00_tables.kql') -Label 'schema/00_tables.kql'
} else {
    Write-Host "Skipping schema/00_tables.kql (retrofit mode; -CreateBaseTables not set)."
}

# 2) App helper functions
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\10_app_functions.kql') -Label 'schema/10_app_functions.kql'

# 2b) Matrix profile result tables
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\20_mp_result_tables.kql') -Label 'schema/20_mp_result_tables.kql'

# 3) SAX function library (internal to this repo). Deploy order matters:
#    core helpers first, then the search / discords / VSM functions that use them.
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\30_sax_core.kql') -Label 'schema/30_sax_core.kql'
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\40_sax_similarity_1d.kql') -Label 'schema/40_sax_similarity_1d.kql'
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\50_sax_similarity_multidim.kql') -Label 'schema/50_sax_similarity_multidim.kql'
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\60_sax_discords.kql') -Label 'schema/60_sax_discords.kql'
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\70_sax_vsm.kql') -Label 'schema/70_sax_vsm.kql'

if ($IncludeSax) {
    Write-Host "Note: -IncludeSax is deprecated; the SAX library now ships in-repo and always deploys."
}

# 4) MVAD function library. Core preparation/contract helpers must exist before
#    the four detectors that consume them.
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\80_mvad_core.kql') -Label 'schema/80_mvad_core.kql'
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\81_mvad_random_projection.kql') -Label 'schema/81_mvad_random_projection.kql'
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\82_mvad_residual_voting.kql') -Label 'schema/82_mvad_residual_voting.kql'
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\83_mvad_change_points.kql') -Label 'schema/83_mvad_change_points.kql'
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\84_mvad_spectral.kql') -Label 'schema/84_mvad_spectral.kql'

# 4b) App analytics functions (descriptive stats + element-wise series transforms
#     pushed down from the browser). Self-contained; depends only on 00_tables.kql.
Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'schema\90_app_analytics.kql') -Label 'schema/90_app_analytics.kql'

# 4c) OneLake external tables (optional). Exposes the mirrored RayFin Annotation
#     and SignalMetadata tables so the profile's Events / Metadata queries can join
#     them server-side. Requires BOTH Delta URIs.
if ($AnnotationsDeltaUri -and $SignalMetadataDeltaUri) {
    Invoke-KustoFileWithTokens `
        -Path (Join-Path $eventhouseRoot 'schema\05_external_tables.kql') `
        -Label 'schema/05_external_tables.kql' `
        -Tokens @{
            '__ANNOTATIONS_DELTA_URI__'     = $AnnotationsDeltaUri
            '__SIGNAL_METADATA_DELTA_URI__' = $SignalMetadataDeltaUri
        }
} elseif ($AnnotationsDeltaUri -or $SignalMetadataDeltaUri) {
    Write-Host "Skipping schema/05_external_tables.kql: provide BOTH -AnnotationsDeltaUri and -SignalMetadataDeltaUri to deploy external tables."
} else {
    Write-Host "Skipping schema/05_external_tables.kql (no OneLake Delta URIs provided)."
}

# 5) Sample data (optional)
if ($IncludeSampleData) {
    Invoke-KustoFile -Path (Join-Path $eventhouseRoot 'sample-data\contoso_sample.kql') -Label 'sample-data/contoso_sample.kql'
}

Write-Host "Eventhouse deployment complete."
