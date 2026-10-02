'use strict';
// One window for every agent session: real consoles running the real agent
// CLIs, and a dashboard read from the files those CLIs write on disk. The
// window never sees a login and never talks to a model provider.
const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen, shell } = require('electron');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HIDDEN = process.env.DESK_HIDDEN === '1';
const SELFTEST_DIR = process.env.DESK_SELFTEST || '';
if (SELFTEST_DIR) {
  // A hidden test run that dies must say so in its report, not in an error box on the screen.
  process.on('uncaughtException', (err) => {
    try {
      fs.mkdirSync(SELFTEST_DIR, { recursive: true });
      fs.appendFileSync(path.join(SELFTEST_DIR, 'report.txt'), `FAIL  crashed: ${err && err.stack ? err.stack : err}\n`);
    } catch {
      // nowhere left to report to
    }
    process.exit(70);
  });
}
// A test copy keeps its own profile so it can never collide with the window in use.
if (process.env.DESK_PROFILE_DIR) app.setPath('userData', process.env.DESK_PROFILE_DIR);
if (SELFTEST_DIR) app.commandLine.appendSwitch('js-flags', '--expose-gc');
const { Chats } = require('./chats.cjs');

const windowsBuild = Number(os.release().split('.')[2]) || 0;
// DESK_CONSOLE=inbox picks the console engine built into Windows instead of the one shipped with the app.
const ENGINE = process.env.DESK_CONSOLE === 'inbox' ? 'inbox' : 'bundled';
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_ID = /^[0-9a-f]{6,40}$/i;
const APP_ID = 'Perch.Desk';
const ICON = path.join(__dirname, '..', 'icon.ico');
const LAUNCHER = path.join(__dirname, 'PerchDesk.vbs');
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
const OLD_MS = 3 * 86400e3;
const RANGES = ['today', '7d', '30d'];
const ACCOUNT_KEY = /^[0-9a-f]{8}$/;
// the colour of the top of the page: the window buttons Windows draws sit on it, and it shows before the page has loaded
const BASE = '#0a0a0b';

let win = null;
let tray = null;
let worker = null;
let quitting = false;
let latest = { at: 0, chats: [], ended: [], leaving: [], plan: null, accounts: null }; // the watcher's newest picture
let latestRes = null;                       // and what the programs under the sessions use, as last measured
const took = [];                            // how long its last looks took, in ms
const watcherErrors = [];                   // what it reported as going wrong, newest last (a handful kept)
const asks = new Map();                     // questions put to the watcher, waiting for their answer
let askSeq = 0;
const lastState = new Map();                // session -> its state at the last look
const notedAt = new Map();                  // session -> when a note about it last went up near the clock
const limitNoted = new Set();               // usage windows, per account, a "nearly used up" note already went out for
let noteTarget = '';                        // where a click on that note leads
const PLAN_NAMES = { five: '5-hour limit', week: 'weekly limit' };
const NEARLY = 90;                          // percent of a usage limit at which a note goes out, once per window
// what closing the window with chats in it does: 'ask', 'always' (keep them for next time), 'never' (start fresh), 'tray' (hide by the clock)
const CLOSE_CHOICES = ['ask', 'always', 'never', 'tray'];
// permission modes Claude Code takes on its command line, besides bypassing them ("default" needs no word)
const MODES = ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan'];
// how many chats can share the screen
const TILES = [1, 2, 4];
let settings = {
  starter: '', open: [], trayNoted: false, bounds: null, maximized: false, keepChats: 'ask',
  // a note near the clock when a chat wants the person: for the chats of this window, for sessions in other
  // terminals, when a chat of this window finishes, and when a usage limit is nearly used up
  notify: { here: true, elsewhere: false, finished: false, limit: true },
  fontSize: 16,
  inspector: false,
  // how many chats share the screen (1, 2 or 4), and how many when it was last more than one
  tiles: 2,
  split: 2,
  // the window is opened see-through, with the desktop blurred behind its sidebar and title bar; true switches that off
  solid: false,
  // what the person calls their accounts: account -> name
  accountNames: {},
  // the workspaces: [{ id, name, folders }]. A chat belongs to the workspace that lists its folder, or a folder above it.
  spaces: [],
  // the workspace in front; '' shows every chat
  space: '',
};
let glassOn = false;                        // the window was opened see-through this time
let previous = [];                          // the chats that were open when the app last quit, or went down
let front = '';                             // the chat in front in the window, as the page last said
let ending = false;                         // Windows is shutting down or signing out: no questions, the chats are kept
let endTimer = null;                        // ... unless it turns out not to: then this takes that back
let restore = '';                           // what becomes of `previous` at this start: 'auto' (they open), 'crash' (the same, after a crash), 'ask', or ''
let restoring = false;                      // they are being opened again right now: the list kept on disk is left alone until they all are
let restoreUntil = 0;                       // ... or until this moment, should the page never say it is done
let starters = [];

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const leaf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const send = (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); };
const logFile = () => path.join(app.getPath('userData'), 'desk.log');
function log(text) {
  try {
    if (fs.existsSync(logFile()) && fs.statSync(logFile()).size > 1024 * 1024) fs.writeFileSync(logFile(), '');
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${text}\n`);
  } catch {
    // a log that cannot be written is not worth stopping for
  }
}

// ---- what is kept between runs ----
const settingsFile = () => path.join(app.getPath('userData'), 'desk.json');
let saveTimer = null;
/** Takes the names given to accounts from `from` into `into`: an empty name takes the old one away. */
function takeNames(into, from) {
  if (!from || typeof from !== 'object') return into;
  for (const [key, value] of Object.entries(from)) {
    if (!ACCOUNT_KEY.test(key) || typeof value !== 'string') continue;
    const name = value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (name) into[key] = name; else delete into[key];
  }
  return into;
}
const SPACE_ID = /^w[0-9a-z]{1,12}$/;
const SPACES_MAX = 12;
const SPACE_FOLDERS_MAX = 200;
/**
 * The workspaces as they were handed over, made fit to keep: ids of one fixed shape, a short name each, and
 * folders that are whole paths on this machine, each in one workspace only (the first that lists it). Nothing
 * here is ever run or opened: a folder is only compared with the folder a chat works in. null: not a list.
 */
function takeSpaces(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const ids = new Set();
  const taken = new Set();
  for (const s of list) {
    if (out.length >= SPACES_MAX) break;
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !SPACE_ID.test(s.id) || ids.has(s.id)) continue;
    const name = typeof s.name === 'string' ? s.name.replace(/\s+/g, ' ').trim().slice(0, 24) : '';
    if (!name) continue;
    const folders = [];
    for (const f of Array.isArray(s.folders) ? s.folders : []) {
      if (folders.length >= SPACE_FOLDERS_MAX) break;
      if (typeof f !== 'string' || !f || f.length > 260 || !path.win32.isAbsolute(f)) continue;
      const whole = path.win32.normalize(f);
      const root = path.win32.parse(whole).root;
      // a drive or a share by name: "\folder" alone says nothing about where it is
      if (root.length < 3) continue;
      const tidy = whole.length > root.length ? whole.replace(/\\+$/, '') : root;
      if (taken.has(tidy.toLowerCase())) continue;
      taken.add(tidy.toLowerCase());
      folders.push(tidy);
    }
    ids.add(s.id);
    out.push({ id: s.id, name, folders });
  }
  return out;
}
function loadSettings() {
  let kept = {};
  try { kept = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { /* first run */ }
  settings = { ...settings, ...kept, notify: { ...settings.notify, ...(kept.notify && typeof kept.notify === 'object' ? kept.notify : {}) } };
  if (!Array.isArray(settings.open)) settings.open = [];
  settings.fontSize = clamp(Math.round(Number(settings.fontSize)) || 16, 10, 26);
  settings.inspector = Boolean(settings.inspector);
  if (!TILES.includes(settings.tiles)) settings.tiles = 2;
  if (settings.split !== 4) settings.split = 2;
  settings.solid = Boolean(kept.solid);
  if (!CLOSE_CHOICES.includes(settings.keepChats)) settings.keepChats = 'ask';
  // what the third version kept its own see-through switch in
  delete settings.glass;
  settings.accountNames = takeNames({}, kept.accountNames);
  settings.spaces = takeSpaces(kept.spaces) || [];
  if (!settings.spaces.some((s) => s.id === settings.space)) settings.space = '';
}
function writeSettings() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile() + '.tmp', JSON.stringify(settings, null, 1));
    fs.renameSync(settingsFile() + '.tmp', settingsFile());
  } catch (err) {
    log(`settings not saved: ${err.message}`);
  }
}
const saveSettings = () => { if (!saveTimer) saveTimer = setTimeout(writeSettings, 400); };

// ---- the ways a chat can be started ----
const onPath = (name) => (process.env.PATH || '').split(';').some((dir) => dir && ['.exe', '.cmd', '.ps1', '.bat']
  .some((ext) => { try { return fs.statSync(path.join(dir, name + ext)).isFile(); } catch { return false; } }));

function findStarters() {
  const list = [{ id: 'claude', name: 'Claude Code', command: 'claude', agent: 'claude' }];
  // A function in the PowerShell profile that starts the CLI with the person's own flags is how they start chats.
  try {
    const profile = fs.readFileSync(path.join(app.getPath('documents'), 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'), 'utf8');
    for (const m of profile.matchAll(/^[ \t]*function[ \t]+([A-Za-z][\w-]*)[ \t]*\{([^}]*)\}/gm)) {
      if (/(^|[\s;&|(])claude(\s|$)/m.test(m[2])) list.push({ id: m[1], name: m[1], command: m[1], agent: 'claude' });
    }
  } catch {
    // no profile: the plain command is all there is
  }
  if (onPath('codex')) list.push({ id: 'codex', name: 'Codex', command: 'codex', agent: 'codex' });
  list.push({ id: 'shell', name: 'PowerShell', command: '', agent: '' });
  return list;
}
/** The person's own function when there is one, until they pick something else. */
const claudeStarter = () => starters.find((s) => s.id === settings.starter && s.agent === 'claude')
  || starters.find((s) => s.agent === 'claude' && s.id !== 'claude') || starters[0];
const defaultStarter = () => starters.find((s) => s.id === settings.starter) || claudeStarter();

/**
 * When the newest Claude Code session that may be running in a chat started.
 * Read straight from the CLI's own files: the watcher's picture is a couple of seconds old.
 */
function newestStart(chatId) {
  const where = new Map(latest.chats.map((c) => [c.session, c.chat]));
  let newest = 0;
  let names = [];
  try { names = fs.readdirSync(SESSIONS_DIR); } catch { return 0; }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
      const chat = where.get(rec.sessionId);
      // one traced to another chat of this window is that chat's concern; one not traced yet may be this chat's
      if (chat && chat !== chatId) continue;
      process.kill(Number(name.slice(0, -5)), 0);
      newest = Math.max(newest, Number(rec.startedAt) || 0);
    } catch {
      // gone, or mid-write
    }
  }
  return newest;
}

const chats = new Chats({
  engine: ENGINE,
  newestStart,
  onOutput: (id, data) => send('desk:output', id, data),
  onExit: (id, code) => send('desk:exit', id, code),
  onChange: () => {
    send('desk:chats', chats.list());
    tellWatcher();
    saveOpen();
  },
});

/** Which console, and which background session, belongs to which chat: how the watcher ties what it finds on disk to the chats here. */
function tellWatcher() {
  if (worker) worker.postMessage({ type: 'shells', pairs: chats.shells(), jobs: chats.jobs() });
}

/** The Claude Code session running in a chat of this window, as the watcher last saw it. */
const sessionIn = (chatId) => latest.chats
  .filter((c) => c.chat === chatId && c.provider === 'claude' && c.session)
  .sort((a, b) => b.at - a.at)[0];

/**
 * What is kept of one open chat, to bring it back next time. c: the chat. s: the session the watcher sees in it,
 * if any. inFront: it is the chat in front in the window.
 */
function keptOf(c, s, inFront) {
  // its agent was left with /exit and none was started since: a plain shell is what is open, and that is what comes back
  const left = !s && c.left;
  // A session nothing was ever asked of has no transcript, so there is nothing to pick up: it is started afresh.
  // A chat opened to pick a conversation up holds that conversation until its session shows something newer:
  // the watcher sees a session a few seconds after its program starts, and the app can go down before that.
  const live = s && s.turn ? s.session : '';
  const resume = live || (left ? '' : c.holds || '');
  return {
    cwd: c.cwd, starter: left ? 'shell' : c.starter,
    // the name the person gave it; otherwise the one it went by, for saying what came back
    title: c.title || (s ? s.title || s.name || '' : ''), named: Boolean(c.named),
    resume, mode: live ? s.mode || '' : resume ? c.mode || '' : '', front: Boolean(inFront),
  };
}

/**
 * What is brought back next time: every chat open now, kept as it changes, so a crash, a forced close or a
 * machine that goes down loses nothing. Each with its folder, how it was started, the name the person gave it,
 * the conversation in it and the permission mode that conversation was in.
 */
function saveOpen() {
  if (quitting) return;
  // Last time's chats are still being opened again, one after the other: the list on disk stays whole until they
  // all are, so an end in the middle of it loses none of them.
  if (restoring && Date.now() < restoreUntil) return;
  restoring = false;
  // the view of a background session is not a chat to bring back: the session lives on without it, and the sidebar lists it
  const now = chats.list().filter((c) => !c.closing && !c.job).map((c) => keptOf(c, sessionIn(c.id), c.id === front));
  // nothing open, and last time's chats neither reopened nor dismissed: they stay on offer
  if (!now.length && previous.length) return;
  if (JSON.stringify(now) === JSON.stringify(settings.open)) return;
  settings.open = now;
  saveSettings();
}

/**
 * How a chat that is asked for gets started: the starter it goes through, the command typed into its shell, the
 * background session it is the view of, the conversation it picks up and the permission mode that was in.
 * Nothing is started here. Only ids of a fixed shape and words from a fixed list ever reach the command line.
 */
function planChat(ask) {
  const starter = starters.find((s) => s.id === ask.starter) || defaultStarter();
  if (typeof ask.attach === 'string' && JOB_ID.test(ask.attach)) {
    // the view of a background session: the plain CLI, whatever chats are usually started with
    return { starter, via: starters[0], command: `claude attach ${ask.attach}`, job: ask.attach, holds: '', mode: '' };
  }
  if (typeof ask.resume === 'string' && SESSION_ID.test(ask.resume)) {
    const via = starter.agent === 'claude' ? starter : claudeStarter();
    const mode = ask.mode === 'bypassPermissions' || MODES.includes(ask.mode) ? ask.mode : '';
    // The plain command starts in the default permission mode: the conversation is put back in the one it was in.
    // The person's own starter sets the mode itself (theirs bypasses permissions) and is left to: a second mode on
    // the same line would fight it.
    const flags = via.id !== 'claude' || !mode ? '' : mode === 'bypassPermissions' ? ' --dangerously-skip-permissions' : ` --permission-mode ${mode}`;
    return { starter, via, command: `${via.command} --resume ${ask.resume}${flags}`, job: '', holds: ask.resume, mode };
  }
  return { starter, via: starter, command: starter.command, job: '', holds: '', mode: '' };
}

function createChat(ask) {
  if (!ask || typeof ask !== 'object') return { error: 'Nothing to start.' };
  if (typeof ask.cwd !== 'string' || !isDir(ask.cwd)) return { error: 'That folder no longer exists.' };
  const p = planChat(ask);
  // What the person picks for a new chat is what the next new chat starts with. A chat that comes back from last
  // time, or that picks a conversation up, changes nothing about that.
  if (!p.job && !p.holds && ask.restore !== true && ask.starter && p.starter.id === ask.starter && settings.starter !== p.starter.id) {
    settings.starter = p.starter.id;
    saveSettings();
  }
  const title = typeof ask.title === 'string' ? ask.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  const chat = chats.create({ cwd: ask.cwd, command: p.command, starter: p.via.id, title, named: ask.named === true && Boolean(title), job: p.job, holds: p.holds, mode: p.mode });
  return chats.list().find((c) => c.id === chat.id);
}

// ---- the watcher thread ----
let restarts = 0;
let watcherSince = 0;
function startWatcher() {
  watcherSince = Date.now();
  const thread = new Worker(path.join(__dirname, 'watch.cjs'), {
    workerData: {
      home: os.homedir(),
      localAppData: process.env.LOCALAPPDATA || '',
      cacheFile: path.join(app.getPath('userData'), 'tally.jsonl'),
      endedFile: path.join(app.getPath('userData'), 'ended.json'),
      accountsFile: path.join(app.getPath('userData'), 'accounts.json'),
      // a test run walks no transcripts unless it asks to
      counting: !SELFTEST_DIR,
      // what the programs under the sessions use, through a small helper program
      measure: true,
    },
    // It reads megabytes of JSON a second and keeps almost none of it: a small heap is cleaned sooner.
    resourceLimits: { maxOldGenerationSizeMb: 160, maxYoungGenerationSizeMb: 8 },
  });
  worker = thread;
  thread.on('message', (m) => {
    if (m.type === 'snapshot') {
      took.push(m.tookMs);
      if (took.length > 50) took.shift();
      track(m.data);
      send('desk:snapshot', m.data);
    } else if (m.type === 'res') {
      latestRes = m.data;
      send('desk:res', m.data);
    } else if (m.type === 'answer') {
      const done = asks.get(m.ask);
      asks.delete(m.ask);
      if (done) done(m.data);
    } else if (m.type === 'error') {
      log(`watcher: ${m.message}`);
      watcherErrors.push(String(m.message));
      if (watcherErrors.length > 20) watcherErrors.shift();
    }
  });
  thread.on('error', (err) => log(`watcher stopped: ${err && err.stack ? err.stack : err}`));
  thread.on('exit', (code) => {
    if (worker !== thread) return;
    worker = null;
    if (quitting || code === 0) return;
    // one that ran a good while before it stopped starts again with a clean slate
    if (Date.now() - watcherSince > 10 * 60e3) restarts = 0;
    // without it the dashboard goes stale: bring it back, a few times at most, and say so when that fails
    if (++restarts > 3) {
      log(`watcher ended with code ${code} ${restarts} times in a row; left stopped`);
      send('desk:command', 'stale');
      return;
    }
    log(`watcher ended with code ${code}; starting it again`);
    setTimeout(() => { if (!quitting && !worker) { startWatcher(); presence(); } }, 2000);
  });
  tellWatcher();
}

/** The person asks for the watcher back, after it was left stopped. */
function watchAgain() {
  if (worker || quitting) return;
  restarts = 0;
  startWatcher();
  presence();
}

/** Puts a question to the watcher; null when it does not answer. */
function askWatcher(type, more) {
  return new Promise((resolve) => {
    if (!worker) { resolve(null); return; }
    const ask = ++askSeq;
    asks.set(ask, resolve);
    worker.postMessage({ ...more, type, ask });
    setTimeout(() => { if (asks.delete(ask)) resolve(null); }, 15000);
  });
}

/** The name a session goes by, as the page shows it. */
function nameOf(c) {
  const chat = c.chat && chats.all.get(c.chat);
  return (chat && chat.title) || (c.named && c.name) || c.title || c.name || leaf(c.cwd) || 'Chat';
}

/** A note near the clock; a click on it brings the window up at `target`. */
function balloon(title, content, target) {
  noteTarget = target;
  try {
    tray.displayBalloon({ iconType: 'custom', icon: ICON, largeIcon: true, title: title.slice(0, 63), content: content.slice(0, 240), respectQuietTime: true });
  } catch (err) {
    log(`note not shown: ${err.message}`);
  }
}

function note(c, finished) {
  const what = finished ? 'finished' : c.state === 'error' ? 'stopped on an error' : 'needs you';
  balloon(`${nameOf(c)} ${what}`, String(c.words || '').replace(/\s+/g, ' ').trim() || (finished ? 'Its turn is over.' : 'It is waiting for you.'), c.chat || `row:${c.key}`);
}

/** "18:20" for a moment today, "Thu 8 Oct, 09:00" for another day. */
function whenOf(at) {
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

function track(data) {
  const first = latest.at === 0;
  latest = data;
  const now = Date.now();
  let nudge = false;
  let wanted = null;
  let needs = 0;
  let working = 0;
  const keys = new Set();
  for (const c of data.chats) {
    keys.add(c.key);
    // a background record nobody runs any more and nobody answered for days is not counted, as in the window
    const stale = c.kind === 'bg' && !c.pid && now - c.at > OLD_MS;
    if (!stale && (c.state === 'attention' || c.state === 'error')) needs++;
    if (c.state === 'working' || c.state === 'compacting') working++;
    const before = lastState.get(c.key);
    lastState.set(c.key, c.state);
    if (first || !before || before === c.state) continue;
    const finished = c.state === 'idle' && (before === 'working' || before === 'compacting');
    const wants = c.state === 'attention' || c.state === 'error';
    if (!wants && !finished) continue;
    if (c.chat) nudge = true;
    const on = finished ? Boolean(c.chat) && settings.notify.finished : c.chat ? settings.notify.here : settings.notify.elsewhere;
    if (on && !wanted && now - (notedAt.get(c.key) || 0) > 60000) wanted = { c, finished };
  }
  for (const key of lastState.keys()) if (!keys.has(key)) { lastState.delete(key); notedAt.delete(key); }
  // a session wants the person, or just finished, while they are looking elsewhere
  const looking = Boolean(win) && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
  if (!HIDDEN && !looking) {
    if (nudge && win && !win.isDestroyed()) win.flashFrame(true);
    if (wanted && tray) { notedAt.set(wanted.c.key, now); note(wanted.c, wanted.finished); }
  }
  // A usage limit of the account in use that is nearly used up is said once per window: in the page when it is
  // being looked at, near the clock when not. The limits are those of whichever account is logged in, so it is named.
  const plan = data.plan || {};
  const me = data.accounts && Array.isArray(data.accounts.list) ? data.accounts.list.find((a) => a.here) : null;
  const who = me ? settings.accountNames[me.key] || String(me.email || '').split('@')[0] : '';
  for (const name of Object.keys(PLAN_NAMES)) {
    const w = plan[name];
    const said = `${me ? me.key : ''}|${name}|${w ? w.until : 0}`;
    if (!w || w.used < NEARLY || limitNoted.has(said)) continue;
    limitNoted.add(said);
    // already that far when the app started: the sidebar shows it, and a note would be old news
    if (first || HIDDEN || !settings.notify.limit) continue;
    const title = `${Math.round(w.used)}% of your ${PLAN_NAMES[name]} is used`;
    const rest = `${who ? `Account ${who}. ` : ''}It resets at ${whenOf(w.until)}.`;
    if (looking) send('desk:command', 'say', `${title}. ${rest}`);
    else if (tray && !wanted) balloon(title, `${rest} As Claude Code last reported it.`, 'stats');
    else limitNoted.delete(said);
  }
  if (tray) {
    const bits = ['Perch Desk'];
    if (needs) bits.push(`${needs} need${needs === 1 ? 's' : ''} you`);
    if (working) bits.push(`${working} working`);
    const limits = [plan.five && `5h ${Math.round(plan.five.used)}%`, plan.week && `week ${Math.round(plan.week.used)}%`].filter(Boolean).join(', ');
    if (limits) bits.push(who ? `${who}: ${limits}` : limits);
    else if (who) bits.push(who);
    // Windows cuts a tooltip off at 127 characters
    tray.setToolTip(bits.join(' · ').slice(0, 120));
  }
  // a conversation that ended in a chat of this window: that chat is a plain shell from now on
  for (const e of data.ended || []) if (e.chat) chats.release(e.chat);
  saveOpen();
}

/** The watcher looks less often while nobody can see the window, and the page stops its small animations when it is not in front. */
function presence() {
  if (!win || win.isDestroyed()) return;
  const seen = win.isVisible() && !win.isMinimized();
  if (worker) worker.postMessage({ type: 'pace', ms: seen ? 2000 : 6000 });
  send('desk:command', !seen ? 'away' : win.isFocused() ? 'live' : 'seen');
  if (win.isFocused()) win.flashFrame(false);
}

// ---- shortcuts in the Start menu, on the desktop, in the "start with Windows" folder: made only when asked ----
const LINKS = {
  startmenu: () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Perch Desk.lnk'),
  desktop: () => path.join(app.getPath('desktop'), 'Perch Desk.lnk'),
  startup: () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Perch Desk.lnk'),
};
const linkState = () => Object.fromEntries(Object.keys(LINKS).map((kind) => [kind, fs.existsSync(LINKS[kind]())]));
/** Writes a shortcut that starts this app the way the taskbar does. flags: passed on to the window. */
function writeLink(file, flags) {
  return shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', {
    target: WSCRIPT,
    args: `"${LAUNCHER}"${flags ? ' ' + flags : ''}`,
    cwd: __dirname,
    description: 'Perch Desk: every agent chat in one window',
    icon: ICON,
    iconIndex: 0,
    appUserModelId: APP_ID,
  });
}

// ---- what the page may ask for ----
function logoUrl() {
  try {
    return nativeImage.createFromPath(path.join(__dirname, '..', 'logo.png')).resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
  } catch {
    return '';
  }
}
const shownSettings = () => ({ notify: { ...settings.notify }, fontSize: settings.fontSize, inspector: settings.inspector, tiles: settings.tiles, split: settings.split,
  solid: settings.solid, keepChats: settings.keepChats, accountNames: { ...settings.accountNames }, links: linkState(),
  spaces: settings.spaces.map((s) => ({ id: s.id, name: s.name, folders: s.folders.slice() })), space: settings.space });

ipcMain.handle('desk:info', () => ({
  build: windowsBuild,
  // DESK_RENDERER=dom: draw with plain page text instead of the graphics card, should that ever garble.
  renderer: process.env.DESK_RENDERER === 'dom' ? 'dom' : 'webgl',
  logo: logoUrl(),
  home: os.homedir(),
  starters: starters.map(({ id, name, agent }) => ({ id, name, agent })),
  starter: defaultStarter().id,
  previous,
  restore,
  size: { cols: chats.cols, rows: chats.rows },
  chats: chats.list(),
  snapshot: latest,
  res: latestRes,
  settings: shownSettings(),
  hidden: HIDDEN,
  glass: glassOn,
}));
ipcMain.handle('desk:create', (_event, ask) => createChat(ask));
ipcMain.on('desk:input', (_event, id, data) => {
  if (typeof id === 'string' && typeof data === 'string') chats.input(id, data);
});
ipcMain.on('desk:resize', (_event, id, size) => {
  if (typeof id === 'string') chats.resize(id, size && size.cols, size && size.rows);
});
ipcMain.on('desk:rename', (_event, id, title) => {
  if (typeof id === 'string' && typeof title === 'string') chats.rename(id, title);
});
ipcMain.handle('desk:close', async (_event, id) => {
  const chat = chats.all.get(id);
  if (!chat) return false;
  const s = sessionIn(id);
  // closing the view of a background session stops nothing: the session carries on without it
  if (!chat.job && s && (s.state === 'working' || s.state === 'compacting') && !HIDDEN) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Close chat', 'Keep it'],
      defaultId: 1,
      cancelId: 1,
      message: 'This chat is still working.',
      detail: 'Closing it stops the agent in the middle of its task. The conversation is saved: it is listed on the left under "Ended in the last day", and in History.',
    });
    if (response !== 0) return false;
  }
  chats.close(id);
  return true;
});
ipcMain.handle('desk:pick-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Folder for the new chat' });
  return canceled || !filePaths.length ? null : filePaths[0];
});
ipcMain.handle('desk:recent', async () => (await askWatcher('recent')) || { chats: [], folders: [] });
ipcMain.handle('desk:usage', (_event, range) => askWatcher('usage', { range: RANGES.includes(range) ? range : 'today' }));
// what was typed into a prompt box, ever, that holds the words asked for: read from Claude Code's own prompt history
ipcMain.handle('desk:typed', async (_event, query) => {
  if (typeof query !== 'string' || query.trim().length < 3) return [];
  return (await askWatcher('typed', { query: query.slice(0, 200) })) || [];
});
// One page of a conversation, read from its transcript: what was asked, said and done. The page names a session
// by its id; which file that is, is worked out by the watcher, among the CLI's own transcripts only.
const READ_KEY = /^(job:[0-9a-f]{6,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const AGENT_KEY = /^[0-9a-z]{6,40}$/i;
const offset = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined);
ipcMain.handle('desk:read', (_event, ask) => {
  if (!ask || typeof ask.key !== 'string' || !READ_KEY.test(ask.key)) return null;
  const agent = typeof ask.agent === 'string' && AGENT_KEY.test(ask.agent) ? ask.agent : '';
  return askWatcher('read', { key: ask.key, agent, before: offset(ask.before) || 0, after: offset(ask.after) });
});
ipcMain.handle('desk:history', () => askWatcher('history'));
// the person asks for everything to be read again now: sessions, who is logged in, what the chats last said about the limits
ipcMain.handle('desk:refresh', () => askWatcher('refresh'));
// Shows a conversation's own file in Explorer.
ipcMain.handle('desk:show-file', async (_event, key, agent) => {
  if (typeof key !== 'string' || !READ_KEY.test(key) || HIDDEN) return false;
  const file = await askWatcher('file', { key, agent: typeof agent === 'string' && AGENT_KEY.test(agent) ? agent : '' });
  const root = path.join(os.homedir(), '.claude', 'projects') + path.sep;
  if (typeof file !== 'string' || !file.toLowerCase().startsWith(root.toLowerCase()) || !fs.existsSync(file)) return false;
  shell.showItemInFolder(file);
  return true;
});
ipcMain.on('desk:forget', (_event, id) => {
  if (worker && typeof id === 'string' && SESSION_ID.test(id)) worker.postMessage({ type: 'forget', id });
});
ipcMain.on('desk:previous-done', () => {
  previous = [];
  restoring = false;
  saveOpen();
});
ipcMain.handle('desk:settings', (_event, patch) => {
  if (patch && typeof patch === 'object') {
    const notify = patch.notify && typeof patch.notify === 'object' ? patch.notify : {};
    for (const key of Object.keys(settings.notify)) if (typeof notify[key] === 'boolean') settings.notify[key] = notify[key];
    if (Number.isFinite(patch.fontSize)) settings.fontSize = clamp(Math.round(patch.fontSize), 10, 26);
    if (typeof patch.inspector === 'boolean') settings.inspector = patch.inspector;
    if (TILES.includes(patch.tiles)) settings.tiles = patch.tiles;
    if (patch.split === 2 || patch.split === 4) settings.split = patch.split;
    if (typeof patch.solid === 'boolean') settings.solid = patch.solid;
    if (CLOSE_CHOICES.includes(patch.keepChats)) settings.keepChats = patch.keepChats;
    takeNames(settings.accountNames, patch.accountNames);
    const spaces = takeSpaces(patch.spaces);
    if (spaces) settings.spaces = spaces;
    if (typeof patch.space === 'string') settings.space = patch.space;
    // the workspace in front is one that exists: taken away, the window shows every chat again
    if (!settings.spaces.some((s) => s.id === settings.space)) settings.space = '';
    saveSettings();
  }
  return shownSettings();
});
ipcMain.handle('desk:shortcut', (_event, kind, on) => {
  const file = Object.hasOwn(LINKS, kind) ? LINKS[kind]() : '';
  try {
    if (!file || HIDDEN) return linkState();
    // started with Windows, it waits by the clock instead of opening over whatever is on screen
    if (on) writeLink(file, kind === 'startup' ? '--tray' : '');
    else fs.rmSync(file, { force: true });
  } catch (err) {
    log(`shortcut ${kind}: ${err.message}`);
  }
  return linkState();
});
// Copy and paste go through here: the page itself has no access to the clipboard.
ipcMain.handle('desk:clip-read', () => clipboard.readText());
ipcMain.on('desk:clip-write', (_event, text) => {
  if (typeof text === 'string' && text) clipboard.writeText(text.slice(0, 4 * 1024 * 1024));
});
ipcMain.on('desk:open-url', (_event, url) => {
  // web addresses only: nothing a terminal prints may start a program
  if (typeof url === 'string' && url.length < 2048 && /^https?:\/\/[^\s]+$/i.test(url)) shell.openExternal(url).catch(() => {});
});
ipcMain.on('desk:open-folder', (_event, dir) => {
  if (typeof dir === 'string' && isDir(dir)) shell.openPath(dir);
});
ipcMain.on('desk:badge', (_event, image, text) => {
  if (!win || win.isDestroyed() || HIDDEN) return;
  // the small mark on the taskbar button: how many sessions want the person
  if (typeof image === 'string' && image.startsWith('data:image/png;base64,') && image.length < 60000) {
    win.setOverlayIcon(nativeImage.createFromDataURL(image), String(text || '').slice(0, 80));
  } else {
    win.setOverlayIcon(null, '');
  }
});
ipcMain.on('desk:watch-again', () => watchAgain());
// the person asks to quit from the window: the same as closing it
ipcMain.on('desk:quit', () => leave());
// The person's answer to "what about your chats?": keep them for next time, start fresh, or keep running by the
// clock. remember: the same answer every time from now on (Settings can change it).
const ANSWERS = { keep: 'always', fresh: 'never', tray: 'tray' };
ipcMain.on('desk:leave', (_event, how, remember) => {
  if (!Object.hasOwn(ANSWERS, how)) return;
  if (remember === true) { settings.keepChats = ANSWERS[how]; saveSettings(); }
  if (how === 'tray') toTray(); else quit(how === 'keep');
});
// which chat is in front: it is put in front again when the chats come back
ipcMain.on('desk:front', (_event, id) => {
  front = typeof id === 'string' ? id.slice(0, 20) : '';
  saveOpen();
});

// ---- the window, the tray, leaving ----
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Where the window was last time, as long as that place is still on a screen that is plugged in. */
function lastBounds() {
  const b = settings.bounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return {};
  const area = screen.getDisplayMatching(b).workArea;
  const reachable = b.x + b.width > area.x + 120 && b.x < area.x + area.width - 120 && b.y >= area.y - 8 && b.y < area.y + area.height - 80;
  return reachable ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: b.width, height: b.height };
}

function createWindow() {
  // See-through: Windows blurs the desktop behind the window (11, 22H2 and later), and the page leaves its sidebar
  // and title bar half out. Decided when the window is made: it cannot be changed on one that is already open.
  // A window that is never shown has no desktop behind it.
  glassOn = !settings.solid && !HIDDEN && windowsBuild >= 22621;
  // The page is dark whatever Windows is set to: the blur behind it and the window's own three buttons follow.
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    ...(HIDDEN ? {} : lastBounds()),
    minWidth: 760,
    minHeight: 460,
    show: false,
    backgroundColor: glassOn ? '#00000000' : BASE,
    ...(glassOn ? { backgroundMaterial: 'acrylic' } : {}),
    title: 'Perch Desk',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: glassOn ? '#00000000' : BASE, symbolColor: '#a4a9b6', height: 46 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A minimised window still owns live consoles: their output must keep being read at full speed.
      backgroundThrottling: false,
    },
  });
  // The taskbar goes by what a window says it is. Unsaid, its button is "Electron", and pinning it pins the
  // bare runtime, which opens an empty window: the window gives its own name and the command that starts it.
  win.setAppDetails({
    appId: APP_ID,
    appIconPath: ICON,
    appIconIndex: 0,
    relaunchCommand: `"${WSCRIPT}" "${LAUNCHER}"`,
    relaunchDisplayName: 'Perch Desk',
  });
  // The page is this app's own file and nothing else: no new windows, no going anywhere.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
  // --inactive: appear without taking the keyboard from whatever is being typed into. --tray: stay by the clock.
  if (!HIDDEN && !process.argv.includes('--tray')) {
    win.once('ready-to-show', () => (process.argv.includes('--inactive') ? win.showInactive() : win.show()));
  }
  if (settings.maximized && !HIDDEN && !process.argv.includes('--tray')) win.maximize();
  for (const change of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) win.on(change, presence);
  for (const change of ['resize', 'move', 'maximize', 'unmaximize']) {
    win.on(change, () => {
      if (HIDDEN || win.isMinimized() || !win.isVisible()) return;
      settings.bounds = win.getNormalBounds();
      settings.maximized = win.isMaximized();
      saveSettings();
    });
  }
  win.on('close', (event) => {
    // with no chat open there is nothing to decide; Windows going down decides for itself
    if (quitting || HIDDEN || ending || !chats.list().some((c) => !c.job && !c.closing)) return;
    event.preventDefault();
    leave();
  });
  // Windows is shutting down or signing out: what is open is written down now, and brought back at the next start
  for (const end of ['query-session-end', 'session-end']) {
    win.on(end, () => {
      ending = true;
      saveOpen();
      // said on disk, so the next start knows this run ended with Windows and not in a crash
      settings.running = 'windows';
      writeSettings();
      // still here a minute later: Windows did not go down after all
      clearTimeout(endTimer);
      endTimer = setTimeout(() => { ending = false; settings.running = true; writeSettings(); }, 60000);
    });
  }
  win.on('closed', () => { win = null; });
}

/** The window keeps running by the clock: its chats go on, and the bird brings it back. */
function toTray() {
  if (!win || win.isDestroyed() || !tray) return;
  win.hide();
  if (!settings.trayNoted) {
    tray.displayBalloon({ iconType: 'info', title: 'Perch Desk is still running', content: 'Your chats keep going. Click the bird near the clock to come back, right-click it to quit.' });
    settings.trayNoted = true;
    saveSettings();
  }
}

/** Leaving with chats open: what becomes of them is the person's to say, once, or every time. */
function leave() {
  if (quitting) return;
  if (!chats.list().some((c) => !c.job && !c.closing)) { quit(true); return; }
  const choice = settings.keepChats;
  if (choice === 'tray' && tray) toTray();
  else if (choice === 'always') quit(true);
  else if (choice === 'never') quit(false);
  else {
    showWindow();
    send('desk:command', 'ask-leave');
  }
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip('Perch Desk');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Perch Desk', click: showWindow },
    { label: 'New chat', click: () => { showWindow(); send('desk:command', 'new'); } },
    { label: 'Dashboard', click: () => { showWindow(); send('desk:command', 'goto', 'stats'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => leave() },
  ]));
  tray.on('click', showWindow);
  tray.on('balloon-click', () => {
    showWindow();
    if (noteTarget) send('desk:command', 'goto', noteTarget);
  });
}

/**
 * Closes every chat (each agent ends its own session) and then the app. keep: the chats open now come back at
 * the next start; otherwise the next start is a fresh one.
 */
async function quit(keep = true) {
  if (quitting) return;
  saveOpen();
  if (!keep) { settings.open = []; previous = []; }
  // it reached its end: the next start is not one after a crash
  clearTimeout(endTimer);
  settings.running = false;
  quitting = true;
  writeSettings();
  if (win && !win.isDestroyed()) win.hide();
  if (tray) tray.destroy();
  await chats.closeAll();
  if (worker) {
    const gone = new Promise((done) => worker.once('exit', done));
    worker.postMessage({ type: 'stop' });
    await Promise.race([gone, new Promise((done) => setTimeout(done, 1500))]);
  }
  app.exit(0);
}

/**
 * How the last run ended, from what it left in the settings file. `running` is written true at every start and
 * false at every proper end; 'windows' when Windows shut down or signed out under it. Still true: it never reached
 * an end (closed by force, a crash, the power going).
 */
const lastEnd = (running) => (running === true ? 'crash' : running === 'windows' ? 'windows' : 'clean');
/**
 * What becomes, at a start, of the chats that were open when the app last ran. open: how many there are. last:
 * how that run ended. After a proper close they are there because the person kept them: they open. After a crash
 * or a Windows shutdown they open too, unless the person chose to start fresh after every close: then they are
 * asked. 'crash' says so in the window; a Windows shutdown is nothing to remark on.
 */
const restoreMode = (open, last, keepChats) => (!open ? '' : last === 'clean' ? 'auto' : keepChats === 'never' ? 'ask' : last === 'crash' ? 'crash' : 'auto');

function start() {
  // The default menu owns Ctrl+W, Ctrl+R and friends; inside a terminal those keys belong to the CLI.
  Menu.setApplicationMenu(null);
  loadSettings();
  // what the first version kept its token counts in; the day-by-day counts live in another file
  try { fs.rmSync(path.join(app.getPath('userData'), 'counts.json'), { force: true }); } catch { /* still there, and harmless */ }
  starters = findStarters();
  previous = settings.open.filter((c) => c && typeof c.cwd === 'string' && isDir(c.cwd));
  const last = lastEnd(settings.running);
  restore = restoreMode(previous.length, last, settings.keepChats);
  restoring = restore === 'auto' || restore === 'crash';
  // the page opens them one after the other once it has loaded, up to 3.5 s apart, and says when it is done
  restoreUntil = Date.now() + 30000 + previous.length * 5000;
  if (last !== 'clean') log(`the last run ended ${last === 'crash' ? 'without closing properly' : 'with Windows'}; ${previous.length} chat(s) to bring back`);
  settings.running = true;
  writeSettings();
  createWindow();
  if (!HIDDEN) createTray();
  startWatcher();
  if (SELFTEST_DIR) {
    require('./selftest.cjs')({
      app, win, dir: SELFTEST_DIR, engine: ENGINE, chats, writeLink, keptOf, restoreMode, lastEnd,
      // how a chat would be started, as plain words: nothing is started
      planChat: (ask) => { const p = planChat(ask); return { via: p.via.id, plain: p.via.id === 'claude', command: p.command, job: p.job, holds: p.holds, mode: p.mode }; },
      settingsNow: () => JSON.parse(JSON.stringify(settings)),
      watch: { latest: () => latest, took: () => took.slice(), errors: () => watcherErrors.slice(), post: (m) => worker.postMessage(m), ask: askWatcher, kill: () => worker && worker.terminate() },
    });
  }
}

// A second launch brings the first one's window forward instead of opening another.
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => { if (!quitting) showWindow(); });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quit();
  });
  app.on('window-all-closed', () => quit());
  app.whenReady().then(start);
} else {
  app.exit(0);
}
