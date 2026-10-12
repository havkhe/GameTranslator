param(
    [string]$Dest = "",
    [string]$Tag = "",
    [string]$Backend = "vulkan"
)
$ErrorActionPreference = "Stop"

# Windows-BACKEND-x64.zip is the build; the CUDA build ALSO needs the CUDA runtime in the same folder
# (cudart64_*.dll), which llama.cpp ships as a separate zip — without it the CUDA build cannot start.
if ($Dest -eq "") { $Dest = Join-Path $PSScriptRoot "llama" }
$suffix = if ($Backend -eq "cuda12") { "cuda-12.4" } else { "vulkan" }

if ($Tag -eq "") {
    # The newest release that actually carries Windows binaries. /releases/latest is not enough: llama.cpp's
    # semver releases (e.g. v0.6.0) hold only a nightly-tag pointer and no zips at all, so asking for "latest"
    # downloads nothing and the script fails with a bare WebException.
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30" `
        -Headers @{ "User-Agent" = "GameTranslatorV3" }
    foreach ($r in $rel) {
        if ($r.tag_name -notmatch '^b\d+') { continue }
        if (@($r.assets) | Where-Object { $_.name -like "*bin-win-$suffix-x64.zip" }) { $Tag = $r.tag_name; break }
    }
    if ($Tag -eq "") { throw "No release with Windows binaries was found; pass -Tag <bXXXX> manually." }
}
Write-Host "Release: $Tag    Backend: $Backend"

$assets = @("llama-$Tag-bin-win-$suffix-x64.zip")
if ($Backend -eq "cuda12") { $assets += "cudart-llama-bin-win-$suffix-x64.zip" }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
foreach ($assetName in $assets) {
    $assetUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$Tag/$assetName"
    Write-Host "Download: $assetUrl"
    $zip = Join-Path $env:TEMP $assetName
    Invoke-WebRequest -Uri $assetUrl -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $Dest -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
}

$server = Join-Path $Dest "llama-server.exe"
if (-not (Test-Path -LiteralPath $server)) { throw "llama-server.exe not found after extraction" }
Write-Host "OK: $server"
if ($Backend -eq "cuda12") {
    $cudart = @(Get-ChildItem -LiteralPath $Dest -Filter 'cudart64*.dll' -ErrorAction SilentlyContinue).Count
    if ($cudart -eq 0) { Write-Host "WARNING: no cudart64*.dll next to llama-server.exe - the CUDA build needs it." }
    else { Write-Host "CUDA runtime: $cudart cudart64*.dll present" }
}
Write-Host "Backend: $Backend (vulkan works on older NVIDIA/AMD/Intel GPUs; cuda12 requires sm_70+)"
