@echo off
REM dsh-link context-observer - manual start with a visible console (debug).
REM Runs the observer in the foreground; Ctrl+C stops it.
setlocal
set "NODE=node"
if not exist "%NODE%" (
  echo [FAIL] bundled node not found: %NODE%
  exit /b 1
)
if not exist "%~dp0observer.mjs" (
  echo [FAIL] observer.mjs not found: %~dp0observer.mjs
  exit /b 1
)
cd /d "%~dp0"
"%NODE%" "%~dp0observer.mjs" --verbose %*
exit /b %errorlevel%
