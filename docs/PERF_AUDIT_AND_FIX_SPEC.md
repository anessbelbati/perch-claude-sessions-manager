# Perch Performance Audit & Fix Spec (2026-07-17)

3-lens adversarial audit (WPF rendering / per-tick hot path / child-process +
hook economics). User-reported symptoms: widget feels slow and non-native;
the watched claude CLIs get slower while Perch runs.

## The failure chain

1. **The window renders in software, all the time.** `AllowsTransparency=True`
   presents every frame via UpdateLayeredWindow (GPU→CPU readback). A
   BlurRadius-18 `DropShadowEffect` wraps the ENTIRE card, so any dirty pixel
   re-runs an 18px Gaussian blur over the whole ~324×550 surface. The
   working/attention dots run `RepeatBehavior=Forever` opacity animations at
   ~60fps with per-dot BlurRadius-8 glow effects — so with any session
   working (i.e. always), the full-card blur + readback runs ~60×/s, forever.
   Everything else in this list gets amplified by this.
2. **The 2s tick redoes work that changed nothing: 280–700ms of every
   2000ms tick.** All ~60 status JSONs are re-read and re-parsed every tick
   (~150–300ms; only ~8 are alive). The UIA tab cache TTL (2s) equals the
   tick interval, so every tick walks the full WT UIA tree again
   (~80–330ms). Up to ~60 `Get-Process -Id` calls per tick. LimitsPanel and
   ChipsPanel clear+rebuild every tick (usage.json re-parsed every 2s for
   data that changes every 3min) — and every rebuild re-triggers (1).
3. **The hook taxes every claude tool call.** PreToolUse AND PostToolUse both
   spawn a full powershell (~0.3–0.6s each) to write the same 'working'
   status — PostToolUse is 100% redundant. Worse: sessions captured via
   `+cwdname` (renamed tabs) or never captured fail the `*+console` hint
   check, so the EXPENSIVE capture path (4×150ms marker poll × full UIA scans
   + twin-clash live-attaching to every other session's console + 16 CIM
   ancestry queries) re-runs on EVERY tool call: **3–8s added per tool call**
   for those sessions. This is the "claude feels slower" smoking gun.
4. **Every console probe compiles C#.** console-probe.ps1 runs
   `Add-Type -TypeDefinition` per spawn → csc.exe + cvtres.exe children,
   ~300–800ms + Defender scans, ~150 compiler processes/hour at steady state.
5. Leaks/backoff: in-flight ProbeJobs are only reaped if the same pid is
   requested again; permanently-unmappable agents are probed every 60s
   forever; `debug.on` left enabled grows hook-debug.log on every capture.

## Phase 1 (same-day, implemented in this pass)

R1  Remove the card-level DropShadowEffect (all themes). Attention pulse
    animates the card BorderBrush instead (rim brush in glass).
R2  Cap dot pulse animations at 12fps (Timeline.DesiredFrameRate); keep the
    small per-dot glows.
R3  LimitsPanel: rebuild only when usage.json LastWriteTime changes or 60s
    passed (countdown refresh); never re-parse unchanged JSON per tick.
R4  ChipsPanel: build the 4 chips once; per tick update text/visibility only.
R5  Status-file cache: path → {LastWriteTime, verdict/object}; unchanged
    files are never re-read, dead files short-circuit permanently.
R6  One Get-Process snapshot per tick (hashtable by Id); all liveness checks
    become dictionary lookups.
R7  UIA tab cache TTL 2s → 6s (click paths already use -Fresh where needed).
R8  Learner backoff: per-pid refresh interval grows with failed attempts
    (60s → up to 10min).
R9  ProbeJobs sweep once per tick: kill >8s stragglers, dispose exited
    orphans, regardless of whether the pid is requested again.
R10 Hook: `+cwdname` counts as a valid capture hint (stops the 3–8s
    per-tool-call recapture for renamed-tab sessions).
R11 Hook: twin-clash check reads other sessions' cached tab_name from their
    status files instead of live-attaching to their consoles.
R12 settings.json: drop the agent-focus PostToolUse wiring (redundant with
    PreToolUse; halves the per-tool-call hook tax).
R13 Move console-probe's P/Invoke class into AgentFocusNative.dll (rebuilt);
    no more csc.exe per probe.
R14 Delete the debug.on flag; trim hook-debug.log.

## Phase 2 (structural, later)

- Background runspace for the whole scan pipeline (UI thread renders only).
- Acrylic drag-lag mitigation: switch accent to plain blur during DragMove.
- Invoke-FocusSession fully async with progress affordance on the row.
- Learner/resolver state machine consolidation (one pid ledger).

## Phase 3 (measurement)

- perf.log: per-tick ms histogram behind a debug flag; hook self-timing
  (start-to-exit ms in the status file) to watch the CLI tax regress.

## Guardrails

- Never trade correctness of tab mapping for speed (ownership rules stay).
- Hook must remain <1s on the common path; capture only on state change.
- Any new cache needs an invalidation story written next to it.
