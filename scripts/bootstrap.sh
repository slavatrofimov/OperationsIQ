#!/usr/bin/env bash
# Convenience wrapper: idempotent dependency bootstrap (see scripts/bootstrap.mjs).
# Forwards all arguments, e.g. ./scripts/bootstrap.sh --force
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/bootstrap.mjs" "$@"
