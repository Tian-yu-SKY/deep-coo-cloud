@echo off
REM dsh-link bridge - manual foreground start (visible console, Ctrl+C to stop).
REM For hidden background use start-bridge.vbs, or install login autostart.
REM Node resolution: node-path.txt > %DSH_NODE_PATH% > node from PATH.
setlocal
cd /d "%~dp0"
set "NODE="
if exist "%~dp0node-path.txt" set /p NODE=<"%~dp0node-path.txt"
if not defined NODE if defined DSH_NODE_PATH set "NODE=%DSH_NODE_PATH%"
if not defined NODE set "NODE=node"
echo [dsh-link-bridge] starting server.mjs in foreground; Ctrl+C to stop
echo [dsh-link-bridge] for hidden background run start-bridge.vbs
echo [dsh-link-bridge] node: %NODE%
"%NODE%" server.mjs
exit /b %errorlevel%
