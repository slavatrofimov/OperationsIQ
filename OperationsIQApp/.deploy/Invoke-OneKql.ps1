param(
    [Parameter(Mandatory = $true)][string]$ClusterUri,
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$CslPath
)
$ErrorActionPreference = 'Stop'
$csl = Get-Content -Path $CslPath -Raw
$body = @{ db = $Database; csl = $csl } | ConvertTo-Json -Compress
$bodyPath = Join-Path $env:TEMP 'kql_one.json'
$body | Out-File -FilePath $bodyPath -Encoding utf8NoBOM
az rest --method POST --url "$ClusterUri/v1/rest/mgmt" --resource "https://kusto.kusto.windows.net" --headers "Content-Type=application/json" --body "@$bodyPath" 2>&1
