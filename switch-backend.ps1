# Switch the llama.cpp backend between Vulkan and CUDA 12, from the command line.
#
# ASCII only: Windows PowerShell reads a .ps1 in the ANSI codepage, so a non-ASCII byte in this file would
# corrupt it (a Chinese path or message inside a script is enough to break the parser).
#
# The runtime keeps both builds in their own folders under the llama directory
# (llama\vulkan\llama-server.exe, llama\cuda12\llama-server.exe), so switching is one value in
# ui-settings.ini plus a restart of the model server. Nothing is downloaded here unless a build is missing.
#
#   .\switch-backend.ps1                 show the current backend and what is installed
#   .\switch-backend.ps1 -Backend cuda12 switch to the CUDA 12 build
#   .\switch-backend.ps1 -Backend vulkan switch back
param(
    [string]$Backend = "",
    [string]$IniPath = ""
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $IniPath) { $IniPath = Join-Path $root "ui-settings.ini" }

function Get-Backend([string]$ini) {
    if (-not (Test-Path -LiteralPath $ini)) { return "" }
    foreach ($line in Get-Content -LiteralPath $ini -Encoding UTF8) {
        if ($line -match '^\s*LlamaBackend\s*=\s*(.+)$') { return $matches[1].Trim() }
    }
    return ""
}

function Show-State {
    $cur = Get-Backend $IniPath
    if (-not $cur) { $cur = "(not set - the program uses vulkan)" }
    Write-Output ("settings file : " + $IniPath)
    Write-Output ("current       : " + $cur)
    foreach ($b in @('vulkan', 'cuda12')) {
        $dir = Join-Path (Join-Path $root 'llama') $b
        $exe = Join-Path $dir 'llama-server.exe'
        $state = if (Test-Path -LiteralPath $exe) { 'installed' } else { 'MISSING' }
        Write-Output ("  llama\" + $b + " : " + $state + "   " + $dir)
    }
    $flat = Join-Path (Join-Path $root 'llama') 'llama-server.exe'
    if (Test-Path -LiteralPath $flat) { Write-Output ("  llama\      : installed (single-build layout, still supported)") }
    Write-Output ""
    Write-Output "Vulkan works on GTX 10 series / AMD / Intel; CUDA 12 needs sm_70+ (RTX 20 series and newer)."
    Write-Output "Close the program before switching, or use the Backend button inside it."
}

if ($Backend -ne 'vulkan' -and $Backend -ne 'cuda12') {
    if ($Backend -ne '') { Write-Output ("unknown backend: " + $Backend) }
    Show-State
    Write-Output ""
    Write-Output "usage: .\switch-backend.ps1 -Backend vulkan|cuda12"
    exit 0
}

$exe = Join-Path (Join-Path (Join-Path $root 'llama') $Backend) 'llama-server.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Output ("[!] llama\" + $Backend + "\llama-server.exe is not installed yet.")
    Write-Output ("    download it with:  .\download-llama.ps1 -Dest .\llama\" + $Backend + " -Backend " + $Backend)
    Write-Output "    (or use the Backend button in the program, which downloads it for you)"
    exit 2
}

# Rewrite just that one line, leaving every other setting exactly as it was.
$lines = @()
if (Test-Path -LiteralPath $IniPath) { $lines = Get-Content -LiteralPath $IniPath -Encoding UTF8 }
$done = $false
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
    if ($line -match '^\s*LlamaBackend\s*=') { $out.Add('LlamaBackend=' + $Backend); $done = $true }
    else { $out.Add($line) }
}
if (-not $done) { $out.Add('LlamaBackend=' + $Backend) }
[System.IO.File]::WriteAllLines($IniPath, $out, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("[OK] backend set to " + $Backend)
Write-Output "     start the program and press the 启动模型 button (or the Backend button to restart it there)."
