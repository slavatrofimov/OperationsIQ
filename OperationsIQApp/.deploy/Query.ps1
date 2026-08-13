param(
    [Parameter(Mandatory = $true)][string]$ClusterUri,
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][string]$Csl
)
$ErrorActionPreference = 'Stop'
$token = az account get-access-token --resource "https://kusto.kusto.windows.net" --query accessToken -o tsv
$j = @{ db = $Database; csl = $Csl } | ConvertTo-Json -Compress
$p = Join-Path $env:TEMP 'kql_verify.json'
$j | Out-File $p -Encoding utf8NoBOM
$raw = curl.exe -s -X POST "$ClusterUri/v2/rest/query" -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data "@$p"
$data = $raw | ConvertFrom-Json
$primary = $data | Where-Object { $_.TableKind -eq 'PrimaryResult' }
foreach ($t in $primary) {
    $cols = $t.Columns.ColumnName
    foreach ($row in $t.Rows) {
        $obj = [ordered]@{}
        for ($i = 0; $i -lt $cols.Count; $i++) { $obj[$cols[$i]] = $row[$i] }
        [pscustomobject]$obj | Format-Table -AutoSize | Out-String | Write-Host
    }
}
