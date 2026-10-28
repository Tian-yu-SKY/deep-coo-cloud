' dsh-link context-observer - manual hidden start (no console window; cwd = this script's folder)
' Double-click to run the observer in the background.
' For a visible console (debug) use start-observer.cmd.
Option Explicit
Dim fso, shell, observerDir, nodeExe, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
observerDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "node"
If Not fso.FileExists(nodeExe) Then
  MsgBox "node.exe not found: " & nodeExe, 16, "dsh-link context-observer"
  WScript.Quit 1
End If
If Not fso.FileExists(observerDir & "\observer.mjs") Then
  MsgBox "observer.mjs not found: " & observerDir & "\observer.mjs", 16, "dsh-link context-observer"
  WScript.Quit 1
End If
shell.CurrentDirectory = observerDir
cmd = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & observerDir & "\observer.mjs" & Chr(34)
shell.Run cmd, 0, False
