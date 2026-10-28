@echo off
rem dsh-link awareness local-sync: install login autostart (does NOT start it now)
set "NODE=node"
"%NODE%" "%~dp0tools\autostart.mjs" install
