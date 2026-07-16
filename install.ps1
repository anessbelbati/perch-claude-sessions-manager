<#
    Perch installer.

    - Deploys the status hook to %LOCALAPPDATA%\AgentFocus\hooks\
    - Compiles the AgentFocusNative.dll console helper
    - Writes default AgentFocus settings (if none exist)
    - Non-destructively merges the hook into ~/.claude/settings.json
      (a backup is written next to it first)
    - Generates icon.ico from logo.png
    - Optionally creates Desktop / Startup shortcuts

    Usage:
      powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
      powershell ... -File install.ps1 -DesktopShortcut -StartupShortcut
#>
param(
    [switch]$DesktopShortcut,
    [switch]$StartupShortcut
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$af = Join-Path $env:LOCALAPPDATA 'AgentFocus'

Write-Host "Perch installer" -ForegroundColor Cyan
Write-Host "  repo: $repo"
Write-Host "  data: $af"

# 1. directories + hook script
New-Item -ItemType Directory -Force -Path (Join-Path $af 'hooks') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $af 'status') | Out-Null
Copy-Item (Join-Path $repo 'hooks\agent-focus-status.ps1') (Join-Path $af 'hooks\agent-focus-status.ps1') -Force
Write-Host "  [ok] hook deployed"

# 2. native console helper (AttachConsole etc.)
$dll = Join-Path $af 'AgentFocusNative.dll'
if (-not (Test-Path -LiteralPath $dll)) {
    $src = @'
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
'@
    Add-Type -TypeDefinition $src -OutputAssembly $dll
    Write-Host "  [ok] AgentFocusNative.dll compiled"
}
else {
    Write-Host "  [ok] AgentFocusNative.dll already present"
}

# 3. AgentFocus settings
$afCfg = Join-Path $af 'settings.json'
if (-not (Test-Path -LiteralPath $afCfg)) {
    [ordered]@{
        RefreshSeconds    = 2
        HideAfterFocus    = $false
        ChirpOnAttention  = $false
        ShowWorkTimers    = $true
        StatusDirectory   = (Join-Path $af 'status')
        AgentProcessNames = @('claude', 'codex', 'gemini', 'opencode', 'aider')
    } | ConvertTo-Json | Set-Content -LiteralPath $afCfg -Encoding UTF8
    Write-Host "  [ok] default AgentFocus settings written"
}
else {
    Write-Host "  [ok] AgentFocus settings already present (untouched)"
}

# 4. merge hook into Claude Code settings
$cc = Join-Path $env:USERPROFILE '.claude\settings.json'
$hookPath = (Join-Path $af 'hooks\agent-focus-status.ps1') -replace '\\', '/'
$hookCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$hookPath`" -Provider claude"
$events = @('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'Notification', 'SessionEnd')

$settings = $null
if (Test-Path -LiteralPath $cc) {
    Copy-Item $cc "$cc.perch-backup" -Force
    $settings = Get-Content -LiteralPath $cc -Raw | ConvertFrom-Json
    Write-Host "  [ok] backed up settings.json -> settings.json.perch-backup"
}
else {
    New-Item -ItemType Directory -Force -Path (Split-Path $cc) | Out-Null
    $settings = [pscustomobject]@{}
}
if ($null -eq $settings.PSObject.Properties['hooks']) {
    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
}
$added = 0
foreach ($ev in $events) {
    $list = @()
    if ($null -ne $settings.hooks.PSObject.Properties[$ev]) { $list = @($settings.hooks.$ev) }
    $present = $false
    foreach ($grp in $list) {
        foreach ($h in @($grp.hooks)) {
            if ([string]$h.command -like '*agent-focus-status.ps1*') { $present = $true }
        }
    }
    if (-not $present) {
        $list += [pscustomobject]@{
            matcher = ''
            hooks   = @([pscustomobject]@{ type = 'command'; command = $hookCmd; timeout = 15 })
        }
        $settings.hooks | Add-Member -NotePropertyName $ev -NotePropertyValue $list -Force
        $added++
    }
}
if ($added -gt 0) {
    $settings | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $cc -Encoding UTF8
    Write-Host "  [ok] hook registered on $added Claude Code event(s) (new sessions pick it up)"
}
else {
    Write-Host "  [ok] hook already registered on all events"
}

# 5. icon
if (Test-Path (Join-Path $repo 'logo.png')) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'gen-icon.ps1') | Out-Null
    Write-Host "  [ok] icon.ico generated"
}

# 6. shortcuts
$ws = New-Object -ComObject WScript.Shell
function New-PerchShortcut([string]$Where) {
    $lnk = $ws.CreateShortcut((Join-Path $Where 'Perch.lnk'))
    $lnk.TargetPath = Join-Path $repo 'Perch.vbs'
    $lnk.WorkingDirectory = $repo
    $lnk.IconLocation = (Join-Path $repo 'icon.ico') + ',0'
    $lnk.Description = 'Perch - agent session HUD'
    $lnk.Save()
}
if ($DesktopShortcut) {
    New-PerchShortcut ([Environment]::GetFolderPath('Desktop'))
    Write-Host "  [ok] desktop shortcut created"
}
if ($StartupShortcut) {
    New-PerchShortcut ([Environment]::GetFolderPath('Startup'))
    Write-Host "  [ok] startup shortcut created (Perch launches at login)"
}

Write-Host ""
Write-Host "Done. Launch with Perch.vbs - see README.md for Codex + other CLI tools." -ForegroundColor Green
