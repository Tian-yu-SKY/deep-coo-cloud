@echo off
REM dsh-link bridge - uninstall login autostart (removes dsh-link-bridge.vbs from Startup folder).
REM Node resolution: node-path.txt > %DSH_NODE_PATH% > node from PATH.
setlocal
set "NODE="
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if not defined NODE if defined DSH_NODE_PATH set "NODE=%DSH_NODE_PATH%"
if not defined NODE set "NODE=node"
"%NODE%" "%~dp0tools\autostart.mjs" uninstall
if errorlevel 1 (
  echo [FAIL] uninstall failed
  exit /b 1
)
echo [OK] autostart uninstalled.
exit /b 0
