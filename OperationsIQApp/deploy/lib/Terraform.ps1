<#
    Terraform helper for the Azure-resource modules (foundry, entra, deploy-sp).
    Each module lives in its own root under deploy/terraform/<name> with its own
    state so operators can apply them independently.

    . "$PSScriptRoot/../lib/Terraform.ps1"
#>

Set-StrictMode -Version Latest

# Turn a hashtable of variables into repeated `-var key=value` args. Values that
# are already strings/numbers/bools are passed through; hashtables/arrays are
# JSON-encoded (Terraform accepts HCL-compatible JSON for complex vars).
function ConvertTo-TfVarArgs {
    param([hashtable]$Vars = @{})
    $args = @()
    foreach ($key in $Vars.Keys) {
        $val = $Vars[$key]
        if ($null -eq $val) { continue }
        if ($val -is [bool]) {
            $args += @('-var', "$key=$($val.ToString().ToLowerInvariant())")
        } elseif ($val -is [hashtable] -or $val -is [System.Collections.IEnumerable] -and -not ($val -is [string])) {
            $json = ($val | ConvertTo-Json -Compress -Depth 8)
            $args += @('-var', "$key=$json")
        } else {
            $args += @('-var', "$key=$val")
        }
    }
    return , $args
}

# Run `terraform init` (idempotent) + `terraform apply -auto-approve` in $Dir
# with the given variables, then return the parsed `terraform output -json`.
function Invoke-TerraformApply {
    param(
        [Parameter(Mandatory)] [string]$Dir,
        [hashtable]$Vars = @{},
        [switch]$PlanOnly
    )
    if (-not (Test-Command 'terraform')) {
        throw "terraform is not installed. Install it, or follow the manual doc for this module."
    }
    if (-not (Test-Path $Dir)) { throw "Terraform dir not found: $Dir" }

    $varArgs = ConvertTo-TfVarArgs -Vars $Vars

    Invoke-External -FilePath 'terraform' -Arguments @('-chdir', $Dir, 'init', '-input=false', '-upgrade')

    if ($PlanOnly) {
        Invoke-External -FilePath 'terraform' -Arguments (@('-chdir', $Dir, 'plan', '-input=false') + $varArgs)
        return @{}
    }

    Invoke-External -FilePath 'terraform' -Arguments (@('-chdir', $Dir, 'apply', '-input=false', '-auto-approve') + $varArgs)

    $json = terraform -chdir $Dir output -json
    if ($LASTEXITCODE -ne 0) { throw "terraform output failed in $Dir." }
    $parsed = $json | ConvertFrom-Json
    $result = @{}
    foreach ($prop in $parsed.PSObject.Properties) {
        $result[$prop.Name] = $prop.Value.value
    }
    return $result
}
