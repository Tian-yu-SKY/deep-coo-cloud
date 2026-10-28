@echo off
rem dsh-link awareness local-sync: status
set "NODE=node"
"%NODE%" "%~dp0local-sync.mjs" --status
