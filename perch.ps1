<#
    Claude HUD v2 - tiny always-on-top viewer for live Claude Code sessions.

    Reads AgentFocus status files (written by Claude Code hooks) and shows one
    row per live session: glowing status dot + project folder + status + age.
      - left-click a row   -> focuses its Windows Terminal window AND selects its tab
      - right-click a row  -> hides it until its status changes again
      - drag the header    -> move the widget (position is remembered)
      - pin button         -> toggle always-on-top

    Usage:
      powershell -NoProfile -ExecutionPolicy Bypass -STA -File hud.ps1
      powershell -NoProfile -ExecutionPolicy Bypass -File hud.ps1 -Probe   # console dump, no UI
#>
param([switch]$Probe)

$ErrorActionPreference = 'Continue'

# log unexpected errors so a hidden-window launch is debuggable.
# IMPORTANT: continue, don't break - WPF reentrancy (menus, nested message
# pumps) can stop a running pipeline (PipelineStoppedException) and that must
# never kill the whole HUD.
trap {
    try {
        "$(Get-Date -Format s)  $($_ | Out-String)" |
            Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-error.log')
    }
    catch { }
    continue
}

$AgentFocusDir = Join-Path $env:LOCALAPPDATA 'AgentFocus'
$StatusDir     = Join-Path $AgentFocusDir 'status'
$CfgPath       = Join-Path $AgentFocusDir 'settings.json'
$StatePath     = Join-Path $PSScriptRoot 'hud-state.json'
$PrefsPath     = Join-Path $PSScriptRoot 'hud-prefs.json'
$ProgressPreference = 'SilentlyContinue'

# ---------- config ----------
$RefreshSeconds = 2
$HideAfterFocus = $false
$AgentProcNames = @('claude', 'codex', 'gemini', 'opencode', 'aider')
$script:ChirpOn = $false
$script:ChirpVolume = 10   # percent - birds are for noticing, not startling
$script:ShowTimers = $true
$script:ThemeName = 'midnight'   # 'midnight' (classic dark) or 'glass' (liquid acrylic)
try {
    if (Test-Path -LiteralPath $CfgPath) {
        $cfg = Get-Content -LiteralPath $CfgPath -Raw | ConvertFrom-Json
        if ($cfg.RefreshSeconds) { $RefreshSeconds = [int]$cfg.RefreshSeconds }
        if ($null -ne $cfg.PSObject.Properties['HideAfterFocus']) { $HideAfterFocus = [bool]$cfg.HideAfterFocus }
        if ($null -ne $cfg.PSObject.Properties['ChirpOnAttention']) { $script:ChirpOn = [bool]$cfg.ChirpOnAttention }
        if ($null -ne $cfg.PSObject.Properties['ChirpVolume']) { $script:ChirpVolume = [int]$cfg.ChirpVolume }
        if ($null -ne $cfg.PSObject.Properties['ShowWorkTimers']) { $script:ShowTimers = [bool]$cfg.ShowWorkTimers }
        if ($null -ne $cfg.PSObject.Properties['ThemeName']) { $script:ThemeName = [string]$cfg.ThemeName }
        if ($cfg.PSObject.Properties['AgentProcessNames'] -and $cfg.AgentProcessNames) {
            $AgentProcNames = @($cfg.AgentProcessNames | ForEach-Object { [string]$_ })
        }
    }
}
catch { }
# processes that count as "an agent CLI" for liveness + untracked discovery
$script:AgentProcRegex = '^(' + ((@($AgentProcNames) + @('node', 'bun', 'deno', 'python')) -join '|') + ')'

# real backdrop blur for the glass theme: undocumented-but-ubiquitous
# SetWindowCompositionAttribute acrylic + Win11 DWM rounded corners
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace ClaudeHud {
    public static class Glass {
        [StructLayout(LayoutKind.Sequential)]
        private struct AccentPolicy { public int AccentState; public int AccentFlags; public uint GradientColor; public int AnimationId; }
        [StructLayout(LayoutKind.Sequential)]
        private struct CompData { public int Attribute; public IntPtr Data; public int SizeOfData; }

        [DllImport("user32.dll")]
        private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref CompData data);
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        public static void SetAcrylic(IntPtr hwnd, bool on, uint tintABGR) {
            var accent = new AccentPolicy();
            accent.AccentState = on ? 4 : 0;        // ACCENT_ENABLE_ACRYLICBLURBEHIND / DISABLED
            accent.AccentFlags = 2;
            accent.GradientColor = tintABGR;        // AABBGGRR
            int sz = Marshal.SizeOf(accent);
            IntPtr ptr = Marshal.AllocHGlobal(sz);
            try {
                Marshal.StructureToPtr(accent, ptr, false);
                var data = new CompData { Attribute = 19, Data = ptr, SizeOfData = sz };   // WCA_ACCENT_POLICY
                SetWindowCompositionAttribute(hwnd, ref data);
            }
            finally { Marshal.FreeHGlobal(ptr); }
        }

        public static void SetRoundCorners(IntPtr hwnd, bool round) {
            int pref = round ? 2 : 0;               // DWMWCP_ROUND / DEFAULT (Win11; no-op on Win10)
            DwmSetWindowAttribute(hwnd, 33, ref pref, 4);
        }
    }
}
"@

# ---------- native + UIA ----------
if (-not ("ClaudeHud.Native" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;

namespace ClaudeHud {
    [StructLayout(LayoutKind.Sequential)]
    public struct FLASHWINFO {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    public static class Windows {
        public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int count);

        public static string GetTitle(IntPtr hWnd) {
            var sb = new System.Text.StringBuilder(512);
            GetWindowText(hWnd, sb, sb.Capacity);
            return sb.ToString();
        }

        // ALL visible top-level windows of a process. Windows Terminal hosts
        // every window in ONE process, so Process.MainWindowHandle misses all
        // but one of them.
        public static System.Collections.Generic.List<long> TopLevelForProcess(uint pid) {
            var list = new System.Collections.Generic.List<long>();
            EnumWindows((h, l) => {
                uint wpid;
                GetWindowThreadProcessId(h, out wpid);
                if (wpid == pid && IsWindowVisible(h)) { list.Add(h.ToInt64()); }
                return true;
            }, IntPtr.Zero);
            return list;
        }
    }

    public static class Native {
        [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
        public static void Flash(IntPtr hwnd, uint count) {
            FLASHWINFO fi = new FLASHWINFO();
            fi.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
            fi.hwnd = hwnd;
            fi.dwFlags = 3; // FLASHW_CAPTION | FLASHW_TRAY
            fi.uCount = count;
            fi.dwTimeout = 0;
            FlashWindowEx(ref fi);
        }
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("shell32.dll", SetLastError = true)] public static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string AppID);
    }
}
"@
}
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes  -ErrorAction SilentlyContinue

# ---------- session model ----------
$script:StatusMeta = @{
    'attention' = @{ Rank = 0; Color = '#FF6B6B'; Label = 'needs you' }
    'error'     = @{ Rank = 1; Color = '#FF6B6B'; Label = 'failed'    }
    'working'   = @{ Rank = 2; Color = '#FFB84D'; Label = 'working'   }
    'idle'      = @{ Rank = 3; Color = '#5ED584'; Label = 'done'      }
    'quiet'     = @{ Rank = 4; Color = '#8FA0C8'; Label = 'quiet'     }
}

function Get-StatusMeta([string]$Status) {
    if ($script:StatusMeta.ContainsKey($Status)) { return $script:StatusMeta[$Status] }
    return @{ Rank = 4; Color = '#71717A'; Label = $Status }
}

function Format-Age([datetime]$Ts) {
    $span = (Get-Date) - $Ts
    if ($span.TotalSeconds -lt 60) { return 'now' }
    if ($span.TotalMinutes -lt 60) { return ('{0}m' -f [int][math]::Floor($span.TotalMinutes)) }
    if ($span.TotalHours -lt 24)   { return ('{0}h' -f [int][math]::Floor($span.TotalHours)) }
    return ('{0}d' -f [int][math]::Floor($span.TotalDays))
}

function Get-Sessions {
    $now = Get-Date
    # follow-the-process learning: map agents to tabs from whatever tab the
    # user happens to have open right now (works on renamed tabs too)
    try { Invoke-PassiveTabLearn } catch { }
    $sessions = New-Object System.Collections.ArrayList
    $files = Get-ChildItem -LiteralPath $StatusDir -Filter '*.json' -ErrorAction SilentlyContinue |
             Where-Object { $_.LastWriteTime -gt $now.AddDays(-7) }
    foreach ($f in $files) {
        $s = $null
        try { $s = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch { continue }
        if ($null -eq $s) { continue }

        $status = [string]$s.status
        if ($status -eq 'ended' -or [string]::IsNullOrWhiteSpace($status)) { continue }

        # liveness: prefer the recorded agent pid, fall back to file freshness.
        # (files with no pid are pre-upgrade relics; every live session gains a
        # pid on its first hook event, so the freshness window can be short)
        $agentPid = 0
        $proc = $null
        if ($null -ne $s.PSObject.Properties['agent_pid']) { $agentPid = [int]$s.agent_pid }
        if ($agentPid -gt 0) {
            $proc = Get-Process -Id $agentPid -ErrorAction SilentlyContinue
            if ($null -eq $proc -or $proc.ProcessName -notmatch $script:AgentProcRegex) { continue }
        }
        elseif ($f.LastWriteTime -lt $now.AddMinutes(-30)) { continue }

        # sessions without a usable tab id (headless-flagged: second WT window
        # or manually RENAMED tabs blind the hook's marker trick; or hint-less:
        # capture keeps failing) go through our own resolver - which also feeds
        # the passive learner with their console titles. When even that fails,
        # only hide the session if its process ancestry says subagent - hiding
        # a real session is the worst failure mode.
        $isHeadless = ($null -ne $s.PSObject.Properties['headless'] -and [bool]$s.headless)
        $hasRid = ($null -ne $s.window -and
                   $null -ne $s.window.PSObject.Properties['tab_runtime_id'] -and
                   -not [string]::IsNullOrWhiteSpace([string]$s.window.tab_runtime_id))
        if ($hasRid -and $script:PoisonedRids.ContainsKey("$agentPid|$([string]$s.window.tab_runtime_id)")) {
            # this exact file hint lost a same-tab conflict before: a lie once,
            # a lie every tick (hooks only recapture on session start/prompt)
            $s.window = $null
            $hasRid = $false
        }
        if ($isHeadless -or -not $hasRid) {
            $rescueTab = $null
            if ($null -ne $proc) {
                $rescueTab = Resolve-TabForPid -TargetPid $agentPid -Proc $proc -CwdName ([string]$s.cwd_name)
            }
            if ($null -ne $rescueTab) {
                $s | Add-Member -NotePropertyName window -NotePropertyValue ([pscustomobject]@{
                    hwnd           = [long]$rescueTab.Hwnd
                    tab_runtime_id = $rescueTab.Rid
                    tab_name       = $rescueTab.Name
                    tab_index      = $rescueTab.Index
                    captured_event = 'hud-rescue+console'
                }) -Force
            }
            elseif ($isHeadless) {
                if ($null -eq $proc -or (Test-IsSubagentProc -TargetPid $agentPid)) { continue }
                # interactive session in a tab we can't identify yet (renamed
                # to something arbitrary): keep it visible window-less - the
                # passive learner or a click-time cycle will pin it later
                $s | Add-Member -NotePropertyName window -NotePropertyValue $null -Force
            }
            # hint-less but not headless-flagged: keep whatever window the
            # status file had (name matching may still work at click time)
        }

        $ts = $f.LastWriteTime
        try {
            $ts = ([datetime]::Parse([string]$s.timestamp, $null,
                   [System.Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime()
        }
        catch { }

        $name = [string]$s.cwd_name
        if ([string]::IsNullOrWhiteSpace($name)) { $name = '(unknown)' }

        $msg = [string]$s.message
        if ($msg.Length -gt 400) { $msg = $msg.Substring(0, 400) + '...' }

        [void]$sessions.Add([pscustomobject]@{
            Id       = [string]$s.session_id
            Provider = [string]$s.provider
            Status   = $status
            CwdName  = $name
            Cwd      = [string]$s.cwd
            Message  = $msg
            Ts       = $ts
            AgentPid = $agentPid
            Window   = $s.window
            Rank     = (Get-StatusMeta $status).Rank
        })
    }

    # dedupe: one agent process = one session row (newest file wins; covers
    # /clear and restarted conversations that leave older files behind)
    $seenPid = @{}
    $kept = New-Object System.Collections.ArrayList
    foreach ($s in @($sessions | Sort-Object -Property Ts -Descending)) {
        if ($s.AgentPid -gt 0) {
            if ($seenPid.ContainsKey($s.AgentPid)) { continue }
            $seenPid[$s.AgentPid] = $true
        }
        [void]$kept.Add($s)
    }

    # add live agent processes that have NO usable status file (sessions from
    # before the hooks, codex, gemini, ...): identified via console titles
    foreach ($u in @(Get-UntrackedSessions -Tracked $kept)) {
        if ($seenPid.ContainsKey([int]$u.AgentPid)) { continue }

        # LIVE status from the current tab/window title (untracked agents have
        # no hooks, but a leading spinner glyph in the title means working)
        $liveName = ''
        $urid = [string]$u.Window.tab_runtime_id
        if ($urid.Length -gt 0) {
            foreach ($tb in @(Get-AllTerminalTabs)) {
                if ($tb.Rid -eq $urid) { $liveName = [string]$tb.Name; break }
            }
        }
        elseif ([long]$u.Window.hwnd -gt 0) {
            try { $liveName = [ClaudeHud.Windows]::GetTitle([IntPtr][long]$u.Window.hwnd) } catch { }
        }
        if ($liveName.Length -gt 0) {
            $u.Window | Add-Member -NotePropertyName tab_name -NotePropertyValue $liveName -Force
            $inferred = Get-InferredAgentStatus $liveName
            $u | Add-Member -NotePropertyName Status -NotePropertyValue $inferred -Force
            $u | Add-Member -NotePropertyName Rank -NotePropertyValue ((Get-StatusMeta $inferred).Rank) -Force
            # keep the row NAME live too: it was snapshotted from whatever the
            # title said at first resolve, which goes stale/wrong within minutes
            $dn = Get-NormalizedTabName $liveName
            if ($dn.Length -gt 34) { $dn = $dn.Substring(0, 34) }
            if ($dn.Length -gt 0) { $u | Add-Member -NotePropertyName CwdName -NotePropertyValue $dn -Force }
        }
        [void]$kept.Add($u)
    }

    # self-heal wrong pins: two rows claiming the SAME tab means at least one
    # mapping is a lie (batch-restarted twins once cross-captured each other),
    # and there is no way to tell which from stored hints alone. Unpin ALL of
    # them - the marker-first resolver re-derives ownership-proven mappings
    # within a tick or two.
    $byRid = @{}
    foreach ($s in $kept) {
        if ($null -eq $s.Window -or -not $s.Window.PSObject.Properties['tab_runtime_id']) { continue }
        $r = [string]$s.Window.tab_runtime_id
        if ($r.Length -eq 0) { continue }
        if (-not $byRid.ContainsKey($r)) { $byRid[$r] = New-Object System.Collections.ArrayList }
        [void]$byRid[$r].Add($s)
    }
    foreach ($r in @($byRid.Keys)) {
        $rows = $byRid[$r]
        if ($rows.Count -lt 2) { continue }
        foreach ($row in @($rows)) {
            $row.Window = $null
            if ($row.AgentPid -gt 0) {
                $script:PoisonedRids["$($row.AgentPid)|$r"] = $true
                [void]$script:UntrackedTabMap.Remove([int]$row.AgentPid)
                [void]$script:NoTabStamp.Remove([int]$row.AgentPid)
            }
        }
    }

    # remember which tabs are spoken for (feeds the passive learner's
    # never-steal-a-claimed-tab guard next tick)
    $script:KnownRidClaims = @{}
    foreach ($s in $kept) {
        if ($null -eq $s.Window -or -not $s.Window.PSObject.Properties['tab_runtime_id']) { continue }
        $r = [string]$s.Window.tab_runtime_id
        if ($r.Length -gt 0) { $script:KnownRidClaims[$r] = [int]$s.AgentPid }
    }

    # apply user prefs: custom names + pinned-to-top
    foreach ($s in $kept) {
        $display = $s.CwdName
        $pinned = $false
        $key = Get-PrefKey $s
        if ($script:Prefs.ContainsKey($key)) {
            $e = $script:Prefs[$key]
            if ($null -ne $e.PSObject.Properties['name'] -and
                -not [string]::IsNullOrWhiteSpace([string]$e.name)) { $display = [string]$e.name }
            if ($null -ne $e.PSObject.Properties['pinned']) { $pinned = [bool]$e.pinned }
        }
        $s | Add-Member -NotePropertyName DisplayName -NotePropertyValue $display -Force
        $s | Add-Member -NotePropertyName Pinned -NotePropertyValue $pinned -Force
    }

    return @($kept | Sort-Object -Property @{ Expression = 'Pinned'; Descending = $true },
                                           Rank,
                                           @{ Expression = 'Ts'; Descending = $true })
}

# ---------- prefs (rename / pin) ----------
$script:Prefs = @{}
function Load-Prefs {
    $script:Prefs = @{}
    try {
        if (Test-Path -LiteralPath $PrefsPath) {
            $obj = Get-Content -LiteralPath $PrefsPath -Raw | ConvertFrom-Json
            foreach ($p in $obj.PSObject.Properties) { $script:Prefs[$p.Name] = $p.Value }
        }
    }
    catch { }
}

function Save-Prefs {
    try {
        $out = @{}
        foreach ($k in $script:Prefs.Keys) { $out[$k] = $script:Prefs[$k] }
        $out | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $PrefsPath -Encoding UTF8
    }
    catch { }
}

function Get-PrefKey($Sess) {
    # key by project path so renames/pins survive session restarts in a folder
    if (-not [string]::IsNullOrWhiteSpace($Sess.Cwd)) { return $Sess.Cwd.ToLowerInvariant() }
    return ('name:' + $Sess.CwdName.ToLowerInvariant())
}

function Set-Pref($Sess, [string]$Field, $Value) {
    $key = Get-PrefKey $Sess
    $entry = $null
    if ($script:Prefs.ContainsKey($key)) { $entry = $script:Prefs[$key] }
    if ($null -eq $entry) { $entry = [pscustomobject]@{ name = ''; pinned = $false } }
    if ($null -eq $entry.PSObject.Properties['name'])   { $entry | Add-Member -NotePropertyName name   -NotePropertyValue '' }
    if ($null -eq $entry.PSObject.Properties['pinned']) { $entry | Add-Member -NotePropertyName pinned -NotePropertyValue $false }
    $entry.$Field = $Value
    $script:Prefs[$key] = $entry
    Save-Prefs
}

# ---------- untracked claude scan ----------
function Ensure-ConsoleApi {
    if ("AgentFocus.ConsoleApi" -as [type]) { return $true }
    $dll = Join-Path $env:LOCALAPPDATA 'AgentFocus\AgentFocusNative.dll'
    if (Test-Path -LiteralPath $dll) {
        try { Add-Type -Path $dll -ErrorAction Stop; return $true } catch { }
    }
    return $false
}

function Test-ProcSuspended($Proc) {
    # NEVER touch a suspended process's console: its console server can't
    # answer and GetConsoleTitle blocks forever (agent-team workers are
    # routinely suspended) - this once froze the whole HUD
    $suspended = $true
    try {
        foreach ($t in $Proc.Threads) {
            if ($t.ThreadState -ne 'Wait' -or $t.WaitReason -ne 'Suspended') { $suspended = $false; break }
        }
    }
    catch { $suspended = $false }
    return $suspended
}

function Start-ConsoleProbe {
    # console RPC can hang FOREVER on a hosed conhost (observed live: one
    # agent process froze a probe for 2 minutes). Never attach from the HUD
    # process - spawn a disposable child that the caller can kill.
    param([int]$TargetPid, [string]$Marker = '', [int]$MarkerMs = 900)

    $probe = Join-Path $PSScriptRoot 'console-probe.ps1'
    if (-not (Test-Path -LiteralPath $probe)) { return $null }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$probe`" -TargetPid $TargetPid" +
                     $(if ($Marker.Length -gt 0) { " -Marker `"$Marker`" -MarkerMs $MarkerMs" } else { '' })
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.CreateNoWindow = $true
    try { return [System.Diagnostics.Process]::Start($psi) } catch { return $null }
}

function Read-ConsoleInfoBounded {
    # returns @{ Title; ConsoleHwnd } of a process's console, or $null.
    # Never blocks longer than ~2.5s (probe child gets killed).
    param([int]$TargetPid)

    $p = Start-ConsoleProbe -TargetPid $TargetPid
    if ($null -eq $p) { return $null }
    try {
        if (-not $p.WaitForExit(3000)) {
            try { $p.Kill() } catch { }
            return $null
        }
        if ($p.ExitCode -ne 0) { return $null }
        $title = $p.StandardOutput.ReadLine()
        [long]$hwnd = 0
        $hwndLine = $p.StandardOutput.ReadLine()
        if ($null -ne $hwndLine) { [void][long]::TryParse($hwndLine.Trim(), [ref]$hwnd) }
        $screen = $p.StandardOutput.ReadLine()
        if ($null -eq $screen) { $screen = '' }
        [long]$conPid = 0
        $conLine = $p.StandardOutput.ReadLine()
        if ($null -ne $conLine) { [void][long]::TryParse($conLine.Trim(), [ref]$conPid) }
        return [pscustomobject]@{ Title = $title; ConsoleHwnd = $hwnd; Screen = [string]$screen; ConsoleId = $conPid }
    }
    catch { return $null }
    finally { try { $p.Dispose() } catch { } }
}

# (a marker-title dance used to live here: stamp a unique title on the
# agent's console, watch which tab shows it. TRUE ownership proof - except
# ConPTY never propagates externally-set titles to WT tabs, verified live,
# so it never fired. Content matching via Resolve-TabByCycle is its heir.)

$script:UntrackedTabMap = @{}   # pid -> resolved tab rid (positive cache: dance runs once per process)
$script:WinOnlyMap = @{}        # pid -> console window hwnd (agents in plain conhost windows, no WT tab)
$script:NoTabStamp = @{}        # pid -> last time resolution failed (negative cache, 5 min TTL)
$script:ProbeBudget = 4         # console probes allowed this tick (reset in Update-List)
$script:LastScreenMap = @{}     # pid -> last probed console SCREEN text (fuel for the passive learner)
$script:KnownRidClaims = @{}    # rid -> pid for EVERY row perch showed last tick (hook-captured included)
$script:PoisonedRids = @{}      # "pid|rid" -> true: file hints that lost a conflict; never trust them again
$script:CycleFailStamp = @{}    # pid -> last time the click-time tab walk found nothing (30s cooldown)
$script:LastTitleByPid = @{}    # pid -> last probed console title (twin-clash detection)
$script:ConsoleIdByPid = @{}    # pid -> conhost pid owning its console (same console = same session)

function Invoke-PassiveTabLearn {
    # follow the PROCESS, not names: whatever tab the user has open exposes
    # its rendered text via UIA. If it content-matches the probed console
    # screen of ONE unmapped agent DECISIVELY (high score + clear margin over
    # every other unmapped agent), that selected tab IS the agent's tab - pin
    # pid -> rid without stamping or guessing. Tabs already claimed by any
    # known session are never up for grabs: pinning a session onto its twin's
    # tab is exactly the bug this guard exists for.
    $unmapped = $false
    foreach ($apid in @($script:LastScreenMap.Keys)) {
        if (-not $script:UntrackedTabMap.ContainsKey($apid)) { $unmapped = $true; break }
    }
    if (-not $unmapped) { return }
    $tabs = @(Get-AllTerminalTabs)
    if ($tabs.Count -eq 0) { return }

    # keep candidate screens FRESH: agents redraw constantly, so a stale
    # fingerprint never matches the live pane and the learner goes blind -
    # forcing the (visible) click-time tab walk to do the job instead
    foreach ($apid in @($script:LastScreenMap.Keys)) {
        if ($script:UntrackedTabMap.ContainsKey($apid)) { continue }
        if ($null -eq (Get-Process -Id $apid -ErrorAction SilentlyContinue)) {
            [void]$script:LastScreenMap.Remove($apid)
            continue
        }
        $entry = $script:LastScreenMap[$apid]
        if (((Get-Date) - $entry.Stamp).TotalSeconds -lt 30) { continue }
        if ($script:ProbeBudget -le 0) { break }
        $script:ProbeBudget--
        $fresh = Read-ConsoleInfoBounded -TargetPid $apid
        if ($null -ne $fresh) {
            $script:LastTitleByPid[$apid] = [string]$fresh.Title
            if ([long]$fresh.ConsoleId -gt 0) { $script:ConsoleIdByPid[$apid] = [long]$fresh.ConsoleId }
        }
        if ($null -ne $fresh -and ([string]$fresh.Screen).Length -ge 200) {
            $script:LastScreenMap[$apid] = @{ Text = [string]$fresh.Screen; Stamp = (Get-Date) }
        }
        else { $entry.Stamp = (Get-Date) }   # don't hammer a mute console
    }

    $claimed = @{}
    foreach ($v in $script:UntrackedTabMap.Values) { $claimed[[string]$v] = $true }
    foreach ($r in $script:KnownRidClaims.Keys) { $claimed[[string]$r] = $true }

    $seenHwnd = @{}
    foreach ($tb in $tabs) {
        if (-not $tb.Selected -or $tb.Rid.Length -eq 0) { continue }
        $hk = [string][long]$tb.Hwnd
        if ($seenHwnd.ContainsKey($hk)) { continue }
        $seenHwnd[$hk] = $true
        if ($claimed.ContainsKey($tb.Rid)) { continue }

        $paneText = Get-ActiveTermText -Hwnd $tb.Hwnd
        if ($paneText.Length -lt 200) { continue }
        $best = $null; $bestScore = 0; $second = 0
        foreach ($apid in @($script:LastScreenMap.Keys)) {
            if ($script:UntrackedTabMap.ContainsKey($apid)) { continue }
            $sc = Get-ScreenMatchScore -S ([string]$script:LastScreenMap[$apid].Text) -T $paneText
            if ($sc -gt $bestScore) { $second = $bestScore; $bestScore = $sc; $best = $apid }
            elseif ($sc -gt $second) { $second = $sc }
        }
        if ($null -ne $best -and $bestScore -ge 6 -and ($bestScore - $second) -ge 2) {
            $script:UntrackedTabMap[$best] = $tb.Rid
            $claimed[$tb.Rid] = $true
            [void]$script:NoTabStamp.Remove($best)
        }
    }
}

function Resolve-TabByCycle {
    # Deterministic CLICK-TIME resolution for tabs nothing else can correlate
    # (renamed to something arbitrary): probe the agent's console SCREEN, then
    # SELECT each tab in turn and compare its rendered UIA text - the content
    # identifies the right tab no matter what the header says. Only ever
    # called from a user click (the user asked to switch tabs; flipping
    # through a few on the way is fine). The result is cached, so this runs
    # at most once per process.
    param([int]$TargetPid, [string[]]$PreferredNorms = @())

    if ($script:CycleFailStamp.ContainsKey($TargetPid)) {
        # a double-click must not run the whole light show twice in a row
        if (((Get-Date) - $script:CycleFailStamp[$TargetPid]).TotalSeconds -lt 30) { return $null }
        [void]$script:CycleFailStamp.Remove($TargetPid)
    }

    $info = Read-ConsoleInfoBounded -TargetPid $TargetPid
    if ($null -eq $info -or ([string]$info.Screen).Length -lt 200) { return $null }
    $s = [string]$info.Screen
    $script:LastScreenMap[$TargetPid] = @{ Text = $s; Stamp = (Get-Date) }

    $tabs = @(Get-AllTerminalTabs -Fresh)
    if ($tabs.Count -eq 0) { return $null }
    $original = @{}   # hwnd -> tab selected before we started (restore on failure)
    foreach ($tb in $tabs) {
        $hk = [string][long]$tb.Hwnd
        if ($tb.Selected -and -not $original.ContainsKey($hk)) { $original[$hk] = $tb }
    }

    # tabs OWNED by other sessions (ownership-proven mappings) are not
    # candidates: fewer visible flips and no way to land on a busy neighbor
    $claimed = @{}
    foreach ($r in @($script:KnownRidClaims.Keys)) {
        if ([int]$script:KnownRidClaims[$r] -ne $TargetPid) { $claimed[[string]$r] = $true }
    }
    foreach ($k in @($script:UntrackedTabMap.Keys)) {
        if ([int]$k -ne $TargetPid) { $claimed[[string]$script:UntrackedTabMap[$k]] = $true }
    }
    $cands = @($tabs | Where-Object { $null -ne $_.Element -and $_.Rid.Length -gt 0 -and -not $claimed.ContainsKey($_.Rid) })
    if ($cands.Count -eq 0) { return $null }
    if ($PreferredNorms.Count -gt 0) {
        # most-likely first (tab named like the row): the walk usually ends
        # on flip #1 instead of touring the whole strip
        $cands = @($cands | Sort-Object -Property @{ Expression = { if ($PreferredNorms -contains $_.Norm) { 0 } else { 1 } } })
    }

    # score every candidate and require a decisive winner: freshly restarted
    # twin sessions show near-identical screens, and stopping at the first
    # plausible match once sent a click to the WRONG session's tab
    $best = $null; $bestScore = 0; $second = 0
    try {
        foreach ($tb in $cands) {
            try {
                $pat = $tb.Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                $pat.Select()
            }
            catch { continue }
            $sc = 0
            for ($attempt = 0; $attempt -lt 2; $attempt++) {
                Start-Sleep -Milliseconds 150
                $paneText = Get-ActiveTermText -Hwnd $tb.Hwnd
                $sc = [Math]::Max($sc, (Get-ScreenMatchScore -S $s -T $paneText))
                if ($sc -ge 6) { break }
            }
            if ($sc -gt $bestScore) { $second = $bestScore; $bestScore = $sc; $best = $tb }
            elseif ($sc -gt $second) { $second = $sc }
        }
    }
    catch { }

    if ($null -ne $best -and $bestScore -ge 6 -and ($bestScore - $second) -ge 2) {
        $script:UntrackedTabMap[$TargetPid] = $best.Rid
        [void]$script:NoTabStamp.Remove($TargetPid)
        try {
            $pat = $best.Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $pat.Select()
        }
        catch { }
        return $best
    }
    $script:CycleFailStamp[$TargetPid] = Get-Date
    foreach ($hk in @($original.Keys)) {
        # no decisive winner: put the user back on the tab they were on -
        # doing nothing beats jumping to the wrong session
        try {
            $pat = $original[$hk].Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $pat.Select()
        }
        catch { }
    }
    return $null
}

$script:SubagentCache = @{}   # pid -> bool (ancestry never changes for a live pid)
function Test-IsSubagentProc {
    # Interactive agents are launched from a shell, so walking UP the parent
    # chain reaches the terminal host; a subagent (claude spawned by claude -
    # Task tool / agent teams) hits an agent-named ancestor first.
    param([int]$TargetPid)

    if ($script:SubagentCache.ContainsKey($TargetPid)) { return $script:SubagentCache[$TargetPid] }
    $isSub = $false
    try {
        $agentNames = '^(' + ((@($AgentProcNames) | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')'
        $current = $TargetPid
        for ($i = 0; $i -lt 8; $i++) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop
            if ($null -eq $proc) { break }
            $parentId = [int]$proc.ParentProcessId
            if ($parentId -le 0) { break }
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
            if ($null -eq $parent) { break }
            $name = [string]$parent.Name
            if ($name -match $agentNames) { $isSub = $true; break }
            if ($name -match '^(WindowsTerminal|explorer|svchost|services|wininit|winlogon)') { break }
            $current = $parentId
        }
    }
    catch { }
    $script:SubagentCache[$TargetPid] = $isSub
    return $isSub
}

function Get-InferredAgentStatus([string]$LiveName) {
    # untracked agents have no hooks, but their console/tab title tells the
    # story: a leading braille spinner glyph (u2800-u28FF) means WORKING
    if ([string]::IsNullOrWhiteSpace($LiveName)) { return 'quiet' }
    $c = [int][char]$LiveName[0]
    if ($c -ge 0x2800 -and $c -le 0x28FF) { return 'working' }
    return 'quiet'
}

function Resolve-TabForPid {
    # Map an agent process to its WT tab (cached rid -> unique title match ->
    # marker dance -> cwd-name match for RENAMED tabs) OR, for agents in a
    # plain console window with no WT tab, to that window itself (Rid = '').
    # Negative results cached 5 min.
    param([int]$TargetPid, $Proc, [string]$CwdName = '')

    $tabs = @(Get-AllTerminalTabs)

    if ($script:UntrackedTabMap.ContainsKey($TargetPid)) {
        $rid = [string]$script:UntrackedTabMap[$TargetPid]
        foreach ($tb in $tabs) { if ($tb.Rid -eq $rid) { return $tb } }
        [void]$script:UntrackedTabMap.Remove($TargetPid)
    }
    if ($script:WinOnlyMap.ContainsKey($TargetPid)) {
        $h = [IntPtr][long]$script:WinOnlyMap[$TargetPid]
        if ([ClaudeHud.Native]::IsWindow($h)) {
            $name = ''
            try { $name = [ClaudeHud.Windows]::GetTitle($h) } catch { }
            return [pscustomobject]@{ Hwnd = $h; Rid = ''; Name = $name; Norm = (Get-NormalizedTabName $name); Index = -1; Element = $null }
        }
        [void]$script:WinOnlyMap.Remove($TargetPid)
    }
    if ($script:NoTabStamp.ContainsKey($TargetPid)) {
        if (((Get-Date) - $script:NoTabStamp[$TargetPid]).TotalSeconds -lt 300) { return $null }
        [void]$script:NoTabStamp.Remove($TargetPid)
    }
    if (Test-ProcSuspended $Proc) { return $null }   # not cached: may wake up

    # probes cost a child process each (~0.7s); budget per tick so a fleet of
    # unresolved processes can't stall the UI - leftovers resolve next ticks
    if ($script:ProbeBudget -le 0) { return $null }
    $script:ProbeBudget--

    $info = Read-ConsoleInfoBounded -TargetPid $TargetPid
    $match = $null
    if ($null -ne $info) {
        if (([string]$info.Screen).Length -ge 200) {
            $script:LastScreenMap[$TargetPid] = @{ Text = [string]$info.Screen; Stamp = (Get-Date) }   # fuels the passive learner
        }
        $script:LastTitleByPid[$TargetPid] = [string]$info.Title
        if ([long]$info.ConsoleId -gt 0) { $script:ConsoleIdByPid[$TargetPid] = [long]$info.ConsoleId }
    }
    if ($null -ne $info -and -not [string]::IsNullOrWhiteSpace($info.Title)) {
        # TWIN-PROOF title matching. A title is a value, not ownership: two
        # freshly restarted sessions briefly share identical titles and plain
        # title matching once cross-mapped them (click on A focused B). The
        # match only counts when NO other known console currently shows the
        # same title - processes sharing OUR console (codex.exe launcher +
        # its node TUI) are the same session and don't count as twins.
        # (A stamped marker WOULD be true ownership proof, but ConPTY never
        # propagates externally-set titles to the WT tab - verified live.)
        $norm = Get-NormalizedTabName $info.Title
        $byName = @($tabs | Where-Object { $_.Norm -eq $norm })
        if ($byName.Count -eq 1) {
            $ownConsole = [long]$script:ConsoleIdByPid[$TargetPid]
            $clash = $false
            foreach ($opid in @($script:LastTitleByPid.Keys)) {
                if ([int]$opid -eq $TargetPid) { continue }
                if ($ownConsole -gt 0 -and [long]$script:ConsoleIdByPid[$opid] -eq $ownConsole) { continue }
                if ($null -eq (Get-Process -Id $opid -ErrorAction SilentlyContinue)) { continue }
                if ((Get-NormalizedTabName ([string]$script:LastTitleByPid[$opid])) -eq $norm) { $clash = $true; break }
            }
            if (-not $clash) { $match = $byName[0] }
        }
    }
    if ($null -eq $match -and $CwdName.Length -gt 0) {
        # manually-RENAMED tabs ignore console-title changes, so neither the
        # live title nor a stamped marker ever appears on them. People usually
        # rename the tab to the project name -> match the cwd folder name.
        $wantCwd = Get-NormalizedTabName $CwdName
        if ($wantCwd.Length -gt 0) {
            $byCwd = @($tabs | Where-Object { $_.Norm -eq $wantCwd })
            if ($byCwd.Count -eq 1) { $match = $byCwd[0] }
        }
    }
    if ($null -eq $match -and $null -ne $info -and $info.ConsoleHwnd -gt 0) {
        # no WT tab anywhere, but the console has its own visible window
        # (plain conhost / legacy console) - track the window itself
        $h = [IntPtr][long]$info.ConsoleHwnd
        $script:WinOnlyMap[$TargetPid] = [long]$info.ConsoleHwnd
        $match = [pscustomobject]@{ Hwnd = $h; Rid = ''; Name = [string]$info.Title; Norm = (Get-NormalizedTabName $info.Title); Index = -1; Element = $null }
    }
    if ($null -ne $match) {
        if ($match.Rid.Length -gt 0) { $script:UntrackedTabMap[$TargetPid] = $match.Rid }
    }
    else { $script:NoTabStamp[$TargetPid] = Get-Date }
    return $match
}

$script:UntrackedCache = @()
$script:UntrackedStamp = [datetime]::MinValue
function Get-UntrackedSessions {
    # Agent processes with no live status file. Two detection paths:
    #  a) processes literally named claude/codex/... (claude.exe)
    #  b) interpreter processes (node/bun/deno/python) whose COMMAND LINE
    #     names an agent - e.g. Codex runs as `node ...\@openai\codex\bin\codex.js`
    #     while codex.exe is just a consoleless launcher.
    # Tab resolution: unique title match, else marker dance (cached per pid).
    param($Tracked)

    if (((Get-Date) - $script:UntrackedStamp).TotalSeconds -lt 20) { return $script:UntrackedCache }
    $script:UntrackedStamp = Get-Date

    $found = New-Object System.Collections.ArrayList
    try {
        if (-not (Ensure-ConsoleApi)) { $script:UntrackedCache = @(); return @() }

        $trackedPids = @{}
        $claimedRids = @{}
        foreach ($t in @($Tracked)) {
            if ($t.AgentPid -gt 0) { $trackedPids[[int]$t.AgentPid] = $true }
            if ($null -ne $t.Window -and $t.Window.PSObject.Properties['tab_runtime_id']) {
                $r = [string]$t.Window.tab_runtime_id
                if ($r.Length -gt 0) { $claimedRids[$r] = $true }
            }
        }

        # path a: interpreter-hosted agents, detected via command line - these
        # come FIRST because they are the real TUI (codex.exe is a consoleless
        # launcher whose node child owns the session)
        $candidates = New-Object System.Collections.ArrayList
        $namePattern = ($AgentProcNames | ForEach-Object { [regex]::Escape($_) }) -join '|'
        $cmdRegex = "[\\/@]($namePattern)[\\/. ]"
        try {
            $interp = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='bun.exe' OR Name='deno.exe' OR Name='python.exe'" -ErrorAction Stop)
            foreach ($ip in $interp) {
                $cl = [string]$ip.CommandLine
                if ($cl -notmatch $cmdRegex) { continue }
                $provider = $Matches[1].ToLowerInvariant()
                if ($trackedPids.ContainsKey([int]$ip.ProcessId)) { continue }
                $p = Get-Process -Id $ip.ProcessId -ErrorAction SilentlyContinue
                if ($null -ne $p) {
                    [void]$candidates.Add(@{ Proc = $p; Provider = $provider })
                }
            }
        }
        catch { }

        # path b: by process name
        foreach ($procName in $AgentProcNames) {
            foreach ($p in @(Get-Process -Name $procName -ErrorAction SilentlyContinue)) {
                if (-not $trackedPids.ContainsKey($p.Id)) {
                    [void]$candidates.Add(@{ Proc = $p; Provider = $procName.ToLowerInvariant() })
                }
            }
        }

        if ($candidates.Count -eq 0) { $script:UntrackedCache = @(); return @() }

        $claimedHwnds = @{}
        foreach ($cand in $candidates) {
            $c = $cand.Proc
            $match = Resolve-TabForPid -TargetPid $c.Id -Proc $c
            if ($null -eq $match) { continue }
            # a tab/window already claimed by a tracked session or another
            # candidate (codex.exe launcher + its node child share ONE
            # console) = skip the duplicate
            if ($match.Rid.Length -gt 0) {
                if ($claimedRids.ContainsKey($match.Rid)) { continue }
                $claimedRids[$match.Rid] = $true
            }
            else {
                $hkey = [string][long]$match.Hwnd
                if ($claimedHwnds.ContainsKey($hkey)) { continue }
                $claimedHwnds[$hkey] = $true
            }

            $dispName = Get-NormalizedTabName $match.Name
            if ($dispName.Length -eq 0) { $dispName = "$($cand.Provider) session" }
            if ($dispName.Length -gt 34) { $dispName = $dispName.Substring(0, 34) }
            $ts = Get-Date
            try { $ts = $c.StartTime } catch { }

            [void]$found.Add([pscustomobject]@{
                Id       = "untracked-$($c.Id)"
                Provider = $cand.Provider
                Status   = 'quiet'
                CwdName  = $dispName
                Cwd      = ''
                Message  = 'untracked session (no hook events yet) - for claude, send any prompt to fully track it'
                Ts       = $ts
                AgentPid = [int]$c.Id
                Window   = [pscustomobject]@{
                    hwnd           = [long]$match.Hwnd
                    tab_runtime_id = $match.Rid
                    tab_name       = $match.Name
                    tab_index      = $match.Index
                    captured_event = 'hud-scan+console'
                }
                Rank     = (Get-StatusMeta 'quiet').Rank
            })
        }
    }
    catch { }
    $script:UntrackedCache = @($found)
    return $script:UntrackedCache
}

# ---------- focusing ----------
function Get-NormalizedTabName([string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Name)) { return '' }
    return (($Name -replace '^[^\p{L}\p{Nd}]+', '').Trim().ToLowerInvariant())
}

function Get-ActiveTermText {
    # UIA TextPattern on the ACTIVE tab's TermControl: the rendered pane text
    # (what Narrator reads). Tab renames touch only the header - the CONTENT
    # is the one fingerprint of a session that cannot lie.
    param([IntPtr]$Hwnd = [IntPtr]::Zero, $Root = $null)

    try {
        if ($null -eq $Root) {
            if ($Hwnd -eq [IntPtr]::Zero) { return '' }
            $Root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
        }
        if ($null -eq $Root) { return '' }
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'TermControl')
        $tc = $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($null -eq $tc) { return '' }
        $tp = $tc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        $text = ''
        foreach ($r in @($tp.GetVisibleRanges())) { $text += $r.GetText(2147483647) }
        if ($text.Length -eq 0) { $text = $tp.DocumentRange.GetText(40000) }
        return ($text -replace '[^\p{L}\p{Nd}]', '').ToLowerInvariant()
    }
    catch { return '' }
}

function Get-ScreenMatchScore {
    # 0..8: how many 100-char slices of S (probed console screen) appear in T
    # (pane text from UIA). Same session => high score. BUT two freshly
    # restarted claude sessions show near-identical boilerplate screens, so an
    # absolute threshold alone false-positives (learned the hard way: a click
    # on one session landed on its twin). Callers must demand a MARGIN over
    # the runner-up before trusting any match.
    param([string]$S, [string]$T)

    if ($S.Length -lt 200 -or $T.Length -lt 200) { return 0 }
    $score = 0
    foreach ($frac in @(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8)) {
        $start = [Math]::Max(0, [Math]::Min([int]($S.Length * $frac) - 50, $S.Length - 100))
        if ($T.Contains($S.Substring($start, 100))) { $score++ }
    }
    return $score
}

$script:TabsCache = @()
$script:TabsCacheStamp = [datetime]::MinValue
function Get-AllTerminalTabs {
    # UIA enumeration across EVERY top-level WT window (there can be several
    # per process). Cached for 2s - callers hit this on every refresh tick.
    # -Fresh bypasses the cache (marker dance polls for a just-set title).
    param([switch]$Fresh)
    if (-not $Fresh -and ((Get-Date) - $script:TabsCacheStamp).TotalMilliseconds -lt 2000) { return $script:TabsCache }
    $list = New-Object System.Collections.ArrayList
    $handles = New-Object System.Collections.ArrayList
    foreach ($wt in @(Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue)) {
        try {
            foreach ($hl in [ClaudeHud.Windows]::TopLevelForProcess([uint32]$wt.Id)) {
                [void]$handles.Add([IntPtr][long]$hl)
            }
        }
        catch {
            if ($wt.MainWindowHandle -ne [IntPtr]::Zero) { [void]$handles.Add($wt.MainWindowHandle) }
        }
    }
    foreach ($hwnd in $handles) {
        if ($hwnd -eq [IntPtr]::Zero) { continue }
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
            if ($null -eq $root) { continue }
            $cond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::TabItem)
            $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
            for ($i = 0; $i -lt $tabs.Count; $i++) {
                $tab = $tabs.Item($i)
                $rid = ''
                try { $rid = ($tab.GetRuntimeId() -join '.') } catch { }
                $tname = ''
                try { $tname = [string]$tab.Current.Name } catch { }
                $sel = $false
                try {
                    $sel = [bool]$tab.GetCurrentPropertyValue(
                        [System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty)
                }
                catch { }
                [void]$list.Add([pscustomobject]@{
                    Hwnd     = $hwnd
                    Rid      = $rid
                    Name     = $tname
                    Norm     = Get-NormalizedTabName $tname
                    Index    = $i
                    Selected = $sel
                    Element  = $tab
                })
            }
        }
        catch { }
    }
    $script:TabsCache = @($list)
    $script:TabsCacheStamp = Get-Date
    return $script:TabsCache
}

function Invoke-FocusSession($Sess) {
    $w = $Sess.Window
    $storedHwnd = [IntPtr]::Zero
    $rid = ''; $tabName = ''; $tabIndex = -1
    if ($null -ne $w) {
        if ($w.PSObject.Properties['hwnd'] -and $w.hwnd) { try { $storedHwnd = [IntPtr][long]$w.hwnd } catch { } }
        if ($w.PSObject.Properties['tab_runtime_id'])    { $rid = [string]$w.tab_runtime_id }
        if ($w.PSObject.Properties['tab_name'])          { $tabName = [string]$w.tab_name }
        if ($w.PSObject.Properties['tab_index'] -and $null -ne $w.tab_index) {
            try { $tabIndex = [int]$w.tab_index } catch { }
        }
    }

    # match against the LIVE tab list; the hook refreshes tab_name on every
    # event, so a fresh title match outranks a possibly-stale runtime id.
    $tabs = @(Get-AllTerminalTabs)
    $target = $null
    if ($tabs.Count -gt 0) {
        $want = Get-NormalizedTabName $tabName
        $byName = @($tabs | Where-Object { $want.Length -gt 0 -and $_.Norm -eq $want })
        $byRid  = @($tabs | Where-Object { $rid.Length -gt 0 -and $_.Rid -eq $rid })
        $both   = @($byRid | Where-Object { $_.Norm -eq $want -and $want.Length -gt 0 })

        if     ($both.Count -ge 1)   { $target = $both[0] }
        elseif ($byName.Count -eq 1) { $target = $byName[0] }
        elseif ($byRid.Count -ge 1)  { $target = $byRid[0] }
        elseif ($byName.Count -gt 1) {
            $inWin = @($byName | Where-Object { $_.Hwnd -eq $storedHwnd })
            if ($inWin.Count -ge 1) { $target = $inWin[0] } else { $target = $byName[0] }
        }
        elseif ($storedHwnd -ne [IntPtr]::Zero -and $tabIndex -ge 0) {
            $inWin = @($tabs | Where-Object { $_.Hwnd -eq $storedHwnd })
            if ($tabIndex -lt $inWin.Count) { $target = $inWin[$tabIndex] }
        }

        if ($null -eq $target -and $null -ne $Sess.PSObject.Properties['AgentPid'] -and [int]$Sess.AgentPid -gt 0) {
            # stored hints dead or missing (typical for manually-RENAMED tabs:
            # they ignore console titles, so hooks may never capture them).
            # Follow the PROCESS itself: probe its console screen and cycle
            # tabs until the pane CONTENT matches decisively. Stronger evidence
            # than any name. Runs once per process (cached), only on clicks.
            $prefNorms = @()
            foreach ($cand in @([string]$Sess.DisplayName, [string]$Sess.CwdName)) {
                $n = Get-NormalizedTabName $cand
                if ($n.Length -gt 0 -and $prefNorms -notcontains $n) { $prefNorms += $n }
            }
            $target = Resolve-TabByCycle -TargetPid ([int]$Sess.AgentPid) -PreferredNorms $prefNorms
        }

        if ($null -eq $target) {
            # weakest fallback: match the tab against what the row is CALLED -
            # custom name first, then the project folder name; users rename
            # tabs to exactly these.
            foreach ($cand in @([string]$Sess.DisplayName, [string]$Sess.CwdName)) {
                $wantN = Get-NormalizedTabName $cand
                if ($wantN.Length -eq 0) { continue }
                $byLabel = @($tabs | Where-Object { $_.Norm -eq $wantN })
                if ($byLabel.Count -eq 1) { $target = $byLabel[0]; break }
            }
        }
    }

    if ($null -ne $target) {
        try {
            $pattern = $target.Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $pattern.Select()
        }
        catch { }
        if ([ClaudeHud.Native]::IsIconic($target.Hwnd)) { [void][ClaudeHud.Native]::ShowWindowAsync($target.Hwnd, 9) }
        [void][ClaudeHud.Native]::SetForegroundWindow($target.Hwnd)
        return $true
    }

    # nothing matched: raise the stored window, but ONLY if it is actually a
    # terminal (old foreground-captured hints could point at any app, e.g.
    # Spotify, if the user tab-hopped while the hook fired)
    if ($storedHwnd -ne [IntPtr]::Zero -and [ClaudeHud.Native]::IsWindow($storedHwnd)) {
        [uint32]$wpid = 0
        [void][ClaudeHud.Native]::GetWindowThreadProcessId($storedHwnd, [ref]$wpid)
        $pname = ''
        if ($wpid -gt 0) { try { $pname = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { } }
        if ($pname -match '^(WindowsTerminal|powershell|pwsh|cmd|conhost|OpenConsole|wsl|ubuntu|Code|wezterm|alacritty|Hyper|mintty)$') {
            if ([ClaudeHud.Native]::IsIconic($storedHwnd)) { [void][ClaudeHud.Native]::ShowWindowAsync($storedHwnd, 9) }
            [void][ClaudeHud.Native]::SetForegroundWindow($storedHwnd)
            return $true
        }
    }
    return $false
}

# ---------- probe mode (no UI) ----------
Load-Prefs
if ($Probe) {
    $script:ProbeBudget = 100   # resolve everything in one pass for diagnostics
    # NOTE: the untracked scan detaches this process's console (AttachConsole
    # dance), which resets std handles and breaks the normal output path.
    # Grab the stdout writer BEFORE the scan so it binds to the real pipe.
    $stdout = [Console]::Out
    $rows = @(Get-Sessions | ForEach-Object {
        $tab = ''
        if ($null -ne $_.Window -and $_.Window.PSObject.Properties['tab_name']) { $tab = [string]$_.Window.tab_name }
        [pscustomobject]@{
            Name   = $_.DisplayName
            Pin    = $(if ($_.Pinned) { 'pin' } else { '' })
            Status = $_.Status
            Age    = Format-Age $_.Ts
            Pid    = $_.AgentPid
            Tab    = $tab
        }
    })
    $text = ($rows | Format-Table -AutoSize | Out-String -Width 200)
    try { $stdout.Write($text); $stdout.Flush() } catch { }
    exit 0
}

# ---------- UI ----------
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    Start-Process powershell.exe -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA',
        '-WindowStyle', 'Hidden', '-File', $PSCommandPath) | Out-Null
    exit 0
}

# single instance: launching again while one is running just exits, so HUDs
# can never stack invisibly on top of each other at the same corner
$script:SingleMutex = New-Object System.Threading.Mutex($false, 'Local\PerchSingleton')
if (-not $script:SingleMutex.WaitOne(0)) { exit 0 }

Set-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-boot.log') -Value "$(Get-Date -Format s) boot pid=$PID" -ErrorAction SilentlyContinue

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

# own taskbar identity: without this the taskbar groups the HUD under
# powershell.exe and shows the PowerShell icon instead of our window icon
try { [void][ClaudeHud.Native]::SetCurrentProcessExplicitAppUserModelID('Zelipt.Perch') } catch { }

# purge status files older than 7 days
try {
    Get-ChildItem -LiteralPath $StatusDir -Filter '*.json' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
        Remove-Item -Force -Confirm:$false -ErrorAction SilentlyContinue
}
catch { }

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Perch" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" Topmost="True" ShowInTaskbar="True"
        ResizeMode="NoResize" SizeToContent="Height" Width="324"
        ShowActivated="False" FontFamily="Segoe UI"
        TextOptions.TextRenderingMode="ClearType" UseLayoutRounding="True">
  <Window.Resources>
    <Style x:Key="HudIconButton" TargetType="TextBlock">
      <Setter Property="Foreground" Value="#66666E"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="VerticalAlignment" Value="Center"/>
      <!-- transparent background makes the WHOLE box (incl. padding) clickable,
           not just the glyph pixels -->
      <Setter Property="Background" Value="Transparent"/>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Foreground" Value="#DCDCE4"/>
        </Trigger>
      </Style.Triggers>
    </Style>
    <ControlTemplate x:Key="HudScrollThumb" TargetType="Thumb">
      <Border x:Name="Bg" CornerRadius="3" Background="#26FFFFFF" Margin="1,2"/>
      <ControlTemplate.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter TargetName="Bg" Property="Background" Value="#4DFFFFFF"/>
        </Trigger>
      </ControlTemplate.Triggers>
    </ControlTemplate>
    <ControlTemplate x:Key="HudScrollBtn" TargetType="RepeatButton">
      <Rectangle Fill="Transparent"/>
    </ControlTemplate>
    <Style x:Key="HudMenu" TargetType="ContextMenu">
      <Setter Property="OverridesDefaultStyle" Value="True"/>
      <Setter Property="SnapsToDevicePixels" Value="True"/>
      <Setter Property="HasDropShadow" Value="True"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ContextMenu">
            <Border CornerRadius="10" Background="#FA1F1F29" BorderBrush="#30FFFFFF"
                    BorderThickness="1" Padding="5" Margin="0,0,8,8">
              <Border.Effect>
                <DropShadowEffect BlurRadius="10" ShadowDepth="2" Opacity="0.5"/>
              </Border.Effect>
              <StackPanel IsItemsHost="True"/>
            </Border>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="HudMenuItem" TargetType="MenuItem">
      <Setter Property="OverridesDefaultStyle" Value="True"/>
      <Setter Property="Foreground" Value="#EDEDF2"/>
      <Setter Property="FontSize" Value="11.5"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="MenuItem">
            <Border x:Name="Bg" CornerRadius="7" Background="Transparent" Padding="11,6,26,7" Margin="1">
              <ContentPresenter ContentSource="Header" RecognizesAccessKey="False" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsHighlighted" Value="True">
                <Setter TargetName="Bg" Property="Background" Value="#22FFFFFF"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="6"/>
      <Setter Property="MinWidth" Value="6"/>
      <Setter Property="Background" Value="Transparent"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Grid Background="Transparent">
              <Track x:Name="PART_Track" IsDirectionReversed="True">
                <Track.DecreaseRepeatButton>
                  <RepeatButton Template="{StaticResource HudScrollBtn}"
                                Command="ScrollBar.PageUpCommand" Focusable="False"/>
                </Track.DecreaseRepeatButton>
                <Track.Thumb>
                  <Thumb Template="{StaticResource HudScrollThumb}"/>
                </Track.Thumb>
                <Track.IncreaseRepeatButton>
                  <RepeatButton Template="{StaticResource HudScrollBtn}"
                                Command="ScrollBar.PageDownCommand" Focusable="False"/>
                </Track.IncreaseRepeatButton>
              </Track>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <Border x:Name="RootCard" CornerRadius="16" BorderBrush="#24FFFFFF" BorderThickness="1" Margin="12">
    <Border.Background>
      <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
        <GradientStop Color="#F71E1E27" Offset="0"/>
        <GradientStop Color="#F7141419" Offset="1"/>
      </LinearGradientBrush>
    </Border.Background>
    <Border.Effect>
      <DropShadowEffect BlurRadius="18" ShadowDepth="0" Opacity="0.55"/>
    </Border.Effect>
    <Grid>
    <!-- glass theme overlays: top-light sheen + diagonal reflection streaks
         (under the content) and a light-catching rim (over everything).
         Collapsed in the midnight theme. -->
    <Border x:Name="GlassSheen" CornerRadius="9" IsHitTestVisible="False" Visibility="Collapsed">
      <Border.Background>
        <LinearGradientBrush StartPoint="0.1,0" EndPoint="0.5,1">
          <GradientStop Color="#3DFFFFFF" Offset="0"/>
          <GradientStop Color="#14FFFFFF" Offset="0.18"/>
          <GradientStop Color="#05FFFFFF" Offset="0.42"/>
          <GradientStop Color="#00FFFFFF" Offset="0.65"/>
          <GradientStop Color="#0AFFFFFF" Offset="1"/>
        </LinearGradientBrush>
      </Border.Background>
    </Border>
    <Border x:Name="GlassStreak" CornerRadius="9" IsHitTestVisible="False" Visibility="Collapsed">
      <Border.Background>
        <LinearGradientBrush StartPoint="0,0" EndPoint="1,0.9">
          <GradientStop Color="#00FFFFFF" Offset="0"/>
          <GradientStop Color="#00FFFFFF" Offset="0.30"/>
          <GradientStop Color="#17FFFFFF" Offset="0.37"/>
          <GradientStop Color="#00FFFFFF" Offset="0.46"/>
          <GradientStop Color="#00FFFFFF" Offset="0.55"/>
          <GradientStop Color="#0DFFFFFF" Offset="0.60"/>
          <GradientStop Color="#00FFFFFF" Offset="0.68"/>
          <GradientStop Color="#00FFFFFF" Offset="1"/>
        </LinearGradientBrush>
      </Border.Background>
    </Border>
    <StackPanel>
      <Grid x:Name="Header" Margin="16,11,12,7" Background="Transparent">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>
        <StackPanel Grid.Column="0" Orientation="Horizontal" VerticalAlignment="Center">
          <Image x:Name="LogoImg" Width="17" Height="17" Margin="0,0,7,0"
                 RenderOptions.BitmapScalingMode="HighQuality"/>
          <TextBlock FontSize="13" FontWeight="SemiBold" Text="Perch"
                     Foreground="#F4F4F8" VerticalAlignment="Center"/>
        </StackPanel>
        <StackPanel Grid.Column="1" Orientation="Horizontal">
          <TextBlock x:Name="MiniBtn" Text="&#x2013;" FontSize="12" Padding="5,3"
                     Style="{StaticResource HudIconButton}" Margin="2,0"
                     ToolTip="compact mode (double-click the header works too)"/>
          <TextBlock x:Name="GearBtn" Text="&#x2699;" FontSize="12" Padding="5,3"
                     Style="{StaticResource HudIconButton}" Margin="2,0"
                     ToolTip="settings"/>
          <TextBlock x:Name="PinBtn" Text="&#x1F4CC;" FontSize="11" Padding="5,3"
                     Style="{StaticResource HudIconButton}" Margin="2,0"
                     ToolTip="pinned = always on top; unpinned = normal window (attention only flashes the taskbar)"/>
          <TextBlock x:Name="CloseBtn" Text="&#x2715;" FontSize="12" Padding="5,3"
                     Style="{StaticResource HudIconButton}" Margin="4,0,2,0"/>
        </StackPanel>
      </Grid>
      <WrapPanel x:Name="ChipsPanel" Orientation="Horizontal" Margin="16,0,16,8" Background="Transparent"/>
      <Border x:Name="Divider" Height="1" Background="#14FFFFFF" Margin="12,0,12,4"/>
      <ScrollViewer x:Name="RowsScroll" MaxHeight="560" VerticalScrollBarVisibility="Auto"
                    HorizontalScrollBarVisibility="Disabled">
        <StackPanel x:Name="SessionList" Margin="8,2,8,10"/>
      </ScrollViewer>
    </StackPanel>
    <Border x:Name="GlassRim" CornerRadius="9" BorderThickness="1.4"
            IsHitTestVisible="False" Visibility="Collapsed">
      <Border.BorderBrush>
        <LinearGradientBrush StartPoint="0.2,0" EndPoint="0.8,1">
          <GradientStop Color="#A8FFFFFF" Offset="0"/>
          <GradientStop Color="#30FFFFFF" Offset="0.22"/>
          <GradientStop Color="#12FFFFFF" Offset="0.55"/>
          <GradientStop Color="#26FFFFFF" Offset="0.85"/>
          <GradientStop Color="#59FFFFFF" Offset="1"/>
        </LinearGradientBrush>
      </Border.BorderBrush>
    </Border>
    </Grid>
  </Border>
</Window>
"@

$script:Window      = [System.Windows.Markup.XamlReader]::Parse($xaml)
$script:SessionList = $Window.FindName('SessionList')
$script:ChipsPanel  = $Window.FindName('ChipsPanel')
$script:Header      = $Window.FindName('Header')
$script:PinBtn      = $Window.FindName('PinBtn')
$script:CloseBtn    = $Window.FindName('CloseBtn')
$script:GearBtn     = $Window.FindName('GearBtn')
$script:MiniBtn     = $Window.FindName('MiniBtn')
$script:Divider     = $Window.FindName('Divider')
$script:RowsScroll  = $Window.FindName('RowsScroll')
$script:RootCard    = $Window.FindName('RootCard')
$script:GlassSheen  = $Window.FindName('GlassSheen')
$script:GlassStreak = $Window.FindName('GlassStreak')
$script:GlassRim    = $Window.FindName('GlassRim')
$script:RimGradient = $script:GlassRim.BorderBrush          # restored after pulse animations
$script:CardGradient = $script:RootCard.Background          # midnight look, restored on theme switch
$script:CardShadow  = $script:RootCard.Effect
$script:WorkSince   = @{}
$script:Dismissed   = @{}
$script:PrevAttention = @{}
$script:UiHold      = 0
$script:UiHoldStamp = [datetime]::MinValue
$script:InTick      = $false
$script:InTickStamp = [datetime]::MinValue

# last safety net: a handler exception must never tear the window down
$Window.Dispatcher.Add_UnhandledException({
    param($s, $e)
    try {
        "$(Get-Date -Format s)  DISPATCHER: $($e.Exception.Message)" |
            Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-error.log')
    }
    catch { }
    $e.Handled = $true
})
$script:BrushCache  = @{}
$script:Bc          = New-Object System.Windows.Media.BrushConverter
$script:Sep         = ' ' + [string][char]0x00B7 + ' '
$script:Dash        = ' ' + [string][char]0x2014 + ' '
$script:HudHideAfterFocus = $HideAfterFocus

function Get-Brush([string]$Hex) {
    if (-not $script:BrushCache.ContainsKey($Hex)) {
        $b = $script:Bc.ConvertFromString($Hex)
        $b.Freeze()
        $script:BrushCache[$Hex] = $b
    }
    return $script:BrushCache[$Hex]
}

function Get-RowBaseBrush($Sess) {
    if ($Sess.Status -eq 'attention' -or $Sess.Status -eq 'error') { return Get-Brush '#14FF6B6B' }
    return [System.Windows.Media.Brushes]::Transparent
}

# window/taskbar icon + header logo
try {
    $iconPath = Join-Path $PSScriptRoot 'icon.ico'
    if (Test-Path -LiteralPath $iconPath) {
        $Window.Icon = [System.Windows.Media.Imaging.BitmapFrame]::Create(
            (New-Object System.Uri($iconPath)),
            [System.Windows.Media.Imaging.BitmapCreateOptions]::None,
            [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
    }
    $logoPath = Join-Path $PSScriptRoot 'logo.png'
    $logoImg = $Window.FindName('LogoImg')
    if ($null -ne $logoImg -and (Test-Path -LiteralPath $logoPath)) {
        $bi = New-Object System.Windows.Media.Imaging.BitmapImage
        $bi.BeginInit()
        $bi.UriSource = New-Object System.Uri($logoPath)
        $bi.DecodePixelWidth = 128
        $bi.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bi.EndInit()
        $bi.Freeze()
        $logoImg.Source = $bi
        $script:LogoSource = $bi
    }
}
catch { }

function Set-GlassBackdrop([bool]$On) {
    # needs a real hwnd - called again from SourceInitialized for the boot path
    try {
        $h = (New-Object System.Windows.Interop.WindowInteropHelper($script:Window)).Handle
        if ($h -eq [IntPtr]::Zero) { return }
        if ($On) {
            [ClaudeHud.Glass]::SetRoundCorners($h, $true)
            # tint is ABGR: ~35% warm near-black. LOW alpha on purpose - the
            # point is glass you can see through, not fogged plexiglass
            [ClaudeHud.Glass]::SetAcrylic($h, $true, 0x59120E0C)
        }
        else {
            [ClaudeHud.Glass]::SetAcrylic($h, $false, 0)
            [ClaudeHud.Glass]::SetRoundCorners($h, $false)
        }
    }
    catch { }
}

function Apply-Theme {
    $glass = ($script:ThemeName -eq 'glass')
    if ($glass) {
        # liquid glass: REAL backdrop blur (acrylic) + a barely-there white
        # film, lit by a sheen, two reflection streaks and a bright rim.
        # margin 0 because the acrylic covers the whole hwnd rect - any
        # transparent margin would show a square blur slab around the card.
        $script:RootCard.Margin = New-Object System.Windows.Thickness(0)
        $script:RootCard.CornerRadius = New-Object System.Windows.CornerRadius(9)
        $script:RootCard.Effect = $null
        $script:RootCard.BorderBrush = Get-Brush '#00FFFFFF'
        $film = New-Object System.Windows.Media.LinearGradientBrush
        $film.StartPoint = New-Object System.Windows.Point(0, 0)
        $film.EndPoint = New-Object System.Windows.Point(0, 1)
        [void]$film.GradientStops.Add((New-Object System.Windows.Media.GradientStop(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#1CFFFFFF'), 0.0)))
        [void]$film.GradientStops.Add((New-Object System.Windows.Media.GradientStop(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#08FFFFFF'), 1.0)))
        $film.Freeze()
        $script:RootCard.Background = $film
        $script:GlassSheen.Visibility = 'Visible'
        $script:GlassStreak.Visibility = 'Visible'
        $script:GlassRim.Visibility = 'Visible'
        $script:GlassRim.BorderBrush = $script:RimGradient
    }
    else {
        $script:RootCard.Margin = New-Object System.Windows.Thickness(12)
        $script:RootCard.CornerRadius = New-Object System.Windows.CornerRadius(16)
        $script:RootCard.Effect = $script:CardShadow
        $script:RootCard.BorderBrush = Get-Brush '#24FFFFFF'
        $script:RootCard.Background = $script:CardGradient
        $script:GlassSheen.Visibility = 'Collapsed'
        $script:GlassStreak.Visibility = 'Collapsed'
        $script:GlassRim.Visibility = 'Collapsed'
    }
    Set-GlassBackdrop $glass
}

$script:Compact = $false
function Set-CompactMode([bool]$On) {
    # compact = a little perch: logo + chips, no session rows. Everything
    # still lives (chirp, red pulse, taskbar flash) - it just takes no space.
    $script:Compact = $On
    if ($On) {
        $script:RowsScroll.Visibility = 'Collapsed'
        $script:Divider.Visibility = 'Collapsed'
        $script:Window.Width = 264
        $script:MiniBtn.Text = [string][char]0x25FB   # restore glyph
        $script:MiniBtn.ToolTip = 'expand (or double-click the header)'
    }
    else {
        $script:RowsScroll.Visibility = 'Visible'
        $script:Divider.Visibility = 'Visible'
        $script:Window.Width = 324
        $script:MiniBtn.Text = [string][char]0x2013   # minimize glyph
        $script:MiniBtn.ToolTip = 'compact mode (double-click the header works too)'
    }
}

# restore saved position + pin preference (default: top-right, pinned)
$script:UserTopmost = $true
$wa = [System.Windows.SystemParameters]::WorkArea
$Window.Left = $wa.Right - 324 - 8
$Window.Top  = $wa.Top + 8
try {
    if (Test-Path -LiteralPath $StatePath) {
        $st = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
        if ($null -ne $st.PSObject.Properties['Topmost']) {
            $script:UserTopmost = [bool]$st.Topmost
            $Window.Topmost = $script:UserTopmost
        }
        if ($null -ne $st.PSObject.Properties['Compact'] -and [bool]$st.Compact) {
            Set-CompactMode $true
        }
        if ($null -ne $st.Left -and $null -ne $st.Top) {
            $vl = [System.Windows.SystemParameters]::VirtualScreenLeft
            $vt = [System.Windows.SystemParameters]::VirtualScreenTop
            $vw = [System.Windows.SystemParameters]::VirtualScreenWidth
            $vh = [System.Windows.SystemParameters]::VirtualScreenHeight
            if ($st.Left -ge ($vl - 50) -and $st.Left -lt ($vl + $vw) -and
                $st.Top  -ge ($vt - 50) -and $st.Top  -lt ($vt + $vh)) {
                $Window.Left = [double]$st.Left
                $Window.Top  = [double]$st.Top
            }
        }
    }
}
catch { }

Apply-Theme   # brushes now; the acrylic backdrop needs an hwnd, so once more:
$Window.Add_SourceInitialized({ try { Set-GlassBackdrop ($script:ThemeName -eq 'glass') } catch { } })

function Show-RenameDialog([string]$Current) {
    $script:RenameResult = $null
    $dlg = New-Object System.Windows.Window
    $dlg.WindowStyle = 'None'; $dlg.AllowsTransparency = $true
    $dlg.Background = [System.Windows.Media.Brushes]::Transparent
    $dlg.SizeToContent = 'WidthAndHeight'
    $dlg.WindowStartupLocation = 'CenterOwner'
    $dlg.Owner = $script:Window
    $dlg.Topmost = $true; $dlg.ShowInTaskbar = $false

    $card = New-Object System.Windows.Controls.Border
    $card.CornerRadius = New-Object System.Windows.CornerRadius(12)
    $card.Background = Get-Brush '#F8202029'
    $card.BorderBrush = Get-Brush '#33FFFFFF'
    $card.BorderThickness = New-Object System.Windows.Thickness(1)
    $card.Padding = New-Object System.Windows.Thickness(16, 12, 16, 12)

    $stack = New-Object System.Windows.Controls.StackPanel
    $stack.Width = 230

    $title = New-Object System.Windows.Controls.TextBlock
    $title.Text = 'rename session'
    $title.FontSize = 11
    $title.Foreground = Get-Brush '#8A8A93'
    $title.Margin = New-Object System.Windows.Thickness(0, 0, 0, 8)
    [void]$stack.Children.Add($title)

    $box = New-Object System.Windows.Controls.TextBox
    $box.Text = $Current
    $box.FontSize = 12.5
    $box.Background = Get-Brush '#14FFFFFF'
    $box.Foreground = Get-Brush '#F4F4F8'
    $box.CaretBrush = Get-Brush '#F4F4F8'
    $box.BorderBrush = Get-Brush '#33FFFFFF'
    $box.Padding = New-Object System.Windows.Thickness(6, 4, 6, 4)
    $box.Tag = $dlg
    $box.Add_KeyDown({
        param($s, $e)
        if ($e.Key -eq 'Return') {
            $script:RenameResult = $s.Text
            $s.Tag.Close()
        }
        elseif ($e.Key -eq 'Escape') {
            $script:RenameResult = $null
            $s.Tag.Close()
        }
    })
    [void]$stack.Children.Add($box)

    $hint = New-Object System.Windows.Controls.TextBlock
    $hint.Text = 'Enter = save   empty = reset   Esc = cancel'
    $hint.FontSize = 10
    $hint.Foreground = Get-Brush '#6E6E78'
    $hint.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
    [void]$stack.Children.Add($hint)

    $card.Child = $stack
    $dlg.Content = $card
    $dlg.Add_ContentRendered({ param($s, $e) $s.Content.Child.Children[1].Focus(); $s.Content.Child.Children[1].SelectAll() })
    $script:UiHold++
    $script:UiHoldStamp = Get-Date
    try { [void]$dlg.ShowDialog() }
    finally { $script:UiHold = [Math]::Max(0, $script:UiHold - 1) }
    return $script:RenameResult
}

function New-DarkLabel([string]$Text) {
    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $Text
    $tb.FontSize = 10.5
    $tb.Foreground = Get-Brush '#8A8A93'
    $tb.Margin = New-Object System.Windows.Thickness(2, 10, 0, 4)
    return $tb
}

function Set-Toggle($Toggle, [bool]$On) {
    $Toggle.Tag = $On
    if ($On) {
        $Toggle.Background = Get-Brush '#E07B54'
        $Toggle.Child.HorizontalAlignment = 'Right'
    }
    else {
        $Toggle.Background = Get-Brush '#33FFFFFF'
        $Toggle.Child.HorizontalAlignment = 'Left'
    }
}

function New-Toggle([bool]$On) {
    $t = New-Object System.Windows.Controls.Border
    $t.Width = 34; $t.Height = 18
    $t.CornerRadius = New-Object System.Windows.CornerRadius(9)
    $t.VerticalAlignment = 'Center'
    $thumb = New-Object System.Windows.Shapes.Ellipse
    $thumb.Width = 12; $thumb.Height = 12
    $thumb.Fill = Get-Brush '#F4F4F8'
    $thumb.Margin = New-Object System.Windows.Thickness(3, 0, 3, 0)
    $thumb.VerticalAlignment = 'Center'
    $t.Child = $thumb
    Set-Toggle $t $On
    return $t
}

function New-SettingRow([string]$Label, [bool]$On) {
    # whole row is clickable and hoverable, like session rows. The toggle
    # lives in $row.Tag; its boolean state in $row.Tag.Tag.
    $row = New-Object System.Windows.Controls.Border
    $row.CornerRadius = New-Object System.Windows.CornerRadius(8)
    $row.Padding = New-Object System.Windows.Thickness(9, 7, 9, 7)
    $row.Margin = New-Object System.Windows.Thickness(0, 1, 0, 1)
    $row.Background = [System.Windows.Media.Brushes]::Transparent
    $row.Cursor = [System.Windows.Input.Cursors]::Hand

    $grid = New-Object System.Windows.Controls.Grid
    $c0 = New-Object System.Windows.Controls.ColumnDefinition
    $c0.Width = New-Object System.Windows.GridLength(1, 'Star')
    $c1 = New-Object System.Windows.Controls.ColumnDefinition
    $c1.Width = [System.Windows.GridLength]::Auto
    [void]$grid.ColumnDefinitions.Add($c0)
    [void]$grid.ColumnDefinitions.Add($c1)

    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $Label
    $tb.FontSize = 11.5
    $tb.Foreground = Get-Brush '#E4E4EA'
    $tb.VerticalAlignment = 'Center'
    $tb.TextTrimming = 'CharacterEllipsis'
    $tb.Margin = New-Object System.Windows.Thickness(0, 0, 10, 0)
    [System.Windows.Controls.Grid]::SetColumn($tb, 0)
    [void]$grid.Children.Add($tb)

    $toggle = New-Toggle $On
    [System.Windows.Controls.Grid]::SetColumn($toggle, 1)
    [void]$grid.Children.Add($toggle)

    $row.Child = $grid
    $row.Tag = $toggle
    $row.Add_MouseLeftButtonUp({ param($s, $e) Set-Toggle $s.Tag (-not [bool]$s.Tag.Tag) })
    $row.Add_MouseEnter({ param($s, $e) $s.Background = Get-Brush '#0FFFFFFF' })
    $row.Add_MouseLeave({ param($s, $e) $s.Background = [System.Windows.Media.Brushes]::Transparent })
    return $row
}

function New-InputBox([string]$Text) {
    # rounded dark input: Border wrapper + borderless TextBox (.Child)
    $wrap = New-Object System.Windows.Controls.Border
    $wrap.CornerRadius = New-Object System.Windows.CornerRadius(8)
    $wrap.Background = Get-Brush '#14FFFFFF'
    $wrap.BorderBrush = Get-Brush '#26FFFFFF'
    $wrap.BorderThickness = New-Object System.Windows.Thickness(1)
    $wrap.Padding = New-Object System.Windows.Thickness(9, 4, 9, 5)
    $box = New-Object System.Windows.Controls.TextBox
    $box.Text = $Text
    $box.FontSize = 12
    $box.Background = [System.Windows.Media.Brushes]::Transparent
    $box.BorderThickness = New-Object System.Windows.Thickness(0)
    $box.Foreground = Get-Brush '#F4F4F8'
    $box.CaretBrush = Get-Brush '#E07B54'
    $box.SelectionBrush = Get-Brush '#55E07B54'
    $wrap.Child = $box
    return $wrap
}

function New-DialogButton([string]$Text, [bool]$Primary) {
    $b = New-Object System.Windows.Controls.Border
    $b.CornerRadius = New-Object System.Windows.CornerRadius(9)
    $b.Cursor = [System.Windows.Input.Cursors]::Hand
    $b.Padding = New-Object System.Windows.Thickness(16, 5, 16, 6)
    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $Text
    $tb.FontSize = 11.5
    $tb.FontWeight = [System.Windows.FontWeights]::SemiBold
    if ($Primary) {
        $b.Background = Get-Brush '#E07B54'
        $tb.Foreground = Get-Brush '#1E1E27'
        $b.Add_MouseEnter({ param($s, $e) $s.Background = Get-Brush '#EC906F' })
        $b.Add_MouseLeave({ param($s, $e) $s.Background = Get-Brush '#E07B54' })
    }
    else {
        $b.Background = Get-Brush '#1AFFFFFF'
        $tb.Foreground = Get-Brush '#C0C0C8'
        $b.Add_MouseEnter({ param($s, $e) $s.Background = Get-Brush '#26FFFFFF' })
        $b.Add_MouseLeave({ param($s, $e) $s.Background = Get-Brush '#1AFFFFFF' })
    }
    $b.Child = $tb
    return $b
}

function Save-PerchSettings([bool]$Glass, [bool]$Chirp, [bool]$Timers, [bool]$HideAfter, [bool]$Startup, [string]$RefreshRaw, [string]$VolumeRaw, [string]$ProcsRaw) {
    $newTheme = $(if ($Glass) { 'glass' } else { 'midnight' })
    if ($newTheme -ne $script:ThemeName) {
        $script:ThemeName = $newTheme
        Apply-Theme
    }
    $script:ChirpOn = $Chirp
    $script:ShowTimers = $Timers
    $script:HudHideAfterFocus = $HideAfter

    $refresh = 0
    if ([int]::TryParse($RefreshRaw.Trim(), [ref]$refresh) -and $refresh -ge 1 -and $refresh -le 60) {
        $script:RefreshSeconds = $refresh
        if ($null -ne $script:Timer) { $script:Timer.Interval = [TimeSpan]::FromSeconds($refresh) }
    }

    $vol = 0
    if ([int]::TryParse($VolumeRaw.Trim(), [ref]$vol) -and $vol -ge 0 -and $vol -le 100) {
        $script:ChirpVolume = $vol
    }

    $names = @()
    foreach ($n in ($ProcsRaw -split '[,;\s]+')) {
        if ($n.Trim().Length -gt 0) { $names += $n.Trim().ToLowerInvariant() }
    }
    if ($names.Count -gt 0) {
        $script:AgentProcNames = $names
        $script:AgentProcRegex = '^(' + ((@($names) + @('node', 'bun', 'deno', 'python')) -join '|') + ')'
        $script:UntrackedStamp = [datetime]::MinValue   # rescan with new list soon
    }

    # start-with-windows = shortcut in the Startup folder
    try {
        $lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Perch.lnk'
        if ($Startup -and -not (Test-Path -LiteralPath $lnkPath)) {
            $ws = New-Object -ComObject WScript.Shell
            $lnk = $ws.CreateShortcut($lnkPath)
            $lnk.TargetPath = Join-Path $PSScriptRoot 'Perch.vbs'
            $lnk.WorkingDirectory = $PSScriptRoot
            $lnk.IconLocation = (Join-Path $PSScriptRoot 'icon.ico') + ',0'
            $lnk.Description = 'Perch - agent session HUD'
            $lnk.Save()
        }
        elseif (-not $Startup -and (Test-Path -LiteralPath $lnkPath)) {
            Remove-Item -LiteralPath $lnkPath -Force
        }
    }
    catch { }

    # persist
    try {
        $cfg = $null
        if (Test-Path -LiteralPath $CfgPath) { $cfg = Get-Content -LiteralPath $CfgPath -Raw | ConvertFrom-Json }
        if ($null -eq $cfg) { $cfg = [pscustomobject]@{} }
        $cfg | Add-Member -NotePropertyName RefreshSeconds    -NotePropertyValue $script:RefreshSeconds -Force
        $cfg | Add-Member -NotePropertyName HideAfterFocus    -NotePropertyValue $script:HudHideAfterFocus -Force
        $cfg | Add-Member -NotePropertyName ChirpOnAttention  -NotePropertyValue $script:ChirpOn -Force
        $cfg | Add-Member -NotePropertyName ChirpVolume       -NotePropertyValue $script:ChirpVolume -Force
        $cfg | Add-Member -NotePropertyName ThemeName         -NotePropertyValue $script:ThemeName -Force
        $cfg | Add-Member -NotePropertyName ShowWorkTimers    -NotePropertyValue $script:ShowTimers -Force
        $cfg | Add-Member -NotePropertyName AgentProcessNames -NotePropertyValue $script:AgentProcNames -Force
        $cfg | ConvertTo-Json | Set-Content -LiteralPath $CfgPath -Encoding UTF8
    }
    catch { }

    Update-List -Force
}

function Show-SettingsDialog {
    $dlg = New-Object System.Windows.Window
    $dlg.WindowStyle = 'None'; $dlg.AllowsTransparency = $true
    $dlg.Background = [System.Windows.Media.Brushes]::Transparent
    $dlg.SizeToContent = 'WidthAndHeight'
    $dlg.WindowStartupLocation = 'CenterOwner'
    $dlg.Owner = $script:Window
    $dlg.Topmost = $true; $dlg.ShowInTaskbar = $false

    $card = New-Object System.Windows.Controls.Border
    $card.CornerRadius = New-Object System.Windows.CornerRadius(14)
    $grad = New-Object System.Windows.Media.LinearGradientBrush
    $grad.StartPoint = New-Object System.Windows.Point(0, 0)
    $grad.EndPoint = New-Object System.Windows.Point(0, 1)
    [void]$grad.GradientStops.Add((New-Object System.Windows.Media.GradientStop(
        [System.Windows.Media.ColorConverter]::ConvertFromString('#FA1F1F28'), 0.0)))
    [void]$grad.GradientStops.Add((New-Object System.Windows.Media.GradientStop(
        [System.Windows.Media.ColorConverter]::ConvertFromString('#FA15151A'), 1.0)))
    $card.Background = $grad
    $card.BorderBrush = Get-Brush '#2AFFFFFF'
    $card.BorderThickness = New-Object System.Windows.Thickness(1)
    $card.Padding = New-Object System.Windows.Thickness(14, 12, 14, 14)
    $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
    $shadow.BlurRadius = 16; $shadow.ShadowDepth = 0; $shadow.Opacity = 0.55
    $card.Effect = $shadow
    $card.Margin = New-Object System.Windows.Thickness(10)

    $stack = New-Object System.Windows.Controls.StackPanel
    $stack.Width = 266

    # header: bird + title (draggable)
    $head = New-Object System.Windows.Controls.StackPanel
    $head.Orientation = 'Horizontal'
    $head.Margin = New-Object System.Windows.Thickness(2, 0, 0, 10)
    $head.Background = [System.Windows.Media.Brushes]::Transparent
    if ($null -ne $script:LogoSource) {
        $hImg = New-Object System.Windows.Controls.Image
        $hImg.Source = $script:LogoSource
        $hImg.Width = 15; $hImg.Height = 15
        $hImg.Margin = New-Object System.Windows.Thickness(0, 0, 7, 0)
        [void]$head.Children.Add($hImg)
    }
    $title = New-Object System.Windows.Controls.TextBlock
    $title.Text = 'settings'
    $title.FontSize = 12.5
    $title.FontWeight = [System.Windows.FontWeights]::SemiBold
    $title.Foreground = Get-Brush '#F4F4F8'
    $title.VerticalAlignment = 'Center'
    [void]$head.Children.Add($title)
    $head.Tag = $dlg
    $head.Add_MouseLeftButtonDown({ param($s, $e) try { $s.Tag.DragMove() } catch { } })
    [void]$stack.Children.Add($head)

    $startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Perch.lnk'
    $rowGlass   = New-SettingRow 'liquid glass theme'                 ($script:ThemeName -eq 'glass')
    $rowChirp   = New-SettingRow 'chirp when a session needs me'      $script:ChirpOn
    $rowTimers  = New-SettingRow 'show work timers on busy sessions'  $script:ShowTimers
    $rowHide    = New-SettingRow 'minimize after click-to-focus'      $script:HudHideAfterFocus
    $rowStartup = New-SettingRow 'start with windows'                 (Test-Path -LiteralPath $startupLnk)
    foreach ($r in @($rowGlass, $rowChirp, $rowTimers, $rowHide, $rowStartup)) { [void]$stack.Children.Add($r) }

    $sep = New-Object System.Windows.Controls.Border
    $sep.Height = 1
    $sep.Background = Get-Brush '#14FFFFFF'
    $sep.Margin = New-Object System.Windows.Thickness(2, 8, 2, 0)
    [void]$stack.Children.Add($sep)

    $numRow = New-Object System.Windows.Controls.StackPanel
    $numRow.Orientation = 'Horizontal'
    $colRefresh = New-Object System.Windows.Controls.StackPanel
    [void]$colRefresh.Children.Add((New-DarkLabel 'refresh every (seconds)'))
    $inRefresh = New-InputBox ([string]$script:RefreshSeconds)
    $inRefresh.Width = 64
    $inRefresh.HorizontalAlignment = 'Left'
    [void]$colRefresh.Children.Add($inRefresh)
    $colVolume = New-Object System.Windows.Controls.StackPanel
    $colVolume.Margin = New-Object System.Windows.Thickness(18, 0, 0, 0)
    [void]$colVolume.Children.Add((New-DarkLabel 'chirp volume (%)'))
    $inVolume = New-InputBox ([string]$script:ChirpVolume)
    $inVolume.Width = 64
    $inVolume.HorizontalAlignment = 'Left'
    [void]$colVolume.Children.Add($inVolume)
    [void]$numRow.Children.Add($colRefresh)
    [void]$numRow.Children.Add($colVolume)
    [void]$stack.Children.Add($numRow)

    [void]$stack.Children.Add((New-DarkLabel 'agent process names'))
    $inProcs = New-InputBox ($script:AgentProcNames -join ', ')
    [void]$stack.Children.Add($inProcs)

    $btnRow = New-Object System.Windows.Controls.StackPanel
    $btnRow.Orientation = 'Horizontal'
    $btnRow.HorizontalAlignment = 'Right'
    $btnRow.Margin = New-Object System.Windows.Thickness(0, 16, 0, 0)
    $btnSave = New-DialogButton 'save' $true
    $btnSave.Margin = New-Object System.Windows.Thickness(0, 0, 8, 0)
    $btnCancel = New-DialogButton 'cancel' $false
    [void]$btnRow.Children.Add($btnSave)
    [void]$btnRow.Children.Add($btnCancel)
    [void]$stack.Children.Add($btnRow)

    $card.Child = $stack
    $dlg.Content = $card

    $dlg.Tag = @{
        Glass = $rowGlass.Tag; Chirp = $rowChirp.Tag; Timers = $rowTimers.Tag; Hide = $rowHide.Tag; Startup = $rowStartup.Tag
        Refresh = $inRefresh.Child; Volume = $inVolume.Child; Procs = $inProcs.Child
    }
    $btnSave.Tag = $dlg
    $btnCancel.Tag = $dlg
    $btnSave.Add_MouseLeftButtonUp({
        param($s, $e)
        $c = $s.Tag.Tag
        Save-PerchSettings ([bool]$c.Glass.Tag) ([bool]$c.Chirp.Tag) ([bool]$c.Timers.Tag) ([bool]$c.Hide.Tag) `
                           ([bool]$c.Startup.Tag) ([string]$c.Refresh.Text) ([string]$c.Volume.Text) ([string]$c.Procs.Text)
        $s.Tag.Close()
    })
    $btnCancel.Add_MouseLeftButtonUp({ param($s, $e) $s.Tag.Close() })
    $dlg.Add_KeyDown({ param($s, $e) if ($e.Key -eq 'Escape') { $s.Close() } })

    $script:UiHold++
    $script:UiHoldStamp = Get-Date
    try { [void]$dlg.ShowDialog() }
    finally { $script:UiHold = [Math]::Max(0, $script:UiHold - 1) }
}

$script:ChirpPlayer = $null   # one MediaPlayer, reused (has real volume control)
function Invoke-Chirp {
    if (-not $script:ChirpOn) { return }
    # a real bird, not a beep: picks a random .wav from sounds/ every time
    # (drop your own in there; they're not committed - see README). Played
    # through MediaPlayer because SoundPlayer has NO volume knob and a full-
    # blast tropical squeak at 2am is a jump scare, not a notification.
    try {
        $wavs = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'sounds') -Filter '*.wav' -ErrorAction SilentlyContinue)
        if ($wavs.Count -gt 0) {
            $pick = $wavs[(Get-Random -Maximum $wavs.Count)]
            if ($null -eq $script:ChirpPlayer) {
                $script:ChirpPlayer = New-Object System.Windows.Media.MediaPlayer
            }
            $script:ChirpPlayer.Open([Uri]$pick.FullName)
            $script:ChirpPlayer.Volume = [Math]::Max(0.0, [Math]::Min(1.0, $script:ChirpVolume / 100.0))
            $script:ChirpPlayer.Play()   # async, never blocks the UI thread
            return
        }
    }
    catch { }
    try {
        # no wavs installed: the trusty old synth chirp
        [Console]::Beep(1568, 70)
        [Console]::Beep(2093, 90)
    }
    catch { }
}

function New-RowMenu($Sess) {
    $menu = New-Object System.Windows.Controls.ContextMenu
    $menu.Style = $script:Window.FindResource('HudMenu')
    $menu.Add_Opened({ $script:UiHold++; $script:UiHoldStamp = Get-Date })
    $menu.Add_Closed({ $script:UiHold = [Math]::Max(0, $script:UiHold - 1) })
    $miStyle = $script:Window.FindResource('HudMenuItem')

    $miPin = New-Object System.Windows.Controls.MenuItem
    $miPin.Style = $miStyle
    $miPin.Header = $(if ($Sess.Pinned) { 'Unpin' } else { 'Pin to top' })
    $miPin.Tag = $Sess
    $miPin.Add_Click({
        param($s, $e)
        Set-Pref $s.Tag 'pinned' (-not [bool]$s.Tag.Pinned)
        Update-List -Force
    })
    [void]$menu.Items.Add($miPin)

    $miRen = New-Object System.Windows.Controls.MenuItem
    $miRen.Style = $miStyle
    $miRen.Header = 'Rename...'
    $miRen.Tag = $Sess
    $miRen.Add_Click({
        param($s, $e)
        $newName = Show-RenameDialog ([string]$s.Tag.DisplayName)
        if ($null -ne $newName) {
            Set-Pref $s.Tag 'name' $newName.Trim()
            Update-List -Force
        }
    })
    [void]$menu.Items.Add($miRen)

    $miHide = New-Object System.Windows.Controls.MenuItem
    $miHide.Style = $miStyle
    $miHide.Header = 'Hide until next change'
    $miHide.Tag = $Sess
    $miHide.Add_Click({
        param($s, $e)
        $script:Dismissed[$s.Tag.Id] = $s.Tag.Ts
        Update-List -Force
    })
    [void]$menu.Items.Add($miHide)

    return $menu
}

function Invoke-AttentionRaise {
    # a session just flipped to "needs you": resurface the HUD (no focus steal)
    try {
        Invoke-Chirp
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:Window)
        if ($script:UserTopmost) {
            # pinned: make sure the HUD is visible above everything (no focus steal)
            if ($script:Window.WindowState -ne 'Normal') { $script:Window.WindowState = 'Normal' }
            $script:Window.Topmost = $true
            if ($helper.Handle -ne [IntPtr]::Zero) {
                # HWND_TOPMOST, SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE
                [void][ClaudeHud.Native]::SetWindowPos($helper.Handle, [IntPtr](-1), 0, 0, 0, 0, 0x13)
            }
        }
        elseif ($helper.Handle -ne [IntPtr]::Zero) {
            # unpinned: NEVER jump over the user's windows - flash the taskbar
            [ClaudeHud.Native]::Flash($helper.Handle, 5)
        }
        $eff = $script:RootCard.Effect
        if ($null -ne $eff) {
            $dur = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(650))
            $ca = New-Object System.Windows.Media.Animation.ColorAnimation(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#FF6B6B'),
                [System.Windows.Media.ColorConverter]::ConvertFromString('#000000'), $dur)
            $ca.RepeatBehavior = New-Object System.Windows.Media.Animation.RepeatBehavior(4)
            $eff.BeginAnimation([System.Windows.Media.Effects.DropShadowEffect]::ColorProperty, $ca)
            $oa = New-Object System.Windows.Media.Animation.DoubleAnimation(0.95, 0.55, $dur)
            $oa.RepeatBehavior = New-Object System.Windows.Media.Animation.RepeatBehavior(4)
            $eff.BeginAnimation([System.Windows.Media.Effects.DropShadowEffect]::OpacityProperty, $oa)
        }
        elseif ($script:ThemeName -eq 'glass' -and $null -ne $script:GlassRim) {
            # glass has no drop shadow to pulse - flash the rim red instead,
            # then hand the light back to the white gradient
            $dur = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(650))
            $pulse = New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#FF6B6B'))
            $script:GlassRim.BorderBrush = $pulse
            $ca = New-Object System.Windows.Media.Animation.ColorAnimation(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#FF6B6B'),
                [System.Windows.Media.ColorConverter]::ConvertFromString('#30FFFFFF'), $dur)
            $ca.RepeatBehavior = New-Object System.Windows.Media.Animation.RepeatBehavior(4)
            $ca.Add_Completed({
                try { $script:GlassRim.BorderBrush = $script:RimGradient } catch { }
            })
            $pulse.BeginAnimation([System.Windows.Media.SolidColorBrush]::ColorProperty, $ca)
        }
    }
    catch { }
}

function New-Chip([string]$Text, [string]$Hex) {
    $chip = New-Object System.Windows.Controls.Border
    $chip.CornerRadius = New-Object System.Windows.CornerRadius(9)
    $chip.Padding = New-Object System.Windows.Thickness(8, 2, 8, 3)
    $chip.Margin = New-Object System.Windows.Thickness(0, 0, 6, 0)
    $chip.Background = Get-Brush ('#22' + $Hex.Substring(1))
    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $Text
    $tb.FontSize = 10.5
    $tb.FontWeight = [System.Windows.FontWeights]::SemiBold
    $tb.Foreground = Get-Brush $Hex
    $chip.Child = $tb
    return $chip
}

function New-SessionRow($Sess) {
    $meta = Get-StatusMeta $Sess.Status

    $row = New-Object System.Windows.Controls.Border
    $row.CornerRadius = New-Object System.Windows.CornerRadius(10)
    $row.Padding = New-Object System.Windows.Thickness(10, 7, 10, 8)
    $row.Margin = New-Object System.Windows.Thickness(2, 1, 2, 1)
    $row.Background = Get-RowBaseBrush $Sess
    $row.Cursor = [System.Windows.Input.Cursors]::Hand
    $row.Tag = $Sess

    $grid = New-Object System.Windows.Controls.Grid
    foreach ($wdef in @('Auto', '*')) {
        $cd = New-Object System.Windows.Controls.ColumnDefinition
        if ($wdef -eq 'Auto') { $cd.Width = [System.Windows.GridLength]::Auto }
        else { $cd.Width = New-Object System.Windows.GridLength(1, 'Star') }
        [void]$grid.ColumnDefinitions.Add($cd)
    }

    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 8; $dot.Height = 8
    $dot.Fill = Get-Brush $meta.Color
    $dot.Margin = New-Object System.Windows.Thickness(1, 5, 10, 0)
    $dot.VerticalAlignment = 'Top'
    $glow = New-Object System.Windows.Media.Effects.DropShadowEffect
    $glow.BlurRadius = 8
    $glow.ShadowDepth = 0
    $glow.Opacity = 0.85
    $glow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($meta.Color)
    $dot.Effect = $glow
    [System.Windows.Controls.Grid]::SetColumn($dot, 0)
    [void]$grid.Children.Add($dot)
    if ($Sess.Status -eq 'working' -or $Sess.Status -eq 'attention') {
        $anim = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.3,
            (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(850))))
        $anim.AutoReverse = $true
        $anim.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
        $dot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $anim)
    }

    $mid = New-Object System.Windows.Controls.StackPanel
    [System.Windows.Controls.Grid]::SetColumn($mid, 1)

    # line 1: project name + age
    $line1 = New-Object System.Windows.Controls.Grid
    foreach ($wdef in @('*', 'Auto')) {
        $cd = New-Object System.Windows.Controls.ColumnDefinition
        if ($wdef -eq 'Auto') { $cd.Width = [System.Windows.GridLength]::Auto }
        else { $cd.Width = New-Object System.Windows.GridLength(1, 'Star') }
        [void]$line1.ColumnDefinitions.Add($cd)
    }
    $name = New-Object System.Windows.Controls.TextBlock
    $name.Text = $(if ($Sess.Pinned) { [char]::ConvertFromUtf32(0x1F4CC) + ' ' + $Sess.DisplayName } else { $Sess.DisplayName })
    $name.FontSize = 12.5
    $name.FontWeight = [System.Windows.FontWeights]::SemiBold
    $name.Foreground = Get-Brush '#F4F4F8'
    $name.TextTrimming = 'CharacterEllipsis'
    [System.Windows.Controls.Grid]::SetColumn($name, 0)
    [void]$line1.Children.Add($name)
    $age = New-Object System.Windows.Controls.TextBlock
    $age.Text = Format-Age $Sess.Ts
    $age.FontSize = 10.5
    $age.Foreground = Get-Brush '#5F5F6A'
    $age.VerticalAlignment = 'Center'
    $age.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
    [System.Windows.Controls.Grid]::SetColumn($age, 1)
    [void]$line1.Children.Add($age)
    [void]$mid.Children.Add($line1)

    # line 2: colored status + message snippet
    $snippet = ($Sess.Message -replace '\s+', ' ').Trim()
    if ($snippet.Length -gt 70) { $snippet = $snippet.Substring(0, 70) }
    $label = $meta.Label
    if ($Sess.Status -eq 'working' -and $script:ShowTimers -and $script:WorkSince.ContainsKey($Sess.Id)) {
        $workSpan = (Get-Date) - $script:WorkSince[$Sess.Id]
        if ($workSpan.TotalSeconds -ge 90) { $label = "working $(Format-Age $script:WorkSince[$Sess.Id])" }
    }
    if ($Sess.Provider -and $Sess.Provider -ne 'claude') { $label = "$($Sess.Provider)$($script:Sep)$label" }
    $sub = New-Object System.Windows.Controls.TextBlock
    $sub.FontSize = 10.5
    $sub.TextTrimming = 'CharacterEllipsis'
    $sub.Margin = New-Object System.Windows.Thickness(0, 1, 0, 0)
    $runStatus = New-Object System.Windows.Documents.Run($label)
    $runStatus.Foreground = Get-Brush $meta.Color
    $runStatus.FontWeight = [System.Windows.FontWeights]::SemiBold
    [void]$sub.Inlines.Add($runStatus)
    if ($snippet.Length -gt 0) {
        $runMsg = New-Object System.Windows.Documents.Run("$($script:Dash)$snippet")
        $runMsg.Foreground = Get-Brush '#8B8B95'
        [void]$sub.Inlines.Add($runMsg)
    }
    [void]$mid.Children.Add($sub)
    [void]$grid.Children.Add($mid)

    $row.Child = $grid

    $tipTab = ''
    if ($null -ne $Sess.Window -and $Sess.Window.PSObject.Properties['tab_name']) {
        $tipTab = [string]$Sess.Window.tab_name
    }
    $tipCwd = $Sess.Cwd
    if ([string]::IsNullOrWhiteSpace($tipCwd)) { $tipCwd = '(untracked - folder unknown)' }
    $row.ToolTip = "$tipCwd`ntab: $tipTab`n`n$($Sess.Message)`n`nclick = focus$($script:Sep)right-click = pin / rename / hide"

    $row.Add_MouseEnter({
        param($s, $e)
        if ($s.Tag.Status -eq 'attention' -or $s.Tag.Status -eq 'error') { $s.Background = Get-Brush '#26FF6B6B' }
        else { $s.Background = Get-Brush '#12FFFFFF' }
    })
    $row.Add_MouseLeave({ param($s, $e) $s.Background = Get-RowBaseBrush $s.Tag })
    $row.Add_MouseLeftButtonUp({
        param($s, $e)
        $ok = Invoke-FocusSession $s.Tag
        if ($ok -and $script:HudHideAfterFocus) { $script:Window.WindowState = 'Minimized' }
        if (-not $ok) { $s.Background = Get-Brush '#33FF6B6B' }
    })
    $row.ContextMenu = New-RowMenu $Sess
    return $row
}

function Update-List {
    # don't rebuild rows while a context menu or dialog is open, and never
    # re-enter (nested WPF message pumps can overlap timer ticks and stop
    # each other's pipelines). -Force is for user actions (pin/rename/hide)
    # that must reflect IMMEDIATELY even though their menu is mid-close.
    # BOTH guards are time-limited: a PipelineStoppedException can abort a
    # tick without running its finally, and a stuck flag froze the HUD once -
    # stale flags are reclaimed instead of trusted forever.
    param([switch]$Force)
    if (-not $Force) {
        if ($script:UiHold -gt 0) {
            if (((Get-Date) - $script:UiHoldStamp).TotalSeconds -gt 90) { $script:UiHold = 0 }
            else { return }
        }
        if ($script:InTick -and ((Get-Date) - $script:InTickStamp).TotalSeconds -lt 30) { return }
    }
    $script:InTick = $true
    $script:InTickStamp = Get-Date
    $script:ProbeBudget = 4
    try {

    $sessions = @(Get-Sessions)

    # drop dismissed rows until their status file changes again
    $visible = New-Object System.Collections.ArrayList
    foreach ($s in $sessions) {
        if ($script:Dismissed.ContainsKey($s.Id)) {
            if ($s.Ts -le $script:Dismissed[$s.Id]) { continue }
            $script:Dismissed.Remove($s.Id)
        }
        [void]$visible.Add($s)
    }

    # track how long each session has been continuously working
    $liveIds = @{}
    foreach ($s in $visible) {
        $liveIds[$s.Id] = $true
        if ($s.Status -eq 'working') {
            if (-not $script:WorkSince.ContainsKey($s.Id)) { $script:WorkSince[$s.Id] = Get-Date }
        }
        else {
            [void]$script:WorkSince.Remove($s.Id)
        }
    }
    foreach ($k in @($script:WorkSince.Keys)) {
        if (-not $liveIds.ContainsKey($k)) { [void]$script:WorkSince.Remove($k) }
    }

    $script:SessionList.Children.Clear()
    if ($visible.Count -eq 0) {
        $emptyStack = New-Object System.Windows.Controls.StackPanel
        $emptyStack.HorizontalAlignment = 'Center'
        $emptyStack.Margin = New-Object System.Windows.Thickness(0, 14, 0, 14)
        if ($null -ne $script:LogoSource) {
            $birdImg = New-Object System.Windows.Controls.Image
            $birdImg.Source = $script:LogoSource
            $birdImg.Width = 42; $birdImg.Height = 42
            $birdImg.Opacity = 0.9
            $birdImg.HorizontalAlignment = 'Center'
            $birdImg.Margin = New-Object System.Windows.Thickness(0, 0, 0, 8)
            [void]$emptyStack.Children.Add($birdImg)
        }
        $empty = New-Object System.Windows.Controls.TextBlock
        $empty.Text = 'all quiet' + $script:Dash.TrimEnd() + ' no live sessions'
        $empty.FontSize = 11.5
        $empty.Foreground = Get-Brush '#6E6E78'
        $empty.HorizontalAlignment = 'Center'
        [void]$emptyStack.Children.Add($empty)
        [void]$script:SessionList.Children.Add($emptyStack)
    }
    else {
        foreach ($s in $visible) {
            [void]$script:SessionList.Children.Add((New-SessionRow $s))
        }
    }

    $script:ChipsPanel.Children.Clear()
    $att   = @($visible | Where-Object { $_.Status -eq 'attention' -or $_.Status -eq 'error' }).Count
    $work  = @($visible | Where-Object { $_.Status -eq 'working' }).Count
    $done  = @($visible | Where-Object { $_.Status -eq 'idle' }).Count
    $quiet = @($visible | Where-Object { $_.Status -eq 'quiet' }).Count
    if ($att -gt 0)   { [void]$script:ChipsPanel.Children.Add((New-Chip "$att need you" '#FF6B6B')) }
    if ($work -gt 0)  { [void]$script:ChipsPanel.Children.Add((New-Chip "$work working" '#FFB84D')) }
    if ($done -gt 0)  { [void]$script:ChipsPanel.Children.Add((New-Chip "$done done" '#5ED584')) }
    if ($quiet -gt 0) { [void]$script:ChipsPanel.Children.Add((New-Chip "$quiet quiet" '#8FA0C8')) }
    if ($script:ChipsPanel.Children.Count -eq 0) {
        [void]$script:ChipsPanel.Children.Add((New-Chip 'all quiet' '#71717A'))
    }

    # resurface the HUD when a session NEWLY needs attention
    $curAtt = @{}
    foreach ($s in $visible) {
        if ($s.Status -eq 'attention' -or $s.Status -eq 'error') { $curAtt[$s.Id] = $true }
    }
    $hasNew = $false
    foreach ($k in $curAtt.Keys) {
        if (-not $script:PrevAttention.ContainsKey($k)) { $hasNew = $true; break }
    }
    if ($hasNew) { Invoke-AttentionRaise }
    $script:PrevAttention = $curAtt

    }
    catch { }
    finally { $script:InTick = $false }
}

# the header buttons must swallow mouse-down BEFORE it bubbles to the
# header, otherwise DragMove() starts a window drag and eats their click
$PinBtn.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
$CloseBtn.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
$GearBtn.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
$script:MiniBtn.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
$GearBtn.Add_MouseLeftButtonUp({ Show-SettingsDialog })
$script:MiniBtn.Add_MouseLeftButtonUp({
    Set-CompactMode (-not $script:Compact)
    Save-HudState
})
# double-click the header or chips row = toggle compact; single click = drag
$script:HeaderClick = {
    param($s, $e)
    if ($e.ClickCount -eq 2) {
        Set-CompactMode (-not $script:Compact)
        Save-HudState
        $e.Handled = $true
        return
    }
    try { $script:Window.DragMove() } catch { }
}
$Header.Add_MouseLeftButtonDown($script:HeaderClick)
$ChipsPanel.Add_MouseLeftButtonDown($script:HeaderClick)
function Save-HudState {
    try {
        @{ Left = $script:Window.Left; Top = $script:Window.Top
           Topmost = $script:UserTopmost; Compact = $script:Compact } |
            ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding UTF8
    }
    catch { }
}

$CloseBtn.Add_MouseLeftButtonUp({ $script:Window.Close() })
$PinBtn.Add_MouseLeftButtonUp({
    $script:UserTopmost = -not $script:UserTopmost
    $script:Window.Topmost = $script:UserTopmost
    if ($script:UserTopmost) { $script:PinBtn.Opacity = 1.0 } else { $script:PinBtn.Opacity = 0.35 }
    Save-HudState
})
if (-not $script:UserTopmost) { $PinBtn.Opacity = 0.35 }

$Window.Add_Closing({ Save-HudState })

$script:Timer = New-Object System.Windows.Threading.DispatcherTimer
$script:Timer.Interval = [TimeSpan]::FromSeconds($RefreshSeconds)
$script:Timer.Add_Tick({ Update-List })
$script:Timer.Start()

# defer the first untracked-process scan: the window must be visible before
# any potentially slow console probing happens
$script:UntrackedStamp = Get-Date

Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-boot.log') -Value "$(Get-Date -Format s) first-update" -ErrorAction SilentlyContinue
Update-List
Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-boot.log') -Value "$(Get-Date -Format s) showdialog" -ErrorAction SilentlyContinue
[void]$Window.ShowDialog()
