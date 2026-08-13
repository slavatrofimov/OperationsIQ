#requires -Modules Pester

# Pester tests for deploy/config/Write-EnvFile.ps1 — assembling .env from the
# module outputs and validating required keys.

BeforeAll {
    $script:deployRoot = Split-Path -Parent $PSScriptRoot
    $script:writeEnv = Join-Path $script:deployRoot 'config/Write-EnvFile.ps1'

    function New-Workspace {
        $ws = Join-Path ([IO.Path]::GetTempPath()) ("oiq-env-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $ws -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $ws 'outputs') -Force | Out-Null
        return $ws
    }

    # Template covering every mapped key plus a preserved non-deployment default.
    $script:template = @'
VITE_RAYFIN_API_URL=
VITE_RAYFIN_PUBLISHABLE_KEY=
VITE_FABRIC_WORKSPACE_ID=
VITE_FABRIC_ITEM_ID=
VITE_EVENTHOUSE_QUERY_URI=
VITE_EVENTHOUSE_DB=
VITE_MSAL_CLIENT_ID=
VITE_MSAL_TENANT_ID=
VITE_FOUNDRY_SCOPE=https://ai.azure.com/.default
'@

    function Write-Outputs {
        param([string]$Ws, [hashtable]$Values, [string]$Name = 'test')
        ($Values | ConvertTo-Json) | Set-Content -Path (Join-Path $Ws "outputs/$Name.json")
    }

    $script:required = @{
        rayfinApiUrl = 'https://api.example.com'
        rayfinPublishableKey = 'pk-123'
        workspaceId = 'ws-1'
        fabricItemId = 'item-1'
        eventhouseQueryUri = 'https://eh.example.com'
        companionDatabase = 'OperationsIQ'
        msalClientId = 'client-1'
        tenantId = 'tenant-1'
    }
}

Describe 'Write-EnvFile' {
    It 'substitutes all required keys and preserves template defaults' {
        $ws = New-Workspace
        $tpl = Join-Path $ws '.env.example'
        $script:template | Set-Content -Path $tpl
        Write-Outputs -Ws $ws -Values $script:required
        $out = Join-Path $ws '.env.produced'

        & $script:writeEnv -OutputsDir (Join-Path $ws 'outputs') -TemplatePath $tpl -OutFile $out | Out-Null

        $content = Get-Content -Path $out -Raw
        $content | Should -Match 'VITE_RAYFIN_API_URL=https://api.example.com'
        $content | Should -Match 'VITE_EVENTHOUSE_DB=OperationsIQ'
        $content | Should -Match 'VITE_MSAL_TENANT_ID=tenant-1'
        # Non-deployment default preserved unchanged.
        $content | Should -Match 'VITE_FOUNDRY_SCOPE=https://ai.azure.com/.default'
        Remove-Item $ws -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'throws when a required value is missing' {
        $ws = New-Workspace
        $tpl = Join-Path $ws '.env.example'
        $script:template | Set-Content -Path $tpl
        $partial = $script:required.Clone()
        $partial.Remove('msalClientId')
        Write-Outputs -Ws $ws -Values $partial
        $out = Join-Path $ws '.env.produced'

        { & $script:writeEnv -OutputsDir (Join-Path $ws 'outputs') -TemplatePath $tpl -OutFile $out } |
            Should -Throw
        Remove-Item $ws -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'merges values across multiple outputs files' {
        $ws = New-Workspace
        $tpl = Join-Path $ws '.env.example'
        $script:template | Set-Content -Path $tpl
        # Split the required keys across two module output files.
        Write-Outputs -Ws $ws -Name 'a' -Values @{
            rayfinApiUrl = 'https://api.example.com'; rayfinPublishableKey = 'pk-123'
            workspaceId = 'ws-1'; fabricItemId = 'item-1'
        }
        Write-Outputs -Ws $ws -Name 'b' -Values @{
            eventhouseQueryUri = 'https://eh.example.com'; companionDatabase = 'OperationsIQ'
            msalClientId = 'client-1'; tenantId = 'tenant-1'
        }
        $out = Join-Path $ws '.env.produced'
        & $script:writeEnv -OutputsDir (Join-Path $ws 'outputs') -TemplatePath $tpl -OutFile $out | Out-Null
        (Get-Content $out -Raw) | Should -Match 'VITE_FABRIC_ITEM_ID=item-1'
        Remove-Item $ws -Recurse -Force -ErrorAction SilentlyContinue
    }
}
