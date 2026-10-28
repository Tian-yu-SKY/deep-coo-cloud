@echo off
rem dsh-link awareness local-sync: start hidden background loop
rem 需要 Node.js 在 PATH 中；或把下面 NODE 改成你的 node.exe 绝对路径
set "NODE=node"
"%NODE%" "%~dp0local-sync.mjs" --start
