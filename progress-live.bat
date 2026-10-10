@echo off
chcp 65001 >nul
title Translation Progress - live (close this window to stop refreshing)
"D:\GameTranslator\node\node.exe" "D:\dsh\gt-audit\progress.js" --live
