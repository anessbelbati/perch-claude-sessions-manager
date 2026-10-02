' Perch Desk launcher - opens the window with no console window behind it.
' Path-relative: works from wherever the repo is cloned.
' Anything passed to this script is passed on to the window, for example
' --inactive (appear without taking the keyboard).
Dim fso, dir, extra, i
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
extra = ""
For i = 0 To WScript.Arguments.Count - 1
    extra = extra & " " & WScript.Arguments(i)
Next
CreateObject("Wscript.Shell").Run """" & dir & "\node_modules\electron\dist\electron.exe"" """ & dir & """" & extra, 1, False
