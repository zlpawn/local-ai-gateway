$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
$Root = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $Root "gateway.pid"
$StdoutLog = Join-Path $Root "gateway.stdout.log"
$StderrLog = Join-Path $Root "gateway.stderr.log"
$AppLog = Join-Path $Root "gateway.log"

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

function Show-Usage {
  @"
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
"@ | Write-Host
}

function Tail-Log {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    Write-Host "Log file not found: $Path"
    return
  }

  Get-Content -LiteralPath $Path -Tail 80 -Wait
}

$command = if ($args.Count -gt 0) { $args[0] } else { "" }

switch ($command) {
  "start" {
    & (Join-Path $ScriptDir "start-gateway.ps1")
  }
  "stop" {
    & (Join-Path $ScriptDir "stop-gateway.ps1")
  }
  "restart" {
    & (Join-Path $ScriptDir "restart-gateway.ps1")
  }
  "status" {
    & (Join-Path $ScriptDir "status-gateway.ps1")
  }
  "logs" {
    Tail-Log -Path $AppLog
  }
  "stdout" {
    Tail-Log -Path $StdoutLog
  }
  "stderr" {
    Tail-Log -Path $StderrLog
  }
  "path" {
    Write-Host $Root
  }
  "" {
    Show-Usage
  }
  "help" {
    Show-Usage
  }
  "-h" {
    Show-Usage
  }
  "--help" {
    Show-Usage
  }
  default {
    Write-Error "Unknown command: $command"
  }
}
