' Opens the Mandi POS Launcher as a desktop app.
' Two things this does that a plain shortcut to electron.exe cannot:
'   - clears ELECTRON_RUN_AS_NODE, which VS Code and Git Bash set to 1 and
'     which makes electron.exe start as plain Node with no window at all
'   - starts it with no console window flashing up
Option Explicit

Dim sh, fso, appDir, exePath
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = appDir & "\node_modules\electron\dist\electron.exe"

sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"

If Not fso.FileExists(exePath) Then
  MsgBox "Electron is not installed yet." & vbCrLf & vbCrLf & _
         "Run ""Start Launcher.bat"" once in:" & vbCrLf & appDir, _
         vbExclamation, "Mandi POS Launcher"
  WScript.Quit 1
End If

sh.CurrentDirectory = appDir
sh.Run """" & exePath & """ """ & appDir & """", 1, False
