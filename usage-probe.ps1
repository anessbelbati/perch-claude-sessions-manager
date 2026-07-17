# Perch usage probe - runs as a fire-and-forget child so the HUD's UI thread
# never waits on the network. Fetches the account's limit utilization from the
# same endpoint the CLI's /usage screen uses and writes a SANITIZED snapshot
# (percentages + reset times only - the token never leaves this process).
#
# Token choice mirrors the account switcher: the ACTIVE saved account if one
# is configured, else whatever ~/.claude/.credentials.json is logged into.
$out = Join-Path $env:LOCALAPPDATA 'AgentFocus\usage.json'
try {
    $tok = $null
    $acctFile = Join-Path $env:LOCALAPPDATA 'AgentFocus\accounts.json'
    if (Test-Path -LiteralPath $acctFile) {
        $aj = Get-Content -LiteralPath $acctFile -Raw | ConvertFrom-Json
        $act = @($aj.accounts) | Where-Object { $_.id -eq $aj.active } | Select-Object -First 1
        if ($null -ne $act -and $act.token) {
            Add-Type -AssemblyName System.Security
            $tok = [System.Text.Encoding]::UTF8.GetString(
                [System.Security.Cryptography.ProtectedData]::Unprotect(
                    [Convert]::FromBase64String([string]$act.token), $null,
                    [System.Security.Cryptography.DataProtectionScope]::CurrentUser))
        }
    }
    if (-not $tok) {
        $cred = Get-Content -LiteralPath "$env:USERPROFILE\.claude\.credentials.json" -Raw | ConvertFrom-Json
        $tok = [string]$cred.claudeAiOauth.accessToken
    }
    if (-not $tok) { throw 'no token available' }

    # respect an active rate-limit cooldown: hitting a throttled endpoint
    # again is how you stay throttled
    $cool = Join-Path $env:LOCALAPPDATA 'AgentFocus\usage-cooldown.txt'
    if (Test-Path -LiteralPath $cool) {
        try {
            $until = [datetime]::Parse((Get-Content -LiteralPath $cool -Raw).Trim(), $null,
                     [System.Globalization.DateTimeStyles]::RoundtripKind)
            if ([datetime]::UtcNow -lt $until.ToUniversalTime()) { exit 0 }
        }
        catch { }
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    # identify as the CLI (CodexBar's trick): same UA the real client sends,
    # so we get the rate-limit treatment the CLI gets
    $ua = 'claude-code/2.1.212'
    try {
        $exe = Get-Command claude.exe -ErrorAction SilentlyContinue
        if ($null -ne $exe) {
            $v = [string](& $exe.Source --version 2>$null)
            if ($v -match '(\d+\.\d+\.\d+)') { $ua = "claude-code/$($Matches[1])" }
        }
    }
    catch { }
    # ONE attempt, no retry: a failed request costs nothing to wait out, and
    # retrying into a 429 digs the hole deeper
    try {
        $r = Invoke-RestMethod 'https://api.anthropic.com/api/oauth/usage' -TimeoutSec 20 -Headers @{
            Authorization    = "Bearer $tok"
            'anthropic-beta' = 'oauth-2025-04-20'
            'User-Agent'     = $ua
        }
    }
    catch {
        $resp = $_.Exception.Response
        if ($null -ne $resp -and [int]$resp.StatusCode -eq 429) {
            # back WAY off: Retry-After if the server names a number, else 30min
            $mins = 30
            try {
                $ra = [int]$resp.Headers['Retry-After']
                if ($ra -gt 0) { $mins = [Math]::Max([Math]::Ceiling($ra / 60.0), 5) }
            }
            catch { }
            ([datetime]::UtcNow.AddMinutes($mins)).ToString('o') | Set-Content -LiteralPath $cool -Encoding UTF8
        }
        exit 0   # keep the old snapshot; the HUD shows its age honestly
    }
    Remove-Item -LiteralPath $cool -Force -Confirm:$false -ErrorAction SilentlyContinue

    $limits = @()
    foreach ($l in @($r.limits)) {
        if ($null -eq $l) { continue }
        $label = switch ([string]$l.kind) {
            'session'       { '5h window' }
            'weekly_all'    { 'week' }
            'weekly_scoped' {
                $m = ''
                try { $m = [string]$l.scope.model.display_name } catch { }
                if ($m.Length -gt 0) { 'week ' + [string][char]0x00B7 + ' ' + $m.ToLowerInvariant() } else { 'week (model)' }
            }
            default         { ([string]$l.kind) -replace '_', ' ' }
        }
        $limits += [pscustomobject]@{
            label     = $label
            percent   = [double]$l.percent
            severity  = [string]$l.severity
            resets_at = [string]$l.resets_at
        }
    }

    [pscustomobject]@{
        fetched_at = (Get-Date).ToUniversalTime().ToString('o')
        limits     = $limits
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $out -Encoding UTF8
}
catch {
    # network down / token expired: leave the previous snapshot alone -
    # the HUD hides anything older than 15 minutes on its own
}
