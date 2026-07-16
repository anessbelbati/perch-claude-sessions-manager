# Adapter: Codex CLI `notify` hook -> AgentFocus status file (shows Codex
# sessions in Perch with a real status instead of just "quiet").
#
# Codex invokes the notify program with ONE argument: a JSON string like
#   {"type":"agent-turn-complete","turn-id":"...","last-assistant-message":"..."}
# We translate that into the stdin JSON contract that
# agent-focus-status.ps1 expects and forward it with -Provider codex.
#
# Setup (in ~/.codex/config.toml):
#   notify = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
#             "-File", "D:\\ACTIVE-PROJECTS\\claudeviewer\\codex-notify-adapter.ps1"]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

$ErrorActionPreference = 'SilentlyContinue'
$raw = ($Rest -join ' ')
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

$n = $null
try { $n = $raw | ConvertFrom-Json } catch { exit 0 }
if ($null -eq $n) { exit 0 }

# codex currently only fires on turn completion -> maps to Stop ("done")
$eventName = 'Stop'
if ([string]$n.type -match 'error') { $eventName = 'StopFailure' }

$sessionId = ''
foreach ($k in @('thread-id', 'conversation-id', 'session-id', 'turn-id')) {
    if ($n.PSObject.Properties[$k] -and $n.$k) { $sessionId = [string]$n.$k; break }
}
if ([string]::IsNullOrWhiteSpace($sessionId)) {
    # stable fallback: one row per working directory
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes((Get-Location).Path)
    $sessionId = -join ($sha.ComputeHash($bytes) | Select-Object -First 8 | ForEach-Object { $_.ToString('x2') })
    $sha.Dispose()
}

$msg = ''
if ($n.PSObject.Properties['last-assistant-message']) { $msg = [string]$n.'last-assistant-message' }

$payload = @{
    hook_event_name        = $eventName
    session_id             = $sessionId
    cwd                    = (Get-Location).Path
    last_assistant_message = $msg
} | ConvertTo-Json -Compress

$payload | powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AgentFocus\hooks\agent-focus-status.ps1" -Provider codex
exit 0
