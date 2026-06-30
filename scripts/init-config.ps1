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
Copy-TemplateIfMissing "gateway.config.example.json" "gateway.config.json"

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Edit .env and gateway.config.json"
Write-Host "  2. Run: npm run validate:config"
Write-Host "  3. Run: npm run gateway:start"
