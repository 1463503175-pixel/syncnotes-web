@echo off
title Chen Dushan Notes
cd /d "%~dp0"
set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "APP=%~dp0server.js"

if not exist "%NODE%" (
  echo Node runtime not found:
  echo %NODE%
  pause
  exit /b 1
)

echo Starting Chen Dushan Notes...
echo.
"%NODE%" "%APP%"
pause
