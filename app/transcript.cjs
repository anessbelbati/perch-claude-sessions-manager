'use strict';
// Reading a session transcript without ever loading it whole: they run to
// gigabytes. Two readers live here. The Follower keeps up with the END of a
// transcript, to know what the session is doing now. The Tally walks a
// transcript once, in slices, and adds up what the session used and did, day
// by day, and under which account.
const fs = require('node:fs');

const CHUNK = 4 * 1024 * 1024;
const HEAD = 400;                // enough of a line to tell what kind of line it is
const HEAD_USER = 1200;          // enough of a user line to tell a tool's result from something asked
const TOOLS_KEPT = 60;
const USAGE = Buffer.from('"usage"');
// what a slash command leaves in the transcript: the command, its output. Nobody asked the model anything.
const PLUMBING = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;
const MINUTE = 60e3;

// One read buffer for the whole thread, instead of megabytes of new ones on every look.
const SHARED = Buffer.allocUnsafe(CHUNK);

/**
 * Calls onLine for every complete line between two offsets and returns the
 * offset just past the last complete one, so a line still being written is
 * read again whole next time. The buffer handed to onLine is reused: read it
 * before returning, and do not call eachLine from inside onLine.
 */
function eachLine(fd, from, to, onLine) {
  let carry = null;
  let pos = from;
  let done = from;
  while (pos < to) {
    const n = fs.readSync(fd, SHARED, 0, Math.min(CHUNK, to - pos), pos);
    if (n <= 0) break;
    pos += n;
    const data = carry ? Buffer.concat([carry, SHARED.subarray(0, n)]) : SHARED.subarray(0, n);
    let start = 0;
    let nl;
    while ((nl = data.indexOf(10, start)) !== -1) {
      if (nl > start) onLine(data.subarray(start, nl));
      start = nl + 1;
    }
    done = pos - (data.length - start);
    carry = start < data.length ? Buffer.from(data.subarray(start)) : null;
  }
  return done;
}

/**
 * What kind of line this is, read from its first bytes only. Small records
 * start with their type; user and system lines name it before their body; an
 * assistant line carries its message first, so it is known by the message's
 * role. Whichever marker comes first wins: a prompt may quote the other one.
 */
function kindOf(line) {
  if (line[0] !== 0x7b) return '';
  const head = line.toString('latin1', 0, Math.min(line.length, HEAD));
  if (head.startsWith('{"type":"')) return head.slice(9, head.indexOf('"', 9));
  const user = head.indexOf('"type":"user","message":{');
  const assistant = head.indexOf('"role":"assistant"');
  const system = head.indexOf('"type":"system","subtype"');
  const first = Math.min(...[user, assistant, system].filter((i) => i !== -1), Infinity);
  if (first === Infinity) return '';
  return first === user ? 'user' : first === assistant ? 'assistant' : 'system';
}

const ELLIPSIS = String.fromCharCode(0x2026);
const clip = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + ELLIPSIS : flat;
};
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };

/** A tool's name as a person would say it: "ops: capture" for mcp__ops__capture. */
function toolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  return m ? `${m[1].replace(/_/g, ' ')}: ${m[2].replace(/_/g, ' ')}` : String(name || '');
}

/** The few words that say what a tool call is working on. */
function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return '';
  const first = (...keys) => {
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k];
    return '';
  };
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return clip(first('file_path', 'notebook_path').split(/[\\/]/).pop(), 90);
    case 'Bash': case 'PowerShell':
      return clip(first('description') || first('command').split('\n')[0], 90);
    case 'Grep': case 'Glob':
      return clip(first('pattern'), 90);
    case 'Agent': case 'Task':
      return clip(first('description', 'name'), 90);
    case 'WebFetch':
      return clip(hostOf(first('url')), 90);
    case 'WebSearch':
      return clip(first('query'), 90);
    case 'AskUserQuestion':
      return clip(Array.isArray(input.questions) && input.questions[0] && input.questions[0].question, 240);
    default:
      return clip(first('description', 'query', 'title', 'name', 'skill', 'path', 'file_path', 'url', 'command', 'prompt', 'text', 'message'), 90);
  }
}

/** A tool call that cannot finish until the person at the keyboard answers. */
const waitsForPerson = (tool) => Boolean(tool) && (tool.name === 'AskUserQuestion' || tool.name === 'ExitPlanMode');

/** What a user line holds, once tool results and notes for the model are set aside. */
function askedText(o) {
  const content = o.message.content;
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  return String((blocks.find((b) => b.type === 'text') || {}).text || '').trimStart();
}

/** When the service turned a request down for a usage limit: which limit, and when it lifts. */
function limitOf(o) {
  if (o.error !== 'rate_limit') return null;
  const q = o.quotaLimits || {};
  return { type: String(q.rateLimitType || ''), until: (Number(q.resetsAt) || 0) * 1000 };
}

function emptyState() {
  return {
    title: '',        // the name the CLI gave the conversation
    prompt: '',       // the last thing asked of it
    mode: '',         // its permission mode
    model: '',
    effort: '',       // how hard it was told to think
    cwd: '',
    said: '',         // the last thing it wrote in words
    failed: false,    // those words are an error from the service, not an answer
    limit: null,      // that error was a usage limit: { type, until }
    at: 0,            // when its newest line was written
    turnStart: 0,     // when the turn in progress (or the last one) began; 0 = before what was read
    turnEnd: 0,       // when that turn finished; 0 = still going, or it left no mark
    turnMs: 0,
    tools: [],        // that turn's tool calls, oldest first, at most TOOLS_KEPT
    toolCount: 0,     // every tool call of that turn, the dropped ones included
    context: 0,       // tokens in its newest request: what its memory holds now
    last: '',         // what its newest line was: 'asked', 'said', 'tool' (a call) or 'answer' (a tool's result)
    recap: '',        // the CLI's own summary of what happened while the person was away
    recapAt: 0,
    queued: 0,        // messages typed while it worked, still waiting their turn
    compactedAt: 0,   // when its memory was last compacted
  };
}

class Follower {
  /** tailBytes: how far back the first read goes. */
  constructor(file, tailBytes = 4 * 1024 * 1024) {
    this.file = file;
    this.tailBytes = tailBytes;
    this.offset = -1;
    this.state = emptyState();
    this.pending = new Map();
    this.beats = new Map();      // minute -> things it did in that minute, for the last hour
  }

  /** Reads what was appended since the last call. True when something was read. */
  poll() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return false; }
    if (size === this.offset) return false;
    let from = this.offset;
    let midLine = false;
    if (from < 0 || size < from || size - from > 4 * this.tailBytes) {
      // the first read, a file that was replaced, or more new text than is worth walking: start over from the end
      if (from >= 0) { this.state = emptyState(); this.pending.clear(); this.beats.clear(); }
      from = Math.max(0, size - this.tailBytes);
      midLine = from > 0;
    }
    let fd;
    try { fd = fs.openSync(this.file, 'r'); } catch { return false; }
    try {
      this.offset = eachLine(fd, from, size, (line) => {
        if (midLine) { midLine = false; return; }
        this.take(line);
      });
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  take(line) {
    const kind = kindOf(line);
    if (kind !== 'assistant' && kind !== 'user' && kind !== 'system' && kind !== 'ai-title' && kind !== 'last-prompt'
      && kind !== 'permission-mode' && kind !== 'queue-operation') return;
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    const s = this.state;
    if (kind === 'ai-title') s.title = clip(o.aiTitle, 120);
    else if (kind === 'last-prompt') s.prompt = clip(o.lastPrompt, 400);
    else if (kind === 'permission-mode') s.mode = String(o.permissionMode || '');
    else if (kind === 'queue-operation') this.takeQueue(o);
    else if (kind === 'assistant') this.takeReply(o);
    else if (kind === 'user') this.takeUser(o);
    else if (o.subtype === 'turn_duration') this.end(Date.parse(o.timestamp) || s.at, Number(o.durationMs) || 0);
    else if (o.subtype === 'stop_hook_summary' && !s.turnEnd) this.end(Date.parse(o.timestamp) || s.at, 0);
    else if (o.subtype === 'away_summary' && o.content) { s.recap = clip(o.content, 700); s.recapAt = Date.parse(o.timestamp) || s.at; }
    else if (o.subtype === 'compact_boundary') s.compactedAt = Date.parse(o.timestamp) || s.at;
  }

  takeQueue(o) {
    const s = this.state;
    if (o.operation === 'enqueue') s.queued++;
    else if (o.operation === 'popAll') s.queued = 0;
    // read from the middle of the file, a message may leave the queue that was never seen entering it
    else if (s.queued > 0) s.queued--;
  }

  takeReply(o) {
    const s = this.state;
    const msg = o.message;
    if (o.type !== 'assistant' || !msg) return;
    const at = Date.parse(o.timestamp) || s.at;
    // words after a finished turn: something set it going again without a line of its own (a slash command, a hook)
    if (s.turnEnd) this.begin(at);
    s.at = at;
    if (o.cwd) s.cwd = o.cwd;
    if (msg.model && msg.model !== '<synthetic>') s.model = msg.model;
    if (o.effort) s.effort = String(o.effort);
    const u = msg.usage;
    if (u) s.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) || s.context;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block.type === 'text' && block.text && block.text.trim()) {
        s.said = clip(block.text, 600);
        s.failed = Boolean(o.isApiErrorMessage);
        s.limit = s.failed ? limitOf(o) : null;
        s.last = 'said';
        this.beat(at);
      } else if (block.type === 'tool_use' && !this.pending.has(block.id)) {
        const tool = { name: toolName(block.name), what: toolTarget(block.name, block.input), at, done: 0 };
        this.pending.set(block.id, tool);
        s.tools.push(tool);
        s.toolCount++;
        s.last = 'tool';
        if (s.tools.length > TOOLS_KEPT) s.tools.shift();
        this.beat(at);
      }
    }
  }

  takeUser(o) {
    const s = this.state;
    if (o.type !== 'user' || !o.message) return;
    const at = Date.parse(o.timestamp) || s.at;
    s.at = at;
    if (o.cwd) s.cwd = o.cwd;
    const text = askedText(o);
    if (text === null) {
      for (const b of o.message.content) if (b.type === 'tool_result') this.finish(b.tool_use_id, at);
      s.last = 'answer';
      return;
    }
    // notes the CLI adds for the model, and the summary a compaction leaves: nobody asked anything
    if (o.isMeta || o.isCompactSummary) return;
    if (text.startsWith('[Request interrupted')) this.end(at, 0);
    else if (!PLUMBING.test(text)) this.begin(at);
  }

  /** Something new was asked: a turn begins. */
  begin(at) {
    const s = this.state;
    s.turnStart = at;
    s.turnEnd = 0;
    s.turnMs = 0;
    s.tools = [];
    s.toolCount = 0;
    s.failed = false;
    s.limit = null;
    s.last = 'asked';
    this.pending.clear();
  }

  /** The turn is over. It takes its unanswered tool calls with it (an interrupt). */
  end(at, ms) {
    const s = this.state;
    s.at = at;
    s.turnEnd = at;
    s.turnMs = ms;
    for (const tool of this.pending.values()) tool.done = at;
    this.pending.clear();
  }

  finish(id, at) {
    const tool = this.pending.get(id);
    if (!tool) return;
    tool.done = at;
    this.pending.delete(id);
  }

  /** The tool call still waiting for its answer, the newest of them; null when none. */
  running() {
    let last = null;
    for (const tool of this.pending.values()) last = tool;
    return last;
  }

  beat(at) {
    const minute = Math.floor(at / MINUTE);
    this.beats.set(minute, (this.beats.get(minute) || 0) + 1);
    if (this.beats.size > 90) for (const m of this.beats.keys()) if (m < minute - 60) this.beats.delete(m);
  }

  /** Adds its beats of the last `n` minutes into `into`, oldest minute first. */
  pulse(now, into) {
    const last = Math.floor(now / MINUTE);
    const n = into.length;
    for (const [minute, count] of this.beats) {
      const i = n - 1 - (last - minute);
      if (i >= 0 && i < n) into[i] += count;
    }
    return into;
  }
}

// ---- the Tally ----
const DAYS_KEPT = 40;            // how far back the day-by-day detail goes
const GAP_CAP = 60 * MINUTE;     // one stretch between two replies counts as work up to this long
// A stretch that ends at a message instead of a reply: real when the message arrived mid-turn, not when the
// turn had died without leaving a mark and the message came hours later. It counts up to this long.
const CUT_CAP = 15 * MINUTE;
const RECENT = 48;
const VERSION = 3;               // of what a tally keeps between runs
const pad = (n) => String(n).padStart(2, '0');

// The local day and hour of a moment. Every time zone sits a multiple of 15 minutes from UTC, so a
// quarter of an hour never straddles an hour: one Date per quarter instead of one per line.
let slotOf = -1;
let slotDay = '';
let slotHour = 0;
function localHour(at) {
  const slot = Math.floor(at / (15 * MINUTE));
  if (slot !== slotOf) {
    const d = new Date(at);
    slotOf = slot;
    slotDay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    slotHour = d.getHours();
  }
  return slotDay;
}
/** 'YYYY-MM-DD' of a moment, local time. */
const dayKey = (at) => localHour(at);

// Which account was in use when, oldest first: [{ at, key }]. Handed over by whoever keeps the ledger of
// logins. What a reply cost is filed under the account that was logged in when it was written.
const UNKNOWN = '?';             // before the first mark, and wherever the ledger says "not known"
let marks = [];
let whoFrom = 1;                 // the stretch the last answer came from: the next line is nearly always in it too
let whoTo = 0;
let whoKey = UNKNOWN;
function setTimeline(list) {
  marks = Array.isArray(list) ? list : [];
  whoFrom = 1;
  whoTo = 0;
}
function whoAt(at) {
  if (at >= whoFrom && at < whoTo) return whoKey;
  let lo = 0;
  let hi = marks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].at <= at) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  whoFrom = found < 0 ? -Infinity : marks[found].at;
  whoTo = found + 1 < marks.length ? marks[found + 1].at : Infinity;
  whoKey = (found >= 0 && marks[found].key) || UNKNOWN;
  return whoKey;
}

const PROBE = 256 * 1024;
const PROBE_MAX = 16 * 1024 * 1024;
const BACK_OFF = 2 * 1024 * 1024; // lines are not written in perfect order: start a little before the place found

/** When the first line after `from` that carries a time was written; 0 when none is found within reach. */
function timeAfter(fd, from, size) {
  for (let span = PROBE; span <= PROBE_MAX; span *= 4) {
    const buf = Buffer.allocUnsafe(Math.min(span, size - from));
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    const data = buf.subarray(0, n);
    // the read starts in the middle of a line: that line is skipped
    let start = from === 0 ? 0 : data.indexOf(10) + 1;
    if (from > 0 && start === 0) {
      if (n < span) return 0;
      continue;
    }
    let tried = 0;
    let nl;
    while (tried < 60 && (nl = data.indexOf(10, start)) !== -1) {
      if (nl > start) {
        tried++;
        try {
          const at = Date.parse(JSON.parse(data.toString('utf8', start, nl)).timestamp);
          if (at > 0) return at;
        } catch {
          // not a record
        }
      }
      start = nl + 1;
    }
    if (tried >= 60 || n < span) return 0;
  }
  return 0;
}

/**
 * Where in a transcript the lines written from `at` on begin: the start of a line a little before them (the
 * end of the file, near enough, when it holds none), or -1 when it cannot be read. Found by halving, a dozen
 * short reads, without walking the file: lines sit in the order they were written, near enough.
 */
function seekTime(file, at) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return -1; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return -1;
    let lo = 0;
    let hi = size;
    while (hi - lo > PROBE) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const found = timeAfter(fd, mid, size);
      // nothing readable there counts as "late enough": the answer then errs on the early side
      if (!found || found >= at) hi = mid; else lo = mid;
    }
    const from = Math.max(0, lo - BACK_OFF);
    if (from === 0) return 0;
    const buf = Buffer.allocUnsafe(Math.min(PROBE_MAX, size - from));
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    const nl = buf.subarray(0, n).indexOf(10);
    return nl === -1 ? -1 : from + nl + 1;
  } catch {
    return -1;
  } finally {
    fs.closeSync(fd);
  }
}

const emptyDay = () => ({
  h: {},           // local hour -> [fresh input, output, written to cache, read from cache, replies, ms of work]
  m: {},           // model -> [fresh input, output, written to cache, read from cache, replies]
  a: {},           // account -> [fresh input, output, written to cache, read from cache, replies, ms of work]
  t: {},           // tool -> calls
  asked: 0,        // things a person typed
  think: 0,        // output tokens spent thinking (already part of the output count)
  web: 0,          // web searches and page fetches run by the service
  agents: 0,       // subagents started
  comp: 0,         // compactions of its memory
  compMs: 0,       // and how long they took
  err: 0,          // requests the service answered with an error
  lim: 0,          // of those, usage limits reached
});

/**
 * What one transcript adds up to. Token counts: [fresh input, output, written
 * to cache, read from cache, thinking]. One reply is logged as several lines,
 * one per part, that repeat its token counts (the output count can still be
 * growing on the early ones), always next to each other: a reply is counted
 * when first seen and topped up when a later line of it shows more.
 *
 * Work time: the stretch between two replies of the same turn, and from a
 * question to its first reply. The wait for the next question is not work,
 * and neither is the wait for the person to answer a question the model put
 * to them.
 */
class Tally {
  constructor(saved) {
    this.reset();
    if (saved && saved.v === VERSION) {
      Object.assign(this, {
        offset: saved.offset, sum: saved.sum.slice(), replies: saved.replies, tools: saved.tools, days: saved.days || {},
        lastAt: saved.lastAt || 0, idle: saved.idle !== false, askedAt: saved.askedAt || 0, title: saved.title || '', cwd: saved.cwd || '',
        cost: saved.cost || null, pre: saved.pre || 0, compacts: saved.compacts || 0, limits: (saved.limits || []).slice(), first: saved.first || 0,
        model: saved.model || '', preModel: saved.preModel || '', preAt: saved.preAt || 0,
      });
      this.recent = new Map((saved.recent || []).map(([id, r]) => [id, { c: r.c.slice(), at: r.at, model: r.model }]));
    }
    this.size = this.offset;
    this.slice = 16 * 1024 * 1024;
  }

  reset() {
    this.offset = 0;
    this.sum = [0, 0, 0, 0, 0];
    this.replies = 0;
    this.tools = 0;
    this.days = {};
    this.recent = new Map();
    this.lastTool = '';
    this.lastAt = 0;         // when its newest reply was written
    this.idle = true;        // its turn is over: the time until the next reply is not work
    this.askedAt = 0;        // when the thing that set the turn in progress going arrived
    this.title = '';
    this.cwd = '';
    this.cost = null;        // the CLI's own running cost record, as last written: { usd, added, removed, apiMs, toolMs, at }
    this.model = '';         // the model of its newest reply
    this.pre = 0;            // tokens in its memory when it last compacted on its own
    this.preModel = '';      // on which model that was
    this.preAt = 0;
    this.compacts = 0;
    this.limits = [];        // usage limits it ran into, newest last: { at, type, until }
    this.first = 0;          // when its first reply was written
  }

  /** A tally that leaves out everything before `offset`: for today's lines of a transcript far from counted. */
  static from(offset) {
    const t = new Tally();
    t.offset = offset;
    t.size = offset;
    t.began = offset;
    return t;
  }

  /** Reads one slice further. True while more is left to read. */
  step(file) {
    let size;
    try { size = fs.statSync(file).size; } catch { return false; }
    if (size < this.offset) this.reset();      // not the file that was counted before
    this.size = size;
    if (size === this.offset) return false;
    const to = Math.min(size, this.offset + this.slice);
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return false; }
    let done;
    try {
      done = eachLine(fd, this.offset, to, (line) => this.take(line));
    } finally {
      fs.closeSync(fd);
    }
    // one line longer than a whole slice: take a bigger bite next time instead of stalling on it
    if (done === this.offset && to < size) this.slice *= 2;
    this.offset = done;
    return this.offset < size && to < size;
  }

  take(line) {
    const kind = kindOf(line);
    if (kind === 'assistant') {
      if (line.indexOf(USAGE) !== -1) this.takeReply(line);
    } else if (kind === 'user') {
      // a tool's result names the call it answers right at the start of its body; those are most of a transcript
      if (line.toString('latin1', 0, Math.min(line.length, HEAD_USER)).includes('"tool_use_id"')) return;
      this.takeUser(line);
    } else if (kind === 'system') {
      this.takeSystem(line);
    } else if (kind === 'cost-state' || kind === 'ai-title') {
      let o;
      try { o = JSON.parse(line.toString('utf8')); } catch { return; }
      if (kind === 'ai-title') this.title = clip(o.aiTitle, 120);
      else {
        this.cost = {
          usd: Number(o.totalCostUSD) || 0, added: Number(o.totalLinesAdded) || 0, removed: Number(o.totalLinesRemoved) || 0,
          apiMs: Number(o.totalAPIDuration) || 0, toolMs: Number(o.totalToolDuration) || 0, at: this.lastAt,
        };
      }
    }
  }

  /** The day a moment falls in, with its detail; null for one too long ago to keep by day. */
  day(at) {
    if (!at || Date.now() - at > DAYS_KEPT * 86400e3) return null;
    const key = dayKey(at);
    return this.days[key] || (this.days[key] = emptyDay());
  }

  add(at, model, c, replies, work) {
    for (let i = 0; i < 5; i++) this.sum[i] += c[i];
    const d = this.day(at);
    if (!d) return;
    const h = d.h[slotHour] || (d.h[slotHour] = [0, 0, 0, 0, 0, 0]);
    const m = d.m[model] || (d.m[model] = [0, 0, 0, 0, 0]);
    const who = whoAt(at);
    const a = d.a[who] || (d.a[who] = [0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) { h[i] += c[i]; m[i] += c[i]; a[i] += c[i]; }
    h[4] += replies;
    m[4] += replies;
    a[4] += replies;
    h[5] += work;
    a[5] += work;
    d.think += c[4];
    d.web += c[5];
  }

  /** Work that ends at something other than a reply: the stretch before an interrupt, or before a message that arrived mid-turn. */
  workUntil(at) {
    if (this.idle || !this.lastAt || at <= this.lastAt) return;
    const d = this.day(at);
    if (!d) return;
    const h = d.h[slotHour] || (d.h[slotHour] = [0, 0, 0, 0, 0, 0]);
    const who = whoAt(at);
    const a = d.a[who] || (d.a[who] = [0, 0, 0, 0, 0, 0]);
    const work = Math.min(at - this.lastAt, CUT_CAP);
    h[5] += work;
    a[5] += work;
  }

  takeReply(line) {
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    const msg = o.message;
    const u = msg && msg.usage;
    if (o.type !== 'assistant' || !u) return;
    const at = Date.parse(o.timestamp) || this.lastAt;
    if (o.isApiErrorMessage) { this.takeError(o, at); return; }
    if (!this.cwd && o.cwd) this.cwd = String(o.cwd);
    let over = false;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block.type !== 'tool_use') continue;
      // a question put to the person: what follows is their time, not the model's
      if (waitsForPerson(block)) over = true;
      if (block.id === this.lastTool) continue;
      this.lastTool = block.id;
      this.tools++;
      const d = this.day(at);
      if (!d) continue;
      const name = toolName(block.name);
      d.t[name] = (d.t[name] || 0) + 1;
      if (block.name === 'Agent' || block.name === 'Task') d.agents++;
    }
    const web = u.server_tool_use || {};
    const counts = [u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0,
      (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0, (web.web_search_requests || 0) + (web.web_fetch_requests || 0)];
    // the model said it was finished: what follows is the wait for the next question (not every turn leaves another mark)
    if (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence') over = true;
    const id = `${msg.id}|${o.requestId}`;
    const seen = this.recent.get(id);
    if (seen) {
      let grew = false;
      for (let i = 0; i < 6; i++) {
        const more = counts[i] - seen.c[i];
        if (more > 0) { seen.c[i] = counts[i]; counts[i] = more; grew = true; } else counts[i] = 0;
      }
      if (grew) this.add(seen.at, seen.model, counts, 0, 0);
      if (over) this.idle = true;
      return;
    }
    let work = 0;
    if (this.idle) {
      if (this.askedAt && at > this.askedAt) work = Math.min(at - this.askedAt, GAP_CAP);
    } else if (this.lastAt && at > this.lastAt) {
      work = Math.min(at - this.lastAt, GAP_CAP);
    }
    this.idle = over;
    this.askedAt = 0;
    this.lastAt = at;
    if (!this.first) this.first = at;
    const model = msg.model && msg.model !== '<synthetic>' ? String(msg.model) : 'unknown';
    if (model !== 'unknown') this.model = model;
    this.recent.set(id, { c: counts.slice(), at, model });
    this.replies++;
    this.add(at, model, counts, 1, work);
    if (this.recent.size > RECENT) this.recent.delete(this.recent.keys().next().value);
  }

  takeError(o, at) {
    const d = this.day(at);
    if (d) d.err++;
    const limit = limitOf(o);
    if (!limit) return;
    const last = this.limits[this.limits.length - 1];
    // a request turned down is tried again and turned down again: one limit, reached once
    if (last && last.type === limit.type && last.until === limit.until) return;
    this.limits.push({ at, ...limit });
    if (this.limits.length > 12) this.limits.shift();
    if (d) d.lim++;
  }

  takeUser(line) {
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    if (o.type !== 'user' || !o.message) return;
    const text = askedText(o);
    if (text === null || o.isMeta || o.isCompactSummary) return;
    const at = Date.parse(o.timestamp) || 0;
    if (PLUMBING.test(text)) return;
    // An interrupt ends the turn; anything else here sets one going. Arriving in the middle of a turn, either one
    // closes a stretch of work; arriving after its end, the wait before it was not work.
    this.workUntil(at);
    this.idle = true;
    if (text.startsWith('[Request interrupted')) { this.askedAt = 0; return; }
    this.askedAt = at;
    // typed by a person, in the conversation itself: not a task's notice, not the brief handed to a subagent
    const origin = o.origin && o.origin.kind;
    const typed = origin === 'human' || (origin === undefined && !text.startsWith('<'));
    const d = typed && !o.isSidechain ? this.day(at) : null;
    if (d) d.asked++;
  }

  takeSystem(line) {
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    if (o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary') {
      this.idle = true;
      this.askedAt = 0;
    } else if (o.subtype === 'compact_boundary') {
      const meta = o.compactMetadata || {};
      const at = Date.parse(o.timestamp) || this.lastAt;
      this.compacts++;
      if (meta.trigger === 'auto' && Number(meta.preTokens) > 0) { this.pre = Number(meta.preTokens); this.preModel = this.model; this.preAt = at; }
      const d = this.day(at);
      if (d) { d.comp++; d.compMs += Number(meta.durationMs) || 0; }
    }
  }

  /** [fresh input, output, written to cache, read from cache]. */
  totals() {
    return this.sum.slice(0, 4);
  }

  /** Read to the end and not being written to: only a reply's own lines could still follow it, so its newest few are kept. */
  rest() {
    while (this.recent.size > 4) this.recent.delete(this.recent.keys().next().value);
  }

  /** What to keep between runs. Only a reply's own lines can still follow it, so its newest few are enough to carry over. */
  save() {
    const oldest = dayKey(Date.now() - DAYS_KEPT * 86400e3);
    const days = {};
    for (const key of Object.keys(this.days)) if (key >= oldest) days[key] = this.days[key];
    return {
      v: VERSION, offset: this.offset, sum: this.sum, replies: this.replies, tools: this.tools, days, recent: [...this.recent].slice(-4),
      lastAt: this.lastAt, idle: this.idle, askedAt: this.askedAt, title: this.title, cwd: this.cwd, cost: this.cost, pre: this.pre,
      compacts: this.compacts, limits: this.limits, first: this.first, model: this.model, preModel: this.preModel, preAt: this.preAt,
    };
  }
}

Tally.VERSION = VERSION;

// ---- reading a stretch of a transcript for the eye ----
// A page is a run of whole lines, about a megabyte and a half of them, turned into what a person would call
// the conversation: what was asked, what was said and thought, each tool call with what came back, and the
// marks between turns. Long texts are cut (one result can be megabytes); the file is never read whole.
const PAGE = 1536 * 1024;
const NEW_MAX = 3 * PAGE;        // more new lines than this since the last look: the look starts over from the end
const CUT = { asked: 30000, said: 30000, thought: 8000, input: 6000, output: 8000, read: 2400, line: 500, diff: 240, note: 3000 };
const QUEUED = '"attachment":{"type":"queued_command"';

/** A slice that never lands between the two halves of one character. */
function sliceWhole(s, from, to) {
  if (from > 0 && from < s.length && s.charCodeAt(from) >= 0xDC00 && s.charCodeAt(from) <= 0xDFFF) from++;
  if (to > 0 && to < s.length && s.charCodeAt(to - 1) >= 0xD800 && s.charCodeAt(to - 1) <= 0xDBFF) to--;
  return s.slice(from, to);
}

/** Cuts a long text to about `max` characters, keeping its start and its end: the end of a command's output is where the answer is. */
function cut(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  return `${sliceWhole(s, 0, head)}\n\n[${(s.length - max).toLocaleString('en-US')} characters not shown]\n\n${sliceWhole(s, s.length - (max - head), s.length)}`;
}
const cutLine = (l) => (l.length > CUT.line ? sliceWhole(l, 0, CUT.line) + ELLIPSIS : l);

/** The words in what a tool handed back: a text, or a list of parts. */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'image') out.push('[a picture]');
    else if (b.type === 'tool_reference' && b.tool_name) out.push(`[tool: ${b.tool_name}]`);
  }
  return out.join('\n');
}

/** The changed lines of an edit as the CLI recorded them: hunks of lines led by ' ', '+' or '-'. more: lines left out. */
function diffOf(file, patch, kind) {
  const hunks = [];
  let added = 0;
  let removed = 0;
  let lines = 0;
  let kept = 0;
  for (const hk of Array.isArray(patch) ? patch : []) {
    const rows = [];
    for (const l of Array.isArray(hk && hk.lines) ? hk.lines : []) {
      const s = String(l);
      lines++;
      if (s[0] === '+') added++;
      else if (s[0] === '-') removed++;
      if (kept < CUT.diff) { rows.push(cutLine(s)); kept++; }
    }
    if (rows.length) hunks.push({ a: Number(hk.oldStart) || 0, b: Number(hk.newStart) || 0, lines: rows });
  }
  return { file: String(file || ''), kind, hunks, added, removed, more: lines - kept };
}

/** Texts set against each other as taken out and put in: [[before, after], ...]. */
function swapDiff(file, pairs, kind) {
  const hunks = [];
  let added = 0;
  let removed = 0;
  let lines = 0;
  let kept = 0;
  const rows = (text, mark) => {
    const all = String(text == null ? '' : text).split('\n');
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const out = [];
    for (const l of all) {
      lines++;
      if (mark === '+') added++; else removed++;
      if (kept < CUT.diff) { out.push(mark + cutLine(l)); kept++; }
    }
    return out;
  };
  for (const [before, after] of pairs) {
    const list = [...(before ? rows(before, '-') : []), ...(after ? rows(after, '+') : [])];
    if (list.length) hunks.push({ a: 0, b: 0, lines: list });
  }
  return { file: String(file || ''), kind, hunks, added, removed, more: lines - kept };
}

/** The change a tool call asks for, read from what it was given: what stands until the call's own record of it arrives. */
function askedDiff(name, input) {
  const file = typeof input.file_path === 'string' ? input.file_path : '';
  if (!file) return null;
  if (name === 'Write' && typeof input.content === 'string') return swapDiff(file, [['', input.content]], 'new');
  if (name === 'Edit' && typeof input.new_string === 'string') return swapDiff(file, [[input.old_string, input.new_string]], 'edit');
  if (name === 'MultiEdit' && Array.isArray(input.edits)) return swapDiff(file, input.edits.map((e) => [e && e.old_string, e && e.new_string]), 'edit');
  return null;
}

/** What a tool call was given, in a few lines of text. */
function inputOf(name, input) {
  const s = (k) => (typeof input[k] === 'string' ? input[k] : '');
  switch (name) {
    case 'Bash': case 'PowerShell':
      return cut(s('command'), CUT.input);
    case 'Read': {
      const from = Number(input.offset) || 0;
      const n = Number(input.limit) || 0;
      return s('file_path') + (from || n ? `\nfrom line ${from || 1}${n ? `, ${n} lines` : ''}` : '');
    }
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return s('file_path') || s('notebook_path');
    case 'Grep':
      return [s('pattern'), s('path') && `in ${s('path')}`, s('glob') && `files: ${s('glob')}`, s('type') && `type: ${s('type')}`].filter(Boolean).join('\n');
    case 'Glob':
      return [s('pattern'), s('path') && `in ${s('path')}`].filter(Boolean).join('\n');
    case 'WebFetch':
      return [s('url'), cut(s('prompt'), 1200)].filter(Boolean).join('\n');
    case 'WebSearch':
      return s('query');
    case 'Agent': case 'Task':
      return [s('description'), s('subagent_type') && `kind: ${s('subagent_type')}`, cut(s('prompt'), 4000)].filter(Boolean).join('\n\n');
    case 'AskUserQuestion':
      return (Array.isArray(input.questions) ? input.questions : []).map((q) => `${(q && q.question) || ''}\n${(Array.isArray(q && q.options) ? q.options : []).map((x) => `  - ${(x && x.label) || ''}`).join('\n')}`).join('\n\n');
    default: {
      let text = '';
      try { text = JSON.stringify(input, null, 1); } catch { /* not something that can be written out */ }
      return text === '{}' ? '' : cut(text, 3000);
    }
  }
}

/** What came back from a tool call: { done, error, out, diff, note }. Told by the shape of the record, so a result whose call is on another page reads the same. */
function resultOf(o, block, at) {
  const r = o.toolUseResult;
  const res = { done: at, error: block.is_error === true, out: '', diff: null, note: '' };
  const said = textOf(block.content);
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) res.diff = diffOf(r.filePath, r.structuredPatch, r.type === 'create' ? 'new' : 'edit');
    else if (r.type === 'create' && typeof r.content === 'string' && r.filePath) res.diff = swapDiff(r.filePath, [['', r.content]], 'new');
    else if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      res.out = cut([r.stdout, r.stderr].filter(Boolean).join('\n'), CUT.output);
      if (r.interrupted) res.note = 'interrupted';
    } else if (r.file && typeof r.file === 'object' && r.file.filePath) {
      const f = r.file;
      const n = Number(f.numLines) || 0;
      if (n) res.note = `${n.toLocaleString('en-US')} line${n === 1 ? '' : 's'} from line ${Number(f.startLine) || 1}${f.totalLines ? ` of ${Number(f.totalLines).toLocaleString('en-US')}` : ''}`;
      res.out = cut(typeof f.content === 'string' ? f.content : said, CUT.read);
    } else if (typeof r.url === 'string' && typeof r.result === 'string') {
      res.note = `${r.code || ''} ${r.codeText || ''}`.trim();
      res.out = cut(r.result, CUT.output);
    }
  }
  if (!res.out && (!res.diff || res.error)) res.out = cut(said, CUT.output);
  return res;
}

/** What a notice the CLI put into the conversation is about: its summary when it carries one, else its words without the tags. */
function noticeText(text) {
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text);
  return cut((m ? m[1] : text.replace(/<[^>]{1,60}>/g, ' ')).replace(/\s+/g, ' ').trim(), 600);
}

class Page {
  constructor() {
    this.items = [];
    this.calls = new Map();      // tool call id -> its item, to hang the result on
    this.orphans = {};           // results whose call sits on an earlier page
    this.replies = new Map();    // reply id -> { at, ctx, out }: how full its memory was, and what it wrote
    this.seen = new Set();       // parts of replies already taken: a part can be written twice
    this.title = '';
    this.name = '';
    this.cwd = '';
  }

  take(line) {
    const head = line.toString('latin1', 0, Math.min(line.length, HEAD));
    let kind;
    if (head.startsWith('{"parentUuid"') && head.includes('"attachment":{')) {
      if (!head.includes(QUEUED)) return;
      kind = 'queued';
    } else {
      kind = kindOf(line);
    }
    if (kind !== 'assistant' && kind !== 'user' && kind !== 'system' && kind !== 'queued' && kind !== 'ai-title' && kind !== 'custom-title') return;
    let o;
    try { o = JSON.parse(line.toString('utf8')); } catch { return; }
    if (kind === 'ai-title') this.title = clip(o.aiTitle, 120);
    else if (kind === 'custom-title') this.name = clip(o.customTitle, 120);
    else if (kind === 'assistant') this.takeReply(o);
    else if (kind === 'user') this.takeUser(o);
    else if (kind === 'system') this.takeSystem(o);
    else this.takeQueued(o);
  }

  /** Something typed by the person. The same message can be on record twice (typed while it worked, then handed over): once is enough. */
  ask(at, text, more) {
    for (let i = this.items.length - 1, n = 0; i >= 0 && n < 12; i--, n++) {
      const it = this.items[i];
      if (it.k === 'ask' && it.text === text) return;
    }
    this.items.push({ k: 'ask', at, text, ...more });
  }

  note(at, from, text) {
    if (!text) return;
    const last = this.items[this.items.length - 1];
    if (last && last.k === 'note' && last.text === text) return;
    this.items.push({ k: 'note', at, from, text });
  }

  takeUser(o) {
    if (o.type !== 'user' || !o.message) return;
    const at = Date.parse(o.timestamp) || 0;
    if (o.cwd && !this.cwd) this.cwd = String(o.cwd);
    const content = o.message.content;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
    const results = blocks.filter((b) => b && b.type === 'tool_result');
    if (results.length) {
      for (const b of results) {
        // the CLI's own record of the result belongs to the line; with several results on one line it cannot be told whose it is
        const res = resultOf(results.length === 1 ? o : {}, b, at);
        const call = this.calls.get(b.tool_use_id);
        if (call) settle(call, res);
        else if (typeof b.tool_use_id === 'string') this.orphans[b.tool_use_id] = res;
      }
      return;
    }
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n').trim();
    const pictures = blocks.filter((b) => b && b.type === 'image').length;
    if (o.isCompactSummary) { this.items.push({ k: 'summary', at, text: cut(text, CUT.asked) }); return; }
    if (o.isMeta || (!text && !pictures)) return;
    if (text.startsWith('[Request interrupted')) { this.items.push({ k: 'stop', at }); return; }
    if (PLUMBING.test(text)) {
      const name = /<command-name>([^<]{1,80})<\/command-name>/.exec(text);
      const args = /<command-args>([^<]{0,400})<\/command-args>/.exec(text);
      if (name) this.items.push({ k: 'cmd', at, text: `${name[1].trim()}${args && args[1].trim() ? ' ' + args[1].trim() : ''}` });
      return;
    }
    const origin = o.origin && o.origin.kind;
    if (origin === 'human' || (origin === undefined && !text.startsWith('<'))) {
      this.ask(at, cut(text, CUT.asked), { pictures, queued: o.promptSource === 'queued' });
    } else {
      this.note(at, String(origin || 'notice'), noticeText(text));
    }
  }

  /** A message that arrived while it worked. */
  takeQueued(o) {
    const a = o.attachment;
    if (!a || a.type !== 'queued_command') return;
    const at = Date.parse(a.timestamp || o.timestamp) || 0;
    const text = (typeof a.prompt === 'string' ? a.prompt : textOf(a.prompt)).trim();
    if (!text) return;
    const origin = a.origin && a.origin.kind;
    if (a.commandMode === 'prompt' && (origin === 'human' || origin === undefined)) this.ask(at, cut(text, CUT.asked), { pictures: 0, queued: true });
    else this.note(at, String(origin || a.commandMode || 'notice'), noticeText(text));
  }

  takeReply(o) {
    const msg = o.message;
    if (o.type !== 'assistant' || !msg) return;
    const at = Date.parse(o.timestamp) || 0;
    if (o.cwd && !this.cwd) this.cwd = String(o.cwd);
    const u = msg.usage;
    if (u && msg.id && !o.isApiErrorMessage) {
      const out = u.output_tokens || 0;
      const had = this.replies.get(msg.id);
      if (!had) this.replies.set(msg.id, { at, ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out });
      else if (out > had.out) had.out = out;
    }
    const model = msg.model && msg.model !== '<synthetic>' ? String(msg.model) : '';
    const list = Array.isArray(msg.content) ? msg.content : [];
    for (let i = 0; i < list.length; i++) {
      const block = list[i];
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        if (this.calls.has(block.id)) continue;
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        const item = {
          k: 'tool', at, id: String(block.id || ''), name: String(block.name || ''), label: toolName(block.name), what: toolTarget(block.name, input),
          input: inputOf(block.name, input), done: 0, error: false, out: '', note: '',
          // the change it asks for; taken as made once its result says so
          diff: askedDiff(block.name, input), applied: false,
        };
        this.calls.set(item.id, item);
        this.items.push(item);
        continue;
      }
      const words = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : null;
      if (words == null) continue;
      const mark = `${msg.id}|${block.type}|${Number.isInteger(o.apiBlockIndex) ? o.apiBlockIndex : i}|${String(words).length}`;
      if (this.seen.has(mark)) continue;
      this.seen.add(mark);
      if (block.type === 'thinking') {
        this.items.push({ k: 'think', at, text: cut(words, CUT.thought), ms: Number(o.thinkingDurationMs) || 0 });
      } else if (String(words).trim()) {
        if (o.isApiErrorMessage) this.items.push({ k: 'fail', at, text: cut(words, CUT.note), limit: limitOf(o) });
        else this.items.push({ k: 'say', at, text: cut(words, CUT.said), model });
      }
    }
  }

  takeSystem(o) {
    const at = Date.parse(o.timestamp) || 0;
    const last = this.items[this.items.length - 1];
    if (o.subtype === 'turn_duration') {
      // the mark a stop hook left a moment earlier is the same end of turn
      if (last && last.k === 'turn' && !last.ms) last.ms = Number(o.durationMs) || 0;
      else this.items.push({ k: 'turn', at, ms: Number(o.durationMs) || 0 });
    } else if (o.subtype === 'stop_hook_summary') {
      if (!last || last.k !== 'turn') this.items.push({ k: 'turn', at, ms: 0 });
    } else if (o.subtype === 'compact_boundary') {
      const m = o.compactMetadata || {};
      this.items.push({ k: 'compact', at, pre: Number(m.preTokens) || 0, ms: Number(m.durationMs) || 0, auto: m.trigger === 'auto' });
    } else if (o.subtype === 'away_summary' && o.content) {
      this.items.push({ k: 'recap', at, text: cut(o.content, CUT.note) });
    }
  }
}

/** Hangs what came back on the call it answers. */
function settle(call, res) {
  call.done = res.done;
  call.error = res.error;
  call.out = res.out;
  call.note = res.note;
  if (res.diff) call.diff = res.diff;
  call.applied = Boolean(call.diff) && !res.error;
}

/** Where the first line that begins at or after `from` starts; -1 when none begins before `to`. */
function lineAfter(fd, from, to) {
  if (from <= 0) return 0;
  const buf = Buffer.allocUnsafe(64 * 1024);
  for (let pos = from - 1; pos < to;) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, to - pos), pos);
    if (n <= 0) return -1;
    const i = buf.subarray(0, n).indexOf(10);
    if (i !== -1) return pos + i + 1 < to ? pos + i + 1 : -1;
    pos += n;
  }
  return -1;
}

/** The start of a run of whole lines that ends at `to` and is about `span` long; longer when one line alone is longer than that. */
function pageStart(fd, to, span) {
  for (let want = span; ; want *= 2) {
    const from = Math.max(0, to - want);
    if (from === 0) return 0;
    const at = lineAfter(fd, from, to);
    if (at >= 0) return at;
    if (want > 512 * 1024 * 1024) return to;
  }
}

/**
 * One page of a transcript. before: the page that ends at that offset (0: the page at the end of the file).
 * after: only what was written from that offset on. Returns { size, from, to, start, skipped, items, orphans,
 * replies, title, name, cwd }, or null when the file cannot be read. from and to are where the next page
 * backwards ends and where the next look forwards begins.
 */
function readPage(file, { before = 0, after = -1 } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    let from;
    let to = size;
    let skipped = false;
    if (after >= 0) {
      from = after;
      // a file that was replaced by a shorter one, or more new lines than are worth walking: start over from its end
      if (after > size || size - after > NEW_MAX) { from = pageStart(fd, size, PAGE); skipped = true; }
    } else {
      if (before > 0) to = Math.min(before, size);
      from = pageStart(fd, to, PAGE);
    }
    const page = new Page();
    const done = eachLine(fd, from, to, (line) => page.take(line));
    return {
      size, from, to: done, start: from === 0, skipped,
      items: page.items, orphans: page.orphans, replies: [...page.replies.values()], title: page.title, name: page.name, cwd: page.cwd,
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The few facts about a conversation that sit near the end of its file: what it is called, what was last asked of it, where it ran. */
function peekTail(file, bytes = 256 * 1024) {
  const found = { title: '', name: '', prompt: '', cwd: '', mode: '' };
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return found; }
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const buf = Buffer.allocUnsafe(size - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString('utf8', 0, n).split('\n');
    if (from > 0) lines.shift();
    const FIELDS = { 'ai-title': ['title', 'aiTitle'], 'custom-title': ['name', 'customTitle'], 'last-prompt': ['prompt', 'lastPrompt'], 'permission-mode': ['mode', 'permissionMode'] };
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith('{"type":"')) {
        const field = FIELDS[line.slice(9, line.indexOf('"', 9))];
        if (!field || found[field[0]]) continue;
        try { found[field[0]] = clip(JSON.parse(line)[field[1]], field[0] === 'prompt' ? 300 : 120); } catch { /* cut short */ }
      } else if (!found.cwd) {
        // the line's own folder stands after its body, near its end
        const at = line.lastIndexOf('"cwd":"');
        const m = at < 0 ? null : /^"cwd":"((?:[^"\\]|\\.)*)"/.exec(line.slice(at, at + 1200));
        if (m) { try { found.cwd = String(JSON.parse(`"${m[1]}"`)); } catch { /* not a path */ } }
      }
    }
  } catch {
    // unreadable: nothing is known about it
  } finally {
    fs.closeSync(fd);
  }
  return found;
}

module.exports = { Follower, Tally, eachLine, kindOf, toolName, toolTarget, waitsForPerson, clip, dayKey, emptyDay, setTimeline, whoAt, seekTime, UNKNOWN, readPage, peekTail };
