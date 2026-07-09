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

gateway_port() {
  if [[ "${GATEWAY_PORT:-}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$GATEWAY_PORT"
    return
  fi
  if [[ "${PORT:-}" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$PORT"
    return
  fi

  node - "$ROOT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];

for (const name of ["GATEWAY_PORT", "PORT"]) {
  const value = process.env[name];
  if (/^\d+$/.test(value || "")) {
    console.log(value);
    process.exit(0);
  }
}

const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(GATEWAY_PORT|PORT)\s*=\s*["']?(\d+)["']?\s*$/);
    if (match) {
      console.log(match[2]);
      process.exit(0);
    }
  }
}

const configured = process.env.GATEWAY_CONFIG_FILE || "gateway.config.json";
const configPath = path.isAbsolute(configured) ? configured : path.join(root, configured);
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    const port = Number(config?.server?.port);
    if (Number.isInteger(port) && port > 0) {
      console.log(port);
      process.exit(0);
    }
  } catch {}
}

console.log("8787");
NODE
}

read_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$pid"
}

pid_running() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

port_pids() {
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

health_json() {
  local port="$1"
  local url="http://127.0.0.1:$port/health"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$url" 2>/dev/null
    return
  fi

  node - "$url" <<'NODE'
const url = process.argv[2];
const controller = new AbortController();
setTimeout(() => controller.abort(), 3000);
fetch(url, { signal: controller.signal })
  .then(async (response) => {
    if (!response.ok) process.exit(1);
    console.log(await response.text());
  })
  .catch(() => process.exit(1));
NODE
}

json_field() {
  node - "$1" "$2" <<'NODE'
const json = process.argv[2];
const field = process.argv[3];
try {
  const value = JSON.parse(json)[field];
  if (Array.isArray(value)) console.log(value.join(", "));
  else if (value !== undefined && value !== null) console.log(value);
} catch {}
NODE
}

start_gateway() {
  command -v node >/dev/null 2>&1 || {
    printf 'node is required to start the gateway.\n' >&2
    return 1
  }

  local port pid listeners
  port="$(gateway_port)"

  if pid="$(read_pid)" && pid_running "$pid"; then
    printf 'Gateway already running. PID: %s\n' "$pid"
    return 0
  fi
  rm -f "$PID_FILE"

  listeners="$(port_pids "$port" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ -n "$listeners" ]]; then
    printf 'Port %s is already in use by PID: %s\n' "$port" "$listeners" >&2
    return 1
  fi

  : > "$STDOUT_LOG"
  : > "$STDERR_LOG"

  (
    cd "$ROOT"
    nohup node server.js >"$STDOUT_LOG" 2>"$STDERR_LOG" &
    printf '%s\n' "$!" > "$PID_FILE"
  )

  pid="$(read_pid)"
  sleep 1
  if health="$(health_json "$port")"; then
    printf 'Gateway started. PID: %s\n' "$pid"
    printf 'Health: ok=%s\n' "$(json_field "$health" ok)"
  else
    printf 'Gateway process started but health check failed. PID: %s\n' "$pid" >&2
    printf 'Check %s\n' "$STDERR_LOG" >&2
    return 1
  fi
}

stop_gateway() {
  local port stopped pid
  port="$(gateway_port)"
  stopped=0

  if pid="$(read_pid)"; then
    if pid_running "$pid"; then
      kill "$pid" 2>/dev/null || true
      sleep 0.3
      pid_running "$pid" && kill -9 "$pid" 2>/dev/null || true
      printf 'Stopped gateway PID: %s\n' "$pid"
      stopped=1
    fi
    rm -f "$PID_FILE"
  fi

  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    pid_running "$pid" || continue
    kill "$pid" 2>/dev/null || true
    sleep 0.3
    pid_running "$pid" && kill -9 "$pid" 2>/dev/null || true
    printf 'Stopped gateway PID: %s\n' "$pid"
    stopped=1
  done < <(port_pids "$port")

  [[ "$stopped" -eq 1 ]] || printf 'Gateway is not running.\n'
}

status_gateway() {
  local port listeners health pid
  port="$(gateway_port)"
  listeners="$(port_pids "$port")"

  if [[ -z "$listeners" ]]; then
    printf 'Gateway is not listening on 127.0.0.1:%s\n' "$port"
    return 0
  fi

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    printf 'Gateway listening on 127.0.0.1:%s\n' "$port"
    printf 'PID: %s\n' "$pid"
  done <<< "$listeners"

  if health="$(health_json "$port")"; then
    printf 'Health: ok=%s\n' "$(json_field "$health" ok)"
    printf 'Upstream: %s\n' "$(json_field "$health" upstream)"
    printf 'Models: %s\n' "$(json_field "$health" models)"
  else
    printf 'Health check failed.\n'
  fi
}

tail_log() {
  local file="$1"
  [[ -f "$file" ]] || {
    printf 'Log file not found: %s\n' "$file"
    return 0
  }
  tail -n 80 -f "$file"
}

case "${1:-}" in
  start) start_gateway ;;
  stop) stop_gateway ;;
  restart) stop_gateway; sleep 0.5; start_gateway ;;
  status) status_gateway ;;
  logs) tail_log "$APP_LOG" ;;
  stdout) tail_log "$STDOUT_LOG" ;;
  stderr) tail_log "$STDERR_LOG" ;;
  path) printf '%s\n' "$ROOT" ;;
  ""|help|-h|--help) usage ;;
  *)
    printf 'Unknown command: %s\n' "$1" >&2
    usage >&2
    exit 1
    ;;
esac
