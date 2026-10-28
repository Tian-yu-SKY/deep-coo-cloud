@echo off
REM dsh-link context-observer - remove login autostart for the current user.
setlocal
set "NODE=node"
if not exist "%NODE%" (
  echo [FAIL] bundled node not found: %NODE%
  exit /b 1
)
"%NODE%" "%~dp0tools\autostart.mjs" uninstall
if errorlevel 1 (
  echo [FAIL] uninstall failed
  exit /b 1
)
exit /b 0
