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

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $r = $null
    foreach ($timeout in @(20, 30)) {   # one retry - flaky wifi is a way of life
        try {
            $r = Invoke-RestMethod 'https://api.anthropic.com/api/oauth/usage' -TimeoutSec $timeout -Headers @{
                Authorization    = "Bearer $tok"
                'anthropic-beta' = 'oauth-2025-04-20'
            }
            break
        }
        catch { if ($timeout -eq 30) { throw } }
    }

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
