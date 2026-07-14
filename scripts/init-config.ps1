$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot

function Copy-TemplateIfMissing {
  param(
    [string]$Template,
    [string]$Target
  )

  $templatePath = Join-Path $Root $Template
  $targetPath = Join-Path $Root $Target

  if (-not (Test-Path $templatePath)) {
    throw "Template not found: $templatePath"
  }

  if (Test-Path $targetPath) {
    Write-Host "Exists: $Target"
    return
  }

  Copy-Item -LiteralPath $templatePath -Destination $targetPath
  Write-Host "Created: $Target"
}

Copy-TemplateIfMissing ".env.example" ".env"

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Edit .env"
Write-Host "  2. Start the gateway and open http://127.0.0.1:8787/config"
Write-Host "  3. Save the web config page to create gateway.config.json"
