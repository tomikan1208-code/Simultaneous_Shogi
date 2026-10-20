Option Explicit
Dim shell, fso, base, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = fso.GetParentFolderName(base)
result = shell.Run("node """ & base & "\launcher.mjs""", 0, True)
If result <> 0 Then MsgBox "Could not open AI Training Panel. See .cache\dashboard\launcher.log. Node.js and Chrome/Edge are required.", 48, "AI Training Panel"
