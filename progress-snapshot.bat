@echo off
chcp 65001 >nul
title Translation Progress - snapshot
"D:\GameTranslator\node\node.exe" "D:\dsh\gt-audit\progress.js"
echo.
echo This is a snapshot. For live refresh use progress-live.bat .
pause
