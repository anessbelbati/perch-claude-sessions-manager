'use strict';
// Runs in its own thread. Every couple of seconds it reads what the agent
// CLIs wrote on disk (which sessions are alive, what each is doing, their
// subagents) and hands the window one plain object to show. In between it
// walks every transcript on the machine once, a little at a time, to add up
// tokens, tools and work time day by day. It only reads: nothing those CLIs
// own is ever written or deleted.
//
// Where it reads:
//   ~/.claude/sessions/<pid>.json                     one file per running session: busy, idle, or waiting for the person
//   ~/.claude/projects/<folder>/<session>.jsonl       its transcript
//   ~/.claude/projects/<folder>/<session>/subagents/  one transcript + one description per subagent
//   ~/.claude/jobs/<id>/state.json                    background sessions
//   %LOCALAPPDATA%/AgentFocus/status/*.json           what the Perch hook noted (compacting, helper sessions, Codex)
//   %LOCALAPPDATA%/AgentFocus/statusline.json         what a session last handed its status line, when the person's
//                                                     status line command keeps it: its usage limits, its cost, how
//                                                     warm its cache is. One file for every session, holding whichever
//                                                     spoke last: it is looked at twice a second
//   ~/.claude.json, ~/.claude/history.jsonl           which account is logged in, when /login was typed (accounts.cjs),
//                                                     and everything typed into a prompt box, for the search
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Follower, Tally, eachLine, waitsForPerson, clip, dayKey, setTimeline, seekTime, readPage, peekTail } = require('./transcript.cjs');
const { Ledger } = require('./accounts.cjs');
const { Procs } = require('./procs.cjs');
const os = require('node:os');

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const WARM = 30 * 60e3;          // a subagent is followed, and shown, while its file moved in the last half hour
const AGENT_TAIL = 256 * 1024;
const TOOLS_SHOWN = 14;
const AGENTS_SHOWN = 24;
const PULSE = 30;                // minutes of activity drawn next to each session
const COUNT_BUDGET_MS = 60;      // how long one round of counting may run before it rests
const CATCH_UP = 4 * 1024 * 1024; // a running session this close to counted is brought up to date at every look
const CATCH_UP_MS = 30;
const SMALL_LAG = 256 * 1024;    // this far behind is "counted": the newest lines are picked up at the next look
const HISTORY_EVERY = 10 * 60e3; // how often the machine's whole history is listed again
const ENDED_KEPT = 40;
const ENDED_FOR = DAY;           // an ended conversation is offered again for this long
// A program on its way out takes its own record away first and then needs a few seconds more (its
// end-of-session scripts may take up to a minute). One still there after this long is not coming back to it.
const LEAVING_FOR = 75e3;
const PLAN_WINDOWS = [['five_hour', 'five'], ['seven_day', 'week']];
// how often who is logged in is looked at again: at every look (a look at the file's date; it is read only when that moved)
const LOGIN_EVERY = 1500;
const LEDGER_SAVE = 30000;
const LINE_KEPT = 30 * 60e3;     // what a session that is gone last handed its status line is kept this long
// A transcript with more than this left to count, written to today, gets today's lines counted first.
const EARLY_MIN = 48 * 1024 * 1024;
const TODAY_AGAIN = 60000;       // how often a transcript is asked again whether today's lines need that
const LANES = 10;                // conversations drawn hour by hour on the Usage view
const TYPED_KEPT = 300;          // characters kept of each thing typed, for the search
const TYPED_IDLE = 5 * 60e3;     // what was typed is let go of this long after the last search
const TYPED_SHOWN = 40;
// what the programs under the sessions use is looked at this often while the window can be seen, and this often when not
const MEASURE_SEEN = 4000;
const MEASURE_AWAY = 30000;
const ITEMS_SHOWN = 14;          // programs listed under one session; the rest are added up as "more"
// programs that only start others or hold a console: what they run is what they are
const WRAPPER = /^(cmd|conhost|py|pyw|bash|sh|powershell|pwsh|wsl|openconsole|uv|uvx|npx)\.exe$/i;
const SHELL = /^(cmd|bash|sh|powershell|pwsh|wsl)\.exe$/i;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_ID = /^[0-9a-z]{6,40}$/i;
const HISTORY_SHOWN = 600;       // conversations listed on the History view, newest first
const HISTORY_FRESH = 60000;     // how old the listing of every transcript may be when that view asks for it

const readJson = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  // files written by Windows PowerShell start with a byte-order mark, which JSON.parse refuses
  return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
};
// EPERM: the process exists and belongs to someone this one may not signal
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const leaf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
/** A moment the CLI gives in seconds, in milliseconds, or written out as a date. */
const momentOf = (v) => (typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v) || 0);

/** A background session's own record of how it stands, in the words used here. */
const jobState = (job) => (job.state === 'blocked' || job.tempo === 'blocked' ? 'attention'
  : job.state === 'failed' || job.state === 'crashed' ? 'error'
    : job.state === 'done' || job.state === 'stopped' ? 'ended'
      : job.tempo === 'active' ? 'working' : 'idle');

/** Re-reads a small JSON file only when it changed on disk. */
class Fresh {
  constructor() { this.stamp = ''; this.value = null; }
  read(file) {
    let st;
    try { st = fs.statSync(file); } catch { this.stamp = ''; this.value = null; return null; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp !== this.stamp) {
      try { this.value = readJson(file); this.stamp = stamp; } catch { /* mid-write: the next look reads it whole */ }
    }
    return this.value;
  }
}

/** The subagents of one session. */
class Agents {
  constructor(dir, main, countFor) {
    this.dir = dir;
    this.main = main;            // the session's own transcript: it holds the calls that started them
    this.countFor = countFor;
    this.all = new Map();
    this.listedAt = 0;
    this.warm = 0;
    this.newest = 0;
  }

  poll(now, busy) {
    // every one of them is looked at on a listing; between listings only the ones that moved lately
    const listing = now - this.listedAt > (busy || this.warm ? 4000 : 60000);
    if (listing) {
      this.listedAt = now;
      let names = [];
      try { names = fs.readdirSync(this.dir); } catch { /* no subagents yet */ }
      for (const name of names) {
        if (!name.startsWith('agent-') || !name.endsWith('.meta.json')) continue;
        const id = name.slice(6, -10);
        if (this.all.has(id)) continue;
        const file = path.join(this.dir, `agent-${id}.jsonl`);
        this.all.set(id, {
          id, file, meta: {}, about: new Fresh(), aboutFile: path.join(this.dir, name),
          follow: new Follower(file, AGENT_TAIL), count: this.countFor(file), born: 0, mtime: 0, size: 0, read: false,
        });
      }
    }
    this.warm = 0;
    for (const a of this.all.values()) {
      if (!listing && now - a.mtime > WARM) continue;
      let st;
      try { st = fs.statSync(a.file); } catch { continue; }
      if (st.size !== a.size) a.count.dirty = true;
      const changed = st.mtimeMs !== a.mtime;
      a.mtime = st.mtimeMs;
      a.size = st.size;
      a.born = st.birthtimeMs;
      if (a.mtime > this.newest) this.newest = a.mtime;
      if (now - a.mtime > WARM) continue;
      this.warm++;
      a.meta = a.about.read(a.aboutFile) || a.meta;
      if (changed || !a.read) { a.follow.poll(); a.read = true; }
    }
  }

  state(a, now) {
    const f = a.follow;
    if (a.meta.stoppedByUser || f.state.turnEnd) return 'stopped';
    if (f.running()) return 'working';
    // between two tool calls it writes nothing for a while: the call that started it is still open, so it is still going
    const parent = a.meta.parentAgentId ? this.all.get(a.meta.parentAgentId) : null;
    if ((parent ? parent.follow : this.main).pending.has(a.meta.toolUseId)) return 'working';
    const quiet = now - a.mtime;
    // its last line was words: that is its report, once nothing follows it
    if (f.state.last === 'said') return quiet > 45e3 ? 'done' : 'working';
    return quiet < 3 * 60e3 ? 'working' : 'stopped';
  }

  /** The ones still working, then the ones that finished in the last half hour, newest first. */
  view(now) {
    const list = [];
    let running = 0;
    for (const a of this.all.values()) {
      if (!a.read || now - a.mtime > WARM) continue;
      const state = this.state(a, now);
      if (state === 'working') running++;
      const f = a.follow;
      const tool = state === 'working' ? f.running() : null;
      list.push({
        id: a.id,
        name: clip(a.meta.name || a.meta.description || a.meta.agentType || a.id, 80),
        what: a.meta.name && a.meta.description !== a.meta.name ? clip(a.meta.description, 120) : '',
        type: String(a.meta.agentType || ''),
        team: String(a.meta.teamName || ''),
        model: String(a.meta.model || f.state.model || ''),
        depth: Number(a.meta.spawnDepth) || 0,
        parent: String(a.meta.parentAgentId || ''),
        state,
        doing: tool ? { name: tool.name, what: tool.what, at: tool.at } : null,
        said: clip(f.state.said, 240),
        // whole once its file has been counted to the end
        tools: a.count.tools,
        out: a.count.sum[1],
        started: Math.round(a.born),
        at: Math.round(a.mtime),
      });
    }
    list.sort((x, y) => (x.state === 'working') === (y.state === 'working') ? y.at - x.at : x.state === 'working' ? -1 : 1);
    return { total: this.all.size, running, list: list.slice(0, AGENTS_SHOWN) };
  }

  /** Adds the warm ones' beats of the last minutes into `into`. */
  pulse(now, into) {
    for (const a of this.all.values()) if (a.read && now - a.mtime <= WARM) a.follow.pulse(now, into);
  }
}

/**
 * One day of a transcript. While the full count of it is still on its way, the days from today on come from
 * the short count of today's lines (see Watch.todayPlan).
 */
const dayIn = (c, key) => (c.early && key >= c.early.fromDay ? c.early.days[key] : c.days[key]);
/** Every day of a transcript that has something in it: [key, day]. */
function daysIn(c) {
  if (!c.early) return Object.entries(c.days);
  const out = [];
  for (const key of Object.keys(c.days)) if (key < c.early.fromDay) out.push([key, c.days[key]]);
  for (const key of Object.keys(c.early.days)) if (key >= c.early.fromDay) out.push([key, c.early.days[key]]);
  return out;
}

/** What a day of one transcript adds up to: [fresh input, output, written to cache, read from cache, replies, ms of work]. */
function dayTotals(d, into) {
  for (const v of Object.values(d.h)) for (let i = 0; i < 6; i++) into[i] += v[i];
  return into;
}
const toolsOf = (d) => { let n = 0; for (const v of Object.values(d.t)) n += v; return n; };

class Watch {
  /** measure: look at what the programs under the sessions use (a helper program does that; tests go without). */
  constructor({ home, localAppData, cacheFile, endedFile, accountsFile, counting, measure }) {
    this.claude = path.join(home, '.claude');
    this.projects = path.join(this.claude, 'projects');
    this.perch = path.join(localAppData || '', 'AgentFocus', 'status');
    this.cacheFile = cacheFile || '';
    this.endedFile = endedFile || '';
    this.records = new Map();    // pid -> reader of its session file
    this.sessions = new Map();   // session id -> what is known about a running session
    this.shells = new Map();     // console shell pid -> the desk chat it belongs to
    this.attached = new Map();   // background session id -> the desk chat that is its view
    this.placed = new Map();     // agent pid -> desk chat id, '' when it runs in some other terminal
    this.counts = new Map();     // transcript path -> its tally
    this.saved = {};             // tallies kept from the last run, until their transcript is met again
    this.journal = 0;            // characters in the cache file
    this.whole = 0;              // and how many of them a file with one line per transcript would take
    this.unsaved = false;
    this.ceilings = new Map();   // model -> where a session's memory stood when one last compacted on its own
    this.ceilingsAt = 0;
    this.history = [];           // tallies of transcripts no running session owns, newest first
    this.historyAt = 0;
    this.historyNext = 0;
    this.ended = [];             // conversations whose program ended lately, newest first
    this.leaving = new Map();    // session id -> a conversation whose record went away while its program still ran
    this.codex = [];
    this.codexAt = 0;
    this.jobs = [];
    this.jobsAt = 0;
    this.lineFile = path.join(localAppData || '', 'AgentFocus', 'statusline.json');
    this.lineStamp = 0;
    this.lines = new Map();      // session id -> what it last handed its status line
    this.ledger = new Ledger({ home, file: accountsFile || '' });
    this.epoch = 0;              // goes up when another account logs in: what a session reported before is the old account's
    this.loginAt = 0;
    this.ledgerSaved = 0;
    this.marksSent = -1;
    this.typed = null;           // everything typed into a prompt box, oldest first; read when first searched
    this.typedAt = 0;
    this.typedSize = 0;
    this.todayDone = false;      // today's lines of every transcript are counted
    this.asking = false;
    this.askedAt = 0;
    this.sent = '';
    this.counting = counting !== false;
    this.procs = measure ? new Procs() : null;
    this.measureAt = 0;
    this.measuring = false;
    this.measureEvery = MEASURE_SEEN;
    this.cpuBefore = new Map();  // program (number and start) -> its processor time at the last look
    this.cpuAt = 0;
    this.loadCounts();
    this.loadEnded();
  }

  // ---- tallies kept between runs, so each transcript is walked once. One line per transcript, newer lines
  // ---- replacing older ones: a save appends what changed instead of rewriting everything. ----
  loadCounts() {
    if (!this.cacheFile) return;
    let text = '';
    try { text = fs.readFileSync(this.cacheFile, 'utf8'); } catch { return; }
    const sizes = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const { f, e } = JSON.parse(line);
        if (typeof f !== 'string' || !e || e.v !== Tally.VERSION) continue;
        this.saved[f] = e;
        sizes.set(f, line.length + 1);
      } catch { /* a line cut short by a crash: that transcript is walked again */ }
    }
    this.journal = text.length;
    for (const n of sizes.values()) this.whole += n;
  }

  saveCounts() {
    if (!this.cacheFile || !this.unsaved) return;
    const changed = [...this.counts.values()].filter((c) => c.changed);
    try {
      const lines = changed.map((c) => JSON.stringify({ f: c.file, e: c.save() }));
      const added = lines.reduce((n, l) => n + l.length + 1, 0);
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      // appended to until the file is a few times what it needs to be, then written afresh with one line per transcript
      if (this.journal + added > 3 * this.whole + 4 * 1024 * 1024) {
        const all = [];
        for (const c of this.counts.values()) if (c.offset > 0) { all.push(JSON.stringify({ f: c.file, e: c.save() })); c.kept = true; }
        for (const [f, e] of Object.entries(this.saved)) all.push(JSON.stringify({ f, e }));
        const text = all.length ? all.join('\n') + '\n' : '';
        fs.writeFileSync(this.cacheFile + '.tmp', text);
        fs.renameSync(this.cacheFile + '.tmp', this.cacheFile);
        this.journal = this.whole = text.length;
      } else if (lines.length) {
        fs.appendFileSync(this.cacheFile, lines.join('\n') + '\n');
        this.journal += added;
        // a transcript saved for the first time adds to what the whole file needs; one saved again does not
        for (let i = 0; i < changed.length; i++) if (!changed[i].kept) { changed[i].kept = true; this.whole += lines[i].length + 1; }
      }
      for (const c of changed) c.changed = false;
      this.unsaved = false;
    } catch { /* tried again at the next save */ }
  }

  countFor(file) {
    let c = this.counts.get(file);
    if (!c) {
      c = new Tally(this.saved[file]);
      c.kept = Boolean(this.saved[file]);
      delete this.saved[file];
      c.file = file;
      c.dirty = true;
      c.changed = false;
      c.mtime = 0;
      // <projects>/<folder>/<session>.jsonl, or <projects>/<folder>/<session>/subagents/agent-<id>.jsonl
      const parts = path.relative(this.projects, file).split(path.sep);
      c.project = parts[0] || '';
      c.sub = parts.length > 2;
      c.session = c.sub ? parts[1] : (parts[1] || '').slice(0, -6);
      this.counts.set(file, c);
    }
    return c;
  }

  /** Lists every transcript on the machine: the running sessions' are known already, the rest are history. */
  scanHistory(now) {
    this.historyAt = now;
    const found = new Set();
    const take = (file) => {
      let st;
      try { st = fs.statSync(file); } catch { return; }
      found.add(file);
      const c = this.countFor(file);
      c.mtime = st.mtimeMs;
      c.size = st.size;
      if (st.size !== c.offset) c.dirty = true;
      else if (!c.live) c.dirty = false;
    };
    let dirs = [];
    try { dirs = fs.readdirSync(this.projects, { withFileTypes: true }); } catch { /* the CLI was never run here */ }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const folder = path.join(this.projects, dir.name);
      let names = [];
      try { names = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
      for (const ent of names) {
        if (ent.isFile() && SESSION_FILE.test(ent.name)) take(path.join(folder, ent.name));
        else if (ent.isDirectory()) {
          let subs = [];
          try { subs = fs.readdirSync(path.join(folder, ent.name, 'subagents')); } catch { continue; }
          for (const n of subs) if (n.startsWith('agent-') && n.endsWith('.jsonl')) take(path.join(folder, ent.name, 'subagents', n));
        }
      }
    }
    // a transcript the CLI cleaned away takes its tally with it
    for (const [file, c] of this.counts) if (!found.has(file) && !c.live && !fs.existsSync(file)) this.counts.delete(file);
    this.history = [...this.counts.values()].filter((c) => c.dirty && !c.live).sort((a, b) => b.mtime - a.mtime);
    this.historyNext = 0;
  }

  // ---- sessions ----
  transcriptOf(s, now) {
    const name = `${s.id}.jsonl`;
    const guess = path.join(this.projects, String(s.rec.cwd || '').replace(/[^A-Za-z0-9]/g, '-'), name);
    if (fs.existsSync(guess)) return guess;
    // started in one folder and moved to another: look in every project, but rarely
    if (now - s.searchedAt < 30000) return '';
    s.searchedAt = now;
    let dirs = [];
    try { dirs = fs.readdirSync(this.projects); } catch { return ''; }
    for (const dir of dirs) {
      const file = path.join(this.projects, dir, name);
      if (fs.existsSync(file)) return file;
    }
    return '';
  }

  poll() {
    const now = Date.now();
    const dir = path.join(this.claude, 'sessions');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* the CLI was never run here */ }
    const present = new Set();
    const live = new Map();      // conversation -> the program that holds it
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      const pid = Number(name.slice(0, -5));
      present.add(pid);
      let record = this.records.get(pid);
      if (!record) this.records.set(pid, record = new Fresh());
      const rec = record.read(path.join(dir, name));
      if (!rec || typeof rec.sessionId !== 'string' || !alive(pid)) continue;
      // one conversation open in two programs (picked up again while still open elsewhere): the one that moved last speaks for it
      const other = live.get(rec.sessionId);
      if (!other || (Number(rec.statusUpdatedAt) || 0) > (Number(other.rec.statusUpdatedAt) || 0)) live.set(rec.sessionId, { pid, rec });
    }
    for (const [id, { pid, rec }] of live) {
      let s = this.sessions.get(id);
      if (!s || s.pid !== pid) {
        s = { id, pid, file: '', follow: null, count: null, agents: null, perch: new Fresh(), lookedAt: 0, searchedAt: 0 };
        this.sessions.set(id, s);
        this.forgetEnded(id);
      }
      s.rec = rec;
      if (!s.file && now - s.lookedAt > 3000) {
        // a conversation has no transcript until its first message
        s.lookedAt = now;
        s.file = this.transcriptOf(s, now);
        if (s.file) {
          s.follow = new Follower(s.file);
          s.count = this.countFor(s.file);
          s.count.live = true;
          s.agents = new Agents(path.join(path.dirname(s.file), s.id, 'subagents'), s.follow, (f) => { const c = this.countFor(f); c.live = true; return c; });
        }
      }
      if (s.follow) {
        const before = s.follow.offset;
        s.follow.poll();
        if (s.follow.offset !== before) s.count.dirty = true;
        s.agents.poll(now, rec.status !== 'idle');
      }
      s.note = s.perch.read(path.join(this.perch, `claude-${s.id}.json`));
    }
    // a program that moved on to another conversation (/clear), or ended, leaves its old one behind here
    const holding = new Set();
    for (const l of live.values()) holding.add(l.pid);
    for (const [id, s] of this.sessions) {
      if (live.has(id)) continue;
      this.sessions.delete(id);
      this.lines.delete(id);
      if (!alive(s.pid)) this.noteEnded(s, now);
      // Still running, and holding another conversation: it only moved on, and the old one was set aside, not
      // ended. Still running and holding none: it is on its way out, having taken its own record away first.
      // That conversation ends when the program is gone, which one of the next looks will see.
      else if (!holding.has(s.pid)) this.leaving.set(id, { s, since: now, chat: this.placed.get(s.pid) || '' });
      if (s.count) {
        s.count.live = false;
        for (const a of s.agents.all.values()) a.count.live = false;
        // whatever of it is still uncounted is history from now on
        this.historyAt = 0;
      }
      if (!present.has(s.pid)) this.placed.delete(s.pid);
    }
    for (const [id, l] of this.leaving) {
      // back under its own name (its record was only being rewritten), or its program holds another conversation now
      if (live.has(id) || holding.has(l.s.pid)) { this.leaving.delete(id); continue; }
      if (alive(l.s.pid) && now - l.since < LEAVING_FOR) continue;
      this.leaving.delete(id);
      this.noteEnded(l.s, now, l.chat);
    }
    for (const pid of this.records.keys()) if (!present.has(pid)) this.records.delete(pid);
    if (now - this.codexAt > 10000) { this.codexAt = now; this.readCodex(now); }
    if (now - this.jobsAt > 15000) { this.jobsAt = now; this.readJobs(); }
    if (now - this.loginAt > LOGIN_EVERY) { this.loginAt = now; this.who(now); }
    this.sample();
    this.place(now);
  }

  /** Asked for by the person: at the next look everything is read again, as if it had not been read before. */
  refresh() {
    this.loginAt = 0;
    this.ledger.stamp = '';
    this.lineStamp = 0;
    this.codexAt = 0;
    this.jobsAt = 0;
    this.historyAt = 0;
    for (const s of this.sessions.values()) s.lookedAt = 0;
    this.sent = '';
  }

  // ---- accounts: who is logged in, and what each session says about the limits ----
  /** Run once, before anything is counted: which account was in use when decides where each reply is filed. */
  seed() {
    this.ledger.seed();
    this.timeline();
  }

  timeline() {
    if (this.marksSent === this.ledger.changed) return;
    this.marksSent = this.ledger.changed;
    setTimeline(this.ledger.timeline());
  }

  who(now) {
    if (this.ledger.observe(now)) {
      // sessions carry on under the new login, but what each last heard about the limits is the old account's
      this.epoch++;
      this.sent = '';
    }
    this.timeline();
    if (now - this.ledgerSaved > LEDGER_SAVE) { this.ledgerSaved = now; this.ledger.save(); }
    for (const [id, l] of this.lines) if (!this.sessions.has(id) && now - l.at > LINE_KEPT) this.lines.delete(id);
    if (this.typed && now - this.typedAt > TYPED_IDLE) { this.typed = null; this.typedSize = 0; }
  }

  /**
   * Reads what a session last handed its status line, when that file changed. Every session writes the same
   * file, so each read catches whichever spoke last; looked at twice a second, an active session is caught
   * within moments. An idle one says nothing, and what is shown for it is what it said last.
   */
  sample() {
    let st;
    try { st = fs.statSync(this.lineFile); } catch { return; }
    if (st.mtimeMs === this.lineStamp) return;
    let told;
    // caught mid-write: read again at the next look
    try { told = readJson(this.lineFile); } catch { return; }
    this.lineStamp = st.mtimeMs;
    if (told && typeof told === 'object') this.takeLine(told, Math.round(st.mtimeMs));
  }

  takeLine(told, at) {
    const id = String(told.session_id || '');
    if (!id) return;
    const cost = told.cost || {};
    const cache = told.prompt_cache || {};
    const api = Number(cost.total_api_duration_ms) || 0;
    let l = this.lines.get(id);
    if (!l) this.lines.set(id, l = { epoch: this.epoch, base: api, moved: false, api });
    if (l.epoch !== this.epoch) { l.epoch = this.epoch; l.base = api; l.moved = false; }
    else if (api > l.base) l.moved = true;
    // it has just heard back from the service: what it says about the limits is as of now
    const fresh = api > l.api;
    l.api = api;
    l.at = at;
    // what Claude Code itself reckons the session cost at list prices since its program started, and what it changed
    l.usd = Number(cost.total_cost_usd) || 0;
    l.added = Number(cost.total_lines_added) || 0;
    l.removed = Number(cost.total_lines_removed) || 0;
    // the cache of its conversation: until when it stays warm, and what the next reply re-reads once it has gone cold
    l.warm = Boolean(cache.warm);
    l.cacheUntil = momentOf(cache.expires_at);
    l.cacheCold = Number(cache.recache_tokens_if_cold) || 0;
    l.cacheHit = Number.isFinite(cache.hit_ratio) ? Math.round(cache.hit_ratio * 1000) / 1000 : -1;
    // Whose figures these are. After a /login a session can go on reporting the account it used before (seen on
    // 2 Oct: the old account's weekly figure, 6 minutes after the switch), so the account logged in now is not
    // enough. The 5-hour window tells accounts apart: one on record names its owner. One that is not is a new
    // window, taken to be the account logged in now's once this session is seen calling the service (an old
    // account whose own window closed in between could be taken for it: its next window is told apart again).
    const limits = told.rate_limits || {};
    const five = limits.five_hour;
    const fiveUntil = five ? momentOf(five.resets_at) : 0;
    const owner = (fiveUntil && this.ledger.ownerOf('five', fiveUntil)) || (l.moved || fresh ? this.ledger.current : '');
    if (!owner) return;
    for (const [key, name] of PLAN_WINDOWS) {
      const w = limits[key];
      if (w) this.ledger.reading(owner, name, Number(w.used_percentage), momentOf(w.resets_at), at, fresh);
    }
  }

  // ---- everything typed into a prompt box, for the search ----
  loadTyped() {
    const file = path.join(this.claude, 'history.jsonl');
    let size;
    try { size = fs.statSync(file).size; } catch { return; }
    if (this.typed && size === this.typedSize) return;
    if (!this.typed || size < this.typedSize) { this.typed = []; this.typedSize = 0; }
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
      this.typedSize = eachLine(fd, this.typedSize, size, (line) => {
        let o;
        try { o = JSON.parse(line.toString('utf8')); } catch { return; }
        const d = String(o.display || '').trim();
        // a slash command is not something asked
        if (!d || d[0] === '/') return;
        // cut through a buffer: a plain slice would keep the whole of a long paste alive
        this.typed.push({
          d: d.length > TYPED_KEPT ? Buffer.from(d.slice(0, TYPED_KEPT), 'utf8').toString('utf8') : d,
          at: Number(o.timestamp) || 0, cwd: String(o.project || ''), id: String(o.sessionId || ''),
        });
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  /** What was typed, ever, that holds every word of `query`: newest first. */
  typedFor(query) {
    this.loadTyped();
    this.typedAt = Date.now();
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length || !this.typed) return [];
    const out = [];
    const had = new Set();
    for (let i = this.typed.length - 1; i >= 0 && out.length < TYPED_SHOWN; i--) {
      const t = this.typed[i];
      const hay = t.d.toLowerCase();
      if (had.has(t.d) || !words.every((w) => hay.includes(w))) continue;
      had.add(t.d);
      // its conversation can be opened again when its transcript is still on disk
      const there = Boolean(t.id) && fs.existsSync(path.join(this.projects, t.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${t.id}.jsonl`));
      out.push({ text: t.d, at: t.at, cwd: t.cwd, session: t.id, live: this.sessions.has(t.id), there });
    }
    return out;
  }

  // ---- conversations whose program ended a while ago: they can be picked up again, here ----
  loadEnded() {
    if (!this.endedFile) return;
    try {
      const list = readJson(this.endedFile).list;
      // Which chat of the window it ran in was true for the run that wrote the file. Chats are numbered afresh at
      // every start, so here that number would point at another chat.
      if (Array.isArray(list)) this.ended = list.filter((e) => e && typeof e.id === 'string' && typeof e.cwd === 'string' && Date.now() - e.at < ENDED_FOR).map((e) => ({ ...e, chat: '' }));
    } catch { /* none kept */ }
  }

  saveEnded() {
    if (!this.endedFile) return;
    try {
      fs.writeFileSync(this.endedFile + '.tmp', JSON.stringify({ list: this.ended }));
      fs.renameSync(this.endedFile + '.tmp', this.endedFile);
    } catch { /* kept in memory all the same */ }
  }

  /** chat: the chat of this window it ran in, when that was noted before its program left; looked up otherwise. */
  noteEnded(s, now, chat) {
    const rec = s.rec;
    // what it wrote on its way out belongs to it too
    if (s.follow) { try { s.follow.poll(); } catch { /* the file went with it */ } }
    const st = s.follow ? s.follow.state : null;
    // nothing to pick up without a transcript; a background session and a terminal that handed its
    // conversation to one are not conversations that ended
    if (!st || !st.at || rec.kind === 'bg' || rec.parkedJobId || (rec.entrypoint && rec.entrypoint !== 'cli')) return;
    this.ended = this.ended.filter((e) => e.id !== s.id);
    this.ended.unshift({
      id: s.id,
      name: String(rec.name || ''),
      named: rec.nameSource === 'user' || rec.nameSource === 'peer',
      title: st.title,
      cwd: String(rec.cwd || st.cwd || ''),
      mode: st.mode,
      at: now,
      words: clip(st.said, 240),
      prompt: clip(st.prompt, 240),
      // the chat of this window it ran in, '' for some other terminal
      chat: chat !== undefined ? chat : this.placed.get(s.pid) || '',
      // it was cut off in the middle of a turn: the answer in progress was lost
      cut: rec.status === 'busy' && !st.turnEnd,
    });
    this.ended = this.ended.filter((e) => now - e.at < ENDED_FOR).slice(0, ENDED_KEPT);
    this.saveEnded();
    this.sent = '';
  }

  forgetEnded(id) {
    if (!this.ended.some((e) => e.id === id)) return;
    this.ended = this.ended.filter((e) => e.id !== id);
    this.saveEnded();
    this.sent = '';
  }

  /** Codex sessions, known only through what the Perch hook noted about them. */
  readCodex(now) {
    const list = [];
    let names = [];
    try { names = fs.readdirSync(this.perch); } catch { /* the hook is not installed */ }
    for (const name of names) {
      if (!name.startsWith('codex-') || !name.endsWith('.json')) continue;
      const file = path.join(this.perch, name);
      try {
        if (now - fs.statSync(file).mtimeMs > 24 * HOUR) continue;
        const r = readJson(file);
        const pid = Number(r.agent_pid) || 0;
        if (r.status === 'ended' || r.headless || !pid || !alive(pid)) continue;
        list.push({ id: String(r.session_id || name.slice(6, -5)), pid, note: r });
      } catch { /* mid-write, or gone since the listing */ }
    }
    this.codex = list;
  }

  readJobs() {
    const dir = path.join(this.claude, 'jobs');
    const list = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* none */ }
    for (const name of names) {
      try {
        const st = readJson(path.join(dir, name, 'state.json'));
        list.push({
          id: name,
          name: clip(st.name || name, 100),
          state: String(st.state || ''),
          tempo: String(st.tempo || ''),
          needs: clip(st.needs, 400),
          detail: clip(st.detail, 240),
          cwd: String(st.cwd || ''),
          session: String(st.sessionId || ''),
          at: Date.parse(st.updatedAt) || 0,
        });
      } catch { /* not a job folder */ }
    }
    list.sort((a, b) => b.at - a.at);
    this.jobs = list;
  }

  // ---- which sessions run inside this window ----
  /** jobs: [background session id, chat id] for the chats that are the view of one; it runs outside every console here. */
  setShells(pairs, jobs) {
    this.shells = new Map(pairs);
    this.attached = new Map(jobs || []);
    const open = new Set(this.shells.values());
    // a chat that closed, and the sessions seen before their own chat was known, are asked about again
    for (const [pid, chat] of this.placed) if (!chat || !open.has(chat)) this.placed.delete(pid);
    this.sent = '';
  }

  /**
   * Asks Windows who started whom, once, whenever a session shows up that has not been placed yet. Only while the
   * helper that measures the programs is not answering: its answers place the sessions too.
   */
  place(now) {
    if (this.procs && this.procs.ready) return;
    if (this.asking || !this.shells.size || now - this.askedAt < 4000) return;
    const pids = [...this.sessions.values()].map((s) => s.pid).concat(this.codex.map((c) => c.pid));
    if (pids.every((pid) => this.placed.has(pid))) return;
    this.asking = true;
    this.askedAt = now;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'],
    { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      this.asking = false;
      if (err) return;
      const parent = new Map();
      for (const line of out.split(/\r?\n/)) {
        const [pid, ppid] = line.trim().split(' ').map(Number);
        if (pid) parent.set(pid, ppid);
      }
      for (const pid of pids) {
        let chat = '';
        // a session sits one or two programs below its shell
        for (let p = pid, hop = 0; p && hop < 12; p = parent.get(p), hop++) {
          if (this.shells.has(p)) { chat = this.shells.get(p); break; }
        }
        this.placed.set(pid, chat);
      }
      this.sent = '';
    });
  }

  // ---- what the programs under the sessions use ----
  /**
   * Asks the helper about every session's program, every chat's console and this app, and works out what each
   * uses. Resolves to what the window shows, or null when it is not time yet or there is no answer. A session not
   * yet placed in a chat of this window is looked at sooner, even while the window is out of sight.
   */
  async measure(now) {
    if (!this.procs || this.measuring || this.procs.failed) return null;
    const pids = [...this.sessions.values()].map((s) => s.pid).concat(this.codex.map((c) => c.pid));
    const unplaced = this.shells.size > 0 && pids.some((pid) => !this.placed.has(pid));
    if (now - this.measureAt < (unplaced ? Math.min(this.measureEvery, 4000) : this.measureEvery)) return null;
    this.measuring = true;
    this.measureAt = now;
    let got = null;
    try {
      // this app's own program (the thread runs inside it), the consoles of its chats, and every session
      got = await this.procs.sample([...new Set([process.pid, ...this.shells.keys(), ...pids])].filter((pid) => pid > 0));
    } finally {
      this.measuring = false;
    }
    return got ? this.takeMeasure(got, Date.now()) : null;
  }

  takeMeasure(got, now) {
    const rows = new Map();
    for (const [pid, ppid, name, started, ws, mem, cpu, kind, label] of got.p) {
      rows.set(pid, { pid, ppid, name: String(name || ''), started, ws, mem, cpu, kind: String(kind || ''), label: String(label || ''), kids: [], ports: [] });
    }
    for (const r of rows.values()) {
      const up = rows.get(r.ppid);
      // a parent's number can go to a new program once it ends: a child older than its parent is not its child
      if (up && up !== r && !(r.started && up.started && r.started < up.started)) up.kids.push(r);
    }
    for (const [port, pid] of got.l) { const r = rows.get(pid); if (r) r.ports.push(port); }
    // processor: what each program used since the last look, as a share of the whole machine. Nothing to compare
    // with at the first look: unknown, not zero.
    const cores = os.cpus().length || 1;
    const before = this.cpuBefore;
    const span = this.cpuAt ? now - this.cpuAt : 0;
    this.cpuBefore = new Map();
    for (const r of rows.values()) {
      const key = `${r.pid}:${r.started}`;
      this.cpuBefore.set(key, r.cpu);
      const was = before.get(key);
      // One seen at the last look: what it used since. One born since: all it has used. One that is older and was
      // not looked at then (its session has only just been found): not known until the next look, since what it
      // used before would all be counted as used now.
      const used = was !== undefined ? r.cpu - was : r.started >= this.cpuAt ? r.cpu : null;
      r.load = span > 200 && used !== null ? Math.max(0, used / span / cores * 100) : null;
    }
    this.cpuAt = now;

    /**
     * A program and everything under it, added up. stop: programs (with what is under them) left out. Its share
     * of the processor is known once the program at the top has been looked at twice; one under it that is not
     * known yet adds nothing, instead of blanking the whole figure.
     */
    const total = (root, stop) => {
      const t = { mem: 0, ws: 0, cpu: 0, n: 0, ports: [] };
      const seen = new Set();
      const walk = [root];
      while (walk.length) {
        const r = walk.pop();
        if (seen.has(r) || (stop && r !== root && stop.has(r.pid))) continue;
        seen.add(r);
        t.mem += r.mem;
        t.ws += r.ws;
        if (r.load !== null) t.cpu += r.load;
        t.n++;
        t.ports.push(...r.ports);
        walk.push(...r.kids);
      }
      return { mem: t.mem, ws: t.ws, cpu: root.load === null ? null : Math.round(t.cpu * 10) / 10, n: t.n, ports: [...new Set(t.ports)].sort((a, b) => a - b) };
    };
    /** What a program started by a session is: worked out from it and what runs under it. */
    const what = (top, root) => {
      const all = [];
      const seen = new Set();
      const walk = [top];
      while (walk.length) {
        const r = walk.shift();
        if (seen.has(r)) continue;
        seen.add(r);
        all.push(r);
        walk.push(...r.kids);
      }
      const named = (r) => r.name.replace(/\.exe$/i, '').toLowerCase();
      const mcp = all.find((r) => r.kind === 'mcp');
      if (mcp) return { kind: 'mcp', label: (all.find((r) => r.kind === 'mcp' && r.label) || mcp).label };
      const serving = all.find((r) => r.ports.length);
      const tool = all.find((r) => r.kind === 'tool' && r.label);
      if (serving) return { kind: 'server', label: (tool && tool.label) || serving.label || named(serving) };
      if (all.some((r) => r.kind === 'claude')) return { kind: 'claude', label: 'claude' };
      if (tool) return { kind: 'tool', label: tool.label };
      // the program that does the work, not the shell or launcher it runs in
      const main = all.filter((r) => !WRAPPER.test(r.name)).sort((a, b) => b.mem - a.mem)[0];
      // started together with its session: Claude Code starts its MCP servers that way
      if (top.started && root.started && top.started - root.started < 30000 && !SHELL.test(top.name)) return { kind: 'start', label: named(main || top) };
      if (SHELL.test(top.name)) return { kind: 'command', label: main ? named(main) : named(top) };
      return { kind: 'program', label: named(main || top) };
    };
    /** One session: its own program, then each program it started, biggest first. */
    const describe = (root) => {
      const own = { mem: root.mem, cpu: root.load };
      const items = [];
      for (const k of root.kids) {
        // the console window a program opens for its tools is part of what that program costs
        if (/^conhost\.exe$/i.test(k.name) && !k.kids.length) {
          own.mem += k.mem;
          if (own.cpu !== null && k.load !== null) own.cpu += k.load;
          continue;
        }
        const t = total(k);
        items.push({ ...what(k, root), mem: t.mem, cpu: t.cpu, n: t.n, ports: t.ports, started: k.started });
      }
      items.sort((a, b) => b.mem - a.mem);
      const t = total(root);
      const rest = items.slice(ITEMS_SHOWN);
      return {
        mem: t.mem, ws: t.ws, cpu: t.cpu, n: t.n, ports: t.ports, started: root.started,
        own: { mem: own.mem, cpu: own.cpu === null ? null : Math.round(own.cpu * 10) / 10 },
        items: items.slice(0, ITEMS_SHOWN),
        more: rest.length ? { n: rest.length, mem: rest.reduce((a, x) => a + x.mem, 0) } : null,
      };
    };

    const out = { at: now, cores, memory: os.totalmem(), sessions: {}, chats: {}, app: null, all: null, servers: [] };
    const sessionPids = new Map();
    for (const s of this.sessions.values()) sessionPids.set(s.pid, s.id);
    for (const c of this.codex) sessionPids.set(c.pid, `codex:${c.id}`);
    for (const [pid, key] of sessionPids) { const r = rows.get(pid); if (r) out.sessions[key] = describe(r); }

    // which chat of this window each session runs in: the one whose console it runs under
    const placed = new Map();
    for (const [shell, chat] of this.shells) {
      const r = rows.get(shell);
      if (!r) continue;
      const t = total(r);
      out.chats[chat] = { mem: t.mem, cpu: t.cpu, n: t.n, ports: t.ports };
      const walk = [r];
      const seen = new Set();
      while (walk.length) {
        const x = walk.pop();
        if (seen.has(x)) continue;
        seen.add(x);
        if (sessionPids.has(x.pid)) placed.set(x.pid, chat);
        walk.push(...x.kids);
      }
    }
    let moved = false;
    for (const pid of sessionPids.keys()) {
      const chat = placed.get(pid) || '';
      if (this.placed.get(pid) !== chat) { this.placed.set(pid, chat); moved = true; }
    }
    if (moved) this.sent = '';

    // this app: its window, its helpers and the consoles it draws, without what its chats run
    const me = rows.get(process.pid);
    if (me) {
      const t = total(me, new Set(this.shells.keys()));
      out.app = { mem: t.mem, cpu: t.cpu, n: t.n };
    }
    // Which session each program runs under. A session started inside another (by one of its commands) runs its
    // own programs: sessions are walked oldest first, so the newest one that holds a program keeps it.
    const owner = new Map();
    const order = [...sessionPids].map(([pid, key]) => ({ r: rows.get(pid), key })).filter((x) => x.r).sort((a, b) => (a.r.started || 0) - (b.r.started || 0));
    for (const { r, key } of order) {
      const walk = [r];
      const seen = new Set();
      while (walk.length) {
        const x = walk.pop();
        if (seen.has(x)) continue;
        seen.add(x);
        owner.set(x, key);
        walk.push(...x.kids);
      }
    }
    // every session together, each program counted once; and every port one of them listens on
    const all = { mem: 0, cpu: 0, known: 0, n: 0 };
    for (const [r, key] of owner) {
      all.mem += r.mem;
      if (r.load !== null) { all.cpu += r.load; all.known++; }
      all.n++;
      for (const port of r.ports) {
        const s = out.sessions[key];
        const holder = s && s.items.find((i) => i.ports.includes(port));
        out.servers.push({ port, key, label: holder ? holder.label : r.name.replace(/\.exe$/i, '').toLowerCase(), kind: holder ? holder.kind : 'program' });
      }
    }
    out.all = { mem: all.mem, cpu: all.known ? Math.round(all.cpu * 10) / 10 : null, n: all.n, sessions: order.length };
    out.servers.sort((a, b) => a.port - b.port);
    return out;
  }

  // ---- counting, a little at a time ----
  /**
   * How today's lines of a transcript get counted before the rest of it: 'early', a short count of their own
   * that starts where today starts (found by halving, not by reading); 'whole', by finishing the count, when
   * little of it is left; 'none', when nothing was written to it today. Without this the first run shows no
   * number for today until gigabytes of old conversation have been read.
   */
  todayPlan(c, now, midnight) {
    if (c.early) return 'early';
    // 'early' without its short count: that count is gone (the full count reached it, or the file was
    // replaced under it), and the full count carries on from where it stands
    if (c.todayAt && now - c.todayAt < TODAY_AGAIN) return c.today === 'early' ? 'whole' : c.today;
    c.todayAt = now;
    let st;
    try { st = fs.statSync(c.file); } catch { return (c.today = 'none'); }
    c.size = st.size;
    c.mtime = st.mtimeMs;
    if (st.mtimeMs < midnight) return (c.today = 'none');
    if (st.size - c.offset < EARLY_MIN) return (c.today = 'whole');
    const from = seekTime(c.file, midnight);
    // today starts close to where the count stands: finishing the count is as quick
    if (from < 0 || from - c.offset < EARLY_MIN / 2) return (c.today = 'whole');
    c.early = Tally.from(from);
    // the first day the short count speaks for. Its own name: `day` is a method of the count and `first` one of its fields
    c.early.fromDay = dayKey(midnight);
    c.early.dirty = true;
    return (c.today = 'early');
  }

  /** Counts for a moment. True while some transcript is still waiting to be counted. */
  count() {
    if (!this.counting) return false;
    const started = Date.now();
    if (started - this.historyAt > HISTORY_EVERY) this.scanHistory(started);
    const sessions = [...this.sessions.values()].filter((s) => s.count);
    // the chats inside this window first, then every other running session, then history from the newest back
    sessions.sort((a, b) => (this.placed.get(a.pid) ? 0 : 1) - (this.placed.get(b.pid) ? 0 : 1));
    const over = () => Date.now() - started > COUNT_BUDGET_MS;
    const walk = (c) => {
      while (c.dirty) {
        const before = c.offset;
        c.dirty = c.step(c.file);
        if (c.offset !== before) { c.changed = true; this.unsaved = true; }
        // the full count has read as far as the count of today's lines: that one has done its job
        if (c.early && c.offset >= c.early.offset) c.early = null;
        if (!c.dirty && !c.live) c.rest();
        if (over()) return true;
      }
      return false;
    };
    const dayStart = new Date(started);
    dayStart.setHours(0, 0, 0, 0);
    const midnight = dayStart.getTime();
    const today = (c) => {
      const plan = this.todayPlan(c, started, midnight);
      if (plan === 'whole') return walk(c);
      if (plan !== 'early') return false;
      const e = c.early;
      while (e.dirty) {
        e.dirty = e.step(c.file);
        // not the file it was started on: the full count takes it from here
        if (e.offset < e.began) { c.early = null; break; }
        if (over()) return true;
      }
      return false;
    };
    // today first: the running sessions, their subagents that moved today, then the history written to today
    for (const s of sessions) if (today(s.count)) return true;
    for (const s of sessions) for (const a of s.agents.all.values()) if (a.mtime >= midnight && walk(a.count)) return true;
    for (const c of this.history) {
      if (c.mtime < midnight) break;
      if (c.dirty && today(c)) return true;
    }
    this.todayDone = true;
    for (const s of sessions) if (walk(s.count)) return true;
    for (const s of sessions) for (const a of s.agents.all.values()) if (walk(a.count)) return true;
    while (this.historyNext < this.history.length) {
      if (walk(this.history[this.historyNext])) return true;
      this.historyNext++;
    }
    return false;
  }

  /**
   * The lines running sessions wrote since the last look, counted before the picture is taken: without this
   * their numbers trail what they are doing by a round of counting, and read as "still counting" every time
   * they write. Only for what is nearly counted already, or small: a conversation with gigabytes still to
   * read keeps its place in the slow count.
   */
  catchUp() {
    if (!this.counting) return;
    const until = Date.now() + CATCH_UP_MS;
    /** False once the time for this look is used up: a session can have hundreds of small subagent files. */
    const top = (c, size) => {
      // the short count of today's lines keeps up with the session too
      const e = c.early;
      if (e && size > e.offset && size - e.offset <= CATCH_UP) e.dirty = e.step(c.file);
      if (!c.dirty || size <= c.offset || size - c.offset > CATCH_UP) return true;
      const before = c.offset;
      c.dirty = c.step(c.file);
      if (c.offset !== before) { c.changed = true; this.unsaved = true; }
      if (c.early && c.offset >= c.early.offset) c.early = null;
      return Date.now() < until;
    };
    // First the few new lines of what was counted before, and a conversation that only just began: that is
    // what keeps the numbers level. Small subagent files never read come after, with the time that is left.
    for (const s of this.sessions.values()) {
      if (!s.count) continue;
      if (!top(s.count, s.follow.offset)) return;
      for (const a of s.agents.all.values()) if (a.count.offset > 0 && !top(a.count, a.size)) return;
    }
    for (const s of this.sessions.values()) {
      if (!s.count) continue;
      for (const a of s.agents.all.values()) if (a.count.offset === 0 && !top(a.count, a.size)) return;
    }
  }

  /** What the conversation and its subagents add up to. share: how much of it has been counted so far. */
  tokensOf(s) {
    const t = s.count.totals();
    let tools = s.count.tools;
    let read = Math.min(s.count.offset, s.follow.offset);
    let size = Math.max(0, s.follow.offset);
    for (const a of s.agents.all.values()) {
      const at = a.count.sum;
      for (let i = 0; i < 4; i++) t[i] += at[i];
      tools += a.count.tools;
      read += Math.min(a.count.offset, a.size);
      size += a.size;
    }
    const counted = size <= 0 || (s.count.offset > 0 && size - read < SMALL_LAG);
    return { in: t[0], out: t[1], cacheWrite: t[2], cacheRead: t[3], tools, share: counted ? 1 : Math.min(1, read / size) };
  }

  /**
   * The same, for today only. whole: today's lines of it are all counted. They sit at the end of each file,
   * so they are in once the count that covers them (the short one of today's lines, else the full one) has
   * got there; a file nothing was written to since `midnight` holds none.
   */
  dayOf(s, key, midnight) {
    const v = [0, 0, 0, 0, 0, 0];
    let asked = 0;
    let tools = 0;
    let agents = 0;
    let whole = true;
    const add = (c, size, moved) => {
      if (moved >= midnight && size - (c.early ? c.early.offset : c.offset) > SMALL_LAG) whole = false;
      const d = dayIn(c, key);
      if (!d) return;
      dayTotals(d, v);
      asked += d.asked;
      tools += toolsOf(d);
      agents += d.agents;
    };
    add(s.count, s.follow.offset, s.follow.state.at || 0);
    for (const a of s.agents.all.values()) add(a.count, a.size, a.mtime);
    return { in: v[0], out: v[1], cacheWrite: v[2], cacheRead: v[3], replies: v[4], work: v[5], asked, tools, agents, whole };
  }

  /** Where the memory of sessions on `model` stood when one last compacted on its own; 0 when none ever did. */
  ceilingOf(model, now) {
    if (now - this.ceilingsAt > 60000) {
      this.ceilingsAt = now;
      const newest = new Map();
      for (const c of this.counts.values()) {
        if (!c.pre || !c.preModel) continue;
        const had = newest.get(c.preModel);
        if (!had || c.preAt > had.at) newest.set(c.preModel, { pre: c.pre, at: c.preAt });
      }
      this.ceilings = newest;
    }
    const known = this.ceilings.get(model);
    return known ? known.pre : 0;
  }

  // ---- what the window shows ----
  stateOf(s) {
    const status = s.rec.status;
    // the CLI's own word for "a prompt is open and nothing moves until the person answers"
    if (status === 'waiting') return 'attention';
    const st = s.follow ? s.follow.state : null;
    if (status === 'busy') {
      const note = s.note;
      // the hook notes the start of a compaction; it holds until the session writes again
      const compacting = note && note.status === 'compacting' && (Date.parse(note.timestamp) || 0) >= (st ? st.at : 0) - 1500;
      return compacting ? 'compacting' : 'working';
    }
    return st && st.failed ? 'error' : 'idle';
  }

  /**
   * One entry per conversation: the running sessions, the background sessions
   * (running or not) and the Codex ones. A terminal that handed its
   * conversation to a background session is left out and the background
   * session shown in its place, as the CLI's own list does.
   */
  snapshot() {
    const now = Date.now();
    const today = dayKey(now);
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const midnight = dayStart.getTime();
    const chats = [];
    const jobs = new Map(this.jobs.map((j) => [j.id, j]));
    const parked = new Map();    // background session id -> the desk chat of the terminal it came from
    for (const s of this.sessions.values()) if (s.rec.parkedJobId) parked.set(s.rec.parkedJobId, this.placed.get(s.pid) || '');
    const running = new Set();
    for (const s of this.sessions.values()) {
      const rec = s.rec;
      if (rec.parkedJobId) continue;
      const job = rec.jobId ? jobs.get(rec.jobId) : null;
      if (job) running.add(job.id);
      const f = s.follow;
      const st = f ? f.state : null;
      let state = this.stateOf(s);
      let waiting = state === 'attention' ? String(rec.waitingFor || '') : '';
      let words = st ? st.said : '';
      const told = job ? jobState(job) : '';
      if (told === 'attention') { state = 'attention'; waiting = 'blocked'; words = job.needs || words; }
      else if (told === 'error') state = 'error';
      const tool = f && (state === 'working' || state === 'compacting' || (state === 'attention' && !told)) ? f.running() : null;
      if (state === 'attention' && waitsForPerson(tool) && tool.what) words = tool.what;
      // busy with its turn over: the CLI is only waiting on work it started in the background
      const background = state === 'working' && Boolean(st && st.turnEnd) && !tool;
      const flipped = Number(rec.statusUpdatedAt) || 0;
      const pulse = new Array(PULSE).fill(0);
      if (f) { f.pulse(now, pulse); s.agents.pulse(now, pulse); }
      chats.push({
        key: s.id,
        session: s.id,
        provider: 'claude',
        pid: s.pid,
        name: String(rec.name || ''),
        named: rec.nameSource === 'user' || rec.nameSource === 'peer',
        title: st ? st.title : '',
        cwd: String(rec.cwd || ''),
        kind: rec.kind === 'bg' ? 'bg' : 'interactive',
        state,
        waiting,
        background,
        since: told === 'attention' ? job.at : state === 'working' && !background ? (st && st.turnStart) || flipped : flipped,
        at: Math.max((st && st.at) || 0, s.agents ? Math.round(s.agents.newest) : 0, flipped),
        started: Number(rec.startedAt) || 0,
        words,
        prompt: st ? st.prompt : '',
        doing: tool ? { name: tool.name, what: tool.what, at: tool.at } : null,
        turn: st ? {
          start: st.turnStart,
          end: st.turnEnd,
          ms: st.turnMs,
          count: st.toolCount,
          tools: st.tools.slice(-TOOLS_SHOWN).map((t) => ({ name: t.name, what: t.what, at: t.at, done: t.done })),
        } : null,
        agents: s.agents ? s.agents.view(now) : { total: 0, running: 0, list: [] },
        tokens: s.count ? this.tokensOf(s) : null,
        today: s.count ? this.dayOf(s, today, midnight) : null,
        pulse,
        context: (st && st.context) || (s.note && Number(s.note.context_tokens)) || 0,
        // where its memory stood when it last compacted on its own, about where it will again; failing that,
        // where another session on the same model did
        ceiling: (s.count && s.count.pre) || this.ceilingOf((st && st.model) || '', now),
        ceilingOwn: Boolean(s.count && s.count.pre),
        compacts: s.count ? s.count.compacts : 0,
        // the service turned it down for a usage limit that has not lifted yet
        limit: st && st.limit && st.limit.until > now && state === 'error' ? st.limit : null,
        recap: st ? st.recap : '',
        recapAt: st ? st.recapAt : 0,
        queued: st ? st.queued : 0,
        cost: s.count && s.count.cost ? s.count.cost : null,
        live: this.lineOf(s.id),
        model: (st && st.model) || (s.note && String(s.note.model || '')) || '',
        effort: st ? st.effort : '',
        mode: st ? st.mode : '',
        job: job ? job.id : '',
        chat: this.placed.get(s.pid) || (job && (this.attached.get(job.id) || parked.get(job.id))) || '',
      });
    }
    for (const job of this.jobs) {
      // one whose program is not running: all there is to show is what it left behind
      const state = jobState(job);
      if (running.has(job.id) || state === 'ended') continue;
      chats.push({
        key: `job:${job.id}`,
        session: job.session,
        provider: 'claude',
        pid: 0,
        name: job.name,
        named: true,
        title: '',
        cwd: job.cwd,
        kind: 'bg',
        state,
        waiting: state === 'attention' ? 'blocked' : '',
        background: false,
        since: job.at,
        at: job.at,
        started: 0,
        words: job.needs || job.detail,
        prompt: '',
        doing: null,
        turn: null,
        agents: { total: 0, running: 0, list: [] },
        tokens: null,
        today: null,
        pulse: null,
        context: 0,
        ceiling: 0,
        ceilingOwn: false,
        compacts: 0,
        limit: null,
        recap: '',
        recapAt: 0,
        queued: 0,
        cost: null,
        live: this.lineOf(job.session),
        model: '',
        effort: '',
        mode: '',
        job: job.id,
        chat: this.attached.get(job.id) || parked.get(job.id) || '',
      });
    }
    for (const c of this.codex) {
      const r = c.note;
      const at = Date.parse(r.timestamp) || 0;
      const state = ['working', 'attention', 'compacting', 'error'].includes(r.status) ? r.status : 'idle';
      chats.push({
        key: `codex:${c.id}`,
        session: c.id,
        provider: 'codex',
        pid: c.pid,
        name: '',
        named: false,
        title: '',
        cwd: String(r.cwd || ''),
        kind: 'interactive',
        state,
        waiting: '',
        background: false,
        since: at,
        at,
        started: 0,
        // while it works the hook's note is the prompt it was given, not something it said
        words: state === 'working' ? '' : clip(r.message, 600),
        prompt: '',
        doing: null,
        turn: null,
        agents: { total: 0, running: 0, list: [] },
        tokens: null,
        today: null,
        pulse: null,
        context: Number(r.context_tokens) || 0,
        ceiling: 0,
        ceilingOwn: false,
        compacts: 0,
        limit: null,
        recap: '',
        recapAt: 0,
        queued: 0,
        cost: null,
        live: null,
        model: String(r.model || ''),
        effort: '',
        mode: '',
        job: '',
        chat: this.placed.get(c.pid) || '',
      });
    }
    const ended = this.ended.filter((e) => now - e.at < ENDED_FOR);
    // closed, with their program still on its way out: neither running nor ended yet, for a few seconds
    const leaving = [...this.leaving.keys()];
    const accounts = this.ledger.view(now);
    // the limits of the account logged in now, by themselves: what the tray and the notes near the clock go by
    const me = accounts.list.find((a) => a.here);
    const open = (w) => (w && w.until > now ? w : null);
    const plan = me && (open(me.five) || open(me.week)) ? { five: open(me.five), week: open(me.week) } : null;
    // when a limit was last reported moves every few seconds: to the minute is enough to send it again for
    const told = (w) => w && [w.used, w.until, Math.floor(w.at / 60e3)];
    const key = accounts.list.map((a) => [a.key, a.email, a.plan, a.here, a.to, told(a.five), told(a.week), a.pace.five, a.pace.week]);
    const body = JSON.stringify([chats, ended, leaving, accounts.current, key, this.ledger.changed]);
    if (body === this.sent) return null;
    this.sent = body;
    return { at: now, chats, ended, leaving, plan, accounts };
  }

  // ---- one conversation read for the eye, and every conversation kept on this machine ----
  /**
   * The transcript a key stands for: a running session, a background session ('job:<id>'), or any
   * conversation still on disk. agent: one of its subagents instead. '' when there is none. Only ever a
   * file under the CLI's own projects folder: the key is an id, never a path.
   */
  fileOf(key, agent) {
    let id = String(key || '');
    if (id.startsWith('job:')) {
      const job = this.jobs.find((j) => j.id === id.slice(4));
      id = job ? job.session : '';
    }
    if (!SESSION_ID.test(id)) return '';
    const s = this.sessions.get(id);
    let file = s && s.file ? s.file : '';
    if (!file) {
      for (const c of this.counts.values()) if (!c.sub && c.session === id && fs.existsSync(c.file)) { file = c.file; break; }
    }
    if (!file) {
      let dirs = [];
      try { dirs = fs.readdirSync(this.projects); } catch { return ''; }
      for (const dir of dirs) {
        const guess = path.join(this.projects, dir, `${id}.jsonl`);
        if (fs.existsSync(guess)) { file = guess; break; }
      }
    }
    if (!file || !agent) return file;
    if (!AGENT_ID.test(String(agent))) return '';
    const sub = path.join(path.dirname(file), id, 'subagents', `agent-${agent}.jsonl`);
    return fs.existsSync(sub) ? sub : '';
  }

  /** One page of a conversation: see readPage. null when it has no transcript. */
  page(m) {
    const file = this.fileOf(m.key, m.agent);
    return file ? readPage(file, { before: Number(m.before) || 0, after: Number.isFinite(m.after) ? m.after : -1 }) : null;
  }

  /**
   * Every conversation kept on this machine, newest first: what it is called, where it ran, what it came to.
   * What a conversation is called and what was last asked of it sit near the end of its file: read once per
   * file, and again only when the file has grown.
   */
  conversations() {
    const now = Date.now();
    if (now - this.historyAt > HISTORY_FRESH) this.scanHistory(now);
    const subs = new Map();      // conversation -> [subagent files, tokens they wrote]
    const mains = [];
    let bytes = 0;
    for (const c of this.counts.values()) {
      bytes += c.size || 0;
      if (!c.sub) { mains.push(c); continue; }
      const had = subs.get(c.session);
      if (had) { had[0]++; had[1] += c.sum[1]; } else subs.set(c.session, [1, c.sum[1]]);
    }
    mains.sort((a, b) => b.mtime - a.mtime);
    const list = mains.slice(0, HISTORY_SHOWN).map((c) => {
      const s = this.sessions.get(c.session);
      const st = s && s.follow ? s.follow.state : null;
      let p = c.peek;
      if (st) {
        p = { title: st.title, name: s.rec.nameSource === 'user' ? String(s.rec.name || '') : '', prompt: st.prompt, cwd: String(s.rec.cwd || st.cwd || ''), mode: st.mode };
      } else {
        const stamp = `${c.size}:${c.mtime}`;
        if (c.peekStamp !== stamp) { c.peek = p = peekTail(c.file); c.peekStamp = stamp; }
      }
      const sub = subs.get(c.session);
      return {
        id: c.session, project: c.project, cwd: p.cwd || c.cwd, title: p.title || c.title, name: p.name, prompt: p.prompt, mode: p.mode,
        at: Math.round(c.mtime), first: c.first, size: c.size || 0, model: c.model,
        // counted: its numbers are whole; until then they are what was read so far
        out: c.sum[1] + (sub ? sub[1] : 0), replies: c.replies, tools: c.tools, compacts: c.compacts, agents: sub ? sub[0] : 0,
        usd: c.cost ? c.cost.usd : 0, added: c.cost ? c.cost.added : 0, removed: c.cost ? c.cost.removed : 0,
        counted: !c.dirty && c.offset > 0, live: Boolean(s),
      };
    });
    return { at: now, list, total: mains.length, bytes, counting: this.counting };
  }

  /** What a session last handed its status line, as the window shows it; null when it never spoke, or not while this app looked. */
  lineOf(id) {
    const l = id ? this.lines.get(id) : null;
    if (!l) return null;
    return { usd: l.usd, added: l.added, removed: l.removed, warm: l.warm, cacheUntil: l.cacheUntil, cacheCold: l.cacheCold, cacheHit: l.cacheHit };
  }

  /**
   * What every transcript on the machine adds up to. range: 'today', '7d' or
   * '30d' for the breakdowns; the day-by-day and hour-by-hour series are
   * always whole.
   */
  stats(range) {
    const now = Date.now();
    const noon = new Date(now);
    noon.setHours(12, 0, 0, 0);
    const keys = [];
    for (let i = 29; i >= 0; i--) keys.push(dayKey(noon.getTime() - i * DAY));
    const span = range === '30d' ? 30 : range === '7d' ? 7 : 1;
    const inRange = new Set(keys.slice(-span));
    const today = keys[29];
    const yesterday = keys[28];
    const zero = () => ({ in: 0, out: 0, cacheWrite: 0, cacheRead: 0, replies: 0, work: 0, asked: 0, tools: 0, agents: 0, think: 0, web: 0, comp: 0, compMs: 0, err: 0, lim: 0 });
    const days = new Map(keys.map((k) => [k, { day: k, ...zero(), who: {} }]));
    // the 48 hours up to the end of today, one slot per hour: yesterday's 24, then today's
    const hours = Array.from({ length: 48 }, () => ({ in: 0, out: 0, cacheWrite: 0, cacheRead: 0, replies: 0, work: 0 }));
    const total = zero();
    const models = new Map();
    const projects = new Map();
    const tools = new Map();
    const chats = new Map();
    const who = new Map();       // account -> what was done under it in the range
    const lanes = new Map();     // conversation -> its work and output today, hour by hour
    const limits = new Map();    // which limit, lifting when -> when it was first run into, and by how many conversations
    const names = new Map();     // project folder -> the name of the folder it stands for
    const titles = new Map();    // conversation -> its title
    const folders = new Map();   // conversation -> the folder it ran in
    const recorded = { usd: 0, added: 0, removed: 0, conversations: 0 };
    const reading = { files: 0, done: 0, bytes: 0, read: 0 };
    const group = (map, key) => {
      let g = map.get(key);
      if (!g) map.set(key, g = { key, in: 0, out: 0, cacheWrite: 0, cacheRead: 0, replies: 0, work: 0, asked: 0 });
      return g;
    };
    for (const c of this.counts.values()) {
      reading.files++;
      reading.bytes += c.size;
      reading.read += Math.min(c.offset, c.size);
      if (!c.dirty) reading.done++;
      if (!c.sub) {
        if (c.cwd && !names.has(c.project)) names.set(c.project, leaf(c.cwd));
        if (c.title) titles.set(c.session, c.title);
        if (c.cwd) folders.set(c.session, c.cwd);
        if (c.cost && c.cost.at >= now - 30 * DAY) {
          recorded.usd += c.cost.usd;
          recorded.added += c.cost.added;
          recorded.removed += c.cost.removed;
          recorded.conversations++;
        }
      }
      for (const l of c.limits) {
        if (l.at < now - 30 * DAY) continue;
        const key = `${l.type}|${l.until}`;
        const had = limits.get(key);
        if (!had) limits.set(key, { type: l.type, until: l.until, at: l.at, hit: new Set([c.session]) });
        else { had.at = Math.min(had.at, l.at); had.hit.add(c.session); }
      }
      for (const [key, d] of daysIn(c)) {
        const day = days.get(key);
        if (!day) continue;
        // output tokens by account, every day: the day-by-day chart is drawn in the accounts' colours
        for (const [acct, a] of Object.entries(d.a || {})) day.who[acct] = (day.who[acct] || 0) + a[1];
        const v = dayTotals(d, [0, 0, 0, 0, 0, 0]);
        const n = toolsOf(d);
        const parts = { in: v[0], out: v[1], cacheWrite: v[2], cacheRead: v[3], replies: v[4], work: v[5], asked: d.asked, tools: n,
          agents: d.agents, think: d.think, web: d.web, comp: d.comp, compMs: d.compMs, err: d.err, lim: d.lim };
        for (const k of Object.keys(parts)) day[k] += parts[k];
        if (key === today || key === yesterday) {
          const base = key === today ? 24 : 0;
          for (const [hour, h] of Object.entries(d.h)) {
            const slot = hours[base + Number(hour)];
            slot.in += h[0]; slot.out += h[1]; slot.cacheWrite += h[2]; slot.cacheRead += h[3]; slot.replies += h[4]; slot.work += h[5];
          }
        }
        if (key === today) {
          let lane = lanes.get(c.session);
          if (!lane) lanes.set(c.session, lane = { key: c.session, project: c.project, work: new Array(24).fill(0), out: new Array(24).fill(0), sum: 0, tokens: 0 });
          for (const [hour, h] of Object.entries(d.h)) {
            lane.work[Number(hour)] += h[5];
            lane.out[Number(hour)] += h[1];
            lane.sum += h[5];
            lane.tokens += h[1];
          }
        }
        if (!inRange.has(key)) continue;
        for (const [acct, a] of Object.entries(d.a || {})) {
          const g = group(who, acct);
          g.in += a[0]; g.out += a[1]; g.cacheWrite += a[2]; g.cacheRead += a[3]; g.replies += a[4]; g.work += a[5];
        }
        for (const k of Object.keys(parts)) total[k] += parts[k];
        for (const [model, m] of Object.entries(d.m)) {
          const g = group(models, model);
          g.in += m[0]; g.out += m[1]; g.cacheWrite += m[2]; g.cacheRead += m[3]; g.replies += m[4];
        }
        for (const [name, calls] of Object.entries(d.t)) tools.set(name, (tools.get(name) || 0) + calls);
        for (const g of [group(projects, c.project), group(chats, c.session)]) {
          g.in += v[0]; g.out += v[1]; g.cacheWrite += v[2]; g.cacheRead += v[3]; g.replies += v[4]; g.work += v[5]; g.asked += d.asked;
          g.project = c.project;
        }
      }
    }
    const top = (map, n) => [...map.values()].sort((a, b) => b.out - a.out).slice(0, n);
    const reached = [...limits.values()].sort((a, b) => b.at - a.at).slice(0, 12).map((l) => ({ type: l.type, until: l.until, at: l.at, chats: l.hit.size }));
    return {
      at: now,
      range: span === 30 ? '30d' : span === 7 ? '7d' : 'today',
      total,
      days: [...days.values()],
      hours,
      models: top(models, 8),
      projects: top(projects, 12).map((g) => ({ ...g, name: names.get(g.key) || g.key })),
      chats: top(chats, 12).map((g) => ({ ...g, title: titles.get(g.key) || '', name: names.get(g.project) || g.project, cwd: folders.get(g.key) || '' })),
      tools: [...tools].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls).slice(0, 14),
      toolKinds: tools.size,
      limits: reached,
      who: [...who.values()].sort((a, b) => b.out - a.out),
      lanes: [...lanes.values()].filter((l) => l.sum > 0 || l.tokens > 0).sort((a, b) => b.sum - a.sum || b.tokens - a.tokens).slice(0, LANES)
        .map((l) => ({ key: l.key, title: titles.get(l.key) || '', name: names.get(l.project) || l.project, work: l.work, out: l.out, sum: l.sum, tokens: l.tokens })),
      active: { chats: chats.size, projects: projects.size },
      recorded,
      // today: today's lines of every transcript are in, even while the older ones are still being read
      reading: { ...reading, counting: this.counting, today: this.todayDone },
    };
  }

  /**
   * Conversations that ended and can be picked up again, newest first, and the
   * folders recent conversations ran in. Read on request only: it walks every
   * project folder.
   */
  recent(limit = 30) {
    const files = [];
    let dirs = [];
    try { dirs = fs.readdirSync(this.projects); } catch { /* none */ }
    for (const dir of dirs) {
      let names = [];
      try { names = fs.readdirSync(path.join(this.projects, dir)); } catch { continue; }
      for (const name of names) {
        if (!SESSION_FILE.test(name)) continue;
        const file = path.join(this.projects, dir, name);
        try { files.push({ file, id: name.slice(0, -6), at: fs.statSync(file).mtimeMs }); } catch { /* gone */ }
      }
    }
    files.sort((a, b) => b.at - a.at);
    const chats = [];
    const folders = [];
    const addFolder = (cwd) => { if (cwd && !folders.includes(cwd) && folders.length < 40) folders.push(cwd); };
    for (const s of this.sessions.values()) addFolder(String(s.rec.cwd || ''));
    for (const f of files.slice(0, limit * 2)) {
      const follow = new Follower(f.file, 512 * 1024);
      follow.poll();
      const st = follow.state;
      addFolder(st.cwd);
      if (this.sessions.has(f.id) || chats.length >= limit || !st.cwd) continue;
      chats.push({ id: f.id, title: st.title, prompt: st.prompt, cwd: st.cwd, mode: st.mode, at: Math.round(f.at) });
    }
    return { chats, folders: folders.filter((dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }) };
  }
}

module.exports = { Watch };

if (!isMainThread) {
  const watch = new Watch(workerData);
  let pace = 2000;
  const say = (message) => parentPort.postMessage(message);
  const failed = (err) => say({ type: 'error', message: String((err && err.stack) || err) });
  let timer = null;
  // the status line file holds whichever session spoke last: looked at between two looks as well, so none is missed
  let sampler = null;
  const sampleEvery = (ms) => {
    clearInterval(sampler);
    sampler = setInterval(() => { try { watch.sample(); } catch (err) { failed(err); } }, ms);
  };
  const look = () => {
    clearTimeout(timer);
    try {
      const t0 = Date.now();
      watch.poll();
      watch.catchUp();
      const data = watch.snapshot();
      if (data) say({ type: 'snapshot', data, tookMs: Date.now() - t0 });
    } catch (err) {
      failed(err);
    }
    // what the programs use: answered a moment later by the helper, between two looks
    watch.measure(Date.now()).then((res) => {
      if (!res) return;
      say({ type: 'res', data: res });
      // a session it placed in a chat of this window shows there at once
      const data = watch.snapshot();
      if (data) say({ type: 'snapshot', data, tookMs: 0 });
    }).catch(failed);
    timer = setTimeout(look, pace);
  };
  let lastSave = Date.now();
  let behindSince = 0;
  const tally = () => {
    let more = false;
    try { more = watch.count(); } catch (err) { failed(err); }
    const now = Date.now();
    if (more && !behindSince) behindSince = now;
    // Written down once a minute at most, and when a count that took a while ends (the first one walks
    // gigabytes). Live sessions add lines every few seconds, and a burst of them takes a round or two to
    // catch up with: neither may write each time.
    const longOneOver = !more && behindSince && now - behindSince > 10000;
    if (watch.unsaved && (longOneOver || now - lastSave > 60000)) { watch.saveCounts(); lastSave = now; }
    if (!more) behindSince = 0;
    // A round is 60 ms of work: resting 300 ms after each keeps the long count under a fifth of one core.
    // Today's lines are a fraction of it and what the window waits for: they get a shorter rest.
    setTimeout(tally, !more ? 3000 : watch.todayDone ? 300 : 120);
  };
  /** What this thread holds on to, for the self-test's memory report. */
  const held = () => {
    const heap = require('node:v8').getHeapStatistics();
    let agents = 0;
    for (const s of watch.sessions.values()) if (s.agents) agents += s.agents.all.size;
    return {
      heapUsedMb: Math.round(heap.used_heap_size / 1048576),
      heapTotalMb: Math.round(heap.total_heap_size / 1048576),
      outsideHeapMb: Math.round(heap.external_memory / 1048576),
      sessions: watch.sessions.size,
      agents,
      counts: watch.counts.size,
    };
  };
  parentPort.on('message', (m) => {
    try {
      if (m.type === 'shells') watch.setShells(m.pairs, m.jobs);
      // a new pace starts with a look: a window that comes back into view is brought up to date at once
      else if (m.type === 'pace') { pace = m.ms; watch.measureEvery = m.ms <= 2000 ? MEASURE_SEEN : MEASURE_AWAY; sampleEvery(m.ms <= 2000 ? 500 : 2000); look(); }
      else if (m.type === 'counting') watch.counting = Boolean(m.on);
      else if (m.type === 'refresh') { watch.refresh(); watch.measureAt = 0; watch.sample(); look(); say({ type: 'answer', ask: m.ask, data: { at: Date.now() } }); }
      else if (m.type === 'recent') say({ type: 'answer', ask: m.ask, data: watch.recent() });
      else if (m.type === 'usage') say({ type: 'answer', ask: m.ask, data: watch.stats(m.range) });
      else if (m.type === 'stats') say({ type: 'answer', ask: m.ask, data: held() });
      else if (m.type === 'typed') say({ type: 'answer', ask: m.ask, data: watch.typedFor(m.query) });
      else if (m.type === 'read') say({ type: 'answer', ask: m.ask, data: watch.page(m) });
      else if (m.type === 'history') say({ type: 'answer', ask: m.ask, data: watch.conversations() });
      else if (m.type === 'file') say({ type: 'answer', ask: m.ask, data: watch.fileOf(m.key, m.agent) });
      else if (m.type === 'forget') watch.forgetEnded(String(m.id || ''));
      else if (m.type === 'stop') { if (watch.procs) watch.procs.stop(); watch.saveCounts(); watch.ledger.save(); process.exit(0); }
    } catch (err) {
      failed(err);
      if (m.ask) say({ type: 'answer', ask: m.ask, data: null });
    }
  });
  // who was logged in when is worked out before the first picture, and before anything is counted
  try { watch.seed(); } catch (err) { failed(err); }
  sampleEvery(500);
  look();
  setTimeout(tally, 5000);
}
