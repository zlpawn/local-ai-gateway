$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root "gateway.pid"
$StdoutLog = Join-Path $Root "gateway.stdout.log"
$StderrLog = Join-Path $Root "gateway.stderr.log"

function Normalize-EnvVarCase {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PreferredName,

    [Parameter(Mandatory = $true)]
    [string[]]$Aliases
  )

  $value = $null
  foreach ($name in @($PreferredName) + $Aliases) {
    $candidate = [System.Environment]::GetEnvironmentVariable($name, "Process")
    if ($candidate) {
      $value = $candidate
      break
    }
  }

  foreach ($name in @($PreferredName) + $Aliases) {
    [System.Environment]::SetEnvironmentVariable($name, $null, "Process")
  }

  if ($null -ne $value) {
    [System.Environment]::SetEnvironmentVariable($PreferredName, $value, "Process")
  }
}

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

function Get-RunningPidFromFile {
  if (-not (Test-Path $PidFile)) {
    return $null
  }

  $savedPid = (Get-Content $PidFile -Raw).Trim()
  if (-not $savedPid) {
    return $null
  }

  $process = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
  if ($process) {
    return $process.Id
  }

  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  return $null
}

function Get-ListeningPid {
  $connection = Get-NetTCPConnection `
    -LocalAddress 127.0.0.1 `
    -LocalPort $Port `
    -State Listen `
    -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if ($connection) {
    return $connection.OwningProcess
  }

  return $null
}

$runningPid = Get-RunningPidFromFile
if ($runningPid) {
  Write-Host "Gateway already running. PID: $runningPid"
  exit 0
}

$listeningPid = Get-ListeningPid
if ($listeningPid) {
  Write-Host "Port $Port is already in use by PID: $listeningPid"
  Write-Host "Run npm run gateway:status for details."
  exit 1
}

$hasProxy = $env:HTTPS_PROXY -or $env:HTTP_PROXY -or $env:ALL_PROXY -or $env:https_proxy -or $env:http_proxy -or $env:all_proxy
if ($hasProxy -and -not $env:NODE_USE_ENV_PROXY) {
  $env:NODE_USE_ENV_PROXY = "1"
}

# Windows treats environment variable names case-insensitively. If both
# `NO_PROXY` and `no_proxy` exist, Start-Process can fail while building the
# child environment block. Normalize common proxy keys to a single casing.
Normalize-EnvVarCase -PreferredName "HTTP_PROXY" -Aliases @("http_proxy")
Normalize-EnvVarCase -PreferredName "HTTPS_PROXY" -Aliases @("https_proxy")
Normalize-EnvVarCase -PreferredName "ALL_PROXY" -Aliases @("all_proxy")
Normalize-EnvVarCase -PreferredName "NO_PROXY" -Aliases @("no_proxy")

$node = Get-Command node -ErrorAction Stop
$process = Start-Process `
  -FilePath $node.Source `
  -ArgumentList "--use-env-proxy", "server.js" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $StdoutLog `
  -RedirectStandardError $StderrLog `
  -PassThru

Set-Content -Path $PidFile -Value $process.Id -Encoding ascii
Start-Sleep -Milliseconds 900

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
  Write-Host "Gateway started. PID: $($process.Id)"
  Write-Host "Health: ok=$($health.ok), upstream=$($health.upstream)"
} catch {
  Write-Host "Gateway process started but health check failed. PID: $($process.Id)"
  Write-Host "Check $StderrLog"
  exit 1
}
