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
$script:ChirpDoneOn = $true   # a finish SOUND is the thing you're waiting for - on by default
$script:ChirpVolume = 10   # percent - birds are for noticing, not startling
$script:ParkMinutes = 30   # needs-you older than this -> 'parked' (0 = never)
$script:CompactAtK = 120   # context (k tokens) past which a row grows its compact button (0 = never)
$script:ShowTimers = $true
$script:ThemeName = 'midnight'   # any key of $script:ThemeSpecs (midnight/oled/glass/phosphor/nord/catppuccin/synthwave)
$script:MascotPack = 'bird'      # 'bird' = built-in (root logo.png + assets\bird\); else assets\mascots\<name>\
$script:AcctDisclaimerOk = $false
$script:AcctPanel = $null
try {
    if (Test-Path -LiteralPath $CfgPath) {
        $cfg = Get-Content -LiteralPath $CfgPath -Raw | ConvertFrom-Json
        if ($cfg.RefreshSeconds) { $RefreshSeconds = [int]$cfg.RefreshSeconds }
        if ($null -ne $cfg.PSObject.Properties['HideAfterFocus']) { $HideAfterFocus = [bool]$cfg.HideAfterFocus }
        if ($null -ne $cfg.PSObject.Properties['ChirpOnAttention']) { $script:ChirpOn = [bool]$cfg.ChirpOnAttention }
        if ($null -ne $cfg.PSObject.Properties['ChirpOnDone']) { $script:ChirpDoneOn = [bool]$cfg.ChirpOnDone }
        if ($null -ne $cfg.PSObject.Properties['ChirpVolume']) { $script:ChirpVolume = [int]$cfg.ChirpVolume }
        if ($null -ne $cfg.PSObject.Properties['ParkAfterMinutes']) { $script:ParkMinutes = [int]$cfg.ParkAfterMinutes }
        if ($null -ne $cfg.PSObject.Properties['CompactAtK']) { $script:CompactAtK = [int]$cfg.CompactAtK }
        if ($null -ne $cfg.PSObject.Properties['ShowWorkTimers']) { $script:ShowTimers = [bool]$cfg.ShowWorkTimers }
        if ($null -ne $cfg.PSObject.Properties['ThemeName']) { $script:ThemeName = [string]$cfg.ThemeName }
        if ($null -ne $cfg.PSObject.Properties['MascotPack'] -and -not [string]::IsNullOrWhiteSpace([string]$cfg.MascotPack)) { $script:MascotPack = [string]$cfg.MascotPack }
        if ($null -ne $cfg.PSObject.Properties['AccountsDisclaimerOk']) { $script:AcctDisclaimerOk = [bool]$cfg.AccountsDisclaimerOk }
        if ($cfg.PSObject.Properties['AgentProcessNames'] -and $cfg.AgentProcessNames) {
            $AgentProcNames = @($cfg.AgentProcessNames | ForEach-Object { [string]$_ })
        }
    }
}
catch { }
# processes that count as "an agent CLI" for liveness + untracked discovery
$script:AgentProcRegex = '^(' + ((@($AgentProcNames) + @('node', 'bun', 'deno', 'python')) -join '|') + ')'

function Set-ContentAtomic([string]$Path, [string]$Text) {
    # tmp + rename: a power cut mid-write must never leave a TRUNCATED file.
    # (A friend's PC crash taught us what half-written JSON does to a boot -
    # config and state writes get the same law the hook status files follow.)
    $tmp = $Path + '.tmp'
    Set-Content -LiteralPath $tmp -Value $Text -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

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
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
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
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue   # SendKeys for the compact button

# ---------- session model ----------
$script:StatusMeta = @{
    'attention'  = @{ Rank = 0; Color = '#FF6B6B'; Label = 'needs you'  }
    'error'      = @{ Rank = 1; Color = '#FF6B6B'; Label = 'failed'     }
    'retrying'   = @{ Rank = 1; Color = '#FF8F5E'; Label = 'api retry'  }
    'working'    = @{ Rank = 2; Color = '#FFB84D'; Label = 'working'    }
    'compacting' = @{ Rank = 2; Color = '#B48EF0'; Label = 'compacting' }
    'idle'       = @{ Rank = 3; Color = '#5ED584'; Label = 'done'       }
    'parked'     = @{ Rank = 4; Color = '#9A7B85'; Label = 'parked'     }
    'quiet'      = @{ Rank = 5; Color = '#8FA0C8'; Label = 'quiet'      }
}

function Get-StatusMeta([string]$Status) {
    if ($script:StatusMeta.ContainsKey($Status)) { return $script:StatusMeta[$Status] }
    return @{ Rank = 5; Color = '#71717A'; Label = $Status }
}

$script:NativeCache = @{}   # pid -> {LWT; Val}: parse-once cache for the native state files
function Get-NativeAgentStatus([int]$AgentPid, $Proc) {
    # THE STEAL (thanks, claude-busy-monitor): claude code self-reports live
    # per-process state in ~/.claude/sessions/<pid>.json - status busy/shell/
    # idle/waiting, rewritten the moment it changes. It is the CLI's own word:
    # it knows about BACKGROUND TASKS the hook lane is blind to (a bg agent
    # filming for 10 minutes keeps status=busy while the hooks said idle at
    # Stop), and it flips idle instantly on Esc-interrupts the hooks skip.
    # pid reuse is guarded by procStart (process start ticks, 10ms tolerance -
    # claude reads the start time via a different API and lands 1 tick off).
    try {
        $f = Join-Path $env:USERPROFILE ".claude\sessions\$AgentPid.json"
        $fi = [System.IO.FileInfo]::new($f)
        if (-not $fi.Exists) { return $null }
        $cached = $script:NativeCache[$AgentPid]
        if ($null -ne $cached -and $cached.LWT -eq $fi.LastWriteTimeUtc) { return $cached.Val }
        $j = [IO.File]::ReadAllText($f) | ConvertFrom-Json
        $val = $null
        $ok = $true
        if ($null -ne $j.PSObject.Properties['procStart'] -and $null -ne $Proc) {
            [long]$ps = 0
            if ([long]::TryParse([string]$j.procStart, [ref]$ps)) {
                if ([Math]::Abs($Proc.StartTime.Ticks - $ps) -gt 100000) { $ok = $false }   # 10ms: pid was reused
            }
        }
        if ($ok) {
            $val = switch ([string]$j.status) {
                'busy'    { 'working'; break }
                'shell'   { 'working'; break }
                'waiting' { 'attention'; break }
                'idle'    { 'idle'; break }
                default   { $null }
            }
        }
        $script:NativeCache[$AgentPid] = @{ LWT = $fi.LastWriteTimeUtc; Val = $val }
        return $val
    }
    catch { return $null }
}

function Format-Age([datetime]$Ts) {
    $span = (Get-Date) - $Ts
    if ($span.TotalSeconds -lt 60) { return 'now' }
    if ($span.TotalMinutes -lt 60) { return ('{0}m' -f [int][math]::Floor($span.TotalMinutes)) }
    if ($span.TotalHours -lt 24)   { return ('{0}h' -f [int][math]::Floor($span.TotalHours)) }
    return ('{0}d' -f [int][math]::Floor($span.TotalDays))
}

# these two string helpers MUST live above Get-Sessions: PowerShell only
# registers a function when its `function` statement EXECUTES (no hoisting),
# and -Probe mode calls Get-Sessions from mid-script - with the helpers
# defined at the bottom, the probe path exploded on CommandNotFoundException
# while the GUI (whose loop starts after the last line) never noticed.
# First external install caught it. Thanks, friend.
function Repair-Mojibake([string]$T) {
    # the hook used to read stdin with the OEM codepage, so UTF-8 punctuation
    # arrived as CP850 mojibake (em-dash showed as garble). Reverse it: re-encode as
    # CP850, re-decode as STRICT UTF-8 - both steps throw unless the text
    # really is mojibake, so organic text (even actual Greek) survives intact.
    if ([string]::IsNullOrEmpty($T) -or $T.IndexOf([char]0x0393) -lt 0) { return $T }
    foreach ($cp in @(437, 850)) {   # U+0393 at 0xE2 is CP437; 850 kept as spare
        try {
            $enc = [System.Text.Encoding]::GetEncoding($cp,
                (New-Object System.Text.EncoderExceptionFallback),
                (New-Object System.Text.DecoderExceptionFallback))
            $bytes = $enc.GetBytes($T)
            return (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes)
        }
        catch { }
    }
    return $T
}

function Get-PeekDisplayText([string]$T, [int]$Max) {
    # raw transcript text is hostile to a one-glance tooltip: control chars,
    # markdown emphasis, box-drawing rules from pasted terminal output, and
    # blind Substring() that can cut an emoji in half mid-surrogate (the
    # broken half renders as the classic weird box)
    if ([string]::IsNullOrWhiteSpace($T)) { return '' }
    $t = $T -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', ''
    $t = $t -replace '[\u2500-\u259F]+', ' '      # box drawing / block elements
    $t = $t -replace '```[a-zA-Z]*', ' '          # code fences
    $t = $t -replace '[`]|\*{1,3}', ''            # backticks / md emphasis
    $t = ($t -replace '\s+', ' ').Trim()
    if ($t.Length -gt $Max) {
        $cut = $Max
        if ([char]::IsHighSurrogate($t[$cut - 1])) { $cut-- }   # never split a pair
        $t = $t.Substring(0, $cut) + [string][char]0x2026
    }
    return $t
}

function Get-Sessions {
    $now = Get-Date
    # follow-the-process learning: map agents to tabs from whatever tab the
    # user happens to have open right now (works on renamed tabs too)
    try { Invoke-PassiveTabLearn } catch { }
    # ONE process-table snapshot, reused for 4s: every liveness check becomes
    # a dictionary lookup (the audit counted up to ~60 Get-Process calls/tick;
    # raw GetProcesses is also ~2.5x cheaper than the Get-Process cmdlet)
    if (((Get-Date) - $script:ProcSnapStamp).TotalSeconds -ge 4) {
        $script:ProcSnapshot = @{}
        foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { $script:ProcSnapshot[[int]$p.Id] = $p }
        $script:ProcSnapStamp = Get-Date
    }

    $sessions = New-Object System.Collections.ArrayList
    $files = Get-ChildItem -LiteralPath $StatusDir -Filter '*.json' -ErrorAction SilentlyContinue |
             Where-Object { $_.LastWriteTime -gt $now.AddDays(-7) }
    foreach ($f in $files) {
        # parse-once cache: a status file is only re-read when its
        # LastWriteTime changes, and dead files short-circuit forever.
        # Hooks are human-paced now, so most ticks parse NOTHING.
        $ck = $f.FullName
        $cached = $script:FileCache[$ck]
        if ($null -ne $cached -and $cached.LWT -eq $f.LastWriteTimeUtc) {
            if ($cached.Skip) { continue }
            $s = $cached.Obj
        }
        else {
            $s = $null
            try { $s = [IO.File]::ReadAllText($ck) | ConvertFrom-Json } catch { }
            if ($null -eq $s -or ([string]$s.status) -eq 'ended' -or
                [string]::IsNullOrWhiteSpace([string]$s.status)) {
                $script:FileCache[$ck] = @{ LWT = $f.LastWriteTimeUtc; Skip = $true }
                continue
            }
            $script:FileCache[$ck] = @{ LWT = $f.LastWriteTimeUtc; Skip = $false; Obj = $s }
        }

        $status = [string]$s.status
        if ($status -eq 'ended' -or [string]::IsNullOrWhiteSpace($status)) { continue }

        # liveness: prefer the recorded agent pid, fall back to file freshness.
        # (files with no pid are pre-upgrade relics; every live session gains a
        # pid on its first hook event, so the freshness window can be short)
        $agentPid = 0
        $proc = $null
        if ($null -ne $s.PSObject.Properties['agent_pid']) { $agentPid = [int]$s.agent_pid }
        if ($agentPid -gt 0) {
            $proc = $script:ProcSnapshot[$agentPid]
            if ($null -eq $proc -or $proc.ProcessName -notmatch $script:AgentProcRegex) { continue }
            # workers are NOT sessions, even when they capture a tab hint
            # (they run inside the parent's terminal, so the hook records the
            # parent's tab and the row shows up as a duplicate). Hide only on
            # BOTH signals - '--agent' on the cmdline AND an agent ancestor -
            # so a user-launched 'claude --agent x' keeps its row. Both checks
            # cache per pid; steady-state cost is a dictionary hit.
            if ((Test-IsWorkerProc $agentPid) -and (Test-IsSubagentProc -TargetPid $agentPid)) { continue }
        }
        elseif ($f.LastWriteTime -lt $now.AddMinutes(-30)) { continue }

        # NATIVE STATE LANE: the CLI's own live self-report outranks the hook
        # trail for the busy/idle/asking axis. Hooks still own everything else
        # (identity, tab hints, messages, transcript, context). Two richer
        # hook truths survive: error (native shows busy through api retries)
        # and compacting (cosmetic purple, native calls it busy).
        $nativeApplied = $false
        $hookStatus = $status   # the hooks' own word, pre-override: the done
                                # chirp trusts ONLY a hook-authored idle
        if ($agentPid -gt 0 -and $null -ne $proc) {
            $native = Get-NativeAgentStatus $agentPid $proc
            if ($null -ne $native) {
                $nativeApplied = $true
                $keep = ($native -eq 'working' -and $status -in @('error', 'compacting'))
                if (-not $keep -and $native -ne $status) { $status = $native }
            }
        }

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

        # same soap the peek tooltip gets: heal legacy mojibake, strip
        # markdown/box-drawing/control junk, cut surrogate-safely
        $msg = Get-PeekDisplayText (Repair-Mojibake ([string]$s.message)) 400

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
            Context  = $(if ($null -ne $s.PSObject.Properties['context_tokens']) { [long]$s.context_tokens } else { 0 })
            Transcript = $(if ($null -ne $s.PSObject.Properties['transcript_path']) { [string]$s.transcript_path } else { '' })
            Native   = $nativeApplied
            HookStatus = $hookStatus
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
    $script:UntrackedPids = @{}
    foreach ($u in @(Get-UntrackedSessions -Tracked $kept)) {
        if ($seenPid.ContainsKey([int]$u.AgentPid)) { continue }
        $script:UntrackedPids[[int]$u.AgentPid] = $true

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
            $inferred = Get-ScreenInferredStatus ([int]$u.AgentPid) (Get-InferredAgentStatus $liveName)
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

    # WORKING sessions are left alone by the passive learner's probing: their
    # consoles are busy rendering (probes contend with that via conhost RPC
    # and were measurably slowing the CLIs), and their screens change too fast
    # to fingerprint anyway. They get probed when they calm down.
    # EXCEPT: stale busy rows get a slow ground-truth check (Invoke-BusyVerify)
    # because hooks go silent on Esc-interrupts and can die before repainting
    # after a compact - without it those rows show 'working' forever. A
    # screen-proven override sticks until the next hook write to that file.
    $script:BusyPids = @{}
    $queue = New-Object System.Collections.ArrayList
    foreach ($s in $kept) {
        if ($s.Status -notin @('working', 'compacting') -or $s.AgentPid -le 0) { continue }
        $apid = [int]$s.AgentPid
        if ([bool]$s.Native) {
            # the CLI vouches for this row itself - no stale-busy lie possible
            # (Esc flips its native file to idle instantly). Never probe it,
            # and drop any prober override so an old screen sighting can't
            # fight the CLI's own word (bg-task busy looked calm to a probe).
            [void]$script:BusyOverride.Remove($apid)
            [void]$script:BusyVerify.Remove($apid)
            $script:BusyPids[$apid] = $true
            continue
        }
        $ov = $script:BusyOverride[$apid]
        if ($null -ne $ov) {
            if ($ov.FileTs -eq $s.Ts) {
                $s.Status = [string]$ov.Status
                $s.Rank   = (Get-StatusMeta $s.Status).Rank
                # KEEP WATCHING an overridden row: an api-retry that recovers
                # (or an idle flip that was wrong) gets lifted by the next
                # probe when busy markers reappear on screen
                if (-not $script:UntrackedPids.ContainsKey($apid)) {
                    [void]$queue.Add(@{ Pid = $apid; Ts = $s.Ts; Transcript = [string]$s.Transcript })
                }
                continue                                   # corrected: not busy anymore
            }
            [void]$script:BusyOverride.Remove($apid)       # newer hook event wins
            [void]$script:BusyVerify.Remove($apid)
        }
        $script:BusyPids[$apid] = $true
        # untracked rows (codex &co) already run their own screen inference -
        # only hook-fed rows need the stale-busy lie detector
        if (-not $script:UntrackedPids.ContainsKey($apid)) {
            [void]$queue.Add(@{ Pid = $apid; Ts = $s.Ts; Transcript = [string]$s.Transcript })
        }
    }
    $script:BusyVerifyQueue = $queue
    try { Invoke-BusyVerify } catch { }

    # LANDING GATE: a Stop write means the MODEL finished - but the terminal
    # keeps TYPING the answer for 5-15s after (proven live: 2 of 3 real
    # flips still showed a busy console AT the flip instant; one was still
    # typing 14s later). Done should mean READABLE, so a hook-flipped idle
    # row holds at 'working' until one probe shows the console calm - the
    # hook already says idle, screen-calm is the second independent witness.
    # Capped at 25s / 2 failed probes (headless consoles land immediately).
    # Prober-lane overrides never enter: their screens are proven calm.
    foreach ($s in $kept) {
        $apid = [int]$s.AgentPid
        if ($apid -le 0 -or $s.Status -ne 'idle') {
            if ($apid -gt 0) { [void]$script:LandingByPid.Remove($apid) }
            continue
        }
        $land = $script:LandingByPid[$apid]
        if ($null -eq $land) {
            $prevSt = [string]$script:PrevStatusById[[string]$s.Id]
            if ($prevSt -notin @('working', 'retrying', 'compacting')) { continue }
            $land = @{ Since = Get-Date; Fails = 0 }
            $script:LandingByPid[$apid] = $land
        }
        if (((Get-Date) - $land.Since).TotalSeconds -ge 25) {
            [void]$script:LandingByPid.Remove($apid)          # cap: land regardless
            continue
        }
        $hold = $true
        $r = Request-ConsoleInfo -TargetPid $apid
        if ($null -ne $r) {
            if ($null -ne $r.PSObject.Properties['Failed']) {
                $land.Fails = [int]$land.Fails + 1
                if ($land.Fails -ge 2) {
                    [void]$script:LandingByPid.Remove($apid)  # unprobeable: land now
                    $hold = $false
                }
            }
            elseif (-not (Test-ScreenLooksBusy ([string]$r.Screen) ([string]$r.Title))) {
                [void]$script:LandingByPid.Remove($apid)      # calm: the answer is READABLE - land (chirp fires this tick)
                $hold = $false
            }
        }
        if ($hold) {
            $s.Status = 'working'
            $s.Rank   = (Get-StatusMeta 'working').Rank
        }
    }

    # ANSWER LANE: for blocked claude rows, read the actual pending question
    # + numbered options off the console so the row can offer one-click
    # answers. Async probe children, shared probe budget, 20s capture cache,
    # cleared the moment the row stops asking. A just-answered pid rests 8s
    # so a lagging screen can't resurrect the old dialog.
    foreach ($s in $kept) {
        $apid = [int]$s.AgentPid
        if ($apid -le 0) { continue }
        if ($s.Status -ne 'attention' -or [string]$s.Provider -ne 'claude') {
            [void]$script:PromptCapByPid.Remove($apid)
            [void]$script:AttnTickByPid.Remove($apid)
            continue
        }
        if ($script:AnswerDebug) { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-answer.log') -Value "$(Get-Date -Format HH:mm:ss) pid=$apid st=$($s.Status) prov=$($s.Provider) tick=$([int]$script:AttnTickByPid[$apid] + 1)" -ErrorAction SilentlyContinue }
        # DEBOUNCE: only a row that STAYS blocked earns an attach. A status
        # flicker (working -> attention -> working) on a session that is
        # actually rendering must never cost it a console probe - attached
        # time on a busy TUI is contention (see the probe-contention law).
        $script:AttnTickByPid[$apid] = [int]$script:AttnTickByPid[$apid] + 1
        if ([int]$script:AttnTickByPid[$apid] -lt 3) { continue }
        $cool = $script:AnswerCoolByPid[$apid]
        if ($null -ne $cool -and ((Get-Date) - [datetime]$cool).TotalSeconds -lt 8) { continue }
        $cap = $script:PromptCapByPid[$apid]
        if ($null -ne $cap -and ((Get-Date) - [datetime]$cap.Stamp).TotalSeconds -lt 20) { continue }
        $preFlight = $script:ProbeJobs.ContainsKey($apid)
        $preAge = -1
        if ($preFlight) { try { $preAge = [int]((Get-Date) - $script:ProbeJobs[$apid].Started).TotalSeconds } catch { $preAge = -2 } }
        $r = Request-ConsoleInfo -TargetPid $apid -Raw -Priority
        if ($null -eq $r) { if ($script:AnswerDebug) { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-answer.log') -Value "$(Get-Date -Format HH:mm:ss) pid=$apid probe null: preflight=$preFlight age=$preAge budget=$($script:ProbeBudget) nowflight=$($script:ProbeJobs.ContainsKey($apid))" -ErrorAction SilentlyContinue }; continue }   # probe in flight: next tick
        if ($null -ne $r.PSObject.Properties['Failed']) {
            if ($script:AnswerDebug) { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-answer.log') -Value "$(Get-Date -Format HH:mm:ss) pid=$apid probe FAILED" -ErrorAction SilentlyContinue }
            $script:PromptCapByPid[$apid] = @{ Stamp = Get-Date; Prompt = $null }
            continue
        }
        # collected some OTHER lane's plain (no-raw) probe for this pid:
        # don't cache an empty parse for 20s - retry with a raw probe next tick
        if (-not [bool]$r.RawProbe) { if ($script:AnswerDebug) { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-answer.log') -Value "$(Get-Date -Format HH:mm:ss) pid=$apid collected PLAIN probe, retrying raw" -ErrorAction SilentlyContinue }; continue }
        $parsedP = ConvertTo-PendingPrompt ([string]$r.RawTail)
        if ($script:AnswerDebug) { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-answer.log') -Value "$(Get-Date -Format HH:mm:ss) pid=$apid CAPTURED rawlen=$(([string]$r.RawTail).Length) parsed=$($null -ne $parsedP) q=$(if ($parsedP) { $parsedP.Question })" -ErrorAction SilentlyContinue }
        $script:PromptCapByPid[$apid] = @{ Stamp = Get-Date; Prompt = $parsedP }
    }

    # a needs-you left hanging past N minutes isn't urgent anymore - you saw
    # it, you moved on. Demote it to PARKED: muted, below 'done', no pulse,
    # no chirp - fresh reds keep meaning fresh. A NEW notification (newer
    # status write) restarts the clock and brings the red back.
    if ($script:ParkMinutes -gt 0) {
        foreach ($s in $kept) {
            $sid = [string]$s.Id
            if ($s.Status -ne 'attention') { [void]$script:AttnSince.Remove($sid); continue }
            # a captured pending prompt = one-click answerable. That row is
            # the whole point of the answer lane - it never fades to parked
            # (observed live: park demoted the row AFTER the lane captured,
            # so the buttons existed but the strip gate never dressed them)
            $capP = $script:PromptCapByPid[[int]$s.AgentPid]
            if ($null -ne $capP -and $null -ne $capP.Prompt) { [void]$script:AttnSince.Remove($sid); continue }
            $seed = $script:AttnSince[$sid]
            if ($null -eq $seed -or $s.Ts -gt $seed) { $seed = $s.Ts; $script:AttnSince[$sid] = $seed }
            if (((Get-Date) - $seed).TotalMinutes -ge $script:ParkMinutes) {
                $s.Status = 'parked'
                $s.Rank   = (Get-StatusMeta 'parked').Rank
            }
        }
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
    param([int]$TargetPid, [string]$Marker = '', [int]$MarkerMs = 900, [switch]$Raw)

    $probe = Join-Path $PSScriptRoot 'console-probe.ps1'
    if (-not (Test-Path -LiteralPath $probe)) { return $null }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$probe`" -TargetPid $TargetPid" +
                     $(if ($Raw) { ' -Raw' } else { '' }) +
                     $(if ($Marker.Length -gt 0) { " -Marker `"$Marker`" -MarkerMs $MarkerMs" } else { '' })
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.CreateNoWindow = $true
    try { return [System.Diagnostics.Process]::Start($psi) } catch { return $null }
}

$script:ProbeJobs = @{}   # pid -> @{ Proc; Started }: probes IN FLIGHT (async)
function Request-ConsoleInfo {
    # NON-BLOCKING console probe: starts a child and returns $null (pending);
    # a later call collects the finished result. The UI thread never waits on
    # console RPC anymore - waiting synchronously froze the widget for ~1s
    # per probe and native apps don't hitch every two seconds.
    # -Raw: ask the probe child for the raw visible rows too (answer lane
    # only) - the collected result carries RawProbe so a caller who NEEDS
    # raw can tell when it collected some other lane's plain probe instead.
    # -Priority: exempt from the per-tick start budget. The budget exists to
    # pace BACKGROUND probing; a blocked row waiting for a human is the
    # highest-value probe in the building, and on a busy fleet the shared
    # budget is burned by busy-verify/learner before this lane ever runs
    # (observed live: answer lane starved for minutes, buttons never came).
    param([int]$TargetPid, [switch]$Raw, [switch]$Priority)

    if ($script:ProbeJobs.ContainsKey($TargetPid)) {
        $job = $script:ProbeJobs[$TargetPid]
        if (-not $job.Proc.HasExited) {
            if (((Get-Date) - $job.Started).TotalSeconds -gt 8) {
                try { $job.Proc.Kill() } catch { }
                try { $job.Proc.Dispose() } catch { }
                [void]$script:ProbeJobs.Remove($TargetPid)
                return [pscustomobject]@{ Failed = $true }
            }
            return $null   # still cooking - ask again next tick
        }
        [void]$script:ProbeJobs.Remove($TargetPid)
        try {
            if ($job.Proc.ExitCode -ne 0) { return [pscustomobject]@{ Failed = $true } }
            # stdout was drained ASYNC while the child ran. Reading only after
            # exit DEADLOCKED the child on wide consoles: a ~210-col raw tail
            # overflows the 4KB pipe buffer, the child blocks mid-WriteLine,
            # never exits, and eats the 8s kill - forever (observed live:
            # answer buttons never appeared; spawn-kill-respawn every 8s).
            $all = ''
            try { $all = [string]$job.Out.Result } catch { $all = '' }
            $lines = $all -split "`r?`n"
            $title = $(if ($lines.Count -ge 1) { $lines[0] } else { '' })
            [long]$hwnd = 0
            if ($lines.Count -ge 2) { [void][long]::TryParse($lines[1].Trim(), [ref]$hwnd) }
            $screen = $(if ($lines.Count -ge 3) { [string]$lines[2] } else { '' })
            [long]$conPid = 0
            if ($lines.Count -ge 4) { [void][long]::TryParse($lines[3].Trim(), [ref]$conPid) }
            $rawTail = ''
            if ($lines.Count -ge 5 -and -not [string]::IsNullOrWhiteSpace($lines[4])) {
                try { $rawTail = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($lines[4].Trim())) } catch { $rawTail = '' }
            }
            return [pscustomobject]@{ Title = $title; ConsoleHwnd = $hwnd; Screen = [string]$screen; ConsoleId = $conPid; RawTail = $rawTail; RawProbe = [bool]$job.Raw }
        }
        catch { return [pscustomobject]@{ Failed = $true } }
        finally { try { $job.Proc.Dispose() } catch { } }
    }

    if (-not $Priority -and $script:ProbeBudget -le 0) { return $null }
    if ($script:ProbeBudget -gt 0) { $script:ProbeBudget-- }
    $p = Start-ConsoleProbe -TargetPid $TargetPid -Raw:$Raw
    if ($null -ne $p) {
        # begin draining stdout NOW (see deadlock note in the collect path)
        $t = $p.StandardOutput.ReadToEndAsync()
        $script:ProbeJobs[$TargetPid] = @{ Proc = $p; Started = Get-Date; Raw = [bool]$Raw; Out = $t }
    }
    return $null
}

function Read-ConsoleInfoBounded {
    # returns @{ Title; ConsoleHwnd } of a process's console, or $null.
    # Never blocks longer than ~2.5s (probe child gets killed).
    param([int]$TargetPid)

    $p = Start-ConsoleProbe -TargetPid $TargetPid
    if ($null -eq $p) { return $null }
    try {
        # drain stdout ASYNC before waiting: a screen bigger than the 4KB
        # pipe buffer otherwise deadlocks the child (same law as the async
        # collect path in Request-ConsoleInfo)
        $tOut = $p.StandardOutput.ReadToEndAsync()
        if (-not $p.WaitForExit(3000)) {
            try { $p.Kill() } catch { }
            return $null
        }
        if ($p.ExitCode -ne 0) { return $null }
        $all = ''
        try { $all = [string]$tOut.Result } catch { $all = '' }
        $lines = $all -split "`r?`n"
        $title = $(if ($lines.Count -ge 1) { $lines[0] } else { '' })
        [long]$hwnd = 0
        if ($lines.Count -ge 2) { [void][long]::TryParse($lines[1].Trim(), [ref]$hwnd) }
        $screen = $(if ($lines.Count -ge 3) { [string]$lines[2] } else { '' })
        [long]$conPid = 0
        if ($lines.Count -ge 4) { [void][long]::TryParse($lines[3].Trim(), [ref]$conPid) }
        $rawTail = ''
        if ($lines.Count -ge 5 -and -not [string]::IsNullOrWhiteSpace($lines[4])) {
            try { $rawTail = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($lines[4].Trim())) } catch { $rawTail = '' }
        }
        return [pscustomobject]@{ Title = $title; ConsoleHwnd = $hwnd; Screen = [string]$screen; ConsoleId = $conPid; RawTail = $rawTail }
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
$script:ProbeBudget = 3         # probe STARTS allowed per tick (reset in Update-List) -
                                # starting a child is ~30ms; results are collected async
$script:LastScreenMap = @{}     # pid -> last probed console SCREEN text (fuel for the passive learner)
$script:KnownRidClaims = @{}    # rid -> pid for EVERY row perch showed last tick (hook-captured included)
$script:PoisonedRids = @{}      # "pid|rid" -> true: file hints that lost a conflict; never trust them again
$script:CycleFailStamp = @{}    # pid -> last time the click-time tab walk found nothing (30s cooldown)
$script:LastTitleByPid = @{}    # pid -> last probed console title (twin-clash detection)
$script:ConsoleIdByPid = @{}    # pid -> conhost pid owning its console (same console = same session)
$script:BusyPids = @{}          # pids of WORKING sessions - background probing leaves them alone
$script:BusyVerify = @{}        # pid -> {FileTs; Stamp; Wait; Misses}: stale-busy verification state
$script:BusyOverride = @{}      # pid -> {Status; FileTs}: screen-proven correction of a stuck status
$script:LandingByPid = @{}      # pid -> {Since; Fails}: hook says idle but the console is still TYPING the answer
$script:BusyVerifyQueue = @()   # busy rows eligible for verification, rebuilt every tick
$script:AttnSince = @{}         # session id -> when it started needing you (parked-demotion clock)
$script:UntrackedPids = @{}     # pids currently shown as untracked rows (screen-state detection)
$script:FileCache = @{}         # status file path -> {LWT; Skip|Obj} (parse only what changed)
$script:ProcSnapshot = @{}      # pid -> Process, refreshed at most every 4s
$script:ProcSnapStamp = [datetime]::MinValue
# state Get-Sessions touches MUST initialize before the -Probe branch calls it
$script:PrevStatusById = @{}    # session id -> last status: a real FINISH is working->idle per session
$script:PendingDoneById = @{}   # session id -> when the NATIVE lane landed an idle the hooks never wrote:
                                # a real finish gets Stop's idle within seconds - a manual /compact or an
                                # Esc-interrupt never does, and must not sing
$script:PromptCapByPid = @{}    # pid -> @{ Stamp; Prompt }: parsed pending prompt per blocked row
$script:AttnTickByPid = @{}     # pid -> consecutive attention ticks (debounce: flickers never earn a probe)
$script:AnswerDebug = $false    # trace the answer lane to hud-answer.log (flip on when field-debugging)
$script:AnswerCoolByPid = @{}   # pid -> when an answer was injected (mute stale strip while the screen catches up)
$script:AnswerBusy = $false
$script:AnswerInjProc = $null
$script:AnswerInjTimer = $null
$script:AnswerInjStart = [datetime]::MinValue

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
    # forcing the (visible) click-time tab walk to do the job instead.
    # Probes are ASYNC (results arrive on a later tick) - zero UI blocking.
    foreach ($apid in @($script:LastScreenMap.Keys)) {
        # mapped pids normally leave the refresh loop - EXCEPT live untracked
        # agents (codex &co): their screen fingerprint doubles as hookless
        # needs-you detection, so it must stay reasonably fresh
        $isUntrackedRow = $script:UntrackedPids.ContainsKey([int]$apid)
        if ($script:UntrackedTabMap.ContainsKey($apid) -and -not $isUntrackedRow) { continue }
        if ($script:BusyPids.ContainsKey($apid)) { continue }   # let working TUIs render in peace
        if (-not $script:ProcSnapshot.ContainsKey([int]$apid)) {
            [void]$script:LastScreenMap.Remove($apid)
            continue
        }
        $entry = $script:LastScreenMap[$apid]
        # backoff: an agent that keeps refusing to map gets probed less and
        # less (60s -> 10min); live untracked rows stay at a steady 90s
        $wait = 60 * (1 + [Math]::Min([int]$entry.Tries, 9))
        if ($isUntrackedRow) { $wait = 90 }
        if (((Get-Date) - $entry.Stamp).TotalSeconds -lt $wait) { continue }
        $fresh = Request-ConsoleInfo -TargetPid $apid
        if ($null -eq $fresh) { continue }   # pending or out of budget - later tick
        if ($null -ne $fresh.PSObject.Properties['Failed']) {
            $entry.Stamp = (Get-Date); $entry.Tries = [int]$entry.Tries + 1
            continue
        }
        $script:LastTitleByPid[$apid] = [string]$fresh.Title
        if ([long]$fresh.ConsoleId -gt 0) { $script:ConsoleIdByPid[$apid] = [long]$fresh.ConsoleId }
        if (([string]$fresh.Screen).Length -ge 200) {
            $script:LastScreenMap[$apid] = @{ Text = [string]$fresh.Screen; Stamp = (Get-Date); Tries = ([int]$entry.Tries + 1) }
        }
        else { $entry.Stamp = (Get-Date); $entry.Tries = [int]$entry.Tries + 1 }   # don't hammer a mute console
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
$script:WorkerCache = @{}     # pid -> bool ('--agent' on the command line = worker)

function Test-IsWorkerProc([int]$TargetPid) {
    # Task-tool / agent-team workers carry '--agent <type>' on their command
    # line. Ancestry alone can't tell them from forked background jobs (both
    # are claude-spawned-by-claude) - the command line can.
    if ($script:WorkerCache.ContainsKey($TargetPid)) { return $script:WorkerCache[$TargetPid] }
    $isWorker = $false
    try {
        $cl = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction Stop).CommandLine
        if ($cl -match '\s--agent\s') { $isWorker = $true }
    }
    catch { }
    $script:WorkerCache[$TargetPid] = $isWorker
    return $isWorker
}
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

# screen-content state patterns, stolen with love from ccmanager's per-agent
# detectors. Our screen fingerprints are normalized to lowercase alnum, so
# the patterns are too. Order matters: needs-you outranks busy.
$script:ScreenNeedsYou = @(
    'pressentertoconfirmoresctocancel'   # codex confirm bar
    'entertosubmitanswer'                # codex question
    'allowcommand'                       # codex permission
    'doyouwanttoproceed'                 # gemini / generic permission box
    'waitingforuserconfirmation'         # gemini
    'applythischange'                    # gemini diff prompt
    'wouldyouliketo'                     # generic permission phrasing
)
$script:ScreenBusy = @(
    'esctointerrupt'                     # claude/codex busy hint
    'ctrlctointerrupt'
    'ctrlbtoruninbackground'             # claude running-tool hint
)
$script:ScreenApiRetry = @(
    'retryingin'                         # "Unable to connect ... Retrying in 4s (attempt 3/10)"
)
$script:ScreenApiError = @(
    'unabletoconnecttoapi'               # connection refused / dns / proxy down
    'connectionrefused'
    'apierror'                           # "API Error: 500/529..."
    'overloadederror'
)

function Test-ScreenLooksBusy([string]$Txt, [string]$Title) {
    # busy signals that do NOT rotate. The status-bar hint line alternates
    # between "esc to interrupt" and random tips (verified live: a session 9
    # minutes into a Bash call showed only a tip), so the hint's absence at
    # one instant proves nothing. The elapsed-timer/token row and the braille
    # spinner leading the console title are constant while a turn runs.
    foreach ($p in $script:ScreenBusy) { if ($Txt.Contains($p)) { return $true } }
    if ($Txt -match '\d+s\d+(\.\d+)?k?tokens') { return $true }   # "(9m 14s . 135k tokens"
    if (-not [string]::IsNullOrEmpty($Title)) {
        $c = [int][char]$Title[0]
        if ($c -ge 0x2800 -and $c -le 0x28FF) { return $true }
    }
    return $false
}

function Invoke-BusyVerify {
    # HOOK BLIND SPOTS: no hook event fires when the user Escs a running turn
    # (Stop skips user interrupts BY DESIGN), and compact-end repaints can
    # vanish with a timed-out hook. Either way a session sits painted
    # 'working'/'compacting' forever. The console screen is ground truth:
    # slow-probe stale busy rows and OVERRIDE the painted status once the
    # screen provably stopped cooking - two clean sightings 10s apart, since
    # a single frame without busy markers lies (the hint line rotates).
    # (grace 25s / first look 20s: a killed-under-load Stop hook or an Esc
    # interrupt now flips in ~35-55s instead of ~60-90s; clean finishes
    # never ride this lane at all)
    # TRANSCRIPT HEARTBEAT: claude appends to its transcript every few
    # seconds while a turn runs; when the chat ends (or the user Escs) it
    # goes silent. One NTFS metadata stat - free, zero conhost contention -
    # so a quiet transcript (>=8s) collapses the WAITING: grace 25s -> 6s,
    # first probe immediately, second look after 4s instead of 10. It NEVER
    # waives the two-sighting rule: transcript silence is a weak witness
    # (long pure-prose streams append the transcript only when the message
    # COMPLETES), so one rotation-lie frame + a quiet transcript must not
    # flip a still-writing session to done. Worst case ~39s -> ~15s.
    # Any newer hook write invalidates the override instantly.
    foreach ($q in @($script:BusyVerifyQueue)) {
        $apid = [int]$q.Pid
        $st = $script:BusyVerify[$apid]
        if ($null -eq $st -or $st.FileTs -ne $q.Ts) {
            $st = @{ FileTs = $q.Ts; Stamp = [datetime]::MinValue; Wait = 20; Misses = 0 }
            $script:BusyVerify[$apid] = $st
        }
        $tQuiet = $false
        if ($null -ne $q.Transcript -and -not [string]::IsNullOrWhiteSpace([string]$q.Transcript)) {
            try {
                $tw = [System.IO.File]::GetLastWriteTimeUtc([string]$q.Transcript)
                if (((Get-Date).ToUniversalTime() - $tw).TotalSeconds -ge 8) { $tQuiet = $true }
            } catch { }
        }
        $grace = $(if ($tQuiet) { 6 } else { 25 })
        if (((Get-Date) - $q.Ts).TotalSeconds -lt $grace) { continue }  # let the hooks speak first
        if ($tQuiet -and $st.Stamp -eq [datetime]::MinValue) { $st.Wait = 0 }  # quiet transcript: first look NOW
        if (((Get-Date) - $st.Stamp).TotalSeconds -lt $st.Wait) { continue }
        $r = Request-ConsoleInfo -TargetPid $apid
        if ($null -eq $r) { continue }                                  # pending or out of budget
        $st.Stamp = Get-Date
        if ($null -ne $r.PSObject.Properties['Failed']) { continue }
        $script:LastTitleByPid[$apid] = [string]$r.Title
        if ([long]$r.ConsoleId -gt 0) { $script:ConsoleIdByPid[$apid] = [long]$r.ConsoleId }
        $txt = [string]$r.Screen
        if ($txt.Length -lt 200) { continue }                           # mute console proves nothing
        $ov = $script:BusyOverride[$apid]
        if (Test-ScreenLooksBusy $txt ([string]$r.Title)) {
            # cooking (again): LIFT any override - an api-retry that got
            # through goes straight back to plain 'working'
            if ($null -ne $ov) { [void]$script:BusyOverride.Remove($apid) }
            $st.Misses = 0
            $st.Wait = [Math]::Min([int]$st.Wait + 30, 120)             # confirmed busy: ease off
            continue
        }
        # not cooking - what IS on screen? checked in blame order: a
        # permission prompt outranks an api hiccup outranks plain idle
        $verdict = $null
        foreach ($p in $script:ScreenNeedsYou) { if ($txt.Contains($p)) { $verdict = 'attention'; break } }
        if ($null -eq $verdict) {
            foreach ($p in $script:ScreenApiRetry) { if ($txt.Contains($p)) { $verdict = 'retrying'; break } }
        }
        if ($null -eq $verdict) {
            foreach ($p in $script:ScreenApiError) { if ($txt.Contains($p)) { $verdict = 'error'; break } }
        }
        if ($null -ne $verdict) {
            $script:BusyOverride[$apid] = @{ Status = $verdict; FileTs = $q.Ts }
            $st.Misses = 0
            # api retries resolve themselves - look back quickly so recovery
            # flips the row to working fast; the rest can relax
            $st.Wait = $(if ($verdict -eq 'retrying') { 20 } else { [Math]::Min([int]$st.Wait + 30, 90) })
            continue
        }
        if ($null -ne $ov -and [string]$ov.Status -eq 'idle') {
            $st.Wait = [Math]::Min([int]$st.Wait + 30, 120)             # confirmed calm: ease off
            continue
        }
        $st.Misses++
        $st.Wait = $(if ($tQuiet) { 4 } else { 10 })                    # suspicious: look again soon(er if the transcript is silent)
        if ($st.Misses -ge 2 -or $txt.Contains('interruptedbyuser')) {
            $script:BusyOverride[$apid] = @{ Status = 'idle'; FileTs = $q.Ts }
        }
    }
}

function Get-ScreenInferredStatus([int]$AgentPid, [string]$Fallback) {
    # sharpen a title-inferred status using the last screen fingerprint (if
    # fresh): hookless agents get a REAL needs-you state instead of sitting
    # at quiet while a permission prompt rots unanswered
    $entry = $script:LastScreenMap[$AgentPid]
    if ($null -eq $entry) { return $Fallback }
    if (((Get-Date) - $entry.Stamp).TotalMinutes -gt 3) { return $Fallback }
    $txt = [string]$entry.Text
    foreach ($p in $script:ScreenNeedsYou) { if ($txt.Contains($p)) { return 'attention' } }
    if ($Fallback -eq 'quiet') {
        foreach ($p in $script:ScreenBusy) { if ($txt.Contains($p)) { return 'working' } }
    }
    return $Fallback
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

    # ASYNC probe: $null while pending means "unresolved THIS tick, no
    # verdict" - only a completed probe may write the negative cache
    $info = Request-ConsoleInfo -TargetPid $TargetPid
    if ($null -eq $info) { return $null }
    if ($null -ne $info.PSObject.Properties['Failed']) {
        $script:NoTabStamp[$TargetPid] = Get-Date
        return $null
    }
    $match = $null
    if (([string]$info.Screen).Length -ge 200) {
        $script:LastScreenMap[$TargetPid] = @{ Text = [string]$info.Screen; Stamp = (Get-Date) }   # fuels the passive learner
    }
    $script:LastTitleByPid[$TargetPid] = [string]$info.Title
    if ([long]$info.ConsoleId -gt 0) { $script:ConsoleIdByPid[$TargetPid] = [long]$info.ConsoleId }
    if (-not [string]::IsNullOrWhiteSpace($info.Title)) {
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
                if (-not $script:ProcSnapshot.ContainsKey([int]$opid)) { continue }
                if ((Get-NormalizedTabName ([string]$script:LastTitleByPid[$opid])) -eq $norm) { $clash = $true; break }
            }
            if (-not $clash) { $match = $byName[0] }
        }
    }
    if ($null -eq $match -and $CwdName.Length -gt 0) {
        # manually-RENAMED tabs ignore console-title changes, so neither the
        # live title nor a stamped marker ever appears on them. People usually
        # rename the tab to the project name -> match the cwd folder name.
        # IMPOSTER GUARD: codex titles its console with the BARE CWD FOLDER
        # NAME - indistinguishable from a human-renamed tab. If any OTHER
        # live agent's probed console title shows this same name, that tab
        # is (almost certainly) that agent's console, not a rename - adopt
        # it and a claude row starts jumping to codex (observed live: open
        # claude then codex in one folder and the row 'became' codex).
        $wantCwd = Get-NormalizedTabName $CwdName
        if ($wantCwd.Length -gt 0) {
            $byCwd = @($tabs | Where-Object { $_.Norm -eq $wantCwd })
            if ($byCwd.Count -eq 1) {
                $imposter = $false
                foreach ($opid in @($script:LastTitleByPid.Keys)) {
                    if ([int]$opid -eq $TargetPid) { continue }
                    if (-not $script:ProcSnapshot.ContainsKey([int]$opid)) { continue }
                    if ((Get-NormalizedTabName ([string]$script:LastTitleByPid[$opid])) -eq $wantCwd) { $imposter = $true; break }
                }
                if (-not $imposter) { $match = $byCwd[0] }
            }
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
            # shell-noise names (cmd.exe path, powershell, conhost) are the
            # HOST's title, not the agent's - show the provider instead of
            # 'c:\windows\system32\cmd.exe - ...' (observed live with codex
            # launched via cmd /k)
            if ($dispName.Length -eq 0 -or $dispName -match '(?i)cmd\.exe|powershell|pwsh|conhost|windows terminal') {
                $dispName = "$($cand.Provider) session"
            }
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
                Context  = 0
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
    # 6s TTL: the tab SET changes rarely; the old 2s TTL equalled the tick
    # interval, so every tick paid a full UIA tree walk for nothing. Click
    # paths that need exactness pass -Fresh.
    if (-not $Fresh -and ((Get-Date) - $script:TabsCacheStamp).TotalMilliseconds -lt 6000) { return $script:TabsCache }
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

$script:CompactBusy = $false
$script:CompactTarget = $null
$script:CompactKeyTimer = $null
$script:CompactInjProc = $null
$script:CompactInjTimer = $null
$script:CompactInjStart = [datetime]::MinValue
function Invoke-CompactFallback($Sess) {
    # visible-dance fallback (only when silent injection failed): jump to the
    # tab, then SendKeys. Keys go to the FOREGROUND window, so we verify the
    # focus landed on the terminal we aimed at before typing a single char -
    # typing /compact into an email is a horror film.
    if ($script:CompactBusy) { return }
    $script:CompactBusy = $true
    $ok = $false
    try { $ok = Invoke-FocusSession $Sess } catch { }
    if (-not $ok) { $script:CompactBusy = $false; return }
    if ($null -eq $script:CompactKeyTimer) {
        $script:CompactKeyTimer = New-Object System.Windows.Threading.DispatcherTimer
        $script:CompactKeyTimer.Interval = [TimeSpan]::FromMilliseconds(650)   # let WT land the tab switch
        $script:CompactKeyTimer.Add_Tick({
            $script:CompactKeyTimer.Stop()
            try {
                $fg = [ClaudeHud.Native]::GetForegroundWindow()
                $fpid = [uint32]0
                [void][ClaudeHud.Native]::GetWindowThreadProcessId($fg, [ref]$fpid)
                $fname = ''
                try { $fname = (Get-Process -Id ([int]$fpid) -ErrorAction Stop).ProcessName } catch { }
                $sess = $script:CompactTarget
                $expected = [long]0
                if ($null -ne $sess -and $null -ne $sess.Window -and
                    $null -ne $sess.Window.PSObject.Properties['hwnd']) {
                    $expected = [long]$sess.Window.hwnd
                }
                if (($expected -gt 0 -and [long]$fg -eq $expected) -or
                    $fname -in @('WindowsTerminal', 'OpenConsole', 'conhost')) {
                    [System.Windows.Forms.SendKeys]::SendWait('/compact{ENTER}')
                }
            }
            catch { }
            finally { $script:CompactBusy = $false }
        })
    }
    $script:CompactTarget = $Sess
    $script:CompactKeyTimer.Stop(); $script:CompactKeyTimer.Start()
}

function Invoke-CompactSession($Sess) {
    # the compact button's whole job, the CIVILIZED way: console-inject.ps1
    # attaches to the session's console BY PID and writes /compact + Enter
    # straight into its input buffer (WriteConsoleInput). No focus steal, no
    # tab switch, wrong-window impossible, works while minimized - the user
    # never leaves what they were doing. NEVER automatic: the button
    # appearing is the reminder, the click is the consent. Falls back to the
    # visible focus+SendKeys dance only if attach fails (exit != 0).
    if ($script:CompactBusy) { return }
    if ([int]$Sess.AgentPid -le 0) { return }
    $inj = Join-Path $PSScriptRoot 'console-inject.ps1'
    if (-not (Test-Path -LiteralPath $inj)) { Invoke-CompactFallback $Sess; return }
    $script:CompactBusy = $true
    $script:CompactTarget = $Sess
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$inj`" -TargetPid $([int]$Sess.AgentPid) -Text /compact -Enter"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    try { $script:CompactInjProc = [System.Diagnostics.Process]::Start($psi) } catch { $script:CompactInjProc = $null }
    if ($null -eq $script:CompactInjProc) {
        $script:CompactBusy = $false
        Invoke-CompactFallback $Sess
        return
    }
    if ($null -eq $script:CompactInjTimer) {
        $script:CompactInjTimer = New-Object System.Windows.Threading.DispatcherTimer
        $script:CompactInjTimer.Interval = [TimeSpan]::FromMilliseconds(400)
        $script:CompactInjTimer.Add_Tick({
            $p = $script:CompactInjProc
            if ($null -eq $p) { $script:CompactInjTimer.Stop(); $script:CompactBusy = $false; return }
            if (-not $p.HasExited) {
                if (((Get-Date) - $script:CompactInjStart).TotalSeconds -gt 8) {
                    try { $p.Kill() } catch { }
                    try { $p.Dispose() } catch { }
                    $script:CompactInjProc = $null
                    $script:CompactInjTimer.Stop()
                    $script:CompactBusy = $false
                    Invoke-CompactFallback $script:CompactTarget
                }
                return
            }
            $code = 1
            try { $code = $p.ExitCode } catch { }
            try { $p.Dispose() } catch { }
            $script:CompactInjProc = $null
            $script:CompactInjTimer.Stop()
            $script:CompactBusy = $false
            if ($code -ne 0) { Invoke-CompactFallback $script:CompactTarget }
        })
    }
    $script:CompactInjStart = Get-Date
    $script:CompactInjTimer.Stop(); $script:CompactInjTimer.Start()
}

# ====== ANSWER FROM THE PERCH (experimental) ============================
# When a claude session blocks on a numbered prompt (permission ask, plan
# approval, AskUserQuestion), the prober reads the ACTUAL question and
# options off its screen and the row grows one-click answer buttons that
# inject the digit BY PID - no focus steal, no tab switch, works minimized.
# Never blind: you see exactly what you're approving before you click.
# (The SDK-bound tools closed this as impossible. It isn't, down here.)

function ConvertTo-PendingPrompt([string]$RawTail) {
    # parse the console's raw visible rows into @{ Question; Detail; Options }
    # or $null. Anchor = the BOTTOM-most numbered list starting at "1." with
    # ascending numbers (claude renders one option per line, the selected one
    # prefixed with a caret). Wrapped option text on the following line is
    # glued back on. Context above the block: nearest "...?" line = question,
    # the rest = detail (usually the tool name + the exact command).
    if ([string]::IsNullOrWhiteSpace($RawTail)) { return $null }
    $clean = New-Object System.Collections.ArrayList
    foreach ($ln in ($RawTail -split "`r?`n")) {
        # box-drawing + block glyphs -> space (claude draws the dialog border
        # in these; real TUI uses them, degraded/ASCII terminals use '|' '+')
        $cl = ($ln -replace ('[' + [char]0x2500 + '-' + [char]0x259F + ']'), ' ').Trim()
        # strip only EDGE border pipes/plus - interior '|' survives so a
        # piped command (cat x | grep y) stays intact in the detail line
        $cl = ($cl -replace '^[|+]\s?', '' -replace '\s?[|+]$', '').Trim()
        [void]$clean.Add($cl)
    }
    $best = $null
    $cur = $null
    for ($i = 0; $i -lt $clean.Count; $i++) {
        $t = [string]$clean[$i]
        # selected-option caret variants: U+276F heavy chevron, >, U+00BB, U+2192 arrow
        $m = [regex]::Match($t, ('^(?:[' + [char]0x276F + '>' + [char]0x00BB + [char]0x2192 + ']\s*)?(\d)\.\s+(\S.*)$'))
        if ($m.Success) {
            $n = [int]$m.Groups[1].Value
            $lbl = $m.Groups[2].Value.Trim()
            if ($n -eq 1) {
                $cur = @{ Start = $i; Opts = (New-Object System.Collections.ArrayList) }
                [void]$cur.Opts.Add(@{ Num = 1; Label = $lbl })
            }
            elseif ($null -ne $cur -and $n -eq ($cur.Opts.Count + 1)) {
                [void]$cur.Opts.Add(@{ Num = $n; Label = $lbl })
            }
            else { $cur = $null }
            if ($null -ne $cur -and $cur.Opts.Count -ge 2) { $best = $cur }
        }
        elseif ($null -ne $cur -and $t.Length -gt 0) {
            # wrapped option text continues on the next screen row
            $last = $cur.Opts[$cur.Opts.Count - 1]
            if (([string]$last.Label).Length -lt 200) { $last.Label = ([string]$last.Label + ' ' + $t).Trim() }
        }
        else {
            if ($null -ne $cur -and $cur.Opts.Count -ge 2) { $best = $cur }
            $cur = $null
        }
    }
    if ($null -eq $best) { return $null }
    $ctx = New-Object System.Collections.ArrayList
    for ($i = [int]$best.Start - 1; $i -ge 0 -and $ctx.Count -lt 4 -and ([int]$best.Start - $i) -le 10; $i--) {
        $t = [string]$clean[$i]
        if ($t.Length -eq 0) { continue }
        [void]$ctx.Insert(0, $t)
    }
    $q = ''
    for ($i = $ctx.Count - 1; $i -ge 0; $i--) {
        if ([string]$ctx[$i] -match '\?\s*$') { $q = [string]$ctx[$i]; $ctx.RemoveAt($i); break }
    }
    $ctxSep = ' ' + [string][char]0x00B7 + ' '
    $detail = (@($ctx) -join $ctxSep).Trim()
    if ($detail.Length -gt 160) { $detail = $detail.Substring(0, 160) }
    foreach ($o in $best.Opts) {
        if (([string]$o.Label).Length -gt 90) { $o.Label = ([string]$o.Label).Substring(0, 90).TrimEnd() }
    }
    return @{ Question = $q; Detail = $detail; Options = $best.Opts }
}

function Invoke-AnswerPrompt($Sess, [int]$Num) {
    # inject the chosen option's digit into the blocked session BY PID (no
    # Enter - claude's numbered menus act on the digit itself). There is NO
    # SendKeys fallback ON PURPOSE: blindly typing digits at whatever holds
    # focus is exactly the auto-yes bug class the rest of the ecosystem
    # suffers from. If attach fails, the row click (jump to tab) is right
    # there and the prompt is still on screen. Nothing is ever automatic.
    if ($script:AnswerBusy) { return }
    $apid = [int]$Sess.AgentPid
    if ($apid -le 0 -or $Num -lt 1 -or $Num -gt 9) { return }
    $inj = Join-Path $PSScriptRoot 'console-inject.ps1'
    if (-not (Test-Path -LiteralPath $inj)) { return }
    $script:AnswerBusy = $true
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$inj`" -TargetPid $apid -Text $Num"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    try { $script:AnswerInjProc = [System.Diagnostics.Process]::Start($psi) } catch { $script:AnswerInjProc = $null }
    if ($null -eq $script:AnswerInjProc) { $script:AnswerBusy = $false; return }
    [void]$script:PromptCapByPid.Remove($apid)
    [void]$script:AttnTickByPid.Remove($apid)
    $script:AnswerCoolByPid[$apid] = Get-Date
    if ($null -eq $script:AnswerInjTimer) {
        $script:AnswerInjTimer = New-Object System.Windows.Threading.DispatcherTimer
        $script:AnswerInjTimer.Interval = [TimeSpan]::FromMilliseconds(400)
        $script:AnswerInjTimer.Add_Tick({
            $p = $script:AnswerInjProc
            if ($null -eq $p) { $script:AnswerInjTimer.Stop(); $script:AnswerBusy = $false; return }
            if (-not $p.HasExited) {
                if (((Get-Date) - $script:AnswerInjStart).TotalSeconds -gt 8) {
                    try { $p.Kill() } catch { }
                    try { $p.Dispose() } catch { }
                    $script:AnswerInjProc = $null
                    $script:AnswerInjTimer.Stop()
                    $script:AnswerBusy = $false
                }
                return
            }
            try { $p.Dispose() } catch { }
            $script:AnswerInjProc = $null
            $script:AnswerInjTimer.Stop()
            $script:AnswerBusy = $false
        })
    }
    $script:AnswerInjStart = Get-Date
    $script:AnswerInjTimer.Stop(); $script:AnswerInjTimer.Start()
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
  <Grid x:Name="WinRoot">
  <Border x:Name="RootCard" CornerRadius="16" BorderBrush="#24FFFFFF" BorderThickness="1" Margin="12">
    <Border.Background>
      <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
        <GradientStop Color="#F71E1E27" Offset="0"/>
        <GradientStop Color="#F7141419" Offset="1"/>
      </LinearGradientBrush>
    </Border.Background>
    <!-- NO Border.Effect here, ever again: an Effect on the root card forces
         the ENTIRE window subtree through a software blur on every dirty
         pixel, and with AllowsTransparency each frame is also a GPU-to-CPU
         readback. The audit measured this as the single biggest reason the
         widget felt slow. Depth now comes from the border + themes. -->
    <Grid>
    <!-- glass theme optics, bottom to top: a DOME of light falling from
         above the top edge (radial - glass is curved, light is not linear),
         soft diagonal reflection streaks, then the content, then a bright
         INNER highlight edge and a light-catching outer rim. Collapsed in
         the other themes. -->
    <Border x:Name="GlassDome" CornerRadius="9" IsHitTestVisible="False" Visibility="Collapsed">
      <Border.Background>
        <RadialGradientBrush Center="0.32,-0.28" GradientOrigin="0.32,-0.28" RadiusX="1.15" RadiusY="0.85">
          <GradientStop Color="#80FFFFFF" Offset="0"/>
          <GradientStop Color="#30FFFFFF" Offset="0.4"/>
          <GradientStop Color="#0EFFFFFF" Offset="0.7"/>
          <GradientStop Color="#00FFFFFF" Offset="1"/>
        </RadialGradientBrush>
      </Border.Background>
    </Border>
    <Border x:Name="GlassStreak" CornerRadius="9" IsHitTestVisible="False" Visibility="Collapsed">
      <Border.Background>
        <LinearGradientBrush StartPoint="0,0" EndPoint="1,0.85">
          <GradientStop Color="#00FFFFFF" Offset="0"/>
          <GradientStop Color="#00FFFFFF" Offset="0.28"/>
          <GradientStop Color="#1CFFFFFF" Offset="0.36"/>
          <GradientStop Color="#05FFFFFF" Offset="0.44"/>
          <GradientStop Color="#00FFFFFF" Offset="0.52"/>
          <GradientStop Color="#12FFFFFF" Offset="0.58"/>
          <GradientStop Color="#00FFFFFF" Offset="0.66"/>
          <GradientStop Color="#00FFFFFF" Offset="0.90"/>
          <GradientStop Color="#0DFFFFFF" Offset="1"/>
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
          <Image x:Name="LogoImg" Width="24" Height="24" Margin="0,0,8,0"
                 RenderOptions.BitmapScalingMode="HighQuality">
            <Image.Effect>
              <DropShadowEffect BlurRadius="7" ShadowDepth="0" Opacity="0.55" Color="#E07B54"/>
            </Image.Effect>
          </Image>
          <TextBlock FontSize="13.5" FontWeight="SemiBold" Text="Perch"
                     Foreground="#F4F4F8" VerticalAlignment="Center"/>
        </StackPanel>
        <!-- header icons: Segoe MDL2 Assets glyphs, NOT text/emoji - emoji
             render in fixed color and cannot show state; font glyphs tint
             via Foreground, so toggles can actually LOOK on/off -->
        <StackPanel Grid.Column="1" Orientation="Horizontal">
          <!-- E738 Remove, NOT E921 ChromeMinimize: E921 is missing from
               older MDL2 revisions and renders as a tofu rectangle -->
          <TextBlock x:Name="MiniBtn" Text="&#xE738;" FontFamily="Segoe MDL2 Assets" FontSize="11" Padding="6,4"
                     Style="{StaticResource HudIconButton}" Margin="2,0"
                     ToolTip="compact mode (double-click the header works too)"/>
          <TextBlock x:Name="GearBtn" Text="&#xE713;" FontFamily="Segoe MDL2 Assets" FontSize="12" Padding="6,4"
                     Style="{StaticResource HudIconButton}" Margin="2,0"
                     ToolTip="settings"/>
          <TextBlock x:Name="PinBtn" Text="&#xE841;" FontFamily="Segoe MDL2 Assets" FontSize="12" Padding="6,4"
                     Style="{StaticResource HudIconButton}" Margin="2,0"/>
          <TextBlock x:Name="CloseBtn" Text="&#xE8BB;" FontFamily="Segoe MDL2 Assets" FontSize="11" Padding="6,4"
                     Style="{StaticResource HudIconButton}" Margin="4,0,2,0"
                     ToolTip="hide to tray - the bird keeps watching (quit from the tray icon)"/>
        </StackPanel>
      </Grid>
      <WrapPanel x:Name="ChipsPanel" Orientation="Horizontal" Margin="16,0,16,4" Background="Transparent"/>
      <StackPanel x:Name="LimitsPanel" Margin="16,0,16,9" Background="Transparent"/>
      <Border x:Name="Divider" Height="1" Background="#14FFFFFF" Margin="12,0,12,4"/>
      <!-- CRASH INSURANCE: appears only when a snapshot from a previous life
           lists sessions that are not running now. resume all = manual,
           always - perch never relaunches anything on its own. -->
      <Border x:Name="RestoreBar" CornerRadius="8" Background="#1A7BD8FF" BorderBrush="#2E7BD8FF"
              BorderThickness="1" Margin="12,1,12,5" Padding="9,5,6,5" Visibility="Collapsed">
        <Grid>
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/>
            <ColumnDefinition Width="Auto"/>
            <ColumnDefinition Width="Auto"/>
          </Grid.ColumnDefinitions>
          <TextBlock x:Name="RestoreText" FontSize="11.5" Foreground="#BFE4FF"
                     VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
          <Border x:Name="RestoreGoBtn" Grid.Column="1" CornerRadius="6" Background="#2E7BD8FF" Margin="8,0,4,0" Cursor="Hand">
            <TextBlock x:Name="RestoreGo" Text="resume all" FontSize="11" FontWeight="SemiBold"
                       Foreground="#D8F0FF" Padding="8,2" VerticalAlignment="Center"/>
          </Border>
          <TextBlock x:Name="RestoreDismiss" Grid.Column="2" Text="&#x2715;" FontSize="10.5"
                     Foreground="#807BD8FF" Padding="5,2,3,2" VerticalAlignment="Center" Cursor="Hand"/>
        </Grid>
      </Border>
      <ScrollViewer x:Name="RowsScroll" MaxHeight="560" VerticalScrollBarVisibility="Auto"
                    HorizontalScrollBarVisibility="Disabled">
        <StackPanel x:Name="SessionList" Margin="8,2,8,10"/>
      </ScrollViewer>
    </StackPanel>
    <Border x:Name="GlassInner" CornerRadius="7.5" BorderThickness="1" Margin="1.8"
            IsHitTestVisible="False" Visibility="Collapsed">
      <Border.BorderBrush>
        <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
          <GradientStop Color="#96FFFFFF" Offset="0"/>
          <GradientStop Color="#1FFFFFFF" Offset="0.12"/>
          <GradientStop Color="#00FFFFFF" Offset="0.45"/>
          <GradientStop Color="#00FFFFFF" Offset="0.85"/>
          <GradientStop Color="#26FFFFFF" Offset="1"/>
        </LinearGradientBrush>
      </Border.BorderBrush>
    </Border>
    <Border x:Name="GlassRim" CornerRadius="9" BorderThickness="1.3"
            IsHitTestVisible="False" Visibility="Collapsed">
      <Border.BorderBrush>
        <LinearGradientBrush StartPoint="0.15,0" EndPoint="0.85,1">
          <GradientStop Color="#F5FFFFFF" Offset="0"/>
          <GradientStop Color="#59FFFFFF" Offset="0.18"/>
          <GradientStop Color="#24FFFFFF" Offset="0.5"/>
          <GradientStop Color="#3DFFFFFF" Offset="0.82"/>
          <GradientStop Color="#8CFFFFFF" Offset="1"/>
        </LinearGradientBrush>
      </Border.BorderBrush>
    </Border>
    </Grid>
  </Border>
  <!-- the resting pill is its OWN tiny card, not a squeezed RootCard: the
       peek morph is a pure crossfade between the two (render-only, no
       per-frame layout, no window-rect animation - THAT was the jank) -->
  <Border x:Name="PillCard" CornerRadius="30" BorderThickness="1" Margin="8"
          HorizontalAlignment="Left" VerticalAlignment="Top" Visibility="Collapsed"/>
  </Grid>
</Window>
"@

$script:Window      = [System.Windows.Markup.XamlReader]::Parse($xaml)
$script:SessionList = $Window.FindName('SessionList')
$script:ChipsPanel  = $Window.FindName('ChipsPanel')
$script:LimitsPanel = $Window.FindName('LimitsPanel')
$script:UsageFetchStamp = [datetime]::MinValue
$script:BlocksSpawnStamp = [datetime]::MinValue
$script:BlocksProc = $null           # blocks-probe child (never overlap scans)
$script:BlocksFileLWT = [datetime]::MinValue
$script:BlocksParsed = $null         # cached blocks.json parse
$script:AnchorKey = ''               # last official 5h reset written as the probe's anchor
$script:BlockCalib = New-Object System.Collections.ArrayList   # {Tok;Pct;At}: official% vs local tokens pairs
$script:UsageHist = @{}      # limit label -> samples of (T, Pct) for burn-rate math
$script:LimitAlerted = @{}   # limit label -> chirped-at-90 flag (cleared on reset)
$script:LastUsageKey = ''
$script:UsageFileLWT = [datetime]::MinValue
$script:LimitsRenderStamp = [datetime]::MinValue
$script:UsageParsed = $null            # cached endpoint snapshot (parse once per file write)
$script:LastOfficial = $null           # last good statusline-sourced limits
$script:LastOfficialStamp = [datetime]::MinValue
$script:LimitsKey = ''                 # content key: rebuild only on real change
$script:SlTextKey = ''                 # last text pushed to the statusline echo file
$script:Header      = $Window.FindName('Header')
$script:PinBtn      = $Window.FindName('PinBtn')
$script:CloseBtn    = $Window.FindName('CloseBtn')
$script:GearBtn     = $Window.FindName('GearBtn')
$script:MiniBtn     = $Window.FindName('MiniBtn')
$script:Divider     = $Window.FindName('Divider')
$script:RowsScroll  = $Window.FindName('RowsScroll')
# ---------------------------------------------------- crash insurance --
# perch keeps a rolling snapshot of every live claude session (id + cwd).
# A power cut, BSOD or accidental shutdown kills the terminals but not the
# snapshot - on the next boot, sessions listed there that are NOT running
# get offered in the RestoreBar. Offered. Clicking 'resume all' relaunches
# each one in its own terminal tab via `claude --resume <id>`; nothing is
# ever relaunched automatically.
$SnapPath = Join-Path $PSScriptRoot 'hud-livesnap.json'
$script:RestoreBar     = $Window.FindName('RestoreBar')
$script:RestoreText    = $Window.FindName('RestoreText')
$script:RestoreGoBtn   = $Window.FindName('RestoreGoBtn')
$script:RestoreDismiss = $Window.FindName('RestoreDismiss')
$script:LiveSnapSig = $null            # last written id-set (write only on change)
$script:RestorePending = New-Object System.Collections.ArrayList
$script:RestoreSavedAt = ''
try {
    if (Test-Path -LiteralPath $SnapPath) {
        $snap = Get-Content -LiteralPath $SnapPath -Raw | ConvertFrom-Json
        $script:RestoreSavedAt = [string]$snap.savedAt
        foreach ($p in @($snap.sessions)) {
            if (-not [string]::IsNullOrWhiteSpace([string]$p.id) -and
                -not [string]::IsNullOrWhiteSpace([string]$p.cwd) -and
                (Test-Path -LiteralPath ([string]$p.cwd))) {
                [void]$script:RestorePending.Add(@{
                    Id = [string]$p.id; Cwd = [string]$p.cwd; Name = [string]$p.name
                    Flags = [string]$p.flags })   # absent in old snapshots -> ''
            }
        }
    }
}
catch { }
function Update-RestoreBar {
    if ($null -eq $script:RestoreBar) { return }
    $n = $script:RestorePending.Count
    if ($n -le 0) {
        if ($script:RestoreBar.Visibility -ne 'Collapsed') { $script:RestoreBar.Visibility = 'Collapsed' }
        return
    }
    $script:RestoreText.Text = ('{0} {1} lost session{2}' -f
        [char]0x21BB, $n, $(if ($n -eq 1) { '' } else { 's' }))
    $tip = "these were alive when perch last saw them"
    if ($script:RestoreSavedAt) {
        try {
            $age = (Get-Date) - [datetime]::Parse($script:RestoreSavedAt, $null,
                [System.Globalization.DateTimeStyles]::RoundtripKind)
            $tip += $(if ($age.TotalHours -ge 1) { ' ({0:0.#}h ago)' -f $age.TotalHours }
                      else { ' ({0:0}min ago)' -f [Math]::Max(1, $age.TotalMinutes) })
        }
        catch { }
    }
    $tip += ":`n"
    foreach ($p in $script:RestorePending) {
        $pf = $(if (-not [string]::IsNullOrWhiteSpace([string]$p.Flags)) { '  [' + $p.Flags + ']' } else { '' })
        $tip += ('  ' + $p.Name + '  -  ' + $p.Cwd + $pf + "`n")
    }
    $tip += "resume all = one terminal tab per session, each running 'claude --resume' with the permission flags it was born with. nothing happens until you click."
    if ([string]$script:RestoreBar.ToolTip -ne $tip) { $script:RestoreBar.ToolTip = $tip }
    if ($script:RestoreBar.Visibility -ne 'Visible') { $script:RestoreBar.Visibility = 'Visible' }
}
$script:PermFlagsByPid = @{}   # pid -> permission flags the session was LAUNCHED with (one cmdline query per pid, ever)
function Get-SessionPermFlags([int]$AgentPid) {
    # a bypass-permissions fleet restored into DEFAULT mode is a downgrade
    # trap: every restored session starts blocking on prompts the user never
    # sees. Read the live process's command line ONCE and remember exactly
    # which permission posture it was born with, so --resume can inherit it.
    if ($AgentPid -le 0) { return '' }
    if ($script:PermFlagsByPid.ContainsKey($AgentPid)) { return [string]$script:PermFlagsByPid[$AgentPid] }
    $flags = ''
    try {
        $cl = [string](Get-CimInstance Win32_Process -Filter "ProcessId = $AgentPid" -ErrorAction Stop).CommandLine
        if ($cl -match '--dangerously-skip-permissions') { $flags = '--dangerously-skip-permissions' }
        elseif ($cl -match '--permission-mode[= ]+([A-Za-z]+)') { $flags = '--permission-mode ' + $Matches[1] }
    }
    catch { }
    $script:PermFlagsByPid[$AgentPid] = $flags
    return $flags
}
function Invoke-ResumeSession($P) {
    # one dead session -> one fresh terminal tab in its old cwd, claude
    # picking the conversation back up WITH the permission flags it was
    # born with (bare --resume silently downgraded a bypass session to
    # default mode). cmd /k keeps the tab (and any resume error) visible
    # instead of vanishing on failure.
    try {
        $cmd = 'claude --resume ' + $P.Id
        if (-not [string]::IsNullOrWhiteSpace([string]$P.Flags)) { $cmd += ' ' + [string]$P.Flags }
        $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
        if ($null -ne $wt) {
            Start-Process wt.exe -ArgumentList ('-w 0 nt -d "' + $P.Cwd + '" cmd /k ' + $cmd)
        }
        else {
            Start-Process cmd.exe -WorkingDirectory $P.Cwd -ArgumentList ('/k ' + $cmd)
        }
    }
    catch { }
}
# staggered relaunch: N simultaneous claude boots would fight over CPU and
# the terminal - one every 700ms feels like a calm roll call instead
$script:RestoreQueue = New-Object System.Collections.Queue
$script:RestoreTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:RestoreTimer.Interval = [TimeSpan]::FromMilliseconds(700)
$script:RestoreTimer.Add_Tick({
    try {
        if ($script:RestoreQueue.Count -eq 0) { $script:RestoreTimer.Stop(); return }
        Invoke-ResumeSession $script:RestoreQueue.Dequeue()
    }
    catch { $script:RestoreTimer.Stop() }
})
$script:RestoreGoBtn.Add_MouseLeftButtonUp({
    param($s, $e)
    $e.Handled = $true
    try {
        if ($script:RestorePending.Count -eq 0) { return }
        foreach ($p in @($script:RestorePending)) { [void]$script:RestoreQueue.Enqueue($p) }
        $script:RestorePending.Clear()
        Update-RestoreBar
        Invoke-ResumeSession $script:RestoreQueue.Dequeue()   # first one NOW
        if ($script:RestoreQueue.Count -gt 0) { $script:RestoreTimer.Start() }
    }
    catch { }
})
$script:RestoreDismiss.Add_MouseLeftButtonUp({
    param($s, $e)
    $e.Handled = $true
    $script:RestorePending.Clear()
    Update-RestoreBar
    # dismissed = you didn't want that morning; kill the stale snapshot so
    # it can't re-offer after the NEXT reboot (the writer rebuilds it live)
    try { Remove-Item -LiteralPath $SnapPath -Force -Confirm:$false -ErrorAction SilentlyContinue } catch { }
})
$script:RootCard    = $Window.FindName('RootCard')
$script:PillCard    = $Window.FindName('PillCard')
$script:GlassDome   = $Window.FindName('GlassDome')
$script:GlassStreak = $Window.FindName('GlassStreak')
$script:GlassInner  = $Window.FindName('GlassInner')
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
$script:FocusBusy   = $false
$script:LastFocusId = ''
$script:LastFocusStamp = [datetime]::MinValue
$script:RowCache    = @{}    # session id -> persistent row elements (diff rendering)
$script:EmptyEl     = $null
$script:ChipSet     = $null  # the 4+1 status chips, created once

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
    if ($Sess.Status -in @('attention', 'error', 'retrying')) { return Get-Brush '#14FF6B6B' }
    return [System.Windows.Media.Brushes]::Transparent
}

# ---------------------------------------------------------------- themes --
# the theme catalog. every theme is a room the bird perches in: same light
# text, same status colors (those are semantics, not decoration), different
# walls. all brushes are frozen and shared. FxUnder renders behind the
# content (glows), FxOver above everything (scanlines). Glow tints the
# bird's halo to match the room.
function New-GradBrush([double[]]$From, [double[]]$To, [object[]]$Stops) {
    $g = New-Object System.Windows.Media.LinearGradientBrush
    $g.StartPoint = New-Object System.Windows.Point($From[0], $From[1])
    $g.EndPoint = New-Object System.Windows.Point($To[0], $To[1])
    foreach ($s in $Stops) {
        [void]$g.GradientStops.Add((New-Object System.Windows.Media.GradientStop(
            [System.Windows.Media.ColorConverter]::ConvertFromString($s[0]), [double]$s[1])))
    }
    $g.Freeze()
    return $g
}

function New-ScanlineBrush {
    # CRT scanlines: a 64x3 tile with one barely-there dark line. Frozen +
    # tiled = realized once, effectively free to repaint (audit-approved).
    $dg = New-Object System.Windows.Media.DrawingGroup
    foreach ($r in @(
            @('#00000000', 0, 3),     # transparent filler keeps the tile bounds
            @('#10000000', 2, 1))) {  # the line itself
        $gd = New-Object System.Windows.Media.GeometryDrawing
        $gd.Brush = Get-Brush ([string]$r[0])
        $gd.Geometry = New-Object System.Windows.Media.RectangleGeometry(
            (New-Object System.Windows.Rect(0, [double]$r[1], 64, [double]$r[2])))
        [void]$dg.Children.Add($gd)
    }
    $b = New-Object System.Windows.Media.DrawingBrush($dg)
    $b.TileMode = 'Tile'
    $b.ViewportUnits = 'Absolute'
    $b.Viewport = New-Object System.Windows.Rect(0, 0, 64, 3)
    $b.Freeze()
    return $b
}

function New-DomeGlow([double[]]$Center, [double[]]$Radii, [object[]]$Stops) {
    # a radial light source parked off one edge of the card - the same
    # trick GlassDome plays, reusable for any hue
    $rg = New-Object System.Windows.Media.RadialGradientBrush
    $rg.Center = New-Object System.Windows.Point($Center[0], $Center[1])
    $rg.GradientOrigin = $rg.Center
    $rg.RadiusX = $Radii[0]
    $rg.RadiusY = $Radii[1]
    foreach ($s in $Stops) {
        [void]$rg.GradientStops.Add((New-Object System.Windows.Media.GradientStop(
            [System.Windows.Media.ColorConverter]::ConvertFromString($s[0]), [double]$s[1])))
    }
    $rg.Freeze()
    return $rg
}

function New-HorizonGlow {
    # synthwave: a neon sun setting just below the card's bottom edge -
    # magenta core cooling toward cyan as it fades out
    return New-DomeGlow @(0.5, 1.22) @(0.95, 0.78) @(
        @('#4AFF41B0', 0.0), @('#207A5CFF', 0.55), @('#0033E0FF', 1.0))
}

$script:ThemeSpecs = [ordered]@{
    # the classics
    midnight   = @{ Bg = $script:CardGradient
                    BorderBrush = (Get-Brush '#24FFFFFF'); Glow = '#E07B54' }
    oled       = @{ Bg = (Get-Brush '#FF060608')
                    BorderBrush = (Get-Brush '#2BFFFFFF'); Glow = '#E07B54' }
    glass      = @{ Glow = '#E07B54' }   # special-cased in Apply-Theme (acrylic + optics)
    # the fun ones. each one tells the same light story glass does, tinted:
    # a light SOURCE (FxUnder), an inner top GLINT (FxUnderEdge), walls that
    # darken away from the light (Bg), and a border that's bright where the
    # light falls (BorderBrush gradient). flat hex walls looked like shit.
    phosphor   = @{ Bg = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#F70D1F12', 0), @('#F7081409', 0.55), @('#F7040B05', 1)))
                    BorderBrush = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#6E45E683', 0), @('#28245C36', 1)))
                    Glow = '#3EDC78'
                    FxUnder = (New-DomeGlow @(0.5, -0.2) @(1.05, 0.75) @(
                        @('#2E3EDC78', 0), @('#12246E3C', 0.55), @('#00000000', 1)))
                    FxUnderEdge = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#66CFFFDC', 0), @('#1A3EDC78', 0.10), @('#00000000', 0.5), @('#123EDC78', 1)))
                    FxOver = (New-ScanlineBrush) }
    nord       = @{ Bg = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#F7353C4B', 0), @('#F72B303E', 0.55), @('#F7222733', 1)))
                    BorderBrush = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#7A93C5D6', 0), @('#2E46586B', 1)))
                    Glow = '#88C0D0'
                    # the aurora: teal -> green -> purple, draped across the top
                    FxUnder = (New-GradBrush @(0, 0) @(1, 0.6) @(
                        @('#2488C0D0', 0), @('#18A3BE8C', 0.35), @('#14B48EAD', 0.65), @('#00000000', 1)))
                    FxUnderEdge = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#78DFF1F5', 0), @('#1E88C0D0', 0.10), @('#00000000', 0.5), @('#1281A1C1', 1))) }
    catppuccin = @{ Bg = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#F7272738', 0), @('#F71E1E2E', 0.55), @('#F7151521', 1)))
                    BorderBrush = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#6EC9ABF2', 0), @('#2A55436E', 1)))
                    Glow = '#CBA6F7'
                    # pastel dawn: mauve -> pink -> peach wash from the top corner
                    FxUnder = (New-GradBrush @(0, 0) @(1, 0.6) @(
                        @('#22CBA6F7', 0), @('#16F5C2E7', 0.4), @('#10FAB387', 0.75), @('#00000000', 1)))
                    FxUnderEdge = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#70EBDFFB', 0), @('#1CCBA6F7', 0.10), @('#00000000', 0.5), @('#12B4BEFE', 1))) }
    synthwave  = @{ Bg = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#F72F1A52', 0), @('#F71E1038', 0.5), @('#F7140B28', 1)))
                    BorderBrush = (New-GradBrush @(0, 0) @(1, 1) @(
                        @('#96FF41B0', 0), @('#5C7A5CFF', 0.5), @('#8C33E0FF', 1)))
                    Glow = '#FF41B0'
                    FxUnder = (New-HorizonGlow)
                    FxUnderEdge = (New-GradBrush @(0, 0) @(0, 1) @(
                        @('#7AFFD1EC', 0), @('#22FF41B0', 0.10), @('#00000000', 0.5), @('#1633E0FF', 1))) }
}

# two code-made overlay layers for theme effects: one under the content
# (glows), one over everything (scanlines). Hit-test transparent, collapsed
# unless the active theme uses them.
$script:ThemeFxUnder = New-Object System.Windows.Controls.Border
$script:ThemeFxOver  = New-Object System.Windows.Controls.Border
foreach ($fx in @($script:ThemeFxUnder, $script:ThemeFxOver)) {
    $fx.IsHitTestVisible = $false
    $fx.Visibility = 'Collapsed'
}
# the under-layer doubles as the inner GLINT: inset 1.2 so its 1px border
# sits just inside the card's own border, like GlassInner does for glass
$script:ThemeFxUnder.Margin = New-Object System.Windows.Thickness(1.2)
$script:ThemeFxUnder.CornerRadius = New-Object System.Windows.CornerRadius(14.8)
$script:ThemeFxOver.CornerRadius = New-Object System.Windows.CornerRadius(15)
try {
    $cardGrid = $script:RootCard.Child
    $cardGrid.Children.Insert(2, $script:ThemeFxUnder)   # above glass optics, below content
    [void]$cardGrid.Children.Add($script:ThemeFxOver)    # above everything
}
catch { }

# ===== MASCOT PACKS ======================================================
# A mascot is a folder of PNGs. The built-in 'bird' lives at root logo.png +
# assets\bird\bird-<state>.png. Any OTHER pack is assets\mascots\<name>\ with
# logo.png (or neutral.png) + <state>.png. Everything here is written to
# NEVER throw and NEVER blank the HUD: any missing file, missing pack, or
# unreadable image falls back - state file -> pack neutral -> bird -> root
# logo. Generate art in any order; the mascot levels up incrementally.
function Import-MascotBitmap([string]$Path, [int]$DecodeW) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $bi = New-Object System.Windows.Media.Imaging.BitmapImage
        $bi.BeginInit()
        $bi.UriSource = New-Object System.Uri($Path)
        if ($DecodeW -gt 0) { $bi.DecodePixelWidth = $DecodeW }
        $bi.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bi.EndInit()
        $bi.Freeze()
        return $bi
    }
    catch { return $null }
}
function Get-MascotSpec {
    # @{ Name; Dir; Neutral } for the active pack - ALWAYS valid.
    $root = $PSScriptRoot
    $name = [string]$script:MascotPack
    if ([string]::IsNullOrWhiteSpace($name)) { $name = 'bird' }
    if ($name -ne 'bird') {
        $dir = Join-Path $root ('assets\mascots\' + $name)
        if (Test-Path -LiteralPath $dir) {
            $neutral = $null
            foreach ($n in @('logo.png', 'neutral.png')) {
                $p = Join-Path $dir $n
                if (Test-Path -LiteralPath $p) { $neutral = $p; break }
            }
            if ($null -eq $neutral) { $neutral = Join-Path $root 'logo.png' }   # pack has no neutral yet: borrow bird's
            return @{ Name = $name; Dir = $dir; Neutral = $neutral }
        }
        # named pack folder is gone: fall through to the bird
    }
    return @{ Name = 'bird'; Dir = (Join-Path $root 'assets\bird'); Neutral = (Join-Path $root 'logo.png') }
}
function Get-MascotPacks {
    # 'bird' (always) + every assets\mascots\<name> that has a neutral image
    $packs = [System.Collections.ArrayList]@('bird')
    $mdir = Join-Path $PSScriptRoot 'assets\mascots'
    if (Test-Path -LiteralPath $mdir) {
        foreach ($d in @(Get-ChildItem -LiteralPath $mdir -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
            foreach ($n in @('logo.png', 'neutral.png')) {
                if (Test-Path -LiteralPath (Join-Path $d.FullName $n)) { [void]$packs.Add($d.Name); break }
            }
        }
    }
    return $packs
}
function Load-MascotFaces {
    # (re)build $script:BirdFaces + $script:LogoSource for the active pack and
    # push the neutral face to the live UI. Safe to call at boot OR live from
    # the picker. State keys: <state>.png, and a legacy 'bird-' prefix is
    # tolerated so the built-in pack's bird-blink.png -> key 'blink'.
    $spec = Get-MascotSpec
    $script:MascotActive = $spec.Name
    $neutral = Import-MascotBitmap $spec.Neutral 160
    if ($null -eq $neutral) { $neutral = Import-MascotBitmap (Join-Path $PSScriptRoot 'logo.png') 160 }
    $script:LogoSource = $neutral
    $faces = @{ neutral = $neutral }
    try {
        if (Test-Path -LiteralPath $spec.Dir) {
            foreach ($f in @(Get-ChildItem -LiteralPath $spec.Dir -Filter '*.png' -ErrorAction SilentlyContinue)) {
                $key = $f.BaseName
                if ($key -like 'bird-*') { $key = $key.Substring(5) }
                if ($key -eq 'logo' -or $key -eq 'neutral' -or [string]::IsNullOrWhiteSpace($key)) { continue }
                $img = Import-MascotBitmap $f.FullName 160
                if ($null -ne $img) { $faces[$key] = $img }
            }
        }
    }
    catch { }
    $script:BirdFaces = $faces
    if ($null -ne $script:LogoImg -and $null -ne $neutral) { $script:LogoImg.Source = $neutral }
    if ($null -ne $script:PillBirdA -and $null -ne $neutral) {
        $script:PillBirdA.Source = $neutral
        if ($null -ne $script:PillBirdB) { $script:PillBirdB.Opacity = 0.0 }
        $script:BirdFaceKey = 'neutral'
    }
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
    $logoImg = $Window.FindName('LogoImg')
    $script:LogoImg = $logoImg
    # neutral face for the ACTIVE mascot pack (Get-MascotSpec always resolves
    # to something loadable - a custom pack, or the built-in bird, or at worst
    # the root logo). Drives BOTH the header logo and the bird's resting face.
    $mspec0 = Get-MascotSpec
    $script:LogoSource = Import-MascotBitmap $mspec0.Neutral 128
    if ($null -ne $logoImg -and $null -ne $script:LogoSource) {
        $logoImg.Source = $script:LogoSource
    }
}
catch { }

# ------------------------------------------------------------------ pill --
# compact mode v2, the dynamic-island treatment: a tiny pill where the bird
# wears the 5h limit as a RING (green->amber->red arc), next to colored
# need/work/done counts. Hovering peeks the chips + limit bars in place
# (the PILLAR/NotchNook interaction people love), double-click expands.
$script:PillCluster = @{}
$script:PillAttTarget = $null   # longest-waiting attention session, set each tick
$script:PillRingKey = ''
$script:Pill5hPct = -1.0
$script:Pill5hHex = '#5ED584'
$script:PillPeeked = $false
$script:AnchorRight = 0.0
$script:BirdScale = $null       # transforms exist only if the logo loaded
$script:BirdDozing = $false     # bird leans over asleep when everything's quiet
$script:PillParkedCount = 0     # parked (ignored 30+ min) -> the judging sideeye
$script:BirdFlapN = 0           # flap-burst frame counter (happy/happy2)
$script:BirdFanFlip = $false    # hot/hot2 alternation phase
$script:BirdFanTimer = $null    # created with the other timers below
$script:BootStamp = Get-Date    # suppresses the done-chirp for already-done sessions found at launch
$script:PillWorkCount = 0       # gates the supervising head-tilt
$script:BirdFaces = @{}         # state -> BitmapImage (from assets/bird)
$script:PillBirdA = $null       # visible face Image
$script:PillBirdB = $null       # crossfade partner Image
$script:BirdRingGrid = $null    # the 48px ring grid (grows to 68 mid-carry)
$script:BirdImgGrid = $null     # the bird image wrapper (rides along)
$script:BirdFaceKey = 'neutral'
$script:BirdFaceHoldUntil = [datetime]::MinValue   # moment faces override state faces
$script:PillAttCount = 0
$script:PillErrCount = 0
$script:PillDoneAll = $false
$script:CarryAngle = 0.0        # pendulum state while you carry him
$script:CarryAngVel = 0.0
$script:CarryLastX = 0.0
$script:CarryFlips = 0          # shake detector: fast direction flips -> he swears
$script:CarryLastSign = 0
$script:CarryFlipStamp = [datetime]::MinValue
$script:BirdBoopCount = 0       # boop-spam detector: pester the cooldown -> he swears

$script:PillBar = New-Object System.Windows.Controls.Grid
# bird-first geometry, packed TIGHT: left margin 3 puts the ring's center
# at x=30 - the same center as the capsule's left cap (CR 30), so the
# bird's ring IS the pill's left end. The bird's image box fills the ring
# (art padding is the only gap) - no dead space around the cutie.
$script:PillBar.Margin = New-Object System.Windows.Thickness(3, 3, 10, 3)
$script:PillBar.Background = [System.Windows.Media.Brushes]::Transparent
$script:PillBar.Visibility = 'Collapsed'
$pillRow = New-Object System.Windows.Controls.StackPanel
$pillRow.Orientation = 'Horizontal'
$pillRow.VerticalAlignment = 'Center'

$birdGrid = New-Object System.Windows.Controls.Grid
$birdGrid.Width = 52; $birdGrid.Height = 52
$script:PillRingTrack = New-Object System.Windows.Shapes.Ellipse
$script:PillRingTrack.Stroke = Get-Brush '#1EFFFFFF'
$script:PillRingTrack.StrokeThickness = 2.8
[void]$birdGrid.Children.Add($script:PillRingTrack)
$script:PillRingArc = New-Object System.Windows.Shapes.Path
$script:PillRingArc.Stroke = Get-Brush '#5ED584'
$script:PillRingArc.StrokeThickness = 2.8
$script:PillRingArc.StrokeStartLineCap = 'Round'
$script:PillRingArc.StrokeEndLineCap = 'Round'
$script:PillRingArc.Visibility = 'Collapsed'
[void]$birdGrid.Children.Add($script:PillRingArc)
if ($null -ne $script:LogoSource) {
    # FACE LIBRARY for the active mascot pack. Built by Load-MascotFaces
    # (below, once PillBirdA exists so it can push the neutral face) - keyed
    # by <state>, missing files fall back to neutral. Seed it now so the gate
    # code paths that read $script:BirdFaces before the load never null out.
    $script:BirdFaces = @{ neutral = $script:LogoSource }
    # two stacked Images = 120ms face crossfades; transforms ride on the
    # wrapper grid so every motion moves whichever face is showing
    $birdImgGrid = New-Object System.Windows.Controls.Grid
    $birdImgGrid.Width = 52; $birdImgGrid.Height = 52   # fills the ring - art padding is the gap
    $birdImgGrid.HorizontalAlignment = 'Center'
    $birdImgGrid.VerticalAlignment = 'Center'
    $pillBird = New-Object System.Windows.Controls.Image
    $pillBird.Source = $script:LogoSource
    [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($pillBird, 'HighQuality')
    $script:PillBirdA = $pillBird
    $script:PillBirdB = New-Object System.Windows.Controls.Image
    $script:PillBirdB.Opacity = 0.0
    $script:PillBirdB.IsHitTestVisible = $false
    [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($script:PillBirdB, 'HighQuality')
    [void]$birdImgGrid.Children.Add($pillBird)
    [void]$birdImgGrid.Children.Add($script:PillBirdB)
    # the bird LIVES: scale (perk, squash) + rotate (doze lean, head tilt) +
    # translate (hop). All render-only, all event-driven moments - no loops,
    # no idle cost. Origin near the feet so tilts read as LEANING and hops
    # launch from the ground, not from the belly.
    $script:BirdScale = New-Object System.Windows.Media.ScaleTransform(1.0, 1.0)
    $script:BirdRot = New-Object System.Windows.Media.RotateTransform(0.0)
    $script:BirdShift = New-Object System.Windows.Media.TranslateTransform(0.0, 0.0)
    $birdTg = New-Object System.Windows.Media.TransformGroup
    [void]$birdTg.Children.Add($script:BirdScale)
    [void]$birdTg.Children.Add($script:BirdRot)
    [void]$birdTg.Children.Add($script:BirdShift)
    $birdImgGrid.RenderTransform = $birdTg
    $birdImgGrid.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.72)
    [void]$birdGrid.Children.Add($birdImgGrid)
    $script:BirdImgGrid = $birdImgGrid
    # now that PillBirdA/B exist, build the full face library for the active
    # pack (bird by default) and push its neutral face onto them
    Load-MascotFaces
}
[void]$pillRow.Children.Add($birdGrid)
$script:BirdRingGrid = $birdGrid   # resized during a drag: the carried bird grows
# HOVER = he NOTICES you. The law stands - hover opens NOTHING - but the
# bird is a creature, not a button: pass the cursor over HIM and he waves
# hello (wink, chirp, tiny bounce). Do it while he's asleep and he cracks
# one eye open (drowsy frame), clocks you, and drifts back off - the doze
# lean and the breathing never stop. Cooldown so a restless cursor doesn't
# turn him into a metronome; moment faces (grabbed/launch/alert...) win.
$script:BirdGreetStamp = [datetime]::MinValue
$script:BirdRingGrid.Add_MouseEnter({
    try {
        if (-not $script:Compact -or $script:PillDragging -or $script:PillPressActive) { return }
        if (((Get-Date) - $script:BirdGreetStamp).TotalSeconds -lt 8) {
            # pestering him during the cooldown - he's counting. Four boops
            # and he LOSES IT: grawlix rant + furious feather shake. Works
            # from sleep too (waking him repeatedly EARNS the cussing) -
            # but keep the body asleep then: face swears, lean stays.
            $script:BirdBoopCount++
            if ($script:BirdBoopCount -ge 4 -and $null -ne $script:BirdFaces['cursing'] -and
                (Get-Date) -ge $script:BirdFaceHoldUntil) {
                $script:BirdBoopCount = 0
                $script:BirdGreetStamp = Get-Date
                Set-BirdFace 'cursing'
                $script:BirdFaceHoldUntil = (Get-Date).AddMilliseconds(2500)
                if (-not $script:BirdDozing) { Invoke-BirdMotion 'ruffle' }
            }
            return
        }
        if ((Get-Date) -lt $script:BirdFaceHoldUntil) { return }
        $script:BirdBoopCount = 0
        $script:BirdGreetStamp = Get-Date
        if ($script:BirdDozing) {
            if ($null -ne $script:BirdFaces['drowsy']) {
                Set-BirdFace 'drowsy'
                $script:BirdFaceHoldUntil = (Get-Date).AddMilliseconds(1200)
            }
        }
        else {
            if ($null -ne $script:BirdFaces['wave']) {
                Set-BirdFace 'wave'
                $script:BirdFaceHoldUntil = (Get-Date).AddMilliseconds(1800)
            }
            Invoke-BirdMotion 'greet'
        }
    }
    catch { }
})

$pillClusterPanel = New-Object System.Windows.Controls.StackPanel
$pillClusterPanel.Orientation = 'Horizontal'
$pillClusterPanel.VerticalAlignment = 'Center'
$pillClusterPanel.Margin = New-Object System.Windows.Thickness(9, 0, 0, 0)
foreach ($cdef in @(@('att', '#FF6B6B'), @('work', '#FFB84D'), @('done', '#5ED584'))) {
    $t = New-Object System.Windows.Controls.TextBlock
    $t.FontSize = 13
    $t.FontWeight = [System.Windows.FontWeights]::SemiBold
    $t.Foreground = Get-Brush $cdef[1]
    $t.Margin = New-Object System.Windows.Thickness(0, 0, 7, 0)
    $t.Visibility = 'Collapsed'
    if ($cdef[0] -eq 'att') {
        # the red count glows - it's the one number the pill exists for
        $pds = New-Object System.Windows.Media.Effects.DropShadowEffect
        $pds.BlurRadius = 6; $pds.ShadowDepth = 0; $pds.Opacity = 0.7
        $pds.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#FF6B6B')
        $pds.Freeze()
        $t.Effect = $pds
        # and it's a BUTTON: click the red number -> land in the terminal
        # that's been waiting longest. Transparent bg = whole box clickable,
        # padding fattens the hit target on an 11px glyph.
        $t.Background = [System.Windows.Media.Brushes]::Transparent
        # horizontal-only padding + compensating margin: fat hit target with
        # the glyph EXACTLY where its siblings sit - top/bottom padding sank
        # the red number 2px below the orange/green ones
        $t.Padding = New-Object System.Windows.Thickness(3, 0, 3, 0)
        $t.Margin = New-Object System.Windows.Thickness(-3, 0, 4, 0)
        $t.Cursor = [System.Windows.Input.Cursors]::Hand
        $t.ToolTip = 'jump to the session that needs you'
        $t.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })   # don't arm click-vs-drag
        $t.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Invoke-JumpToAtt })
    }
    $script:PillCluster[$cdef[0]] = $t
    [void]$pillClusterPanel.Children.Add($t)
}
$pillZzz = New-Object System.Windows.Controls.TextBlock
$pillZzz.Text = 'zzz'
$pillZzz.FontSize = 13
$pillZzz.FontStyle = [System.Windows.FontStyles]::Italic
$pillZzz.Foreground = Get-Brush '#8A8A93'
$pillZzz.VerticalAlignment = 'Center'
$pillZzz.Margin = New-Object System.Windows.Thickness(1, 0, 2, 0)
$pillZzz.Visibility = 'Collapsed'
$script:PillCluster['zzz'] = $pillZzz
[void]$pillClusterPanel.Children.Add($pillZzz)
[void]$pillRow.Children.Add($pillClusterPanel)
$script:PillClusterPanel = $pillClusterPanel   # hidden during a drag: you carry ONLY the bird
[void]$script:PillBar.Children.Add($pillRow)
$script:PillBar.Visibility = 'Visible'   # PillCard's visibility is the gate now
$script:PillCard.Child = $script:PillBar
# the peek morph scales the big card in from the top - one persistent
# transform, animated per open/close, cleared after
$script:PeekScale = New-Object System.Windows.Media.ScaleTransform(1.0, 1.0)
$script:RootCard.RenderTransform = $script:PeekScale
$script:RootCard.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.0)

function Update-PillCluster([int]$Att, [int]$Work, [int]$Done, [int]$Quiet) {
    $vals = @{ att = $Att; work = $Work; done = $Done }
    foreach ($k in @('att', 'work', 'done')) {
        $t = $script:PillCluster[$k]
        if ($null -eq $t) { continue }
        $n = [int]$vals[$k]
        if ($n -le 0) {
            if ($t.Visibility -ne 'Collapsed') { $t.Visibility = 'Collapsed' }
        }
        else {
            $txt = [string][char]0x2022 + [string]$n
            if ($t.Text -ne $txt) { $t.Text = $txt }
            if ($t.Visibility -ne 'Visible') { $t.Visibility = 'Visible' }
        }
    }
    $z = $script:PillCluster['zzz']
    $wantZ = $(if (($Att + $Work + $Done + $Quiet) -eq 0) { 'Visible' } else { 'Collapsed' })
    if ($null -ne $z -and $z.Visibility -ne $wantZ) { $z.Visibility = $wantZ }
    $script:PillWorkCount = $Work
    if ($wantZ -eq 'Visible' -and -not $script:BirdDozing) {
        $script:BirdDozing = $true
        # drowsy bridges INTO sleep: half-lidded for a beat, then out cold
        if ($null -ne $script:BirdFaces['drowsy'] -and (Get-Date) -ge $script:BirdFaceHoldUntil) {
            Set-BirdFace 'drowsy'
            $script:BirdFaceHoldUntil = (Get-Date).AddMilliseconds(700)
        }
        Invoke-BirdMotion 'doze'
    }
    elseif ($wantZ -ne 'Visible' -and $script:BirdDozing) {
        $script:BirdDozing = $false
        # and OUT of sleep: he surfaces through drowsy, not a hard snap
        if ($null -ne $script:BirdFaces['drowsy'] -and (Get-Date) -ge $script:BirdFaceHoldUntil) {
            Set-BirdFace 'drowsy'
            $script:BirdFaceHoldUntil = (Get-Date).AddMilliseconds(450)
        }
        Invoke-BirdMotion 'wake'
    }
    Update-BirdFace
    if ($script:Compact -and -not $script:PillPeeked) {
        $tip = @()
        if ($Att -gt 0) { $tip += "$Att need you" }
        if ($Work -gt 0) { $tip += "$Work working" }
        if ($Done -gt 0) { $tip += "$Done done" }
        if ($Quiet -gt 0) { $tip += "$Quiet quiet" }
        if ($tip.Count -eq 0) { $tip = @('all quiet') }
        if ([double]$script:Pill5hPct -ge 0) {
            $tip += ('5h {0:0}%' -f [double]$script:Pill5hPct)
        }
        if ($script:RestorePending.Count -gt 0) {
            $tip += "$($script:RestorePending.Count) to restore"
        }
        $tipText = ($tip -join $script:Sep) + $script:Dash + 'click = full view'
        if ([string]$script:PillBar.ToolTip -ne $tipText) { $script:PillBar.ToolTip = $tipText }
    }
}

function Start-BirdAnim($Target, $Prop, $Anim, [double]$Base) {
    # every bird motion obeys the HoldEnd law: land on the base value and
    # RELEASE the property, or held values fight the next motion forever
    $done = { try { $Target.SetValue($Prop, $Base); $Target.BeginAnimation($Prop, $null) } catch { } }.GetNewClosure()
    $Anim.Add_Completed($done)
    $Target.BeginAnimation($Prop, $Anim)
}

function New-BirdKeyAnim([object[]]$Frames) {
    # frames: @(value, msFromStart), eased so the motion feels muscular
    $k = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
    $ease = New-Object System.Windows.Media.Animation.QuadraticEase
    $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseInOut
    foreach ($f in $Frames) {
        [void]$k.KeyFrames.Add((New-Object System.Windows.Media.Animation.EasingDoubleKeyFrame(
            [double]$f[0],
            [System.Windows.Media.Animation.KeyTime]::FromTimeSpan([TimeSpan]::FromMilliseconds([int]$f[1])),
            $ease)))
    }
    return $k
}

function Invoke-BirdMotion([string]$Kind) {
    # the bird is ALIVE - in moments, not loops. Ephemeral kinds (perk, hop,
    # tilt, settle) only play when the pill is actually on screen; state
    # kinds (doze, wake) fall back to setting the resting pose directly so
    # the bird is already asleep when you fold a quiet HUD into the pill.
    if ($null -eq $script:BirdScale) { return }
    try {
    $vis = ($script:Compact -and $script:PillCard.Visibility -eq 'Visible')
    $sx = [System.Windows.Media.ScaleTransform]::ScaleXProperty
    $sy = [System.Windows.Media.ScaleTransform]::ScaleYProperty
    $ra = [System.Windows.Media.RotateTransform]::AngleProperty
    $ty = [System.Windows.Media.TranslateTransform]::YProperty
    $tx = [System.Windows.Media.TranslateTransform]::XProperty
    switch ($Kind) {
        'perk' {
            # something newly needs you: puff up + indignant wiggle
            if (-not $vis) { return }
            foreach ($p in @($sx, $sy)) {
                $a = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 1.16,
                    (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(130))))
                $a.AutoReverse = $true
                Start-BirdAnim $script:BirdScale $p $a 1.0
            }
            Start-BirdAnim $script:BirdRot $ra (New-BirdKeyAnim @(
                @(0, 0), @(-9, 110), @(7, 230), @(-3, 320), @(0, 400))) 0.0
        }
        'hop' {
            # work finished: a happy double bounce with a landing squash
            if (-not $vis) { return }
            Start-BirdAnim $script:BirdShift $ty (New-BirdKeyAnim @(
                @(0, 0), @(-5.0, 120), @(0, 240), @(-2.0, 330), @(0, 430))) 0.0
            Start-BirdAnim $script:BirdScale $sy (New-BirdKeyAnim @(
                @(1.0, 0), @(1.0, 220), @(0.88, 270), @(1.0, 360))) 1.0
        }
        'tilt' {
            # supervising: a slow head-tilt at the work, then back
            if (-not $vis) { return }
            Start-BirdAnim $script:BirdRot $ra (New-BirdKeyAnim @(
                @(0, 0), @(6.5, 180), @(6.5, 380), @(0, 560))) 0.0
        }
        'bob' {
            # pecking at the work: two quick dips with a forward lean
            if (-not $vis) { return }
            Start-BirdAnim $script:BirdShift $ty (New-BirdKeyAnim @(
                @(0, 0), @(-2.4, 90), @(0.8, 180), @(-2.0, 270), @(0, 380))) 0.0
            Start-BirdAnim $script:BirdRot $ra (New-BirdKeyAnim @(
                @(0, 0), @(4.5, 120), @(4.5, 280), @(0, 400))) 0.0
        }
        'greet' {
            # you hovered: a tiny acknowledging bounce - hi.
            if (-not $vis) { return }
            Start-BirdAnim $script:BirdShift $ty (New-BirdKeyAnim @(
                @(0, 0), @(-2.6, 110), @(0, 230))) 0.0
            foreach ($p in @($sx, $sy)) {
                $a = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 1.07,
                    (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(110))))
                $a.AutoReverse = $true
                Start-BirdAnim $script:BirdScale $p $a 1.0
            }
        }
        'settle' {
            # parked after a drag: a small grounding squash
            if (-not $vis) { return }
            $a = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.88,
                (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(110))))
            $a.AutoReverse = $true
            Start-BirdAnim $script:BirdScale $sy $a 1.0
        }
        'look' {
            # idle antic: glance left, hold, glance right, hold, back - the
            # head turn is sold by rotation + a tiny sideways lean together
            if (-not $vis) { return }
            Start-BirdAnim $script:BirdRot $ra (New-BirdKeyAnim @(
                @(0, 0), @(-8, 170), @(-8, 560), @(8, 800), @(8, 1180), @(0, 1380))) 0.0
            Start-BirdAnim $script:BirdShift $tx (New-BirdKeyAnim @(
                @(0, 0), @(-2.4, 170), @(-2.4, 560), @(2.4, 800), @(2.4, 1180), @(0, 1380))) 0.0
        }
        'ruffle' {
            # idle antic: a dog-shaking-off-water feather ruffle - fast
            # rotation shimmy with a jelly puff (X and Y in opposition)
            if (-not $vis) { return }
            Start-BirdAnim $script:BirdRot $ra (New-BirdKeyAnim @(
                @(0, 0), @(-5, 60), @(5, 125), @(-4, 190), @(4, 255), @(-2, 315), @(0, 375))) 0.0
            Start-BirdAnim $script:BirdScale $sx (New-BirdKeyAnim @(
                @(1.0, 0), @(1.14, 85), @(0.92, 170), @(1.10, 250), @(0.97, 320), @(1.0, 390))) 1.0
            Start-BirdAnim $script:BirdScale $sy (New-BirdKeyAnim @(
                @(1.0, 0), @(0.90, 85), @(1.08, 170), @(0.94, 250), @(1.03, 320), @(1.0, 390))) 1.0
        }
        'hopturn' {
            # idle antic: hops, turns his BACK on you (ScaleX through 0 to
            # -1 = a real pivot), sulks a beat, hops back around. Peak bird.
            if (-not $vis) { return }
            Start-BirdAnim $script:BirdShift $ty (New-BirdKeyAnim @(
                @(0, 0), @(-4.5, 110), @(0, 220), @(0, 1020), @(-4.5, 1130), @(0, 1240))) 0.0
            Start-BirdAnim $script:BirdScale $sx (New-BirdKeyAnim @(
                @(1.0, 0), @(-1.0, 250), @(-1.0, 1040), @(1.0, 1290))) 1.0
        }
        'doze' {
            # everything's quiet: lean over asleep (pose HOLDS via the base
            # value) and BREATHE - a slow forever scale cycle. The one loop
            # the perf law tolerates: it only runs when no session is doing
            # anything, on a ~60px surface. To-only lean = idempotent, so
            # re-folding a quiet HUD can restart the breath without a snap.
            if (-not $vis) { $script:BirdRot.Angle = -10.0; return }
            $a = New-Object System.Windows.Media.Animation.DoubleAnimation(-10.0,
                (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(650))))
            Start-BirdAnim $script:BirdRot $ra $a (-10.0)
            $breath = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 1.035,
                (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(1600))))
            $breath.AutoReverse = $true
            $breath.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
            $script:BirdScale.BeginAnimation($sy, $breath)
        }
        'wake' {
            # stop breathing-in-sleep FIRST, then straighten with a startle hop
            $script:BirdScale.BeginAnimation($sy, $null)
            $script:BirdScale.ScaleY = 1.0
            if (-not $vis) { $script:BirdRot.Angle = 0.0; return }
            $a = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0,
                (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(240))))
            Start-BirdAnim $script:BirdRot $ra $a 0.0
            Start-BirdAnim $script:BirdShift $ty (New-BirdKeyAnim @(
                @(0, 240), @(-3.0, 330), @(0, 430))) 0.0
        }
    }
    }
    catch { }
}

function Set-BirdFace([string]$Key, [switch]$Instant) {
    # swap the bird's ART to a state face. The NEW face lands on the visible
    # Image IMMEDIATELY; the old face fades out on the overlay Image. A
    # killed animation can only cut the goodbye short - it can never strand
    # a stale face (v1 adopted the new face in Completed, and any
    # Clear-PillAnimations mid-fade left the bird stuck forever).
    if ($null -eq $script:PillBirdA) { return }
    $src = $script:BirdFaces[$Key]
    if ($null -eq $src) { $src = $script:BirdFaces['neutral']; $Key = 'neutral' }
    if ($null -eq $src -or $script:BirdFaceKey -eq $Key) { return }
    $script:BirdFaceKey = $Key
    try {
        $opProp = [System.Windows.UIElement]::OpacityProperty
        $old = $script:PillBirdA.Source
        $script:PillBirdB.BeginAnimation($opProp, $null)
        $script:PillBirdA.Source = $src
        if ($Instant -or $null -eq $old -or
            -not ($script:Compact -and $script:PillCard.Visibility -eq 'Visible')) {
            $script:PillBirdB.Opacity = 0.0
            return
        }
        $script:PillBirdB.Source = $old
        $script:PillBirdB.Opacity = 1.0
        $fade = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0,
            (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(120))))
        $fade.Add_Completed({
            try {
                $script:PillBirdB.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
                $script:PillBirdB.Opacity = 0.0
            }
            catch { }
        })
        $script:PillBirdB.BeginAnimation($opProp, $fade)
    }
    catch { }
}

function Update-BirdFace {
    # dominant-status face, lowest to highest priority - later wins. Moment
    # faces (wave/happy/launch/grabbed/hatch) override via BirdFaceHoldUntil.
    if ((Get-Date) -lt $script:BirdFaceHoldUntil) { return }
    $key = 'neutral'
    if ($script:BirdDozing) { $key = 'sleep' }
    if ($script:PillWorkCount -gt 0) { $key = 'focused' }
    if ($script:PillDoneAll) { $key = 'crown' }
    # a session you've IGNORED past ParkMinutes: the meme side-eye. Beats
    # crown (a parked session is still waiting, no matter how smug he feels)
    if ($script:PillParkedCount -gt 0) { $key = 'sideeye' }
    if ([double]$script:Pill5hPct -ge 90.0) { $key = 'hot' }
    if ($script:PillErrCount -gt 0) { $key = 'worried' }
    # NOTE: no permanent 'alert' - attention almost always exists, and a
    # permanently shocked bird reads as a bug. Fresh attention holds the
    # alert face for 45s from the hasNew pulse instead; the red count and
    # the chips carry the standing state.
    if ([double]$script:Pill5hPct -ge 99.5) { $key = 'knocked' }
    Set-BirdFace $key
    # hot runs the frantic-fan loop (hot/hot2 alternation) - (re)arm it
    # whenever the resting face is hot and the pill is on screen; the
    # timer stops itself the moment either condition breaks
    if ($key -eq 'hot' -and $null -ne $script:BirdFanTimer -and -not $script:BirdFanTimer.IsEnabled -and
        $null -ne $script:BirdFaces['hot2'] -and $script:Compact -and
        $script:PillCard.Visibility -eq 'Visible') { $script:BirdFanTimer.Start() }
}

function Invoke-JumpToAtt {
    # red = jump, everywhere: the pill's red count and the 'need you' chip
    # both land you in the LONGEST-WAITING attention session's terminal.
    # Same debounce discipline as row clicks - focusing can involve console
    # probes and a UIA tab walk, seconds of blocked UI thread.
    $sess = $script:PillAttTarget
    if ($null -eq $sess -or $script:FocusBusy) { return }
    # aviator moment: show the takeoff face and FLUSH a render pass before
    # the focus dance blocks the UI thread - otherwise it appears after
    if ($null -ne $script:BirdFaces['launch'] -and $null -ne $script:PillBirdA) {
        $script:BirdFaceHoldUntil = (Get-Date).AddMilliseconds(1500)
        $script:BirdFaceKey = 'launch'
        $script:PillBirdA.Source = $script:BirdFaces['launch']
        try { $script:Window.Dispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Render) } catch { }
    }
    if ([string]$sess.Id -eq $script:LastFocusId -and
        ((Get-Date) - $script:LastFocusStamp).TotalMilliseconds -lt 1500) { return }
    $script:FocusBusy = $true
    try { [void](Invoke-FocusSession $sess) }
    catch { }
    finally {
        $script:FocusBusy = $false
        $script:LastFocusId = [string]$sess.Id
        $script:LastFocusStamp = Get-Date
    }
}

function Update-PillRing {
    # the bird's halo of consequence: 5h usage as an arc. Rebuilt only when
    # the rounded pct or color changes - between changes it costs nothing.
    if ($null -eq $script:PillRingArc) { return }
    $pct = [double]$script:Pill5hPct
    $key = ('{0:0}|{1}' -f $pct, $script:Pill5hHex)
    if ($key -eq $script:PillRingKey) { return }
    $script:PillRingKey = $key
    if ($pct -lt 0) {
        $script:PillRingArc.Visibility = 'Collapsed'
        return
    }
    $script:PillRingArc.Stroke = Get-Brush $script:Pill5hHex
    $r = 24.6
    if ($pct -ge 99.5) {
        # a closed arc is degenerate geometry - full circle gets an ellipse
        $eg = New-Object System.Windows.Media.EllipseGeometry(
            (New-Object System.Windows.Point(26, 26)), $r, $r)
        $eg.Freeze()
        $script:PillRingArc.Data = $eg
    }
    else {
        $ang = [Math]::Max(0.02, $pct / 100.0) * 2.0 * [Math]::PI
        $fig = New-Object System.Windows.Media.PathFigure
        $fig.StartPoint = New-Object System.Windows.Point(26.0, (26.0 - $r))
        $arc = New-Object System.Windows.Media.ArcSegment(
            (New-Object System.Windows.Point((26.0 + $r * [Math]::Sin($ang)), (26.0 - $r * [Math]::Cos($ang)))),
            (New-Object System.Windows.Size($r, $r)),
            0, ($pct -gt 50), 'Clockwise', $true)
        [void]$fig.Segments.Add($arc)
        $geo = New-Object System.Windows.Media.PathGeometry
        [void]$geo.Figures.Add($fig)
        $geo.Freeze()
        $script:PillRingArc.Data = $geo
    }
    if ($script:PillRingArc.Visibility -ne 'Visible') { $script:PillRingArc.Visibility = 'Visible' }
}

function Set-GlassBackdrop([bool]$On) {
    # needs a real hwnd - called again from SourceInitialized for the boot path
    try {
        $h = (New-Object System.Windows.Interop.WindowInteropHelper($script:Window)).Handle
        if ($h -eq [IntPtr]::Zero) { return }
        if ($On) {
            [ClaudeHud.Glass]::SetRoundCorners($h, $true)
            # tint is ABGR: ~18% warm near-black. As LOW as readability
            # allows - the more of the world shows through, the more it
            # reads as actual glass instead of fogged plexiglass
            [ClaudeHud.Glass]::SetAcrylic($h, $true, 0x2E14100D)
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
    $overlays = @($script:GlassDome, $script:GlassStreak, $script:GlassInner, $script:GlassRim)
    if ($glass) {
        # liquid glass: REAL backdrop blur (acrylic) + layered optics - a
        # radial dome of light, reflection streaks, a bright inner highlight
        # edge and a light-catching outer rim over a barely-there film.
        # margin 0 because the acrylic covers the whole hwnd rect - any
        # transparent margin would show a square blur slab around the card.
        $script:RootCard.Margin = New-Object System.Windows.Thickness(0)
        $script:RootCard.CornerRadius = New-Object System.Windows.CornerRadius(9)
        $script:RootCard.Effect = $null
        $script:RootCard.BorderBrush = Get-Brush '#00FFFFFF'
        $film = New-Object System.Windows.Media.LinearGradientBrush
        $film.StartPoint = New-Object System.Windows.Point(0, 0)
        $film.EndPoint = New-Object System.Windows.Point(0, 1)
        foreach ($stop in @(@('#1FFFFFFF', 0.0), @('#06FFFFFF', 0.5), @('#12000000', 1.0))) {
            [void]$film.GradientStops.Add((New-Object System.Windows.Media.GradientStop(
                [System.Windows.Media.ColorConverter]::ConvertFromString($stop[0]), [double]$stop[1])))
        }
        $film.Freeze()
        $script:RootCard.Background = $film
        foreach ($o in $overlays) { $o.Visibility = 'Visible' }
        $script:GlassRim.BorderBrush = $script:RimGradient
        $script:ThemeFxUnder.Visibility = 'Collapsed'
        $script:ThemeFxOver.Visibility = 'Collapsed'
    }
    else {
        # every non-glass theme is data, not code: walls + border + halo
        # from the catalog. unknown names (old configs, typos) -> midnight.
        $spec = $script:ThemeSpecs[$script:ThemeName]
        if ($null -eq $spec -or $null -eq $spec.Bg) { $spec = $script:ThemeSpecs['midnight'] }
        $script:RootCard.Margin = New-Object System.Windows.Thickness(12)
        $script:RootCard.CornerRadius = New-Object System.Windows.CornerRadius(16)
        $script:RootCard.Effect = $script:CardShadow
        $script:RootCard.BorderBrush = $spec.BorderBrush
        $script:RootCard.Background = $spec.Bg
        foreach ($o in $overlays) { $o.Visibility = 'Collapsed' }
        # under-layer: light source as background + inner glint as border
        $script:ThemeFxUnder.Background = $spec.FxUnder
        if ($null -ne $spec.FxUnderEdge) {
            $script:ThemeFxUnder.BorderBrush = $spec.FxUnderEdge
            $script:ThemeFxUnder.BorderThickness = New-Object System.Windows.Thickness(1)
        }
        else {
            $script:ThemeFxUnder.BorderBrush = $null
            $script:ThemeFxUnder.BorderThickness = New-Object System.Windows.Thickness(0)
        }
        $script:ThemeFxUnder.Visibility = $(
            if ($null -ne $spec.FxUnder -or $null -ne $spec.FxUnderEdge) { 'Visible' } else { 'Collapsed' })
        if ($null -ne $spec.FxOver) {
            $script:ThemeFxOver.Background = $spec.FxOver
            $script:ThemeFxOver.Visibility = 'Visible'
        }
        else { $script:ThemeFxOver.Visibility = 'Collapsed' }
    }
    # the bird's halo matches the room
    try {
        if ($null -ne $script:LogoImg) {
            $sp = $script:ThemeSpecs[$script:ThemeName]
            $glowHex = '#E07B54'
            if ($null -ne $sp -and $sp.Glow) { $glowHex = [string]$sp.Glow }
            $ds = New-Object System.Windows.Media.Effects.DropShadowEffect
            $ds.BlurRadius = 7
            $ds.ShadowDepth = 0
            $ds.Opacity = 0.55
            $ds.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($glowHex)
            $ds.Freeze()
            $script:LogoImg.Effect = $ds
        }
    }
    catch { }
    # dress the pill card to match the room
    try {
        if ($glass) {
            $script:PillCard.Background = $script:RootCard.Background   # the film
            $script:PillCard.BorderBrush = Get-Brush '#59FFFFFF'
            $script:PillCard.Margin = New-Object System.Windows.Thickness(0)
        }
        else {
            $pspec = $script:ThemeSpecs[$script:ThemeName]
            if ($null -eq $pspec -or $null -eq $pspec.Bg) { $pspec = $script:ThemeSpecs['midnight'] }
            $script:PillCard.Background = $pspec.Bg
            $script:PillCard.BorderBrush = $pspec.BorderBrush
            $script:PillCard.Margin = New-Object System.Windows.Thickness(8)
        }
    }
    catch { }
    Set-GlassBackdrop $glass
}

$script:Compact = $false
function Set-PillEdgeAnchor {
    # island rule: grow AWAY from the screen edge you hug. If the widget
    # lives on the right half, pin its right edge across the resize; on the
    # left half, Left already stays put and nothing needs doing.
    $script:AnchorRight = 0.0
    if (-not $script:Window.IsLoaded) { return }
    try {
        $wa = [System.Windows.SystemParameters]::WorkArea
        $mid = $wa.Left + ($wa.Width / 2.0)
        if (($script:Window.Left + ($script:Window.ActualWidth / 2.0)) -ge $mid) {
            $script:AnchorRight = $script:Window.Left + $script:Window.ActualWidth
        }
    }
    catch { }
}

function Set-CompactMode([bool]$On) {
    # compact = THE PILL: the bird wearing its 5h ring + colored counts.
    # Hover peeks chips + limit bars, double-click expands. Everything
    # still lives (chirp, red pulse, taskbar flash) - it just takes ~150px.
    $script:Compact = $On
    Clear-PillAnimations
    Set-PillEdgeAnchor
    if ($On) {
        $script:PillPeeked = $false
        # the peek card = header + chips + limits at 264, no rows
        $script:Header.Visibility = 'Visible'
        $script:ChipsPanel.Visibility = 'Visible'
        $script:LimitsPanel.Visibility = 'Visible'
        $script:RowsScroll.Visibility = 'Collapsed'
        $script:Divider.Visibility = 'Collapsed'
        $script:RootCard.Visibility = 'Collapsed'
        $script:RootCard.Width = 264.0
        $script:PillCard.Visibility = 'Visible'
        $script:Window.SizeToContent = 'WidthAndHeight'
        $script:MiniBtn.Text = [string][char]0x25FB   # restore glyph
        $script:MiniBtn.ToolTip = 'expand (or just click the pill)'
        # folding a quiet HUD: the bird should already be asleep AND breathing
        if ($script:BirdDozing) { Invoke-BirdMotion 'doze' }
    }
    else {
        $script:PillCard.Visibility = 'Collapsed'
        $script:RootCard.Visibility = 'Visible'
        $script:RootCard.Width = [double]::NaN
        $script:Header.Visibility = 'Visible'
        $script:ChipsPanel.Visibility = 'Visible'
        $script:LimitsPanel.Visibility = 'Visible'
        $script:RowsScroll.Visibility = 'Visible'
        $script:Divider.Visibility = 'Visible'
        $script:Window.SizeToContent = 'Height'
        $script:Window.Width = 324
        # no Apply-Theme here: pill v2 never restyles RootCard, and the call
        # cost DWM round-trips on every expand. The rows FADE in instead -
        # render-only, so the single hwnd jump reads as designed, not lag.
        try {
            $rf = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0,
                (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(140))))
            $rf.Add_Completed({
                try {
                    $script:RowsScroll.Opacity = 1.0
                    $script:RowsScroll.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
                }
                catch { }
            })
            $script:RowsScroll.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $rf)
        }
        catch { }
        $script:MiniBtn.Text = [string][char]0x2013   # minimize glyph
        $script:MiniBtn.ToolTip = 'compact mode (double-click the header works too)'
    }
}

function Set-PillPeek([bool]$On) {
    # hover = CROSSFADE pill -> mini card (header + chips + limit bars).
    # v1 animated the window rect and stuttered: every frame was a
    # SetWindowPos + full layout + layered-window readback, and the
    # measure trick flashed an intermediate rect. Now the hwnd resizes
    # ONCE per direction (a visibility flip under SizeToContent) and
    # everything animated is render-only (opacity + scale) - software
    # rendering glides through that.
    if (-not $script:Compact) { return }
    if ($On -eq $script:PillPeeked) { return }
    $script:PillPeeked = $On
    Clear-PillAnimations
    Set-PillEdgeAnchor
    $opProp = [System.Windows.UIElement]::OpacityProperty
    if ($On) {
        $script:PillBar.ToolTip = $null   # the open card IS the tooltip
        $script:PillCloseTimer.Interval = [TimeSpan]::FromSeconds(5)
        $script:PillCloseTimer.Stop()
        $script:PillCloseTimer.Start()    # the peek closes itself; clicks are the only opener
        $script:RootCard.Opacity = 0.0
        $script:RootCard.Visibility = 'Visible'   # single hwnd grow via SizeToContent
        $durIn = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(170))
        $ease = New-Object System.Windows.Media.Animation.CubicEase
        $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseOut
        $fadeIn = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, $durIn)
        $fadeIn.EasingFunction = $ease
        $fadeIn.Add_Completed({
            try {
                if ($script:PillPeeked) {
                    $script:RootCard.Opacity = 1.0
                    $script:RootCard.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
                    $script:PillCard.Visibility = 'Hidden'   # out of render + input, keeps layout
                }
            }
            catch { }
        })
        foreach ($sp in @([System.Windows.Media.ScaleTransform]::ScaleXProperty,
                          [System.Windows.Media.ScaleTransform]::ScaleYProperty)) {
            $grow = New-Object System.Windows.Media.Animation.DoubleAnimation(0.94, 1.0, $durIn)
            $grow.EasingFunction = $ease
            $script:PeekScale.BeginAnimation($sp, $grow)
        }
        $script:RootCard.BeginAnimation($opProp, $fadeIn)
        $pillOut = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0,
            (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(110))))
        $script:PillCard.BeginAnimation($opProp, $pillOut)
    }
    else {
        $script:PillCloseTimer.Stop()
        $script:PillCard.Visibility = 'Visible'
        $script:PillCard.Opacity = 0.0
        $durOut = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(130))
        $fadeOut = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0, $durOut)
        $fadeOut.Add_Completed({
            try {
                if (-not $script:PillPeeked) {
                    $script:RootCard.Visibility = 'Collapsed'   # single hwnd shrink
                    $script:RootCard.Opacity = 1.0
                    $script:RootCard.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
                    # Clear-PillAnimations stopped the sleeping breath on peek
                    # open - if he's still asleep, resume it
                    if ($script:BirdDozing) { Invoke-BirdMotion 'doze' }
                }
            }
            catch { }
        })
        $script:RootCard.BeginAnimation($opProp, $fadeOut)
        $pillIn = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, $durOut)
        $script:PillCard.BeginAnimation($opProp, $pillIn)
    }
}

function Set-PillFoldInstant {
    # a drag is starting: snap the peek back to the pill with NO animation,
    # so the user always drags the tiny pill - never the open island. No
    # right-edge anchoring here either: keeping Left fixed leaves the pill
    # right where the card's top-left corner (the natural grab spot) was.
    if (-not $script:Compact -or -not $script:PillPeeked) { return }
    $script:PillPeeked = $false
    Clear-PillAnimations
    $script:AnchorRight = 0.0
    $script:PillCard.Visibility = 'Visible'
    $script:RootCard.Visibility = 'Collapsed'
}

function Clear-PillAnimations {
    # release every held animation so base values rule again - a mode
    # change mid-crossfade must not fight HoldEnd values
    try {
        $opProp = [System.Windows.UIElement]::OpacityProperty
        foreach ($el in @($script:RootCard, $script:PillCard)) {
            $el.BeginAnimation($opProp, $null)
            $el.Opacity = 1.0
        }
        foreach ($sp in @([System.Windows.Media.ScaleTransform]::ScaleXProperty,
                          [System.Windows.Media.ScaleTransform]::ScaleYProperty)) {
            $script:PeekScale.BeginAnimation($sp, $null)
        }
        $script:PeekScale.ScaleX = 1.0
        $script:PeekScale.ScaleY = 1.0
        if ($null -ne $script:BirdScale) {
            foreach ($bp in @([System.Windows.Media.ScaleTransform]::ScaleXProperty,
                              [System.Windows.Media.ScaleTransform]::ScaleYProperty)) {
                $script:BirdScale.BeginAnimation($bp, $null)
            }
            $script:BirdScale.ScaleX = 1.0; $script:BirdScale.ScaleY = 1.0
            $script:BirdRot.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
            $script:BirdRot.Angle = $(if ($script:BirdDozing) { -10.0 } else { 0.0 })
            $script:BirdShift.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
            $script:BirdShift.Y = 0.0
            $script:BirdShift.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $null)
            $script:BirdShift.X = 0.0
            if ($null -ne $script:PillBirdB) {
                $script:PillBirdB.BeginAnimation($opProp, $null)
                $script:PillBirdB.Opacity = 0.0
            }
        }
    }
    catch { }
}

# CLICK-DRIVEN peek (hover triggers NOTHING - the user hated the pill
# changing state under a passing cursor): click the pill = peek opens,
# click the peek = full view. The peek closes ITSELF a few seconds after
# you leave it - the timer only ever closes, never opens, and it extends
# politely while the cursor is still reading the card.
$script:PillDragging = $false   # DragMove() pumps a nested message loop, so
                                # the close timer TICKS DURING A DRAG - the
                                # flag keeps it from acting mid-carry
$script:PillDragEnd = [datetime]::MinValue
$script:PillCloseTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PillCloseTimer.Interval = [TimeSpan]::FromSeconds(5)
$script:PillCloseTimer.Add_Tick({
    $script:PillCloseTimer.Stop()
    try {
        if (-not $script:Compact -or -not $script:PillPeeked -or $script:PillDragging) { return }
        if ($script:RootCard.IsMouseOver) {
            # still reading it - check again soon
            $script:PillCloseTimer.Interval = [TimeSpan]::FromSeconds(3)
            $script:PillCloseTimer.Start()
            return
        }
        Set-PillPeek $false
    }
    catch { }
})
# the LIFE timer: while sessions work, the bird supervises (head-tilt /
# peck every minute or so). While he's awake with nothing running, he does
# idle antics - look around, feather ruffle, hop-turn - on a quicker beat,
# because a creature that just stands there is a status icon. All
# render-only animations on a ~60px surface; the cost is nothing. Never
# mid-drag: the dispatcher pumps this timer during DragMove and an antic
# would fight the carry pendulum.
$script:BirdTiltTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:BirdTiltTimer.Interval = [TimeSpan]::FromSeconds(52)
$script:BirdTiltTimer.Add_Tick({
    try {
        $script:BirdTiltTimer.Interval = [TimeSpan]::FromSeconds((Get-Random -Minimum 45 -Maximum 76))
        if (-not $script:Compact -or $script:BirdDozing -or $script:PillDragging) { return }
        if ($script:PillWorkCount -gt 0) {
            # supervising: sometimes a head-tilt, sometimes a peck
            Invoke-BirdMotion $(if ((Get-Random -Minimum 0 -Maximum 2) -eq 0) { 'tilt' } else { 'bob' })
        }
        else {
            # awake, nothing running: he entertains himself
            Invoke-BirdMotion (Get-Random -InputObject @('look', 'ruffle', 'hopturn'))
            $script:BirdTiltTimer.Interval = [TimeSpan]::FromSeconds((Get-Random -Minimum 22 -Maximum 49))
        }
    }
    catch { }
})
$script:BirdTiltTimer.Start()
# the blink/sip beat: every 4-9s, the neutral face closes its eyes for
# 140ms - and the parked SIDEEYE raises the cup and sips for 400ms. Same
# machinery, direct Source swaps (no crossfade) - both ARE hard cuts.
# Other faces sit this out: blinking away glasses/hats reads as a glitch.
$script:BirdUnblinkTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:BirdUnblinkTimer.Interval = [TimeSpan]::FromMilliseconds(140)
$script:BirdUnblinkTimer.Add_Tick({
    $script:BirdUnblinkTimer.Stop()
    try {
        if (($script:BirdFaceKey -eq 'neutral' -or $script:BirdFaceKey -eq 'sideeye') -and
            $null -ne $script:PillBirdA) {
            $script:PillBirdA.Source = $script:BirdFaces[$script:BirdFaceKey]
        }
    }
    catch { }
})
$script:BirdBlinkTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:BirdBlinkTimer.Interval = [TimeSpan]::FromSeconds(6)
$script:BirdBlinkTimer.Add_Tick({
    try {
        $script:BirdBlinkTimer.Interval = [TimeSpan]::FromMilliseconds((Get-Random -Minimum 4000 -Maximum 9000))
        if (-not ($script:Compact -and $script:PillCard.Visibility -eq 'Visible' -and
                  $null -ne $script:PillBirdA -and (Get-Date) -ge $script:BirdFaceHoldUntil)) { return }
        if ($script:BirdFaceKey -eq 'neutral' -and $null -ne $script:BirdFaces['blink']) {
            $script:PillBirdA.Source = $script:BirdFaces['blink']
            $script:BirdUnblinkTimer.Interval = [TimeSpan]::FromMilliseconds(140)
        }
        elseif ($script:BirdFaceKey -eq 'sideeye' -and $null -ne $script:BirdFaces['sideeye2']) {
            # parked: he periodically SIPS while judging you
            $script:PillBirdA.Source = $script:BirdFaces['sideeye2']
            $script:BirdUnblinkTimer.Interval = [TimeSpan]::FromMilliseconds(400)
        }
        else { return }
        $script:BirdUnblinkTimer.Stop()
        $script:BirdUnblinkTimer.Start()
    }
    catch { }
})
$script:BirdBlinkTimer.Start()
# the flap burst: while the happy hop plays, happy/happy2 alternate every
# 90ms - eight swaps of ACTUAL wing-flapping with confetti physics. Fired
# by the done-count rise (same place as the hop), self-stopping.
$script:BirdFlapTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:BirdFlapTimer.Interval = [TimeSpan]::FromMilliseconds(90)
$script:BirdFlapTimer.Add_Tick({
    try {
        $script:BirdFlapN++
        if ($script:BirdFlapN -gt 8 -or $script:BirdFaceKey -ne 'happy' -or
            $null -eq $script:PillBirdA -or $null -eq $script:BirdFaces['happy2']) {
            $script:BirdFlapTimer.Stop()
            if ($script:BirdFaceKey -eq 'happy' -and $null -ne $script:PillBirdA) {
                $script:PillBirdA.Source = $script:BirdFaces['happy']
            }
            return
        }
        $script:PillBirdA.Source = $script:BirdFaces[$(if ($script:BirdFlapN % 2 -eq 1) { 'happy2' } else { 'happy' })]
    }
    catch { $script:BirdFlapTimer.Stop() }
})
# the frantic fan: while the resting face is HOT, hot/hot2 alternate every
# 180ms - he fans himself in real time for as long as he's cooking. Armed
# by Update-BirdFace, stops itself when the face or the pill goes away.
$script:BirdFanTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:BirdFanTimer.Interval = [TimeSpan]::FromMilliseconds(180)
$script:BirdFanTimer.Add_Tick({
    try {
        if ($script:BirdFaceKey -ne 'hot' -or -not $script:Compact -or
            $script:PillCard.Visibility -ne 'Visible' -or $null -eq $script:PillBirdA -or
            $null -eq $script:BirdFaces['hot2']) { $script:BirdFanTimer.Stop(); return }
        $script:BirdFanFlip = -not $script:BirdFanFlip
        $script:PillBirdA.Source = $script:BirdFaces[$(if ($script:BirdFanFlip) { 'hot2' } else { 'hot' })]
    }
    catch { $script:BirdFanTimer.Stop() }
})
# CARRY PHYSICS: while you drag him, a 30ms sampler reads the window's
# horizontal velocity and drives a spring-damped pendulum - he tilts
# against the motion, overshoots, and wobbles back when you stop. The
# dispatcher pumps timers during DragMove, so this runs mid-carry.
$script:CarrySwingTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:CarrySwingTimer.Interval = [TimeSpan]::FromMilliseconds(30)
$script:CarrySwingTimer.Add_Tick({
    try {
        if (-not $script:PillDragging) { $script:CarrySwingTimer.Stop(); return }
        $x = $script:Window.Left
        $vx = ($x - $script:CarryLastX) / 0.03
        $script:CarryLastX = $x
        # CARTOON tuning: double tilt per speed, wide swing, low damping -
        # a hard stop rings him like a bell for a few oscillations
        $target = [Math]::Max(-58.0, [Math]::Min(58.0, $vx * -0.095))
        $script:CarryAngVel += (($target - $script:CarryAngle) * 170.0 - $script:CarryAngVel * 4.2) * 0.03
        $script:CarryAngle += $script:CarryAngVel * 0.03
        if ($null -ne $script:BirdRot) { $script:BirdRot.Angle = $script:CarryAngle }
        # jelly: stretch with swing violence, squash sideways to compensate
        if ($null -ne $script:BirdScale) {
            $j = [Math]::Min(0.18, [Math]::Abs($script:CarryAngVel) * 0.00055)
            $script:BirdScale.ScaleY = 1.0 + $j
            $script:BirdScale.ScaleX = 1.0 - ($j * 0.5)
        }
        # SHAKE detection: violent direction flips in quick succession =
        # you're rattling the poor birb. Four fast flips and he starts
        # SWEARING at you mid-dangle (grawlix face, if the art exists) -
        # direct Source set, same as the grab face: holds rule mid-carry
        if ([Math]::Abs($vx) -gt 900) {
            $sign = [Math]::Sign($vx)
            if ($sign -ne $script:CarryLastSign) {
                if (((Get-Date) - $script:CarryFlipStamp).TotalMilliseconds -gt 900) { $script:CarryFlips = 0 }
                $script:CarryFlips++
                $script:CarryFlipStamp = Get-Date
                $script:CarryLastSign = $sign
                if ($script:CarryFlips -ge 4 -and $script:BirdFaceKey -ne 'cursing' -and
                    $null -ne $script:BirdFaces['cursing'] -and $null -ne $script:PillBirdA) {
                    $script:BirdFaceKey = 'cursing'
                    $script:PillBirdA.Source = $script:BirdFaces['cursing']
                }
            }
        }
    }
    catch { }
})
# boot = hatch: he arrives in his egg, then the first tick hatches him into
# whatever the day actually looks like. The hold is re-armed at first render:
# on slow boots (powershell host takes seconds to show the window) a hold
# started here would expire before anyone could see the egg.
if ($null -ne $script:BirdFaces['hatch'] -and $null -ne $script:PillBirdA) {
    $script:BirdFaceHoldUntil = (Get-Date).AddSeconds(30)   # guard until first render
    $script:BirdFaceKey = 'hatch'
    $script:PillBirdA.Source = $script:BirdFaces['hatch']
    $Window.Add_ContentRendered({
        if ($script:BirdFaceKey -eq 'hatch') {
            $script:BirdFaceHoldUntil = (Get-Date).AddMilliseconds(2200)
        }
    })
}
# hover triggers NOTHING - peek opens on click only (see HeaderClick)
$Window.Add_SizeChanged({
    param($s, $e)
    if ($script:AnchorRight -gt 0) {
        try { $script:Window.Left = $script:AnchorRight - $e.NewSize.Width } catch { }
        $script:AnchorRight = 0.0
    }
})

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
        if ($null -ne $st.PSObject.Properties['Calib']) {
            # learned 5h-window calibration pairs (official % vs local block
            # tokens) survive restarts - the offline bars stay trustworthy
            foreach ($cs in @($st.Calib)) {
                if ($null -ne $cs -and $null -ne $cs.PSObject.Properties['Tok'] -and [double]$cs.Pct -gt 0) {
                    [void]$script:BlockCalib.Add(@{ Tok = [long]$cs.Tok; Pct = [double]$cs.Pct; At = [string]$cs.At })
                }
            }
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

function New-ThemeSwatch([string]$Name) {
    # a little preview card in the settings dialog: click = LIVE preview of
    # the theme on the actual widget behind the dialog. cancel reverts.
    $wrap = New-Object System.Windows.Controls.StackPanel
    $wrap.Margin = New-Object System.Windows.Thickness(0, 2, 10, 0)
    $wrap.Cursor = [System.Windows.Input.Cursors]::Hand
    $wrap.Tag = $Name

    $ring = New-Object System.Windows.Controls.Border
    $ring.CornerRadius = New-Object System.Windows.CornerRadius(12)
    $ring.BorderThickness = New-Object System.Windows.Thickness(2)
    $ring.Padding = New-Object System.Windows.Thickness(2)
    $ring.BorderBrush = [System.Windows.Media.Brushes]::Transparent

    $prev = New-Object System.Windows.Controls.Border
    $prev.CornerRadius = New-Object System.Windows.CornerRadius(8)
    $prev.Width = 66; $prev.Height = 42
    $prev.BorderThickness = New-Object System.Windows.Thickness(1)
    switch ($Name) {
        'glass' {
            $g = New-Object System.Windows.Media.LinearGradientBrush
            $g.StartPoint = New-Object System.Windows.Point(0.2, 0)
            $g.EndPoint = New-Object System.Windows.Point(0.8, 1)
            foreach ($stop in @(@('#52FFFFFF', 0.0), @('#1AFFFFFF', 0.45), @('#0DFFFFFF', 1.0))) {
                [void]$g.GradientStops.Add((New-Object System.Windows.Media.GradientStop(
                    [System.Windows.Media.ColorConverter]::ConvertFromString($stop[0]), [double]$stop[1])))
            }
            $prev.Background = $g
            $prev.BorderBrush = Get-Brush '#8CFFFFFF'
        }
        default {
            $spec = $script:ThemeSpecs[$Name]
            if ($null -eq $spec -or $null -eq $spec.Bg) { $spec = $script:ThemeSpecs['midnight'] }
            $prev.Background = $spec.Bg
            $prev.BorderBrush = $spec.BorderBrush
        }
    }
    $dotHex = '#E07B54'
    $sw = $script:ThemeSpecs[$Name]
    if ($null -ne $sw -and $sw.Glow) { $dotHex = [string]$sw.Glow }
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 7; $dot.Height = 7
    $dot.Fill = Get-Brush $dotHex
    $dot.HorizontalAlignment = 'Left'; $dot.VerticalAlignment = 'Top'
    $dot.Margin = New-Object System.Windows.Thickness(7, 7, 0, 0)
    $prev.Child = $dot
    $ring.Child = $prev
    [void]$wrap.Children.Add($ring)

    $lbl = New-Object System.Windows.Controls.TextBlock
    $lbl.Text = $Name
    $lbl.FontSize = 10
    $lbl.Foreground = Get-Brush '#8A8A93'
    $lbl.HorizontalAlignment = 'Center'
    $lbl.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)
    [void]$wrap.Children.Add($lbl)

    $script:ThemePickRings[$Name] = $ring
    if ($Name -eq $script:PickTheme) { $ring.BorderBrush = Get-Brush '#E07B54' }

    $wrap.Add_MouseLeftButtonDown({
        param($s, $e)
        $script:PickTheme = [string]$s.Tag
        foreach ($k in @($script:ThemePickRings.Keys)) {
            $script:ThemePickRings[$k].BorderBrush = $(
                if ($k -eq $script:PickTheme) { Get-Brush '#E07B54' }
                else { [System.Windows.Media.Brushes]::Transparent })
        }
        $script:ThemeName = $script:PickTheme
        Apply-Theme   # live preview on the real widget
        $e.Handled = $true
    })
    return $wrap
}

function New-MascotSwatch([string]$Name) {
    # preview card in settings: the pack's neutral face + name. Click = LIVE
    # swap of the whole mascot on the real widget; cancel reverts. A pack that
    # can't produce a thumbnail still shows a labeled placeholder (never blank).
    $wrap = New-Object System.Windows.Controls.StackPanel
    $wrap.Margin = New-Object System.Windows.Thickness(0, 2, 10, 0)
    $wrap.Cursor = [System.Windows.Input.Cursors]::Hand
    $wrap.Tag = $Name

    $ring = New-Object System.Windows.Controls.Border
    $ring.CornerRadius = New-Object System.Windows.CornerRadius(12)
    $ring.BorderThickness = New-Object System.Windows.Thickness(2)
    $ring.Padding = New-Object System.Windows.Thickness(2)
    $ring.BorderBrush = [System.Windows.Media.Brushes]::Transparent

    $prev = New-Object System.Windows.Controls.Border
    $prev.CornerRadius = New-Object System.Windows.CornerRadius(8)
    $prev.Width = 54; $prev.Height = 54
    $prev.Background = Get-Brush '#14FFFFFF'
    $prev.BorderThickness = New-Object System.Windows.Thickness(1)
    $prev.BorderBrush = Get-Brush '#26FFFFFF'

    # thumbnail = that pack's neutral (root logo for bird, pack logo/neutral else)
    $thumbPath = $null
    if ($Name -eq 'bird') { $thumbPath = Join-Path $PSScriptRoot 'logo.png' }
    else {
        foreach ($n in @('logo.png', 'neutral.png')) {
            $p = Join-Path $PSScriptRoot ('assets\mascots\' + $Name + '\' + $n)
            if (Test-Path -LiteralPath $p) { $thumbPath = $p; break }
        }
    }
    $thumb = Import-MascotBitmap $thumbPath 96
    if ($null -ne $thumb) {
        $img = New-Object System.Windows.Controls.Image
        $img.Source = $thumb
        $img.Width = 40; $img.Height = 40
        $img.HorizontalAlignment = 'Center'; $img.VerticalAlignment = 'Center'
        [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($img, 'HighQuality')
        $prev.Child = $img
    }
    else {
        $ph = New-Object System.Windows.Controls.TextBlock
        $ph.Text = [string][char]0x2027   # tiny dot: pack present but art not generated yet
        $ph.FontSize = 18
        $ph.Foreground = Get-Brush '#66666E'
        $ph.HorizontalAlignment = 'Center'; $ph.VerticalAlignment = 'Center'
        $prev.Child = $ph
    }
    $ring.Child = $prev
    [void]$wrap.Children.Add($ring)

    $lbl = New-Object System.Windows.Controls.TextBlock
    $lbl.Text = $Name
    $lbl.FontSize = 10
    $lbl.Foreground = Get-Brush '#8A8A93'
    $lbl.HorizontalAlignment = 'Center'
    $lbl.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)
    [void]$wrap.Children.Add($lbl)

    $script:MascotPickRings[$Name] = $ring
    if ($Name -eq $script:PickMascot) { $ring.BorderBrush = Get-Brush '#E07B54' }

    $wrap.Add_MouseLeftButtonDown({
        param($s, $e)
        $script:PickMascot = [string]$s.Tag
        foreach ($k in @($script:MascotPickRings.Keys)) {
            $script:MascotPickRings[$k].BorderBrush = $(
                if ($k -eq $script:PickMascot) { Get-Brush '#E07B54' }
                else { [System.Windows.Media.Brushes]::Transparent })
        }
        $script:MascotPack = $script:PickMascot
        try { Load-MascotFaces; Update-BirdFace } catch { }   # live swap on the real widget
        $e.Handled = $true
    })
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

# ---------- claude account switcher ----------
# Switch which of YOUR paid Claude subscriptions new sessions use. Manual
# only, on purpose: no auto-rotation, no multi-account parallelism - just
# the login dance you already do by hand, without the dance. Tokens come
# from `claude setup-token` (official, 1-year lifetime) and are stored
# DPAPI-encrypted; a `claude` profile function injects the active one via
# CLAUDE_CODE_OAUTH_TOKEN (documented to take precedence) at every launch.
$script:AcctPath = Join-Path $env:LOCALAPPDATA 'AgentFocus\accounts.json'

function Get-Accounts {
    try {
        if (Test-Path -LiteralPath $script:AcctPath) {
            $a = Get-Content -LiteralPath $script:AcctPath -Raw | ConvertFrom-Json
            if ($null -ne $a) {
                if ($null -eq $a.PSObject.Properties['active']) { $a | Add-Member -NotePropertyName active -NotePropertyValue '' }
                if ($null -eq $a.PSObject.Properties['accounts']) { $a | Add-Member -NotePropertyName accounts -NotePropertyValue @() }
                return $a
            }
        }
    }
    catch { }
    return [pscustomobject]@{ active = ''; accounts = @() }
}

function Save-Accounts($Data) {
    try {
        $Data.accounts = @($Data.accounts)   # keep it an ARRAY through PS 5.1 json round-trips
        $Data | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $script:AcctPath -Encoding UTF8
    }
    catch { }
}

function Protect-AccountToken([string]$Plain) {
    Add-Type -AssemblyName System.Security
    return [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect(
        [System.Text.Encoding]::UTF8.GetBytes($Plain), $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
}

function Install-ClaudeLauncher {
    # a `claude` function in the PowerShell profile(s): reads the ACTIVE
    # account at every launch and injects its token via CLAUDE_CODE_OAUTH_TOKEN.
    # Same command you always type; marker-guarded so it installs once.
    $block = @'

# >>> perch account launcher >>>
function claude {
    try {
        $acctFile = Join-Path $env:LOCALAPPDATA 'AgentFocus\accounts.json'
        if (Test-Path -LiteralPath $acctFile) {
            $aj = Get-Content -LiteralPath $acctFile -Raw | ConvertFrom-Json
            $act = @($aj.accounts) | Where-Object { $_.id -eq $aj.active } | Select-Object -First 1
            if ($null -ne $act -and $act.token) {
                Add-Type -AssemblyName System.Security
                $env:CLAUDE_CODE_OAUTH_TOKEN = [System.Text.Encoding]::UTF8.GetString(
                    [System.Security.Cryptography.ProtectedData]::Unprotect(
                        [Convert]::FromBase64String([string]$act.token), $null,
                        [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
            }
        }
    }
    catch { }
    $exe = Get-Command claude.exe -ErrorAction SilentlyContinue
    if ($null -ne $exe) { & $exe.Source @args } else { Write-Error 'claude.exe not found in PATH' }
}
# <<< perch account launcher <<<
'@
    foreach ($prof in @(
        (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WindowsPowerShell\Microsoft.PowerShell_profile.ps1'),
        (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'PowerShell\Microsoft.PowerShell_profile.ps1'))) {
        try {
            $dir = Split-Path $prof -Parent
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            $existing = ''
            if (Test-Path -LiteralPath $prof) { $existing = Get-Content -LiteralPath $prof -Raw }
            if ($existing -notlike '*perch account launcher*') {
                Add-Content -LiteralPath $prof -Value $block
            }
        }
        catch { }
    }
}

function Show-AccountsDisclaimer {
    # honest modal, shown once: this automates switching between the user's
    # OWN paid subscriptions, but Anthropic's ToS stance on rotating accounts
    # around usage limits is not clear - their call to make.
    $script:DisclaimerOk = $false
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
    $card.Padding = New-Object System.Windows.Thickness(18, 14, 18, 14)

    $stack = New-Object System.Windows.Controls.StackPanel
    $stack.Width = 280

    $title = New-Object System.Windows.Controls.TextBlock
    $title.Text = 'heads up'
    $title.FontSize = 12.5
    $title.FontWeight = [System.Windows.FontWeights]::SemiBold
    $title.Foreground = Get-Brush '#F4F4F8'
    $title.Margin = New-Object System.Windows.Thickness(0, 0, 0, 8)
    [void]$stack.Children.Add($title)

    $body = New-Object System.Windows.Controls.TextBlock
    $body.Text = "this switches which of YOUR paid Claude subscriptions new sessions use - the same thing you already do by hand with /login, minus the dance.`n`nhonesty corner: we are not sure where Anthropic's terms stand on rotating accounts around usage limits, even fully paid ones. no auto-switching happens, ever - every switch is your click, your call."
    $body.FontSize = 11
    $body.TextWrapping = 'Wrap'
    $body.Foreground = Get-Brush '#C0C0C8'
    $body.LineHeight = 16
    [void]$stack.Children.Add($body)

    $btnRow = New-Object System.Windows.Controls.StackPanel
    $btnRow.Orientation = 'Horizontal'
    $btnRow.HorizontalAlignment = 'Right'
    $btnRow.Margin = New-Object System.Windows.Thickness(0, 14, 0, 0)
    $btnOk = New-DialogButton 'i understand' $true
    $btnOk.Margin = New-Object System.Windows.Thickness(0, 0, 8, 0)
    $btnNo = New-DialogButton 'nevermind' $false
    $btnOk.Tag = $dlg
    $btnNo.Tag = $dlg
    $btnOk.Add_MouseLeftButtonUp({ param($s, $e) $script:DisclaimerOk = $true; $s.Tag.Close() })
    $btnNo.Add_MouseLeftButtonUp({ param($s, $e) $s.Tag.Close() })
    [void]$btnRow.Children.Add($btnOk)
    [void]$btnRow.Children.Add($btnNo)
    [void]$stack.Children.Add($btnRow)

    $card.Child = $stack
    $dlg.Content = $card
    $dlg.Add_KeyDown({ param($s, $e) if ($e.Key -eq 'Escape') { $s.Close() } })
    $script:UiHold++; $script:UiHoldStamp = Get-Date
    try { [void]$dlg.ShowDialog() }
    finally { $script:UiHold = [Math]::Max(0, $script:UiHold - 1) }
    return $script:DisclaimerOk
}

function Show-AddAccountDialog {
    # label + pasted `claude setup-token` output -> encrypted account entry
    $script:AddAcctResult = $null
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
    $stack.Width = 260

    $title = New-Object System.Windows.Controls.TextBlock
    $title.Text = 'add claude account'
    $title.FontSize = 11
    $title.Foreground = Get-Brush '#8A8A93'
    $title.Margin = New-Object System.Windows.Thickness(0, 0, 0, 6)
    [void]$stack.Children.Add($title)

    [void]$stack.Children.Add((New-DarkLabel 'name (e.g. the email)'))
    $inLabel = New-InputBox ''
    [void]$stack.Children.Add($inLabel)

    [void]$stack.Children.Add((New-DarkLabel 'token from `claude setup-token` (run it while logged into that account)'))
    $inToken = New-InputBox ''
    [void]$stack.Children.Add($inToken)

    $hint = New-Object System.Windows.Controls.TextBlock
    $hint.Text = 'stored encrypted (DPAPI, this windows user only)'
    $hint.FontSize = 9.5
    $hint.Foreground = Get-Brush '#6E6E78'
    $hint.Margin = New-Object System.Windows.Thickness(2, 6, 0, 0)
    [void]$stack.Children.Add($hint)

    $btnRow = New-Object System.Windows.Controls.StackPanel
    $btnRow.Orientation = 'Horizontal'
    $btnRow.HorizontalAlignment = 'Right'
    $btnRow.Margin = New-Object System.Windows.Thickness(0, 12, 0, 0)
    $btnAdd = New-DialogButton 'add' $true
    $btnAdd.Margin = New-Object System.Windows.Thickness(0, 0, 8, 0)
    $btnCancel = New-DialogButton 'cancel' $false
    $dlg.Tag = @{ Label = $inLabel.Child; Token = $inToken.Child }
    $btnAdd.Tag = $dlg
    $btnCancel.Tag = $dlg
    $btnAdd.Add_MouseLeftButtonUp({
        param($s, $e)
        $c = $s.Tag.Tag
        $lbl = ([string]$c.Label.Text).Trim()
        $tok = ([string]$c.Token.Text).Trim()
        if ($lbl.Length -gt 0 -and $tok -like 'sk-ant-*') {
            $script:AddAcctResult = @{ Label = $lbl; Token = $tok }
            $s.Tag.Close()
        }
    })
    $btnCancel.Add_MouseLeftButtonUp({ param($s, $e) $s.Tag.Close() })
    [void]$btnRow.Children.Add($btnAdd)
    [void]$btnRow.Children.Add($btnCancel)
    [void]$stack.Children.Add($btnRow)

    $card.Child = $stack
    $dlg.Content = $card
    $dlg.Add_KeyDown({ param($s, $e) if ($e.Key -eq 'Escape') { $s.Close() } })
    $script:UiHold++; $script:UiHoldStamp = Get-Date
    try { [void]$dlg.ShowDialog() }
    finally { $script:UiHold = [Math]::Max(0, $script:UiHold - 1) }
    return $script:AddAcctResult
}

function Update-AccountsPanel {
    # (re)build the account rows inside the settings dialog
    if ($null -eq $script:AcctPanel) { return }
    $script:AcctPanel.Children.Clear()
    $data = Get-Accounts
    foreach ($acct in @($data.accounts)) {
        $row = New-Object System.Windows.Controls.Border
        $row.CornerRadius = New-Object System.Windows.CornerRadius(8)
        $row.Padding = New-Object System.Windows.Thickness(9, 5, 7, 6)
        $row.Margin = New-Object System.Windows.Thickness(0, 1, 0, 1)
        $row.Cursor = [System.Windows.Input.Cursors]::Hand
        $row.Background = [System.Windows.Media.Brushes]::Transparent
        $row.Tag = [string]$acct.id
        $row.Add_MouseEnter({ param($s, $e) $s.Background = Get-Brush '#12FFFFFF' })
        $row.Add_MouseLeave({ param($s, $e) $s.Background = [System.Windows.Media.Brushes]::Transparent })

        $g = New-Object System.Windows.Controls.Grid
        foreach ($wdef in @('Auto', '*', 'Auto')) {
            $cd = New-Object System.Windows.Controls.ColumnDefinition
            if ($wdef -eq 'Auto') { $cd.Width = [System.Windows.GridLength]::Auto }
            else { $cd.Width = New-Object System.Windows.GridLength(1, 'Star') }
            [void]$g.ColumnDefinitions.Add($cd)
        }

        $dot = New-Object System.Windows.Shapes.Ellipse
        $dot.Width = 7; $dot.Height = 7
        $dot.Margin = New-Object System.Windows.Thickness(0, 1, 8, 0)
        $dot.VerticalAlignment = 'Center'
        $dot.Fill = $(if ([string]$acct.id -eq [string]$data.active) { Get-Brush '#5ED584' } else { Get-Brush '#33FFFFFF' })
        [System.Windows.Controls.Grid]::SetColumn($dot, 0)
        [void]$g.Children.Add($dot)

        $lbl = New-Object System.Windows.Controls.TextBlock
        $lbl.Text = [string]$acct.label + $(if ([string]$acct.id -eq [string]$data.active) { '  (active)' } else { '' })
        $lbl.FontSize = 11.5
        $lbl.Foreground = $(if ([string]$acct.id -eq [string]$data.active) { Get-Brush '#F4F4F8' } else { Get-Brush '#B9B9C2' })
        $lbl.VerticalAlignment = 'Center'
        [System.Windows.Controls.Grid]::SetColumn($lbl, 1)
        [void]$g.Children.Add($lbl)

        $del = New-Object System.Windows.Controls.TextBlock
        $del.Text = [string][char]0x2715
        $del.FontSize = 10
        $del.Foreground = Get-Brush '#55555E'
        $del.Cursor = [System.Windows.Input.Cursors]::Hand
        $del.Padding = New-Object System.Windows.Thickness(6, 1, 2, 1)
        $del.Tag = [string]$acct.id
        $del.Add_MouseEnter({ param($s, $e) $s.Foreground = Get-Brush '#FF6B6B' })
        $del.Add_MouseLeave({ param($s, $e) $s.Foreground = Get-Brush '#55555E' })
        $del.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
        $del.Add_MouseLeftButtonUp({
            param($s, $e)
            $e.Handled = $true
            $d = Get-Accounts
            $d.accounts = @($d.accounts | Where-Object { [string]$_.id -ne [string]$s.Tag })
            if ([string]$d.active -eq [string]$s.Tag) { $d.active = '' }
            Save-Accounts $d
            Update-AccountsPanel
        })
        [System.Windows.Controls.Grid]::SetColumn($del, 2)
        [void]$g.Children.Add($del)

        $row.Child = $g
        $row.Add_MouseLeftButtonUp({
            param($s, $e)
            $d = Get-Accounts
            $d.active = [string]$s.Tag
            Save-Accounts $d
            Update-AccountsPanel
        })
        [void]$script:AcctPanel.Children.Add($row)
    }

    $add = New-Object System.Windows.Controls.TextBlock
    $add.Text = '+ add account'
    $add.FontSize = 10.5
    $add.Foreground = Get-Brush '#E07B54'
    $add.Cursor = [System.Windows.Input.Cursors]::Hand
    $add.Margin = New-Object System.Windows.Thickness(9, 4, 0, 2)
    $add.Add_MouseLeftButtonUp({
        if (-not $script:AcctDisclaimerOk) {
            if (-not (Show-AccountsDisclaimer)) { return }
            $script:AcctDisclaimerOk = $true
            try {
                $cfg = $null
                if (Test-Path -LiteralPath $CfgPath) { $cfg = Get-Content -LiteralPath $CfgPath -Raw | ConvertFrom-Json }
                if ($null -eq $cfg) { $cfg = [pscustomobject]@{} }
                $cfg | Add-Member -NotePropertyName AccountsDisclaimerOk -NotePropertyValue $true -Force
                Set-ContentAtomic $CfgPath ($cfg | ConvertTo-Json)
            }
            catch { }
        }
        $res = Show-AddAccountDialog
        if ($null -ne $res) {
            $d = Get-Accounts
            $id = 'acct-' + ([guid]::NewGuid().ToString('N').Substring(0, 8))
            $d.accounts = @($d.accounts) + @([pscustomobject]@{
                id = $id; label = [string]$res.Label; token = (Protect-AccountToken ([string]$res.Token))
            })
            if ([string]$d.active -eq '') { $d.active = $id }
            Save-Accounts $d
            Install-ClaudeLauncher   # make plain `claude` account-aware (idempotent)
            Update-AccountsPanel
        }
    })
    [void]$script:AcctPanel.Children.Add($add)
}

function Save-PerchSettings([string]$Theme, [bool]$Chirp, [bool]$Timers, [bool]$HideAfter, [bool]$Startup, [string]$RefreshRaw, [string]$VolumeRaw, [string]$ProcsRaw, [string]$ParkRaw = '', [bool]$ChirpDone = $true, [string]$CompactRaw = '') {
    if ($script:ThemeSpecs.Keys -contains $Theme -and $Theme -ne $script:ThemeName) {
        $script:ThemeName = $Theme
        Apply-Theme
    }
    $script:ChirpOn = $Chirp
    $script:ChirpDoneOn = $ChirpDone
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

    $park = 0
    if ([int]::TryParse($ParkRaw.Trim(), [ref]$park) -and $park -ge 0 -and $park -le 1440) {
        $script:ParkMinutes = $park
        if ($park -eq 0) { $script:AttnSince = @{} }   # never park: forget the clocks
    }

    $cak = 0
    if ([int]::TryParse($CompactRaw.Trim(), [ref]$cak) -and $cak -ge 0 -and $cak -le 5000) {
        $script:CompactAtK = $cak
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
        $cfg | Add-Member -NotePropertyName ChirpOnDone       -NotePropertyValue $script:ChirpDoneOn -Force
        $cfg | Add-Member -NotePropertyName ChirpVolume       -NotePropertyValue $script:ChirpVolume -Force
        $cfg | Add-Member -NotePropertyName ParkAfterMinutes  -NotePropertyValue $script:ParkMinutes -Force
        $cfg | Add-Member -NotePropertyName CompactAtK        -NotePropertyValue $script:CompactAtK -Force
        $cfg | Add-Member -NotePropertyName ThemeName         -NotePropertyValue $script:ThemeName -Force
        $cfg | Add-Member -NotePropertyName MascotPack        -NotePropertyValue $script:MascotPack -Force
        $cfg | Add-Member -NotePropertyName ShowWorkTimers    -NotePropertyValue $script:ShowTimers -Force
        $cfg | Add-Member -NotePropertyName AgentProcessNames -NotePropertyValue $script:AgentProcNames -Force
        Set-ContentAtomic $CfgPath ($cfg | ConvertTo-Json)
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

    # theme picker: swatches, live preview, cancel reverts
    $script:PickTheme = $script:ThemeName
    $script:ThemeOrig = $script:ThemeName
    $script:ThemeSaved = $false
    $script:ThemePickRings = @{}
    [void]$stack.Children.Add((New-DarkLabel 'theme'))
    $themeRow = New-Object System.Windows.Controls.WrapPanel
    $themeRow.Orientation = 'Horizontal'
    $themeRow.MaxWidth = 404
    $themeRow.HorizontalAlignment = 'Left'
    $themeRow.Margin = New-Object System.Windows.Thickness(2, 0, 0, 6)
    foreach ($tn in @($script:ThemeSpecs.Keys)) {
        [void]$themeRow.Children.Add((New-ThemeSwatch ([string]$tn)))
    }
    [void]$stack.Children.Add($themeRow)

    # mascot picker: same live-preview-cancel-reverts pattern as the theme row.
    # 'bird' is built in; drop a folder in assets\mascots\<name> and it shows
    # up here (see assets\mascots\MASCOT-SPEC.md for the art an AI must make).
    $script:PickMascot = $script:MascotPack
    $script:MascotOrig = $script:MascotPack
    $script:MascotSaved = $false
    $script:MascotPickRings = @{}
    [void]$stack.Children.Add((New-DarkLabel 'mascot'))
    $mascotRow = New-Object System.Windows.Controls.WrapPanel
    $mascotRow.Orientation = 'Horizontal'
    $mascotRow.MaxWidth = 404
    $mascotRow.HorizontalAlignment = 'Left'
    $mascotRow.Margin = New-Object System.Windows.Thickness(2, 0, 0, 6)
    foreach ($mn in @(Get-MascotPacks)) {
        [void]$mascotRow.Children.Add((New-MascotSwatch ([string]$mn)))
    }
    [void]$stack.Children.Add($mascotRow)

    $startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Perch.lnk'
    $rowChirp   = New-SettingRow 'chirp when a session needs me'      $script:ChirpOn
    $rowChirpDn = New-SettingRow 'double-chirp when a session finishes' $script:ChirpDoneOn
    $rowTimers  = New-SettingRow 'show work timers on busy sessions'  $script:ShowTimers
    $rowHide    = New-SettingRow 'minimize after click-to-focus'      $script:HudHideAfterFocus
    $rowStartup = New-SettingRow 'start with windows'                 (Test-Path -LiteralPath $startupLnk)
    foreach ($r in @($rowChirp, $rowChirpDn, $rowTimers, $rowHide, $rowStartup)) { [void]$stack.Children.Add($r) }

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
    $colPark = New-Object System.Windows.Controls.StackPanel
    $colPark.Margin = New-Object System.Windows.Thickness(18, 0, 0, 0)
    [void]$colPark.Children.Add((New-DarkLabel 'park needs-you after (min, 0=never)'))
    $inPark = New-InputBox ([string]$script:ParkMinutes)
    $inPark.Width = 64
    $inPark.HorizontalAlignment = 'Left'
    [void]$colPark.Children.Add($inPark)
    [void]$numRow.Children.Add($colRefresh)
    [void]$numRow.Children.Add($colVolume)
    [void]$numRow.Children.Add($colPark)
    [void]$stack.Children.Add($numRow)

    $numRow2 = New-Object System.Windows.Controls.StackPanel
    $numRow2.Orientation = 'Horizontal'
    $numRow2.Margin = New-Object System.Windows.Thickness(0, 6, 0, 0)
    $colCompact = New-Object System.Windows.Controls.StackPanel
    [void]$colCompact.Children.Add((New-DarkLabel 'compact button past (k tokens, 0=off)'))
    $inCompact = New-InputBox ([string]$script:CompactAtK)
    $inCompact.Width = 64
    $inCompact.HorizontalAlignment = 'Left'
    [void]$colCompact.Children.Add($inCompact)
    [void]$numRow2.Children.Add($colCompact)
    [void]$stack.Children.Add($numRow2)

    [void]$stack.Children.Add((New-DarkLabel 'agent process names'))
    $inProcs = New-InputBox ($script:AgentProcNames -join ', ')
    [void]$stack.Children.Add($inProcs)

    # claude accounts (switch which subscription NEW sessions use)
    $sep2 = New-Object System.Windows.Controls.Border
    $sep2.Height = 1
    $sep2.Background = Get-Brush '#14FFFFFF'
    $sep2.Margin = New-Object System.Windows.Thickness(2, 12, 2, 0)
    [void]$stack.Children.Add($sep2)
    [void]$stack.Children.Add((New-DarkLabel 'claude accounts'))
    $script:AcctPanel = New-Object System.Windows.Controls.StackPanel
    [void]$stack.Children.Add($script:AcctPanel)
    Update-AccountsPanel
    $acctHint = New-Object System.Windows.Controls.TextBlock
    $acctHint.Text = 'applies to NEW sessions - in a stuck tab just run: claude --continue'
    $acctHint.FontSize = 9.5
    $acctHint.Foreground = Get-Brush '#6E6E78'
    $acctHint.TextWrapping = 'Wrap'
    $acctHint.Margin = New-Object System.Windows.Thickness(2, 4, 0, 0)
    [void]$stack.Children.Add($acctHint)

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
        Chirp = $rowChirp.Tag; ChirpDone = $rowChirpDn.Tag; Timers = $rowTimers.Tag; Hide = $rowHide.Tag; Startup = $rowStartup.Tag
        Refresh = $inRefresh.Child; Volume = $inVolume.Child; Procs = $inProcs.Child; Park = $inPark.Child
        Compact = $inCompact.Child
    }
    $btnSave.Tag = $dlg
    $btnCancel.Tag = $dlg
    $btnSave.Add_MouseLeftButtonUp({
        param($s, $e)
        $c = $s.Tag.Tag
        $script:ThemeSaved = $true
        $script:MascotSaved = $true
        $script:MascotPack = [string]$script:PickMascot   # Save-PerchSettings persists $script:MascotPack
        Save-PerchSettings ([string]$script:PickTheme) ([bool]$c.Chirp.Tag) ([bool]$c.Timers.Tag) ([bool]$c.Hide.Tag) `
                           ([bool]$c.Startup.Tag) ([string]$c.Refresh.Text) ([string]$c.Volume.Text) ([string]$c.Procs.Text) `
                           ([string]$c.Park.Text) ([bool]$c.ChirpDone.Tag) ([string]$c.Compact.Text)
        $s.Tag.Close()
    })
    $btnCancel.Add_MouseLeftButtonUp({ param($s, $e) $s.Tag.Close() })
    $dlg.Add_KeyDown({ param($s, $e) if ($e.Key -eq 'Escape') { $s.Close() } })
    $dlg.Add_Closed({
        # closed without saving: undo any live mascot preview
        if (-not $script:MascotSaved -and $script:MascotPack -ne $script:MascotOrig) {
            $script:MascotPack = $script:MascotOrig
            try { Load-MascotFaces; Update-BirdFace } catch { }
        }
        # closed without saving: undo any live theme preview
        if (-not $script:ThemeSaved -and $script:ThemeName -ne $script:ThemeOrig) {
            $script:ThemeName = $script:ThemeOrig
            try { Apply-Theme } catch { }
        }
    })

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

$script:DoneEchoPlayer = $null   # second player so chirp #1 rings out under chirp #2
$script:DoneEchoTimer = $null
function Invoke-DoneChirp {
    # a session FINISHED: a happy DOUBLE chirp - two quick calls, so your ear
    # can tell it from the single needs-you chirp (which also flashes/pulses;
    # done only sings). Done was completely SILENT before this: the pre-perch
    # sound hook chirped on Stop, and perch quietly moved the sound's meaning
    # to attention - this gives the finish line its voice back.
    if (-not $script:ChirpDoneOn) { return }
    if (((Get-Date) - $script:BootStamp).TotalSeconds -lt 8) { return }   # boot roll-call is old news
    try {
        $wavs = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'sounds') -Filter '*.wav' -ErrorAction SilentlyContinue)
        if ($wavs.Count -eq 0) {
            try { [Console]::Beep(1319, 80); [Console]::Beep(1760, 110) } catch { }
            return
        }
        $vol = [Math]::Max(0.0, [Math]::Min(1.0, $script:ChirpVolume / 100.0))
        if ($null -eq $script:ChirpPlayer) { $script:ChirpPlayer = New-Object System.Windows.Media.MediaPlayer }
        $script:ChirpPlayer.Open([Uri]$wavs[(Get-Random -Maximum $wavs.Count)].FullName)
        $script:ChirpPlayer.Volume = $vol
        $script:ChirpPlayer.Play()
        if ($null -eq $script:DoneEchoTimer) {
            $script:DoneEchoTimer = New-Object System.Windows.Threading.DispatcherTimer
            $script:DoneEchoTimer.Interval = [TimeSpan]::FromMilliseconds(320)
            $script:DoneEchoTimer.Add_Tick({
                $script:DoneEchoTimer.Stop()
                try {
                    $w = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'sounds') -Filter '*.wav' -ErrorAction SilentlyContinue)
                    if ($w.Count -eq 0) { return }
                    if ($null -eq $script:DoneEchoPlayer) { $script:DoneEchoPlayer = New-Object System.Windows.Media.MediaPlayer }
                    $script:DoneEchoPlayer.Open([Uri]$w[(Get-Random -Maximum $w.Count)].FullName)
                    $script:DoneEchoPlayer.Volume = [Math]::Max(0.0, [Math]::Min(1.0, $script:ChirpVolume / 100.0))
                    $script:DoneEchoPlayer.Play()
                }
                catch { }
            })
        }
        $script:DoneEchoTimer.Stop(); $script:DoneEchoTimer.Start()
    }
    catch { }
}

function New-RowMenu($Row) {
    # menu items carry the ROW, not a session snapshot: rows now live for the
    # whole session (diff rendering) while Row.Tag is refreshed every tick,
    # so $s.Tag.Tag is always the LIVE session object
    $menu = New-Object System.Windows.Controls.ContextMenu
    $menu.Style = $script:Window.FindResource('HudMenu')
    $miStyle = $script:Window.FindResource('HudMenuItem')

    $miPin = New-Object System.Windows.Controls.MenuItem
    $miPin.Style = $miStyle
    $miPin.Header = 'Pin to top'
    $miPin.Tag = $Row
    $miPin.Add_Click({
        param($s, $e)
        Set-Pref $s.Tag.Tag 'pinned' (-not [bool]$s.Tag.Tag.Pinned)
        Update-List -Force
    })
    [void]$menu.Items.Add($miPin)

    $miRen = New-Object System.Windows.Controls.MenuItem
    $miRen.Style = $miStyle
    $miRen.Header = 'Rename...'
    $miRen.Tag = $Row
    $miRen.Add_Click({
        param($s, $e)
        $newName = Show-RenameDialog ([string]$s.Tag.Tag.DisplayName)
        if ($null -ne $newName) {
            Set-Pref $s.Tag.Tag 'name' $newName.Trim()
            Update-List -Force
        }
    })
    [void]$menu.Items.Add($miRen)

    $miHide = New-Object System.Windows.Controls.MenuItem
    $miHide.Style = $miStyle
    $miHide.Header = 'Hide until next change'
    $miHide.Tag = $Row
    $miHide.Add_Click({
        param($s, $e)
        $script:Dismissed[$s.Tag.Tag.Id] = $s.Tag.Tag.Ts
        Update-List -Force
    })
    [void]$menu.Items.Add($miHide)

    $menu.Tag = $miPin
    $menu.Add_Opened({
        param($s, $e)
        $script:UiHold++; $script:UiHoldStamp = Get-Date
        # header reflects the CURRENT pin state at open time
        try {
            $s.Tag.Header = $(if ([bool]$s.PlacementTarget.Tag.Pinned) { 'Unpin' } else { 'Pin to top' })
        }
        catch { }
    })
    $menu.Add_Closed({ $script:UiHold = [Math]::Max(0, $script:UiHold - 1) })

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
        # attention pulse = a red flash of the border (rim in glass). Cheap:
        # animating a border brush repaints a thin ring, not a full-card blur.
        $dur = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(650))
        $pulse = New-Object System.Windows.Media.SolidColorBrush(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#FF6B6B'))
        $ca = New-Object System.Windows.Media.Animation.ColorAnimation(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#FF6B6B'),
            [System.Windows.Media.ColorConverter]::ConvertFromString('#30FFFFFF'), $dur)
        $ca.RepeatBehavior = New-Object System.Windows.Media.Animation.RepeatBehavior(4)
        $ca.SetValue([System.Windows.Media.Animation.Timeline]::DesiredFrameRateProperty, 15)
        if ($script:Compact -and -not $script:PillPeeked) {
            # resting pill: its own border carries the red flash
            $script:PillCard.BorderBrush = $pulse
            $ca.Add_Completed({
                try {
                    if ($script:ThemeName -eq 'glass') {
                        $script:PillCard.BorderBrush = Get-Brush '#59FFFFFF'
                    }
                    else {
                        $spec = $script:ThemeSpecs[$script:ThemeName]
                        if ($null -eq $spec -or $null -eq $spec.BorderBrush) { $spec = $script:ThemeSpecs['midnight'] }
                        $script:PillCard.BorderBrush = $spec.BorderBrush
                    }
                }
                catch { }
            })
        }
        elseif ($script:ThemeName -eq 'glass' -and $null -ne $script:GlassRim) {
            $script:GlassRim.BorderBrush = $pulse
            $ca.Add_Completed({
                try { $script:GlassRim.BorderBrush = $script:RimGradient } catch { }
            })
        }
        else {
            $script:RootCard.BorderBrush = $pulse
            $ca.Add_Completed({
                try {
                    $spec = $script:ThemeSpecs[$script:ThemeName]
                    if ($null -eq $spec -or $null -eq $spec.BorderBrush) { $spec = $script:ThemeSpecs['midnight'] }
                    $script:RootCard.BorderBrush = $spec.BorderBrush
                }
                catch { }
            })
        }
        $pulse.BeginAnimation([System.Windows.Media.SolidColorBrush]::ColorProperty, $ca)
    }
    catch { }
}

function Format-ResetIn([datetime]$At) {
    $d = $At - (Get-Date)
    if ($d.TotalMinutes -le 0) { return 'resetting' }
    if ($d.TotalHours -ge 24) { return ('{0}d {1}h' -f [int][Math]::Floor($d.TotalDays), $d.Hours) }
    if ($d.TotalHours -ge 1) { return ('{0}h {1}m' -f [int][Math]::Floor($d.TotalHours), $d.Minutes) }
    return ('{0}m' -f [int][Math]::Ceiling($d.TotalMinutes))
}

function Get-OfficialLimits {
    # THE steal of the research run: claude itself (>= 2.1.80) pushes its
    # OFFICIAL rate-limit numbers into the statusline command's stdin on
    # every render. Our statusline command tees that json to a file -
    # server-truth percentages with ZERO api calls, fresh whenever any
    # session is alive. (The oauth endpoint remains as calibration + the
    # per-model weekly rows, at a gentle cadence.)
    $sPath = Join-Path $env:LOCALAPPDATA 'AgentFocus\statusline.json'
    if (-not (Test-Path -LiteralPath $sPath)) { return $null }
    if (([datetime]::UtcNow - (Get-Item -LiteralPath $sPath).LastWriteTimeUtc).TotalMinutes -gt 3) { return $null }
    try {
        $j = Get-Content -LiteralPath $sPath -Raw | ConvertFrom-Json
        if ($null -eq $j -or $null -eq $j.PSObject.Properties['rate_limits']) { return $null }
        $rl = $j.rate_limits
        $lims = @()
        if ($null -ne $rl.PSObject.Properties['five_hour'] -and $null -ne $rl.five_hour) {
            $lims += [pscustomobject]@{ label = '5h window'; percent = [double]$rl.five_hour.used_percentage
                                        severity = 'normal'; resets_at = (ConvertTo-ResetIso $rl.five_hour.resets_at) }
        }
        if ($null -ne $rl.PSObject.Properties['seven_day'] -and $null -ne $rl.seven_day) {
            $lims += [pscustomobject]@{ label = 'week'; percent = [double]$rl.seven_day.used_percentage
                                        severity = 'normal'; resets_at = (ConvertTo-ResetIso $rl.seven_day.resets_at) }
        }
        if ($lims.Count -gt 0) { return $lims }
    }
    catch { }   # concurrent statusline writers can corrupt a read; next render fixes it
    return $null
}

function ConvertTo-ResetIso([object]$Value) {
    # the statusline sends reset times as UNIX EPOCH SECONDS; the oauth
    # endpoint sends ISO strings. Normalize to ISO so one parser rules all -
    # unparsed epochs were rendering as broken countdowns on the 5h/week rows
    $s = [string]$Value
    [long]$epoch = 0
    if ([long]::TryParse($s, [ref]$epoch) -and $epoch -gt 1000000000 -and $epoch -lt 100000000000) {
        return ([System.DateTimeOffset]::FromUnixTimeSeconds($epoch)).UtcDateTime.ToString('o')
    }
    return $s
}

function Update-LimitsPanel {
    # account limit bars. Source priority: statusline capture (official, free,
    # live) -> oauth endpoint snapshot (per-model rows + fallback) -> stale
    # data shown dimmed with its age. The UI thread never touches the network.
    try {
        $now = Get-Date

        # source 1: statusline capture, with a short memory so one corrupted
        # read (concurrent writers) doesn't flicker the panel to fallback
        $official = Get-OfficialLimits
        if ($null -ne $official) { $script:LastOfficial = $official; $script:LastOfficialStamp = $now }
        elseif ($null -ne $script:LastOfficial -and ($now - $script:LastOfficialStamp).TotalMinutes -lt 3) {
            $official = $script:LastOfficial
        }

        # source 2: the oauth endpoint. 30min cadence while the statusline
        # feed is alive (it only contributes the per-model weekly rows then),
        # 5min when it's our only source; file-age gated; never during a 429
        # cooldown (Retry-After honored by the probe)
        $uPath = Join-Path $env:LOCALAPPDATA 'AgentFocus\usage.json'
        $coolPath = Join-Path $env:LOCALAPPDATA 'AgentFocus\usage-cooldown.txt'
        $fileAge = 1e9
        if (Test-Path -LiteralPath $uPath) {
            $fileAge = ([datetime]::UtcNow - (Get-Item -LiteralPath $uPath).LastWriteTimeUtc).TotalSeconds
        }
        $coolActive = $false
        if (Test-Path -LiteralPath $coolPath) {
            try {
                $until = [datetime]::Parse((Get-Content -LiteralPath $coolPath -Raw).Trim(), $null,
                         [System.Globalization.DateTimeStyles]::RoundtripKind)
                $coolActive = ([datetime]::UtcNow -lt $until.ToUniversalTime())
            }
            catch { }
        }
        $cadence = $(if ($null -ne $official) { 1800 } else { 300 })
        if (-not $coolActive -and $fileAge -gt $cadence -and
            ($now - $script:UsageFetchStamp).TotalSeconds -gt 60) {
            $script:UsageFetchStamp = $now
            $probe = Join-Path $PSScriptRoot 'usage-probe.ps1'
            if (Test-Path -LiteralPath $probe) {
                Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$probe`"") | Out-Null
            }
        }

        # source 3: LOCAL 5h-block estimate (the ccusage steal, zero api):
        # a BelowNormal child incrementally buckets transcript token usage
        # into 5h billing blocks. Used only when both official feeds are
        # silent (offline / api down / rate-limited) - the cap is learned by
        # CALIBRATING local block tokens against official percentages seen
        # earlier, falling back to the P90 of past blocks.
        if (($null -eq $script:BlocksProc -or $script:BlocksProc.HasExited) -and
            ($now - $script:BlocksSpawnStamp).TotalSeconds -gt 120) {
            $script:BlocksSpawnStamp = $now
            $bpp = Join-Path $PSScriptRoot 'blocks-probe.ps1'
            if (Test-Path -LiteralPath $bpp) {
                $script:BlocksProc = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList @(
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$bpp`"")
                try { $script:BlocksProc.PriorityClass = 'BelowNormal' } catch { }
            }
        }
        $blocks = $null
        $bPath = Join-Path $env:LOCALAPPDATA 'AgentFocus\blocks.json'
        if (Test-Path -LiteralPath $bPath) {
            $bLwt = (Get-Item -LiteralPath $bPath).LastWriteTimeUtc
            if ($bLwt -ne $script:BlocksFileLWT) {
                try {
                    $script:BlocksParsed = Get-Content -LiteralPath $bPath -Raw | ConvertFrom-Json
                    $script:BlocksFileLWT = $bLwt
                }
                catch { }
            }
            if ($null -ne $script:BlocksParsed -and
                ([datetime]::UtcNow - $bLwt).TotalMinutes -lt 6) { $blocks = $script:BlocksParsed }
        }

        # endpoint snapshot rows (cached parse keyed on file write time)
        $endpointRows = @()
        $endpointFetched = [datetime]::MinValue
        if (Test-Path -LiteralPath $uPath) {
            $uLwt = (Get-Item -LiteralPath $uPath).LastWriteTimeUtc
            if ($uLwt -ne $script:UsageFileLWT -or $null -eq $script:UsageParsed) {
                try {
                    $u = Get-Content -LiteralPath $uPath -Raw | ConvertFrom-Json
                    if ($null -ne $u -and $null -ne $u.PSObject.Properties['limits']) {
                        $script:UsageParsed = $u
                        $script:UsageFileLWT = $uLwt
                    }
                }
                catch { }
            }
            if ($null -ne $script:UsageParsed) {
                $endpointRows = @($script:UsageParsed.limits)
                try {
                    $endpointFetched = ([datetime]::Parse([string]$script:UsageParsed.fetched_at, $null,
                                        [System.Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime()
                }
                catch { }
            }
        }

        # assemble: official 5h/week first; endpoint contributes the scoped
        # per-model weekly rows (statusline doesn't carry those) if reasonably
        # fresh; endpoint alone when no statusline feed exists
        $rows = @()
        $staleMin = 0.0
        $srcStamp = $now
        $localEst = $false
        if ($null -ne $official) {
            $rows = @($official)
            # drop the official 5h reset as an ANCHOR: the blocks probe snaps
            # its local window to it, so offline estimates share the server's
            # exact boundaries instead of drifting up to an hour
            foreach ($ol in @($official)) {
                if ([string]$ol.label -eq '5h window' -and ([string]$ol.resets_at) -ne $script:AnchorKey) {
                    $script:AnchorKey = [string]$ol.resets_at
                    try { $script:AnchorKey | Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgentFocus\reset-anchor.txt') -Encoding ASCII } catch { }
                }
            }
            # CALIBRATE while both eyes are open: official says X%, local
            # math says Y tokens in the SAME window (block end must agree
            # with the official reset) -> the full window holds ~Y*100/X.
            # The median of these pairs beats any guessed plan size.
            if ($null -ne $blocks -and $null -ne $blocks.block) {
                foreach ($ol in @($official)) {
                    if ([string]$ol.label -ne '5h window') { continue }
                    $opct = [double]$ol.percent
                    $otok = [long]$blocks.block.tokens
                    if ($opct -lt 10 -or $otok -le 0) { break }   # tiny % = noisy ratio
                    try {
                        $orst = ([datetime]::Parse([string]$ol.resets_at, $null,
                                 [System.Globalization.DateTimeStyles]::RoundtripKind)).ToUniversalTime()
                        $bend = ([datetime]::Parse([string]$blocks.block.end, $null,
                                 [System.Globalization.DateTimeStyles]::RoundtripKind)).ToUniversalTime()
                        if ([Math]::Abs(($orst - $bend).TotalMinutes) -gt 45) { break }   # different window: skip
                    }
                    catch { break }
                    $lastC = $(if ($script:BlockCalib.Count -gt 0) { $script:BlockCalib[$script:BlockCalib.Count - 1] } else { $null })
                    $lastAt = [datetime]::MinValue
                    if ($null -ne $lastC) {
                        try { $lastAt = ([datetime]::Parse([string]$lastC.At, $null,
                                         [System.Globalization.DateTimeStyles]::RoundtripKind)) } catch { }
                    }
                    if (($now - $lastAt).TotalMinutes -gt 20) {
                        [void]$script:BlockCalib.Add(@{ Tok = $otok; Pct = $opct; At = $now.ToString('o') })
                        while ($script:BlockCalib.Count -gt 12) { $script:BlockCalib.RemoveAt(0) }
                        Save-HudState
                    }
                    break
                }
            }
            # the statusline doesn't carry the per-model weekly rows - keep
            # them from the endpoint snapshot for up to 6h (weekly numbers
            # drift slowly; a 2h-old fable row beats a vanished fable row)
            if (($now - $endpointFetched).TotalHours -lt 6) {
                foreach ($er in $endpointRows) {
                    if (([string]$er.label) -like 'week *' -and ([string]$er.label) -ne 'week') {
                        $rows += $er
                    }
                }
            }
        }
        else {
            $rows = $endpointRows
            if ($endpointFetched -gt [datetime]::MinValue) { $staleMin = ($now - $endpointFetched).TotalMinutes }
            else { $staleMin = 999 }
            $srcStamp = $endpointFetched
            # both official feeds silent: local block math carries the 5h row
            # (fresh + honest about being an estimate via its '~local' label)
            if ($null -ne $blocks -and $null -ne $blocks.block -and
                ($staleMin -gt 20 -or $rows.Count -eq 0)) {
                $cap = 0.0
                if ($script:BlockCalib.Count -ge 3) {
                    $capsArr = @(foreach ($cs in $script:BlockCalib) { [double]$cs.Tok * 100.0 / [double]$cs.Pct }) | Sort-Object
                    $cap = [double]$capsArr[[int][Math]::Floor($capsArr.Count / 2)]
                }
                elseif ($null -ne $blocks.PSObject.Properties['p90'] -and [double]$blocks.p90 -gt 0) {
                    $cap = [double]$blocks.p90
                }
                if ($cap -gt 0) {
                    $estPct = [Math]::Min(100.0, [long]$blocks.block.tokens * 100.0 / $cap)
                    $rows = @([pscustomobject]@{ label = '5h ~local'; percent = $estPct
                                                 severity = 'normal'; resets_at = [string]$blocks.block.end }) +
                            @($rows | Where-Object { ([string]$_.label) -ne '5h window' })
                    $localEst = $true
                }
            }
        }
        if ($rows.Count -eq 0) {
            $script:Pill5hPct = -1.0
            Update-PillRing
            $script:LimitsPanel.Children.Clear()
            # keep the in-terminal statusline honest too: a seeded/stale text
            # would keep claiming numbers we no longer have
            try {
                if ($script:SlTextKey -ne 'perch: limits offline') {
                    $script:SlTextKey = 'perch: limits offline'
                    $script:SlTextKey | Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgentFocus\statusline-text.txt') -Encoding ASCII
                }
            }
            catch { }
            return
        }

        $wantOpacity = $(if ($staleMin -gt 15 -and -not $localEst) { 0.45 } else { 1.0 })
        if ($script:LimitsPanel.Opacity -ne $wantOpacity) { $script:LimitsPanel.Opacity = $wantOpacity }

        # rebuild only when the CONTENT changed (rounded pct / reset) or a
        # minute passed - the statusline file updates every render, so a
        # file-time gate would rebuild every tick
        $ckParts = foreach ($lim in $rows) { '{0}:{1:0}:{2}' -f [string]$lim.label, [double]$lim.percent, [string]$lim.resets_at }
        $contentKey = ($ckParts -join '|') + '|' + [int]$staleMin
        if ($contentKey -eq $script:LimitsKey -and
            ($now - $script:LimitsRenderStamp).TotalSeconds -lt 60 -and
            $script:LimitsPanel.Children.Count -gt 0) { return }
        $isNewSample = ($contentKey -ne $script:LimitsKey)
        $script:LimitsKey = $contentKey
        $script:LimitsRenderStamp = $now
        $script:LimitsPanel.Children.Clear()
        $fetched = $srcStamp
        $script:Pill5hPct = -1.0   # re-stashed by the 5h row below, if any

        foreach ($lim in @($rows)) {
            $pct = [Math]::Max(0.0, [Math]::Min(100.0, [double]$lim.percent))
            $hex = '#5ED584'
            if ($pct -ge 90 -or [string]$lim.severity -match 'exceeded|blocked') { $hex = '#FF6B6B' }
            elseif ($pct -ge 70 -or [string]$lim.severity -match 'warn') { $hex = '#FFB84D' }

            $lkey = [string]$lim.label
            if ($lkey -like '5h*') { $script:Pill5hPct = $pct; $script:Pill5hHex = $hex }
            if ($isNewSample) {
                if (-not $script:UsageHist.ContainsKey($lkey)) { $script:UsageHist[$lkey] = New-Object System.Collections.ArrayList }
                $hist = $script:UsageHist[$lkey]
                # a big drop = the window RESET: clear history, chirp the good news
                if ($hist.Count -gt 0 -and ($hist[$hist.Count - 1].Pct - $pct) -ge 20) {
                    $hist.Clear()
                    [void]$script:LimitAlerted.Remove($lkey)
                    Invoke-Chirp   # your window is fresh - go
                }
                [void]$hist.Add(@{ T = $fetched; Pct = $pct })
                while ($hist.Count -gt 0 -and ($now - $hist[0].T).TotalMinutes -gt 90) { $hist.RemoveAt(0) }
                # crossing 90 percent: one chirp per window, never nags
                if ($pct -ge 90 -and -not $script:LimitAlerted.ContainsKey($lkey)) {
                    $script:LimitAlerted[$lkey] = $true
                    Invoke-Chirp
                }
            }

            # burn rate -> predicted cutoff: if the pace says you hit 100%
            # BEFORE the reset, that beats the reset countdown as the thing
            # you need to know (idea borrowed from every macOS usage app)
            $capsAt = [datetime]::MinValue
            if ($script:UsageHist.ContainsKey($lkey)) {
                $hist = $script:UsageHist[$lkey]
                if ($hist.Count -ge 2) {
                    $first = $hist[0]; $last = $hist[$hist.Count - 1]
                    $hrs = ($last.T - $first.T).TotalHours
                    if ($hrs -gt 0.05 -and ($last.Pct - $first.Pct) -gt 0.5) {
                        $rate = ($last.Pct - $first.Pct) / $hrs   # percent per hour
                        if ($rate -gt 1) {
                            $capsAt = $now.AddHours((100.0 - $pct) / $rate)
                        }
                    }
                }
            }
            $resetAt = [datetime]::MaxValue
            try {
                $resetAt = ([datetime]::Parse([string]$lim.resets_at, $null,
                            [System.Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime()
            }
            catch { }
            # a caps claim must BEAT a reset we can actually see: no known
            # reset time = no claim (a prediction that outlives the real
            # reset is worse than none), reset already due = the reset wins,
            # and a hit >12h out is rate noise, not a warning
            $willCap = ($capsAt -gt [datetime]::MinValue -and
                        $resetAt -lt [datetime]::MaxValue -and
                        $resetAt -gt $now -and
                        $capsAt -lt $resetAt -and
                        ($capsAt - $now).TotalHours -lt 12)
            if ($willCap -and $hex -eq '#5ED584') { $hex = '#FFB84D' }

            $g = New-Object System.Windows.Controls.Grid
            $g.Margin = New-Object System.Windows.Thickness(0, 2, 0, 2)
            foreach ($wdef in @(86, 0, 92)) {
                $cd = New-Object System.Windows.Controls.ColumnDefinition
                if ($wdef -gt 0) { $cd.Width = New-Object System.Windows.GridLength($wdef) }
                else { $cd.Width = New-Object System.Windows.GridLength(1, 'Star') }
                [void]$g.ColumnDefinitions.Add($cd)
            }

            $lbl = New-Object System.Windows.Controls.TextBlock
            $lbl.Text = [string]$lim.label
            $lbl.FontSize = 9.5
            $lbl.Foreground = Get-Brush '#8A8A93'
            $lbl.VerticalAlignment = 'Center'
            [System.Windows.Controls.Grid]::SetColumn($lbl, 0)
            [void]$g.Children.Add($lbl)

            # the bar: a track with a star-ratio grid inside (pct | rest) -
            # no pixel math, WPF does the proportions
            $track = New-Object System.Windows.Controls.Border
            $track.Height = 5
            $track.CornerRadius = New-Object System.Windows.CornerRadius(2.5)
            $track.Background = Get-Brush '#16FFFFFF'
            $track.VerticalAlignment = 'Center'
            $track.Margin = New-Object System.Windows.Thickness(0, 0, 8, 0)
            $ratio = New-Object System.Windows.Controls.Grid
            foreach ($frac in @([Math]::Max($pct, 0.001), [Math]::Max(100.0 - $pct, 0.001))) {
                $cd = New-Object System.Windows.Controls.ColumnDefinition
                $cd.Width = New-Object System.Windows.GridLength($frac, 'Star')
                [void]$ratio.ColumnDefinitions.Add($cd)
            }
            $fill = New-Object System.Windows.Controls.Border
            $fill.CornerRadius = New-Object System.Windows.CornerRadius(2.5)
            $fill.Background = Get-Brush $hex
            [System.Windows.Controls.Grid]::SetColumn($fill, 0)
            [void]$ratio.Children.Add($fill)
            $track.Child = $ratio
            [System.Windows.Controls.Grid]::SetColumn($track, 1)
            [void]$g.Children.Add($track)

            $right = New-Object System.Windows.Controls.TextBlock
            $right.FontSize = 9.5
            $right.VerticalAlignment = 'Center'
            $right.HorizontalAlignment = 'Right'
            if ($willCap) {
                # you will hit the wall BEFORE the reset - say when
                $right.Text = ('{0:0}%' -f $pct) + $script:Sep + ('caps ~{0:HH:mm}' -f $capsAt)
            }
            elseif ($resetAt -lt [datetime]::MaxValue) {
                $right.Text = ('{0:0}%' -f $pct) + $script:Sep + (Format-ResetIn $resetAt)
            }
            else { $right.Text = ('{0:0}%' -f $pct) }
            $right.Foreground = Get-Brush $hex
            [System.Windows.Controls.Grid]::SetColumn($right, 2)
            [void]$g.Children.Add($right)

            [void]$script:LimitsPanel.Children.Add($g)
        }
        Update-PillRing

        # staleness in words, not just opacity - a 45% dim was too subtle and
        # old numbers were being read as current
        if ($staleMin -gt 10) {
            $old = New-Object System.Windows.Controls.TextBlock
            $old.FontSize = 9
            $old.Foreground = Get-Brush '#8A6E6E'
            $old.HorizontalAlignment = 'Right'
            $old.Margin = New-Object System.Windows.Thickness(0, 1, 0, 0)
            $old.Text = $(if ($localEst) { "5h = local estimate $([char]0x00B7) wk data $([int]$staleMin)m old" }
                          else { "data $([int]$staleMin)m old" +
                                 $(if ($coolActive) { ' (rate-limited, backing off)' } else { ', retrying' }) })
            [void]$script:LimitsPanel.Children.Add($old)
        }

        # feed the statusline: the capture command echoes this file back into
        # every session's statusline - usage at the bottom of each terminal,
        # maintained by perch, costing the render one tiny file read
        try {
            $slParts = foreach ($lim in @($rows)) {
                if (([string]$lim.label) -in @('5h window', 'week', '5h ~local')) {
                    ('{0} {1:0}%' -f (((([string]$lim.label) -replace '5h ~local', '5h~') -replace '5h window', '5h') -replace 'week', 'wk'), [double]$lim.percent)
                }
            }
            $slText = 'perch: ' + (($slParts | Where-Object { $_ }) -join ' | ')
            if ($slText -ne $script:SlTextKey) {
                $script:SlTextKey = $slText
                $slText | Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'AgentFocus\statusline-text.txt') -Encoding ASCII
            }
        }
        catch { }
    }
    catch { }
}

$script:PeekCache = @{}   # transcript path -> {LWT; You; Bot} (re-read only on file change)
function Get-TranscriptPeek([string]$Path) {
    # hover peek: the last thing YOU said and the last thing CLAUDE said,
    # pulled from the transcript tail. Lazy (hover only), cached per file
    # version, tail-read only - transcripts grow to many MB.
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $lwt = (Get-Item -LiteralPath $Path).LastWriteTimeUtc
        $c = $script:PeekCache[$Path]
        if ($null -ne $c -and $c.LWT -eq $lwt) { return $c }
        $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        try {
            $take = [Math]::Min($fs.Length, 262144)
            [void]$fs.Seek(-$take, [IO.SeekOrigin]::End)
            $buf = New-Object byte[] $take
            [void]$fs.Read($buf, 0, $take)
            $text = [Text.Encoding]::UTF8.GetString($buf)
        }
        finally { $fs.Close() }
        $lines = $text -split "`n"
        $you = ''; $bot = ''
        for ($i = $lines.Count - 1; $i -ge 0; $i--) {
            if ($you.Length -gt 0 -and $bot.Length -gt 0) { break }
            $ln = $lines[$i]
            if ($bot.Length -eq 0 -and $ln -like '*"type":"assistant"*') {
                try {
                    $o = $ln | ConvertFrom-Json
                    $parts = @()
                    foreach ($cb in @($o.message.content)) {
                        if ([string]$cb.type -eq 'text' -and -not [string]::IsNullOrWhiteSpace([string]$cb.text)) { $parts += ([string]$cb.text).Trim() }
                    }
                    if ($parts.Count -gt 0) { $bot = $parts -join ' ' }
                }
                catch { }
            }
            elseif ($you.Length -eq 0 -and $ln -like '*"type":"user"*') {
                try {
                    $o = $ln | ConvertFrom-Json
                    if ($null -ne $o.PSObject.Properties['isMeta'] -and [bool]$o.isMeta) { continue }
                    $t = ''
                    $mc = $o.message.content
                    if ($mc -is [string]) { $t = $mc }
                    else {
                        $parts = @()
                        foreach ($cb in @($mc)) { if ([string]$cb.type -eq 'text') { $parts += [string]$cb.text } }
                        $t = $parts -join ' '
                    }
                    $t = $t.Trim()
                    # skip machinery lines: tool results have no text blocks,
                    # command wrappers/caveats/interrupt stubs aren't prompts
                    if ($t.Length -eq 0 -or $t.StartsWith('<') -or
                        $t.StartsWith('[Request interrupt') -or $t.StartsWith('Caveat:')) { continue }
                    $you = $t
                }
                catch { }
            }
        }
        $you = Get-PeekDisplayText $you 300
        $bot = Get-PeekDisplayText $bot 420
        $res = @{ LWT = $lwt; You = $you; Bot = $bot }
        $script:PeekCache[$Path] = $res
        return $res
    }
    catch { return $null }
}

function New-Chip([string]$Text, [string]$Hex) {
    $chip = New-Object System.Windows.Controls.Border
    $chip.CornerRadius = New-Object System.Windows.CornerRadius(9)
    $chip.Padding = New-Object System.Windows.Thickness(8, 2, 8, 3)
    # vertical 2+2 so WRAPPED chip rows breathe (quiet used to sit glued
    # under need-you); the panel margin below drops 8->4 to compensate
    $chip.Margin = New-Object System.Windows.Thickness(0, 2, 6, 2)
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
    # Build ONCE per session, then Update-SessionRow mutates in place every
    # tick. Native apps don't rebuild their UI to change a label - neither do
    # we anymore: rebuilding every row every 2s was why hover states blinked,
    # menus needed babysitting, and the whole widget felt like a web page.
    $row = New-Object System.Windows.Controls.Border
    $row.CornerRadius = New-Object System.Windows.CornerRadius(10)
    $row.Padding = New-Object System.Windows.Thickness(10, 7, 10, 8)
    $row.Margin = New-Object System.Windows.Thickness(2, 1, 2, 1)
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
    $dot.Margin = New-Object System.Windows.Thickness(1, 5, 10, 0)
    $dot.VerticalAlignment = 'Top'
    $glow = New-Object System.Windows.Media.Effects.DropShadowEffect
    $glow.BlurRadius = 8
    $glow.ShadowDepth = 0
    $glow.Opacity = 0.85
    $dot.Effect = $glow
    [System.Windows.Controls.Grid]::SetColumn($dot, 0)
    [void]$grid.Children.Add($dot)

    $mid = New-Object System.Windows.Controls.StackPanel
    [System.Windows.Controls.Grid]::SetColumn($mid, 1)

    $line1 = New-Object System.Windows.Controls.Grid
    foreach ($wdef in @('*', 'Auto', 'Auto', 'Auto')) {
        $cd = New-Object System.Windows.Controls.ColumnDefinition
        if ($wdef -eq 'Auto') { $cd.Width = [System.Windows.GridLength]::Auto }
        else { $cd.Width = New-Object System.Windows.GridLength(1, 'Star') }
        [void]$line1.ColumnDefinitions.Add($cd)
    }
    $name = New-Object System.Windows.Controls.TextBlock
    $name.FontSize = 12.5
    $name.FontWeight = [System.Windows.FontWeights]::SemiBold
    $name.Foreground = Get-Brush '#F4F4F8'
    $name.TextTrimming = 'CharacterEllipsis'
    [System.Windows.Controls.Grid]::SetColumn($name, 0)
    [void]$line1.Children.Add($name)
    # the compact button: appears when this session's head is past YOUR
    # threshold (settings, 0=off). Click = jump to the tab and type /compact
    # for you. NEVER automatic - appearing is the reminder, clicking is the
    # consent. Purple on purpose: it foreshadows the compacting state.
    $cbtn = New-Object System.Windows.Controls.Border
    $cbtn.CornerRadius = New-Object System.Windows.CornerRadius(6)
    $cbtn.Background = Get-Brush '#26B48EF0'
    $cbtn.BorderBrush = Get-Brush '#59B48EF0'
    $cbtn.BorderThickness = New-Object System.Windows.Thickness(1)
    $cbtn.Padding = New-Object System.Windows.Thickness(6, 1, 6, 2)
    $cbtn.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
    $cbtn.VerticalAlignment = 'Center'
    $cbtn.Cursor = [System.Windows.Input.Cursors]::Hand
    $cbtn.Visibility = 'Collapsed'
    $cbtn.ToolTip = 'context past your threshold - click: jump there and type /compact for you'
    $cbtnTxt = New-Object System.Windows.Controls.TextBlock
    $cbtnTxt.Text = 'compact'
    $cbtnTxt.FontSize = 9.5
    $cbtnTxt.FontWeight = [System.Windows.FontWeights]::SemiBold
    $cbtnTxt.Foreground = Get-Brush '#CBB2F5'
    $cbtn.Child = $cbtnTxt
    $cbtn.Tag = $row
    $cbtn.Add_MouseEnter({ param($s, $e) $s.Background = Get-Brush '#40B48EF0' })
    $cbtn.Add_MouseLeave({ param($s, $e) $s.Background = Get-Brush '#26B48EF0' })
    $cbtn.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
    $cbtn.Add_MouseLeftButtonUp({
        param($s, $e)
        $e.Handled = $true
        Invoke-CompactSession $s.Tag.Tag   # row.Tag = the LIVE session object
    })
    [System.Windows.Controls.Grid]::SetColumn($cbtn, 1)
    [void]$line1.Children.Add($cbtn)
    # context meter: how full this session's head is (e.g. 178k). muted while
    # comfy, amber past 180k, red past 256k - compact when YOU decide to.
    $ctx = New-Object System.Windows.Controls.TextBlock
    $ctx.FontSize = 10.5
    $ctx.FontWeight = [System.Windows.FontWeights]::SemiBold
    $ctx.Foreground = Get-Brush '#5F5F6A'
    $ctx.VerticalAlignment = 'Center'
    $ctx.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
    $ctx.Visibility = 'Collapsed'
    $ctx.ToolTip = 'context in this session''s head'
    [System.Windows.Controls.Grid]::SetColumn($ctx, 2)
    [void]$line1.Children.Add($ctx)
    $age = New-Object System.Windows.Controls.TextBlock
    $age.FontSize = 10.5
    $age.Foreground = Get-Brush '#5F5F6A'
    $age.VerticalAlignment = 'Center'
    $age.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
    [System.Windows.Controls.Grid]::SetColumn($age, 3)
    [void]$line1.Children.Add($age)
    [void]$mid.Children.Add($line1)

    $sub = New-Object System.Windows.Controls.TextBlock
    $sub.FontSize = 10.5
    $sub.TextTrimming = 'CharacterEllipsis'
    $sub.Margin = New-Object System.Windows.Thickness(0, 1, 0, 0)
    $runStatus = New-Object System.Windows.Documents.Run('')
    $runStatus.FontWeight = [System.Windows.FontWeights]::SemiBold
    [void]$sub.Inlines.Add($runStatus)
    $runMsg = New-Object System.Windows.Documents.Run('')
    $runMsg.Foreground = Get-Brush '#8B8B95'
    [void]$sub.Inlines.Add($runMsg)
    [void]$mid.Children.Add($sub)

    # ANSWER STRIP (experimental): when the prober has parsed this blocked
    # row's pending question, it renders here - the question + the exact
    # thing being approved, and one button per option. Clicking injects the
    # digit BY PID: answering never steals focus or leaves this window.
    # answer strip: a proper CARD, not loose text - accent edge on the left
    # (this is a pending approval, it should read like one), question dim,
    # the command being approved in MONOSPACE (that's the thing you're
    # signing), buttons below with real hit targets
    $ans = New-Object System.Windows.Controls.Border
    $ans.Visibility = 'Collapsed'
    $ans.CornerRadius = New-Object System.Windows.CornerRadius(7)
    $ans.Background = Get-Brush '#12FFFFFF'
    $ans.BorderBrush = Get-Brush '#66FF6B8A'
    $ans.BorderThickness = New-Object System.Windows.Thickness(2, 0, 0, 0)
    $ans.Padding = New-Object System.Windows.Thickness(9, 5, 8, 6)
    $ans.Margin = New-Object System.Windows.Thickness(0, 5, 0, 2)
    $ansStack = New-Object System.Windows.Controls.StackPanel
    $ans.Child = $ansStack
    $ansTxt = New-Object System.Windows.Controls.TextBlock
    $ansTxt.FontSize = 10.5
    $ansTxt.Foreground = Get-Brush '#B9B9C4'
    $ansTxt.TextTrimming = 'CharacterEllipsis'
    [void]$ansStack.Children.Add($ansTxt)
    $ansCmd = New-Object System.Windows.Controls.TextBlock
    $ansCmd.FontFamily = New-Object System.Windows.Media.FontFamily('Cascadia Mono,Consolas,monospace')
    $ansCmd.FontSize = 11
    $ansCmd.Foreground = Get-Brush '#F0F0F5'
    $ansCmd.TextTrimming = 'CharacterEllipsis'
    $ansCmd.Margin = New-Object System.Windows.Thickness(0, 2, 0, 6)
    [void]$ansStack.Children.Add($ansCmd)
    $ansBtns = New-Object System.Windows.Controls.WrapPanel
    [void]$ansStack.Children.Add($ansBtns)
    [void]$mid.Children.Add($ans)
    [void]$grid.Children.Add($mid)

    $row.Child = $grid

    $row.Add_MouseEnter({
        param($s, $e)
        if ($s.Tag.Status -in @('attention', 'error', 'retrying')) { $s.Background = Get-Brush '#26FF6B6B' }
        else { $s.Background = Get-Brush '#12FFFFFF' }
    })
    $row.Add_MouseLeave({ param($s, $e) $s.Background = Get-RowBaseBrush $s.Tag })
    $row.Add_MouseLeftButtonDown({
        # INSTANT pressed feedback - the work happens on mouse-up, but the
        # eye needs an answer in the same frame as the finger
        param($s, $e)
        $s.Background = Get-Brush '#22FFFFFF'
    })
    $row.Add_MouseLeftButtonUp({
        param($s, $e)
        # DEBOUNCE, hard. Focusing can involve console probes and the tab
        # walk - seconds of blocked UI thread. Impatient multi-clicks queue
        # up behind the first one and each used to re-run the WHOLE dance,
        # freezing the widget for the sum of all of them.
        if ($script:FocusBusy) { return }
        if ([string]$s.Tag.Id -eq $script:LastFocusId -and
            ((Get-Date) - $script:LastFocusStamp).TotalMilliseconds -lt 1500) { return }
        $script:FocusBusy = $true
        try {
            $ok = Invoke-FocusSession $s.Tag
            if ($ok -and $script:HudHideAfterFocus) { $script:Window.WindowState = 'Minimized' }
            if (-not $ok) { $s.Background = Get-Brush '#33FF6B6B' }
        }
        finally {
            $script:FocusBusy = $false
            $script:LastFocusId = [string]$s.Tag.Id
            $script:LastFocusStamp = Get-Date
        }
    })
    $row.ContextMenu = New-RowMenu $row

    # prompt peek (steal from the macOS menubar crowd): hover a row and see
    # what you asked + what claude answered, without switching tabs. Content
    # is built lazily on open - hovering costs nothing until you linger.
    $tt = New-Object System.Windows.Controls.ToolTip
    # OPAQUE on purpose: tooltips are separate popup hwnds with no acrylic
    # backdrop - a translucent brush there blends with whatever's behind the
    # popup and reads as milky garbage, especially over the glass theme
    $tt.Background = Get-Brush '#FF201D26'
    $tt.BorderBrush = Get-Brush '#2EFFFFFF'
    $tt.BorderThickness = New-Object System.Windows.Thickness(1)
    $tt.Padding = New-Object System.Windows.Thickness(11, 8, 11, 9)
    # placeholder content is LOAD-BEARING: WPF never opens an empty ToolTip,
    # so ToolTipOpening (where the real content gets built) would never fire
    $tt.Content = [string][char]0x2026
    $row.ToolTip = $tt
    [System.Windows.Controls.ToolTipService]::SetInitialShowDelay($row, 700)
    [System.Windows.Controls.ToolTipService]::SetShowDuration($row, 60000)
    # content is built on MOUSE ENTER, not ToolTipOpening: the opening event
    # never fired in this window (and an empty tooltip never opens, so lazy-
    # build-on-open was a chicken-and-egg). MouseEnter provably fires - the
    # hover highlight rides it - and the 700ms show delay means the panel is
    # long built before the tooltip appears.
    $row.Add_MouseEnter({
        param($s, $e)
        try {
            $sess = $s.Tag
            $peek = Get-TranscriptPeek ([string]$sess.Transcript)
            $fallback = Get-PeekDisplayText ([string]$sess.Message) 300
            $hasPeek = ($null -ne $peek -and ($peek.You.Length -gt 0 -or $peek.Bot.Length -gt 0))
            if (-not $hasPeek -and [string]::IsNullOrWhiteSpace($fallback)) {
                $s.ToolTip = $null   # a null tooltip never opens
                return
            }
            $panel = New-Object System.Windows.Controls.StackPanel
            $panel.MaxWidth = 330
            $blocks = @()
            if ($hasPeek) {
                if ($peek.You.Length -gt 0) { $blocks += , @('you', '#8FA0C8', $peek.You) }
                if ($peek.Bot.Length -gt 0) { $blocks += , @('claude', '#5ED584', $peek.Bot) }
            }
            else { $blocks += , @('last status', '#8FA0C8', $fallback) }
            foreach ($b in $blocks) {
                $h = New-Object System.Windows.Controls.TextBlock
                $h.Text = [string]$b[0]
                $h.FontSize = 9
                $h.FontWeight = [System.Windows.FontWeights]::SemiBold
                $h.Foreground = Get-Brush ([string]$b[1])
                [void]$panel.Children.Add($h)
                $bd = New-Object System.Windows.Controls.TextBlock
                $bd.Text = [string]$b[2]
                $bd.FontSize = 11
                $bd.Foreground = Get-Brush '#E8E8EC'
                $bd.TextWrapping = 'Wrap'
                $bd.Margin = New-Object System.Windows.Thickness(0, 1, 0, 6)
                [void]$panel.Children.Add($bd)
            }
            # ASSIGN a fresh tooltip, never mutate through $s.ToolTip: the
            # getter came back null-ish in the live window (hud-error.log
            # caught 'property Content cannot be found') even though the
            # identical pattern passes in isolation - assignment can't miss
            $tip = New-Object System.Windows.Controls.ToolTip
            $tip.Background = Get-Brush '#FF201D26'
            $tip.BorderBrush = Get-Brush '#2EFFFFFF'
            $tip.BorderThickness = New-Object System.Windows.Thickness(1)
            $tip.Padding = New-Object System.Windows.Thickness(11, 8, 11, 9)
            $tip.Content = $panel
            $s.ToolTip = $tip
        }
        catch {
            try {
                $diag = 'sender=' + $s.GetType().Name + ' tip=' + $(if ($null -eq $s.ToolTip) { 'null' } else { $s.ToolTip.GetType().Name })
                Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-error.log') -Value "$(Get-Date -Format s) peek: $_ [$diag]" -ErrorAction SilentlyContinue
            }
            catch { }
        }
    })

    $entry = @{
        Row = $row; Dot = $dot; Glow = $glow; Name = $name; Age = $age; Ctx = $ctx
        RunStatus = $runStatus; RunMsg = $runMsg; CompactBtn = $cbtn
        Ans = $ans; AnsTxt = $ansTxt; AnsCmd = $ansCmd; AnsBtns = $ansBtns
        StatusKey = ''; NameKey = ''; SubKey = ''; TipKey = ''; CtxKey = ''; CompactKey = ''; AnsKey = ''
    }
    Update-SessionRow $entry $Sess
    return $entry
}

function Update-SessionRow($Entry, $Sess) {
    # mutate only what CHANGED - property sets on unchanged values still cost
    # layout, and this runs for every row on every tick
    $Entry.Row.Tag = $Sess   # handlers + menus always see the live object
    $meta = Get-StatusMeta $Sess.Status

    if ($Entry.StatusKey -ne [string]$Sess.Status) {
        $Entry.StatusKey = [string]$Sess.Status
        $Entry.Dot.Fill = Get-Brush $meta.Color
        $Entry.Glow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($meta.Color)
        $Entry.RunStatus.Foreground = Get-Brush $meta.Color
        if ($Sess.Status -eq 'working' -or $Sess.Status -eq 'attention') {
            $anim = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.3,
                (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(850))))
            $anim.AutoReverse = $true
            $anim.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
            # 8fps: a Forever animation defaults to ~60fps, and on a layered
            # window EVERY frame is a full present+readback. The pulse reads
            # the same at 8.
            $anim.SetValue([System.Windows.Media.Animation.Timeline]::DesiredFrameRateProperty, 8)
            $Entry.Dot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $anim)
        }
        else {
            $Entry.Dot.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
            $Entry.Dot.Opacity = 1.0
        }
        if (-not $Entry.Row.IsMouseOver) { $Entry.Row.Background = Get-RowBaseBrush $Sess }
    }

    $nameTxt = $(if ($Sess.Pinned) { [char]::ConvertFromUtf32(0x1F4CC) + ' ' + $Sess.DisplayName } else { [string]$Sess.DisplayName })
    if ($Entry.NameKey -ne $nameTxt) { $Entry.NameKey = $nameTxt; $Entry.Name.Text = $nameTxt }

    $ageTxt = Format-Age $Sess.Ts
    if ($Entry.Age.Text -ne $ageTxt) { $Entry.Age.Text = $ageTxt }

    $ctxVal = [long]$Sess.Context
    $ctxTxt = $(if ($ctxVal -gt 0) { '{0}k' -f [int][Math]::Round($ctxVal / 1000.0) } else { '' })
    if ($Entry.CtxKey -ne $ctxTxt) {
        $Entry.CtxKey = $ctxTxt
        if ($ctxTxt.Length -eq 0) { $Entry.Ctx.Visibility = 'Collapsed' }
        else {
            $Entry.Ctx.Text = $ctxTxt
            $col = '#5F5F6A'
            if ($ctxVal -ge 256000) { $col = '#FF6B6B' }
            elseif ($ctxVal -ge 180000) { $col = '#FFB84D' }
            $Entry.Ctx.Foreground = Get-Brush $col
            $Entry.Ctx.Visibility = 'Visible'
        }
    }

    # compact button: threshold from settings, claude rows only (/compact is
    # his dialect), hidden while already compacting
    $showCompact = ($script:CompactAtK -gt 0 -and $ctxVal -ge ([long]$script:CompactAtK * 1000) -and
                    $Sess.Status -ne 'compacting' -and [string]$Sess.Provider -eq 'claude')
    $compactKey = [string]$showCompact
    if ($Entry.CompactKey -ne $compactKey) {
        $Entry.CompactKey = $compactKey
        $Entry.CompactBtn.Visibility = $(if ($showCompact) { 'Visible' } else { 'Collapsed' })
    }

    # answer strip: pending prompt captured off this row's console. Buttons
    # rebuild only when the CAPTURE changes (rare), never per tick.
    $prompt = $null
    $apidA = [int]$Sess.AgentPid
    if (($Sess.Status -eq 'attention' -or $Sess.Status -eq 'parked') -and $apidA -gt 0) {
        $capA = $script:PromptCapByPid[$apidA]
        if ($null -ne $capA) { $prompt = $capA.Prompt }
    }
    $ansKey = ''
    if ($null -ne $prompt) {
        $ansKey = "$($prompt.Question)|$($prompt.Detail)|" +
                  ((@($prompt.Options) | ForEach-Object { "$($_.Num):$($_.Label)" }) -join '|')
    }
    if ($Entry.AnsKey -ne $ansKey) {
        $Entry.AnsKey = $ansKey
        $Entry.AnsBtns.Children.Clear()
        if ($ansKey.Length -eq 0) { $Entry.Ans.Visibility = 'Collapsed' }
        else {
            $hdr = [string]$prompt.Question
            if ($hdr.Length -eq 0) { $hdr = 'claude is asking:' }
            $dt = [string]$prompt.Detail
            $Entry.AnsTxt.Text = $hdr
            $Entry.Ans.ToolTip = $(if ($dt.Length -gt 0) { "$dt`n$hdr" } else { $hdr })
            if ($dt.Length -gt 0) { $Entry.AnsCmd.Text = $dt; $Entry.AnsCmd.Visibility = 'Visible' }
            else { $Entry.AnsCmd.Visibility = 'Collapsed' }
            foreach ($o in @($prompt.Options)) {
                $n = [int]$o.Num
                $lbl = [string]$o.Label
                $short = $(if ($lbl.Length -gt 30) { $lbl.Substring(0, 30).TrimEnd() + [string][char]0x2026 } else { $lbl })
                # bg | border | label | hover-bg | number
                $pal = '#22FFFFFF|#42FFFFFF|#E2E2E8|#3AFFFFFF|#9A9AA6'
                if ($lbl -match '^(?i)yes') { $pal = '#2E5ED584|#5C5ED584|#C9F4DC|#455ED584|#8FD9AF' }
                elseif ($lbl -match '^(?i)no') { $pal = '#2EFF6B6B|#5CFF6B6B|#F7C2C2|#45FF6B6B|#E09B9B' }
                $cols = $pal.Split('|')
                $b = New-Object System.Windows.Controls.Border
                $b.CornerRadius = New-Object System.Windows.CornerRadius(7)
                $b.Background = Get-Brush $cols[0]
                $b.BorderBrush = Get-Brush $cols[1]
                $b.BorderThickness = New-Object System.Windows.Thickness(1)
                $b.Padding = New-Object System.Windows.Thickness(11, 3, 11, 4)
                $b.Margin = New-Object System.Windows.Thickness(0, 0, 7, 2)
                $b.Cursor = [System.Windows.Input.Cursors]::Hand
                $b.ToolTip = $lbl
                $btTxt = New-Object System.Windows.Controls.TextBlock
                $numRun = New-Object System.Windows.Documents.Run("$n")
                $numRun.FontSize = 10
                $numRun.Foreground = Get-Brush $cols[4]
                [void]$btTxt.Inlines.Add($numRun)
                $lblRun = New-Object System.Windows.Documents.Run("  $short")
                $lblRun.FontSize = 11.5
                $lblRun.FontWeight = [System.Windows.FontWeights]::SemiBold
                $lblRun.Foreground = Get-Brush $cols[2]
                [void]$btTxt.Inlines.Add($lblRun)
                $b.Child = $btTxt
                $b.Tag = @{ Row = $Entry.Row; Num = $n; NB = (Get-Brush $cols[0]); HB = (Get-Brush $cols[3]) }
                $b.Add_MouseEnter({ param($s, $e) $s.Background = $s.Tag.HB })
                $b.Add_MouseLeave({ param($s, $e) $s.Background = $s.Tag.NB })
                $b.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
                $b.Add_MouseLeftButtonUp({
                    param($s, $e)
                    $e.Handled = $true
                    Invoke-AnswerPrompt $s.Tag.Row.Tag ([int]$s.Tag.Num)
                })
                [void]$Entry.AnsBtns.Children.Add($b)
            }
            $Entry.Ans.Visibility = 'Visible'
        }
    }

    $snippet = ($Sess.Message -replace '\s+', ' ').Trim()
    if ($snippet.Length -gt 70) { $snippet = $snippet.Substring(0, 70) }
    $label = $meta.Label
    if ($Sess.Status -eq 'working' -and $script:ShowTimers -and $script:WorkSince.ContainsKey($Sess.Id)) {
        $workSpan = (Get-Date) - $script:WorkSince[$Sess.Id]
        if ($workSpan.TotalSeconds -ge 90) { $label = "working $(Format-Age $script:WorkSince[$Sess.Id])" }
    }
    if ($Sess.Provider -and $Sess.Provider -ne 'claude') { $label = "$($Sess.Provider)$($script:Sep)$label" }
    $subKey = "$label|$snippet"
    if ($Entry.SubKey -ne $subKey) {
        $Entry.SubKey = $subKey
        $Entry.RunStatus.Text = $label
        $Entry.RunMsg.Text = $(if ($snippet.Length -gt 0) { "$($script:Dash)$snippet" } else { '' })
    }

    $tipTab = ''
    if ($null -ne $Sess.Window -and $Sess.Window.PSObject.Properties['tab_name']) {
        $tipTab = [string]$Sess.Window.tab_name
    }
    $tipCwd = $Sess.Cwd
    if ([string]::IsNullOrWhiteSpace($tipCwd)) { $tipCwd = '(untracked - folder unknown)' }
    $tipKey = "$tipCwd|$tipTab|$($Sess.Message)"
    if ($Entry.TipKey -ne $tipKey) {
        $Entry.TipKey = $tipKey
        $Entry.Row.ToolTip = "$tipCwd`ntab: $tipTab`n`n$($Sess.Message)`n`nclick = focus$($script:Sep)right-click = pin / rename / hide"
    }
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
    $script:ProbeBudget = 3

    # reap probe children unconditionally: before this sweep, a probe whose
    # pid stopped being interesting was never collected - hung children kept
    # a conhost attached forever and Process objects leaked
    foreach ($k in @($script:ProbeJobs.Keys)) {
        $job = $script:ProbeJobs[$k]
        $age = ((Get-Date) - $job.Started).TotalSeconds
        if (-not $job.Proc.HasExited) {
            if ($age -gt 8) {
                try { $job.Proc.Kill() } catch { }
                try { $job.Proc.Dispose() } catch { }
                [void]$script:ProbeJobs.Remove($k)
            }
        }
        elseif ($age -gt 30) {
            try { $job.Proc.Dispose() } catch { }
            [void]$script:ProbeJobs.Remove($k)
        }
    }
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

    # crash insurance, tick side: (1) anything the old snapshot offered
    # that turns out to be alive (perch restart, not a reboot) leaves the
    # offer; (2) the rolling snapshot rewrites whenever the live id-set
    # changes - atomically, because the next power cut won't wait
    if ($script:RestorePending.Count -gt 0) {
        for ($ri = $script:RestorePending.Count - 1; $ri -ge 0; $ri--) {
            if ($liveIds.ContainsKey($script:RestorePending[$ri].Id)) { $script:RestorePending.RemoveAt($ri) }
        }
    }
    Update-RestoreBar
    $snapList = @()
    foreach ($s in $visible) {
        if (($s.Provider -eq 'claude' -or $s.Id -match '^[0-9a-fA-F-]{32,}$') -and
            -not [string]::IsNullOrWhiteSpace($s.Id) -and
            -not [string]::IsNullOrWhiteSpace($s.Cwd)) {
            $snapList += , @{ id = $s.Id; cwd = $s.Cwd; name = $s.CwdName
                              flags = (Get-SessionPermFlags ([int]$s.AgentPid)) }
        }
    }
    $snapSig = (@($snapList | ForEach-Object { $_.id }) -join '|')
    if ($snapSig -ne $script:LiveSnapSig) {
        $script:LiveSnapSig = $snapSig
        try {
            $tmp = $SnapPath + '.tmp'
            @{ savedAt = (Get-Date).ToString('o'); sessions = $snapList } |
                ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tmp -Encoding UTF8
            Move-Item -LiteralPath $tmp -Destination $SnapPath -Force
        }
        catch { }
    }

    # DIFF rendering: rows persist across ticks and only changed properties
    # get touched. No more clear-and-rebuild = no hover flicker, no layout
    # storm every 2 seconds, menus stay attached. This is most of the
    # difference between "web page" and "native".
    $have = @{}
    foreach ($s in $visible) { $have[[string]$s.Id] = $true }
    foreach ($id in @($script:RowCache.Keys)) {
        if (-not $have.ContainsKey($id)) {
            [void]$script:SessionList.Children.Remove($script:RowCache[$id].Row)
            [void]$script:RowCache.Remove($id)
        }
    }

    if ($visible.Count -eq 0) {
        if ($null -eq $script:EmptyEl) {
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
            $script:EmptyEl = $emptyStack
        }
        if (-not $script:SessionList.Children.Contains($script:EmptyEl)) {
            [void]$script:SessionList.Children.Add($script:EmptyEl)
        }
    }
    else {
        if ($null -ne $script:EmptyEl -and $script:SessionList.Children.Contains($script:EmptyEl)) {
            [void]$script:SessionList.Children.Remove($script:EmptyEl)
        }
        $idx = 0
        foreach ($s in $visible) {
            $id = [string]$s.Id
            if ($script:RowCache.ContainsKey($id)) {
                $entry = $script:RowCache[$id]
                Update-SessionRow $entry $s
                $cur = $script:SessionList.Children.IndexOf($entry.Row)
                if ($cur -ne $idx -and $cur -ge 0) {
                    $script:SessionList.Children.RemoveAt($cur)
                    $script:SessionList.Children.Insert($idx, $entry.Row)
                }
            }
            else {
                $entry = New-SessionRow $s
                $script:RowCache[$id] = $entry
                $script:SessionList.Children.Insert($idx, $entry.Row)
            }
            $idx++
        }
    }

    Update-LimitsPanel

    # chips are created ONCE; per tick we only flip text/visibility when a
    # count actually changed (the old clear+rebuild invalidated layout every
    # tick and re-triggered window-level measure for nothing)
    if ($null -eq $script:ChipSet) {
        $script:ChipSet = @{}
        foreach ($cdef in @(@('att', '#FF6B6B'), @('work', '#FFB84D'), @('done', '#5ED584'),
                            @('quiet', '#8FA0C8'), @('all', '#71717A'))) {
            $chip = New-Chip '' $cdef[1]
            $chip.Visibility = 'Collapsed'
            if ($cdef[0] -eq 'att') {
                # red = jump, everywhere: the chip too (peek card + full view)
                $chip.Cursor = [System.Windows.Input.Cursors]::Hand
                $chip.ToolTip = 'jump to the session that needs you'
                $chip.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true })
                $chip.Add_MouseLeftButtonUp({ param($s, $e) $e.Handled = $true; Invoke-JumpToAtt })
            }
            $script:ChipSet[$cdef[0]] = $chip
            [void]$script:ChipsPanel.Children.Add($chip)
        }
    }
    $attList = @($visible | Where-Object { $_.Status -eq 'attention' -or $_.Status -eq 'error' })
    $script:PillAttTarget = $null
    if ($attList.Count -gt 0) {
        # neediest = the one that's been waiting longest
        $script:PillAttTarget = @($attList | Sort-Object Ts)[0]
    }
    $att   = $attList.Count
    $work  = @($visible | Where-Object { $_.Status -in @('working', 'compacting', 'retrying') }).Count
    $done  = @($visible | Where-Object { $_.Status -eq 'idle' }).Count
    $quiet = @($visible | Where-Object { $_.Status -in @('quiet', 'parked') }).Count
    $chipTexts = @{
        att   = $(if ($att -gt 0) { "$att need you" } else { '' })
        work  = $(if ($work -gt 0) { "$work working" } else { '' })
        done  = $(if ($done -gt 0) { "$done done" } else { '' })
        quiet = $(if ($quiet -gt 0) { "$quiet quiet" } else { '' })
        all   = $(if (($att + $work + $done + $quiet) -eq 0) { 'all quiet' } else { '' })
    }
    foreach ($ck in $chipTexts.Keys) {
        $chip = $script:ChipSet[$ck]
        $txt = [string]$chipTexts[$ck]
        if ($txt.Length -eq 0) {
            if ($chip.Visibility -ne 'Collapsed') { $chip.Visibility = 'Collapsed' }
        }
        else {
            if ($chip.Child.Text -ne $txt) { $chip.Child.Text = $txt }
            if ($chip.Visibility -ne 'Visible') { $chip.Visibility = 'Visible' }
        }
    }
    $script:PillAttCount = $att
    $script:PillErrCount = @($visible | Where-Object { $_.Status -in @('error', 'retrying') }).Count
    $script:PillParkedCount = @($visible | Where-Object { $_.Status -eq 'parked' }).Count
    $script:PillDoneAll = ($done -gt 0 -and $att -eq 0 -and $work -eq 0)
    Update-PillCluster $att $work $done $quiet
    # a FINISH is a per-session working->idle transition WHERE THE HOOKS
    # THEMSELVES WROTE THE IDLE. Two generations of lies led here: the
    # aggregate done-count sang at compact bounces / new tabs / reappearing
    # rows; then per-session transitions still sang when a MANUAL /compact
    # bounced through SessionStart(source=compact)'s 'working' repaint and
    # the native lane landed it back to idle with nothing having run at all.
    # The tell: on a real finish Stop AUTHORS the idle in the status file -
    # on the phantom (and on Esc-interrupts, where you stopped it yourself)
    # nothing ever writes idle, the native lane lands it alone. So a native-
    # led idle holds the note: if the hooks' idle arrives within 6s (native
    # usually beats Stop's write by under a second on real finishes) the
    # bird sings then - if nothing arrives, nothing finished. Silence.
    $newlyDone = $false
    $curStatus = @{}
    foreach ($s in $visible) {
        $sid = [string]$s.Id
        $prev = [string]$script:PrevStatusById[$sid]
        $wasWork = ($prev -eq 'working' -or $prev -eq 'retrying')
        if ($s.Status -eq 'idle') {
            $hookIdle = ([string]$s.HookStatus -eq 'idle')
            if ($wasWork) {
                if ($hookIdle) { $newlyDone = $true; [void]$script:PendingDoneById.Remove($sid) }
                else { $script:PendingDoneById[$sid] = Get-Date }
            }
            elseif ($script:PendingDoneById.ContainsKey($sid)) {
                if ($hookIdle) { $newlyDone = $true; [void]$script:PendingDoneById.Remove($sid) }
                elseif (((Get-Date) - [datetime]$script:PendingDoneById[$sid]).TotalSeconds -ge 6) {
                    [void]$script:PendingDoneById.Remove($sid)   # nothing finished: stay silent
                }
            }
        }
        else { [void]$script:PendingDoneById.Remove($sid) }
        $curStatus[$sid] = [string]$s.Status
    }
    $script:PrevStatusById = $curStatus
    if ($newlyDone) {
        Invoke-DoneChirp          # the finish line SINGS (double chirp)
        Invoke-BirdMotion 'hop'   # work finished!
        if ($null -ne $script:BirdFaces['happy']) {
            $script:BirdFaceHoldUntil = (Get-Date).AddMilliseconds(2500)
            Set-BirdFace 'happy'
            if ($null -ne $script:BirdFaces['happy2'] -and $script:Compact -and
                $script:PillCard.Visibility -eq 'Visible') {
                # and he FLAPS through the hop
                $script:BirdFlapN = 0
                $script:BirdFlapTimer.Stop(); $script:BirdFlapTimer.Start()
            }
        }
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
    if ($hasNew) {
        Invoke-AttentionRaise
        Invoke-BirdMotion 'perk'
        if ($null -ne $script:BirdFaces['alert']) {
            $script:BirdFaceHoldUntil = (Get-Date).AddSeconds(45)
            Set-BirdFace 'alert'
        }
    }
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
# full mode: double-click header = fold to pill, single click = drag.
# compact mode: the pill/peek card is one big 'open me' button - click
# expands, drag moves. The catch: hovering to GRAB the pill opens the peek
# (that's its job), so a naive DragMove would drag the open island - the
# thing the user hated most. We must know click-vs-drag BEFORE acting, and
# DragMove() only tells us at mouse-up. So compact presses are detected by
# hand: arm on press, watch movement, and the moment it crosses the drag
# threshold FOLD the peek back to the pill and drag the pill. Release
# without movement = click = expand. The stamp guards the second press of
# an old-habit double-click from instantly re-folding what the first
# press just opened.
$script:PillExpandStamp = [datetime]::MinValue
$script:PillPressActive = $false
$script:PillPressWasPeeked = $false
$script:PillDragDress = $null
$script:PillPressPt = New-Object System.Windows.Point(0.0, 0.0)
$script:HeaderClick = {
    param($s, $e)
    if ($e.ClickCount -eq 2) {
        if (((Get-Date) - $script:PillExpandStamp).TotalMilliseconds -lt 450) {
            $e.Handled = $true
            return
        }
        Set-CompactMode (-not $script:Compact)
        Save-HudState
        $e.Handled = $true
        return
    }
    if (-not $script:Compact) {
        try { $script:Window.DragMove() } catch { }
        return
    }
    # compact: arm the click-vs-drag watcher. Capture so move/up still
    # reach us when a fast flick leaves the tiny pill before we commit.
    try {
        $script:PillPressPt = $script:Window.PointToScreen($e.GetPosition($script:Window))
        $script:PillPressWasPeeked = $script:PillPeeked   # decides the click LADDER at release
        $script:PillPressActive = $true
        [void]$script:Window.CaptureMouse()
    }
    catch { $script:PillPressActive = $false }
    $e.Handled = $true
}
$Header.Add_MouseLeftButtonDown($script:HeaderClick)
$ChipsPanel.Add_MouseLeftButtonDown($script:HeaderClick)
$script:PillBar.Add_MouseLeftButtonDown($script:HeaderClick)   # pill: click out or drag
# compact only: the whole peeked card body is clickable too. Double runs
# are safe - the second bubbled invocation re-reads $script:Compact.
$script:RootCard.Add_MouseLeftButtonDown({
    param($s, $e)
    if ($script:Compact -and -not $e.Handled) { & $script:HeaderClick $s $e }
})
$Window.Add_MouseMove({
    param($s, $e)
    if (-not $script:PillPressActive) { return }
    if ($e.LeftButton -ne [System.Windows.Input.MouseButtonState]::Pressed) {
        $script:PillPressActive = $false
        try { $script:Window.ReleaseMouseCapture() } catch { }
        return
    }
    try { $cur = $script:Window.PointToScreen($e.GetPosition($script:Window)) } catch { return }
    if ([Math]::Abs($cur.X - $script:PillPressPt.X) -lt 4 -and
        [Math]::Abs($cur.Y - $script:PillPressPt.Y) -lt 4) { return }
    # it's a DRAG: fold to the pill first, then move the pill - and the
    # bird gets scruff-grabbed like a kitten for the ride
    $script:PillPressActive = $false
    try { $script:Window.ReleaseMouseCapture() } catch { }
    Set-PillFoldInstant
    if ($null -ne $script:BirdFaces['grabbed']) {
        $script:BirdFaceHoldUntil = [datetime]::MaxValue
        Set-BirdFace 'grabbed' -Instant
    }
    # you carry ONLY the bird - and he's the STAR: capsule, ring, counts and
    # every margin vanish, and he grows to 68px. The window shrink-wraps to
    # just the big scruff-grabbed cutie under your cursor.
    $script:PillDragDress = $null
    try {
        $script:PillDragDress = @{
            Bg = $script:PillCard.Background
            Border = $script:PillCard.BorderBrush
            Arc = $script:PillRingArc.Visibility
            CardMargin = $script:PillCard.Margin
            BarMargin = $script:PillBar.Margin
        }
        $script:PillCard.Background = [System.Windows.Media.Brushes]::Transparent
        $script:PillCard.BorderBrush = [System.Windows.Media.Brushes]::Transparent
        $script:PillRingTrack.Visibility = 'Collapsed'
        $script:PillRingArc.Visibility = 'Collapsed'
        if ($null -ne $script:PillClusterPanel) { $script:PillClusterPanel.Visibility = 'Collapsed' }
        $script:PillCard.Margin = New-Object System.Windows.Thickness(0)
        $script:PillBar.Margin = New-Object System.Windows.Thickness(0)
        if ($null -ne $script:BirdRingGrid) { $script:BirdRingGrid.Width = 68.0; $script:BirdRingGrid.Height = 68.0 }
        if ($null -ne $script:BirdImgGrid) { $script:BirdImgGrid.Width = 68.0; $script:BirdImgGrid.Height = 68.0 }
    }
    catch { }
    # pinch him AT the cursor: DragMove keeps whatever offset you grabbed
    # with, so snap the window first - the scruff of the 68px carry bird
    # (border 1 + center 34 = x 35; y ~11) lands exactly under the pointer
    try {
        $grabPos = $e.GetPosition($script:Window)
        $script:Window.Left += $grabPos.X - 35.0
        $script:Window.Top += $grabPos.Y - 11.0
    }
    catch { }
    # dangle physics: pivot at the scruff, kill any held rotation animation,
    # zero the spring, start the sampler
    try {
        if ($null -ne $script:BirdRot) {
            $script:BirdRot.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
        }
        if ($null -ne $script:BirdScale) {
            # the spring owns scale too (jelly) - release any held animations
            foreach ($sp2 in @([System.Windows.Media.ScaleTransform]::ScaleXProperty,
                               [System.Windows.Media.ScaleTransform]::ScaleYProperty)) {
                $script:BirdScale.BeginAnimation($sp2, $null)
            }
            $script:BirdScale.ScaleX = 1.0
            $script:BirdScale.ScaleY = 1.0
        }
        if ($null -ne $script:BirdShift) {
            # an idle antic mid-grab would keep tugging the translate and pull
            # the scruff off the cursor pin - release both axes
            foreach ($tp2 in @([System.Windows.Media.TranslateTransform]::XProperty,
                               [System.Windows.Media.TranslateTransform]::YProperty)) {
                $script:BirdShift.BeginAnimation($tp2, $null)
            }
            $script:BirdShift.X = 0.0
            $script:BirdShift.Y = 0.0
        }
        if ($null -ne $script:BirdImgGrid) {
            $script:BirdImgGrid.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.08)
        }
        $script:CarryLastX = $script:Window.Left
        $script:CarryAngle = 0.0
        $script:CarryAngVel = 0.0
        $script:CarryFlips = 0
        $script:CarryLastSign = 0
        $script:CarrySwingTimer.Start()
    }
    catch { }
    # flush layout + a render pass BEFORE the modal drag: without this the
    # layered window drags STALE pixels - the old open island ghosting
    # behind the pill for the whole ride
    try {
        $script:Window.UpdateLayout()
        $script:Window.Dispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Render)
    }
    catch { }
    $script:PillDragging = $true
    try { $script:Window.DragMove() } catch { }
    finally {
        $script:PillDragging = $false
        try { $script:CarrySwingTimer.Stop() } catch { }
        try {
            if ($null -ne $script:BirdImgGrid) {
                $script:BirdImgGrid.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.72)
            }
            if ($null -ne $script:BirdRot) {
                $script:BirdRot.Angle = $(if ($script:BirdDozing) { -10.0 } else { 0.0 })
            }
            if ($null -ne $script:BirdScale) {
                $script:BirdScale.ScaleX = 1.0
                $script:BirdScale.ScaleY = 1.0
            }
        }
        catch { }
        $script:PillDragEnd = Get-Date
        if ($null -ne $script:PillDragDress) {
            try {
                $script:PillCard.Background = $script:PillDragDress.Bg
                $script:PillCard.BorderBrush = $script:PillDragDress.Border
                $script:PillRingTrack.Visibility = 'Visible'
                $script:PillRingArc.Visibility = $script:PillDragDress.Arc
                if ($null -ne $script:PillClusterPanel) { $script:PillClusterPanel.Visibility = 'Visible' }
                $script:PillCard.Margin = $script:PillDragDress.CardMargin
                $script:PillBar.Margin = $script:PillDragDress.BarMargin
                if ($null -ne $script:BirdRingGrid) { $script:BirdRingGrid.Width = 52.0; $script:BirdRingGrid.Height = 52.0 }
                if ($null -ne $script:BirdImgGrid) { $script:BirdImgGrid.Width = 52.0; $script:BirdImgGrid.Height = 52.0 }
            }
            catch { }
            $script:PillDragDress = $null
        }
        Save-HudState   # parked = remembered, even if perch dies uncleanly
        $script:BirdFaceHoldUntil = [datetime]::MinValue
        Update-BirdFace
        Invoke-BirdMotion 'settle'
    }
})
$Window.Add_MouseLeftButtonUp({
    param($s, $e)
    if (-not $script:PillPressActive) { return }
    $script:PillPressActive = $false
    try { $script:Window.ReleaseMouseCapture() } catch { }
    if ($script:Compact) {
        # ONE rung: click = full view. The peek middle-state was redundant -
        # everything it showed, the full card shows better, and the pill's
        # tooltip carries the limits glance for free.
        $script:PillExpandStamp = Get-Date
        Set-CompactMode $false
        Save-HudState
    }
})
function Save-HudState {
    try {
        Set-ContentAtomic $StatePath (@{ Left = $script:Window.Left; Top = $script:Window.Top
           Topmost = $script:UserTopmost; Compact = $script:Compact
           Calib = @($script:BlockCalib) } | ConvertTo-Json -Depth 4)
    }
    catch { }
}

$CloseBtn.Add_MouseLeftButtonUp({ $script:Window.Close() })
# pin = a TOGGLE, and a toggle must LOOK toggled: pinned shows the filled
# pin in gold, unpinned shows the slashed unpin glyph in the same dim gray
# as its neighbors. (The old look was one emoji at 35% opacity - unreadable.)
# Local Foreground beats the style's hover trigger, so hover is code-side too.
function Update-PinLook {
    if ($script:UserTopmost) {
        $script:PinBtn.Text = [string][char]0xE841   # PinnedFill
        $script:PinBtn.Foreground = Get-Brush $(if ($script:PinBtn.IsMouseOver) { '#FFE3A1' } else { '#FFD479' })
        $script:PinBtn.ToolTip = 'pinned: always on top (click to unpin)'
    }
    else {
        $script:PinBtn.Text = [string][char]0xE77A   # UnPin (slashed)
        $script:PinBtn.Foreground = Get-Brush $(if ($script:PinBtn.IsMouseOver) { '#DCDCE4' } else { '#66666E' })
        $script:PinBtn.ToolTip = 'unpinned: normal window - attention only flashes the taskbar (click to pin on top)'
    }
}
$PinBtn.Add_MouseLeftButtonUp({
    $script:UserTopmost = -not $script:UserTopmost
    $script:Window.Topmost = $script:UserTopmost
    Update-PinLook
    Save-HudState
})
$PinBtn.Add_MouseEnter({ Update-PinLook })
$PinBtn.Add_MouseLeave({ Update-PinLook })
Update-PinLook

# close leans RED on hover - universal "this dismisses something" grammar.
# ClearValue on leave hands Foreground back to the style (incl. its trigger).
$CloseBtn.Add_MouseEnter({ $script:CloseBtn.Foreground = Get-Brush '#FF8585' })
$CloseBtn.Add_MouseLeave({ $script:CloseBtn.ClearValue([System.Windows.Controls.TextBlock]::ForegroundProperty) })

# ===== TRAY RESIDENCY ====================================================
# closing the HUD is NOT quitting the app. The bird moves to the system
# tray and keeps watching - timers, hooks, chirps, the answer lane, all of
# it stays live with zero windows on screen. Quitting is a DELIBERATE act:
# tray right-click -> quit perch. This is what resident apps do, and perch
# is a resident.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$script:TrayQuit = $false          # set ONLY by the tray quit item: lets Closing actually close
$script:TrayBalloonShown = $false  # first hide per run explains where the bird went
function Invoke-TrayToggle {
    if ($script:Window.IsVisible) { $script:Window.Hide() }
    else { $script:Window.Show() }   # Topmost + ShowActivated=False: reappears without stealing focus
}
$script:Tray = New-Object System.Windows.Forms.NotifyIcon
try { $script:Tray.Icon = New-Object System.Drawing.Icon((Join-Path $PSScriptRoot 'icon.ico')) } catch { }
$script:Tray.Text = 'perch - watching your sessions'
$trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
$miShow = $trayMenu.Items.Add('show / hide perch')
$miShow.add_Click({ Invoke-TrayToggle })
[void]$trayMenu.Items.Add('-')
$miQuit = $trayMenu.Items.Add('quit perch')
$miQuit.add_Click({
    $script:TrayQuit = $true
    try { $script:Tray.Visible = $false; $script:Tray.Dispose() } catch { }
    $script:Window.Close()
})
$script:Tray.ContextMenuStrip = $trayMenu
$script:Tray.add_MouseClick({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Invoke-TrayToggle }
})
$script:Tray.Visible = $true

$Window.Add_Closing({
    param($s, $e)
    Save-HudState
    if (-not $script:TrayQuit) {
        $e.Cancel = $true
        $script:Window.Hide()
        if (-not $script:TrayBalloonShown) {
            $script:TrayBalloonShown = $true
            try { $script:Tray.ShowBalloonTip(2500, 'perch', 'still watching from the tray - left-click to reopen, right-click to quit', [System.Windows.Forms.ToolTipIcon]::Info) } catch { }
        }
    }
})
$Window.Add_Closed({
    # real quit: tear the tray icon down (or it ghosts in the tray until
    # hover) and end the dispatcher loop the app now runs on
    try { if ($null -ne $script:Tray) { $script:Tray.Visible = $false; $script:Tray.Dispose() } } catch { }
    try { [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() } catch { }
})

$script:Timer = New-Object System.Windows.Threading.DispatcherTimer
$script:Timer.Interval = [TimeSpan]::FromSeconds($RefreshSeconds)
$script:Timer.Add_Tick({ Update-List })
$script:Timer.Start()

# PULSE LANE: hooks write status files via tmp+rename, and NTFS bumps the
# parent DIRECTORY's mtime on every create/rename inside it. One metadata
# stat every 250ms (no handles held, no conhost contention, no per-file
# enumeration) means a Stop hook's write reaches the UI in <0.3s instead of
# waiting out the poll - the done-chirp lands the moment the hook lands,
# same latency as a plain sound-playing hook. The 2s Timer stays as the
# fallback truth (probes, untracked scans, decay states don't touch files).
$script:StatusDirPath  = $StatusDir
$script:StatusDirStamp = [datetime]::MinValue
try { $script:StatusDirStamp = [System.IO.Directory]::GetLastWriteTimeUtc($StatusDir) } catch { }
$script:PulseTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PulseTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:PulseTimer.Add_Tick({
    try {
        $ts = [System.IO.Directory]::GetLastWriteTimeUtc($script:StatusDirPath)
        if ($ts -ne $script:StatusDirStamp) {
            # DEBOUNCE: with many busy sessions the hooks write several times
            # a second, and every full tick resets ProbeBudget - probe spam is
            # exactly the conhost contention we swore off. Skip WITHOUT
            # updating the stamp: the diff persists, the next pulse catches it.
            if (((Get-Date) - $script:InTickStamp).TotalMilliseconds -lt 400) { return }
            $script:StatusDirStamp = $ts
            Update-List
        }
    } catch { }
})
$script:PulseTimer.Start()

# defer the first untracked-process scan: the window must be visible before
# any potentially slow console probing happens
$script:UntrackedStamp = Get-Date

Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-boot.log') -Value "$(Get-Date -Format s) first-update" -ErrorAction SilentlyContinue
Update-List
Add-Content -LiteralPath (Join-Path $PSScriptRoot 'hud-boot.log') -Value "$(Get-Date -Format s) show+run" -ErrorAction SilentlyContinue
# Show + Dispatcher.Run, NOT ShowDialog: hiding a dialog-shown window ENDS
# its modal loop and the whole app with it - tray residency needs the
# dispatcher to outlive the window's visibility. The Closed handler calls
# InvokeShutdown, which is what ends this loop on a real quit.
$Window.Show()
[System.Windows.Threading.Dispatcher]::Run()
