Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strPath = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strPath
exePath = strPath & "\dist\BossFreeForm\BossFreeForm.exe"
If fso.FileExists(exePath) Then
  WshShell.Run """" & exePath & """", 1, False
Else
  WshShell.Run "cmd /c npx electron .", 0, False
End If
Set fso = Nothing
Set WshShell = Nothing
