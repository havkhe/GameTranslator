param(
    [string]$Source = $PSScriptRoot,
    [string]$Dest = "D:\GameTranslator"
)
$ErrorActionPreference = "Stop"

$files = @(
    "GameTranslator.exe",
    "game-pipeline.js",
    "rgss3a.js",
    "vxace_extract.rb",
    "vxace_patch.rb",
    "vxace_stubs.rb"
)
$readme = [char]0x4F7F + [char]0x7528 + [char]0x8BF4 + [char]0x660E + ".txt"
$files += $readme

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
foreach ($f in $files) {
    Copy-Item -LiteralPath (Join-Path $Source $f) -Destination (Join-Path $Dest $f) -Force
}

# Portable Ruby (VX Ace support)
Copy-Item -LiteralPath (Join-Path $Source "ruby") -Destination (Join-Path $Dest "ruby") -Recurse -Force

# Bundled llama runtime (placed by download-llama.ps1)
if (-not (Test-Path -LiteralPath (Join-Path $Dest "llama\llama-server.exe"))) {
    Write-Host "WARNING: D:\GameTranslator\llama\llama-server.exe not found. Run download-llama.ps1 first." -ForegroundColor Yellow
}

# Remove old network-API config
$oldApi = Join-Path $Dest "api-config.json"
if (Test-Path -LiteralPath $oldApi) {
    Remove-Item -LiteralPath $oldApi -Force
    Write-Host "Removed old api-config.json"
}

# Default settings.json (do not overwrite user config)
$settings = Join-Path $Dest "settings.json"
if (-not (Test-Path -LiteralPath $settings)) {
    '{"ModelDir":"D:\\galtrans","Port":18080}' | Set-Content -LiteralPath $settings -Encoding UTF8
    Write-Host "Created default settings.json"
}

Write-Host "Deploy done: $Dest"
Get-ChildItem $Dest -Force | Select-Object Name | Format-Table -AutoSize
