' dsh-link awareness local-sync: manual hidden start (loop, no console window)
' 需要 Node.js 在 PATH 中；若不在，把 "node" 换成本机 node.exe 的绝对路径
Set WShell = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
WShell.Run "node """ & scriptDir & "local-sync.mjs"" --loop", 0, False
