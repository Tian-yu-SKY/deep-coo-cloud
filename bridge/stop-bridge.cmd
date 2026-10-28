@echo off
REM dsh-link bridge - stop supervisor + bridge (intentional stop; no auto-restart).
REM For a hidden start use start-bridge.vbs (bridge starts its supervisor automatically).
setlocal
cd /d "%~dp0"
set "NODE="
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if not defined NODE if defined DSH_NODE_PATH set "NODE=%DSH_NODE_PATH%"
if not defined NODE set "NODE=node"
"%NODE%" "%~dp0supervisor.mjs" --stop
exit /b %errorlevel%
