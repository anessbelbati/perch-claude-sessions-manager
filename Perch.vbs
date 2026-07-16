' Perch launcher - starts the widget with no console window.
' Path-relative: works from wherever the repo is cloned.
Dim fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("Wscript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File """ & dir & "\perch.ps1""", 0, False
