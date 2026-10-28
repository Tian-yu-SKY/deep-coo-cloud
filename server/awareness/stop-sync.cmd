@echo off
rem dsh-link awareness local-sync: stop background loop
set "NODE=node"
"%NODE%" "%~dp0local-sync.mjs" --stop
