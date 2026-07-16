<p align="center">
  <img src="logo.png" width="140" alt="Perch">
</p>

<h1 align="center">Perch</h1>

<p align="center">
  A tiny always-on-top widget for Windows that watches all your agent CLI sessions
  (Claude Code, Codex, ...) across Windows Terminal tabs - and lets you jump
  straight to the exact tab with one click.
</p>

---

Running many Claude Code sessions in parallel means constantly alt-tabbing
through terminal tabs to check which one finished, which one is stuck waiting
for permission, and which one is still grinding. Perch puts all of them in one
small card that perches on the corner of your screen:

- 🔴 **needs you** - waiting for permission or input (pulsing, resurfaces the widget)
- 🟠 **working** - mid-task (pulsing)
- 🟢 **done** - finished its turn
- 🔵 **quiet** - live agent process discovered by scan, no events yet

**Click a row → focuses the right Windows Terminal window AND selects the right
tab.** Deterministically - no title guessing.

## Features

- Live status per session via Claude Code hooks (works for every session, even ones started before Perch launches)
- Click-to-focus down to the exact WT tab (UI Automation + console-title identity)
- Right-click: **pin to top**, **rename**, **hide** (persisted per project folder)
- Attention behavior you control: pinned = resurfaces above everything (never steals focus); unpinned = taskbar flash only
- Auto-discovers untracked agent CLIs (`codex`, `gemini`, `opencode`, `aider`, configurable) as clickable rows
- Dead sessions disappear (process liveness), headless subagents/agent-team workers are hidden
- Single instance, remembers position, zero dependencies - one PowerShell 5.1 script, no runtime to install

## Requirements

- Windows 10/11 with **Windows Terminal**
- **PowerShell 5.1** (preinstalled on Windows)
- [Claude Code](https://claude.com/claude-code) for live statuses (other CLIs get presence + click-to-focus out of the box)

## Install

```powershell
git clone <this-repo> perch
cd perch
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DesktopShortcut
```

The installer:
1. deploys the status hook to `%LOCALAPPDATA%\AgentFocus\`
2. compiles a tiny native helper DLL (console APIs)
3. **non-destructively** merges the hook into `~/.claude/settings.json` (backup written first; already-registered events are left alone)
4. generates `icon.ico` from `logo.png`
5. optionally creates Desktop / Startup shortcuts (`-DesktopShortcut`, `-StartupShortcut`)

Launch with **`Perch.vbs`** (no console window). Sessions started after install
get full status coverage; ones already running appear as soon as they do
anything (or as "quiet" rows via the process scan).

## Other CLI tools (Codex, Gemini, opencode, aider, ...)

**Presence (zero setup):** any process named in `AgentProcessNames`
(`%LOCALAPPDATA%\AgentFocus\settings.json`) that lives in a WT tab is
auto-discovered with click-to-focus.

**Live status:** have the tool pipe one JSON line to
`agent-focus-status.ps1 -Provider <name>` on its events:

```json
{"hook_event_name":"Stop","session_id":"<stable-id>","cwd":"<dir>","last_assistant_message":"..."}
```

| event | shows as |
|---|---|
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | working |
| `Stop` | done |
| `Notification` | needs you |
| `StopFailure` | failed |
| `SessionEnd` | removed |

**Codex CLI** has a ready adapter - add to `~/.codex/config.toml`:

```toml
notify = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
          "-File", "<repo>\\codex-notify-adapter.ps1"]
```

## How it works (the fun part)

Mapping a session to its terminal tab is done **deterministically**:

1. Claude Code hooks spawn with their own hidden console (via bash.exe), so the
   hook `AttachConsole()`s into the agent process itself - that console's title
   IS the session's tab title (ConPTY mirrors it).
2. The title is matched to a tab via UI Automation (normalized to survive
   spinner glyphs). If it isn't unique, the hook briefly stamps a unique marker
   title, finds it, and restores the original.
3. If the marker never appears in any tab, that agent is headless (subagent /
   agent-team worker) - flagged and hidden.
4. The tab's UIA runtime id + fresh title are stored per session; clicking a row
   re-matches against live tabs (fresh title first, runtime id as tiebreaker),
   restores the window if minimized, selects the tab, `SetForegroundWindow`.

Hard-won details, all handled: never capture from the foreground window
(tab-hoppers poison it - it once recorded Spotify), never touch a *suspended*
process's console (blocks forever), per-session mutex against concurrent hook
writes, guard flags are time-limited leases (a stopped pipeline once orphaned
a flag and froze the UI), `AttachConsole` resets std handles (bind stdout
first), and PowerShell-hosted WPF needs its own `AppUserModelID` or the
taskbar shows the PowerShell icon.

## Files

| file | purpose |
|---|---|
| `perch.ps1` | the widget (WPF, single file) |
| `hooks/agent-focus-status.ps1` | Claude Code hook: session events -> status JSONs |
| `install.ps1` | installer (hook deploy + settings merge + shortcuts) |
| `Perch.vbs` | consoleless launcher |
| `codex-notify-adapter.ps1` | Codex CLI notify -> status adapter |
| `gen-icon.ps1` | rebuilds `icon.ico` from `logo.png` |

Debug: `perch.ps1 -Probe` prints the session table to the console.
Runtime logs: `hud-error.log` (survived errors), `hud-boot.log` (startup stages).

## License

MIT © Zelipt
