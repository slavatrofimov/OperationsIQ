<#
.SYNOPSIS
    Retrofit an existing Fabric Eventhouse so the Operations IQ app can connect to
    it, WITHOUT touching the customer's existing KQL databases.

.DESCRIPTION
    Implements the companion-database deployment pattern:

      1. Creates a dedicated app-owned "companion" KQL database on the existing
         Eventhouse via the Fabric Items REST API (idempotent — reuses the DB if it
         already exists).
      2. Deploys the app's stored functions, result/state tables, and (optionally)
         the OneLake external tables into the companion database. The raw sensor
         tables are NOT copied; they stay in the customer's source database and are
         read cross-database from the connection profile's canonical queries.
      3. Validates that every required component is present.
      4. Prints ready-to-paste connection-profile queries that read the source
         database cross-database (database("<SourceDatabase>").<Table>).

    All management/DDL is posted with an az-acquired token; the browser app remains
    strictly read-only-query.

.PARAMETER WorkspaceId
    Fabric workspace id hosting the existing Eventhouse.

.PARAMETER EventhouseId
    Fabric item id of the existing Eventhouse (the parent of the new companion DB).

.PARAMETER ClusterUri
    Eventhouse query URI, e.g. https://<guid>.<region>.kusto.fabric.microsoft.com

.PARAMETER SourceDatabase
    Name of the customer's existing KQL database that holds the raw sensor tables.
    Used only to generate the cross-database connection-profile query templates.

.PARAMETER CompanionDatabase
    Name of the app-owned companion KQL database to create/deploy into.
    Defaults to "OperationsIQ".

.PARAMETER AnnotationsDeltaUri
    OneLake Delta URI of the mirrored RayFin Annotation table. When provided with
    -SignalMetadataDeltaUri, the OneLake external tables are deployed and required
    by validation.

.PARAMETER SignalMetadataDeltaUri
    OneLake Delta URI of the mirrored RayFin SignalMetadata table.

.PARAMETER SkipValidation
    Skip the post-deploy validation step.

.EXAMPLE
    ./Retrofit-Eventhouse.ps1 `
      -WorkspaceId "<ws-guid>" `
      -EventhouseId "<eh-item-guid>" `
      -ClusterUri "https://<guid>.eastus.kusto.fabric.microsoft.com" `
      -SourceDatabase "ContosoRaw" `
      -CompanionDatabase "OperationsIQ" `
      -AnnotationsDeltaUri "https://onelake.dfs.fabric.microsoft.com/<ws>/<db>.MirroredDatabase/Tables/dbo/Annotation" `
      -SignalMetadataDeltaUri "https://onelake.dfs.fabric.microsoft.com/<ws>/<db>.MirroredDatabase/Tables/dbo/SignalMetadata"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkspaceId,

    [Parameter(Mandatory = $true)]
    [string]$EventhouseId,

    [Parameter(Mandatory = $true)]
    [string]$ClusterUri,

    [Parameter(Mandatory = $true)]
    [string]$SourceDatabase,

    [string]$CompanionDatabase = 'OperationsIQ',

    [string]$AnnotationsDeltaUri,

    [string]$SignalMetadataDeltaUri,

    [switch]$SkipValidation
)

$ErrorActionPreference = 'Stop'
$fabricResource = 'https://api.fabric.microsoft.com'
$fabricBase = "$fabricResource/v1"

function Invoke-Fabric {
    param(
        [string]$Method,
        [string]$Url,
        [string]$JsonBody
    )
    $azArgs = @('rest', '--method', $Method, '--url', $Url, '--resource', $fabricResource)
    if ($JsonBody) {
        $bodyPath = Join-Path $env:TEMP 'fabric_body.json'
        $JsonBody | Out-File -FilePath $bodyPath -Encoding utf8NoBOM
        $azArgs += @('--headers', 'Content-Type=application/json', '--body', "@$bodyPath")
    }
    $out = az @azArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        $out | ForEach-Object { Write-Host $_ }
        throw "Fabric REST $Method $Url failed (exit $LASTEXITCODE)."
    }
    if ($out) { return ($out | ConvertFrom-Json) }
    return $null
}

# Return the KQL database item matching $CompanionDatabase, or $null.
function Get-CompanionDb {
    $resp = Invoke-Fabric -Method GET -Url "$fabricBase/workspaces/$WorkspaceId/kqlDatabases"
    if (-not $resp) { return $null }
    return $resp.value | Where-Object { $_.displayName -eq $CompanionDatabase } | Select-Object -First 1
}

Write-Host "== Operations IQ Eventhouse retrofit =="
Write-Host "Workspace : $WorkspaceId"
Write-Host "Eventhouse: $EventhouseId"
Write-Host "Cluster   : $ClusterUri"
Write-Host "Source DB : $SourceDatabase"
Write-Host "Companion : $CompanionDatabase`n"

# --- 1) Create (or reuse) the companion KQL database ------------------------
$existing = Get-CompanionDb
if ($existing) {
    Write-Host "Companion database '$CompanionDatabase' already exists (id $($existing.id)); reusing it."
} else {
    Write-Host "Creating companion database '$CompanionDatabase' on the Eventhouse..."
    $body = @{
        displayName = $CompanionDatabase
        creationPayload = @{
            databaseType = 'ReadWrite'
            parentEventhouseItemId = $EventhouseId
        }
    } | ConvertTo-Json -Depth 5
    Invoke-Fabric -Method POST -Url "$fabricBase/workspaces/$WorkspaceId/kqlDatabases" -JsonBody $body | Out-Null

    # Creation is a long-running op; poll the list until the DB is queryable.
    $deadline = (Get-Date).AddMinutes(5)
    do {
        Start-Sleep -Seconds 5
        $existing = Get-CompanionDb
        if ($existing) { break }
    } while ((Get-Date) -lt $deadline)
    if (-not $existing) {
        throw "Timed out waiting for companion database '$CompanionDatabase' to be created."
    }
    Write-Host "Created companion database (id $($existing.id))."
}

# --- 2) Deploy schema (retrofit mode: no base tables) -----------------------
Write-Host "`nDeploying app schema into '$CompanionDatabase'..."
$deployArgs = @{
    ClusterUri = $ClusterUri
    Database   = $CompanionDatabase
}
if ($AnnotationsDeltaUri)    { $deployArgs.AnnotationsDeltaUri = $AnnotationsDeltaUri }
if ($SignalMetadataDeltaUri) { $deployArgs.SignalMetadataDeltaUri = $SignalMetadataDeltaUri }
& (Join-Path $PSScriptRoot 'Deploy-Eventhouse.ps1') @deployArgs

# --- 3) Validate ------------------------------------------------------------
if (-not $SkipValidation) {
    Write-Host "`nValidating companion database..."
    $validateArgs = @{ ClusterUri = $ClusterUri; Database = $CompanionDatabase }
    if ($AnnotationsDeltaUri -and $SignalMetadataDeltaUri) {
        $validateArgs.RequireExternalTables = $true
    }
    & (Join-Path $PSScriptRoot 'Validate-Eventhouse.ps1') @validateArgs
}

# --- 4) Emit connection-profile query templates -----------------------------
$annUnion = ''
if ($AnnotationsDeltaUri -and $SignalMetadataDeltaUri) {
    $annUnion = @"

  Events query (with annotations) — union app annotations, filtered to this profile:
    database("$SourceDatabase").Events
    | project EventId, ScopeId, ScopeType, StartTimestamp=Timestamp, EndTimestamp, EventType, Title, Detail, Source="Event", UserId=""
    | union (
        AnnotationsExternal
        | where connection_profile_id == _ConnectionProfileId
        | project EventId=id, ScopeId=scope_id, ScopeType=scope_type, StartTimestamp=timestamp, EndTimestamp=end_timestamp, EventType=annotation_type, Title=title, Detail=detail, Source="Annotation", UserId=user_id
      )
"@
}

Write-Host @"

== Retrofit complete ==
Create a connection profile in the app with:
  Eventhouse Query URI : $ClusterUri
  Database             : $CompanionDatabase

Canonical queries (edit projections to match the real source columns):

  Timeseries query:
    database("$SourceDatabase").Timeseries
    | project Timestamp, SignalId=TagId, Value

  Hierarchy query:
    database("$SourceDatabase").TagHierarchy
    | join kind=leftouter (database("$SourceDatabase").TagMetadata | project TagId, TagName) on TagId
    | project SignalId=TagId, SignalName=TagName, Level1=Plant, Level2=Factory, Level3=Line, Level4=Station

  Metadata query:
    database("$SourceDatabase").TagMetadata
    | project SignalId=TagId, MetricName=Metric, UnitOfMeasure=EngUnits, Description=Description

  Events query:
    database("$SourceDatabase").Events
    | project EventId, ScopeId, ScopeType, StartTimestamp=Timestamp, EndTimestamp, EventType, Title, Detail
$annUnion
Grant the signing-in identity Database Viewer on BOTH '$CompanionDatabase' and
'$SourceDatabase', and Database Ingestor on '$CompanionDatabase'. Then use the
ConfigPage "Validate components" button to confirm the profile resolves.
"@
