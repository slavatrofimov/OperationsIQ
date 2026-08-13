param(
    [string]$ClusterUri = "https://trd-wqke5j11jvyftyuz1c.z1.kusto.fabric.microsoft.com",
    [string]$Database = "TsiEventhouse",
    [switch]$SkipStress
)

$ErrorActionPreference = 'Stop'
$ExpectedColumns = 'entity_id,algorithm,event_index,event_time,window_start,window_end,score,threshold,severity,is_anomaly,vote_count,vote_fraction,track_count,contributors,status,explain'
$script:PassCount = 0

function Invoke-KustoQuery {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$Csl
    )

    $token = az account get-access-token `
        --resource "https://kusto.kusto.windows.net" `
        --query accessToken -o tsv
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
        throw "Unable to acquire a Kusto token. Run 'az login' and retry."
    }

    $bodyPath = Join-Path $env:TEMP 'operations_iq_mvad_smoke.json'
    @{ db = $Database; csl = $Csl } |
        ConvertTo-Json -Compress |
        Out-File -FilePath $bodyPath -Encoding utf8NoBOM

    $raw = curl.exe -sS -X POST "$($ClusterUri.TrimEnd('/'))/v2/rest/query" `
        -H "Authorization: Bearer $token" `
        -H "Content-Type: application/json" `
        --data "@$bodyPath"
    if ($LASTEXITCODE -ne 0) {
        throw "HTTP request failed for '$Label' (curl exit $LASTEXITCODE)."
    }

    try {
        $response = $raw | ConvertFrom-Json
    }
    catch {
        throw "Non-JSON response for '$Label': $($raw.Substring(0, [Math]::Min(500, $raw.Length)))"
    }

    $errorTable = $response | Where-Object { $_.TableKind -eq 'QueryCompletionInformation' }
    if ($errorTable -and ($raw -match '"Severity":(?:1|2)' -or $raw -match '"OneApiErrors"')) {
        throw "Kusto reported an error for '$Label': $($raw.Substring(0, [Math]::Min(1200, $raw.Length)))"
    }

    $primary = @($response | Where-Object { $_.TableKind -eq 'PrimaryResult' })[0]
    if (-not $primary) {
        throw "No PrimaryResult returned for '$Label': $($raw.Substring(0, [Math]::Min(800, $raw.Length)))"
    }
    return $primary
}

function Assert-Kusto {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$Csl
    )

    $result = Invoke-KustoQuery -Label $Label -Csl $Csl
    if ($result.Rows.Count -lt 1 -or -not [bool]$result.Rows[0][0]) {
        $preview = if ($result.Rows.Count -gt 0) {
            $result.Rows[0] | ConvertTo-Json -Compress
        }
        else {
            '<no rows>'
        }
        throw "FAIL: $Label -> $preview"
    }
    $script:PassCount++
    Write-Host "PASS: $Label"
}

function Assert-KustoFailure {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$Csl
    )

    try {
        $null = Invoke-KustoQuery -Label $Label -Csl $Csl
    }
    catch {
        $script:PassCount++
        Write-Host "PASS: $Label (rejected as expected)"
        return
    }
    throw "FAIL: $Label unexpectedly succeeded."
}

# A deterministic 256-bin source with four tracks per entity:
#   clean         - stable control
#   residual      - collective final-window excursion
#   correlation   - one relationship reverses in the final window
#   change        - persistent level plus slope change
#   spectral      - final 64 bins shift from period 16 to period 4
#   low_coverage  - a 41-bin source gap that preparation must diagnose
$SyntheticPrefix = @'
let _start = datetime(2026-01-01);
let _end = _start + 256m;
let _entities = datatable(entity_id:string)
[
    "clean", "residual", "correlation", "change", "spectral", "low_coverage"
];
let _source_base =
    range _index from 0 to 255 step 1
    | extend _join_key = 1
    | join kind=inner (_entities | extend _join_key = 1) on _join_key
    | project-away _join_key, _join_key1
    | mv-expand track_id = dynamic(["t0", "t1", "t2", "t3"]) to typeof(string)
    | extend _track_index = case(track_id == "t0", 0, track_id == "t1", 1, track_id == "t2", 2, 3)
    | extend _base = sin(2.0 * pi() * todouble(_index) / 16.0 + todouble(_track_index) * 0.2)
    | extend value = case(
        entity_id == "residual" and _index >= 224,
            _base + 8.0 + todouble(_track_index),
        entity_id == "correlation" and _index >= 224 and track_id == "t3",
            -4.0 * _base,
        entity_id == "change" and _index >= 232,
            _base + 5.0 + 0.15 * todouble(_index - 232),
        entity_id == "spectral" and _index >= 192,
            sin(2.0 * pi() * todouble(_index - 192) / 4.0 + todouble(_track_index) * 0.2),
        _base
    )
    | where not(entity_id == "low_coverage" and _index between (80 .. 120))
    | project
        entity_id,
        track_id,
        timestamp = _start + _index * 1m,
        value;
// Duplicate part of one track deliberately. Preparation must average duplicates
// without counting them as additional occupied bins or coverage.
let _source =
    union
        _source_base,
        (_source_base
         | where entity_id == "clean"
             and track_id == "t0"
             and timestamp < _start + 64m);
let _prepared = mvad_make_series(_source, _start, _end, 1m, 0.90, 8);
'@

Assert-Kusto -Label 'prepared-series contract and low-coverage diagnostic' -Csl @"
$SyntheticPrefix
let _schema = toscalar(
    _prepared
    | getschema
    | order by ColumnOrdinal asc
    | summarize strcat_array(make_list(ColumnName), ",")
);
_prepared
| summarize
    _low_invalid = countif(entity_id == "low_coverage" and not(is_valid)),
    _valid_tracks = countif(entity_id != "low_coverage" and is_valid),
    _duplicate_track_observed_bins = maxif(observed_bins, entity_id == "clean" and track_id == "t0"),
    _duplicate_track_coverage = maxif(coverage, entity_id == "clean" and track_id == "t0")
| project passed =
    _schema == "entity_id,track_id,series,series_start,series_end,bin_size,point_count,observed_bins,coverage,max_missing_run,is_valid,validation_error"
    and _low_invalid == 4
    and _valid_tracks == 20
    and _duplicate_track_observed_bins == 256
    and _duplicate_track_coverage == 1.0
"@

$DetectorQueries = @{
    random = 'mvad_random_projection_ensemble(_prepared, 32m, 0, "none", 24, 0.35, "smoke-seed", 1.2, 1.0, 3, 2.5, 1e-6, 2000000, true)'
    residual = 'mvad_residual_magnitude_voting(_prepared, 32m, 0, "linefit", "ctukey", 2.0, 1.8, 2, 0.5, 4.0, true)'
    change = 'mvad_change_point_ensemble(_prepared, 32m, 0, 8, 1.2, 1.0, 2, 0.5, 2.5, true, true)'
    spectral = 'mvad_spectral_aggregation(_prepared, 64m, 3, 2, true, 1.5, 1.0, 2, 0.5, 3.0, true)'
}

foreach ($detector in $DetectorQueries.GetEnumerator()) {
    Assert-Kusto -Label "$($detector.Key) common result schema" -Csl @"
$SyntheticPrefix
let _result = $($detector.Value);
_result
| getschema
| order by ColumnOrdinal asc
| summarize _columns = strcat_array(make_list(ColumnName), ",")
| project passed = _columns == "$ExpectedColumns"
"@
}

Assert-Kusto -Label 'anomaly-only keeps anomalies and diagnostics but drops clean scores' -Csl @"
$SyntheticPrefix
let _result = mvad_residual_magnitude_voting(
    _prepared, 32m, 0, "linefit", "ctukey",
    2.0, 1.8, 2, 0.5, 4.0, false);
_result
| summarize
    _diagnostics = countif(entity_id == "low_coverage" and status != "ok"),
    _clean_scores = countif(entity_id == "clean" and status == "ok" and not(is_anomaly)),
    _anomalies = countif(status == "ok" and is_anomaly)
| project passed = _diagnostics == 1 and _clean_scores == 0 and _anomalies > 0
"@

Assert-Kusto -Label 'intended synthetic detectors trigger and clean control stays quiet' -Csl @"
$SyntheticPrefix
let _residual = mvad_residual_magnitude_voting(
    _prepared, 32m, 0, "linefit", "ctukey",
    2.0, 1.8, 2, 0.5, 4.0, false);
let _random = mvad_random_projection_ensemble(
    _prepared, 32m, 0, "none", 24, 0.35, "smoke-seed",
    1.2, 1.0, 3, 2.5, 1e-6, 2000000, false);
let _change = mvad_change_point_ensemble(
    _prepared, 32m, 0, 8,
    1.2, 1.0, 2, 0.5, 2.5, true, false);
let _spectral = mvad_spectral_aggregation(
    _prepared, 64m, 3, 2, true,
    1.5, 1.0, 2, 0.5, 3.0, false);
union
    (_residual | summarize hit=countif(entity_id == "residual" and is_anomaly), clean=countif(entity_id == "clean" and is_anomaly) | extend detector="residual"),
    (_random | summarize hit=countif(entity_id == "correlation" and is_anomaly), clean=countif(entity_id == "clean" and is_anomaly) | extend detector="random_projection"),
    (_change | summarize hit=countif(entity_id == "change" and is_anomaly), clean=countif(entity_id == "clean" and is_anomaly) | extend detector="change"),
    (_spectral | summarize hit=countif(entity_id == "spectral" and is_anomaly), clean=countif(entity_id == "clean" and is_anomaly) | extend detector="spectral")
| summarize passed = countif(hit > 0 and clean == 0) == 4
"@

Assert-Kusto -Label 'random projections are deterministic for a fixed seed' -Csl @"
$SyntheticPrefix
let _a = mvad_random_projection_ensemble(
    _prepared, 32m, 0, "none", 24, 0.35, "stable-seed",
    1.2, 1.0, 3, 2.5, 1e-6, 2000000, true)
    | where status == "ok"
    | project entity_id, event_index, score_a=score;
let _b = mvad_random_projection_ensemble(
    _prepared, 32m, 0, "none", 24, 0.35, "stable-seed",
    1.2, 1.0, 3, 2.5, 1e-6, 2000000, true)
    | where status == "ok"
    | project entity_id, event_index, score_b=score;
_a
| join kind=fullouter _b on entity_id, event_index
| summarize passed =
    countif(isnull(score_a) or isnull(score_b) or abs(score_a - score_b) > 1e-12) == 0
"@

Assert-Kusto -Label 'random projection work guard returns diagnostics before expansion' -Csl @"
$SyntheticPrefix
mvad_random_projection_ensemble(
    _prepared, 32m, 0, "none", 24, 1.0, "work-guard",
    1.2, 1.0, 3, 2.5, 1e-6, 10, false)
| summarize passed =
    countif(entity_id != "low_coverage" and status == "work_limit_exceeded") == 5
    and countif(status == "ok") == 0
"@

Assert-KustoFailure -Label 'invalid scalar parameters fail through assert' -Csl @"
$SyntheticPrefix
mvad_residual_magnitude_voting(
    _prepared, 32m, 0, "linefit", "ctukey",
    -1.0, 1.0, 2, 0.5, 2.5, false)
| take 1
"@

if (-not $SkipStress) {
    Assert-Kusto -Label '32-track 2048-bin projection stress case completes' -Csl @'
let _start = datetime(2026-02-01);
let _end = _start + 2048m;
let _source =
    range _index from 0 to 2047 step 1
    | mv-expand _track_index = range(0, 31, 1) to typeof(long)
    | project
        entity_id = "stress",
        track_id = strcat("t", _track_index),
        timestamp = _start + _index * 1m,
        value = sin(2.0 * pi() * todouble(_index) / 32.0 + todouble(_track_index) / 10.0);
let _prepared = mvad_make_series(_source, _start, _end, 1m, 1.0, 0);
mvad_random_projection_ensemble(
    _prepared, 32m, 0, "none", 16, 0.20, "stress-seed",
    1.5, 1.2, 4, 3.0, 1e-6, 2000000, true)
| summarize passed = countif(status == "ok") == 32
'@
}

Write-Host "MVAD smoke checks passed: $script:PassCount"
