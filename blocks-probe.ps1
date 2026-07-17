# Perch blocks probe - LOCAL 5h-window usage math, ccusage-style, ZERO api.
# Runs as a fire-and-forget background child (BelowNormal priority): scans
# ~/.claude/projects/**/*.jsonl transcripts, extracts per-message token usage,
# and buckets it PER UTC HOUR. Windows are then assembled from the buckets:
# the current window snaps to the OFFICIAL reset time when perch has seen one
# (reset-anchor.txt - the server's window does NOT floor to the hour, and on
# continuous usage a floored chain drifts up to an hour off), else it chains
# ccusage-style from first activity. Output feeds the HUD's limit bars when
# both official sources (statusline capture, oauth endpoint) go silent.
#
# INCREMENTAL: transcripts are append-only, so per-file byte offsets are
# remembered and only appended bytes are read after the first pass. Token
# extraction is REGEX, not per-line json parsing - the difference between
# seconds and minutes over a week of heavy transcripts.
#
# SANITIZED output: token counts and timestamps only. No conversation
# content ever leaves the transcripts.
$ErrorActionPreference = 'SilentlyContinue'
$af = Join-Path $env:LOCALAPPDATA 'AgentFocus'
$statePath = Join-Path $af 'blocks-state.json'
$outPath = Join-Path $af 'blocks.json'

# single instance: overlapping scans would double-count appended bytes
$mx = New-Object System.Threading.Mutex($false, 'Local\AgentFocusBlocksProbe')
if (-not $mx.WaitOne(0)) { exit 0 }
try {
    $files = @{}    # transcript path -> @{ off; lwt }
    $hours = @{}    # UTC hour ISO -> total tokens
    try {
        $st = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($null -ne $st.PSObject.Properties['hours']) {
            foreach ($p in $st.files.PSObject.Properties) {
                $files[$p.Name] = @{ off = [long]$p.Value.off; lwt = [string]$p.Value.lwt }
            }
            foreach ($p in $st.hours.PSObject.Properties) { $hours[$p.Name] = [long]$p.Value }
        }
        # no 'hours' = older state format: leave $files empty -> full rescan
    }
    catch { }

    $nowU = [datetime]::UtcNow
    $cut = $nowU.AddDays(-8)
    $tsRx = [regex]'"timestamp":"([^"]+)"'
    $tokRx = @([regex]'"input_tokens":(\d+)', [regex]'"output_tokens":(\d+)',
               [regex]'"cache_creation_input_tokens":(\d+)', [regex]'"cache_read_input_tokens":(\d+)')

    $root = Join-Path $env:USERPROFILE '.claude\projects'
    $seen = @{}
    foreach ($f in @(Get-ChildItem -LiteralPath $root -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)) {
        if ($f.LastWriteTimeUtc -lt $cut) { continue }
        $key = $f.FullName
        $seen[$key] = $true
        $known = $files[$key]
        $off = 0L
        if ($null -ne $known) {
            if ([string]$known.lwt -eq $f.LastWriteTimeUtc.ToString('o') -and [long]$known.off -ge $f.Length) { continue }
            $off = [long]$known.off
        }
        $buf = $null
        try {
            $fs = [IO.File]::Open($key, 'Open', 'Read', 'ReadWrite')
            try {
                if ($off -gt $fs.Length) { $off = 0 }   # rewritten file: rescan
                $len = $fs.Length - $off
                if ($len -le 0) {
                    $files[$key] = @{ off = $fs.Length; lwt = $f.LastWriteTimeUtc.ToString('o') }
                    continue
                }
                [void]$fs.Seek($off, [IO.SeekOrigin]::Begin)
                $buf = New-Object byte[] $len
                [void]$fs.Read($buf, 0, $len)
            }
            finally { $fs.Close() }
        }
        catch { continue }
        # stop at the last complete line; a partial line mid-append stays
        # unconsumed for the next scan (offsets must never split a line)
        $lastNl = [Array]::LastIndexOf($buf, [byte]10)
        if ($lastNl -lt 0) { continue }
        $text = [Text.Encoding]::UTF8.GetString($buf, 0, $lastNl + 1)
        $files[$key] = @{ off = $off + $lastNl + 1; lwt = $f.LastWriteTimeUtc.ToString('o') }

        foreach ($ln in ($text -split "`n")) {
            # cheap gates first: only assistant messages carry usage
            if ($ln.IndexOf('"usage"') -lt 0 -or $ln.IndexOf('"input_tokens"') -lt 0) { continue }
            if ($ln.IndexOf('"type":"assistant"') -lt 0) { continue }
            $tm = $tsRx.Match($ln)
            if (-not $tm.Success) { continue }
            $ts = $null
            try { $ts = ([datetime]::Parse($tm.Groups[1].Value, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)).ToUniversalTime() }
            catch { continue }
            if ($ts -lt $cut) { continue }
            [long]$tok = 0
            foreach ($rx in $tokRx) { $m = $rx.Match($ln); if ($m.Success) { $tok += [long]$m.Groups[1].Value } }
            if ($tok -le 0) { continue }
            $hk = (New-Object datetime($ts.Year, $ts.Month, $ts.Day, $ts.Hour, 0, 0, [DateTimeKind]::Utc)).ToString('o')
            if ($hours.ContainsKey($hk)) { $hours[$hk] = [long]$hours[$hk] + $tok }
            else { $hours[$hk] = $tok }
        }
    }

    # prune: hours past the horizon, file entries for vanished transcripts
    foreach ($k in @($hours.Keys)) {
        try {
            $ht = ([datetime]::Parse($k, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)).ToUniversalTime()
            if ($ht -lt $cut) { [void]$hours.Remove($k) }
        }
        catch { [void]$hours.Remove($k) }
    }
    foreach ($k in @($files.Keys)) { if (-not $seen.ContainsKey($k)) { [void]$files.Remove($k) } }

    # ordered non-empty hours -> windows
    $hlist = New-Object System.Collections.ArrayList
    foreach ($k in $hours.Keys) {
        try {
            $ht = ([datetime]::Parse($k, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)).ToUniversalTime()
            [void]$hlist.Add(@{ T = $ht; Tok = [long]$hours[$k] })
        }
        catch { }
    }
    $hlist = @($hlist | Sort-Object { $_.T })

    function Get-RangeTokens([datetime]$From, [datetime]$To) {
        [long]$s = 0
        foreach ($h in $script:hlist) { if ($h.T -ge $From -and $h.T -lt $To) { $s += [long]$h.Tok } }
        return $s
    }
    $script:hlist = $hlist

    # the ANCHOR: perch drops the official 5h reset time here whenever the
    # statusline/endpoint show one. Server windows don't floor to the hour,
    # so anchoring is what makes the local countdown match reality.
    $anchor = $null
    try {
        $a = ([datetime]::Parse((Get-Content -LiteralPath (Join-Path $af 'reset-anchor.txt') -Raw).Trim(),
              $null, [System.Globalization.DateTimeStyles]::RoundtripKind)).ToUniversalTime()
        if ($a -gt $nowU.AddHours(-10) -and $a -lt $nowU.AddHours(6)) { $anchor = $a }
    }
    catch { }

    $curStart = $null; $curEnd = $null
    if ($null -ne $anchor -and $nowU -lt $anchor) {
        # inside the officially-known window: its boundaries ARE the truth
        $curStart = $anchor.AddHours(-5); $curEnd = $anchor
    }
    else {
        # chain forward ccusage-style: a window opens at the first activity
        # after the previous one closed (from the anchor if known, else from
        # the oldest bucket)
        $pos = $(if ($null -ne $anchor) { $anchor } else { [datetime]::MinValue })
        foreach ($h in $hlist) {
            if ($h.T -lt $pos -or $h.T -gt $nowU) { continue }
            $s = $h.T; $e = $s.AddHours(5)
            if ($nowU -ge $s -and $nowU -lt $e) { $curStart = $s; $curEnd = $e; break }
            $pos = $e
        }
    }
    $curTok = [long]0
    if ($null -ne $curStart) {
        # bucket at floor(start) may include the previous window's tail -
        # overcounting is the SAFE direction for a usage estimate
        $floorStart = New-Object datetime($curStart.Year, $curStart.Month, $curStart.Day, $curStart.Hour, 0, 0, [DateTimeKind]::Utc)
        $curTok = Get-RangeTokens $floorStart $curEnd
    }

    # P90 of past windows = learned "how much a full window usually holds"
    # (used only when no official calibration pairs exist)
    $histSums = New-Object System.Collections.ArrayList
    $pos = [datetime]::MinValue
    foreach ($h in $hlist) {
        if ($h.T -lt $pos) { continue }
        $s = $h.T; $e = $s.AddHours(5)
        $pos = $e
        if ($null -ne $curStart -and $s -lt $curEnd -and $e -gt $curStart) { continue }   # overlaps current
        [void]$histSums.Add((Get-RangeTokens $s $e))
    }
    $p90 = [long]0
    $hs = @($histSums | Sort-Object)
    if ($hs.Count -ge 5) { $p90 = [long]$hs[[int][Math]::Ceiling($hs.Count * 0.9) - 1] }

    [ordered]@{
        updated_at = $nowU.ToString('o')
        block = $(if ($null -ne $curStart) {
            [ordered]@{ start = $curStart.ToString('o'); end = $curEnd.ToString('o'); tokens = $curTok }
        } else { $null })
        history_count = $hs.Count
        p90 = $p90
        anchored = ($null -ne $anchor -and $nowU -lt $anchor)
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $outPath -Encoding UTF8

    [ordered]@{ files = $files; hours = $hours } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
}
finally {
    try { $mx.ReleaseMutex() } catch { }
    try { $mx.Dispose() } catch { }
}
exit 0
