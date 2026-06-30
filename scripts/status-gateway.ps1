$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root "gateway.pid"

function Get-GatewayPort {
  if ($env:GATEWAY_PORT) {
    return [int]$env:GATEWAY_PORT
  }
  if ($env:PORT) {
    return [int]$env:PORT
  }

  $envFile = Join-Path $Root ".env"
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match "^\s*GATEWAY_PORT\s*=\s*(\d+)\s*$") {
        return [int]$Matches[1]
      }
      if ($line -match "^\s*PORT\s*=\s*(\d+)\s*$") {
        return [int]$Matches[1]
      }
    }
  }

  $configFile = $env:GATEWAY_CONFIG_FILE
  if (-not $configFile) {
    $configFile = Join-Path $Root "gateway.config.json"
  } elseif (-not [System.IO.Path]::IsPathRooted($configFile)) {
    $configFile = Join-Path $Root $configFile
  }

  if (Test-Path $configFile) {
    try {
      $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
      if ($config.server.port) {
        return [int]$config.server.port
      }
    } catch {
    }
  }

  return 8787
}

$Port = Get-GatewayPort

$pidFromFile = $null
if (Test-Path $PidFile) {
  $savedPid = (Get-Content $PidFile -Raw).Trim()
  if ($savedPid) {
    $pidFromFile = [int]$savedPid
  }
}

$connections = Get-NetTCPConnection `
  -LocalAddress 127.0.0.1 `
  -LocalPort $Port `
  -State Listen `
  -ErrorAction SilentlyContinue

if (-not $connections) {
  Write-Host "Gateway is not listening on 127.0.0.1:$Port"
  if ($pidFromFile) {
    Write-Host "Stale PID file: $pidFromFile"
  }
  exit 0
}

foreach ($connection in $connections) {
  $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
  Write-Host "Gateway listening on 127.0.0.1:$Port"
  Write-Host "PID: $($connection.OwningProcess)"
  if ($process) {
    Write-Host "Process: $($process.ProcessName)"
  }
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
  Write-Host "Health: ok=$($health.ok)"
  Write-Host "Upstream: $($health.upstream)"
  Write-Host "Models: $($health.models -join ', ')"
} catch {
  Write-Host "Health check failed: $($_.Exception.Message)"
}
