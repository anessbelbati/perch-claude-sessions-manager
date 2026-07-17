# Perch console probe - runs in a DISPOSABLE child process because console
# RPC (GetConsoleTitle on a busy/hung conhost) can block forever; the parent
# enforces a timeout and kills us if we hang.
#
# stdout line 1: the target console's title
# stdout line 2: the console window hwnd (0 for pseudo-consoles / hidden) -
#                lets the parent handle agents in plain conhost windows that
#                have no Windows Terminal tab at all.
# stdout line 3: the console's VISIBLE screen text, normalized to lowercase
#                letters+digits (single line, capped) - lets the parent match
#                a session to a WT tab by CONTENT via UIA TextPattern, which
#                works even for manually renamed tabs that ignore titles.
# stdout line 4: the conhost pid that OWNS this console (identity key: the
#                codex.exe launcher and its node TUI share one console, and
#                the parent must know they are the same session, not twins).
# With -Marker: also stamps the marker title for MarkerMs (parent watches
# which WT tab shows it) and restores.
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [string]$Marker = '',
    [int]$MarkerMs = 900
)

$dll = Join-Path $env:LOCALAPPDATA 'AgentFocus\AgentFocusNative.dll'
if (-not (Test-Path -LiteralPath $dll)) { exit 2 }
Add-Type -Path $dll
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PK {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
    [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct CSBI {
        public COORD dwSize; public COORD dwCursorPosition; public ushort wAttributes;
        public SMALL_RECT srWindow; public COORD dwMaximumWindowSize;
    }
    [DllImport("kernel32.dll")] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern bool ReadConsoleOutputCharacterW(IntPtr h, [Out] char[] buf, uint len, COORD coord, out uint read);
}
'@
$out = [Console]::Out   # bind BEFORE detaching our console

[void][AgentFocus.ConsoleApi]::FreeConsole()
if (-not [AgentFocus.ConsoleApi]::AttachConsole([uint32]$TargetPid)) { exit 1 }
try {
    $sb = New-Object System.Text.StringBuilder(2048)
    [void][AgentFocus.ConsoleApi]::GetConsoleTitle($sb, 2048)
    $prev = $sb.ToString()
    $cw = [PK]::GetConsoleWindow()
    $cwOut = 0
    $conPid = 0
    if ($cw -ne [IntPtr]::Zero) {
        # owner of the console window (real OR the ConPTY fake one) = the
        # conhost/OpenConsole hosting this console = stable session identity
        [uint32]$wp = 0
        [void][PK]::GetWindowThreadProcessId($cw, [ref]$wp)
        $conPid = [long]$wp
    }
    if ($cw -ne [IntPtr]::Zero -and [PK]::IsWindowVisible($cw)) {
        # ConPTY gives every WT tab a FAKE "PseudoConsoleWindow" that can still
        # report visible - only a REAL conhost window is a usable click target
        $csb = New-Object System.Text.StringBuilder(256)
        [void][PK]::GetClassName($cw, $csb, 256)
        if ($csb.ToString() -eq 'ConsoleWindowClass') { $cwOut = $cw.ToInt64() }
    }

    # visible screen text: the session's true fingerprint (titles can be
    # renamed away in WT; the CONTENT of the pane cannot)
    $screen = ''
    try {
        # 3221225472 = GENERIC_READ|GENERIC_WRITE (0xC0000000 parses as a
        # NEGATIVE Int32 literal in PowerShell 5.1 and breaks uint marshaling)
        $h = [PK]::CreateFileW('CONOUT$', [uint32]3221225472, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
        if ($h -ne [IntPtr]::Zero -and $h.ToInt64() -ne -1) {
            $info = New-Object PK+CSBI
            if ([PK]::GetConsoleScreenBufferInfo($h, [ref]$info)) {
                # ONE RPC for the whole viewport: reads wrap cell-to-cell
                # across rows. The old per-row loop made ~50 conhost round
                # trips per probe, and conhost serializes them against the
                # agent's own writes - probing was visibly slowing the TUIs.
                $w = [int]$info.dwSize.X
                $rows = [int]$info.srWindow.Bottom - [int]$info.srWindow.Top + 1
                $len = [Math]::Min($w * $rows, 16000)
                if ($len -gt 0) {
                    $buf = New-Object char[] $len
                    $coord = New-Object PK+COORD
                    $coord.X = 0; $coord.Y = [int16][int]$info.srWindow.Top
                    [uint32]$read = 0
                    if ([PK]::ReadConsoleOutputCharacterW($h, $buf, [uint32]$len, $coord, [ref]$read)) {
                        $screen = ((New-Object string($buf, 0, [int]$read)) -replace '[^\p{L}\p{Nd}]', '').ToLowerInvariant()
                        if ($screen.Length -gt 6000) { $screen = $screen.Substring(0, 6000) }
                    }
                }
            }
            [void][PK]::CloseHandle($h)
        }
    }
    catch { $screen = '' }

    $out.WriteLine($prev)
    $out.WriteLine([string]$cwOut)
    $out.WriteLine($screen)
    $out.WriteLine([string]$conPid)
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
