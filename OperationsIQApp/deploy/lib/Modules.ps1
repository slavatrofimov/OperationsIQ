<#
    Module selection + dependency ordering for the Operations IQ deployment
    orchestrator. Kept side-effect free so Pester can exercise it directly.

    . "$PSScriptRoot/lib/Modules.ps1"
#>

Set-StrictMode -Version Latest

# Load and lightly validate the module registry (modules.psd1). Returns the
# array of module hashtables in declared order.
function Import-ModuleRegistry {
    param([Parameter(Mandatory)] [string]$Path)
    if (-not (Test-Path $Path)) { throw "Module registry not found: $Path" }
    $data = Import-PowerShellDataFile -Path $Path
    if (-not $data.Modules) { throw "Registry $Path has no 'Modules' key." }
    $ids = @{}
    foreach ($m in $data.Modules) {
        foreach ($required in 'Id', 'Name', 'Script') {
            if (-not $m.ContainsKey($required)) {
                throw "Module '$($m.Id)' is missing required field '$required'."
            }
        }
        if ($ids.ContainsKey($m.Id)) { throw "Duplicate module id '$($m.Id)' in registry." }
        $ids[$m.Id] = $true
        foreach ($field in 'DependsOn', 'Produces', 'Consumes') {
            if (-not $m.ContainsKey($field) -or $null -eq $m[$field]) { $m[$field] = @() }
        }
        if (-not $m.ContainsKey('Optional')) { $m.Optional = $false }
    }
    # Every DependsOn must reference a known module.
    foreach ($m in $data.Modules) {
        foreach ($dep in $m.DependsOn) {
            if (-not $ids.ContainsKey($dep)) {
                throw "Module '$($m.Id)' depends on unknown module '$dep'."
            }
        }
    }
    return , $data.Modules
}

# Index the registry by id for quick lookup.
function ConvertTo-ModuleIndex {
    param([Parameter(Mandatory)] [object[]]$Registry)
    $index = @{}
    foreach ($m in $Registry) { $index[$m.Id] = $m }
    return $index
}

# A dependency is "satisfied without running" when every output it produces is
# already present in the merged outputs. This is what lets a teammate hand over
# a JSON instead of re-running an upstream module the operator can't run.
function Test-DependencySatisfiedByOutputs {
    param(
        [Parameter(Mandatory)] [hashtable]$Module,
        [Parameter(Mandatory)] [hashtable]$Outputs
    )
    $produces = @($Module.Produces)
    if ($produces.Count -eq 0) { return $false }
    foreach ($key in $produces) {
        if (-not ($Outputs.ContainsKey($key) -and $null -ne $Outputs[$key] -and "$($Outputs[$key])" -ne '')) {
            return $false
        }
    }
    return $true
}

# Topologically sort a set of modules by their DependsOn edges (Kahn's
# algorithm, stable on declared order). Only edges *within the selected set*
# constrain ordering; deps satisfied externally are ignored here. Throws on a
# dependency cycle.
function Get-TopologicalOrder {
    param(
        [Parameter(Mandatory)] [object[]]$Modules
    )
    $selected = @{}
    foreach ($m in $Modules) { $selected[$m.Id] = $m }

    $indegree = @{}
    $dependents = @{}
    foreach ($m in $Modules) {
        if (-not $indegree.ContainsKey($m.Id)) { $indegree[$m.Id] = 0 }
        foreach ($dep in $m.DependsOn) {
            if ($selected.ContainsKey($dep)) {
                $indegree[$m.Id]++
                if (-not $dependents.ContainsKey($dep)) { $dependents[$dep] = New-Object System.Collections.Generic.List[string] }
                $dependents[$dep].Add($m.Id)
            }
        }
    }

    # Seed the queue in declared order for deterministic output.
    $ready = New-Object System.Collections.Generic.List[string]
    foreach ($m in $Modules) { if ($indegree[$m.Id] -eq 0) { $ready.Add($m.Id) } }

    $ordered = New-Object System.Collections.Generic.List[object]
    while ($ready.Count -gt 0) {
        $id = $ready[0]
        $ready.RemoveAt(0)
        $ordered.Add($selected[$id])
        if ($dependents.ContainsKey($id)) {
            foreach ($child in $dependents[$id]) {
                $indegree[$child]--
                if ($indegree[$child] -eq 0) { $ready.Add($child) }
            }
        }
    }

    if ($ordered.Count -ne $Modules.Count) {
        $remaining = @($Modules | Where-Object { $ordered.Id -notcontains $_.Id } | ForEach-Object { $_.Id })
        throw "Dependency cycle detected among: $($remaining -join ', ')."
    }
    return , $ordered.ToArray()
}

# Resolve the ordered list of modules to run given operator selection.
#
#   -Modules  explicit ids to run (empty => all non-Optional modules).
#   -Skip     ids to exclude even if pulled in.
#   -Outputs  merged outputs hashtable (deps already satisfied are not pulled in).
#
# When -Modules is given, transitively pulls in any DependsOn that is NOT already
# satisfied by outputs, so a partial run still has what it needs (or fails fast
# with a clear message when the missing dep is also excluded/absent).
function Resolve-ModuleSelection {
    param(
        [Parameter(Mandatory)] [object[]]$Registry,
        [string[]]$Modules = @(),
        [string[]]$Skip = @(),
        [hashtable]$Outputs = @{}
    )
    $index = ConvertTo-ModuleIndex -Registry $Registry
    $skipSet = @{}
    foreach ($s in $Skip) {
        if (-not $index.ContainsKey($s)) { throw "Cannot skip unknown module '$s'." }
        $skipSet[$s] = $true
    }

    $wanted = @{}
    if ($Modules.Count -eq 0) {
        foreach ($m in $Registry) {
            if (-not $m.Optional -and -not $skipSet.ContainsKey($m.Id)) { $wanted[$m.Id] = $true }
        }
    } else {
        foreach ($id in $Modules) {
            if (-not $index.ContainsKey($id)) { throw "Unknown module '$id'." }
            $wanted[$id] = $true
        }
        # Transitively add unsatisfied dependencies.
        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($id in @($wanted.Keys)) {
                foreach ($dep in $index[$id].DependsOn) {
                    if ($wanted.ContainsKey($dep)) { continue }
                    if ($skipSet.ContainsKey($dep)) { continue }
                    if (Test-DependencySatisfiedByOutputs -Module $index[$dep] -Outputs $Outputs) { continue }
                    $wanted[$dep] = $true
                    $changed = $true
                }
            }
        }
    }

    foreach ($s in $skipSet.Keys) { $wanted.Remove($s) | Out-Null }

    $selected = @($Registry | Where-Object { $wanted.ContainsKey($_.Id) })
    if ($selected.Count -eq 0) { return , @() }

    $ordered = Get-TopologicalOrder -Modules $selected

    # Final guard: any DependsOn that is neither in the run set nor satisfied by
    # outputs is a hard gap the operator must fill.
    foreach ($m in $ordered) {
        foreach ($dep in $m.DependsOn) {
            $inRun = [bool]($ordered | Where-Object { $_.Id -eq $dep })
            if ($inRun) { continue }
            if (Test-DependencySatisfiedByOutputs -Module $index[$dep] -Outputs $Outputs) { continue }
            throw "Module '$($m.Id)' needs '$dep', which is not being run and whose outputs are absent. Run '$dep' first, hand over its outputs JSON, or use its manual-step doc."
        }
    }

    return , $ordered
}
