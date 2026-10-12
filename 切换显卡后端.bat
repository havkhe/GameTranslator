@echo off
rem Double-clickable wrapper for switch-backend.ps1: shows the current backend and lets you pick one.
rem
rem ASCII only: cmd.exe reads a .bat with the OEM code page, and a non-ASCII byte can split a line into two
rem commands. The menu text is deliberately plain for the same reason.
setlocal
set HERE=%~dp0
set PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
if not exist "%PS%" set PS=powershell.exe

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%switch-backend.ps1"
echo.
echo   [1] Vulkan    (GTX 10 series, AMD, Intel - the safe default)
echo   [2] CUDA 12   (needs RTX 20 series or newer)
echo   [3] do nothing
echo.
set /p CHOICE=Choose 1/2/3 and press Enter: 
if "%CHOICE%"=="1" "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%switch-backend.ps1" -Backend vulkan
if "%CHOICE%"=="2" "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%switch-backend.ps1" -Backend cuda12
if "%CHOICE%"=="3" echo Nothing changed.
echo.
pause
endlocal
