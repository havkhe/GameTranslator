@echo off
rem Build GameTranslator v3 UI.
rem
rem Uses the .NET Framework compiler that ships with Windows, so no SDK and no
rem internet access are required. Note that ProcessStartInfo.ArgumentList is NOT
rem available here (it is a .NET Core API) — the code joins arguments by hand with
rem PipelineRunner.Quote for that reason.
setlocal
set ROOT=%~dp0
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo [ERROR] csc.exe not found. Install .NET Framework 4.x.
  exit /b 1
)
echo Compiling with %CSC%
"%CSC%" /nologo /target:winexe /out:"%ROOT%GameTranslatorV3.exe" ^
  /reference:System.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll ^
  "%ROOT%ui\Program.cs" "%ROOT%ui\MainForm.cs" "%ROOT%ui\PipelineRunner.cs" "%ROOT%ui\Settings.cs" "%ROOT%ui\SimpleJson.cs"
if errorlevel 1 (
  echo [ERROR] build failed
  exit /b 1
)
echo [OK] GameTranslatorV3.exe built
endlocal
