#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$ROOT/gateway.pid"
STDOUT_LOG="$ROOT/gateway.stdout.log"
STDERR_LOG="$ROOT/gateway.stderr.log"
APP_LOG="$ROOT/gateway.log"

usage() {
  cat <<'EOF'
Usage: agent-gateway <command>

Commands:
  start      Start gateway in background
  stop       Stop gateway
  restart    Restart gateway
  status     Show gateway status
  logs       Tail app log
  stdout     Tail process stdout log
  stderr     Tail process stderr log
  path       Print project path
EOF
}

dotenv_value() {
  local name="$1"
  local env_file="$ROOT/.env"
  [[ -f "$env_file" ]] || return 1

  awk -F= -v key="$name" '
    $0 !~ /^[[:space:]]*#/ {
      left=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", left)
      if (left == key) {
        value=substr($0, index($0, "=") + 1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        gsub(/^["'"'"']|["'"'"']$/, "", value)
        print value
        exit 0
      }
    }
  ' "$env_file"
}

config_path() {
  local configured="${GATEWAY_CONFIG_FILE:-gateway.config.json}"
  if [[ "$configured" = /* ]]; then
    printf '%s\n' "$configured"
  else
    printf '%s\n' "$ROOT/$configured"
  fi
}

get_gateway_port() {
  if [[ "${GATEWAY_PORT:-}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$GATEWAY_PORT"
    return
  fi
  if [[ "${PORT:-}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$PORT"
    return
  fi

  local value
  value="$(dotenv_value GATEWAY_PORT || true)"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return
  fi

  value="$(dotenv_value PORT || true)"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return
  fi

  local file
  file="$(config_path)"
  if [[ -f "$file" ]]; then
    value="$(
      node -e '
        const fs = require("fs");
        const file = process.argv[1];
        try {
          const json = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
          const port = Number(json?.server?.port);
          if (Number.isInteger(port) && port > 0) console.log(port);
        } catch {}
      ' "$file"
    )"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$value"
      return
    fi
  fi

  printf '8787\n'
}

pid_is_running() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

pid_from_file() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$pid"
}

listening_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    ss -H -ltnp "sport = :$port" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
      | sort -u
    return
  fi

  if command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null \
      | awk -v port=":$port" '$4 ~ port "$" && $7 ~ /^[0-9]+/ { split($7, a, "/"); print a[1] }' \
      | sort -u
  fi
}

node_args() {
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  if [[ "$major" =~ ^[0-9]+$ && "$major" -ge 24 ]]; then
    printf '%s\n' "--use-env-proxy"
  fi
  printf '%s\n' "server.js"
}

start_gateway() {
  local port
  port="$(get_gateway_port)"

  local pid
  if pid="$(pid_from_file)" && pid_is_running "$pid"; then
    printf 'Gateway already running. PID: %s\n' "$pid"
    return 0
  fi
  rm -f "$PID_FILE"

  local listeners
  listeners="$(listening_pids "$port" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ -n "$listeners" ]]; then
    printf 'Port %s is already in use by PID: %s\n' "$port" "$listeners"
    printf 'Run agent-gateway status for details.\n'
    return 1
  fi

  command -v node >/dev/null 2>&1 || {
    printf 'node is required to start the gateway.\n' >&2
    return 1
  }

  if [[ -n "${HTTPS_PROXY:-}${HTTP_PROXY:-}${ALL_PROXY:-}${https_proxy:-}${http_proxy:-}${all_proxy:-}" && -z "${NODE_USE_ENV_PROXY:-}" ]]; then
    export NODE_USE_ENV_PROXY=1
  fi

  : > "$STDOUT_LOG"
  : > "$STDERR_LOG"

  local args=()
  while IFS= read -r arg; do
    args+=("$arg")
  done < <(node_args)

  (
    cd "$ROOT"
    nohup node "${args[@]}" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
    printf '%s\n' "$!" > "$PID_FILE"
  )

  pid="$(pid_from_file)"
  sleep 0.9

  if health="$(fetch_health "$port" 3)"; then
    local upstream
    upstream="$(json_field "$health" "upstream")"
    printf 'Gateway started. PID: %s\n' "$pid"
    printf 'Health: ok=true, upstream=%s\n' "${upstream:-}"
    return 0
  fi

  printf 'Gateway process started but health check failed. PID: %s\n' "$pid"
  printf 'Check %s\n' "$STDERR_LOG"
  return 1
}

stop_gateway() {
  local port
  port="$(get_gateway_port)"
  local stopped=0

  local pid
  if pid="$(pid_from_file)"; then
    if pid_is_running "$pid"; then
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      if pid_is_running "$pid"; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      printf 'Stopped gateway PID: %s\n' "$pid"
      stopped=1
    fi
    rm -f "$PID_FILE"
  fi

  local listener
  while IFS= read -r listener; do
    [[ "$listener" =~ ^[0-9]+$ ]] || continue
    if pid_is_running "$listener"; then
      kill "$listener" 2>/dev/null || true
      sleep 0.2
      if pid_is_running "$listener"; then
        kill -9 "$listener" 2>/dev/null || true
      fi
      printf 'Stopped gateway PID: %s\n' "$listener"
      stopped=1
    fi
  done < <(listening_pids "$port")

  if [[ "$stopped" -eq 0 ]]; then
    printf 'Gateway is not running.\n'
  fi
}

fetch_health() {
  local port="$1"
  local timeout="${2:-3}"
  local url="http://127.0.0.1:$port/health"

  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time "$timeout" "$url" 2>/dev/null
    return
  fi

  node -e '
    const url = process.argv[1];
    const timeout = Number(process.argv[2]) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        clearTimeout(timer);
        if (!response.ok) process.exit(1);
        console.log(await response.text());
      })
      .catch(() => process.exit(1));
  ' "$url" "$timeout"
}

json_field() {
  local json="$1"
  local field="$2"
  node -e '
    const json = process.argv[1];
    const field = process.argv[2];
    try {
      const value = JSON.parse(json)[field];
      if (Array.isArray(value)) console.log(value.join(", "));
      else if (value != null) console.log(value);
    } catch {}
  ' "$json" "$field"
}

status_gateway() {
  local port
  port="$(get_gateway_port)"

  local pid_file_value=""
  pid_file_value="$(pid_from_file || true)"

  local listeners
  listeners="$(listening_pids "$port")"
  if [[ -z "$listeners" ]]; then
    printf 'Gateway is not listening on 127.0.0.1:%s\n' "$port"
    if [[ -n "$pid_file_value" ]]; then
      printf 'Stale PID file: %s\n' "$pid_file_value"
    fi
    return 0
  fi

  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    printf 'Gateway listening on 127.0.0.1:%s\n' "$port"
    printf 'PID: %s\n' "$pid"
    if command -v ps >/dev/null 2>&1; then
      local name
      name="$(ps -p "$pid" -o comm= 2>/dev/null | sed 's/^[[:space:]]*//')"
      [[ -n "$name" ]] && printf 'Process: %s\n' "$name"
    fi
  done <<< "$listeners"

  local health
  if health="$(fetch_health "$port" 3)"; then
    printf 'Health: ok=%s\n' "$(json_field "$health" "ok")"
    printf 'Upstream: %s\n' "$(json_field "$health" "upstream")"
    printf 'Models: %s\n' "$(json_field "$health" "models")"
  else
    printf 'Health check failed.\n'
  fi
}

tail_log() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf 'Log file not found: %s\n' "$file"
    return 0
  fi
  tail -n 80 -f "$file"
}

command="${1:-}"
case "$command" in
  start)
    start_gateway
    ;;
  stop)
    stop_gateway
    ;;
  restart)
    stop_gateway
    sleep 0.5
    start_gateway
    ;;
  status)
    status_gateway
    ;;
  logs)
    tail_log "$APP_LOG"
    ;;
  stdout)
    tail_log "$STDOUT_LOG"
    ;;
  stderr)
    tail_log "$STDERR_LOG"
    ;;
  path)
    printf '%s\n' "$ROOT"
    ;;
  ""|help|-h|--help)
    usage
    ;;
  *)
    printf 'Unknown command: %s\n' "$command" >&2
    usage >&2
    exit 1
    ;;
esac
