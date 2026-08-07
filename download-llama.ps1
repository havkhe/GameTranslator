param(
    [string]$Dest = "D:\GameTranslator\llama",
    [string]$Tag = ""
)
$ErrorActionPreference = "Stop"

if ($Tag -eq "") {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -Headers @{ "User-Agent"="Codex" }
    $Tag = $rel.tag_name
}
$assetName = "llama-$Tag-bin-win-cuda-12.4-x64.zip"
$assetUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$Tag/$assetName"

Write-Host "下载: $assetUrl"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$zip = Join-Path $env:TEMP $assetName
Invoke-WebRequest -Uri $assetUrl -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $Dest -Force
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

$server = Join-Path $Dest "llama-server.exe"
if (-not (Test-Path -LiteralPath $server)) { throw "解压后未找到 llama-server.exe" }
Write-Host "OK: $server"
