$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root "gateway.pid"
$Port = 8787
$stopped = $false

function Stop-Pid {
  param([int]$ProcessId)

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) {
    return $false
  }

  Stop-Process -Id $ProcessId -Force
  Write-Host "Stopped gateway PID: $ProcessId"
  return $true
}

if (Test-Path $PidFile) {
  $savedPid = (Get-Content $PidFile -Raw).Trim()
  if ($savedPid) {
    $stopped = Stop-Pid -ProcessId ([int]$savedPid)
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

if (-not $stopped) {
  $connections = Get-NetTCPConnection `
    -LocalAddress 127.0.0.1 `
    -LocalPort $Port `
    -State Listen `
    -ErrorAction SilentlyContinue

  foreach ($connection in $connections) {
    if (Stop-Pid -ProcessId $connection.OwningProcess) {
      $stopped = $true
    }
  }
}

if (-not $stopped) {
  Write-Host "Gateway is not running."
}
