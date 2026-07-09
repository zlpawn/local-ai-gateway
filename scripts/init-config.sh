#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

copy_template_if_missing() {
  local template="$1"
  local target="$2"
  local template_path="$ROOT/$template"
  local target_path="$ROOT/$target"

  if [[ ! -f "$template_path" ]]; then
    echo "Template not found: $template_path" >&2
    exit 1
  fi

  if [[ -f "$target_path" ]]; then
    echo "Exists: $target"
    return
  fi

  cp "$template_path" "$target_path"
  echo "Created: $target"
}

copy_template_if_missing ".env.example" ".env"

cat <<'EOF'

Next steps:
  1. Edit .env
  2. Start the gateway and open http://127.0.0.1:8787/config
  3. Save the web config page to create gateway.config.json
EOF
