#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if command -v powershell.exe >/dev/null 2>&1; then
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/agent-gateway.ps1" "$@"
  exit $?
fi

if command -v pwsh >/dev/null 2>&1; then
  pwsh -NoProfile -File "$SCRIPT_DIR/agent-gateway.ps1" "$@"
  exit $?
fi

echo "PowerShell is required to run agent-gateway on this machine." >&2
exit 1
