@echo off
REM dsh-link context-observer - stop the running observer (reads observer.lock pid).
REM Note: on Windows this is a hard stop; the lock file is cleaned up here, and a stale
REM lock left by other means is reclaimed automatically by the next start.
setlocal
set "NODE=node"
if not exist "%NODE%" (
  echo [FAIL] bundled node not found: %NODE%
  exit /b 1
)
"%NODE%" "%~dp0tools\stop.mjs"
exit /b %errorlevel%
