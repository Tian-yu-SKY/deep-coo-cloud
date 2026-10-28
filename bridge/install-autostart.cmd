@echo off
REM dsh-link bridge - install login autostart for current user (no admin; no registry writes).
REM Puts one generated vbs into %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
REM Node resolution: node-path.txt > %DSH_NODE_PATH% > node from PATH.
setlocal
set "NODE="
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if not defined NODE if defined DSH_NODE_PATH set "NODE=%DSH_NODE_PATH%"
if not defined NODE set "NODE=node"
"%NODE%" "%~dp0tools\autostart.mjs" install
if errorlevel 1 (
  echo [FAIL] install failed
  exit /b 1
)
echo [OK] autostart installed.
exit /b 0
