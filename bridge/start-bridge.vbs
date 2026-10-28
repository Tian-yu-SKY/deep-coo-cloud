' dsh-link bridge - manual hidden start (no window; cwd = this script's folder)
' Double-click to run in background. For a visible console use start-bridge.cmd.
'
' Node resolution order:
'   1) node-path.txt in this folder (one line: absolute path to node.exe)
'   2) %DSH_NODE_PATH% environment variable
'   3) node.exe from PATH
Option Explicit
Dim fso, shell, bridgeDir, nodeExe, cmd, rc, nodePathFile, ts, resolved

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
bridgeDir = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe = ""
nodePathFile = bridgeDir & "\node-path.txt"
If fso.FileExists(nodePathFile) Then
  On Error Resume Next
  Set ts = fso.OpenTextFile(nodePathFile, 1)
  If Err.Number = 0 Then
    resolved = Trim(ts.ReadAll)
    ts.Close
    If resolved <> "" Then nodeExe = resolved
  End If
  On Error GoTo 0
End If
If nodeExe = "" Then
  resolved = shell.ExpandEnvironmentStrings("%DSH_NODE_PATH%")
  If resolved <> "%DSH_NODE_PATH%" Then nodeExe = resolved
End If
If nodeExe = "" Then nodeExe = "node.exe"

If Not fso.FileExists(bridgeDir & "\server.mjs") Then
  MsgBox "server.mjs not found in " & bridgeDir, 16, "dsh-link bridge"
  WScript.Quit 1
End If

If LCase(nodeExe) = "node.exe" Then
  rc = shell.Run("cmd /c where node >nul 2>nul", 0, True)
  If rc <> 0 Then
    MsgBox "Node.js not found." & vbCrLf & vbCrLf & _
      "Install Node.js, or create node-path.txt with the absolute path to node.exe," & vbCrLf & _
      "or set the DSH_NODE_PATH environment variable.", 16, "dsh-link bridge"
    WScript.Quit 1
  End If
ElseIf Not fso.FileExists(nodeExe) Then
  MsgBox "node.exe not found: " & nodeExe & vbCrLf & _
    "Fix node-path.txt / DSH_NODE_PATH, or remove node-path.txt to use node from PATH.", 16, "dsh-link bridge"
  WScript.Quit 1
End If

shell.CurrentDirectory = bridgeDir
cmd = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & bridgeDir & "\server.mjs" & Chr(34)
shell.Run cmd, 0, False
