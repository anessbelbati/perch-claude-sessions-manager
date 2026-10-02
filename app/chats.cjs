'use strict';
// The chats of this window: each one a real PowerShell console, usually with
// an agent CLI started inside it. This file owns the consoles and passes
// keystrokes and screen output through; it never looks at what they say.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const pty = require('node-pty');

const FLUSH_MS = 5;
// Claude Code counts a fullscreen start that dies within ten seconds of its
// first frame as a failed start, and after two of those it turns fullscreen
// off for the whole machine. A console is never closed over a session younger
// than this.
const YOUNG_MS = 15000;
// A program started by an Enter just pressed has not written its session file yet.
const ENTER_MS = 3000;

/** Names Windows itself stores for the user and the machine (the environment a program gets from Explorer). */
function savedEnvNames() {
  const names = new Set();
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const out = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
      for (const m of out.matchAll(/^ {4}(\S+) {4}REG_/gm)) names.add(m[1].toUpperCase());
    } catch {
      // an unreadable key only means none of its names are kept
    }
  }
  return names;
}

/**
 * The environment a chat starts with. A window opened from inside an agent's
 * own terminal inherits that agent's session markers (CLAUDECODE,
 * CLAUDE_CODE_SESSION_ID, WT_SESSION ...), and a session started with them
 * believes it is that agent's child, in a Windows Terminal tab. It also
 * inherits what the agent sets for its own tool shells (GIT_EDITOR=true makes
 * every plain `git commit` fail). Those are dropped; names Windows stores for
 * the user are kept. Opened from Explorer, none of them exist.
 */
function sessionEnv() {
  const env = { ...process.env };
  const nested = Boolean(env.CLAUDECODE || env.WT_SESSION);
  const saved = nested ? savedEnvNames() : null;
  const inherited = /^(CLAUDE|CODEX_|WT_|AI_AGENT$|GIT_EDITOR$|COREPACK_ENABLE_AUTO_PIN$)/i;
  for (const name of Object.keys(env)) {
    if (/^DESK_/i.test(name)) delete env[name];
    else if (nested && inherited.test(name) && !saved.has(name.toUpperCase())) delete env[name];
  }
  env.COLORTERM = 'truecolor';
  // Read by the Perch hook: this console is not a Windows Terminal tab, so there is no tab to look for.
  env.AGENTFOCUS_HOST = 'desk';
  // Claude Code wraps each screen update in "paint this whole" marks only for
  // terminals it knows by name, and the console engine answers its question
  // about them without asking the widget. The widget does honour the marks and
  // the engine passes them through, so half-drawn frames never reach the screen.
  env.CLAUDE_CODE_FORCE_SYNC_OUTPUT = '1';
  return env;
}

/** A console cannot be zero or fractional cells wide; a window mid-minimise can ask for both. */
function cells(n, fallback) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 2 ? v : fallback;
}

class Chats {
  /**
   * engine: 'bundled' (Windows Terminal's console engine, shipped with node-pty) or 'inbox' (the one built into Windows).
   * newestStart(chatId): when the newest agent session that may be running in that chat started.
   */
  constructor({ engine, newestStart, onOutput, onExit, onChange }) {
    this.engine = engine;
    this.newestStart = newestStart;
    this.onOutput = onOutput;
    this.onExit = onExit;
    this.onChange = onChange;
    this.all = new Map();
    this.seq = 0;
    this.cols = 120;
    this.rows = 30;
    this.pending = new Map();    // chat id -> screen output not yet sent to the window
    this.timer = null;
    this.env = null;
  }

  /**
   * Starts a console in `cwd` and runs `command` in it; an empty command leaves a plain shell.
   * job: the background session this chat is the view of, when it is one.
   * named: the title is a name the person gave it (kept for next time), not one the chat was opened with.
   */
  /** holds, mode: the conversation the chat was opened to pick up again, and the permission mode it was in. */
  create({ cwd, command, starter, title, named, job, holds, mode }) {
    const id = `c${++this.seq}`;
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = command ? ['-NoLogo', '-NoExit', '-Command', command] : ['-NoLogo'];
    if (!this.env) this.env = sessionEnv();
    // The bundled engine counts the cells of emoji and kaomoji the way the
    // widget does, and on close it lets the programs in the console end
    // themselves; the one built into Windows miscounts and cuts them off.
    const term = pty.spawn(shell, args, { cols: this.cols, rows: this.rows, cwd, env: this.env, useConptyDll: this.engine === 'bundled' });
    const chat = { id, cwd, command, starter: starter || '', title: title || '', named: Boolean(named && title), job: job || '', holds: holds || '', mode: mode || '', left: false,
      startedAt: Date.now(), enterAt: 0, pid: term.pid, term, closing: false };
    this.all.set(id, chat);
    term.onData((data) => this.queue(id, data));
    term.onExit(({ exitCode }) => {
      this.flush();
      this.all.delete(id);
      this.onExit(id, exitCode);
      this.onChange();
    });
    this.onChange();
    return chat;
  }

  input(id, data) {
    const chat = this.all.get(id);
    if (!chat || chat.closing) return;
    if (data.includes('\r')) chat.enterAt = Date.now();
    chat.term.write(data);
  }

  /** The name the person gives a chat; an empty one hands the naming back to the session inside it. */
  rename(id, title) {
    const chat = this.all.get(id);
    if (!chat) return;
    chat.title = String(title).replace(/\s+/g, ' ').trim().slice(0, 120);
    chat.named = Boolean(chat.title);
    this.onChange();
  }

  /** The agent in a chat ended its session (it was left with /exit): the chat holds no conversation any more, only its shell. */
  release(id) {
    const chat = this.all.get(id);
    if (!chat || chat.left) return;
    chat.left = true;
    chat.holds = '';
    chat.mode = '';
  }

  /**
   * A chat's console takes the size of the place its terminal is drawn in: several chats can share the screen, each
   * in a place of its own. The size given last is the one the next new chat starts at.
   */
  resize(id, cols, rows) {
    this.cols = cells(cols, this.cols);
    this.rows = cells(rows, this.rows);
    const chat = this.all.get(id);
    if (!chat) return;
    try { chat.term.resize(this.cols, this.rows); } catch { /* it ended a moment ago */ }
  }

  // Output arrives in many small pieces; a few milliseconds of them go to the window as one message.
  queue(id, data) {
    this.pending.set(id, (this.pending.get(id) || '') + data);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const [id, data] of this.pending) this.onOutput(id, data);
    this.pending.clear();
  }

  /** How long, in ms, before this chat's console may be closed without cutting a starting session short. */
  tooYoung(chat) {
    // A CLI started with the chat has no session file in its first seconds, and the view of a background
    // session never writes one: until there is one, the chat's own start is all there is to go by.
    const own = chat.command ? chat.startedAt + YOUNG_MS : 0;
    return Math.max(chat.enterAt + ENTER_MS, this.newestStart(chat.id) + YOUNG_MS, own) - Date.now();
  }

  /**
   * Closes a chat's console. The programs in it get the console's close event
   * and end themselves: the agent CLI saves and ends its session.
   */
  async close(id) {
    const chat = this.all.get(id);
    if (!chat || chat.closing) return;
    chat.closing = true;
    this.onChange();
    for (;;) {
      const wait = this.tooYoung(chat);
      if (wait <= 0 || !this.all.has(id)) break;
      await new Promise((r) => setTimeout(r, Math.min(wait, 1000)));
    }
    if (this.all.has(id)) {
      try { chat.term.kill(); } catch { /* already gone */ }
    }
  }

  /** Closes every chat and waits, up to `ms` after the last console was told to close, for them to be gone. */
  async closeAll(ms = 6000) {
    await Promise.all([...this.all.keys()].map((id) => this.close(id)));
    const end = Date.now() + ms;
    while (this.all.size && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  }

  list() {
    return [...this.all.values()].map(({ id, cwd, command, starter, title, named, job, holds, mode, left, startedAt, pid, closing }) => ({ id, cwd, command, starter, title, named, job, holds, mode, left, startedAt, pid, closing }));
  }

  /** [shell pid, chat id] pairs: how a session found on disk is traced back to the chat it runs in. */
  shells() {
    return [...this.all.values()].map((chat) => [chat.pid, chat.id]);
  }

  /** [background session id, chat id] pairs: the chats that are the view of one. Such a session runs outside any console here. */
  jobs() {
    return [...this.all.values()].filter((chat) => chat.job).map((chat) => [chat.job, chat.id]);
  }
}

module.exports = { Chats };
