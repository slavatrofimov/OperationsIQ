#!/usr/bin/env pwsh
# Convenience wrapper: idempotent dependency bootstrap (see scripts/bootstrap.mjs).
# Forwards all arguments, e.g. ./scripts/bootstrap.ps1 -force  ->  --force
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Normalize -foo style flags into --foo for the Node script.
$forwarded = $args | ForEach-Object { if ($_ -match '^-[^-]') { "-$_" } else { $_ } }
node (Join-Path $scriptDir 'bootstrap.mjs') @forwarded
exit $LASTEXITCODE
