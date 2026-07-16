# Perch console probe - runs in a DISPOSABLE child process because console
# RPC (GetConsoleTitle on a busy/hung conhost) can block forever; the parent
# enforces a timeout and kills us if we hang.
#
# stdout line 1: the target console's title
# stdout line 2: the console window hwnd (0 for pseudo-consoles / hidden) -
#                lets the parent handle agents in plain conhost windows that
#                have no Windows Terminal tab at all.
# With -Marker: also stamps the marker title for ~900ms (parent watches which
# WT tab shows it) and restores.
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [string]$Marker = ''
)

$dll = Join-Path $env:LOCALAPPDATA 'AgentFocus\AgentFocusNative.dll'
if (-not (Test-Path -LiteralPath $dll)) { exit 2 }
Add-Type -Path $dll
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PK { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); }'
$out = [Console]::Out   # bind BEFORE detaching our console

[void][AgentFocus.ConsoleApi]::FreeConsole()
if (-not [AgentFocus.ConsoleApi]::AttachConsole([uint32]$TargetPid)) { exit 1 }
try {
    $sb = New-Object System.Text.StringBuilder(2048)
    [void][AgentFocus.ConsoleApi]::GetConsoleTitle($sb, 2048)
    $prev = $sb.ToString()
    $cw = [PK]::GetConsoleWindow()
    $cwOut = 0
    if ($cw -ne [IntPtr]::Zero -and [PK]::IsWindowVisible($cw)) { $cwOut = $cw.ToInt64() }
    $out.WriteLine($prev)
    $out.WriteLine([string]$cwOut)
    $out.Flush()
    if ($Marker.Length -gt 0) {
        [void][AgentFocus.ConsoleApi]::SetConsoleTitle($Marker)
        Start-Sleep -Milliseconds 900
        [void][AgentFocus.ConsoleApi]::SetConsoleTitle($prev)
    }
}
finally {
    [void][AgentFocus.ConsoleApi]::FreeConsole()
}
exit 0
