@echo off
rem dsh-link awareness local-sync: remove login autostart
set "NODE=node"
"%NODE%" "%~dp0tools\autostart.mjs" uninstall
