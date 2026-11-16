#!/usr/bin/env bash
# Thin wrapper kept for existing habits and docs. The real installer is
# install-dev.mjs, which also runs on Windows where bash is unavailable.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-dev.mjs" "$@"
