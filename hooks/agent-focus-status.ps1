param(
    [string]$Provider = "agent",
    [string]$StatusDirectory = ""
)

$ErrorActionPreference = "Stop"

function Write-HookSuccess {
    exit 0
}

function Get-SafeFileName {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return "unknown"
    }

    return ($Value -replace '[^a-zA-Z0-9_.-]', '_')
}

function Get-StableId {
    param(
        [string]$ProviderName,
        [string]$SessionId,
        [string]$Cwd,
        [string]$TranscriptPath
    )

    if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
        return $SessionId
    }

    $raw = "$ProviderName|$Cwd|$TranscriptPath"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)
        return -join ($sha.ComputeHash($bytes) | Select-Object -First 12 | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $sha.Dispose()
    }
}

function Get-AgentAncestorPid {
    # Walks up the parent chain from this hook process to find the agent
    # process (claude.exe / node / bun) that spawned it, so viewers can
    # detect dead sessions.
    try {
        $current = $PID
        for ($i = 0; $i -lt 6; $i++) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop
            if ($null -eq $proc) { break }
            $parentId = [int]$proc.ParentProcessId
            if ($parentId -le 0) { break }
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
            if ($null -eq $parent) { break }
            $name = [string]$parent.Name
            if ($name -match '^(claude|codex|gemini|opencode|aider|node|bun|deno)') { return $parentId }
            if ($name -match '^(WindowsTerminal|explorer|svchost|services)') { break }
            $current = $parentId
        }
    }
    catch {
    }
    return 0
}

function Test-IsSubagent {
    # Walks UP from the AGENT process: an agent-named ancestor (claude spawned
    # by claude - Task tool / agent teams) means true subagent; reaching the
    # terminal/shell host first means interactive session. Needed because a
    # manually-RENAMED WT tab ignores console-title changes, so the marker
    # dance can't see it - without this check those sessions were mis-flagged
    # as headless subagents and hidden from viewers.
    param([int]$AgentPid)

    try {
        $agentNames = '^(claude|codex|gemini|opencode|aider)'
        $current = $AgentPid
        for ($i = 0; $i -lt 8; $i++) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction Stop
            if ($null -eq $proc) { break }
            $parentId = [int]$proc.ParentProcessId
            if ($parentId -le 0) { break }
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -ErrorAction SilentlyContinue
            if ($null -eq $parent) { break }
            $name = [string]$parent.Name
            if ($name -match $agentNames) { return $true }
            if ($name -match '^(WindowsTerminal|explorer|svchost|services|wininit|winlogon)') { return $false }
            $current = $parentId
        }
    }
    catch { }
    return $false   # unknown ancestry -> assume interactive (never hide a real session)
}

function Ensure-NativeWindowType {
    if ("AgentFocus.NativeWindow" -as [type]) {
        return
    }

    Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentFocus {
    public static class NativeWindow {
        public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        public static string GetTitle(IntPtr hWnd) {
            var builder = new StringBuilder(512);
            GetWindowText(hWnd, builder, builder.Capacity);
            return builder.ToString();
        }

        // ALL visible top-level windows of a process. Windows Terminal hosts
        // every window in ONE process, so Process.MainWindowHandle misses all
        // but one of them - sessions in a second WT window were invisible.
        public static System.Collections.Generic.List<long> TopLevelForProcess(uint pid) {
            var list = new System.Collections.Generic.List<long>();
            EnumWindows(delegate(IntPtr h, IntPtr l) {
                uint wpid;
                GetWindowThreadProcessId(h, out wpid);
                if (wpid == pid && IsWindowVisible(h)) { list.Add(h.ToInt64()); }
                return true;
            }, IntPtr.Zero);
            return list;
        }
    }
}
"@
}

function Ensure-UiAutomationTypes {
    try {
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
        return $true
    }
    catch {
        return $false
    }
}

function Get-SelectedTerminalTab {
    param([IntPtr]$Hwnd)

    if (-not (Ensure-UiAutomationTypes)) {
        return $null
    }

    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
        if ($null -eq $root) {
            return $null
        }

        $condition = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::TabItem
        )
        $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)

        for ($i = 0; $i -lt $tabs.Count; $i++) {
            $tab = $tabs.Item($i)
            $selected = $false
            try {
                $pattern = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                $selected = $pattern.Current.IsSelected
            }
            catch {
                $selected = $false
            }

            if ($selected) {
                $runtimeId = ""
                try {
                    $runtimeId = ($tab.GetRuntimeId() -join ".")
                }
                catch {
                    $runtimeId = ""
                }

                return [pscustomobject]@{
                    name = $tab.Current.Name
                    index = $i
                    runtime_id = $runtimeId
                }
            }
        }
    }
    catch {
        return $null
    }

    return $null
}

function Get-ForegroundWindowHint {
    param([string]$EventName)

    try {
        Ensure-NativeWindowType
        $hwnd = [AgentFocus.NativeWindow]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) {
            return $null
        }

        [uint32]$processId = 0
        [void][AgentFocus.NativeWindow]::GetWindowThreadProcessId($hwnd, [ref]$processId)
        $title = [AgentFocus.NativeWindow]::GetTitle($hwnd)
        $processName = ""

        if ($processId -gt 0) {
            try {
                $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
            }
            catch {
                $processName = ""
            }
        }

        $hint = [ordered]@{
            hwnd = $hwnd.ToInt64()
            process_id = [int]$processId
            process_name = $processName
            title = $title
            parent_title = ""
            tab_name = ""
            tab_index = -1
            tab_runtime_id = ""
            captured_event = $EventName
        }

        if ($processName -eq "WindowsTerminal") {
            $tab = Get-SelectedTerminalTab -Hwnd $hwnd
            if ($null -ne $tab) {
                $hint.parent_title = $title
                $hint.tab_name = [string]$tab.name
                $hint.tab_index = [int]$tab.index
                $hint.tab_runtime_id = [string]$tab.runtime_id
            }
        }

        [pscustomobject]$hint
    }
    catch {
        $null
    }
}

function Get-NormalizedTitle {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    # strip leading status glyphs / spinner chars so animated titles still match
    return (($Value -replace '^[^\p{L}\p{Nd}]+', '').Trim().ToLowerInvariant())
}

function Find-TerminalTabByName {
    # Scans every Windows Terminal window for a tab whose (normalized) title
    # matches. Returns hint + uniqueness flag, or $null.
    param([string]$Name)

    $want = Get-NormalizedTitle $Name
    if ($want.Length -eq 0) { return $null }

    $found = $null
    $count = 0
    $handles = New-Object System.Collections.ArrayList
    foreach ($wt in @(Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue)) {
        $added = $false
        try {
            Ensure-NativeWindowType
            foreach ($hl in [AgentFocus.NativeWindow]::TopLevelForProcess([uint32]$wt.Id)) {
                [void]$handles.Add([IntPtr][long]$hl)
                $added = $true
            }
        }
        catch { }
        if (-not $added -and $wt.MainWindowHandle -ne [IntPtr]::Zero) { [void]$handles.Add($wt.MainWindowHandle) }
    }
    foreach ($hwnd in $handles) {
        if ($hwnd -eq [IntPtr]::Zero) { continue }
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
            if ($null -eq $root) { continue }
            $cond = [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                [System.Windows.Automation.ControlType]::TabItem
            )
            $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
            for ($i = 0; $i -lt $tabs.Count; $i++) {
                $tab = $tabs.Item($i)
                if ((Get-NormalizedTitle ([string]$tab.Current.Name)) -ne $want) { continue }
                $count++
                if ($null -eq $found) {
                    $rid = ""
                    try { $rid = ($tab.GetRuntimeId() -join ".") } catch { }
                    [uint32]$wtPid = 0
                    [void][AgentFocus.NativeWindow]::GetWindowThreadProcessId($hwnd, [ref]$wtPid)
                    $found = [pscustomobject]@{
                        hwnd = $hwnd.ToInt64()
                        process_id = [int]$wtPid
                        window_title = [AgentFocus.NativeWindow]::GetTitle($hwnd)
                        tab_name = [string]$tab.Current.Name
                        tab_index = $i
                        tab_runtime_id = $rid
                    }
                }
            }
        }
        catch { }
    }

    if ($null -eq $found) { return $null }
    $found | Add-Member -NotePropertyName unique -NotePropertyValue ($count -eq 1) -PassThru
}

function Write-HookDebug {
    param([string]$Line)
    if (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA "AgentFocus\debug.on"))) { return }
    try {
        "$(Get-Date -Format o) pid=$PID $Line" |
            Add-Content -LiteralPath (Join-Path $env:LOCALAPPDATA "AgentFocus\hook-debug.log") -ErrorAction SilentlyContinue
    }
    catch { }
}

$script:ConsoleApiSource = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace AgentFocus {
    public static class ConsoleApi {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AttachConsole(uint dwProcessId);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool FreeConsole();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint GetConsoleTitle(StringBuilder lpConsoleTitle, uint nSize);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool SetConsoleTitle(string lpConsoleTitle);

        public static string ReadTitleFrom(uint pid) {
            FreeConsole();
            if (!AttachConsole(pid)) { return null; }
            try {
                var sb = new StringBuilder(2048);
                uint n = GetConsoleTitle(sb, 2048);
                return n > 0 ? sb.ToString() : "";
            } finally { FreeConsole(); }
        }
    }
}
"@

function Ensure-ConsoleApiType {
    if ("AgentFocus.ConsoleApi" -as [type]) { return $true }
    $dll = Join-Path $env:LOCALAPPDATA "AgentFocus\AgentFocusNative.dll"
    if (Test-Path -LiteralPath $dll) {
        try { Add-Type -Path $dll -ErrorAction Stop; return $true } catch { }
    }
    try { Add-Type -TypeDefinition $script:ConsoleApiSource -ErrorAction Stop; return $true } catch { return $false }
}

function Get-AgentConsoleTitle {
    # Hook processes get their own hidden console (spawned via bash.exe), so
    # the session's REAL tab title lives on the agent process's console.
    # Attach to it, read the title, detach. Stdio is piped, so this is safe.
    param([int]$AgentPid)

    if ($AgentPid -le 0) { return $null }
    if (-not (Ensure-ConsoleApiType)) { return $null }
    try { return [AgentFocus.ConsoleApi]::ReadTitleFrom([uint32]$AgentPid) } catch { return $null }
}

function Get-ConsoleTabHint {
    # Deterministic tab capture: attach to the agent process's console (that
    # console's title IS the session's tab title), find the matching tab via
    # UI Automation. If the title is not unique across tabs, briefly stamp a
    # unique marker title and find that instead, then restore the title.
    param([string]$SessionId, [string]$EventName, [int]$AgentPid, [string]$CwdName)

    if ($AgentPid -le 0) { return $null }
    if (-not (Ensure-ConsoleApiType)) { return $null }
    if (-not (Ensure-UiAutomationTypes)) { return $null }

    [void][AgentFocus.ConsoleApi]::FreeConsole()
    if (-not [AgentFocus.ConsoleApi]::AttachConsole([uint32]$AgentPid)) {
        Write-HookDebug "ev=$EventName attach($AgentPid) FAILED err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        return $null
    }
    try {
        $sb = New-Object System.Text.StringBuilder(2048)
        [void][AgentFocus.ConsoleApi]::GetConsoleTitle($sb, 2048)
        $prevTitle = $sb.ToString()
        Write-HookDebug "ev=$EventName attached($AgentPid) title=[$prevTitle]"

        # marker first: IF the tab shows it, that is true ownership proof
        # (only our console can display it). In practice ConPTY does not
        # propagate externally-set titles to WT tabs (verified live), so this
        # usually fails fast and the hardened passes below do the real work -
        # kept because it is cheap and correct where it does fire.
        $match = $null
        $capTag = "console"
        $suffix = $SessionId
        if ($suffix.Length -gt 8) { $suffix = $suffix.Substring(0, 8) }
        $marker = "cc-mark-$suffix-$PID"
        try {
            [void][AgentFocus.ConsoleApi]::SetConsoleTitle($marker)
            for ($attempt = 0; $attempt -lt 4; $attempt++) {
                Start-Sleep -Milliseconds 150
                $match = Find-TerminalTabByName -Name $marker
                if ($null -ne $match) { break }
            }
        }
        catch { $match = $null }
        finally {
            try { [void][AgentFocus.ConsoleApi]::SetConsoleTitle($prevTitle) } catch { }
        }

        if ($null -eq $match -and -not [string]::IsNullOrWhiteSpace($prevTitle)) {
            # TWIN-PROOF title matching. A title is a VALUE, not ownership:
            # batch-restarted sessions briefly show identical titles, and
            # plain title matching once cross-captured two sessions (both
            # status files stored the SAME tab id - clicking session A focused
            # session B). Only match when no OTHER live session's console
            # shows this title right now.
            $candidate = Find-TerminalTabByName -Name $prevTitle
            if ($null -ne $candidate -and $candidate.unique) {
                $normTitle = Get-NormalizedTitle $prevTitle
                $clash = $false
                try {
                    $statusDir = Join-Path $env:LOCALAPPDATA "AgentFocus\status"
                    foreach ($f in @(Get-ChildItem -LiteralPath $statusDir -Filter '*.json' -ErrorAction SilentlyContinue)) {
                        if ($f.LastWriteTime -lt (Get-Date).AddDays(-2)) { continue }
                        $other = $null
                        try { $other = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch { continue }
                        if ($null -eq $other -or $null -eq $other.PSObject.Properties['agent_pid']) { continue }
                        $otherPid = [int]$other.agent_pid
                        if ($otherPid -le 0 -or $otherPid -eq $AgentPid) { continue }
                        if ([string]$other.status -eq 'ended') { continue }
                        if ($null -eq (Get-Process -Id $otherPid -ErrorAction SilentlyContinue)) { continue }
                        $otherTitle = Get-AgentConsoleTitle -AgentPid $otherPid
                        if (-not [string]::IsNullOrWhiteSpace($otherTitle) -and
                            (Get-NormalizedTitle $otherTitle) -eq $normTitle) { $clash = $true; break }
                    }
                }
                catch { $clash = $true }   # cannot verify -> do not trust
                if ($clash) {
                    Write-HookDebug "ev=$EventName title match REFUSED (twin clash on [$prevTitle])"
                }
                else { $match = $candidate }
            }
        }

        if ($null -eq $match -and -not [string]::IsNullOrWhiteSpace($CwdName)) {
            # manually-RENAMED tabs never show the marker: WT pins the custom
            # name and ignores console-title changes. People typically rename
            # the tab to the project name -> match against the cwd folder name.
            $candidate = Find-TerminalTabByName -Name $CwdName
            if ($null -ne $candidate -and $candidate.unique) {
                Write-HookDebug "ev=$EventName marker blocked (renamed tab?) -> cwd-name matched [$($candidate.tab_name)]"
                $match = $candidate
                $capTag = "cwdname"
            }
        }

        if ($null -eq $match) {
            # attach worked but no tab shows the marker: either a TRUE headless
            # subagent (hidden console) or an interactive session in a tab
            # renamed to something we can't correlate. Only flag headless when
            # the process ancestry says subagent - hiding real sessions is the
            # worst possible failure mode.
            $isSub = Test-IsSubagent -AgentPid $AgentPid
            Write-HookDebug "ev=$EventName marker not found -> subagent=$isSub"
            return [pscustomobject]@{ headless = $isSub }
        }

        $tabTitle = $prevTitle
        if ($null -ne $match.PSObject.Properties['tab_name'] -and
            -not [string]::IsNullOrWhiteSpace([string]$match.tab_name)) {
            $tabTitle = [string]$match.tab_name
        }

        return [pscustomobject]@{
            hwnd = $match.hwnd
            process_id = $match.process_id
            process_name = "WindowsTerminal"
            title = $match.window_title
            parent_title = $match.window_title
            tab_name = $tabTitle
            tab_index = $match.tab_index
            tab_runtime_id = $match.tab_runtime_id
            captured_event = "$EventName+$capTag"
        }
    }
    finally {
        [void][AgentFocus.ConsoleApi]::FreeConsole()
    }
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        Write-HookSuccess
    }

    $inputObject = $raw | ConvertFrom-Json
    $eventName = [string]$inputObject.hook_event_name
    $sessionId = [string]$inputObject.session_id
    $turnId = [string]$inputObject.turn_id
    $cwd = [string]$inputObject.cwd
    $transcriptPath = [string]$inputObject.transcript_path
    $model = [string]$inputObject.model
    $lastAssistantMessage = [string]$inputObject.last_assistant_message
    $prompt = [string]$inputObject.prompt
    $notification = [string]$inputObject.message

    $status = switch ($eventName) {
        "PreToolUse" { "working"; break }
        "PostToolUse" { "working"; break }
        "UserPromptSubmit" { "working"; break }
        "Stop" { "idle"; break }
        "StopFailure" { "error"; break }
        "SessionStart" { "idle"; break }
        "Notification" { "attention"; break }
        "SessionEnd" { "ended"; break }
        default { "unknown" }
    }

    if ($status -eq "unknown") {
        Write-HookSuccess
    }

    if ([string]::IsNullOrWhiteSpace($StatusDirectory)) {
        $StatusDirectory = Join-Path $env:LOCALAPPDATA "AgentFocus\status"
    }

    New-Item -ItemType Directory -Force -Path $StatusDirectory | Out-Null

    $stableId = Get-StableId -ProviderName $Provider -SessionId $sessionId -Cwd $cwd -TranscriptPath $transcriptPath
    $safeFile = "$(Get-SafeFileName $Provider)-$(Get-SafeFileName $stableId).json"
    $statusPath = Join-Path $StatusDirectory $safeFile

    # serialize read-modify-write per session: concurrent hook processes
    # (parallel tool calls) were clobbering each other's freshly written hints
    $mutex = $null
    try {
        $mutex = New-Object System.Threading.Mutex($false, ("Local\AgentFocus-" + (Get-SafeFileName "$Provider-$stableId")))
        if (-not $mutex.WaitOne(8000)) {
            try { $mutex.Dispose() } catch { }
            $mutex = $null
        }
    }
    catch { $mutex = $null }

    try {

    $existing = $null
    if (Test-Path -LiteralPath $statusPath) {
        try {
            $existing = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
        }
        catch {
            $existing = $null
        }
    }

    # -- agent pid first: console capture needs it to attach --
    $agentPid = 0
    if ($null -ne $existing -and $null -ne $existing.PSObject.Properties['agent_pid']) {
        $agentPid = [int]$existing.agent_pid
    }
    $needPid = ($agentPid -le 0 -or $eventName -eq "SessionStart")
    if (-not $needPid -and $agentPid -gt 0) {
        # self-heal: recorded agent process died (session resumed, or claude
        # restarted itself in place e.g. after an auto-update)
        if ($null -eq (Get-Process -Id $agentPid -ErrorAction SilentlyContinue)) { $needPid = $true }
    }
    if ($needPid) {
        $capturedPid = Get-AgentAncestorPid
        if ($capturedPid -gt 0) {
            $agentPid = $capturedPid
        }
    }

    $window = $existing.window
    $headless = $false
    if ($null -ne $existing -and $null -ne $existing.PSObject.Properties['headless']) {
        $headless = [bool]$existing.headless
    }
    # capture is expensive (UIA scan), so only do it when the session has no
    # deterministic console-captured hint yet, or on SessionStart (new tab).
    # Known-headless sessions only recheck on SessionStart/UserPromptSubmit
    # (real interactive sessions get prompts; subagents never do).
    $hasConsoleHint = $false
    if ($null -ne $window -and
        -not [string]::IsNullOrWhiteSpace([string]$window.tab_runtime_id) -and
        ([string]$window.captured_event) -like "*+console") {
        $hasConsoleHint = $true
    }
    # UserPromptSubmit recaptures even when a hint EXISTS: a wrong hint (twin
    # cross-capture) would otherwise survive until the session restarts, and
    # the prompt moment is cheap, human-paced ground truth
    $needCapture = ($eventName -eq "SessionStart") -or
                   ($eventName -eq "UserPromptSubmit") -or
                   ($eventName -ne "SessionEnd" -and -not $hasConsoleHint -and -not $headless)
    if ($needCapture) {
        # NOTE: no foreground-window fallback here on purpose. Guessing from
        # the foreground window wrote wrong-tab (even wrong-app) hints when the
        # user tab-hopped. Console capture is deterministic or nothing.
        $cwdLeaf = ""
        if ($null -ne $existing -and -not [string]::IsNullOrWhiteSpace([string]$existing.cwd_name)) {
            $cwdLeaf = [string]$existing.cwd_name
        }
        elseif (-not [string]::IsNullOrWhiteSpace($cwd)) {
            try { $cwdLeaf = Split-Path -Path $cwd -Leaf } catch { }
        }
        $captured = Get-ConsoleTabHint -SessionId $stableId -EventName $eventName -AgentPid $agentPid -CwdName $cwdLeaf
        if ($null -ne $captured) {
            if ($null -ne $captured.PSObject.Properties['tab_runtime_id']) {
                $window = $captured
                $headless = $false
            }
            else {
                # no tab found: headless only if the ancestry says subagent -
                # interactive sessions in unrecognizably-renamed tabs stay
                # visible (window-less) rather than vanishing from viewers
                $headless = [bool]$captured.headless
                $window = $null
            }
        }
        # $null = attach failed entirely -> keep whatever we had
    }
    elseif ($null -ne $window -and $eventName -ne "SessionEnd" -and
            ([string]$window.captured_event) -like "*+console") {
        # keep tab_name fresh: the agent console's title IS the live tab title.
        # Viewers use it to re-match the tab even if the runtime id went stale.
        # (only for title-following tabs: a cwdname-captured tab is RENAMED, its
        # console title never matches the tab, refreshing would break matching)
        $liveTitle = Get-AgentConsoleTitle -AgentPid $agentPid
        if (-not [string]::IsNullOrWhiteSpace($liveTitle)) {
            $window | Add-Member -NotePropertyName tab_name -NotePropertyValue $liveTitle -Force
        }
    }

    # pin the session's identity to its ORIGINAL folder: agents cd around
    # (docs/webapp/pages...) and a changing name makes rows jump in viewers
    $cwdName = ""
    if ($null -ne $existing -and -not [string]::IsNullOrWhiteSpace([string]$existing.cwd_name)) {
        $cwdName = [string]$existing.cwd_name
        if (-not [string]::IsNullOrWhiteSpace([string]$existing.cwd)) { $cwd = [string]$existing.cwd }
    }
    elseif (-not [string]::IsNullOrWhiteSpace($cwd)) {
        $cwdName = Split-Path -Path $cwd -Leaf
    }

    $message = ""
    if ($eventName -eq "Notification" -and -not [string]::IsNullOrWhiteSpace($notification)) {
        $message = $notification.Trim()
    }
    elseif (-not [string]::IsNullOrWhiteSpace($lastAssistantMessage)) {
        $message = $lastAssistantMessage.Trim()
    }
    elseif (-not [string]::IsNullOrWhiteSpace($prompt)) {
        $message = "Prompt: " + $prompt.Trim()
    }
    elseif ($null -ne $existing -and -not [string]::IsNullOrWhiteSpace([string]$existing.message)) {
        $message = [string]$existing.message
    }

    $record = [ordered]@{
        schema = 1
        provider = $Provider.ToLowerInvariant()
        status = $status
        session_id = $stableId
        turn_id = $turnId
        cwd = $cwd
        cwd_name = $cwdName
        model = $model
        message = $message
        agent_pid = $agentPid
        headless = $headless
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        window = $window
    }

    $tempPath = "$statusPath.$PID.tmp"
    $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tempPath -Encoding UTF8
    Move-Item -LiteralPath $tempPath -Destination $statusPath -Force

    }
    finally {
        if ($null -ne $mutex) {
            try { $mutex.ReleaseMutex() } catch { }
            try { $mutex.Dispose() } catch { }
        }
    }
}
catch {
    # Hooks must never block the agent loop.
}

Write-HookSuccess
