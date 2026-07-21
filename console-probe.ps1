# Perch console probe - runs in a DISPOSABLE child process because console
# RPC (GetConsoleTitle on a busy/hung conhost) can block forever; the parent
# enforces a timeout and kills us if we hang.
#
# stdout line 1: the target console's title
# stdout line 2: the console window hwnd (0 for pseudo-consoles / hidden)
# stdout line 3: the console's VISIBLE screen text, normalized (content
#                fingerprint - works even for manually renamed tabs)
# stdout line 4: the conhost pid that OWNS this console (session identity)
# stdout line 5: the RAW visible rows, base64(UTF8) - punctuation, digits
#                and layout intact so the parent can PARSE pending prompts
#                (numbered permission menus). base64 = encoding-proof.
#                ONLY built when -Raw is passed: raw extraction is extra time
#                ATTACHED to the target console, and attached time on a BUSY
#                writing TUI is contention (the probe-contention law). Blocked
#                rows can afford it; rendering rows must never pay it.
#
# All P/Invoke comes precompiled from AgentFocusNative.dll - this child used
# to Add-Type inline C#, which spawned the C# COMPILER on every probe.
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [string]$Marker = '',
    [int]$MarkerMs = 900,
    [switch]$Raw
)

$dll = Join-Path $env:LOCALAPPDATA 'AgentFocus\AgentFocusNative.dll'
if (-not (Test-Path -LiteralPath $dll)) { exit 2 }
Add-Type -Path $dll
if (-not ('AgentFocus.ProbeKit' -as [type])) { exit 2 }   # stale dll: run install.ps1
$out = [Console]::Out   # bind BEFORE detaching our console

[void][AgentFocus.ConsoleApi]::FreeConsole()
if (-not [AgentFocus.ConsoleApi]::AttachConsole([uint32]$TargetPid)) { exit 1 }
try {
    $sb = New-Object System.Text.StringBuilder(2048)
    [void][AgentFocus.ConsoleApi]::GetConsoleTitle($sb, 2048)
    $prev = $sb.ToString()

    $cw = [AgentFocus.ProbeKit]::GetConsoleWindow()
    $cwOut = 0
    $conPid = 0
    if ($cw -ne [IntPtr]::Zero) {
        # owner of the console window (real OR the ConPTY fake one) = the
        # conhost/OpenConsole hosting this console = stable session identity
        [uint32]$wp = 0
        [void][AgentFocus.ProbeKit]::GetWindowThreadProcessId($cw, [ref]$wp)
        $conPid = [long]$wp
    }
    if ($cw -ne [IntPtr]::Zero -and [AgentFocus.ProbeKit]::IsWindowVisible($cw)) {
        # ConPTY gives every WT tab a FAKE "PseudoConsoleWindow" that can still
        # report visible - only a REAL conhost window is a usable click target
        $csb = New-Object System.Text.StringBuilder(256)
        [void][AgentFocus.ProbeKit]::GetClassName($cw, $csb, 256)
        if ($csb.ToString() -eq 'ConsoleWindowClass') { $cwOut = $cw.ToInt64() }
    }

    # visible screen text: the session's true fingerprint. ONE wrapped read -
    # per-row reads made ~50 conhost round-trips that contended with the
    # agent TUI's own rendering.
    $screen = ''
    $rawB64 = ''
    try {
        # 3221225472 = GENERIC_READ|GENERIC_WRITE (0xC0000000 parses as a
        # NEGATIVE Int32 literal in PowerShell 5.1 and breaks uint marshaling)
        $h = [AgentFocus.ProbeKit]::CreateFileW('CONOUT$', [uint32]3221225472, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
        if ($h -ne [IntPtr]::Zero -and $h.ToInt64() -ne -1) {
            $info = New-Object AgentFocus.ProbeKit+CSBI
            if ([AgentFocus.ProbeKit]::GetConsoleScreenBufferInfo($h, [ref]$info)) {
                $w = [int]$info.dwSize.X
                $rows = [int]$info.srWindow.Bottom - [int]$info.srWindow.Top + 1
                $len = [Math]::Min($w * $rows, 16000)
                if ($len -gt 0) {
                    $buf = New-Object char[] $len
                    $coord = New-Object AgentFocus.ProbeKit+COORD
                    $coord.X = 0; $coord.Y = [int16][int]$info.srWindow.Top
                    [uint32]$read = 0
                    if ([AgentFocus.ProbeKit]::ReadConsoleOutputCharacterW($h, $buf, [uint32]$len, $coord, [ref]$read)) {
                        $rawStr = New-Object string($buf, 0, [int]$read)
                        $screen = (($rawStr) -replace '[^\p{L}\p{Nd}]', '').ToLowerInvariant()
                        if ($screen.Length -gt 6000) { $screen = $screen.Substring(0, 6000) }
                        # raw rows, one per line, right-trimmed: the parent
                        # parses pending numbered prompts out of these.
                        # OPT-IN: plain fingerprint probes skip this work.
                        if ($Raw) {
                            # BOTTOM 30 rows only: the pending-prompt parser
                            # is bottom-anchored, and a full 200-col screen
                            # blows past the parent's 4KB stdout pipe buffer
                            $sbR = New-Object System.Text.StringBuilder
                            for ($i = [Math]::Max(0, $rows - 30); $i -lt $rows; $i++) {
                                $st = $i * $w
                                if ($st -ge $rawStr.Length) { break }
                                [void]$sbR.AppendLine($rawStr.Substring($st, [Math]::Min($w, $rawStr.Length - $st)).TrimEnd())
                            }
                            $rawB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($sbR.ToString()))
                        }
                    }
                }
            }
            [void][AgentFocus.ProbeKit]::CloseHandle($h)
        }
    }
    catch { $screen = '' }

    $out.WriteLine($prev)
    $out.WriteLine([string]$cwOut)
    $out.WriteLine($screen)
    $out.WriteLine([string]$conPid)
    $out.WriteLine($rawB64)
    $out.Flush()
    if ($Marker.Length -gt 0) {
        [void][AgentFocus.ConsoleApi]::SetConsoleTitle($Marker)
        Start-Sleep -Milliseconds $MarkerMs
        [void][AgentFocus.ConsoleApi]::SetConsoleTitle($prev)
    }
}
finally {
    [void][AgentFocus.ConsoleApi]::FreeConsole()
}
exit 0
