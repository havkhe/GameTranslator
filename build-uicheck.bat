@echo off
rem Build the UI structural check (UiCheck.cs) into _uicheck.exe.
rem
rem Before this existed the check could only be built by an ad-hoc command that was not kept, so it
rem could not be re-run from the repository. This compiles the app's sources together with UiCheck.cs,
rem which owns its own Main entry point.
rem
rem   ui\Startup.cs   required   - MainForm calls Startup.Trace throughout
rem   ui\Program.cs   excluded   - it defines the application's Main
rem
rem ASCII only in this file: cmd.exe reads a .bat with the OEM code page, and any non-ASCII byte can
rem split a line into two commands.
rem
rem Run the result from the install root (the folder holding node\, tools\, pipeline\, work\):
rem UiCheck uses AppDomain.CurrentDomain.BaseDirectory as the root it hands to MainForm.
setlocal
set ROOT=%~dp0
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo [ERROR] csc.exe not found. Install .NET Framework 4.x.
  exit /b 1
)
set OUT=%ROOT%_uicheck.exe
if not "%~1"=="" set OUT=%~1
echo Compiling with %CSC%
"%CSC%" /nologo /target:exe /out:"%OUT%" ^
  /reference:System.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll ^
  /reference:System.IO.Compression.FileSystem.dll /reference:System.Management.dll ^
  "%ROOT%ui\UiCheck.cs" "%ROOT%ui\MainForm.cs" "%ROOT%ui\PipelineRunner.cs" "%ROOT%ui\Settings.cs" "%ROOT%ui\SimpleJson.cs" "%ROOT%ui\Startup.cs"
if errorlevel 1 (
  echo [ERROR] build failed
  exit /b 1
)
echo [OK] %OUT% built
endlocal
