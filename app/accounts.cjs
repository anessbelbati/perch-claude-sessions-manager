'use strict';
// Which Claude account this machine is logged in to, which ones it was logged
// in to before, when one took over from another, and how much of each one's
// usage limits is used. All of it is read from what Claude Code keeps on disk:
// the name on an account, never the key that proves it. Nothing here asks
// anyone anything, and nothing here can log in, out, or switch.
//
// Where it reads:
//   ~/.claude.json                        who is logged in now, and the ids of the accounts it has a note about
//   ~/.claude.json.backup, .tmp.*,        older copies of that file: the names of accounts that are not logged in now
//   ~/.claude/backups/*
//   ~/.claude/history.jsonl               when /login was typed: the moments one account took over from another
const fs = require('node:fs');
const path = require('node:path');
const { eachLine } = require('./transcript.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINUTE = 60e3;
const HOUR = 60 * MINUTE;
const SAME_WINDOW = MINUTE;          // two reports of a limit this close in their reset times speak of the same window
const TRACK_EVERY = { five: 2 * MINUTE, week: 20 * MINUTE };
const TRACK_KEPT = 240;
const PACE_OVER = { five: 45 * MINUTE, week: 12 * HOUR };   // how far back the pace of a limit is measured
const PACE_NEEDS = { five: 5 * MINUTE, week: HOUR };        // and how long a stretch it takes to call it a pace
const MARKS_KEPT = 2000;
const LOGIN = Buffer.from('/login');

/** The first eight characters of an account's id: what it goes by here. */
const keyOf = (id) => String(id || '').slice(0, 8).toLowerCase();

/** Who an "oauthAccount" block of the settings file names; null when it names nobody. */
function identity(o) {
  if (!o || typeof o !== 'object' || !UUID.test(String(o.accountUuid || ''))) return null;
  const text = (v, max) => String(v || '').slice(0, max);
  return {
    key: keyOf(o.accountUuid),
    id: String(o.accountUuid).toLowerCase(),
    email: text(o.emailAddress, 120),
    name: text(o.displayName, 80),
    org: text(o.organizationName, 120),
    plan: text(o.organizationRateLimitTier || o.userRateLimitTier, 60),
    type: text(o.organizationType, 40),
  };
}

/** The text of the block that follows `"name":` in a JSON file, braces matched; '' when it is not there or not whole. */
function blockOf(text, name) {
  const at = text.indexOf(`"${name}"`);
  const open = at < 0 ? -1 : text.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\') i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return '';
}

function parsed(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The moments /login was typed, from byte `from` of the prompt history to its end. */
function loginsIn(file, from) {
  const times = [];
  let size;
  try { size = fs.statSync(file).size; } catch { return { times, offset: from }; }
  if (size < from) from = 0;            // not the file that was read before
  if (size === from) return { times, offset: from };
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { times, offset: from }; }
  let offset = from;
  try {
    offset = eachLine(fd, from, size, (line) => {
      if (line.indexOf(LOGIN) === -1) return;
      const o = parsed(line.toString('utf8'));
      const at = o ? Number(o.timestamp) : 0;
      if (at > 0 && /^\/login\b/.test(String(o.display || '').trim())) times.push(at);
    });
  } catch {
    // read again from the same place next time
  } finally {
    fs.closeSync(fd);
  }
  return { times: times.sort((a, b) => a - b), offset };
}

class Ledger {
  /** home: the person's home folder. file: where the ledger is kept between runs ('' keeps nothing). */
  constructor({ home, file }) {
    this.settings = path.join(home, '.claude.json');
    this.home = home;
    this.history = path.join(home, '.claude', 'history.jsonl');
    this.file = file || '';
    this.accounts = new Map();   // key -> { key, n, id, email, name, org, plan, type, first, last }; n: its number, in the order they were met
    this.marks = [];             // [{ at, key, seen }], oldest first: from `at` on the account in use was `key` ('' = not known)
    this.readings = new Map();   // key -> { five, week: { used, until, at } | null, track: { five, week: [[at, used]] } }
    this.current = '';           // the account logged in now
    this.historyAt = 0;          // how far the prompt history has been read, in bytes
    this.block = '';             // the login block of the settings file, as last read
    this.stamp = '';
    this.dirty = false;
    this.changed = 0;            // goes up whenever the marks change
    this.load();
  }

  load() {
    if (!this.file) return;
    const kept = parsed((() => { try { return fs.readFileSync(this.file, 'utf8'); } catch { return ''; } })());
    if (!kept || kept.v !== 1) return;
    for (const a of Array.isArray(kept.accounts) ? kept.accounts : []) {
      if (a && typeof a.key === 'string' && a.key) this.accounts.set(a.key, { id: '', email: '', name: '', org: '', plan: '', type: '', first: 0, last: 0, ...a, n: Number.isInteger(a.n) ? a.n : this.accounts.size });
    }
    this.marks = (Array.isArray(kept.marks) ? kept.marks : [])
      .filter((m) => m && Number.isFinite(m.at) && typeof m.key === 'string')
      .map((m) => ({ at: m.at, key: m.key, seen: Boolean(m.seen) }))
      .sort((a, b) => a.at - b.at);
    for (const [key, r] of Object.entries(kept.readings || {})) {
      const win = (w) => (w && Number.isFinite(w.used) && Number.isFinite(w.until) ? { used: w.used, until: w.until, at: Number(w.at) || 0 } : null);
      const track = (t) => (Array.isArray(t) ? t.filter((p) => Array.isArray(p) && p.length === 2) : []);
      this.readings.set(key, { five: win(r.five), week: win(r.week), track: { five: track(r.track && r.track.five), week: track(r.track && r.track.week) } });
    }
    this.historyAt = Number(kept.historyAt) || 0;
  }

  save() {
    if (!this.file || !this.dirty) return;
    try {
      const readings = {};
      for (const [key, r] of this.readings) readings[key] = r;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ v: 1, historyAt: this.historyAt, accounts: [...this.accounts.values()], marks: this.marks, readings }));
      fs.renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
    } catch {
      // tried again at the next save
    }
  }

  /** Takes in what is known about an account. Names are only ever filled in or replaced, never emptied. */
  learn(who, at) {
    let a = this.accounts.get(who.key);
    if (!a) {
      a = { key: who.key, n: this.accounts.size, id: '', email: '', name: '', org: '', plan: '', type: '', first: at, last: at };
      this.accounts.set(who.key, a);
      this.dirty = true;
    }
    for (const k of ['id', 'email', 'name', 'org', 'plan', 'type']) {
      if (who[k] && a[k] !== who[k]) { a[k] = who[k]; this.dirty = true; }
    }
    if (at < a.first) { a.first = at; this.dirty = true; }
    if (at > a.last) a.last = at;
    return a;
  }

  /** Older copies of the settings file that Claude Code leaves behind, oldest first. */
  copies() {
    const out = [];
    const take = (file) => {
      try {
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0 && st.size < 64 * 1024 * 1024) out.push({ file, at: Math.round(st.mtimeMs) });
      } catch { /* gone since the listing */ }
    };
    try { for (const n of fs.readdirSync(this.home)) if (/^\.claude\.json\.(backup|tmp\.)/.test(n)) take(path.join(this.home, n)); } catch { /* unreadable home */ }
    const backups = path.join(this.home, '.claude', 'backups');
    try { for (const n of fs.readdirSync(backups)) if (n.startsWith('.claude.json.')) take(path.join(backups, n)); } catch { /* none kept */ }
    return out.sort((a, b) => a.at - b.at);
  }

  /**
   * The accounts the settings file keeps a note about, apart from the one logged in: it holds blocks with one
   * entry per account id, each stamped with the moment it was last fetched, which is a moment that account was
   * the one logged in. Only a block that also holds an account already known is taken as such a block.
   */
  remembered(cfg) {
    const out = [];
    const known = new Set([...this.accounts.values()].map((a) => a.id).filter(Boolean));
    for (const block of Object.values(cfg)) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const ids = Object.keys(block).filter((k) => UUID.test(k));
      if (!ids.some((id) => known.has(id.toLowerCase()))) continue;
      for (const id of ids) {
        const at = Number(block[id] && block[id].timestamp) || 0;
        if (at > 0) out.push({ at, key: keyOf(id), id: id.toLowerCase() });
      }
    }
    return out;
  }

  /**
   * Run once at start: who is logged in, which accounts the disk remembers, and, for the time this app was not
   * looking, which account was in use when. That last part is worked out, not seen: every /login typed starts
   * a stretch, and a stretch belongs to the account some file shows was logged in during it. A stretch nothing
   * speaks for stays "not known".
   */
  seed(now = Date.now()) {
    const samples = [];          // moments an account is known to have been the one logged in
    for (const { file, at } of this.copies()) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const who = identity(parsed(blockOf(text, 'oauthAccount')));
      if (who) { this.learn(who, at); samples.push({ at, key: who.key }); }
    }
    let text = '';
    try {
      const st = fs.statSync(this.settings);
      text = fs.readFileSync(this.settings, 'utf8');
      this.stamp = `${st.mtimeMs}:${st.size}`;
    } catch { /* Claude Code was never run here */ }
    this.block = blockOf(text, 'oauthAccount');
    const me = identity(parsed(this.block));
    if (me) this.learn(me, now);
    const cfg = parsed(text);
    if (cfg && typeof cfg === 'object') {
      for (const r of this.remembered(cfg)) {
        this.learn({ key: r.key, id: r.id }, r.at);
        samples.push({ at: r.at, key: r.key });
      }
    }
    if (me) samples.push({ at: now, key: me.key });
    const { times, offset } = loginsIn(this.history, this.historyAt);
    if (offset !== this.historyAt) { this.historyAt = offset; this.dirty = true; }
    this.stretches(times, samples);
    this.current = me ? me.key : '';
    // logged out, or logged in to something the stretches do not end on
    if ((this.marks.length ? this.marks[this.marks.length - 1].key : '') !== this.current) this.mark(now, this.current, true);
  }

  mark(at, key, seen) {
    const last = this.marks[this.marks.length - 1];
    if (last && (last.key === key || at <= last.at)) return;
    this.marks.push({ at, key, seen: Boolean(seen) });
    if (this.marks.length > MARKS_KEPT) this.marks.splice(0, this.marks.length - MARKS_KEPT);
    this.changed++;
    this.dirty = true;
  }

  /** Turns /login moments and sightings of accounts, both newer than the last mark, into marks. */
  stretches(logins, samples) {
    const from = this.marks.length ? this.marks[this.marks.length - 1].at : -Infinity;
    const cuts = logins.filter((t) => t > from);
    const seen = samples.filter((s) => s.at > from).sort((a, b) => a.at - b.at);
    let s = 0;
    // before the first new /login: the stretch already on record runs on, unless a sighting says otherwise
    const until = (end) => {
      while (s < seen.length && seen[s].at < end) { this.mark(seen[s].at, seen[s].key, false); s++; }
    };
    until(cuts.length ? cuts[0] : Infinity);
    for (let i = 0; i < cuts.length; i++) {
      const end = i + 1 < cuts.length ? cuts[i + 1] : Infinity;
      // the account first sighted inside the stretch is taken to have held it from its start
      const first = s < seen.length && seen[s].at < end ? seen[s].key : '';
      const last = this.marks[this.marks.length - 1];
      // a /login into the account that was already in use changes nothing; one nothing speaks for is "not known"
      if (!last || last.key !== first) this.mark(cuts[i], first, false);
      until(end);
    }
  }

  /**
   * Looks at who is logged in now. True when that changed since the last look. The settings file is rewritten
   * every few seconds by every running session: only its login block is ever parsed.
   */
  observe(now = Date.now()) {
    let st;
    try { st = fs.statSync(this.settings); } catch { return false; }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === this.stamp) return false;
    let text = '';
    try { text = fs.readFileSync(this.settings, 'utf8'); } catch { return false; }
    const block = blockOf(text, 'oauthAccount');
    // a file caught half-written has no closing brace yet: it is read again at the next look
    if (!block && text.includes('"oauthAccount"')) return false;
    this.stamp = stamp;
    if (block === this.block) return false;
    this.block = block;
    const me = identity(parsed(block));
    if (me) this.learn(me, now);
    const key = me ? me.key : '';
    if (key === this.current) return false;
    // the /login that did it was typed a moment ago: that is when the new account took over
    const { times, offset } = loginsIn(this.history, this.historyAt);
    if (offset !== this.historyAt) { this.historyAt = offset; this.dirty = true; }
    const typed = times.filter((t) => t <= now && now - t < 5 * MINUTE).pop();
    this.current = key;
    this.mark(typed || now, key, true);
    // had the stretch on record started later than that /login, the mark was refused: it is put at this moment instead
    if ((this.marks.length ? this.marks[this.marks.length - 1].key : '') !== key) this.mark(now, key, true);
    return true;
  }

  /** The account in use at a moment; '' when not known. */
  whoAt(at) {
    let lo = 0;
    let hi = this.marks.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.marks[mid].at <= at) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found < 0 ? '' : this.marks[found].key;
  }

  /** The marks, for whoever files what was done under the account that did it. */
  timeline() {
    return this.marks.map((m) => ({ at: m.at, key: m.key }));
  }

  /**
   * Whose limit window resets at `until`: the account that has that window on record, '' when none has. The
   * 5-hour window opens with each account's own first message after the last one closed, so its reset moment
   * tells accounts apart; a weekly window can reset at the same moment for all of them, and tells nothing.
   * Should two accounts share the moment, the one logged in now is taken.
   */
  ownerOf(name, until) {
    let found = '';
    for (const [key, r] of this.readings) {
      const w = r[name];
      if (!w || Math.abs(w.until - until) > SAME_WINDOW) continue;
      if (key === this.current) return key;
      found = found || key;
    }
    return found;
  }

  /**
   * A usage limit of account `key`, as one of its sessions just reported it. Every session reports what it last
   * heard: within one window the highest figure is the newest, and a window that resets earlier than the one on
   * record is an old one. fresh: the session heard it just now, in answer to a call it made; that is the
   * service's own word on the window, and it stands even when it is lower than what was on record (a figure of
   * another account, filed here before it could be told apart).
   */
  reading(key, name, used, until, at, fresh) {
    if (!key || !Number.isFinite(used) || used < 0 || !(until > at)) return;
    let r = this.readings.get(key);
    if (!r) this.readings.set(key, r = { five: null, week: null, track: { five: [], week: [] } });
    const kept = r[name];
    if (kept && until < kept.until - SAME_WINDOW) return;
    const same = kept && until - kept.until <= SAME_WINDOW;
    if (same && used < kept.used && !fresh) return;
    // the figures on record for this window were not this account's: what they traced is no pace of its own
    if (!same || used < kept.used) r.track[name] = [];
    if (!same || used !== kept.used) this.dirty = true;
    r[name] = { used, until: same ? kept.until : until, at };
    const track = r.track[name];
    const last = track[track.length - 1];
    if (!last || used !== last[1] || at - last[0] >= TRACK_EVERY[name]) {
      track.push([at, used]);
      if (track.length > TRACK_KEPT) track.splice(0, track.length - TRACK_KEPT);
    }
  }

  /** How fast a limit of an account is being used up lately, in percent an hour; 0 when there is too little to tell. */
  pace(key, name, now) {
    const r = this.readings.get(key);
    const w = r && r[name];
    if (!w || w.until <= now) return 0;
    const points = r.track[name].filter((p) => now - p[0] <= PACE_OVER[name]);
    if (points.length < 2) return 0;
    const first = points[0];
    const last = points[points.length - 1];
    // measured up to now, not up to the last report: a limit nobody added to for a while is slowing down
    const span = Math.max(last[0], now) - first[0];
    if (span < PACE_NEEDS[name] || last[1] <= first[1]) return 0;
    return ((last[1] - first[1]) / span) * HOUR;
  }

  /** What the window shows. Nothing in it moves with the clock alone, so the same picture is the same text. */
  view(now = Date.now()) {
    const use = new Map();       // key -> the last stretch it was in use: [from, to], to = 0 while it still is
    for (let i = 0; i < this.marks.length; i++) {
      const m = this.marks[i];
      if (m.key) use.set(m.key, [m.at, i + 1 < this.marks.length ? this.marks[i + 1].at : 0]);
    }
    const list = [...this.accounts.values()].map((a) => {
      const r = this.readings.get(a.key);
      const stretch = use.get(a.key);
      const here = a.key === this.current;
      return {
        key: a.key, n: a.n, email: a.email, name: a.name, org: a.org, plan: a.plan, type: a.type,
        here,
        from: stretch ? stretch[0] : 0,
        // when it was last in use: 0 = it is in use now
        to: here ? 0 : stretch && stretch[1] ? stretch[1] : a.last,
        five: r && r.five ? r.five : null,
        week: r && r.week ? r.week : null,
        pace: { five: Math.round(this.pace(a.key, 'five', now) * 10) / 10, week: Math.round(this.pace(a.key, 'week', now) * 100) / 100 },
      };
    }).sort((a, b) => (a.here ? -1 : b.here ? 1 : b.to - a.to));
    const since = now - 31 * 24 * HOUR;
    let start = this.marks.findIndex((m) => m.at >= since);
    if (start < 0) start = this.marks.length;
    return { current: this.current, list, marks: this.marks.slice(Math.max(0, start - 1)) };
  }
}

module.exports = { Ledger, identity, blockOf, loginsIn, keyOf };
