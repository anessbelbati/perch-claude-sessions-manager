<p align="center">
  <img src="logo.png" width="140" alt="perch bird">
</p>

<h1 align="center">perch</h1>

<p align="center"><b>claude sessions manager — for windows</b></p>

<p align="center">
  a smol always-on-top bird that watches your claude code sessions<br>
  so you don't have to alt-tab through 10 terminal tabs like a maniac
</p>

<p align="center">
  <img src="screenshot.png" width="320" alt="perch watching 7 real sessions">
</p>

---

## why

i run a LOT of claude code sessions at once. multiple windows terminal windows, tabs everywhere. at some point i genuinely could not tell which session was done, which one was stuck waiting for me to click "allow", and which one was still cooking.

so i made perch. it's a tiny card that sits in the corner of your screen and just... tells you:

- 🔴 **needs you** — waiting for permission or input (pulses + resurfaces so you actually notice)
- 🟠 **working** — still cooking
- 🟢 **done** — finished, waiting for your next prompt
- 🔵 **quiet** — a live agent perch found on its own, no events from it yet

and the best part: **click a row and it jumps to the EXACT windows terminal tab.** not "roughly the right window" — the exact tab, deterministically. (this took an embarrassing amount of effort, see war stories below.)

## stuff it does

- live status for every claude code session, via hooks
- click-to-focus down to the exact tab
- right-click a row → **pin to top**, **rename**, **hide** (remembered per project folder)
- pin the widget = always on top. unpin = it stays out of your way and just flashes the taskbar when something needs you
- also spots `codex` / `gemini` / `opencode` / `aider` sessions out of the box (add whatever names you want to the list)
- dead sessions disappear on their own, headless subagents / agent-team workers are hidden
- **statuses that can't get stuck**: pressing esc mid-turn or finishing a `/compact` fires no hook event at all, which normally leaves a session painted "working" forever. perch notices a suspiciously stale busy row, quietly reads the console's actual screen, and corrects the label — a permission prompt hiding under "working" gets promoted to **needs you**, and a session stuck in `Unable to connect to API … retrying` shows as **api retry** (and flips back to working on its own the moment a retry gets through)
- **prompt peek**: hover any row → a little tooltip with the last thing you asked and the last thing claude answered, without touching the tab. read lazily from the transcript tail, cached, costs nothing until you linger
- **parked**: a needs-you you've ignored for 30+ minutes (configurable) clearly wasn't that urgent — it demotes itself below "done", goes muted, stops pulsing. a fresh notification instantly brings the red back. fresh reds keep meaning *fresh*
- **compact mode**: double-click the header (or hit the `–` button) and perch folds into a tiny dynamic-island pill — the bird wearing your **5h limit as a colored ring**, next to colored need-you / working / done counts (`zzz` when everything sleeps). **click-driven, hover opens nothing**: one click = the full card (the tooltip carries a passive counts + 5h% glance) — though passing the cursor over the bird himself makes him **wave hello** (wink + tiny bounce), and if he's asleep he **cracks one eye open**, clocks you, and drifts back off. **drag it and you carry only the bird** — capsule, ring and counts vanish and you're holding a scruff-grabbed birb with real dangle physics until you drop him and the pill reassembles
- **red = jump, everywhere**: the pill's red count and the red "need you" chip are buttons — click one and you land straight in the terminal of the session that's been **waiting longest**, no expanding, no alt-tab roulette. same tab-matching engine as row clicks. everything still chirps, pulses and flashes — the pill just does it in ~150 pixels
- **the bird is alive**: he's the center of the pill — a big bird whose limit-ring forms the capsule's left cap, everything else orbiting him. he has a full wardrobe of state faces (generated art in `assets/bird/`): he **hatches from an egg on boot**, blinks every few seconds, goes wide-eyed with alarm when a session newly needs you, wears reading glasses while sessions work, party-hats when work finishes, side-eyes over coffee when you ignore a needs-you, fans himself as your 5h limit cooks, gets **scruff-grabbed like a kitten while you drag him**, puts on aviator goggles when you jump to a terminal, and when everything's quiet: nightcap, blanket, drool bubble, **breathing** — drifting off *through a half-lidded drowsy frame*, both ways, like a real creature. the sprite tier makes states move: he **actually flaps** through the victory hop (two-frame wing alternation with confetti physics), **sips his coffee** every few seconds while side-eyeing your ignored sessions, and **fans himself frantically in real time** while your 5h limit cooks. motions ride on top — perk wiggle, happy double-hop, supervising head-tilts and pecks, grounding squash on park — and when he's awake with nothing to do, **idle antics**: he looks around, ruffles his feathers, or hops a half-turn and briefly sulks with his back to you. every motion is an event-driven render-only moment; the loops (sleep-breathing, the fan) only run when their state is actually on screen
- **themes**: seven rooms for the bird to perch in — **midnight** (classic), **oled** (pure black, disappears into a dark desktop), **liquid glass** (real acrylic backdrop blur through DWM, specular rim light, reflection streaks — drag it over something colorful), **phosphor** (CRT green terminal, with actual scanlines), **nord** (polar night, frost-blue hairline), **catppuccin** (mocha walls, mauve rim), and **synthwave** (deep violet with a neon sun setting just below the card's bottom edge). the bird's halo re-tints to match whichever room you pick. status colors never change — those are semantics, not decoration. flip themes in ⚙ settings with live preview
- **live limit bars**: how much of your 5-hour window and weekly caps you've burned and exactly when they reset, straight from the same endpoint the CLI's `/usage` screen uses. green → amber → red as you cook, with burn-rate prediction (`caps ~15:40`) when you're on pace to hit the wall before the reset. fetched by a background child every **5 minutes** (10 when the network's down) — deliberately gentle on the API, and the UI never waits on the network. and when *everything* is unreachable (offline, api down, rate-limited), a **local estimate** takes over: perch buckets your own transcripts into the same 5-hour billing windows (ccusage-style, anchored to the server's actual reset time) and calibrates tokens-per-window against official percentages it saw earlier — so the `5h ~local` bar keeps working with zero network at all
- **account switcher**: got more than one paid Claude subscription? save each one once (`claude setup-token` → paste into ⚙ settings → claude accounts) and switching becomes one click instead of the whole logout-browser-login ritual. tokens are DPAPI-encrypted, switches apply to new sessions (`claude --continue` in a stuck tab brings your conversation back on the new account). manual only — perch never auto-switches, and honesty corner: we're not sure where Anthropic's ToS stands on rotating accounts around usage limits, so that call is yours
- **actual bird chirps**: three lovely [mixkit](https://mixkit.co/free-sound-effects/bird/) chirps ship in `sounds/` — a random one plays whenever a session needs you (enable + set volume in ⚙ settings). drop your own `.wav`s in the folder to override; no wavs at all = a humble synth beep
- one powershell script. no electron. no node_modules. your grandma's windows can run it

## "isn't there already something like this?"

kind of, but not really — i looked:

- [claude-squad](https://github.com/smtg-ai/claude-squad) (8k★) and [ccmanager](https://github.com/kbwo/ccmanager) (1k★) are great, but they're terminal multiplexers: you run your sessions *inside* them, tmux-style. that's a whole workflow change.
- there's a small army of cute menubar companions (Pulse, notch dynamic-island apps, claude-code-menubar ×3...) — **every single one is macOS**.
- windows had... a notification popup script. that's it.

perch is different on both axes: it's **windows-native**, and it watches the
windows terminal tabs **you already have** — no tmux, no TUI to live inside,
no workflow change. your sessions don't even know it exists.

## install

you need: windows 10/11, windows terminal, and [claude code](https://claude.com/claude-code) (for the live statuses — other CLIs get presence + click-to-focus without any setup).

```powershell
git clone https://github.com/anessbelbati/perch-claude-sessions-manager perch
cd perch
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DesktopShortcut
```

the installer copies the hook to `%LOCALAPPDATA%\AgentFocus\`, compiles a tiny helper dll, and gently merges the hook into your `~/.claude/settings.json` (it backs it up first and never touches your existing hooks). add `-StartupShortcut` if you want perch at login.

then double-click **`Perch.vbs`**. that's it. sessions you start after installing get full statuses; ones already running show up as soon as they do anything.

## other CLI tools

any agent CLI running in a windows terminal tab shows up automatically if its process name is in `AgentProcessNames` (`%LOCALAPPDATA%\AgentFocus\settings.json`). that gives you presence + click-to-focus with zero setup.

for real statuses the tool needs to tell perch what it's doing — pipe one JSON line to `agent-focus-status.ps1 -Provider <name>`:

```json
{"hook_event_name":"Stop","session_id":"<stable-id>","cwd":"<dir>","last_assistant_message":"..."}
```

| event | shows as |
|---|---|
| `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | working |
| `Stop` | done |
| `Notification` | needs you |
| `StopFailure` | failed |
| `SessionEnd` | gone |

**codex** users: there's a ready-made adapter. in `~/.codex/config.toml`:

```toml
notify = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
          "-File", "<wherever-you-cloned-perch>\\codex-notify-adapter.ps1"]
```

## how it works (nerd corner)

the hard problem is mapping a session to its exact tab. tab titles change constantly (spinner glyphs, task summaries) and guessing from the foreground window is a disaster if you tab-hop fast.

the trick: claude code hooks run as child processes of the claude process, so the hook can `AttachConsole()` into claude itself — and that console's title IS the session's tab title (ConPTY mirrors the app-set title up to windows terminal). match that against all tabs via UI Automation — but only when no *other* live session's console shows the same title right now (batch-restarted twins share identical startup titles, and matching a value without proving ownership once cross-wired two sessions). renamed tabs pin their name and ignore console titles entirely, so those fall back to cwd-name matching and, ultimately, to content fingerprinting: compare the console's visible screen text against what each tab actually renders. boom: session ↔ tab, no guessing.

clicking a row re-matches against live tabs (fresh title first, UIA runtime id as tiebreaker), restores the window if minimized, selects the tab, brings it forward.

## war stories

things that bit me so they don't have to bite you:

- **never capture from the foreground window.** with fast tab-hopping the hook fires late and records whatever's focused. it once stored *spotify* as a session's location. clicking that row opened spotify.
- **never touch a suspended process's console.** agent-team workers get suspended; their console server can't answer and `GetConsoleTitle` blocks forever. perch froze windowless at startup because of this.
- **`DragMove()` eats child clicks.** the draggable header was swallowing every click on the pin button. mark the buttons' mouse-down as handled or they're decorative.
- **powershell + WPF share one thread.** nested message pumps (menus!) stop each other's pipelines; a `trap { break }` then killed the whole app, and later an orphaned "refresh in progress" flag froze it silently. guard flags must be time-limited leases, not locks.
- **`AttachConsole` resets std handles.** bind `[Console]::Out` before the first attach or your stdout just... stops.
- **taskbar icons lie.** a powershell-hosted WPF window shows the powershell icon until you set your own `AppUserModelID`.
- **process-hunting by command-line substring matches your own diagnostic process.** i killed my own kill-script mid-run more than once.
- **no hook fires on esc.** claude code's `Stop` hook deliberately skips user interrupts, and `/compact` has a `PreCompact` but no post — two officially invisible transitions that left rows painted "working" forever. the console screen is the only witness.
- **the TUI's hint line rotates.** "esc to interrupt" vanishes every few seconds in favor of random tips — a session 9 minutes into a bash call showed only a tip. deciding a session stopped because that hint is absent flips live sessions to done; trust the elapsed-timer/token row and the title's spinner glyph instead, and demand two clean sightings before believing anything.
- **`[Console]::In` decodes stdin with the OEM codepage.** claude pipes UTF-8 JSON into hooks; the console reader read it as CP437, so every em-dash and curly quote stored from assistant messages became `ΓÇö`-style mojibake in the session rows. read `OpenStandardInput()` through a UTF-8 StreamReader instead — and the widget carries a strict round-trip reverse-repair (re-encode CP437, strict-decode UTF-8, keep only if both succeed) that heals records written before the fix without ever touching organic text.

## stolen with love

perch is windows-native and proud, but a bunch of its best tricks were shamelessly studied from the macOS / terminal crowd. i literally cloned their repos, read their source, and took notes like a magpie:

- [ccusage](https://github.com/ryoppippi/ccusage) — the 5-hour billing-block model and the "transcripts are append-only, parse incrementally" insight. the offline `5h ~local` bars are this idea wearing a PowerShell trench coat.
- [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) — P90 *learn your limit from your own history* thinking, and burn-rate → predicted cutoff ("caps ~15:40").
- [ccmanager](https://github.com/kbwo/ccmanager) — the screen-content state detectors ("press enter to confirm…", "esc to interrupt") that power hookless needs-you detection. best pattern list in the business.
- [CodexBar](https://github.com/steipete/CodexBar) — the *identify yourself as the CLI* User-Agent trick on the usage endpoint. one header, night and day difference in how you get rate-limited.
- [ccseva](https://github.com/Iamshankhadeep/ccseva) and the rest of the menubar companion crowd — the conviction that a tiny always-visible meter beats a dashboard you have to open, plus the hover prompt-peek.
- [claude-squad](https://github.com/smtg-ai/claude-squad) — not robbed yet, but the git-worktree session spawning is on the list.

no code was copied — everything here is hand-rolled PowerShell 5.1 (their stacks are TypeScript/Python/Go/Swift anyway, the trench coat wouldn't fit). *ideas*, however, were taken without hesitation, and a few came out upgraded: their 5h blocks floor to the hour, ours snap to the server's actual reset time; their caps are plan presets or P90 guesses, ours calibrate against official percentages. that's the deal with building in the open — thanks for doing it 🐦

## files

| file | what |
|---|---|
| `perch.ps1` | the widget (single WPF file) |
| `hooks/agent-focus-status.ps1` | claude code hook: events → status JSONs |
| `install.ps1` | installer |
| `Perch.vbs` | consoleless launcher |
| `codex-notify-adapter.ps1` | codex notify → status adapter |
| `blocks-probe.ps1` | local 5h-window usage math (offline limit bars) |
| `gen-icon.ps1` | rebuilds the icon from `logo.png` |

debugging: `perch.ps1 -Probe` prints the session table. `hud-error.log` has survived errors, `hud-boot.log` has startup stages.

## license

MIT. it's a personal tool i made for me — if it's useful to you, cool 🐦

built with [claude code](https://claude.com/claude-code), naturally.
