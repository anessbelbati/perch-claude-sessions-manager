'use strict';
// What the programs under the sessions use: memory, processor time, the ports they listen on, and what kind of
// program each is. Asked of a small PowerShell helper (procs.ps1) that stays running while the app does: starting
// one for every look would cost more than the look. Measured on his machine: about 18 ms of processor time an
// answer, 77 MB of memory for the helper itself.
const { spawn } = require('node:child_process');
const path = require('node:path');

const ANSWER_MS = 10000;
const READY_MS = 30000;
const TRIES = 3;

class Procs {
  constructor() {
    this.child = null;
    this.ready = false;
    this.buf = '';
    this.asked = 0;
    this.waiting = null;          // { q, resolve, timer }: one question at a time
    this.tries = 0;
    this.startedAt = 0;
    this.pid = 0;
  }

  /** Given up on: the helper would not start, or kept dying. */
  get failed() { return this.tries >= TRIES && !this.child; }

  start() {
    if (this.child || this.failed) return;
    this.tries++;
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let child;
    try {
      child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'procs.ps1')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return;
    }
    this.child = child;
    this.pid = child.pid || 0;
    this.startedAt = Date.now();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this.take(child, d));
    child.on('error', () => this.gone(child));
    child.on('exit', () => this.gone(child));
    child.stdin.on('error', () => { /* it ended: 'exit' says so */ });
  }

  take(child, d) {
    if (child !== this.child) return;
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let o = null;
      try { o = JSON.parse(line); } catch { /* not a whole answer */ }
      if (!o) continue;
      if (o.ready) { this.ready = true; this.tries = 0; continue; }
      const w = this.waiting;
      // an answer that came after its question was given up on belongs to nobody
      if (!w || o.q !== w.q) continue;
      this.waiting = null;
      clearTimeout(w.timer);
      w.resolve(o.error || !Array.isArray(o.p) ? null : o);
    }
    if (this.buf.length > 8 * 1024 * 1024) this.buf = '';
  }

  gone(child) {
    if (child !== this.child) return;
    this.child = null;
    this.ready = false;
    this.buf = '';
    const w = this.waiting;
    this.waiting = null;
    if (w) { clearTimeout(w.timer); w.resolve(null); }
  }

  /**
   * roots: program numbers. Resolves to { p: [[pid, ppid, name, startedMs, workingSet, privateWorkingSet, cpuMs,
   * kind, label]], l: [[port, pid]] }, every program under the roots included; null when there is no answer.
   */
  sample(roots) {
    this.start();
    if (this.child && !this.ready && Date.now() - this.startedAt > READY_MS) { this.stop(); return Promise.resolve(null); }
    if (!this.child || !this.ready || this.waiting) return Promise.resolve(null);
    const q = ++this.asked;
    return new Promise((resolve) => {
      this.waiting = { q, resolve, timer: setTimeout(() => { if (this.waiting && this.waiting.q === q) { this.waiting = null; resolve(null); } }, ANSWER_MS) };
      try { this.child.stdin.write(`${q} ${roots.join(' ')}\n`); } catch { this.waiting = null; resolve(null); }
    });
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.gone(child);
    try { child.stdin.end(); } catch { /* gone */ }
    // given a moment to end on its own, as its input closed
    setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 1500).unref();
  }
}

module.exports = { Procs };
