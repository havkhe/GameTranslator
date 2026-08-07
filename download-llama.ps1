param(
    [string]$Dest = "D:\GameTranslator\llama",
    [string]$Tag = "",
    [string]$Backend = "vulkan"
)
$ErrorActionPreference = "Stop"

if ($Tag -eq "") {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -Headers @{ "User-Agent"="Codex" }
    $Tag = $rel.tag_name
}

if ($Backend -eq "cuda12") {
    $assetName = "llama-$Tag-bin-win-cuda-12.4-x64.zip"
} else {
    $assetName = "llama-$Tag-bin-win-vulkan-x64.zip"
}
$assetUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$Tag/$assetName"

Write-Host "Download: $assetUrl"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$zip = Join-Path $env:TEMP $assetName
Invoke-WebRequest -Uri $assetUrl -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $Dest -Force
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue

$server = Join-Path $Dest "llama-server.exe"
if (-not (Test-Path -LiteralPath $server)) { throw "llama-server.exe not found after extraction" }
Write-Host "OK: $server"
Write-Host "Backend: $Backend (vulkan works on older NVIDIA/AMD/Intel GPUs; cuda12 requires sm_70+)"
