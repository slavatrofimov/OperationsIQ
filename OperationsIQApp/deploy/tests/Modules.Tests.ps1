#requires -Modules Pester

# Pester tests for the deployment orchestrator's module selection + dependency
# ordering (deploy/lib/Modules.ps1). Pure logic — no cloud calls.

BeforeAll {
    $script:deployRoot = Split-Path -Parent $PSScriptRoot
    . (Join-Path $script:deployRoot 'lib/Modules.ps1')

    # Build a normalized module hashtable for synthetic registries.
    function New-Mod {
        param(
            [string]$Id,
            [string[]]$DependsOn = @(),
            [string[]]$Produces = @(),
            [bool]$Optional = $false
        )
        @{
            Id = $Id; Name = $Id; Script = "modules/$Id.ps1"
            DependsOn = $DependsOn; Produces = $Produces; Consumes = @(); Optional = $Optional
        }
    }
}

Describe 'Import-ModuleRegistry' {
    It 'loads and normalizes the real registry' {
        $reg = Import-ModuleRegistry -Path (Join-Path $script:deployRoot 'modules.psd1')
        $reg.Count | Should -BeGreaterThan 0
        ($reg | Where-Object { $_.Id -eq 'preflight' }) | Should -Not -BeNullOrEmpty
        # Every DependsOn references a known id (Import validates this).
        $ids = $reg.Id
        foreach ($m in $reg) {
            foreach ($d in $m.DependsOn) { $ids | Should -Contain $d }
        }
    }

    It 'throws on a missing required field' {
        $bad = @{ Modules = @(@{ Id = 'x' }) }  # no Name/Script
        $tmp = New-TemporaryFile
        # Import-PowerShellDataFile needs a .psd1; emulate by writing one.
        $psd1 = "$($tmp.FullName).psd1"
        "@{ Modules = @(@{ Id = 'x' }) }" | Set-Content -Path $psd1
        { Import-ModuleRegistry -Path $psd1 } | Should -Throw
        Remove-Item $psd1, $tmp.FullName -ErrorAction SilentlyContinue
    }
}

Describe 'Test-DependencySatisfiedByOutputs' {
    It 'is satisfied only when every produced key is present and non-empty' {
        $m = New-Mod -Id 'foundry' -Produces @('foundryEndpoint', 'foundryModelDeployment')
        Test-DependencySatisfiedByOutputs -Module $m -Outputs @{ foundryEndpoint = 'x' } | Should -BeFalse
        Test-DependencySatisfiedByOutputs -Module $m -Outputs @{ foundryEndpoint = 'x'; foundryModelDeployment = 'y' } | Should -BeTrue
        Test-DependencySatisfiedByOutputs -Module $m -Outputs @{ foundryEndpoint = 'x'; foundryModelDeployment = '' } | Should -BeFalse
    }

    It 'is never satisfied for a module that produces nothing' {
        $m = New-Mod -Id 'preflight' -Produces @()
        Test-DependencySatisfiedByOutputs -Module $m -Outputs @{ anything = 'y' } | Should -BeFalse
    }
}

Describe 'Get-TopologicalOrder' {
    It 'orders dependencies before dependents' {
        $mods = @(
            (New-Mod -Id 'c' -DependsOn @('b')),
            (New-Mod -Id 'b' -DependsOn @('a')),
            (New-Mod -Id 'a')
        )
        $order = (Get-TopologicalOrder -Modules $mods).Id
        ($order.IndexOf('a')) | Should -BeLessThan ($order.IndexOf('b'))
        ($order.IndexOf('b')) | Should -BeLessThan ($order.IndexOf('c'))
    }

    It 'detects a cycle' {
        $mods = @(
            (New-Mod -Id 'a' -DependsOn @('b')),
            (New-Mod -Id 'b' -DependsOn @('a'))
        )
        { Get-TopologicalOrder -Modules $mods } | Should -Throw
    }
}

Describe 'Resolve-ModuleSelection' {
    BeforeAll {
        $script:reg = @(
            (New-Mod -Id 'preflight' -Produces @('preflightOk')),
            (New-Mod -Id 'foundry' -DependsOn @('preflight') -Produces @('foundryEndpoint')),
            (New-Mod -Id 'agent' -DependsOn @('foundry') -Produces @('agentName')),
            (New-Mod -Id 'sp' -Produces @('spId') -Optional $true),
            (New-Mod -Id 'smoke' -DependsOn @('agent') -Produces @('smokeOk'))
        )
    }

    It 'selects all non-optional modules by default, in dependency order' {
        $sel = (Resolve-ModuleSelection -Registry $script:reg).Id
        $sel | Should -Not -Contain 'sp'          # optional excluded
        $sel[0] | Should -Be 'preflight'
        ($sel.IndexOf('foundry')) | Should -BeLessThan ($sel.IndexOf('agent'))
    }

    It 'pulls in unsatisfied transitive deps for an explicit selection' {
        $sel = (Resolve-ModuleSelection -Registry $script:reg -Modules @('agent')).Id
        $sel | Should -Contain 'preflight'
        $sel | Should -Contain 'foundry'
        $sel | Should -Contain 'agent'
    }

    It 'does not pull in a dep already satisfied by outputs' {
        $outputs = @{ preflightOk = $true; foundryEndpoint = 'https://x' }
        $sel = (Resolve-ModuleSelection -Registry $script:reg -Modules @('agent') -Outputs $outputs).Id
        $sel | Should -Be @('agent')
    }

    It 'throws on a hard gap when a needed dep is skipped and unsatisfied' {
        { Resolve-ModuleSelection -Registry $script:reg -Modules @('agent') -Skip @('foundry') } |
            Should -Throw
    }

    It 'throws for an unknown module id' {
        { Resolve-ModuleSelection -Registry $script:reg -Modules @('nope') } | Should -Throw
    }
}

Describe 'Real registry resolves end-to-end' {
    It 'produces a full ordered plan with preflight first and smoke last' {
        $reg = Import-ModuleRegistry -Path (Join-Path $script:deployRoot 'modules.psd1')
        $sel = (Resolve-ModuleSelection -Registry $reg).Id
        $sel[0] | Should -Be 'preflight'
        $sel[-1] | Should -Be 'smoke'
        $sel | Should -Not -Contain 'deploy-sp'      # optional
        $sel | Should -Not -Contain 'eventhouse-new' # optional
    }
}
