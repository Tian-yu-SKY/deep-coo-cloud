@echo off
REM dsh-link context-observer - install login autostart for the current user (no admin; no registry writes).
REM Puts one generated vbs into %%APPDATA%%\Microsoft\Windows\Start Menu\Programs\Startup
REM NOTE: delivered but NOT installed by T14; Lead decides when to enable it.
setlocal
set "NODE=node"
if not exist "%NODE%" (
  echo [FAIL] bundled node not found: %NODE%
  exit /b 1
)
"%NODE%" "%~dp0tools\autostart.mjs" install
if errorlevel 1 (
  echo [FAIL] install failed
  exit /b 1
)
echo [OK] autostart installed.
exit /b 0
