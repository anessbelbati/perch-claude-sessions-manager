# Perch console probe - runs in a DISPOSABLE child process because console
# RPC (GetConsoleTitle on a busy/hung conhost) can block forever; the parent
# enforces a timeout and kills us if we hang.
#
# Prints the target console's title to stdout. With -Marker, also stamps the
# marker title for ~900ms (parent watches which WT tab shows it) and restores.
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [string]$Marker = ''
)

$dll = Join-Path $env:LOCALAPPDATA 'AgentFocus\AgentFocusNative.dll'
if (-not (Test-Path -LiteralPath $dll)) { exit 2 }
Add-Type -Path $dll
$out = [Console]::Out   # bind BEFORE detaching our console

[void][AgentFocus.ConsoleApi]::FreeConsole()
if (-not [AgentFocus.ConsoleApi]::AttachConsole([uint32]$TargetPid)) { exit 1 }
try {
    $sb = New-Object System.Text.StringBuilder(2048)
    [void][AgentFocus.ConsoleApi]::GetConsoleTitle($sb, 2048)
    $prev = $sb.ToString()
    $out.WriteLine($prev)
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
