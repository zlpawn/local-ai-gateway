$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
& (Join-Path $ScriptDir "stop-gateway.ps1")
Start-Sleep -Milliseconds 500
& (Join-Path $ScriptDir "start-gateway.ps1")
