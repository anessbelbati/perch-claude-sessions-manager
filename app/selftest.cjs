'use strict';
// Loaded only when DESK_SELFTEST=<folder> is set. Drives the real window,
// hidden, through the list of chats, the chats side by side in plain consoles
// and a live agent session, and keeps pictures of the window's own pixels
// (never of the screen). It never touches the clipboard and never sends
// anything to a model: the one Enter it presses on the agent's prompt is for
// /exit.
//   DESK_SELFTEST_TYPE=1       also type into the agent's prompt box, paste two
//                              lines, clear the box, leave with /exit, then
//                              measure what ten full scrollbacks cost.
//   DESK_SELFTEST_CLOSE=1      close the chat while the agent is running, and
//                              check the agent ended its session itself.
//   DESK_SELFTEST_CLOSE=quit   close the whole window instead; what became of
//                              the agent is then checked from outside, with
//                              the facts left in report.json.
//   DESK_SELFTEST_ONLY=widths  stop before the agent is started.
//   DESK_SELFTEST_ONLY=states  only the list and the pages: the real sessions, then the made-up ones. No terminal is opened.
//   DESK_SELFTEST_ONLY=spaces  the workspaces with real consoles, after the first console: plain consoles in folders
//                              the run makes for itself. No agent is started. (Run it with DESK_SELFTEST_SKIP=states.)
//   DESK_SELFTEST_ONLY=picture four plain consoles dressed as made-up chats, for pictures of the window that hold
//                              nothing of the person's: invented names, invented numbers, invented terminal text.
//   DESK_SELFTEST_ONLY=leave   two plain consoles are opened and one is named; the app is then closed the way the
//                              person closes it, answering "keep them". No agent is started.
//   DESK_SELFTEST_ONLY=back    the start after that, on the same profile: the two consoles come back by themselves.
//                              DESK_SELFTEST_EXPECT=auto (after a proper close) or crash (after a run that never
//                              reached its end, which is how a 'back' run itself ends).
//   DESK_SELFTEST_SKIP=states  leave out the made-up sessions, the reader, History, the Dashboard, the search box and Settings
//                              (the short run covers them), so a run with the agent stays under a minute.
//   DESK_SELFTEST_AGENT_ARGS   extra words for the agent's command line (its own debug switches, when a start or an end needs explaining)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Watch } = require('./watch.cjs');

// Text the sessions on this machine really print: emoji that are wide on their
// own, emoji that only become wide through a trailing selector or a joiner,
// kaomoji, and the status glyphs of the agent's own screen. Kept as code
// points: the script written from them has to be plain ASCII, or Windows
// PowerShell misreads it.
const SAMPLES = {
  'folder': [0x1F5C2, 0xFE0F],
  'folder-bare': [0x1F5C2],
  'warning': [0x26A0, 0xFE0F],
  'warning-bare': [0x26A0],
  'heart': [0x2764, 0xFE0F],
  'tick': [0x2705],
  'bird': [0x1F426],
  'brain': [0x1F9E0],
  // one emoji per year it was added, newest last: width tables go stale at the new end
  'emoji-2018': [0x1F9FF],
  'emoji-2019': [0x1FA70],
  'emoji-2019b': [0x1F7E0],
  'emoji-2020': [0x1F90C],
  'emoji-2020b': [0x1FAC0],
  'emoji-2020c': [0x1F6D7],
  'emoji-2021': [0x1FAE1],
  'emoji-2021b': [0x1F979],
  'emoji-2021c': [0x1F7F0],
  'emoji-2021d': [0x1F6DD],
  'emoji-2022': [0x1FAE8],
  'emoji-2022b': [0x1FA77],
  'emoji-2022c': [0x1F6DC],
  'emoji-2024': [0x1FAE9],
  'emoji-2024b': [0x1FA89],
  'coder': [0x1F468, 0x200D, 0x1F4BB],
  'flag': [0x1F1E9, 0x1F1FF],
  'thumb': [0x1F44D, 0x1F3FD],
  'kaomoji-1': [0x0669, 0x28, 0x25D5, 0x203F, 0x25D5, 0x29, 0x06F6],
  'kaomoji-2': [0x28, 0xFF61, 0x2022, 0x0300, 0x1D17, 0x2D, 0x29, 0x2727],
  'kaomoji-3': [0x28, 0x20, 0x02F6, 0x02C6, 0xA4B3, 0x02C6, 0x02F5, 0x20, 0x29, 0x2661],
  'kaomoji-4': [0x28, 0x0E51, 0x02C3, 0x1D17, 0x02C2, 0x29, 0xFEED],
  'kaomoji-5': [0x1566, 0x28, 0xF2, 0x5F, 0xF3, 0x02C7, 0x29, 0x1564],
  'status': [0x23F5, 0x23F5, 0x20, 0x2733, 0x20, 0x25CF, 0x20, 0x25D0, 0x20, 0x23BF, 0x20, 0x273B],
};
const BOX = String.fromCodePoint(0x2502);

// ---- these run inside the page; `term` there is the terminal of the chat in front ----
/* global term, Terminal, Terms, Desk, desk, Reader, History, popMenu, toast */
function pageScreen() {
  const b = term.buffer.active;
  const out = [];
  for (let y = b.baseY; y < b.baseY + term.rows; y++) {
    const line = b.getLine(y);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}
/** Every line a chat's terminal holds, whether that chat is in front or not. */
function pageLinesOf(id) {
  const b = Terms.get(id).term.buffer.active;
  const out = [];
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y);
    out.push(line ? line.translateToString(true) : '');
  }
  return out;
}
function pageColourOf(text) {
  const b = term.buffer.active;
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y);
    if (line && line.translateToString(true) === text) {
      const cell = line.getCell(0);
      return { palette: cell.isFgPalette(), colour: cell.getFgColor() };
    }
  }
  return null;
}
/** For every answer line "<tag>-<name>=<console column>": the column where the widget put the end mark of the line above it. */
function pageWidths(tag) {
  const b = term.buffer.active;
  const answer = new RegExp('^' + tag + '-([a-z0-9-]+)=(\\d+)$');
  const out = {};
  for (let y = 1; y < b.length; y++) {
    const line = b.getLine(y);
    const m = line && answer.exec(line.translateToString(true).trim());
    if (!m) continue;
    const above = b.getLine(y - 1);
    let end = -1;
    for (let x = 0; x < term.cols; x++) {
      const cell = above.getCell(x);
      if (cell && cell.getChars() === '|') end = x;
    }
    out[m[1]] = { console: Number(m[2]), widget: end + 1 };
  }
  return out;
}
function pageDrawing() {
  return {
    canvases: document.querySelectorAll('.term:not([hidden]) .xterm-screen canvas').length,
    buffer: term.buffer.active.type,
    widths: term.unicode.activeVersion,
  };
}
/** Counts the "hold this frame until it is complete" marks (mode 2026) that reach the widget. */
function pageWatchFrames() {
  window.deskFrames = 0;
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (Array.from(params).includes(2026)) window.deskFrames++;
    return false;
  });
  return true;
}
function pageShiftEnter() {
  term.textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true, bubbles: true, cancelable: true,
  }));
  return true;
}
async function pageFill(count, lines, cols) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1600px;height:700px';
  document.body.appendChild(host);
  const row = '\x1b[38;2;200;160;90m' + 'x'.repeat(30) + '\x1b[0m ' + 'word '.repeat(Math.floor((cols - 32) / 5)) + '\r\n';
  const block = row.repeat(500);
  const made = [];
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;inset:0';
    host.appendChild(el);
    const t = new Terminal({ cols, rows: 34, scrollback: lines, fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 16 });
    t.open(el);
    for (let k = 0; k < lines / 500; k++) await new Promise((done) => t.write(block, done));
    made.push(t);
  }
  window.deskExtra = { host, made };
  if (window.gc) window.gc();
  return made.map((t) => t.buffer.active.length);
}
function pageDrop() {
  for (const t of window.deskExtra.made) t.dispose();
  window.deskExtra.host.remove();
  delete window.deskExtra;
  if (window.gc) window.gc();
  return true;
}
function pageGc() {
  if (window.gc) window.gc();
  return Boolean(window.gc);
}
/** Starts a chat the way the New chat panel does, and waits until it has the keyboard. */
async function pageNew(ask) {
  const chat = await desk.create(ask);
  if (!chat || chat.error) return chat;
  Desk.setView(chat.id);
  // the list of chats that holds it can arrive a moment after the answer does
  for (let i = 0; i < 80 && Terms.active() !== chat.id; i++) await new Promise((r) => setTimeout(r, 25));
  return chat;
}
/** The chats of this window, as the list on the left shows them and in its order. */
function pageSide() {
  return [...document.querySelectorAll('#chat-list .nav-item.chat[data-row^="chat:"]')].map((el) => ({
    id: el.dataset.id,
    active: el.classList.contains('on'),
    shown: el.classList.contains('shown'),
    label: el.querySelector('.label').textContent,
    sub: el.dataset.sub,
    mark: el.dataset.mark,
  }));
}
/** True when something in a view is wider than the room it has: a pane that would scroll sideways. */
function pageSpill(view) {
  const wide = (el) => Boolean(el) && el.scrollWidth > el.clientWidth + 1;
  const root = document.getElementById(view);
  return wide(document.documentElement) || wide(root) || [...root.querySelectorAll('.split, .list-scroll, .d-body, .d-wrap')].some(wide);
}
/** The whole list on the left: every chat on the machine, by group. Rows of a folded group count too. */
function pageList() {
  const list = document.getElementById('chat-list');
  const wide = (el) => Boolean(el) && el.scrollWidth > el.clientWidth + 1;
  const groups = {};
  const order = [];
  for (const g of list.querySelectorAll('section.group')) {
    groups[g.dataset.group] = g.querySelectorAll('.nav-item.chat').length;
    order.push(g.dataset.group);
  }
  const sel = Desk.state.sel;
  return {
    view: Desk.state.view,
    rows: list.querySelectorAll('.nav-item.chat:not(.k-ended)').length,
    here: list.querySelectorAll('.nav-item.chat.k-here').length,
    away: list.querySelectorAll('.nav-item.chat.k-away').length,
    ended: list.querySelectorAll('.nav-item.chat.k-ended').length,
    groups,
    order,
    picked: list.querySelectorAll('.nav-item.chat.on').length,
    sel: sel ? sel.key : '',
    total: document.getElementById('side-n').textContent,
    overflow: wide(document.documentElement) || wide(list) || wide(document.getElementById('side')),
  };
}
/** The page a session that runs elsewhere is looked at on; with none picked and no chat open here, the page the window starts on. */
function pagePeek() {
  const root = document.getElementById('peek');
  const blank = root.querySelector('.blank');
  const pane = root.querySelector('.detail');
  return {
    view: Desk.state.view,
    hidden: root.hidden,
    start: blank.hidden ? '' : (blank.querySelector('h2') || {}).textContent || '',
    buttons: blank.hidden ? [] : [...blank.querySelectorAll('.blank-acts .btn')].map((b) => b.textContent),
    pane: Boolean(pane) && !pane.hidden,
    // a figure on the main screen: there must be none, they all live on the Dashboard
    figures: document.querySelectorAll('#peek .kpi, #peek .bar-slot, #peek .feed-row, #peek .run-row, #chat .kpi, #chat .bar-slot, #side .count').length,
  };
}
/** The chats on screen, by place: the room each has, the size of its terminal, and which one holds the keyboard. */
function pageTiles() {
  const grid = document.getElementById('tiles');
  return {
    n: Number(grid.dataset.n),
    tiles: [...grid.querySelectorAll('.tile')].map((t) => {
      const r = t.getBoundingClientRect();
      const entry = Terms.get(t.dataset.id);
      const b = entry ? entry.term.buffer.active : null;
      return { id: t.dataset.id, on: t.classList.contains('on'), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        cols: entry ? entry.term.cols : 0, rows: entry ? entry.term.rows : 0, drawn: Boolean(t.querySelector('.tile-body > .term:not([hidden]) .xterm')),
        // the terminal stands at the end of what it holds
        atEnd: Boolean(b) && b.viewportY === b.baseY, kept: t.dataset.kept || '' };
    }),
    keyboard: Terms.active(),
    parked: document.querySelectorAll('#park > .term').length,
    split: [...document.querySelectorAll('#split button')].map((b) => b.dataset.n + (b.classList.contains('on') ? '*' : '')),
    saved: [Desk.state.settings.tiles, Desk.state.settings.split],
    order: Desk.state.shown.slice(),
  };
}
/** The strip above one chat: its name, what it is doing, the one figure it keeps, its two buttons, and where they stand. */
function pageStrip(chat) {
  const head = document.querySelector(`#tiles .tile[data-id="${chat}"] .tile-head`);
  if (!head) return null;
  const box = (sel) => head.querySelector(sel).getBoundingClientRect();
  const edge = head.getBoundingClientRect().right - parseFloat(getComputedStyle(head).paddingRight);
  const name = head.querySelector('.th-name');
  const words = head.querySelector('.th-doing .words');
  const folder = head.querySelector('.th-folder');
  const facts = [...head.querySelectorAll('.th-facts .fact')].filter((x) => x.getClientRects().length);
  return {
    head: Math.round(head.getBoundingClientRect().width), short: Math.round(edge - box('.th-tools').right),
    name: name ? name.textContent : '', nameWide: name ? Math.round(name.getBoundingClientRect().width) : 0, nameCut: Boolean(name) && name.scrollWidth > name.clientWidth,
    folder: folder && folder.getClientRects().length ? folder.textContent : '',
    doing: words ? words.textContent : '', doingCut: Boolean(words) && words.scrollWidth > words.clientWidth,
    timer: (head.querySelector('.th-doing .timer') || {}).textContent || '',
    facts: facts.map((x) => x.textContent), figures: head.querySelectorAll('.fact').length,
    buttons: head.querySelectorAll('.th-tools .icon-btn').length, pressed: head.querySelector('.th-tools .icon-btn').classList.contains('on'),
    tip: (head.querySelector('.th-facts') || { dataset: {} }).dataset.tip || '',
    marked: getComputedStyle(head).boxShadow !== 'none',
    spill: head.scrollWidth > head.clientWidth + 1,
  };
}
/** A press of the mouse on something, as the page sees one: down, up, click. */
function pagePress(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
  el.click();
  return true;
}
/** A key pressed with Ctrl held (and Shift, when asked): the window's own keys. up: Ctrl is let go after it. */
function pageCtrl(code, shift, up) {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: code, code, ctrlKey: true, shiftKey: Boolean(shift), bubbles: true, cancelable: true }));
  if (up) document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', code: 'ControlLeft', bubbles: true }));
  return true;
}
/** The pane that shows one conversation, inside a view ('peek', 'history') or the panel beside a chat ('inspector'). */
function pageDetail(where) {
  const root = document.getElementById(where);
  const pane = root.querySelector('.detail');
  const text = (sel) => { const el = pane && pane.querySelector(sel); return el ? el.textContent : ''; };
  const all = (sel) => (pane ? [...pane.querySelectorAll(sel)] : []);
  return {
    shown: Boolean(pane) && !pane.hidden && pane.getClientRects().length > 0,
    title: text('.d-title'),
    words: text('.d-state .words'),
    mark: ((pane && pane.querySelector('.d-state')) || { className: '' }).className.replace('d-state s-', ''),
    button: text('.d-acts .btn'),
    tabs: all('.seg.tabs button').map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')),
    heads: all('.d-body .sec-head h4').map((x) => x.textContent),
    calls: all('.d-body .tl-row').length,
    agents: all('.d-body .ag-row').length,
    facts: all('.d-facts .fact').filter((x) => !x.hidden).map((x) => x.textContent),
    chips: all('.d-sub .chip').map((x) => x.textContent),
    notice: text('.d-body .callout .callout-title'),
  };
}
/** What the reader holds on screen, by kind. Counts only: never a word of the conversation. */
function pageReader(where) {
  const root = document.getElementById(where);
  const n = (sel) => root.querySelectorAll(sel).length;
  const jump = root.querySelector('.rd-jump');
  return {
    asks: n('.rd-list .rd-ask'), says: n('.rd-list .rd-say'), tools: n('.rd-list .rd-tool'), failed: n('.rd-list .rd-tool.err'), running: n('.rd-list .rd-tool.run'),
    thoughts: n('.rd-list .rd-think'), turns: n('.rd-list .rd-turn'), marks: n('.rd-list .rd-mark'), notes: n('.rd-list .rd-note'), runs: n('.rd-list .rd-run'),
    days: n('.rd-list .rd-day'), open: n('.rd-list .rd-tool.open'), diffLines: n('.rd-list .diff .dl'), added: n('.rd-list .diff .dl.add'), removed: n('.rd-list .diff .dl.del'),
    tables: n('.rd-list .md-table'), code: n('.rd-list .md-pre'), lists: n('.rd-list .md-lists li'), headings: n('.rd-list .md-h'),
    new: n('.rd-list .rise'), empty: (root.querySelector('.reader .empty') || {}).textContent || '',
    top: (root.querySelector('.rd-top') || {}).textContent || '', asked: (root.querySelector('.rd-bar .btn') || {}).textContent || '',
    jump: jump && !jump.hidden ? jump.textContent : '',
  };
}
/** Moves the page's clock by `shift` ms (0: back to the real one), so the made-up day looks the same at any hour the test runs. */
function pageClock(shift) {
  if (!window.RealDate) window.RealDate = Date;
  const Real = window.RealDate;
  if (!shift) { window.Date = Real; return Date.now(); }
  window.Date = class extends Real {
    constructor(...args) { if (args.length) super(...args); else super(Real.now() + shift); }
    static now() { return Real.now() + shift; }
  };
  return Date.now();
}
/** Hands the reader and the History view made-up conversations instead of real ones. pages: JSON texts, parsed afresh for every reader that asks. */
function pageFakes(pages, history) {
  window.deskFake = { pages, grown: false, older: false };
  Reader.fake = (source, more) => {
    const F = window.deskFake;
    const copy = (name) => JSON.parse(F.pages[name]);
    // a subagent's own conversation; the session that started them; one that is not running, from its first line
    // to its last; and the one being written, which is read a page at a time and grows
    const name = source.agent ? 'agent' : source.key === 's-agents' ? 'pricing' : source.live ? 'main' : 'whole';
    const first = copy(name);
    if (more.after != null) {
      if (name === 'main' && F.grown && more.after < copy('grown').to) return copy('grown');
      return { ...first, from: more.after, to: more.after, items: [], orphans: {}, replies: [] };
    }
    if (more.before) return name === 'main' && F.older ? copy('older') : null;
    return first;
  };
  History.fake = () => JSON.parse(history);
  return true;
}
function pageKey(key, on) {
  const target = on ? document.querySelector(on) : document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return true;
}
async function pagePicker() {
  Desk.openPicker();
  // the lists fill in once the watcher has walked the project folders
  for (let i = 0; i < 100 && document.querySelector('#picker .recent .quiet'); i++) await new Promise((r) => setTimeout(r, 100));
  // what a past conversation is called can be the first thing typed into it: a picture never shows those words
  let n = 0;
  for (const el of document.querySelectorAll('#picker .recent .pick .name')) el.textContent = `A past conversation (${++n})`;
  return {
    open: !document.getElementById('picker').hidden,
    starters: [...document.querySelectorAll('#picker .seg button')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')),
    folders: document.querySelectorAll('#picker .folders .pick').length,
    recent: document.querySelectorAll('#picker .recent .pick').length,
  };
}
/** The workspaces above the list: the tabs, which one is in front, what each says in yellow, and the rows the list holds under them. */
function pageSpaces() {
  const root = document.getElementById('spaces');
  const label = document.getElementById('side-label');
  const count = document.getElementById('side-n');
  const s = Desk.state.settings;
  const empty = document.getElementById('side-empty');
  return {
    on: !root.hidden,
    label: label.hidden ? '' : label.textContent,
    count: count.hidden ? '' : count.textContent,
    tabs: [...root.querySelectorAll('.space-tab')].map((t) => ({ id: t.dataset.space, name: t.querySelector('.space-name').textContent, on: t.classList.contains('on'),
      n: (t.querySelector('.space-n') || { textContent: '' }).textContent, tip: t.dataset.tip || '' })),
    input: Boolean(root.querySelector('.space-input')),
    typing: Boolean(document.activeElement) && document.activeElement.classList.contains('space-input'),
    space: s.space,
    loose: Desk.state.loose,
    spaces: s.spaces.map((x) => ({ id: x.id, name: x.name, folders: x.folders.slice() })),
    keys: [...document.querySelectorAll('#chat-list .nav-item.chat:not(.k-ended)')].map((el) => el.dataset.key),
    empty: empty.hidden ? '' : empty.textContent,
    // a tab that sticks out of the sidebar, or a row of tabs wider than it
    spill: root.scrollWidth > root.clientWidth + 1 || [...root.children].some((el) => el.getBoundingClientRect().right > root.getBoundingClientRect().right + 1),
    lines: new Set([...root.children].map((el) => Math.round(el.getBoundingClientRect().top))).size,
  };
}
/** The menu that is open: its headings, and what it offers, each with whether it is ticked. null when none is. */
function pageMenu() {
  const el = document.getElementById('menu');
  if (el.hidden) return null;
  return {
    heads: [...el.querySelectorAll('.menu-head')].map((x) => x.textContent),
    items: [...el.querySelectorAll('.menu-item')].map((b) => ({ label: b.querySelector('span:not(.icon-gap)').textContent, ticked: b.getAttribute('aria-checked') === 'true' })),
  };
}
/** A right click on something, the way the mouse does it. */
function pageRightClick(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + r.height / 2) }));
  return true;
}
/** Runs one entry of the menu that is open, by its words. */
function pageMenuRun(label) {
  const item = [...document.querySelectorAll('#menu .menu-item')].find((b) => b.querySelector('span:not(.icon-gap)').textContent === label);
  if (item) item.click();
  return Boolean(item);
}
/**
 * Draws a made-up agent screen into one chat's terminal, for a picture that may be shown to people: invented words in
 * the shapes an agent CLI prints (what was asked, replies, tool calls, a prompt box). Nothing is sent to the console
 * behind it. A terminal with fewer rows than the screen has lines keeps the newest ones. Returns the rows it drew.
 */
function pageDress(id, kind) {
  const entry = Terms.get(id);
  if (!entry) return 0;
  const term = entry.term;
  const cols = term.cols;
  const rows = term.rows;
  const room = Math.max(24, cols - 1);
  const C = { dim: '38;5;245', ok: '38;5;114', bad: '38;5;210', warm: '38;5;216', hi: '1' };
  const wrap = (text, width) => {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
      if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
    return lines;
  };
  // What stands above the prompt. Each of these gives a list of lines, and a line is a list of [style, words];
  // what is asked and what is said run on to the width of the terminal they are drawn in.
  const gap = [[]];
  const asked = (text) => wrap(text, room - 2).map((part, i) => [[C.dim, `${i ? ' ' : '>'} ${part}`]]);
  const said = (text) => wrap(text, room - 2).map((part, i) => [[C.hi, i ? '  ' : '● '], ['', part]]);
  const plain = (text) => [[['', `  ${text}`]]];
  const tool = (name, what, going) => [[[going ? C.dim : C.ok, '● '], [C.hi, name], ['', `(${what})`]]];
  const out = (...texts) => texts.map((text, i) => [[C.dim, `${i ? '     ' : '  ⎿  '}${text}`]]);
  const diff = (n, sign, text) => [[[C.dim, `     ${String(n).padStart(4)} `], [sign === '+' ? C.ok : sign === '-' ? C.bad : '', `${sign} ${text}`]]];
  const busy = (text, note) => [[[C.warm, `✻ ${text}`], [C.dim, ` ${note}`]]];
  const cut = (parts, width) => {
    const kept = [];
    let left = width;
    for (const [style, text] of parts) {
      if (left <= 0) break;
      const t = text.slice(0, left);
      kept.push([style, t]);
      left -= t.length;
    }
    return { parts: kept, left };
  };
  // What stands at the foot: single lines.
  const rule = (a, b) => [[C.dim, `${a}${'─'.repeat(room - 2)}${b}`]];
  const boxed = (...parts) => { const c = cut(parts, room - 4); return [[C.dim, '│ '], ...c.parts, ['', ' '.repeat(c.left)], [C.dim, ' │']]; };
  const promptBox = [rule('╭', '╮'), boxed(['', '> ']), rule('╰', '╯')];
  const mode = (extra) => [[C.dim, `  ⏵⏵ bypass permissions on (shift+tab to cycle)${extra ? `  ·  ${extra}` : ''}`]];
  // prompt: which line of the foot the cursor stands in (-1: a question is open, and there is no cursor)
  const screens = {
    checkout: {
      top: [
        asked('The tax field is lost when the basket is edited twice. Fix it, then deploy.'), gap,
        said("I'll look at how the basket keeps its fields between edits."), gap,
        tool('Read', 'src/checkout/basket.ts'), out('Read 212 lines'), gap,
        tool('Search', 'pattern: "taxField", path: "src/checkout"'), out('Found 7 lines'), gap,
        said('The second edit rebuilds the basket from the form, and the form never held the tax field. I will carry it over from the basket itself.'), gap,
        tool('Update', 'src/checkout/basket.ts'), out('Updated src/checkout/basket.ts with 2 additions and 1 removal'),
        diff(88, ' ', 'const next = fromForm(form);'),
        diff(89, '-', 'return next;'),
        diff(89, '+', '// the form does not hold the tax field: it is carried over'),
        diff(90, '+', 'return { ...next, taxField: basket.taxField };'), gap,
        tool('Bash', 'npm test -- checkout'), out('Tests: 41 passed, 41 total', 'Time:  4.2 s'), gap,
        said('The basket keeps its tax field now, and all 41 tests pass. Ready to deploy.'),
      ],
      foot: [
        rule('╭', '╮'),
        boxed([C.hi, 'Bash command']),
        boxed(),
        boxed(['', '  npm run deploy -- --production']),
        boxed([C.dim, '  Deploy the site to production']),
        boxed(),
        boxed(['', 'Do you want to proceed?']),
        boxed([C.ok, '❯ 1. Yes']),
        boxed(['', "  2. Yes, and don't ask again for npm run deploy commands"]),
        boxed(['', '  3. No, and tell Claude what to do differently '], [C.dim, '(esc)']),
        rule('╰', '╯'),
      ],
      prompt: -1,
    },
    pricing: {
      top: [
        asked('Compare our prices against the five closest competitors and tell me where we are out of line.'), gap,
        said('Five competitors, each with its own pricing page. First our own plans, so there is something to compare against.'), gap,
        tool('Web Search', '"competitor pricing pages 2026"'), out('Found the public pricing pages of competitors A to E'), gap,
        tool('Read', 'plans.md'), out('Read 48 lines'), gap,
        said('Our three tiers are 35, 79 and 149 a month. I am sending one subagent to each competitor, and I will build the table once they are back.'), gap,
        tool('Task', 'Compare competitor A'), out('Done (31 tool uses · 44.1k tokens · 2m 50s)'), gap,
        tool('Task', 'Compare competitor B'), out('Done (24 tool uses · 38.7k tokens · 2m 12s)'), gap,
        tool('Task', 'Compare competitor C'), out('Done (27 tool uses · 41.0k tokens · 2m 31s)'), gap,
        tool('Task', 'Compare competitor D', true), out('Web Fetch(competitor-d.example/pricing)', '+11 more tool uses'), gap,
        tool('Task', 'Compare competitor E', true), out('Found the monthly plans; looking for the yearly ones.', '+9 more tool uses'), gap,
        said('Three of the five are in. Waiting on the last two before I build the table.'), gap,
        busy('Comparing…', '(11m 02s · ↓ 121k tokens · esc to interrupt)'),
      ],
      foot: [...promptBox, mode('3 subagents')],
      prompt: 1,
    },
    refactor: {
      top: [
        asked('Split the rate limiter into modules. Keep every test green on the way.'), gap,
        tool('Read', 'src/api/limiter.ts'), out('Read 640 lines'), gap,
        said('The file does three jobs: counting, storing and answering. One module each.'), gap,
        tool('Write', 'src/api/limiter/count.ts'), out('Wrote 118 lines to src/api/limiter/count.ts'), gap,
        tool('Write', 'src/api/limiter/store.ts'), out('Wrote 164 lines to src/api/limiter/store.ts'), gap,
        tool('Update', 'src/api/limiter.ts'), out('Updated src/api/limiter.ts with 48 additions and 331 removals'), gap,
        tool('Bash', 'npm test -- limiter'), out('Tests: 118 passed, 118 total', 'Time:  9.8 s'), gap,
        said('The limiter is three modules now, and all 118 tests pass. Next: the callers in routes/.'), gap,
        busy('Compacting conversation…', '(50s · esc to interrupt)'),
      ],
      foot: [...promptBox, mode('')],
      prompt: 1,
    },
    landing: {
      top: [
        asked('Rewrite the three sections of the landing page so each says what the product does.'), gap,
        tool('Read', 'src/landing/hero.tsx'), out('Read 74 lines'), gap,
        tool('Update', 'src/landing/hero.tsx'), out('Updated src/landing/hero.tsx with 14 additions and 9 removals'), gap,
        tool('Update', 'src/landing/features.tsx'), out('Updated src/landing/features.tsx with 22 additions and 17 removals'), gap,
        tool('Update', 'src/landing/pricing.tsx'), out('Updated src/landing/pricing.tsx with 9 additions and 9 removals'), gap,
        tool('Bash', 'npm run build'), out('Built in 41s', '0 errors, 0 warnings'), gap,
        said('All three sections are rewritten and the page builds without errors.'), gap,
        plain('Hero       says what it does in one line'),
        plain('Features   three things it does, each with an example'),
        plain('Pricing    the three tiers, no small print'),
      ],
      foot: [...promptBox, mode('')],
      prompt: 1,
    },
  };
  const screen = screens[kind] || screens.landing;
  let lines = [...screen.top.flat(), [], ...screen.foot];
  if (lines.length > rows) lines = lines.slice(lines.length - rows);
  const at = screen.prompt < 0 ? 0 : lines.length - screen.foot.length + screen.prompt + 1;
  const draw = (parts) => cut(parts, cols - 1).parts.map(([style, text]) => (style ? `\x1b[${style}m${text}\x1b[0m` : text)).join('');
  // a terminal that does not hold the keyboard draws its cursor as an outline; the one that does keeps its bar
  term.options.cursorInactiveStyle = id === Terms.active() ? 'bar' : 'outline';
  term.reset();
  term.write(lines.map(draw).join('\r\n') + (at > 0 ? `\x1b[${at};5H` : '\x1b[?25l'));
  return lines.length;
}

module.exports = async function selfTest({ app, win, dir, engine, chats, watch, writeLink, keptOf, restoreMode, lastEnd, planChat, settingsNow }) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const notes = { engine };
  let failed = 0;
  // an error thrown inside the page (in a click handler, in a timer) is reported nowhere else
  const pageErrors = [];
  win.webContents.on('console-message', (event, level, message, line, source) => {
    const d = event && typeof event.message === 'string' ? event : { level, message, lineNumber: line, sourceId: source };
    if (d.level === 'error' || d.level === 3) pageErrors.push(`${d.message} (${path.basename(String(d.sourceId || ''))}:${d.lineNumber})`);
  });
  const flush = () => fs.writeFileSync(path.join(dir, 'report.txt'), lines.join('\n') + '\n');
  const say = (text) => { lines.push(text); flush(); };
  const check = (name, ok, detail = '') => {
    if (!ok) failed++;
    say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
    return ok;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const inPage = (fn, ...args) => exec(`(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`);
  const until = async (probe, ms, step = 150) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > end) return null;
      await wait(step);
    }
  };
  const screen = () => inPage(pageScreen);
  const linesOf = (id) => inPage(pageLinesOf, id);
  const type = (text) => exec(`term.input(${JSON.stringify(text)}, true)`);
  const view = (id) => exec(`Desk.setView(${JSON.stringify(id)})`);
  // a picture is taken only once the page has drawn what was just changed (two frames, or a quarter of a second if none come)
  const drawn = () => exec('Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r("frames")))), new Promise((r) => setTimeout(() => r("timer"), 250))])');
  const shoot = async (name, keepToast) => {
    // the line at the bottom of the window comes and goes on a timer: a picture is of what is under it
    if (!keepToast) await exec('document.getElementById("toast").hidden = true');
    await drawn();
    // A hidden window hands back the frame it last drew, which can be the one from before the change. Asking once
    // makes it draw; the second answer is the picture.
    await win.webContents.capturePage();
    await wait(150);
    fs.writeFileSync(path.join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const keep = async (name) => fs.writeFileSync(path.join(dir, `${name}.txt`), (await screen()).join('\n') + '\n');
  const settle = async (quietMs, maxMs) => {
    const end = Date.now() + maxMs;
    let last = '';
    let since = Date.now();
    while (Date.now() < end) {
      const now = (await screen()).join('\n');
      if (now !== last) { last = now; since = Date.now(); }
      else if (Date.now() - since >= quietMs) return true;
      await wait(200);
    }
    return false;
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const childrenNamed = (parentPid, name) => {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(parentPid)}" | Where-Object { $_.Name -eq '${name}' }).ProcessId`],
        { encoding: 'utf8', windowsHide: true });
      return out.split(/\s+/).filter(Boolean).map(Number);
    } catch { return []; }
  };
  const memory = () => {
    const byKind = {};
    let working = 0;
    let priv = 0;
    for (const m of app.getAppMetrics()) {
      const mb = Math.round(m.memory.workingSetSize / 1024);
      byKind[m.type] = (byKind[m.type] || 0) + mb;
      working += m.memory.workingSetSize;
      priv += m.memory.privateBytes || 0;
    }
    return { processes: app.getAppMetrics().length, workingMb: Math.round(working / 1024), privateMb: Math.round(priv / 1024), byKind };
  };
  const pageMemory = () => {
    const pid = win.webContents.getOSProcessId();
    const m = app.getAppMetrics().find((x) => x.pid === pid);
    return m ? { workingMb: m.memory.workingSetSize / 1024, privateMb: (m.memory.privateBytes || 0) / 1024 } : null;
  };
  const promptBack = async () => {
    const rows = (await screen()).filter((l) => l.trim());
    return rows.length > 0 && /^PS .*>\s*$/.test(rows[rows.length - 1]);
  };

  const report = async (when) => {
    const m = memory();
    const w = await watch.ask('stats');
    say(`      memory ${when}: ${m.workingMb} MB in use (${m.privateMb} MB private) over ${m.processes} processes ${JSON.stringify(m.byKind)}`
      + (w ? `; the watcher thread holds ${w.heapUsedMb} MB (${w.heapTotalMb} MB set aside, ${w.outsideHeapMb} MB of buffers) for ${w.sessions} sessions and ${w.agents} subagent files` : ''));
    return { ...m, watcher: w };
  };
  const typing = process.env.DESK_SELFTEST_TYPE === '1';
  const closing = process.env.DESK_SELFTEST_CLOSE || '';
  const agent = { pid: 0, sessionId: '', firstFrameAt: 0, chat: '' };
  const agentUp = () => agent.pid > 0 && alive(agent.pid);
  const folder = path.resolve(__dirname, '..');
  const plain = { cwd: folder, starter: 'shell' };

  // What the Perch hook, when installed, recorded for this session.
  const hookDir = path.join(process.env.LOCALAPPDATA || '', 'AgentFocus');
  const hookLog = path.join(hookDir, 'hook-timing.log');
  const hookRecord = () => {
    const statusDir = path.join(hookDir, 'status');
    for (const name of fs.existsSync(statusDir) ? fs.readdirSync(statusDir) : []) {
      if (!name.endsWith('.json')) continue;
      try {
        // a status file may start with a byte-order mark, which JSON.parse refuses
        const text = fs.readFileSync(path.join(statusDir, name), 'utf8');
        const r = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
        if (Number(r.agent_pid) === agent.pid) {
          return {
            status: r.status,
            headless: Boolean(r.headless),
            window: r.window ? { tab_name: r.window.tab_name, captured_event: r.window.captured_event } : null,
          };
        }
      } catch { /* a file mid-write: the next poll reads it whole */ }
    }
    return null;
  };
  const hookLogged = (event) => {
    if (!agent.sessionId) return false;
    try {
      return fs.readFileSync(hookLog, 'utf8').includes(` ${event} ${agent.sessionId.slice(0, 8)} `);
    } catch { return false; }
  };

  // What Claude Code itself keeps: one file per running session, and three
  // machine-wide notes about fullscreen starts (still pending, failed, turned off).
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  const liveFile = () => path.join(sessionsDir, `${agent.pid}.json`);
  const fullscreenNotes = () => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
      return {
        pending: Object.keys(d.fullscreenBootPending || {}),
        failedStarts: d.fullscreenBootStrikes ? d.fullscreenBootStrikes.count : 0,
        turnedOff: Boolean(d.fullscreenAutoDisabled),
      };
    } catch { return null; }
  };
  // The sign that the agent ended its session itself instead of being cut off:
  // it removed its own live-session file. Whether it then ran its end-of-session
  // scripts is the CLI's own decision (an orderly /exit has been seen to skip
  // them), so that is checked under its own name and never read as a cut-off.
  const endedItself = async () => {
    const fileGone = Boolean(await until(async () => !fs.existsSync(liveFile()), 8000, 200));
    const hookRan = agent.sessionId && fs.existsSync(hookLog)
      ? Boolean(await until(async () => hookLogged('SessionEnd'), 8000, 300))
      : null;
    return { fileGone, hookRan };
  };
  const endScripts = (end) => {
    if (end.hookRan === null) say('      no end-of-session hook is installed, so nothing to see there');
    else check('the CLI ran its end-of-session scripts', end.hookRan, end.hookRan ? '' : 'the Perch hook left no "session ended" line for this session');
  };
  /** The interactive sessions alive right now, counted straight from the CLI's own files: a second way to the dashboard's number. */
  const liveSessions = () => {
    let n = 0;
    for (const name of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
      if (!/^\d+\.json$/.test(name)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), 'utf8'));
        if (!rec.parkedJobId && rec.kind !== 'bg' && alive(Number(name.slice(0, -5)))) n++;
      } catch { /* mid-write */ }
    }
    return n;
  };
  const shownSessions = () => watch.latest().chats.filter((c) => c.provider === 'claude' && c.kind === 'interactive' && c.pid).length;

  // ---- the start: every chat on the machine in the list, before this window has a chat of its own ----
  const KINDS = ['ask', 'say', 'think', 'tool', 'cmd', 'stop', 'turn', 'compact', 'summary', 'recap', 'note', 'fail'];
  // the groups of the list on the left, in the order they stand
  const GROUP_ORDER = ['needs', 'done', 'working', 'idle', 'old', 'ended'];
  const inOrder = (order) => order.every((g, i) => GROUP_ORDER.includes(g) && (i === 0 || GROUP_ORDER.indexOf(g) > GROUP_ORDER.indexOf(order[i - 1])));
  /** What the start page offers, going by the watcher's own picture: the chats that run in other terminals can be moved here. */
  const startButtons = () => {
    const n = watch.latest().chats.filter((c) => c.provider === 'claude' && c.pid && c.session && c.kind !== 'bg').length;
    return n > 1 ? ['New chat', `Bring all ${n} here`, 'History'] : n === 1 ? ['New chat', 'Bring it here', 'History'] : ['New chat', 'History'];
  };
  const START = 'No chat is open in this window';
  const startPhase = async () => {
    const started = Date.now();
    check('the window loads', Boolean(await until(() => exec('typeof Desk === "object" && Desk !== null'), 15000)));
    const first = await until(async () => watch.latest().at > 0 && watch.latest(), 20000);
    check('the watcher delivers its first picture of the machine', Boolean(first), `${Date.now() - started} ms after launch`);
    const sameCount = await until(async () => liveSessions() === shownSessions(), 8000, 500);
    check('every live Claude Code session is in that picture', Boolean(sameCount),
      `${shownSessions()} in the picture, ${liveSessions()} counted from the CLI's own session files`);
    // the list on the left: every chat on the machine once, by what it wants from the person
    const seen = await until(async () => { const n = watch.latest().chats.length; const l = await inPage(pageList); return l.rows === n ? { l, n } : null; }, 6000, 300);
    const list = seen ? seen.l : await inPage(pageList);
    const pictured = seen ? seen.n : watch.latest().chats.length;
    notes.list = list;
    check('the list on the left holds every chat on this machine once, in groups, with none of them picked',
      list.view === 'peek' && list.rows === pictured && list.here === 0 && list.away === pictured && list.picked === 0 && inOrder(list.order)
      && Number(list.total || 0) === pictured - (list.groups.old || 0),
      `${list.rows} rows for ${pictured} sessions ${JSON.stringify(list.groups)}; the count above the list says ${list.total || 0}`);
    check('nothing in the list runs off its side', !list.overflow);
    // with no chat open here and none picked, the panel is the start page: no figure stands on it, they all live on the Dashboard
    const start = await until(async () => { const p = await inPage(pagePeek); return same(p.buttons, startButtons()) ? p : null; }, 6000, 300) || await inPage(pagePeek);
    check('with no chat open here the window starts on a page that says so and offers the ways to begin, without a single figure on it',
      start.view === 'peek' && !start.hidden && start.start === START && !start.pane && same(start.buttons, startButtons()) && start.figures === 0,
      `"${start.start}"; it offers: ${start.buttons.join(' / ')}; figures on the main screen: ${start.figures}`);
    const accounts = watch.latest().accounts;
    const card = await inPage(() => ({ named: Boolean((document.querySelector('#acct .acct-name') || {}).textContent), limits: document.querySelectorAll('#acct .slim').length }));
    check('the accounts Claude Code logs in to on this machine are found by the app itself, and the one in use is named under the list with its two limits',
      Boolean(accounts) && accounts.list.length > 0 && (accounts.current ? card.named && accounts.list[0].here && card.limits === 2 : true),
      accounts ? `${accounts.list.length} known, ${accounts.list.filter((a) => a.email).length} with a name on disk, ${accounts.marks.length} changes of account on record, ${accounts.current ? 'one is logged in' : 'none is logged in'}; limits known for ${accounts.list.filter((a) => a.five || a.week).length}` : 'the picture holds no accounts');

    // What the real sessions hold on this computer, as the watcher's helper measures it. Numbers only: no name of a session or of a program is written down.
    const running = () => watch.latest().chats.filter((c) => c.pid);
    const measured = await until(async () => {
      const r = await exec('Desk.state.res');
      return r && r.all && running().every((c) => r.sessions[c.key]) ? r : null;
    }, 20000, 300);
    await wait(300);
    const resSeen = await inPage(() => {
      const figure = /^(<1 MB|\d+ MB|\d+(\.\d)? GB)$/;
      const told = /\n\nThis session holds (<1 MB|\d+ MB|\d+(\.\d)? GB) of RAM in \d+ programs?/;
      const res = Desk.state.res;
      const rows = [...document.querySelectorAll('#chat-list .nav-item.chat:not(.k-ended)')].filter((el) => res && res.sessions[el.dataset.key]);
      // a row that waits for the person says for how long instead; every other one ends in the RAM its session holds
      const ending = rows.filter((el) => el.querySelector('.res'));
      return { measured: rows.length, told: rows.filter((el) => told.test(el.dataset.tip || '')).length,
        figures: ending.length, wellFormed: ending.filter((el) => figure.test(el.querySelector('.res').textContent)).length };
    });
    const sessionsMeasured = measured ? Object.keys(measured.sessions).length : 0;
    const partsAddUp = measured ? Object.values(measured.sessions).filter((s) => Math.abs(s.own.mem + s.items.reduce((a, x) => a + x.mem, 0) + (s.more ? s.more.mem : 0) - s.mem) > 1024).length : -1;
    check('what every running session holds on this computer is measured, and its row says so: the RAM at the end of the row, the rest in its hover note',
      Boolean(measured) && sessionsMeasured >= running().length && resSeen.measured >= running().length && resSeen.told === resSeen.measured && resSeen.wellFormed === resSeen.figures && partsAddUp === 0,
      measured ? `${sessionsMeasured} sessions measured for ${running().length} running; ${resSeen.told} rows tell it in their note, ${resSeen.figures} of them end in a figure; parts that do not add up to their session: ${partsAddUp}` : 'no measurement arrived in 20 s');

    // the Dashboard is where every figure lives: it opens with what is running now
    await view('stats');
    await wait(400);
    const dash = await inPage(() => {
      const sec = document.querySelector('#stats .run-sec');
      const text = (sel) => (sec.querySelector(sel) || {}).textContent || '';
      const res = Desk.state.res;
      return {
        shown: !sec.hidden, title: text('.sec-head h3'), note: text('.sec-head .note'), app: text('.run-app'),
        listed: sec.querySelectorAll('.run-row[role="button"]').length, rest: sec.querySelectorAll('.run-row.rest').length,
        known: res ? Desk.state.snap.chats.filter((c) => res.sessions[c.key]).length : 0,
        feedTitle: (document.querySelector('#stats .feed-sec .sec-head h3') || {}).textContent || '',
        feed: document.querySelectorAll('#stats .feed-sec .feed-row').length, quiet: Boolean(document.querySelector('#stats .feed-sec > p.quiet:not(.cost-line)')),
        first: [...document.querySelectorAll('#stats .sec.block')].slice(0, 2).map((x) => x.className),
      };
    });
    check('the Dashboard opens with what the sessions hold on this computer, the heaviest first, and with what each is doing right now',
      dash.shown && dash.title === 'On this computer' && dash.listed === Math.min(12, dash.known) && dash.rest === (dash.known > 12 ? 1 : 0)
      && /^(\d+ MB|\d+(\.\d)? GB) of \d+ GB RAM/.test(dash.note) && /^Perch Desk itself holds (\d+ MB|\d+(\.\d)? GB) of RAM/.test(dash.app)
      && dash.feedTitle === 'Happening now' && (dash.feed > 0 || dash.quiet) && /run-sec/.test(dash.first[0] || '') && /feed-sec/.test(dash.first[1] || '') && !(await inPage(pageSpill, 'stats')),
      `${dash.listed} of ${dash.known} measured sessions listed; "${dash.note}"; "${dash.app}"; ${dash.feed} tool calls in the feed`);
    // the refresh button: everything is read again at once, and the processor share is known from the second look on
    const lookedAt = watch.latest().at;
    const resAt = measured ? measured.at : 0;
    await exec('document.getElementById("refresh").click()');
    const spun = await exec('document.getElementById("refresh").classList.contains("spin")');
    const again = await until(async () => { const r = await exec('Desk.state.res'); return r && r.at > resAt && r.all.cpu !== null ? r : null; }, 8000, 150);
    const lookedAgain = await until(async () => /^Looked again just now\./.test(await exec('document.getElementById("toast").textContent')), 6000, 150);
    check('the refresh button reads everything again at once, and says so',
      spun && Boolean(again) && Boolean(lookedAgain) && watch.latest().at >= lookedAt && !(await exec('document.getElementById("refresh").classList.contains("spin")')),
      again ? `a new measurement ${again.at - resAt} ms after the first; all sessions together: ${Math.round(again.all.mem / 1048576)} MB in ${again.all.n} programs, ${again.all.cpu}% of the processor` : 'no new measurement');
    await view('peek');
    await wait(200);
    await shoot('1-start');

    // One real conversation, read the way the app reads it. Only counts and kinds are kept: never a word of it, and no picture.
    // (one that has said or been asked something: a session nobody has typed in yet has no file to read)
    const one = watch.latest().chats.filter((c) => c.provider === 'claude' && c.session && c.pid && c.kind !== 'bg' && (c.words || c.prompt)).sort((a, b) => b.at - a.at)[0];
    if (!one) {
      say('      no Claude Code session with a conversation is running: reading a real one was not checked');
    } else {
      const t0 = Date.now();
      const page = await watch.ask('read', { key: one.key, agent: '', before: 0 });
      const kinds = {};
      for (const it of page ? page.items : []) kinds[it.k] = (kinds[it.k] || 0) + 1;
      check('a page of a real conversation is read from the end of its file', Boolean(page) && page.to <= page.size && page.from < page.to && Array.isArray(page.replies)
        && page.items.length > 0 && Object.keys(kinds).every((k) => KINDS.includes(k)),
        page ? `${Date.now() - t0} ms for the last ${Math.round((page.to - page.from) / 1024)} KB of ${Math.round(page.size / 1048576)} MB: ${page.items.length} things in it ${JSON.stringify(kinds)}, ${page.replies.length} replies, ${Object.keys(page.orphans).length} results whose call is further back` : 'no answer');
      // picked with a click in the list, it takes the panel; the conversation and the files it changed are laid out
      await pick(one.key);
      await wait(250);
      const picked = await inPage(pageList);
      const pane = await inPage(pageDetail, 'peek');
      check('a click on a chat that runs elsewhere shows it across the panel', picked.picked === 1 && picked.sel === one.key && pane.shown && pane.tabs.length >= 3 && pane.tabs[0] === 'Overview*' && !(await inPage(pageSpill, 'peek')),
        `tabs: ${pane.tabs.join(', ')}; ${pane.heads.length} parts in its overview; button "${pane.button}"`);
      await exec('Desk.Peek.detail().setTab("conv")');
      const ready = await until(() => exec('Desk.Peek.detail().reader.state() === "ready"'), 12000);
      await wait(200);
      const read = await inPage(pageReader, 'peek');
      await exec('Desk.Peek.detail().setTab("changes")');
      await wait(200);
      const changed = await exec(`({ files: document.querySelectorAll('#peek .chg-file').length, sum: Boolean((document.querySelector('#peek .chg-sum') || {}).textContent) })`);
      check('its conversation is laid out to be read, and the files it changed are listed', Boolean(ready) && read.asks + read.says + read.tools > 0 && changed.sum && !(await inPage(pageSpill, 'peek')),
        `on screen: ${read.asks} asked, ${read.says} said, ${read.tools} tool calls (${read.failed} failed, ${read.running} running), ${read.thoughts} thoughts, ${read.turns} turn ends, ${read.marks + read.notes} marks, ${read.tables} tables, ${read.code} code blocks; ${changed.files} files changed in the part read`);
      await exec('Desk.Peek.detail().setTab("overview")');
      await inPage(pageKey, 'Escape');
      await wait(150);
      const after = await inPage(pagePeek);
      check('Esc leaves it, and the start page is back', !after.pane && after.start === START && (await inPage(pageList)).picked === 0);
    }

    // every conversation kept on this machine, as the History view will list them (shapes only)
    const t1 = Date.now();
    const kept = await watch.ask('history');
    const fields = ['id', 'project', 'cwd', 'title', 'name', 'prompt', 'mode', 'at', 'first', 'size', 'model', 'out', 'replies', 'tools', 'compacts', 'agents', 'usd', 'added', 'removed', 'counted', 'live'];
    check('the watcher lists every conversation kept on this machine, newest first', Boolean(kept) && Array.isArray(kept.list) && kept.total >= kept.list.length && kept.list.length > 0
      && fields.every((k) => k in kept.list[0]) && kept.list.every((r, i) => i === 0 || r.at <= kept.list[i - 1].at),
      kept ? `${kept.total} conversations, ${(kept.bytes / 1073741824).toFixed(1)} GB with their subagents, ${kept.list.length} listed, ${kept.list.filter((r) => r.live).length} of them running; ${Date.now() - t1} ms` : 'no answer');

    const picker = await inPage(pagePicker);
    notes.picker = picker;
    check('the New chat panel lists ways to start and folders', picker.open && picker.starters.length >= 2 && picker.starters.some((s) => s.endsWith('*')) && picker.folders > 0,
      `start with: ${picker.starters.join(', ')}; ${picker.folders} folders; ${picker.recent} past conversations`);
    await shoot('1-new-chat');
    await exec('Picker.close()');
    const looks = watch.took();
    say(`      watcher: first look ${looks[0]} ms, later looks ${looks.slice(1).join(', ') || '(none yet)'} ms`);
    // the watcher thread dies: it is started again and the list carries on
    const stoppedAt = Date.now();
    watch.kill();
    const back = await until(async () => watch.latest().at > stoppedAt && watch.latest().chats.length > 0, 12000, 200);
    check('a watcher that dies is started again by itself', Boolean(back), `a new picture of the machine ${Date.now() - stoppedAt} ms after it was stopped`);
    watch.post({ type: 'pace', ms: 2000 });
    const limits = watch.latest().plan;
    say(`      usage limits as Claude Code last reported them: ${limits ? ['five', 'week'].filter((k) => limits[k]).map((k) => `${k} ${limits[k].used}% (reported ${Math.round((Date.now() - limits[k].at) / 1000)} s ago)`).join(', ') : 'none found'}`);
  };

  // ---- made-up sessions and made-up numbers: the real ones rarely show every state at once, and a test run counts nothing ----
  let madeAt = Date.now();
  const beats = (seed, busy) => Array.from({ length: 30 }, (_, i) => (busy && (i * 7 + seed) % 5 !== 0 ? 1 + ((i * 13 + seed) % 6) : (i + seed) % 11 === 0 ? 1 : 0));
  const row = (over) => ({
    session: over.key, provider: 'claude', pid: 1, name: '', named: false, title: '', cwd: 'D:\\work\\shop', kind: 'interactive',
    state: 'idle', waiting: '', background: false, since: madeAt - 90e3, at: madeAt - 20e3, started: madeAt - 6 * 3600e3, words: '', prompt: '', doing: null, turn: null,
    agents: { total: 0, running: 0, list: [] }, tokens: { in: 41200, out: 388000, cacheWrite: 2140000, cacheRead: 61300000, tools: 214, share: 1 },
    today: { in: 9100, out: 121000, cacheWrite: 610000, cacheRead: 18400000, replies: 96, work: 47 * 60e3, asked: 7, tools: 141, agents: 0 },
    pulse: beats(over.key.length, over.state === 'working' || over.state === 'compacting'),
    context: 184000, ceiling: 467000, ceilingOwn: true, compacts: 2, limit: null, recap: '', recapAt: 0, queued: 0, cost: null, live: null,
    model: 'claude-opus-5-5', effort: 'max', mode: 'bypassPermissions', job: '', chat: '', ...over,
  });
  const agentRow = (over) => ({
    id: over.name, what: '', type: 'general-purpose', team: '', model: 'claude-opus-5-5', depth: 0, parent: '', state: 'working',
    doing: null, said: '', tools: 12, out: 18400, started: madeAt - 400e3, at: madeAt - 4e3, ...over,
  });
  const tool = (name, what, secondsAgo, lasted) => ({ name, what, at: madeAt - secondsAgo * 1000, done: lasted ? madeAt - secondsAgo * 1000 + lasted * 1000 : 0 });
  /** A session in the middle of a long turn, with subagents: the busiest a row gets. */
  const busyRow = (over) => row({ key: 's-agents', title: 'Pricing research', cwd: 'D:\\work\\pricing', state: 'working', since: madeAt - 11 * 60e3,
    prompt: 'Compare our prices against the five closest competitors and tell me where we are out of line.',
    words: 'Three of the five are in. Waiting on the last two before I build the table.',
    doing: tool('Agent', 'Compare competitor D', 75, 0),
    turn: { start: madeAt - 11 * 60e3, end: 0, ms: 0, count: 23, tools: [tool('WebSearch', 'competitor pricing pages 2026', 300, 4), tool('Read', 'plans.md', 280, 1),
      tool('Agent', 'Compare competitor A', 260, 170), tool('Agent', 'Compare competitor D', 75, 0), tool('Agent', 'Compare competitor E', 74, 0)] },
    agents: { total: 7, running: 3, list: [
      agentRow({ name: 'competitor-d', what: 'Compare competitor D', doing: tool('WebFetch', 'competitor-d.example', 6, 0) }),
      agentRow({ name: 'price-table', what: 'Read their plans page', depth: 1, parent: 'competitor-d', doing: tool('Read', 'plans.html', 3, 0), tools: 4, out: 2100 }),
      agentRow({ name: 'competitor-e', what: 'Compare competitor E', doing: null, said: 'Found the monthly plans; looking for the yearly ones.' }),
      agentRow({ name: 'competitor-a', what: 'Compare competitor A', state: 'done', said: 'Competitor A charges 29 a month for the same tier, 17% under us.', at: madeAt - 90e3, tools: 31, out: 44100 }),
    ] },
    tokens: { in: 9000, out: 120000, cacheWrite: 800000, cacheRead: 9400000, tools: 88, share: 0.42 },
    today: { in: 9100, out: 121000, cacheWrite: 610000, cacheRead: 18400000, replies: 96, work: 47 * 60e3, asked: 7, tools: 141, agents: 7 },
    context: 402000, queued: 2, recap: 'You asked for a price comparison. Competitors A, B and C are done: A is 17% under us, B and C are level.', recapAt: madeAt - 20 * 60e3,
    cost: { usd: 12.4, added: 1204, removed: 310, apiMs: 0, toolMs: 0, at: madeAt - 3600e3 },
    live: { usd: 41.8, added: 1204, removed: 310, warm: true, cacheUntil: madeAt + 52 * 60e3, cacheCold: 402000, cacheHit: 0.97 }, ...over });
  const madeUpRows = (flip) => [
    row({ key: 's-permission', title: 'Checkout page rebuild', state: 'attention', waiting: 'permission prompt', since: madeAt - 40e3, context: 448000,
      words: 'Ready to deploy. I need your go-ahead to run the release command.', doing: tool('Bash', 'Deploy the site to production', 40, 0),
      // waiting on the person while its cache runs out: answered late, the next message reads the whole conversation afresh
      live: { usd: 18.2, added: 412, removed: 96, warm: true, cacheUntil: madeAt + 4 * 60e3, cacheCold: 448000, cacheHit: 0.96 } }),
    busyRow({}),
    // says it is working, and wrote nothing for six minutes
    row({ key: 's-words', title: 'Invoice export bug', state: 'working', since: madeAt - 9 * 60e3, at: madeAt - 6 * 60e3 - 20e3, words: 'The export skips rows with an empty tax field. Writing the fix now.', context: 96000,
      live: { usd: 6.4, added: 58, removed: 12, warm: true, cacheUntil: madeAt + 31 * 60e3, cacheCold: 96000, cacheHit: 0.93 } }),
    // today's part of its conversation has not been read to the end yet
    row({ key: 's-compact', title: 'Long refactor', state: 'compacting', since: madeAt - 50e3, context: 466000, compacts: 9,
      today: { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, replies: 0, work: 0, asked: 0, tools: 0, agents: 0, whole: false } }),
    row({ key: 's-error', title: 'Nightly report', state: 'error', since: madeAt - 8 * 60e3, words: "You've hit your limit. It resets at the top of the hour.",
      limit: { type: 'five_hour', until: madeAt + 42 * 60e3 } }),
    row({ key: 's-finish', title: 'Landing page copy', state: flip ? 'idle' : 'working', since: madeAt - 30e3,
      words: 'All three sections are rewritten and the page builds without errors.',
      turn: { start: madeAt - 9 * 60e3, end: flip ? madeAt - 30e3 : 0, ms: flip ? 510000 : 0, count: 2, tools: [tool('Edit', 'hero.tsx', 400, 2), tool('Bash', 'Build the site', 300, 41)] } }),
    row({ key: 's-idle', title: 'Old notes', state: 'idle', since: madeAt - 5 * 3600e3, at: madeAt - 5 * 3600e3, words: 'Done. The notes are in the docs folder.', ceiling: 0, ceilingOwn: false, compacts: 0,
      live: { usd: 3.1, added: 0, removed: 0, warm: false, cacheUntil: madeAt - 4 * 3600e3, cacheCold: 184000, cacheHit: 0.9 } }),
    row({ key: 'job:abc12345', pid: 0, name: 'Weekly numbers', named: true, kind: 'bg', state: 'attention', waiting: 'blocked', job: 'abc12345',
      since: madeAt - 3600e3, at: madeAt - 3600e3, words: 'Which week should the report start from?', tokens: null, today: null, pulse: null, model: '', mode: '', context: 0 }),
    row({ key: 'codex:x', provider: 'codex', title: '', cwd: 'D:\\work\\api', state: 'working', tokens: null, today: null, pulse: null, model: 'gpt-6', mode: '', effort: '', context: 0 }),
  ];
  /** What the watcher would answer when asked for the sums, with numbers that look like a busy month. */
  const madeUpUsage = (range) => {
    const pad = (n) => String(n).padStart(2, '0');
    const dayOf = (i) => { const d = new Date(madeAt - (29 - i) * 86400e3); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const wave = (i, n) => 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + n));
    const hourNow = new Date(madeAt).getHours();
    const hours = Array.from({ length: 48 }, (_, i) => {
      const hr = i % 24;
      const k = i >= 24 && hr > hourNow ? 0 : Math.max(0, Math.sin(((hr - 6) / 18) * Math.PI)) * wave(i, 2) * (i < 24 ? 0.84 : 1);
      return { in: Math.round(k * 3000), out: Math.round(k * 780000), cacheWrite: Math.round(k * 2.4e6), cacheRead: Math.round(k * 150e6), replies: Math.round(k * 410), work: Math.round(k * 3.6 * 3600e3) };
    });
    const sumOf = (list, key) => list.reduce((n, x) => n + x[key], 0);
    const days = Array.from({ length: 30 }, (_, i) => {
      const k = wave(i, 1) * (i % 7 === 5 ? 0.3 : 1);
      return { day: dayOf(i), in: Math.round(k * 42000), out: Math.round(k * 9.8e6), cacheWrite: Math.round(k * 31e6), cacheRead: Math.round(k * 1.9e9), replies: Math.round(k * 5200),
        work: Math.round(k * 46 * 3600e3), asked: Math.round(k * 190), tools: Math.round(k * 7400), agents: Math.round(k * 120), think: Math.round(k * 6.1e6), web: Math.round(k * 40),
        comp: Math.round(k * 22), compMs: Math.round(k * 22 * 150e3), err: Math.round(k * 6), lim: i % 9 === 0 ? 1 : 0 };
    });
    // today is what its hours add up to, so the strip and the chart agree
    const today = hours.slice(24);
    Object.assign(days[29], { in: sumOf(today, 'in'), out: sumOf(today, 'out'), cacheWrite: sumOf(today, 'cacheWrite'), cacheRead: sumOf(today, 'cacheRead'), replies: sumOf(today, 'replies'), work: sumOf(today, 'work') });
    const span = range === '30d' ? 30 : range === '7d' ? 7 : 1;
    const total = {};
    for (const key of Object.keys(days[0])) if (key !== 'day') total[key] = sumOf(days.slice(-span), key);
    // which account wrote each day's tokens: the one in use now for the last two days, two others before that, and a stretch nobody can speak for
    const holders = ['aaaa1111', 'bbbb2222', 'cccc3333', '?'];
    const weights = (i) => (i >= 28 ? [0.8, 0.2, 0, 0] : i >= 25 ? [0, 0.7, 0.3, 0] : i >= 20 ? [0, 0.15, 0.85, 0] : i >= 12 ? [0, 0.4, 0.2, 0.4] : [0, 0, 0, 1]);
    days.forEach((d, i) => { d.who = {}; weights(i).forEach((w, j) => { if (w > 0) d.who[holders[j]] = Math.round(d.out * w); }); });
    const who = holders.map((key, j) => {
      const g = { key, in: 0, out: 0, cacheWrite: 0, cacheRead: 0, replies: 0, work: 0, asked: 0 };
      days.slice(-span).forEach((d, n) => { const w = weights(30 - span + n)[j]; for (const k of Object.keys(g)) if (k !== 'key') g[k] += Math.round(d[k] * w); });
      return g;
    }).filter((g) => g.out > 0).sort((a, b) => b.out - a.out);
    const lanes = [['s-agents', 'Pricing research', 'pricing', 7, 0.95], ['s-permission', 'Checkout page rebuild', 'shop', 9, 0.8], ['s-words', 'Invoice export bug', 'shop', 13, 0.6],
      ['past-1', 'Move the blog to the new layout', 'landing', 8, 0.45], ['past-2', 'Quarterly numbers', 'reports', 10, 0.3], ['past-3', 'Fix the flaky login test', 'api', 11, 0.2]].map(([key, title, name, from, k], n) => {
      const work = Array.from({ length: 24 }, (_, hr) => (hr >= from && hr <= hourNow && (hr + n) % 5 !== 0 ? Math.round(k * wave(hr, n) * 3600e3) : 0));
      const out = work.map((ms) => Math.round((ms / 3600e3) * 210000));
      return { key, title, name, work, out, sum: work.reduce((a, b) => a + b, 0), tokens: out.reduce((a, b) => a + b, 0) };
    });
    const share = (names, weights, more) => names.map((name, i) => ({ key: name, name, in: Math.round(total.in * weights[i]), out: Math.round(total.out * weights[i]), cacheWrite: Math.round(total.cacheWrite * weights[i]),
      cacheRead: Math.round(total.cacheRead * weights[i]), replies: Math.round(total.replies * weights[i]), work: Math.round(total.work * weights[i]), asked: Math.round(total.asked * weights[i]), ...(more ? more(name, i) : {}) }));
    const calls = [0.31, 0.22, 0.14, 0.09, 0.07, 0.05, 0.04, 0.03, 0.03, 0.02];
    return {
      at: madeAt + span, range: span === 30 ? '30d' : span === 7 ? '7d' : 'today', total, days, hours,
      models: share(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-1'], [0.74, 0.21, 0.05]),
      projects: share(['shop', 'pricing', 'api', 'landing', 'reports', 'notes'], [0.34, 0.24, 0.17, 0.12, 0.08, 0.05]),
      chats: share(['s-agents', 's-permission', 's-words', 'past-1', 'past-2', 'past-3'], [0.3, 0.22, 0.16, 0.13, 0.11, 0.08], (name, i) => ({
        title: ['Pricing research', 'Checkout page rebuild', 'Invoice export bug', 'Move the blog to the new layout', 'Quarterly numbers', 'Fix the flaky login test'][i],
        name: ['pricing', 'shop', 'shop', 'landing', 'reports', 'api'][i], project: 'p', cwd: i > 2 ? 'Z:\\nowhere\\past' : 'D:\\work\\shop' })),
      tools: ['Bash', 'Read', 'Edit', 'Grep', 'Agent', 'Write', 'WebFetch', 'WebSearch', 'ops: capture', 'Glob'].map((name, i) => ({ name, calls: Math.round(total.tools * calls[i]) })),
      toolKinds: 37,
      limits: [{ type: 'five_hour', until: madeAt + 42 * 60e3, at: madeAt - 18 * 60e3, chats: 3 }, { type: 'seven_day', until: madeAt - 2 * 86400e3, at: madeAt - 3 * 86400e3, chats: 5 }],
      active: { chats: 6 * span, projects: 6 },
      who, lanes,
      recorded: { usd: 1840.5, added: 48210, removed: 19044, conversations: 61 },
      reading: { files: 1756, done: 1756, bytes: 15.9e9, read: 15.9e9, counting: true, today: true },
    };
  };
  const madeUpPlan = () => ({ five: { used: 86, until: madeAt + 2.4 * 3600e3, at: madeAt - 20e3 }, week: { used: 41, until: madeAt + 3.2 * 86400e3, at: madeAt - 20e3 } });
  const DAY_MS = 86400e3;
  const account = (n, key, email, over) => ({ key, n, email, name: '', org: '', plan: email ? 'default_claude_max_20x' : '', type: 'claude_max', here: false, from: 0, to: 0,
    five: null, week: null, pace: { five: 0, week: 0 }, ...over });
  const madeUpAccounts = () => ({
    current: 'aaaa1111',
    list: [
      account(0, 'aaaa1111', 'studio@example.com', { here: true, from: madeAt - 5.2 * 3600e3, five: madeUpPlan().five, week: madeUpPlan().week, pace: { five: 9.5, week: 0.62 } }),
      account(1, 'bbbb2222', 'personal@example.com', { from: madeAt - 2 * DAY_MS, to: madeAt - 5.2 * 3600e3,
        five: { used: 97, until: madeAt + 1.1 * 3600e3, at: madeAt - 5.2 * 3600e3 }, week: { used: 64, until: madeAt + 4.5 * DAY_MS, at: madeAt - 5.2 * 3600e3 } }),
      account(2, 'cccc3333', 'client-work@example.com', { from: madeAt - 2.6 * DAY_MS, to: madeAt - 2 * DAY_MS,
        five: { used: 100, until: madeAt - 1.8 * DAY_MS, at: madeAt - 2 * DAY_MS }, week: { used: 22, until: madeAt + 2.1 * DAY_MS, at: madeAt - 2 * DAY_MS } }),
      account(3, 'dddd4444', '', { from: madeAt - 11 * DAY_MS, to: madeAt - 9 * DAY_MS }),
    ],
    marks: [
      { at: madeAt - 16 * DAY_MS, key: '', seen: false },
      { at: madeAt - 11 * DAY_MS, key: 'dddd4444', seen: false },
      { at: madeAt - 9 * DAY_MS, key: '', seen: false },
      { at: madeAt - 7.5 * DAY_MS, key: 'cccc3333', seen: false },
      { at: madeAt - 4 * DAY_MS, key: 'bbbb2222', seen: false },
      { at: madeAt - 2.6 * DAY_MS, key: 'cccc3333', seen: true },
      { at: madeAt - 2 * DAY_MS, key: 'bbbb2222', seen: true },
      { at: madeAt - 5.2 * 3600e3, key: 'aaaa1111', seen: true },
    ],
  });
  const fake = (at, list, ended = []) => JSON.stringify({ at, chats: list, ended, plan: madeUpPlan(), accounts: madeUpAccounts() });
  const showUsage = (range) => exec(`Desk.state.frozen = true; Desk.state.usage = ${JSON.stringify(madeUpUsage(range))}; paint()`);
  /**
   * What the watcher's helper would report for the made-up sessions: one with a dev server up, a command still
   * running and MCP servers, the others with less. The background record (no program) is not measured.
   * chat: a chat of this window that the busiest session runs in, and so has a total of its own.
   */
  const MB = 1048576;
  const madeUpRes = (chat) => {
    const prog = (kind, label, mb, cpu, n = 1, ports = []) => ({ kind, label, mem: mb * MB, cpu, n, ports, started: madeAt - 3600e3 });
    const sess = (ownMb, ownCpu, items = []) => ({
      mem: ownMb * MB + items.reduce((a, x) => a + x.mem, 0), ws: 0, cpu: Math.round((ownCpu + items.reduce((a, x) => a + x.cpu, 0)) * 10) / 10,
      n: 1 + items.reduce((a, x) => a + x.n, 0), ports: [...new Set(items.flatMap((x) => x.ports))], started: madeAt - 6 * 3600e3,
      own: { mem: ownMb * MB, cpu: ownCpu }, items, more: null,
    });
    const sessions = {
      's-agents': sess(612, 9.4, [prog('server', 'vite', 233, 4.1, 3, [5173]), prog('command', 'python', 199, 0.6, 2), prog('mcp', '@playwright/mcp', 88, 0, 3), prog('mcp', 'mcp_server', 47, 0, 3), prog('start', 'python', 31, 0, 2)]),
      's-permission': sess(455, 0.2, [prog('mcp', 'mcp_server', 47, 0, 3), prog('tool', 'npm run dev', 12, 0, 3)]),
      's-words': sess(398, 6.2, [prog('mcp', 'mcp_server', 46, 0, 3)]),
      's-compact': sess(812, 3.1, [prog('mcp', 'mcp_server', 48, 0, 3)]),
      's-error': sess(301, 0, [prog('mcp', '', 22, 0, 2)]),
      's-finish': sess(276, 0.4),
      's-idle': sess(153, 0, [prog('mcp', 'mcp_server', 0, 0, 3)]),
      'codex:x': sess(188, 1.2),
    };
    const all = Object.values(sessions);
    return {
      at: madeAt, cores: 16, memory: 64 * 1024 * MB, sessions,
      chats: chat ? { [chat]: { mem: sessions['s-agents'].mem + 71 * MB, cpu: 14.4, n: sessions['s-agents'].n + 2, ports: [5173] } } : {},
      app: { mem: 540 * MB, cpu: 1.3, n: 9 },
      all: { mem: all.reduce((a, s) => a + s.mem, 0), cpu: Math.round(all.reduce((a, s) => a + s.cpu, 0) * 10) / 10, n: all.reduce((a, s) => a + s.n, 0), sessions: all.length },
      servers: [{ port: 5173, key: 's-agents', label: 'vite', kind: 'server' }],
    };
  };

  // ---- made-up conversations for the reader and for the History view: the real ones are his, and never go into a picture ----
  const SRC = 'D:\\work\\shop\\src\\billing\\';
  const OPUS = 'claude-opus-5-5';
  const back = (minutes, seconds = 0) => Math.round(madeAt - minutes * 60e3 - seconds * 1000);
  const called = (id, at, label, what, input, over) => ({ k: 'tool', at, id, name: label, label, what, input, done: at + 1500, error: false, out: '', note: '', diff: null, applied: false, ...over });
  const change = (file, kind, hunks) => {
    const lines = hunks.flatMap((hk) => hk.lines);
    return { file: SRC + file, kind, hunks, added: lines.filter((l) => l[0] === '+').length, removed: lines.filter((l) => l[0] === '-').length, more: 0 };
  };
  /** The pages the reader is handed, as JSON: every reader that asks gets its own copy. */
  const madeUpPages = () => {
    const fixExport = change('export.ts', 'edit', [{ a: 21, b: 21, lines: [
      ' export function exportInvoices(rows) {',
      '   return rows',
      "-    .filter((row) => row.tax !== '')",
      '-    .map((row) => line(row, Number(row.tax)));',
      '+    .map((row) => {',
      '+      // an invoice without a tax field is a real invoice: it counts as no tax',
      "+      const tax = row.tax === '' ? 0 : Number(row.tax);",
      '+      return line(row, tax);',
      '+    });',
      ' }',
    ] }]);
    const fixFormat = change('export.ts', 'edit', [{ a: 44, b: 47, lines: [' function money(n) {', '-  return String(n);', '+  return n.toFixed(2);', ' }'] }]);
    const newTest = change('export.test.ts', 'new', [{ a: 0, b: 0, lines: [
      "+import { exportInvoices } from './export';",
      '+',
      "+test('exports a row with an empty tax field', () => {",
      "+  const csv = exportInvoices([{ id: 'INV-204', total: 120, tax: '' }]);",
      "+  expect(csv).toContain('INV-204,120.00,0.00');",
      '+});',
      '+',
      "+test('keeps a tax that is given', () => {",
      "+  const csv = exportInvoices([{ id: 'INV-205', total: 120, tax: '24' }]);",
      "+  expect(csv).toContain('INV-205,120.00,24.00');",
      '+});',
    ] }]);
    const askedPdf = change('pdf.ts', 'edit', [{ a: 0, b: 0, lines: ["-    .filter((row) => row.tax !== '')", '+    .map(withTax)'] }]);
    const madePdf = change('pdf.ts', 'edit', [{ a: 30, b: 30, lines: ['   return rows', "-    .filter((row) => row.tax !== '')", '+    .map(withTax)', '     .map(drawRow);'] }]);
    const about = { skipped: false, title: 'Invoice export bug', name: '', cwd: 'D:\\work\\shop' };
    const older = { ...about, size: 9000, from: 0, to: 4000, start: true, orphans: {},
      items: [
        { k: 'ask', at: back(62), text: 'The CSV export on the invoices page is missing rows. Customers noticed on Monday.\nFind out why before you change anything.', pictures: 1, queued: false },
        { k: 'think', at: back(61, 54), text: 'The export goes through exportInvoices. Before anything else I should see how rows are filtered on their way into the file.', ms: 4200 },
        called('t1', back(61, 50), 'Grep', 'exportInvoices', 'exportInvoices\nin src', { out: 'src/billing/export.ts:21:export function exportInvoices(rows) {\nsrc/pages/invoices.tsx:88:  const csv = exportInvoices(rows);' }),
        called('t2', back(61, 40), 'Read', 'export.ts', `${SRC}export.ts`, { note: '64 lines from line 1 of 64' }),
        { k: 'say', at: back(61, 10), model: OPUS, text: 'Found it. `exportInvoices` drops every row whose **tax** field is empty: the check on line 23 takes an empty field for a broken row.\n\n14 of the 212 invoices from September have no tax field, and those are the ones that are missing.' },
        { k: 'turn', at: back(60, 25), ms: 95000 },
      ],
      replies: [{ at: back(61, 54), ctx: 431000, out: 900 }, { at: back(61, 40), ctx: 440000, out: 300 }, { at: back(61, 10), ctx: 452000, out: 1400 }] };
    const main = { ...about, size: 9000, from: 4000, to: 9000, start: false, orphans: {},
      items: [
        { k: 'compact', at: back(41), pre: 452000, ms: 148000, auto: true },
        { k: 'summary', at: back(41), text: '## Where things stand\n\n- The CSV export drops invoices whose tax field is empty (`src/billing/export.ts`, line 23).\n- Nothing has been changed yet: the cause was to be found first.' },
        { k: 'ask', at: back(40), text: 'Fix it. A row with an empty tax field must be exported with a tax of 0.00.\nAdd a test so this cannot come back.', pictures: 0, queued: false },
        { k: 'think', at: back(39, 56), text: 'Two changes: stop filtering those rows out, and treat the empty field as no tax. Then a test for exactly that row.', ms: 6100 },
        called('t3', back(39, 50), 'Edit', 'export.ts', `${SRC}export.ts`, { diff: fixExport, applied: true }),
        called('t4', back(39, 30), 'Write', 'export.test.ts', `${SRC}export.test.ts`, { diff: newTest, applied: true }),
        called('t5', back(39, 10), 'Bash', 'Run the billing tests', 'npm test -- billing', { done: back(38, 56), error: true,
          out: 'FAIL  src/billing/export.test.ts\n  x exports a row with an empty tax field (4 ms)\n\n    Expected: "INV-204,120.00,0.00"\n    Received: "INV-204,120.00,0"\n\nTests: 1 failed, 11 passed, 12 total' }),
        { k: 'say', at: back(38, 50), model: OPUS, text: 'One test fails: the tax is written as `0`, and the file wants two decimals. Fixing how amounts are written.' },
        called('t6', back(38, 40), 'Edit', 'export.ts', `${SRC}export.ts`, { diff: fixFormat, applied: true }),
        called('t7', back(38, 20), 'Bash', 'Run the billing tests', 'npm test -- billing', { done: back(38, 11), out: 'PASS  src/billing/export.test.ts\n\nTests: 12 passed, 12 total\nTime:  3.1 s' }),
        { k: 'say', at: back(33, 20), model: OPUS, text: [
          '## Fixed',
          '',
          'The export dropped every invoice whose **tax** field was empty. It now writes them with a tax of `0.00`.',
          '',
          '- `src/billing/export.ts`: an empty tax field counts as no tax',
          '- `src/billing/export.test.ts`: new, two cases',
          '',
          '| Case | Before | After |',
          '| --- | --- | --- |',
          '| tax field empty | row dropped | exported, tax 0.00 |',
          '| tax field given | exported | exported, two decimals |',
          '',
          'The one line that decides it:',
          '',
          '```ts',
          "const tax = row.tax === '' ? 0 : Number(row.tax);",
          '```',
          '',
          'All 12 tests pass. The 14 invoices from September are in the file again.',
        ].join('\n') },
        { k: 'turn', at: back(33, 8), ms: 412000 },
        { k: 'ask', at: back(9), text: 'Good. The PDF export has the same check. Fix it there too, and show me the diff before you commit.', pictures: 0, queued: false },
        { k: 'think', at: back(8, 55), text: '', ms: 2400 },
        called('t8', back(8, 50), 'Grep', "row.tax !== ''", "row.tax !== ''\nin src/billing", { out: "src/billing/pdf.ts:31:    .filter((row) => row.tax !== '')" }),
        { k: 'say', at: back(6, 30), model: OPUS, text: 'The export skips rows with an empty tax field. Writing the fix now.' },
        called('t9', back(6, 20), 'Edit', 'pdf.ts', `${SRC}pdf.ts`, { diff: askedPdf, done: 0 }),
      ],
      replies: [{ at: back(39, 56), ctx: 38000, out: 1800 }, { at: back(39, 30), ctx: 52000, out: 2600 }, { at: back(39, 10), ctx: 61000, out: 400 }, { at: back(38, 50), ctx: 66000, out: 700 },
        { at: back(38, 20), ctx: 74000, out: 300 }, { at: back(33, 20), ctx: 85000, out: 4200 }, { at: back(8, 55), ctx: 91000, out: 500 }, { at: back(6, 30), ctx: 96000, out: 800 }] };
    // what arrives while the conversation is being watched: the edit that was running comes back, and a few words follow
    const lastWords = { k: 'say', at: madeAt, model: OPUS, text: 'Done. `pdf.ts` now treats an empty tax field the same way. Here is the diff, before I commit anything.' };
    const grown = { ...about, size: 9600, from: 9000, to: 9600, start: false,
      orphans: { t9: { done: madeAt, error: false, out: '', note: '', diff: madePdf } }, items: [lastWords], replies: [{ at: madeAt, ctx: 99000, out: 700 }] };
    // the same conversation once it is over, as a past one reads
    const whole = { ...about, size: 9600, from: 0, to: 9600, start: true, orphans: {},
      items: [...older.items, ...main.items.map((it) => (it.id === 't9' ? { ...it, done: madeAt, diff: madePdf, applied: true } : it)), lastWords, { k: 'turn', at: madeAt, ms: 540000 }],
      replies: [...older.replies, ...main.replies, ...grown.replies] };
    const pricing = { skipped: false, title: 'Pricing research', name: '', cwd: 'D:\\work\\pricing', size: 5000, from: 0, to: 5000, start: true, orphans: {},
      items: [
        { k: 'ask', at: back(11), text: 'Compare our prices against the five closest competitors and tell me where we are out of line.', pictures: 0, queued: false },
        { k: 'think', at: back(10, 55), text: 'Five competitors, each with its own pricing page: that is work for five subagents at once. First our own plans, so each of them has something to compare against.', ms: 3800 },
        called('p1', back(5), 'WebSearch', 'competitor pricing pages 2026', 'competitor pricing pages 2026', { done: back(4, 56), out: 'Found the public pricing pages of competitors A to E.' }),
        called('p2', back(4, 40), 'Read', 'plans.md', 'D:\\work\\pricing\\plans.md', { note: '48 lines from line 1 of 48' }),
        { k: 'say', at: back(4, 30), model: OPUS, text: 'Our three tiers are 35, 79 and 149 a month. I am sending one subagent to each competitor, and I will build the table once they are back.' },
        called('p3', back(4, 20), 'Agent', 'Compare competitor A', 'Compare competitor A\n\nkind: general-purpose\n\nCompare competitor A\'s public prices with ours, plan by plan.', { done: back(1, 30), out: 'Competitor A charges 29 a month for the same tier, 17% under us.' }),
        called('p4', back(1, 15), 'Agent', 'Compare competitor D', 'Compare competitor D\n\nkind: general-purpose\n\nCompare competitor D\'s public prices with ours, plan by plan.', { done: 0 }),
        called('p5', back(1, 14), 'Agent', 'Compare competitor E', 'Compare competitor E\n\nkind: general-purpose\n\nCompare competitor E\'s public prices with ours, plan by plan.', { done: 0 }),
        { k: 'say', at: back(1, 10), model: OPUS, text: 'Three of the five are in. Waiting on the last two before I build the table.' },
      ],
      replies: [{ at: back(10, 55), ctx: 361000, out: 1200 }, { at: back(4, 40), ctx: 372000, out: 400 }, { at: back(4, 30), ctx: 380000, out: 900 }, { at: back(1, 15), ctx: 396000, out: 2100 }, { at: back(1, 10), ctx: 402000, out: 600 }] };
    const agent = { skipped: false, title: '', name: '', cwd: 'D:\\work\\pricing', size: 2000, from: 0, to: 2000, start: true, orphans: {},
      items: [
        { k: 'ask', at: back(1, 15), text: "Compare competitor D's public prices with ours, plan by plan. Use their pricing page only.\nReport the monthly and the yearly price of every tier.", pictures: 0, queued: false },
        called('a1', back(1, 5), 'WebFetch', 'competitor-d.example', 'https://competitor-d.example/pricing\nList every plan with its monthly and yearly price.', { done: back(0, 40), out: 'Starter 19 a month · Team 49 a month · Business 129 a month. The yearly prices load when the toggle is clicked.' }),
        { k: 'say', at: back(0, 30), model: OPUS, text: 'Their monthly prices are on the page. The yearly ones load from a second request: fetching that next.' },
        called('a2', back(0, 6), 'WebFetch', 'competitor-d.example', 'https://competitor-d.example/api/prices?billing=yearly\nRead the yearly price of every plan.', { done: 0 }),
      ],
      replies: [{ at: back(1, 5), ctx: 14000, out: 300 }, { at: back(0, 30), ctx: 21000, out: 500 }] };
    return { main: JSON.stringify(main), older: JSON.stringify(older), grown: JSON.stringify(grown), whole: JSON.stringify(whole), pricing: JSON.stringify(pricing), agent: JSON.stringify(agent) };
  };
  /** What the watcher would answer when asked for every conversation kept on the machine. */
  const madeUpHistory = () => {
    const past = (id, title, folder, minutesAgo, over) => ({ id, project: `D--work-${folder}`, cwd: `D:\\work\\${folder}`, title, name: '', prompt: '', mode: 'default', at: back(minutesAgo), first: back(minutesAgo + 190),
      size: 4.2e6, model: OPUS, out: 212000, replies: 310, tools: 420, compacts: 1, agents: 0, usd: 0, added: 0, removed: 0, counted: true, live: false, ...over });
    const list = [
      past('past-0', 'Empty tax field breaks the export', 'shop', 0.25, { cwd: 'Z:\\nowhere\\shop', size: 6.8e6, out: 388000, replies: 512, tools: 730, usd: 31.4, added: 412, removed: 96,
        prompt: 'Good. The PDF export has the same check. Fix it there too, and show me the diff before you commit.' }),
      past('s-agents', 'Pricing research', 'pricing', 0.4, { live: true, size: 48.2e6, out: 1.2e6, replies: 1840, tools: 2600, agents: 7, counted: false }),
      past('s-words', 'Invoice export bug', 'shop', 6.3, { live: true, size: 12.1e6 }),
      past('past-1', 'Move the blog to the new layout', 'landing', 26 * 60, { size: 88.4e6, out: 2.4e6, replies: 2210, tools: 3900, compacts: 6, agents: 14 }),
      past('past-2', 'Quarterly numbers', 'reports', 3 * 1440, { model: 'claude-sonnet-5-5', size: 1.3e6, out: 41000, replies: 64, tools: 51, compacts: 0 }),
      past('past-3', '', 'api', 4 * 1440, { prompt: 'Why does the login test fail one run in five? Look at the retries first.', size: 9.9e6 }),
      past('past-4', 'Rate limiter for the public API', 'api', 12 * 1440, { size: 2.28e9, out: 18.4e6, replies: 14200, tools: 22100, compacts: 31, agents: 120 }),
      past('past-5', 'First look at the codebase', 'shop', 45 * 1440, { size: 740e3, out: 9400, replies: 22, tools: 31, compacts: 0, model: '' }),
    ];
    return { at: madeAt, list, total: list.length, bytes: list.reduce((n, r) => n + r.size, 0), counting: false };
  };
  const installFakes = () => inPage(pageFakes, madeUpPages(), JSON.stringify(madeUpHistory()));
  const tabOf = (where, id) => exec(`document.querySelector('#${where} .seg.tabs button[data-tab="${id}"]').click()`);
  /** A click on a chat in the list on the left, found by its session. */
  const pick = (key) => inPage((k) => {
    const el = [...document.querySelectorAll('#chat-list .nav-item.chat')].find((x) => x.dataset.key === k);
    if (el) el.click();
    return Boolean(el);
  }, key);
  const typeInto = (selector, text) => inPage((sel, value) => { const f = document.querySelector(sel); f.value = value; f.dispatchEvent(new Event('input')); return true; }, selector, text);
  // two values hold the same; for a plain object the order of its keys does not count
  const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v);
  const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

  // ---- workspaces, over the made-up list: a name and the folders that belong to it. The list holds the chats of the
  // ---- workspace in front, and a tab says how many of its chats wait while another one is in front.
  const spacesNow = () => inPage(pageSpaces);
  const tabsOf = (sp) => sp.tabs.map((t) => `${t.name}${t.on ? '*' : ''}${t.n ? ` ${t.n}` : ''}`);
  const tabOfSpace = (id) => `#spaces .space-tab[data-space="${id}"]`;
  const keptSpaces = () => settingsNow().spaces.map((s) => [s.name, s.folders]);
  const toastNow = () => exec('document.getElementById("toast").hidden ? "" : document.getElementById("toast").textContent');
  const call = (name, ...args) => exec(`Desk.${name}(${args.map((x) => JSON.stringify(x)).join(', ')})`);
  const sortingPart = async () => {
    const SHOP = 'D:\\work\\shop';
    const PRICING = 'D:\\work\\pricing';
    const rowOf = (key) => `#chat-list .nav-item.chat[data-key="${key}"]`;
    const onDisk = () => { try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'desk.json'), 'utf8')).spaces.map((s) => [s.name, s.folders]); } catch { return null; } };
    const ticks = (menu) => menu.items.map((i) => i.label + (i.ticked ? '*' : ''));
    await exec('document.getElementById("toast").hidden = true; Desk.look(null); Desk.setView("peek")');
    await exec(`takeSnapshot(${fake(madeAt + 40, madeUpRows(true))})`);
    await wait(200);
    let sp = await spacesNow();
    check('with no workspace the list stands under the word "Chats" and its count, and holds no tab',
      !sp.on && sp.label === 'Chats' && sp.count === '9' && sp.tabs.length === 0 && sp.keys.length === 9, `"${sp.label} ${sp.count}", ${sp.keys.length} rows, ${sp.tabs.length} tabs`);

    // made from the menu above the list: its name is typed where its tab will stand
    await exec('document.getElementById("side-more").click()');
    await wait(100);
    await inPage(pageMenuRun, 'New workspace…');
    await wait(150);
    const asking = await spacesNow();
    await typeInto('#spaces .space-input', '  Clients  ');
    await inPage(pageKey, 'Enter', '#spaces .space-input');
    await wait(250);
    sp = await spacesNow();
    let page = await inPage(pagePeek);
    const clients = sp.spaces.length === 1 ? sp.spaces[0].id : '';
    const written = await until(async () => same(keptSpaces(), [['Clients', []]]) && settingsNow().space === clients, 3000, 100);
    check('a workspace is made from the menu above the list: its name is typed where its tab will stand, it comes in front, and it starts empty',
      asking.on && asking.input && asking.typing && same(tabsOf(asking), ['All*'])
      && /^w[0-9a-z]{1,12}$/.test(clients) && sp.spaces[0].name === 'Clients' && sp.space === clients && same(tabsOf(sp), ['All', 'Clients*', 'Unsorted 3'])
      && !sp.input && sp.label === '' && sp.keys.length === 0 && sp.empty.startsWith('No chat of this workspace is running.')
      && page.start === 'No chat of Clients is open in this window' && same(page.buttons, ['New chat', 'History']) && page.figures === 0 && Boolean(written),
      `tabs: ${tabsOf(sp).join(', ')}; the list: "${sp.empty}"; the page: "${page.start}"`);

    // sorted from the list: a right click on a chat puts its folder in a workspace, and every chat in that folder goes along
    await press(tabOfSpace(''));
    await wait(200);
    const inAll = await spacesNow();
    await inPage(pageRightClick, rowOf('s-words'));
    await wait(100);
    const rowMenu = await inPage(pageMenu);
    await inPage(pageMenuRun, 'Clients');
    await wait(250);
    sp = await spacesNow();
    const sortedSaid = await toastNow();
    const toldMain = await until(async () => same(keptSpaces(), [['Clients', [SHOP]]]), 3000, 100);
    const disk = await until(async () => same(onDisk(), [['Clients', [SHOP]]]), 4000, 150);
    check('a right click on a chat offers the workspaces, and the one picked takes its folder: said in the window, written down at once, and kept on disk',
      inAll.space === '' && inAll.keys.length === 9 && Boolean(rowMenu) && same(rowMenu.heads, ['"shop" and the folders in it are in'])
      && same(ticks(rowMenu), ['Bring here', 'Look at it', 'Open its folder', 'Clients', 'No workspace*']) && sortedSaid === '"shop" is now part of Clients.'
      && same(sp.spaces.map((s) => [s.name, s.folders]), [['Clients', [SHOP]]]) && sp.space === '' && sp.keys.length === 9 && Boolean(toldMain) && Boolean(disk),
      rowMenu ? `its menu: ${rowMenu.items.map((i) => i.label + (i.ticked ? ' (ticked)' : '')).join(' / ')}; Clients now holds ${sp.spaces[0] ? sp.spaces[0].folders.join(', ') : 'nothing'}` : 'no menu opened');

    await press(tabOfSpace(clients));
    await wait(200);
    sp = await spacesNow();
    const tip = (sp.tabs.find((t) => t.id === clients) || { tip: '' }).tip.split('\n');
    check('with a workspace in front the list holds its chats only, the ones that wait still on top; what is left to sort has a tab of its own, and the tabs fit the sidebar',
      sp.space === clients && same(sp.keys.slice().sort(), ['job:abc12345', 's-compact', 's-error', 's-finish', 's-idle', 's-permission', 's-words']) && same(sp.keys.slice(0, 3), ['job:abc12345', 's-error', 's-permission'])
      && same(tabsOf(sp), ['All', 'Clients*', 'Unsorted']) && same(tip.slice(0, 3), ['Clients', '7 chats · 3 need you', 'Ctrl Shift 2']) && !sp.spill
      && (await exec('document.getElementById("triage").textContent')) === '3 need you',
      `${sp.keys.length} of 9 rows: ${sp.keys.join(', ')}; its tab says "${tip.slice(0, 3).join(' | ')}"; the tabs take ${sp.lines} line${sp.lines === 1 ? '' : 's'}`);

    // a second workspace: a tab that is not in front counts the chats of its own that wait
    const studio = await call('addSpace', 'Studio');
    await call('putFolder', PRICING, studio);
    await wait(250);
    sp = await spacesNow();
    check('while another workspace is in front, a tab says in yellow how many of its chats wait for you',
      sp.space === studio && same(sp.keys, ['s-agents']) && same(tabsOf(sp), ['All', 'Clients 3', 'Studio*', 'Unsorted']), `tabs: ${tabsOf(sp).join(', ')}; the list: ${sp.keys.join(', ')}`);
    const rules = await inPage((c) => ({
      inside: Desk.spaceOf('D:\\work\\shop\\src\\api') === c, written: Desk.spaceOf('d:/WORK/Shop/') === c,
      beside: Desk.spaceOf('D:\\work\\shopping'), none: Desk.spaceOf(''), other: Desk.spaceOf('D:\\work\\api'),
    }), clients);
    check('a chat in a folder inside a sorted folder is in its workspace, however the path is written; a folder that only begins the same is not',
      rules.inside && rules.written && rules.beside === '' && rules.none === '' && rules.other === '', JSON.stringify(rules));
    await call('putFolder', SHOP, studio);
    await wait(150);
    const moved = (await spacesNow()).spaces.map((s) => [s.name, s.folders]);
    await call('putFolder', SHOP, clients);
    await exec('document.getElementById("toast").hidden = true');
    await call('putFolder', 'D:\\work\\shop\\src', '');
    await wait(150);
    const refusal = await toastNow();
    sp = await spacesNow();
    check('a folder is in one workspace only, and a folder that is in one through the folder above it is not taken out behind your back',
      same(moved, [['Clients', []], ['Studio', [PRICING, SHOP]]]) && same(sp.spaces.map((s) => [s.name, s.folders]), [['Clients', [SHOP]], ['Studio', [PRICING]]])
      && refusal === `"src" is in Clients because ${SHOP} is. Put it in another workspace, or take that folder out in Settings.`, `moved over: ${JSON.stringify(moved)}; then: "${refusal}"`);
    // taken out of its own workspace, a folder can still be in another one through the folder above it
    await call('putFolder', 'D:\\work', studio);
    await call('putFolder', SHOP, '');
    await wait(150);
    const fellTo = await toastNow();
    const nested = (await spacesNow()).spaces.map((s) => [s.name, s.folders]);
    await call('putFolder', 'D:\\work', '');
    await call('putFolder', SHOP, clients);
    await wait(150);
    check('a folder taken out of its workspace that is still inside a sorted folder is said to be where it is now',
      fellTo === '"shop" is now part of Studio, because D:\\work is.' && same(nested, [['Clients', []], ['Studio', [PRICING, 'D:\\work']]])
      && same((await spacesNow()).spaces.map((s) => [s.name, s.folders]), [['Clients', [SHOP]], ['Studio', [PRICING]]]) && (await exec('folderAs("D:/")')) === 'D:\\', `"${fellTo}"; a whole drive is kept as ${await exec('folderAs("D:/")')}`);
    await exec('document.getElementById("toast").hidden = true');

    // what is asked for is followed across workspaces: the chat that has waited longest is in the other one
    await exec('document.getElementById("triage").click()');
    await wait(250);
    sp = await spacesNow();
    const led = await inPage(pageList);
    check('"need you" in the title bar leads to the chat that has waited longest, and its workspace comes in front with it',
      sp.space === clients && led.view === 'peek' && led.sel === 'job:abc12345' && led.picked === 1 && sp.keys.includes('job:abc12345'),
      `in front: ${(sp.tabs.find((t) => t.on) || {}).name}; looking at ${led.sel}`);
    await exec('Desk.look(null)');

    // the keys: Ctrl Shift 1 is every chat, 2 and 3 the workspaces by their tabs
    const walked = [];
    for (const code of ['Digit1', 'Digit3', 'Digit2', 'Digit9']) { await ctrl(code, { shift: true }); await wait(120); walked.push(await exec('Desk.state.settings.space')); }
    const nameOf = (id) => (id === '' ? 'All' : id === studio ? 'Studio' : id === clients ? 'Clients' : id);
    check('Ctrl Shift 1 to 9 goes to a workspace by its tab, 1 is every chat, and a number with no tab does nothing', same(walked, ['', studio, clients, clients]), walked.map(nameOf).join(', '));

    // what is in no workspace yet: a tab of its own, which goes once it is empty
    await press(tabOfSpace('?'));
    await wait(200);
    const loose = await spacesNow();
    page = await inPage(pagePeek);
    await inPage(pageRightClick, rowOf('codex:x'));
    await wait(100);
    const looseMenu = await inPage(pageMenu);
    await inPage(pageMenuRun, 'Studio');
    await wait(250);
    sp = await spacesNow();
    check('"Unsorted" holds the chats that are in no workspace; once the last one is sorted its tab goes, and every chat is shown',
      loose.loose && loose.space === '' && same(loose.keys, ['codex:x']) && same(tabsOf(loose), ['All', 'Clients 3', 'Studio', 'Unsorted*'])
      && page.start === 'No unsorted chat is open in this window' && Boolean(looseMenu) && same(looseMenu.heads, ['"api" and the folders in it are in'])
      && same(ticks(looseMenu), ['Look at it', 'Open its folder', 'Clients', 'Studio', 'No workspace*'])
      && !sp.loose && sp.space === '' && sp.keys.length === 9 && same(tabsOf(sp), ['All*', 'Clients 3', 'Studio']),
      `unsorted: ${loose.keys.join(', ')}; after sorting it, tabs: ${tabsOf(sp).join(', ')}`);

    // renamed from its tab; a name that is begun and given up makes nothing
    await inPage(pageRightClick, tabOfSpace(clients));
    await wait(100);
    const tabMenu = await inPage(pageMenu);
    await inPage(pageMenuRun, 'Rename');
    await wait(150);
    const renaming = await inPage(() => { const f = document.querySelector('#spaces .space-input'); return f ? { value: f.value, focus: document.activeElement === f } : null; });
    await typeInto('#spaces .space-input', 'Upwork');
    await inPage(pageKey, 'Enter', '#spaces .space-input');
    await wait(200);
    sp = await spacesNow();
    await exec('document.getElementById("side-more").click()');
    await wait(100);
    const offers = (await inPage(pageMenu)).items.map((i) => i.label);
    await inPage(pageMenuRun, 'New workspace…');
    await wait(150);
    const begun = await spacesNow();
    await typeInto('#spaces .space-input', 'Given up');
    await inPage(pageKey, 'Escape', '#spaces .space-input');
    await wait(150);
    const after = await spacesNow();
    check('a right click on a tab renames the workspace or takes it away; a name that is given up with Esc makes nothing',
      Boolean(tabMenu) && same(tabMenu.items.map((i) => i.label), ['Rename', 'Its folders…', 'Take this workspace away']) && Boolean(renaming) && renaming.value === 'Clients' && renaming.focus
      && same(sp.tabs.map((t) => t.name), ['All', 'Upwork', 'Studio']) && sp.spaces[0].id === clients && same(sp.spaces[0].folders, [SHOP])
      && same(offers, ['New chat', 'Bring the 7 in other terminals here', 'New workspace…', 'Workspaces and their folders…'])
      && begun.input && begun.typing && same(after.tabs.map((t) => t.name), ['All', 'Upwork', 'Studio']) && !after.input && after.spaces.length === 2,
      `its menu: ${tabMenu ? tabMenu.items.map((i) => i.label).join(' / ') : 'none'}; the tab now says "${(sp.tabs[1] || {}).name}"`);

    // the search box knows them, and the New chat panel puts the folders of the workspace in front first
    await exec('Palette.open()');
    await wait(300);
    await typeInto('#palette input', 'workspace');
    await wait(150);
    // what is found can also be a past conversation of his, or something he typed: only the commands are looked at
    const found = await inPage(() => [...document.querySelectorAll('#palette .pal-item')].filter((el) => (el.querySelector('.from') || {}).textContent === 'Do').map((el) => el.querySelector('.label').textContent));
    await inPage(() => { const hit = [...document.querySelectorAll('#palette .pal-item')].find((el) => el.querySelector('.label').textContent === 'Workspace: Studio'); if (hit) hit.click(); return Boolean(hit); });
    await wait(250);
    sp = await spacesNow();
    const boxShut = (await exec('document.getElementById("palette").hidden')) === true;
    await exec('Desk.openPicker()');
    await wait(200);
    // the folders further down the panel can be his: only the first one, which is made up, is looked at
    const panel = await inPage(() => {
      const first = document.querySelector('#picker .folders .pick');
      const note = document.querySelector('#picker .pick-note');
      return { tag: first ? (first.querySelector('.tag') || { textContent: '' }).textContent : '', madeUp: Boolean(first) && /\\(pricing|api)$/.test(first.querySelector('.path').textContent),
        note: note && !note.hidden ? note.textContent : '' };
    });
    await exec('Picker.close()');
    check('the search box goes to a workspace, and the New chat panel lists the folders of the one in front first, each with the workspace it is in',
      same(found.slice().sort(), ['New workspace', 'Workspace: Studio', 'Workspace: Upwork']) && sp.space === studio && boxShut
      && panel.tag === 'Studio' && panel.madeUp && panel.note === 'A folder that is in no workspace yet joins Studio. One that is in another workspace opens there.',
      `"workspace" finds the commands: ${found.join(' / ')}; the first folder offered is tagged "${panel.tag}"`);

    // Settings lists them with their folders; a folder is taken out, a workspace taken away, and with the last one gone the tabs go too
    await exec('Settings.open("spaces")');
    await wait(200);
    const setNow = () => inPage(() => {
      const part = document.querySelector('#settings section[data-section="spaces"]');
      return { rows: [...part.querySelectorAll('.space-row[data-space] .name-input')].map((f) => f.value), folders: [...part.querySelectorAll('.space-folder .what b')].map((b) => b.textContent),
        fresh: Boolean(part.querySelector('.space-new')), focus: Boolean(document.activeElement) && part.contains(document.activeElement), keys: document.querySelectorAll('#settings .keys kbd').length };
    });
    const shownIn = await setNow();
    await exec(`document.querySelector('#settings section[data-section="spaces"] .space-folder .mini').click()`);
    await wait(200);
    const fewer = await setNow();
    await exec(`[...document.querySelectorAll('#settings section[data-section="spaces"] .space-row[data-space] .btn')].pop().click()`);
    await wait(200);
    const one = await setNow();
    await exec('Settings.close()');
    sp = await spacesNow();
    const kept = await until(async () => same(keptSpaces(), [['Upwork', []]]) && settingsNow().space === '', 3000, 100);
    await call('removeSpace', clients);
    await wait(200);
    const none = await spacesNow();
    const cleared = await until(async () => settingsNow().spaces.length === 0 && same(onDisk(), []), 4000, 150);
    check('Settings lists the workspaces with their folders: a folder can be taken out, a workspace taken away, and with the last one gone the tabs go too',
      same(shownIn.rows, ['Upwork', 'Studio']) && same(shownIn.folders, ['shop', 'pricing', 'api']) && shownIn.fresh && shownIn.focus && shownIn.keys === 21
      && same(fewer.rows, ['Upwork', 'Studio']) && same(fewer.folders, ['pricing', 'api']) && fewer.focus && same(one.rows, ['Upwork']) && same(one.folders, []) && one.focus
      && same(tabsOf(sp), ['All*', 'Upwork', 'Unsorted 3']) && Boolean(kept)
      && !none.on && none.tabs.length === 0 && none.label === 'Chats' && none.count === '9' && none.keys.length === 9 && none.spaces.length === 0 && !none.loose && Boolean(cleared),
      `listed: ${shownIn.rows.join(', ')} with ${shownIn.folders.join(', ')}; after taking Studio away: ${tabsOf(sp).join(', ')}; with none left: "${none.label} ${none.count}"`);
    await exec('document.getElementById("toast").hidden = true');
  };

  // ---- every state a row of the list can be in, a chat looked at and read, History, the Dashboard, the search box, Settings ----
  const statesPhase = async () => {
    const real = watch.latest();
    // the real watcher holds its tongue for ten minutes, so nothing replaces the made-up rows mid-picture
    watch.post({ type: 'pace', ms: 600000 });
    await wait(700);
    // the made-up day is always twenty to four in the afternoon, whenever the test runs: the charts have a day to show
    const afternoon = new Date();
    afternoon.setHours(15, 40, 0, 0);
    madeAt = await inPage(pageClock, afternoon.getTime() - Date.now());
    const now = madeAt;
    await installFakes();
    await showUsage('today');
    await exec(`Desk.state.res = ${JSON.stringify(madeUpRes())}`);
    await exec(`takeSnapshot(${fake(now, madeUpRows(false))})`);
    await exec(`takeSnapshot(${fake(now + 1, madeUpRows(true))})`);
    await wait(250);
    let list = await inPage(pageList);
    check('every state draws in the list, grouped by what it wants from you: who waits, who finished unseen, who works, who is idle',
      same(list.groups, { needs: 3, done: 1, working: 4, idle: 1 }) && same(list.order, ['needs', 'done', 'working', 'idle']) && list.total === '9' && list.away === 9 && list.here === 0 && !list.overflow,
      `${JSON.stringify(list.groups)}, ${list.total} in all`);
    // another account logging in is said in the window (here: the made-up one taking over from the real one)
    const said = await exec('document.getElementById("toast").textContent');
    check('a change of account is said in the window', /^Now on studio@example\.com\. When last seen: /.test(said), /^Now on studio@example\.com/.test(said) ? `"${said}"` : 'the line at the bottom said something else');

    const rows = await inPage(() => {
      const all = [...document.querySelectorAll('#chat-list .nav-item.chat')];
      const by = (key) => all.find((el) => el.dataset.key === key);
      const when = (key) => { const el = by(key).querySelector('.when'); return el ? (el.classList.contains('needs') ? '!' : '') + el.textContent : null; };
      const res = (key) => { const el = by(key).querySelector('.res'); return el ? el.textContent : null; };
      const triage = document.getElementById('triage');
      return {
        order: all.map((el) => el.dataset.key),
        marks: Object.fromEntries(all.map((el) => [el.dataset.key, el.dataset.mark])),
        glyphs: all.filter((el) => el.querySelector('.glyph')).length,
        waits: Object.fromEntries(['job:abc12345', 's-error', 's-permission', 's-finish'].map((k) => [k, when(k)])),
        subs: ['s-permission', 's-agents', 's-idle', 's-error', 'job:abc12345'].map((k) => by(k).dataset.sub),
        out: all.filter((el) => el.querySelector('.out')).length,
        // the fourth line of a row's note: where it runs
        where: ['s-agents', 'job:abc12345'].map((k) => by(k).dataset.tip.split('\n\n')[0].split('\n')[3] || ''),
        res: ['s-agents', 's-words', 's-compact', 's-idle', 'codex:x', 's-permission'].map(res),
        tips: ['s-agents', 's-permission'].map((k) => by(k).dataset.tip.split('\n\n')[1] || ''),
        need: triage.hidden ? '' : triage.textContent,
      };
    });
    check('the list stands in the order of who needs you most: the one that has waited longest on top, then who finished unseen, who works, who is idle',
      same(rows.order, ['job:abc12345', 's-error', 's-permission', 's-finish', 'codex:x', 's-agents', 's-compact', 's-words', 's-idle']) && rows.need === '3 need you',
      `${rows.order.join(', ')}; the title bar says "${rows.need}"`);
    check('each row carries its mark, and a row that waits says for how long',
      same(rows.marks, { 's-permission': 'needs', 's-error': 'error', 'job:abc12345': 'needs', 's-agents': 'working', 's-words': 'working', 's-compact': 'compacting', 'codex:x': 'working', 's-finish': 'done', 's-idle': 'idle' })
      && rows.glyphs === 9 && rows.waits['job:abc12345'] === '!1h' && rows.waits['s-error'] === '!8m' && /^!\d\ds$/.test(rows.waits['s-permission'] || '') && /^\d\ds$/.test(rows.waits['s-finish'] || ''),
      `marks ${JSON.stringify(rows.marks)}; waiting ${JSON.stringify(rows.waits)}`);
    check('what a chat is doing is in its hover note, a chat that runs outside this window is marked as such, and its note says where it runs',
      same(rows.subs, ['Waiting for your permission', 'Agent · Compare competitor D', 'Idle', 'Stopped at a usage limit', 'Blocked until you answer']) && rows.out === 9
      && rows.where[0] === 'It runs in another terminal. Click to look at it, and to move it here.' && rows.where[1] === 'A background session: it runs outside every terminal. Click to look at it.',
      `${rows.subs.join(' | ')}; ${rows.out} of 9 marked as running elsewhere`);
    check('a row that does not wait ends in the RAM its session holds on this computer, and its note lists what it runs',
      same(rows.res, ['1.2 GB', '444 MB', '860 MB', '153 MB', '188 MB', null])
      && rows.tips[0] === 'This session holds 1.2 GB of RAM in 14 programs and uses 14% of the processor.\nThe agent itself: 612 MB\nvite: 233 MB\npython (2): 230 MB\nMCP servers (2): 135 MB\nA server is up on :5173\nRAM as Task Manager counts it.\nIt runs: vite · python · 3 subagents · 2 MCP servers'
      && rows.tips[1].startsWith('This session holds 514 MB of RAM in 7 programs and uses <1% of the processor.'),
      rows.res.map((t) => (t === null ? '(says how long it waits instead)' : `"${t}"`)).join(', '));

    // under the list: a limit that was reached, the account in use, and the other places of the window
    const foot = await inPage(() => {
      const acct = document.getElementById('acct');
      const lim = document.getElementById('side-limit');
      const places = document.querySelector('#side .places');
      return {
        limit: lim.hidden ? '' : lim.textContent, name: (acct.querySelector('.acct-name') || {}).textContent || '', plan: (acct.querySelector('.acct-plan') || {}).textContent || '',
        slims: [...acct.querySelectorAll('.slim')].map((x) => `${x.className.replace('slim', '').trim()}:${x.textContent}`), ticks: acct.querySelectorAll('.track u').length,
        tip: (acct.querySelector('.slim') || { dataset: {} }).dataset.tip || '', room: (acct.querySelector('.acct-room') || {}).textContent || '',
        places: [...places.querySelectorAll('.nav-item .label')].map((x) => x.textContent),
        cut: places.scrollWidth > places.clientWidth + 1 || [...places.querySelectorAll('.nav-item')].some((x) => x.scrollWidth > x.clientWidth + 1),
        counts: document.querySelectorAll('#side .count').length,
      };
    });
    check('a usage limit that was reached stands under the list until it lifts', /^5-hour limit reachedlifts in 4[12]m$/.test(foot.limit), `"${foot.limit}"`);
    check('under the list, the account in use with its two limits, where they are heading, and the other account with the most room',
      foot.name === 'studio' && foot.plan === 'Max 20x' && foot.slims.length === 2 && /^warm:5h86%2h \d\dm$/.test(foot.slims[0]) && /^:Week41%3d \dh$/.test(foot.slims[1]) && foot.ticks === 2
      && /At that pace it is used up at \d\d:\d\d: \d+m before it resets\./.test(foot.tip) && foot.room === 'most room: client-work',
      `${foot.name} · ${foot.plan} · ${foot.slims.join(' | ')} · "${foot.room}"`);
    check('then History and the Dashboard, each named in full, and not one figure of the day', same(foot.places, ['History', 'Dashboard']) && !foot.cut && foot.counts === 0, foot.places.join(', '));
    const blank = await inPage(pagePeek);
    check('with no chat open here and none picked, the panel is the start page: it offers to bring the chats of other terminals here, and holds no figure',
      blank.start === START && same(blank.buttons, ['New chat', 'Bring all 7 here', 'History']) && blank.figures === 0 && !blank.pane,
      `"${blank.start}"; it offers: ${blank.buttons.join(' / ')}; figures on the main screen: ${blank.figures}`);
    say(`      a picture waits for the page to draw: ${await drawn()}`);
    await shoot('0-list');

    // ---- one chat that runs elsewhere, looked at: what it is doing, its subagents, its numbers ----
    await pick('s-agents');
    await wait(300);
    list = await inPage(pageList);
    let pane = await inPage(pageDetail, 'peek');
    check('a chat that runs elsewhere, picked in the list, takes the panel: what it is doing, what was asked, its tool calls, its subagents, and the button that moves it here',
      list.view === 'peek' && list.picked === 1 && list.sel === 's-agents' && pane.shown && pane.title === 'Pricing research' && pane.words === 'Agent · Compare competitor D' && pane.mark === 'working' && pane.button === 'Bring here'
      && same(pane.tabs, ['Overview*', 'Conversation', 'Changes', 'Subagents3', 'Numbers']) && same(pane.heads, ['You last asked', 'Its latest words', 'While you were away', 'This turn', 'Subagents', 'On this computer', 'About'])
      // the facts under its title: how full the model's memory is, then what its programs hold on this computer, then the rest
      && pane.calls === 5 && pane.agents === 4 && pane.facts.length === 8 && pane.facts[1] === '1.2 GBRAM · CPU 14%:5173' && !(await inPage(pageSpill, 'peek')) && !list.overflow,
      `"${pane.title}" · ${pane.words} · tabs: ${pane.tabs.join(', ')} · ${pane.heads.join(', ')} · ${pane.calls} tool calls, ${pane.agents} subagents · ${pane.facts.join(' · ')}`);
    const own = await inPage(() => {
      const box = document.querySelector('#peek .d-body .res-box');
      return { note: box.querySelector('.sec-head .note').textContent, head: box.querySelector('.res-row.head').textContent,
        rows: [...box.querySelectorAll('.res-row:not(.head)')].map((r) => ['.res-what', '.res-mem', '.res-cpu'].map((sel) => r.querySelector(sel).textContent).join(' | ')),
        ports: [...box.querySelectorAll('.port')].map((p) => p.textContent), wide: box.scrollWidth > box.clientWidth + 1 };
    });
    check('its page lists what it runs on this computer: the agent itself, then each program it started, with its RAM, its processor share and its port',
      own.note === '1.2 GB RAM · 14% CPU · 14 programs' && own.head === 'RAMCPU' && same(own.rows, [
        'Claude Codethe agent itself · 3 subagents working inside it | 612 MB | 9%', 'vitea server · 3 programs:5173 | 233 MB | 4%', 'pythona command it runs · 2 programs | 199 MB | <1%',
        '@playwright/mcpMCP server · 3 programs | 88 MB | 0%', 'mcp_serverMCP server · 3 programs | 47 MB | 0%', 'pythonstarted with the session · 2 programs | 31 MB | 0%'])
      && same(own.ports, [':5173']) && !own.wide, `"${own.note}"; ${own.rows.length} lines: ${own.rows.join(' ; ')}`);
    // a newer measurement changes those figures alone: the rest of the page and the chat's row in the list are the same nodes as before
    const mark = await inPage(() => {
      document.querySelector('#peek .d-body .tl-row').dataset.kept = '1';
      [...document.querySelectorAll('#chat-list .nav-item.chat')].find((el) => el.dataset.key === 's-agents').dataset.kept = '1';
      return true;
    });
    const newer = madeUpRes();
    newer.sessions['s-agents'].own.mem = 700 * MB;
    newer.sessions['s-agents'].mem += 88 * MB;
    await exec(`Desk.state.res = ${JSON.stringify(newer)}; paint()`);
    await wait(150);
    const redrawn = await inPage(() => {
      const row = [...document.querySelectorAll('#chat-list .nav-item.chat')].find((el) => el.dataset.key === 's-agents');
      return { first: document.querySelector('#peek .d-body .res-row:not(.head) .res-mem').textContent, note: document.querySelector('#peek .d-body .res-box .sec-head .note').textContent,
        kept: Boolean(document.querySelector('#peek .d-body .tl-row[data-kept="1"]')), row: row.querySelector('.res').textContent, sameRow: row.dataset.kept === '1' };
    });
    check('a newer measurement changes those figures in place, on its page and on its row in the list, without redrawing either', Boolean(mark) && redrawn.first === '700 MB' && redrawn.note === '1.3 GB RAM · 14% CPU · 14 programs' && redrawn.kept
      && redrawn.row === '1.3 GB' && redrawn.sameRow, `Claude Code itself now "${redrawn.first}", the session "${redrawn.note}", its row "${redrawn.row}"; the tool calls above were left as they were: ${redrawn.kept}`);
    await exec(`Desk.state.res = ${JSON.stringify(madeUpRes())}; paint()`);
    await shoot('0-session');
    await tabOf('peek', 'agents');
    await wait(150);
    const tree = await inPage(() => ({ rows: document.querySelectorAll('#peek .d-body .ag-row').length, depth: document.querySelector('#peek .ag-row[data-agent="price-table"]').style.getPropertyValue('--depth'),
      read: document.querySelectorAll('#peek .ag-row .ag-end .btn').length, doing: document.querySelector('#peek .ag-row[data-agent="competitor-d"] .ag-line').textContent,
      note: document.querySelector('#peek .d-body .sec-head .note').textContent }));
    check('its subagents are drawn as a tree, each under the one that started it', tree.rows === 4 && tree.depth === '1' && tree.read === 4 && tree.doing === 'WebFetch · competitor-d.example'
      && tree.note === '3 working · 1 finished in the last half hour · 7 in all', `${tree.rows} subagents, "${tree.note}"`);
    await shoot('0-subagents');
    // a subagent's own conversation can be read, and the way back is one click
    await exec(`document.querySelector('#peek .ag-row[data-agent="competitor-d"] .ag-end .btn').click()`);
    await wait(250);
    const sub = await inPage(pageReader, 'peek');
    const crumb = await inPage(() => {
      const el = document.querySelector('#peek .crumb');
      const r = el.getBoundingClientRect();
      const body = document.querySelector('#peek .d-body').getBoundingClientRect();
      return { words: (el.querySelector('.quiet') || {}).textContent || '', who: (document.querySelector('#peek .rd-ask .who') || {}).textContent || '',
        tab: (document.querySelector('#peek .seg.tabs button.on') || {}).textContent || '', seen: !el.hidden && r.height > 0 && r.bottom <= body.top + 1 };
    });
    await shoot('0-subagent-reading');
    await exec(`document.querySelector('#peek .crumb .btn').click()`);
    await wait(250);
    const mainAgain = await inPage(pageReader, 'peek');
    check("a subagent's own conversation can be read, and one click leads back to the main one",
      crumb.words === 'Subagent: competitor-d' && crumb.seen && crumb.who === 'The brief it was given' && crumb.tab === 'Conversation' && sub.asks === 1 && sub.tools === 2 && sub.running === 1 && sub.says === 1
      && mainAgain.asks === 1 && mainAgain.tools === 5 && mainAgain.running === 2 && (await exec('document.querySelector("#peek .crumb").hidden')),
      `the subagent: ${sub.asks} brief, ${sub.tools} tool calls (${sub.running} running), ${sub.says} said; back on the main one: ${mainAgain.tools} tool calls`);
    await tabOf('peek', 'numbers');
    await wait(150);
    const nums = await inPage(() => ({ heads: [...document.querySelectorAll('#peek .d-body .sec-head h4')].map((x) => x.textContent), cells: document.querySelectorAll('#peek .nums > *').length,
      now: [...document.querySelectorAll('#peek .d-body .plist dt')].map((x) => x.textContent), area: document.querySelectorAll('#peek .area path').length, pulse: document.querySelectorAll('#peek .pulse-box .spark').length,
      foot: (document.querySelector('#peek .area-foot') || {}).textContent || '' }));
    check('its numbers: today against all time, what it last told its status line, its memory reply after reply, and its last half hour',
      same(nums.heads, ['Numbers', 'Right now', 'Memory, reply after reply', 'The last 30 minutes']) && nums.cells === 27 && same(nums.now, ['Used so far', 'Lines changed', 'Cache']) && nums.area === 3 && nums.pulse === 1
      && /now 402k of about 467k/.test(nums.foot), `${nums.heads.join(', ')}; ${nums.cells} cells; "${nums.foot}"`);
    await shoot('0-numbers');
    await tabOf('peek', 'overview');

    // ---- moving on: a chat that finished unseen counts as seen once another is looked at; Esc leaves ----
    await pick('s-finish');
    await wait(200);
    const unseen = { list: await inPage(pageList), pane: await inPage(pageDetail, 'peek') };
    await pick('s-permission');
    await wait(200);
    list = await inPage(pageList);
    pane = await inPage(pageDetail, 'peek');
    check('a chat that finished unseen says so while it is looked at, and counts as seen once you move on to another',
      unseen.list.sel === 's-finish' && unseen.pane.mark === 'done' && unseen.pane.words === 'Finished' && unseen.list.groups.done === 1
      && list.sel === 's-permission' && list.picked === 1 && same(list.groups, { needs: 3, working: 4, idle: 2 }) && pane.mark === 'needs' && pane.notice === 'Waiting for your permission' && pane.tabs[0] === 'Overview*',
      `looked at, it says "${unseen.pane.words}"; after moving on the groups are ${JSON.stringify(list.groups)}; the next one says "${pane.notice}"`);
    await shoot('0-needs-you');
    await inPage(pageKey, 'Escape');
    await wait(150);
    const closed = { list: await inPage(pageList), peek: await inPage(pagePeek) };
    check('Esc leaves the chat that was looked at', closed.list.picked === 0 && closed.list.sel === '' && !closed.peek.pane && closed.peek.start === START);

    // ---- a conversation, read: what was asked, what was said, every tool call, edits as changed lines ----
    await pick('s-words');
    await wait(300);
    pane = await inPage(pageDetail, 'peek');
    const still = await exec(`(document.querySelector('#peek .d-state .timer.still:not([hidden])') || {}).textContent || ''`);
    await tabOf('peek', 'conv');
    await wait(250);
    let read = await inPage(pageReader, 'peek');
    check('a conversation is laid out to be read: what was asked, what was said, each tool call, and the marks between turns',
      pane.title === 'Invoice export bug' && /^quiet \dm$/.test(still) && same(pane.tabs.slice(0, 3), ['Overview*', 'Conversation', 'Changes2'])
      && read.asks === 2 && read.says === 3 && read.tools === 7 && read.failed === 1 && read.running === 1 && read.thoughts === 2 && read.turns === 1 && read.marks === 1 && read.notes === 1 && read.days === 1
      && read.tables === 1 && read.code === 1 && read.lists === 2 && read.headings === 1 && /^Read from \d\d:\d\d on\.Read further back$/.test(read.top) && read.asked === '2 asked',
      `${read.asks} asked, ${read.says} said, ${read.tools} tool calls (${read.failed} failed, ${read.running} running), ${read.thoughts} thoughts, ${read.turns} turn end, ${read.marks} compaction, ${read.notes} summary; a table, a code block, a list; "${read.top}"`);
    await shoot('0-conversation');
    await exec(`document.querySelector('#peek .rd-list .md-table').scrollIntoView({ block: 'center' })`);
    await shoot('0-conversation-reply');
    const paneAt = () => exec(`document.querySelector('#peek .d-body').scrollTop`);
    const leftAt = await paneAt();
    await tabOf('peek', 'changes');
    await wait(150);
    const changesAt = await paneAt();
    await tabOf('peek', 'conv');
    await wait(150);
    const backAt = await paneAt();
    check('the list of changed files opens at its top, and the conversation is back where it was being read', leftAt > 0 && changesAt === 0 && backAt === leftAt,
      `left ${leftAt} px down; the changes open at ${changesAt}; back at ${backAt}`);
    // a tool call unfolds into what it was given and what came back; an edit shows the lines it changed
    await inPage(() => {
      const tools = [...document.querySelectorAll('#peek .rd-list .rd-tool')];
      tools.find((t) => t.querySelector('.t-name').textContent === 'Edit').querySelector('.rd-tool-head').click();
      [...document.querySelectorAll('#peek .rd-list .rd-tool')].find((t) => t.classList.contains('err')).querySelector('.rd-tool-head').click();
      return true;
    });
    await wait(150);
    read = await inPage(pageReader, 'peek');
    const unfolded = await inPage(() => ({ numbers: [...document.querySelectorAll('#peek .rd-tool.open .diff .dl')].slice(0, 3).map((l) => [...l.querySelectorAll('.ln')].map((n) => n.textContent).join('/')),
      delta: (document.querySelector('#peek .rd-tool.open .diff-head .delta') || {}).textContent || '', bad: document.querySelectorAll('#peek .rd-tool.open .t-pre.t-out.bad').length,
      failed: (document.querySelector('#peek .rd-tool.err .t-err') || {}).textContent || '', turn: (document.querySelector('#peek .rd-turn') || {}).textContent || '' }));
    check('a tool call unfolds into what it was given and what came back, and an edit shows its changed lines with their line numbers',
      read.open === 2 && read.diffLines === 10 && read.added === 5 && read.removed === 2 && same(unfolded.numbers, ['21/21', '22/22', '23/']) && unfolded.delta === '+5−2' && unfolded.bad === 1 && unfolded.failed === 'failed'
      && /^Turn over after 6m 52s · \d\d:\d\d · 5 tool calls · 2 files changed · 10k tokens out$/.test(unfolded.turn),
      `${read.diffLines} lines in the change (${unfolded.delta}), numbered ${unfolded.numbers.join(' ')}; the failed call shows its output; "${unfolded.turn}"`);
    await exec(`document.querySelector('#peek .rd-tool.open').scrollIntoView({ block: 'start' })`);
    await shoot('0-conversation-diff');
    // further back, a page at a time
    await exec('window.deskFake.older = true');
    await exec(`document.querySelector('#peek .rd-top .btn').click()`);
    await wait(250);
    read = await inPage(pageReader, 'peek');
    const whole = read;
    await exec(`document.querySelector('#peek .rd-bar .seg button[data-mode="words"]').click()`);
    await wait(100);
    const words = await inPage(pageReader, 'peek');
    await exec(`document.querySelector('#peek .rd-bar .seg button[data-mode="asks"]').click()`);
    await wait(100);
    const asks = await inPage(pageReader, 'peek');
    await exec(`document.querySelector('#peek .rd-bar .seg button[data-mode="all"]').click()`);
    await typeInto('#peek .rd-find input', 'decimals');
    await wait(100);
    const found = await inPage(pageReader, 'peek');
    await typeInto('#peek .rd-find input', '');
    check('it reads further back a page at a time, folds the tool calls away, shows only the prompts, and finds a word',
      whole.asks === 3 && whole.says === 4 && whole.tools === 9 && whole.turns === 2 && whole.top === 'This is where the conversation begins.' && whole.asked === '3 asked'
      && words.tools === 0 && words.thoughts === 0 && words.runs === 5 && words.says === 4 && asks.asks === 3 && asks.says === 0 && asks.tools === 0 && asks.turns === 2
      && found.says === 2 && found.asks === 0 && found.tools === 0,
      `whole: ${whole.asks} asked, ${whole.tools} tool calls, "${whole.top}"; words only: ${words.runs} folded runs; prompts only: ${asks.asks}; "decimals" is in ${found.says} replies`);
    // a conversation that is still being written is kept up with; read further up, the new lines are announced instead of moving the page
    await exec(`document.querySelector('#peek .d-body').scrollTop = 0; window.deskFake.grown = true`);
    for (let i = 0; i < 3; i++) await exec('Desk.Peek.detail().reader.tick()');
    const jumped = await until(async () => { const r = await inPage(pageReader, 'peek'); return r.jump ? r : null; }, 5000);
    await exec(`document.querySelector('#peek .rd-jump').click()`);
    await wait(100);
    const after = await inPage(pageReader, 'peek');
    await tabOf('peek', 'changes');
    await wait(150);
    const files = () => inPage(() => ({ sum: (document.querySelector('#peek .chg-sum') || {}).textContent || '', where: (document.querySelector('#peek .chg-top .quiet') || {}).textContent || '',
      files: [...document.querySelectorAll('#peek .chg-file')].map((f) => `${f.querySelector('.f-name').textContent} ${f.querySelector('.delta').textContent} ${f.querySelector('.f-n').textContent}${f.querySelector('.chip') ? ' new' : ''}`),
      edits: document.querySelectorAll('#peek .chg-file.open .chg-edit').length, lines: document.querySelectorAll('#peek .chg-file.open .dl').length,
      tab: (document.querySelector('#peek .seg.tabs button.on') || {}).textContent || '' }));
    let changes = await files();
    await exec(`[...document.querySelectorAll('#peek .chg-file')].find((f) => f.querySelector('.f-name').textContent === 'export.ts').querySelector('.chg-head').click()`);
    await wait(100);
    const opened = await files();
    check('new lines of a running conversation arrive by themselves: the call that was running comes back, and the page stays where it is being read',
      Boolean(jumped) && jumped.jump === '1 new below' && jumped.running === 0 && jumped.says === 5 && jumped.new === 1 && after.jump === '',
      jumped ? `"${jumped.jump}", ${jumped.running} still running, ${jumped.says} replies` : 'nothing arrived');
    check('the files a conversation changed are listed, each with every edit made to it',
      changes.sum === '3 files changed +18−4' && changes.where === 'In the whole conversation.' && changes.tab === 'Changes3'
      && same(changes.files, ['pdf.ts +1−1 1 edit', 'export.ts +6−3 2 edits', 'export.test.ts +11 1 edit new']) && opened.edits === 2 && opened.lines === 14,
      `${changes.sum}: ${changes.files.join(' ; ')}; export.ts unfolds into ${opened.edits} edits, ${opened.lines} lines`);
    await shoot('0-changes');
    await tabOf('peek', 'overview');
    await inPage(pageKey, 'Escape');
    await wait(150);

    // what floats over the page: a menu, a hover note and the line at the bottom
    await inPage(() => {
      window.deskMenu = popMenu(820, 250, [{ heading: 'This chat' }, { label: 'Rename', icon: 'pencil', run() {} }, { label: 'Open its folder', icon: 'folder', run() {} },
        { label: 'Copy the session id', icon: 'copy', run() {} }, null, { label: 'Close this chat', icon: 'x', key: 'Ctrl Shift W', danger: true, run() {} }]);
      const tip = document.getElementById('tip');
      tip.textContent = '86% of the 5-hour limit is used, as Claude Code last reported it (15:39).\nIt resets 18:04.\nLately it grows by about 9.5% an hour.\nClaude Code is told this with each reply. Nothing here asks Anthropic.';
      tip.hidden = false;
      tip.style.transform = 'translate(470px, 330px)';
      toast('Now on studio@example.com. When last seen: 5-hour at least 86%, week at least 41%.', 9000);
      return true;
    });
    await shoot('0-floating', true);
    await inPage(() => { window.deskMenu(); document.getElementById('tip').hidden = true; return true; });

    // ---- a narrower and a wider window; the sidebar folded away ----
    const [wide0, tall0] = win.getContentSize();
    const sideWide = await exec('Math.round(document.getElementById("side").getBoundingClientRect().width)');
    win.setContentSize(980, 700);
    await wait(350);
    const slim = await inPage(pageList);
    const slimStart = await inPage(pagePeek);
    await pick('s-agents');
    await wait(250);
    const slimPane = await inPage(() => { const b = document.querySelector('#peek .d-body');
      return { side: Math.round(document.getElementById('side').getBoundingClientRect().width), pane: document.querySelector('#peek .detail').clientWidth, stage: document.getElementById('main').clientWidth,
        spill: document.documentElement.scrollWidth > document.documentElement.clientWidth || b.scrollWidth > b.clientWidth + 1, at: b.scrollTop, more: b.scrollHeight - b.clientHeight }; });
    await shoot('0-narrow-session');
    await inPage(pageKey, 'Escape');
    win.setContentSize(1760, 1000);
    await wait(350);
    const broad = await inPage(pageList);
    const broadSpill = await inPage(pageSpill, 'peek');
    const broadSize = win.getContentSize();
    // In a wide window the page of a chat is wider than the column its text stands in. Its bar, its title, its
    // tabs and what is under them must then start on the same line, whichever tab is open, and end on one too.
    win.setContentSize(1920, 1040);
    await wait(350);
    await pick('s-agents');
    await wait(300);
    const edges = () => inPage(() => {
      const pane = document.querySelector('#peek .detail');
      const box = (sel) => { const el = pane.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
      const left = (sel) => { const b = box(sel); return b ? Math.round(b.left) : null; };
      const body = pane.querySelector('.d-body');
      // the column that holds what is open: the overview, the conversation, or the list of changed files. Its text starts after its padding.
      const inside = body.querySelector('.d-wrap, .rd-list, .changes');
      const col = inside.getBoundingClientRect();
      const pad = getComputedStyle(inside);
      const bar = body.querySelector('.rd-bar > *');
      const edge = pane.getBoundingClientRect();
      return { pane: Math.round(edge.width), from: Math.round(edge.left), state: left('.d-state'), title: left('.d-title'), facts: left('.d-facts'), tabs: left('.d-tabs .seg'),
        body: Math.round(col.left + parseFloat(pad.paddingLeft)), right: Math.round(col.right - parseFloat(pad.paddingRight)), reader: bar ? Math.round(bar.getBoundingClientRect().left) : null,
        acts: Math.round(box('.d-acts').right), spill: body.scrollWidth > body.clientWidth + 1 };
    });
    const lined = { overview: await edges() };
    await shoot('0-wide-session');
    await tabOf('peek', 'conv');
    await until(() => exec('Desk.Peek.detail().reader.state() === "ready"'), 5000);
    await wait(250);
    lined.conv = await edges();
    await tabOf('peek', 'changes');
    await wait(250);
    lined.changes = await edges();
    await tabOf('peek', 'overview');
    await inPage(pageKey, 'Escape');
    const inLine = (e) => e.state === e.title && e.title === e.facts && e.facts === e.tabs && e.tabs === e.body && (e.reader === null || e.reader === e.body) && !e.spill;
    const wideSize = win.getContentSize();
    check('in a wide window the bar, the title and the tabs of a chat that is looked at stand in line with what is under them, on every tab',
      // only a page wider than its column (880 px) puts this to the test: on a small screen the window cannot be made that wide
      lined.overview.pane > 1000 && lined.overview.body - lined.overview.from > 60
      && inLine(lined.overview) && inLine(lined.conv) && inLine(lined.changes) && lined.overview.body === lined.conv.body && lined.conv.body === lined.changes.body
      // the buttons at the right end of the bar reach past the column by the room an icon button keeps around its drawing
      && lined.overview.acts - lined.overview.right === 14,
      `window ${wideSize.join(' x ')}, a page of ${lined.overview.pane} px: the bar, the title, the facts, the tabs and the text start ${lined.overview.body - lined.overview.from} px in on the overview `
      + `(${[lined.overview.state, lined.overview.title, lined.overview.facts, lined.overview.tabs, lined.overview.body].join(', ')}), ${lined.conv.body - lined.conv.from} px in on the conversation `
      + `(${[lined.conv.state, lined.conv.tabs, lined.conv.reader, lined.conv.body].join(', ')}), ${lined.changes.body - lined.changes.from} px in on the changes; the bar's buttons end ${lined.overview.acts - lined.overview.right} px past the column`);
    win.setContentSize(wide0, tall0);
    await wait(350);
    check('in a narrow window the list on the left keeps its width, and a chat that is looked at takes the whole panel',
      !slim.overflow && slimStart.start === START && slimPane.side === sideWide && slimPane.pane > 600 && Math.abs(slimPane.pane - slimPane.stage) <= 2 && !slimPane.spill && !broad.overflow && !broadSpill,
      `980 x 700: the list keeps its ${slimPane.side} px, the chat looked at takes ${slimPane.pane} px of a ${slimPane.stage} px panel; nothing spills at ${broadSize.join(' x ')} either`);
    check('a chat that is looked at opens at the top of its overview, however long its conversation is', slimPane.at === 0 && slimPane.more > 0,
      `${slimPane.more} px of it are below the fold, and it stands at ${slimPane.at}`);
    await exec('document.getElementById("side-toggle").click()');
    await wait(200);
    const folded = await inPage(() => ({ off: document.body.classList.contains('no-side'), side: document.getElementById('side').getClientRects().length, stage: document.getElementById('main').clientWidth, window: window.innerWidth }));
    await exec('document.getElementById("side-toggle").click()');
    await wait(200);
    check('the sidebar folds away and comes back', folded.off && folded.side === 0 && folded.stage > folded.window - 24 && !(await exec('document.body.classList.contains("no-side")')),
      `folded: the panel is ${folded.stage} px of a ${folded.window} px window`);

    // ---- the list: a group folded, its menu, the pill in the title bar ----
    const groupAt = (name) => `#chat-list section.group[data-group="${name}"]`;
    await exec(`document.querySelector('${groupAt('working')} .group-head').click()`);
    await wait(150);
    const shut = await inPage((sel) => { const g = document.querySelector(sel);
      return { folded: g.classList.contains('folded'), tall: g.querySelector('.group-rows').clientHeight, count: g.querySelector('.g-n').textContent, total: document.getElementById('side-n').textContent }; }, groupAt('working'));
    await exec(`document.querySelector('${groupAt('working')} .group-head').click()`);
    await wait(150);
    check('a group of the list folds away and keeps its count', shut.folded && shut.tall === 0 && shut.count === '4' && shut.total === '9'
      && !(await exec(`document.querySelector('${groupAt('working')}').classList.contains('folded')`)), `folded: ${shut.tall} px tall, still says ${shut.count}; the list still counts ${shut.total}`);
    await exec('document.getElementById("side-more").click()');
    await wait(100);
    const listMenu = await exec(`[...document.querySelectorAll('#menu .menu-item')].map((b) => b.querySelector('span:not(.icon-gap)').textContent)`);
    await inPage(pageKey, 'Escape', '#menu');
    await wait(100);
    check('the menu above the list starts a chat, brings the chats of other terminals here, or makes a workspace', same(listMenu, ['New chat', 'Bring the 7 in other terminals here', 'New workspace…'])
      && (await exec('document.getElementById("menu").hidden')) === true, listMenu.join(' / '));

    // "N need you" in the title bar leads to the chat that has waited longest
    await exec('document.getElementById("triage").click()');
    await wait(250);
    list = await inPage(pageList);
    pane = await inPage(pageDetail, 'peek');
    check('"need you" in the title bar leads to the chat that has waited longest', list.view === 'peek' && list.sel === 'job:abc12345' && list.picked === 1 && pane.button === 'Open here'
      && pane.notice === 'Blocked until you answer' && same(pane.chips, ['background']), `${list.sel}: "${pane.notice}", button "${pane.button}"`);
    await exec('Desk.look(null)');

    // a chat that runs in another terminal: asked to come here, it is picked up the moment it ends over there
    const ghost = row({ key: 'ghost-1', session: '11111111-2222-4333-8444-555555555555', title: 'Chat in another terminal', cwd: 'Z:\\nowhere\\ghost', pid: 4242 });
    await exec(`takeSnapshot(${fake(now + 2, [ghost])})`);
    await pick('ghost-1');
    await wait(250);
    const offer = (await inPage(pageDetail, 'peek')).button;
    await exec(`document.querySelector('#peek .d-acts .btn').click()`);
    await wait(200);
    const armed = await inPage(() => {
      const item = [...document.querySelectorAll('#chat-list .nav-item.chat')].find((el) => el.dataset.key === 'ghost-1');
      const btn = document.querySelector('#peek .d-acts .btn');
      return { armed: Desk.state.armed.size, button: btn.textContent, cls: btn.className,
        notice: (document.querySelector('#notes > .callout:nth-child(2):not([hidden]) .callout-title') || {}).textContent || '',
        coming: Boolean(item && item.querySelector('.out.coming')), where: item ? item.dataset.tip.split('\n\n')[0].split('\n')[3] || '' : '' };
    });
    await shoot('0-bring-here');
    const gone = { id: ghost.session, name: '', named: false, title: ghost.title, cwd: ghost.cwd, mode: '', at: now, words: 'Last words before it was closed.', prompt: '', chat: '', cut: false };
    await exec(`takeSnapshot(${fake(now + 3, [], [gone])})`);
    // its folder does not exist, so the app refuses before any program is started: the whole chain ran, and nothing was launched
    const refused = await until(async () => { const t = await exec('document.getElementById("toast").textContent'); return /could not be opened here/.test(t) ? t : ''; }, 4000);
    check('a chat asked to come here is marked as on its way, the window says so above every view, and it is picked up when it ends in its own terminal',
      offer === 'Bring here' && armed.armed === 1 && armed.button === 'Waiting…' && /armed/.test(armed.cls)
      && armed.notice === '1 chat will open here as soon as you close it over there' && armed.coming && armed.where === 'It opens here as soon as you close it where it runs now.'
      && Boolean(refused) && chats.all.size === 0 && (await exec('Desk.state.armed.size')) === 0,
      `button "${offer}" then "${armed.button}", notice "${armed.notice}"; when it ended: "${refused}" (made-up folder, so nothing was started)`);
    await wait(200);
    list = await inPage(pageList);
    // the conversations that ended wait in a group of their own, folded until it is asked for
    const endedShut = await exec(`document.querySelector('${groupAt('ended')}').classList.contains('folded')`);
    await exec(`document.querySelector('#chat-list .nav-item.chat.k-ended').click()`);
    await wait(250);
    pane = await inPage(pageDetail, 'peek');
    await exec(`document.querySelector('#peek .d-acts .icon-btn[title="More"]').click()`);
    await wait(100);
    const menu = await exec(`[...document.querySelectorAll('#menu .menu-item')].map((b) => b.textContent)`);
    await exec(`[...document.querySelectorAll('#menu .menu-item')].find((b) => b.textContent === 'Take it off this list').click()`);
    await wait(200);
    const off = { list: await inPage(pageList), peek: await inPage(pagePeek) };
    check('a conversation that ended is listed with a way to pick it up again, and can be taken off the list',
      list.ended === 1 && list.groups.ended === 1 && endedShut && pane.words === 'Ended' && pane.button === 'Resume here' && same(pane.heads, ['Its last words', 'About']) && menu.length === 6
      && off.list.ended === 0 && !off.peek.pane && off.peek.start === START, `${list.ended} listed, its group folded at first: ${endedShut}; its page: "${pane.words}", "${pane.button}"; its menu: ${menu.join(' / ')}`);

    // ---- History: every conversation kept on this machine ----
    await exec('document.getElementById("toast").hidden = true');
    await exec(`takeSnapshot(${fake(now + 4, madeUpRows(true))})`);
    await exec('document.getElementById("go-history").click()');
    await until(() => exec('Desk.History.counts() === 8'), 4000);
    await wait(250);
    const history = () => inPage(() => {
      const root = document.getElementById('history');
      const groups = {};
      for (const g of root.querySelectorAll('section.group')) groups[g.dataset.group] = g.querySelectorAll('.row').length;
      return { view: Desk.state.view, rows: root.querySelectorAll('.row').length, groups, total: root.querySelector('.list-n').textContent,
        sel: Desk.History.selected(), picked: root.querySelectorAll('.row.sel').length, live: root.querySelectorAll('.row.live').length, marks: root.querySelectorAll('.row .glyph').length,
        blank: root.querySelector('.blank').hidden ? '' : root.querySelector('.blank h2').textContent, first: root.querySelector('.row .row-say').textContent,
        names: [...root.querySelectorAll('.row .row-name')].map((x) => x.textContent),
        by: [...root.querySelectorAll('.list-top .seg button')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')),
        spill: document.documentElement.scrollWidth > document.documentElement.clientWidth || [...root.querySelectorAll('.split, .list-scroll, .d-body, .d-wrap')].some((el) => el.scrollWidth > el.clientWidth + 1) };
    });
    let hist = await history();
    pane = await inPage(pageDetail, 'history');
    check('History lists every conversation kept on this machine, newest first, and opens on the latest one',
      hist.view === 'history' && hist.rows === 8 && hist.total === '8' && Object.values(hist.groups).reduce((a, b) => a + b, 0) === 8 && Object.keys(hist.groups).length >= 4 && same(hist.by, ['By date*', 'By project'])
      && hist.sel === 'past-0' && hist.picked === 1 && hist.live === 2 && hist.marks === 2 && hist.first === 'shop · Opus 5.5 · 388k out · 6.5 MB'
      && hist.names[5] === 'Why does the login test fail one run in five? Look at the retries first.' && !hist.spill,
      `${hist.rows} conversations in ${JSON.stringify(hist.groups)}; ${hist.live} of them running; the first: ${hist.first}`);
    check('a past conversation shows what it came to, and offers to be picked up again',
      pane.shown && pane.title === 'Empty tax field breaks the export' && pane.words === 'Not running' && pane.mark === 'ended' && pane.button === 'Resume here' && same(pane.tabs, ['Overview*', 'Conversation', 'Changes3'])
      && same(pane.heads, ['You last asked', 'About']) && same(pane.facts, ['388k out', '512 replies', '730 tool calls', '6.5 MB on disk']),
      `"${pane.title}" · ${pane.words} · ${pane.tabs.join(', ')} · ${pane.facts.join(' · ')}`);
    await shoot('0-history');
    await tabOf('history', 'conv');
    await wait(250);
    const old = await inPage(pageReader, 'history');
    check('a past conversation can be read from its first line to its last', old.asks === 3 && old.says === 5 && old.tools === 9 && old.running === 0 && old.turns === 3 && old.top === 'This is where the conversation begins.',
      `${old.asks} asked, ${old.says} said, ${old.tools} tool calls, ${old.turns} turn ends; "${old.top}"`);
    await shoot('0-history-reading');
    await tabOf('history', 'overview');
    await exec(`document.querySelector('#history .list-top .seg button[data-by="project"]').click()`);
    await wait(150);
    const grouped = await history();
    await exec(`document.querySelector('#history .list-top .seg button[data-by="date"]').click()`);
    await typeInto('#history .filter-box input', 'quarterly');
    await wait(100);
    const one = await history();
    await typeInto('#history .filter-box input', '');
    await exec(`document.querySelector('#history .row[data-id="s-agents"]').click()`);
    await wait(250);
    const running = await inPage(pageDetail, 'history');
    await inPage(pageKey, 'Escape');
    await wait(150);
    hist = await history();
    check('History groups by project, finds a conversation by a word, shows a running one as it is now, and Esc goes back to the list',
      same(grouped.groups, { 'p:shop': 3, 'p:pricing': 1, 'p:landing': 1, 'p:reports': 1, 'p:api': 2 }) && one.rows === 1 && one.names[0] === 'Quarterly numbers'
      && running.title === 'Pricing research' && running.mark === 'working' && running.button === 'Bring here' && running.tabs.includes('Subagents3')
      && hist.sel === '' && hist.blank === '8 conversations on this machine' && hist.rows === 8,
      `by project: ${JSON.stringify(grouped.groups)}; "quarterly" finds ${one.rows}; the running one: ${running.words}; nothing picked: "${hist.blank}"`);
    // picking a past conversation up again: its folder does not exist, so the app refuses before any program is started
    await exec(`document.querySelector('#history .row[data-id="past-0"]').click()`);
    await wait(200);
    await exec(`document.querySelector('#history .d-acts .btn').click()`);
    const refused2 = await until(async () => { const t = await exec('document.getElementById("toast").textContent'); return /^Empty tax field breaks the export could not be opened here/.test(t) ? t : ''; }, 4000);
    check('"Resume here" on a past conversation asks for it to be opened in this window', Boolean(refused2) && chats.all.size === 0, `"${refused2}" (made-up folder, so nothing was started)`);
    await exec('document.getElementById("toast").hidden = true');

    // ---- the Dashboard: every number of the app lives here ----
    await exec('document.getElementById("go-stats").click()');
    await wait(300);
    const usageView = () => inPage(() => {
      const root = document.getElementById('stats');
      const all = (sel) => [...root.querySelectorAll(sel)];
      const text = (sel) => (root.querySelector(sel) || {}).textContent || '';
      return {
        figs: all('.kpis.eight .kpi > b').map((b) => b.textContent), bars: all('.bar-slot').length, panels: all('.sec.block').length,
        lines: all('.table:not(.accts) .tr:not(.th)').length, limits: all('.list-lines .line').length,
        accts: all('.acct-tr').map((r) => (r.classList.contains('here') ? '*' : '') + r.querySelector('.acct-name b').textContent),
        shares: all('.acct-tr .acct-share > span:not(.share)').map((x) => x.textContent),
        cells: all('.acct-tr .lim-cell').map((x) => `${x.className.replace('lim-cell', '').trim()}:${x.querySelector('.r').textContent}`),
        // where the limits of the account in use are heading, and which other account has the most room
        going: all('.acct-tr .lim-cell .go').map((x) => x.textContent), ticks: all('.acct-tr .track u').length,
        room: all('.acct-tr').filter((r) => [...r.querySelectorAll('.chip')].some((c) => c.textContent === 'most room')).map((r) => r.querySelector('.acct-name b').textContent),
        ribbon: all('.ribbon i').length, lanes: all('.lanes .lane:not(.axis)').length, lit: all('.lanes .cells i.on').length,
        stacks: all('.bar-slot i.stack').length, legend: all('.legend > span').length, buttons: all('.table .tr .btn').map((b) => b.textContent),
        note: (all('.sec.block:not(.run-sec):not(.feed-sec) > p.quiet')[0] || {}).textContent || '', foot: text('.foot-note'),
        range: all('.page-head .seg button').map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')),
        title: text('.page-head .d-title'), first: all('.sec.block').slice(0, 2).map((x) => x.className),
        run: { title: text('.run-sec .sec-head h3'), note: text('.run-sec .sec-head .note'),
          rows: all('.run-sec .run-row[role="button"]').map((r) => `${r.querySelector('.name').textContent} ${r.querySelector('.res-mem').textContent}`), rest: all('.run-sec .run-row.rest').length,
          servers: text('.run-sec .run-servers'), app: text('.run-sec .run-app') },
        feed: { title: text('.feed-sec .sec-head h3'), rows: all('.feed-sec .feed-row').length, running: all('.feed-sec .feed-row.running').length, cost: text('.feed-sec .cost-line') },
        overflow: root.scrollWidth > root.clientWidth + 1 || document.documentElement.scrollWidth > document.documentElement.clientWidth || root.querySelector('.d-wrap').scrollWidth > root.querySelector('.d-wrap').clientWidth + 1,
      };
    });
    let usage = await usageView();
    check('the Dashboard draws days, hours, projects, models, chats, tools and limits', usage.title === 'Dashboard' && usage.figs.length === 8 && usage.bars === 78 && usage.panels === 14 && usage.lines === 25
      && usage.limits === 2 && same(usage.range, ['Today*', '7 days', '30 days']) && !usage.overflow && /^Counted from the 1,756 conversation files \(14\.8 GB\)/.test(usage.foot),
      JSON.stringify({ title: usage.title, figs: usage.figs.join(' | '), bars: usage.bars, panels: usage.panels, lines: usage.lines, limits: usage.limits, overflow: usage.overflow }));
    check('the Dashboard opens with what is running now: every session by the RAM it holds, the servers that are up, and this app itself',
      /run-sec/.test(usage.first[0] || '') && usage.run.title === 'On this computer' && usage.run.note === '3.9 GB of 64 GB RAM · 25% CPU · 38 programs in 8 sessions'
      && same(usage.run.rows, ['Pricing research 1.2 GB', 'Long refactor 860 MB', 'Checkout page rebuild 514 MB', 'Invoice export bug 444 MB', 'Nightly report 323 MB', 'Landing page copy 276 MB', 'api 188 MB', 'Old notes 153 MB'])
      && usage.run.rest === 0 && usage.run.servers === 'Server up:5173vite · Pricing research' && usage.run.app === 'Perch Desk itself holds 540 MB of RAM and uses 1% of the processor.',
      `"${usage.run.note}"; ${usage.run.rows.join(', ')}; "${usage.run.servers}"`);
    check('then what every session and subagent is doing right now, call by call, and what the open chats have used so far',
      /feed-sec/.test(usage.first[1] || '') && usage.feed.title === 'Happening now' && usage.feed.rows === 9 && usage.feed.running === 4
      && /^The chats open now have used \$\d+ at list prices so far\.$/.test(usage.feed.cost), `${usage.feed.rows} calls, ${usage.feed.running} still running; "${usage.feed.cost}"`);
    check('the Dashboard goes on with every account: its limits and where they are heading, what was done under it, who was logged in when, and today chat by chat',
      same(usage.accts, ['*studio@example.com', 'personal@example.com', 'client-work@example.com', 'Account dddd4444']) && same(usage.shares, ['80%', '20%', '', ''])
      && usage.cells.length === 8 && /^warm:86% · resets in 2h \d\dm$/.test(usage.cells[0]) && /^:41% · resets in 3d \dh$/.test(usage.cells[1]) && /^hot:≥ 97% · resets \d\d:\d\d$/.test(usage.cells[2])
      && /^:≥ 64% · resets \w+ \d\d:\d\d$/.test(usage.cells[3]) && /^fresh:fresh since \w+ \d\d:\d\d$/.test(usage.cells[4]) && /^:≥ 22% · resets \w+ \d\d:\d\d$/.test(usage.cells[5])
      && usage.cells[6] === 'none:no reading yet' && usage.cells[7] === 'none:no reading yet'
      && usage.going.length === 2 && /^at this pace full at \d\d:\d\d, \d+m early$/.test(usage.going[0]) && /^at this pace \d+% by the reset$/.test(usage.going[1]) && usage.ticks === 2
      && same(usage.room, ['client-work@example.com'])
      && usage.ribbon >= 6 && usage.lanes === 6 && usage.lit > 20 && usage.stacks === 30 && usage.legend === 5 && same(usage.buttons, ['Show', 'Show', 'Show', 'Read', 'Read', 'Read']),
      `${usage.accts.join(', ')}; shares ${usage.shares.filter(Boolean).join(', ')}; limits: ${usage.cells.join(' | ')}; heading: ${usage.going.join(' | ')}; most room: ${usage.room.join(', ')}; ${usage.ribbon} stretches in the band; ${usage.lanes} chats with ${usage.lit} lit hours; ${usage.stacks} day bars in the accounts' shades, ${usage.legend} in the key`);
    // a click on one of the sessions that are running shows it, and Esc leads back to the Dashboard
    await exec(`document.querySelector('#stats .run-row[data-key="s-compact"]').click()`);
    await wait(200);
    const viaRun = await inPage(pageList);
    await inPage(pageKey, 'Escape');
    await wait(150);
    const backOn = await exec('Desk.state.view');
    check('a click on a session there shows it, and Esc leads back to the Dashboard', viaRun.view === 'peek' && viaRun.sel === 's-compact' && viaRun.picked === 1 && backOn === 'stats' && (await exec('Desk.state.sel')) === null,
      `looked at ${viaRun.sel}; Esc led back to "${backOn}"`);
    await shoot('0-dashboard');
    await exec('document.querySelector("#stats .lanes").scrollIntoView({ block: "center" })');
    await shoot('0-dashboard-mid');
    await exec('document.getElementById("stats").scrollTop = 100000');
    await shoot('0-dashboard-2');
    await exec('document.getElementById("stats").scrollTop = 0');
    const dayOut = usage.figs[0];
    await exec('[...document.querySelectorAll("#stats .page-head .seg button")].find((b) => b.textContent === "30 days").click()');
    await showUsage('30d');
    await wait(150);
    usage = await usageView();
    check('switching the Dashboard to 30 days adds up the month, and says what part of it cannot be tied to an account', usage.figs.length === 8 && usage.figs[0] !== dayOut && (await exec('Desk.state.range')) === '30d'
      && /^\d+% of the tokens written in the last 30 days cannot be tied to an account/.test(usage.note), `tokens out: ${dayOut} today, ${usage.figs[0]} in 30 days; "${usage.note}"`);
    await shoot('0-dashboard-30d');
    await exec('[...document.querySelectorAll("#stats .page-head .seg button")].find((b) => b.textContent === "Today").click()');
    await showUsage('today');
    await wait(150);
    // from the busiest chats: a past one opens in History to be read, a running one is shown in the panel
    await exec(`[...document.querySelectorAll('#stats .table .tr .btn')].find((b) => b.textContent === 'Read').click()`);
    await wait(300);
    const led = await inPage(() => ({ view: Desk.state.view, sel: Desk.History.selected(), title: (document.querySelector('#history .d-title') || {}).textContent || '' }));
    await exec('Desk.setView("stats")');
    await wait(150);
    await exec(`[...document.querySelectorAll('#stats .table .tr .btn')].find((b) => b.textContent === 'Show').click()`);
    await wait(300);
    list = await inPage(pageList);
    pane = await inPage(pageDetail, 'peek');
    check('from the busiest chats, a past one opens in History to be read and a running one is shown in the panel',
      led.view === 'history' && led.sel === 'past-1' && led.title === 'Move the blog to the new layout' && list.view === 'peek' && list.sel === 's-agents' && pane.shown && pane.title === 'Pricing research',
      `History on "${led.title}"; then looking at ${list.sel}`);
    // away from the Dashboard, so that the search box below is the one that leads back to it
    await exec('Desk.look(null); Desk.setView("peek")');

    // ---- the search box: a few letters find a command, Enter runs it ----
    await exec('Palette.open()');
    await wait(400);
    const pal = await inPage(() => ({ open: !document.getElementById('palette').hidden, items: document.querySelectorAll('#palette .pal-item').length, groups: [...document.querySelectorAll('#palette .pal-group')].map((g) => g.textContent),
      marks: document.querySelectorAll('#palette .pal-item .glyph').length }));
    await shoot('0-search');
    // the page that was called Usage is still found by that word
    await typeInto('#palette input', 'usage');
    const oldWord = await exec(`[...document.querySelectorAll('#palette .pal-item .label')].map((l) => l.textContent)`);
    await typeInto('#palette input', 'dash');
    const hits = await exec(`[...document.querySelectorAll('#palette .pal-item .label')].map((l) => l.textContent)`);
    await inPage(pageKey, 'Enter', '#palette');
    await wait(150);
    const ran = await exec('Desk.state.view');
    await exec('Palette.open()');
    await typeInto('#palette input', 'hist');
    const hits2 = await exec(`[...document.querySelectorAll('#palette .pal-item .label')].map((l) => l.textContent)`);
    await inPage(pageKey, 'Enter', '#palette');
    await wait(150);
    check('the search box lists chats and commands, finds one by a few letters and runs it', pal.open && pal.items >= 15 && pal.marks === 9 && pal.groups.includes('In other terminals') && pal.groups.includes('Do')
      && new Set(pal.groups).size === pal.groups.length && hits.length >= 1 && /^Dashboard/.test(hits[0]) && oldWord.some((l) => /^Dashboard/.test(l)) && ran === 'stats' && /^History/.test(hits2[0]) && (await exec('Desk.state.view')) === 'history'
      && (await exec('document.getElementById("palette").hidden')) === true,
      // what is found can be a past conversation of his: only the command it should find is written down
      `${pal.items} entries in ${pal.groups.join(', ')}; "dash" finds ${hits.length}, first ${/^Dashboard/.test(hits[0] || '') ? `"${hits[0]}"` : 'something else'}; "usage" still finds it: ${oldWord.some((l) => /^Dashboard/.test(l))}; "hist" finds ${hits2.length}, first ${/^History/.test(hits2[0] || '') ? `"${hits2[0]}"` : 'something else'}`);
    await exec('Desk.setView("peek")');

    // everything ever typed into a prompt box can be searched. Only how many were found is kept: never the words, and no picture
    const typed = await exec(`desk.typed('the').then((list) => (!Array.isArray(list) ? { n: -1 } : { n: list.length, shape: list.length === 0 || ['text', 'at', 'cwd', 'session', 'live', 'there'].every((k) => k in list[0]) }))`);
    const tooShort = await exec(`desk.typed('th').then((list) => (Array.isArray(list) ? list.length : -1))`);
    await exec('Palette.open()');
    await typeInto('#palette input', 'the');
    const listed = await until(() => exec(`[...document.querySelectorAll('#palette .pal-item .from')].filter((x) => x.textContent === 'Things you typed').length`), 3000, 150);
    await exec('Palette.close()');
    check('the search box finds things typed into a prompt box, from three letters on', typed.n >= 0 && typed.shape && tooShort === 0 && (typed.n === 0 || listed === typed.n),
      `${typed.n} things typed hold "the"; ${listed || 0} of them listed in the box; two letters ask nothing (${tooShort})`);

    // ---- Settings: a switch flipped in the panel is written down ----
    await exec('Settings.open()');
    await wait(150);
    const settingsFile = path.join(app.getPath('userData'), 'desk.json');
    const saved = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
    const flip = (label) => inPage((text) => { const r = [...document.querySelectorAll('#settings .set-row')].find((x) => x.querySelector('.what > div').textContent === text);
      r.click(); return true; }, label);
    const switchOf = (label) => inPage((text) => { const r = [...document.querySelectorAll('#settings .set-row')].find((x) => x.querySelector('.what > div').textContent === text);
      return r.querySelector('.switch').classList.contains('on'); }, label);
    const panel = await inPage(() => ({ open: !document.getElementById('settings').hidden, switches: document.querySelectorAll('#settings .switch').length, keys: document.querySelectorAll('#settings .keys kbd').length,
      accounts: document.querySelectorAll('#settings .acct-row').length, on: document.querySelectorAll('#settings .switch.on').length }));
    await flip('When a chat in this window finishes its turn');
    const written = await until(async () => saved().notify && saved().notify.finished === true, 4000, 200);
    // the see-through window is on unless switched off, and the choice is kept for the next start
    const glassWas = await switchOf('See-through window');
    await flip('See-through window');
    const solid = await until(async () => saved().solid === true, 4000, 200);
    const glassOff = await switchOf('See-through window');
    await flip('See-through window');
    const glassBack = await until(async () => saved().solid !== true, 4000, 200);
    check('the see-through window is on unless it is switched off in Settings, and the choice is kept for the next start', glassWas && Boolean(solid) && !glassOff && Boolean(glassBack));
    // a name typed for an account is kept, and used wherever the account shows
    await inPage(() => { const i = document.querySelector('#settings .acct-row .name-input'); i.value = 'Main account'; i.dispatchEvent(new Event('blur')); return true; });
    const named = await until(async () => saved().accountNames && saved().accountNames.aaaa1111 === 'Main account', 4000, 200);
    const calledAs = await exec(`(document.querySelector('#acct .acct-name') || {}).textContent || ''`);
    check('an account can be given a name, which is kept and shown in its place', panel.accounts === 4 && Boolean(named) && calledAs === 'Main account', `${panel.accounts} accounts listed; the sidebar now says "${calledAs}"`);
    await shoot('0-settings');
    await exec('document.querySelector("#settings .set-body").scrollTop = 100000');
    await shoot('0-settings-2');
    check('Settings opens, and a switch flipped there is written down', panel.open && panel.switches === 8 && panel.keys >= 12 && panel.on >= 3 && Boolean(written), JSON.stringify(panel));
    await flip('When a chat in this window finishes its turn');
    await wait(300);
    await exec('Settings.close()');

    // the part that reads the files stopped for good: the window says so above every view, and offers to start it again
    win.webContents.send('desk:command', 'stale');
    const stopped = await until(() => exec('!document.querySelector("#notes > .callout:nth-child(1)").hidden'), 3000);
    const staleTitle = await exec('document.querySelector("#notes > .callout:nth-child(1) .callout-title").textContent');
    await exec('document.querySelector("#notes > .callout:nth-child(1) .btn").click()');
    check('when the list of chats stops updating, the window says so and offers to start it again', Boolean(stopped) && staleTitle === 'The list of chats stopped updating'
      && (await exec('document.querySelector("#notes > .callout:nth-child(1)").hidden')) === true, `"${staleTitle}"`);

    // a shortcut to the app, written into the test's own folder instead of the Start menu
    let link = null;
    try {
      const file = path.join(dir, 'Perch Desk test.lnk');
      writeLink(file, '--tray');
      link = require('electron').shell.readShortcutLink(file);
    } catch (err) {
      link = { error: String(err) };
    }
    check('a shortcut to the app is written the way the taskbar starts it', Boolean(link) && /wscript\.exe$/i.test(link.target || '') && /PerchDesk\.vbs/.test(link.args || '')
      && /--tray/.test(link.args || '') && link.appUserModelId === 'Perch.Desk', JSON.stringify(link));

    // what the watcher really answers when asked for the sums (nothing was counted in a test run: the shape is what is checked)
    const sums = await watch.ask('usage', { range: '7d' });
    check('the watcher answers with 30 days and 48 hours of sums', Boolean(sums) && sums.range === '7d' && sums.days.length === 30 && sums.hours.length === 48
      && typeof sums.total.out === 'number' && Array.isArray(sums.projects) && Array.isArray(sums.limits) && Array.isArray(sums.who) && Array.isArray(sums.lanes)
      && sums.days.every((d) => d.who && typeof d.who === 'object'), sums ? `${sums.reading.files} files known, counting ${sums.reading.counting}` : 'no answer');

    // A transcript's short count of today's lines is dropped once the full count reaches it. Asked again within
    // the minute, the plan must hand it to the full count: it once answered "the short count", which was gone,
    // and counting stood still for up to a minute. (Made-up records: no transcript is read here.)
    const plans = [{ early: null, today: 'early' }, { early: { dirty: true }, today: 'early' }, { early: null, today: 'none' }, { early: null, today: 'whole' }]
      .map((c) => Watch.prototype.todayPlan.call({}, { ...c, todayAt: Date.now() - 5000 }, Date.now(), 0));
    check("a conversation whose count of today's lines is over is handed on to the full count", same(plans, ['whole', 'early', 'none', 'whole']), plans.join(', '));

    // ---- chats that come back: what is written down about an open chat, what a start does with it, and how it is started again.
    // ---- The three deciders are asked with made-up chats: nothing is started, and no file is written.
    const SID = '11111111-2222-4333-8444-555555555555';
    const NEWER = 'aaaaaaaa-2222-4333-8444-555555555555';
    const chatOf = (over) => ({ id: 'c1', cwd: 'D:\\work\\shop', command: 'claude', starter: 'claude', title: '', named: false, job: '', holds: '', mode: '', left: false, ...over });
    const seenAs = (over) => ({ session: SID, title: 'Checkout page rebuild', name: '', turn: { start: 1, end: 2 }, mode: 'bypassPermissions', ...over });
    const base = { cwd: 'D:\\work\\shop', starter: 'claude', title: '', named: false, resume: '', mode: '', front: false };
    const keptAs = [
      // named by the person, its session seen, the chat in front
      [keptOf(chatOf({ title: 'My shop chat', named: true }), seenAs({}), true), { ...base, title: 'My shop chat', named: true, resume: SID, mode: 'bypassPermissions', front: true }],
      // nothing was asked in it yet: there is no conversation to pick up
      [keptOf(chatOf({}), seenAs({ turn: null }), false), { ...base, title: 'Checkout page rebuild' }],
      // opened a moment ago to pick a conversation up, its session not seen yet: it still holds that conversation and its mode
      [keptOf(chatOf({ holds: SID, mode: 'plan' }), undefined, false), { ...base, resume: SID, mode: 'plan' }],
      // its agent was left with /exit: a plain console is what is open
      [keptOf(chatOf({ left: true }), undefined, false), { ...base, starter: 'shell' }],
      // it has moved on to a newer conversation, in another mode: that one counts
      [keptOf(chatOf({ holds: SID, mode: 'plan' }), seenAs({ session: NEWER, mode: 'acceptEdits' }), false), { ...base, title: 'Checkout page rebuild', resume: NEWER, mode: 'acceptEdits' }],
    ];
    check('what is written down about an open chat: the name it was given, the conversation in it, the permission mode it was in, and whether it is in front',
      keptAs.every(([got, want]) => same(got, want)), keptAs.map(([got, want], i) => `${i + 1}: ${same(got, want) ? 'as expected' : JSON.stringify(got)}`).join('; '));
    const decided = [[0, true, 'ask'], [2, false, 'ask'], [2, false, 'never'], [2, true, 'ask'], [2, true, 'always'], [2, true, 'tray'], [2, true, 'never'], [2, 'windows', 'always'], [2, 'windows', 'never'], [2, undefined, 'ask']]
      .map(([open, running, keep]) => restoreMode(open, lastEnd(running), keep));
    check('what a start does with the chats of last time: they open after a proper close, after a crash and after a Windows shutdown, and are asked about only when the choice was to start fresh',
      same(decided, ['', 'auto', 'auto', 'crash', 'crash', 'crash', 'ask', 'auto', 'ask', 'auto']), decided.map((d) => d || '(nothing)').join(', '));
    const plans2 = {
      bypass: planChat({ starter: 'claude', resume: SID, mode: 'bypassPermissions' }),
      plan: planChat({ starter: 'claude', resume: SID, mode: 'plan' }),
      usual: planChat({ starter: 'claude', resume: SID, mode: 'default' }),
      odd: planChat({ starter: 'claude', resume: SID, mode: 'plan; calc' }),
      notOne: planChat({ starter: 'claude', resume: `${SID}; calc`, mode: 'plan' }),
      own: planChat({ resume: SID, mode: 'bypassPermissions' }),
      view: planChat({ attach: 'abc12345' }),
    };
    check('a conversation is picked up again in the permission mode it was in, and only fixed words ever reach the command line',
      plans2.bypass.command === `claude --resume ${SID} --dangerously-skip-permissions` && plans2.bypass.holds === SID && plans2.bypass.mode === 'bypassPermissions'
      && plans2.plan.command === `claude --resume ${SID} --permission-mode plan` && plans2.usual.command === `claude --resume ${SID}` && plans2.usual.mode === ''
      && plans2.odd.command === `claude --resume ${SID}` && plans2.odd.mode === '' && plans2.notOne.command === 'claude' && plans2.notOne.holds === ''
      // the person's own starter sets the mode itself: nothing is added to it
      && (plans2.own.plain ? plans2.own.command === `claude --resume ${SID} --dangerously-skip-permissions` : plans2.own.command.endsWith(` --resume ${SID}`) && !/--dangerously|--permission-mode/.test(plans2.own.command))
      && plans2.own.mode === 'bypassPermissions' && plans2.view.command === 'claude attach abc12345' && plans2.view.job === 'abc12345' && plans2.view.holds === '',
      `bypass: "${plans2.bypass.command.replace(SID, '<id>')}"; plan: "${plans2.plan.command.replace(SID, '<id>')}"; a mode not on the list: "${plans2.odd.command.replace(SID, '<id>')}"; `
      + `through ${plans2.own.plain ? 'the plain command' : 'his own starter, which sets the mode itself'}: "${plans2.own.command.replace(SID, '<id>')}"`);

    await sortingPart();

    // back to the real clock and the real picture of the machine, with nothing looked at and nothing held as it was
    await exec('Desk.state.unread.clear(); Desk.look(null); Desk.setView("peek"); Reader.fake = null; History.fake = null; Desk.state.frozen = false; Desk.state.usage = null; Desk.state.res = null');
    await inPage(pageClock, 0);
    await exec(`takeSnapshot(${JSON.stringify(real)})`);
    watch.post({ type: 'pace', ms: 2000 });
    await wait(300);
  };

  // ---- the chats on screen: what stands in each place, and the keys and presses that move between them ----
  const tilesNow = () => inPage(pageTiles);
  const stripOf = (id) => inPage(pageStrip, id);
  const press = (selector) => inPage(pagePress, selector);
  /** A key of the window, pressed with Ctrl (and Shift). held: Ctrl stays down after it. */
  const ctrl = (code, { shift = false, held = false } = {}) => inPage(pageCtrl, code, shift, !held);
  const tileOf = (id) => `#tiles .tile[data-id="${id}"]`;
  /** A press in a chat's place, which gives it the keyboard. */
  const giveKeyboard = async (id) => {
    await press(`${tileOf(id)} .tile-body`);
    return Boolean(await until(() => exec(`Terms.active() === ${JSON.stringify(id)}`), 3000, 50));
  };
  /** Asks the console that has the keyboard how wide it is; its answer is the line "<tag>=<columns>". */
  const askWidth = (tag) => type(`Write-Host ('${tag}=' + $Host.UI.RawUI.WindowSize.Width)\r`);
  const widthSeen = (id, tag, cols) => until(async () => (await linesOf(id)).some((l) => l.trim() === `${tag}=${cols}`), 6000);
  const colsOf = (id) => exec(`Terms.get(${JSON.stringify(id)}).term.cols`);
  /** Closes a chat the way the window does, and waits until its console is gone (a close holds back while a session on the machine is young). */
  const closeAndWait = async (id) => {
    const pid = chats.all.has(id) ? chats.all.get(id).pid : 0;
    await exec(`Desk.closeChat(${JSON.stringify(id)})`);
    return Boolean(await until(async () => !chats.all.has(id) && !(pid && alive(pid)), 20000, 100));
  };

  // ---- one console: the round trip ----
  const consolePhase = async () => {
    const started = Date.now();
    const a = await inPage(pageNew, plain);
    notes.chatA = a && a.id;
    if (!check('a chat opens in this window', Boolean(a && a.id), a && a.id ? a.id : `no chat: ${a && a.error ? a.error : 'no answer'}`)) throw new Error('no chat');
    agent.chat = a.id;
    const cols0 = await exec('term.cols');
    const rows0 = await exec('term.rows');
    say(`      widget size ${cols0} x ${rows0} cells; console engine: ${engine === 'bundled' ? "Windows Terminal's, shipped with the app" : 'the one built into Windows'}`);
    const alone = await tilesNow();
    const strip0 = await stripOf(a.id);
    check('the first chat takes the whole panel and holds the keyboard',
      alone.n === 1 && alone.tiles.length === 1 && alone.tiles[0].id === a.id && alone.tiles[0].on && alone.tiles[0].drawn && alone.keyboard === a.id && alone.parked === 0
      && (await exec('Desk.state.view')) === a.id && Boolean(strip0) && !strip0.marked,
      alone.tiles[0] ? `1 chat on screen, ${alone.tiles[0].w} x ${alone.tiles[0].h} px, ${alone.tiles[0].cols} x ${alone.tiles[0].rows} cells` : 'no chat on screen');

    check('PowerShell starts inside it', Boolean(await until(promptBack, 30000)), `${Date.now() - started} ms after the chat was asked for`);

    const mark = `desk-${BOX}-ok`;
    await type(`Write-Host ('desk-' + [char]0x2502 + '-ok') -ForegroundColor Green; $Host.UI.RawUI.WindowSize.Width\r`);
    const echoed = await until(async () => (await linesOf(a.id)).includes(mark), 8000);
    check('typed text reaches PowerShell and its answer comes back, box character intact', Boolean(echoed));
    // the width is the answer's second line and can arrive a moment after the first
    const sameWidth = await until(async () => (await linesOf(a.id)).some((l) => l.trim() === String(cols0)), 4000);
    check('PowerShell sees the same width as the widget', Boolean(sameWidth), `${cols0} columns`);
    const colour = await inPage(pageColourOf, mark);
    check('colour survives the trip', Boolean(colour && colour.palette && [2, 10].includes(colour.colour)), JSON.stringify(colour));

    // the strip above the terminal: which chat it is, and its two buttons. The chat can be renamed, also by hand:
    // a click on the name of the chat that has the keyboard turns the name into a field.
    const head = await stripOf(a.id);
    await exec(`desk.rename(${JSON.stringify(a.id)}, 'Renamed by the test')`);
    const renamed = await until(async () => (await inPage(pageSide))[0].label === 'Renamed by the test' && (await stripOf(a.id)).name === 'Renamed by the test', 4000);
    await press(`${tileOf(a.id)} .th-name`);
    const field = `${tileOf(a.id)} .th-rename`;
    const asField = await exec(`Boolean(document.querySelector(${JSON.stringify(field)}))`);
    await inPage((sel) => {
      const input = document.querySelector(sel);
      if (!input) return false;
      input.value = 'Typed by hand';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    }, field);
    const byHand = await until(async () => (await stripOf(a.id)).name === 'Typed by hand' && (await inPage(pageSide))[0].label === 'Typed by hand', 4000);
    await exec(`desk.rename(${JSON.stringify(a.id)}, '')`);
    await until(async () => (await stripOf(a.id)).name !== 'Typed by hand', 4000);
    check('the strip above the terminal names the chat, and the chat can be renamed, also with a click on its name', Boolean(head.name) && head.buttons === 2 && Boolean(renamed) && asField && Boolean(byHand),
      `"${head.name}", then "Renamed by the test", then typed into the strip: ${Boolean(byHand)}`);
    // A plain console has nothing else to say: its strip holds no figure, and its two buttons stand at the right
    // end, at this size and in a window as wide as a maximised one.
    const bare = await stripOf(a.id);
    const [bw, bh] = win.getContentSize();
    win.setContentSize(1920, 1040);
    await wait(500);
    const bareWide = await stripOf(a.id);
    win.setContentSize(bw, bh);
    await until(async () => (await exec('term.cols')) === cols0, 5000);
    await wait(300);
    check('above a plain console the strip holds its name and its two buttons, at its right end at any width, and not one figure',
      bare.figures === 0 && bare.doing === '' && bare.short === 0 && !bare.spill && bareWide.figures === 0 && bareWide.short === 0 && !bareWide.spill && bareWide.head > 1200,
      `a strip of ${bare.head} px: the buttons end ${bare.short} px from its edge; a strip of ${bareWide.head} px, as in a maximised window: ${bareWide.short} px; figures on it: ${bare.figures}`);

    // The same strip above a chat at work: a made-up session is tied to this chat, so there is something to say.
    // The panel beside the chat then shows its tool calls, its subagents and its conversation.
    const real = watch.latest();
    watch.post({ type: 'pace', ms: 600000 });
    await wait(700);
    madeAt = Date.now();
    await installFakes();
    await exec(`takeSnapshot(${fake(Date.now(), [busyRow({ chat: a.id, tokens: { in: 9000, out: 120000, cacheWrite: 800000, cacheRead: 9400000, tools: 88, share: 1 } })])})`);
    await exec('Desk.setInspector(true)');
    const narrower = await until(async () => { const c = await exec('term.cols'); return c < cols0 ? c : 0; }, 5000);
    await wait(300);
    const beside = await inPage(pageDetail, 'inspector');
    const strip = await stripOf(a.id);
    const inList = (await inPage(pageSide))[0];
    const tabsFit = await inPage(() => { const t = document.querySelector('#inspector .d-tabs'); return t.scrollWidth <= t.clientWidth; });
    check('the strip above a chat at work says which chat it is, what it is doing and how full its memory is, and nothing else',
      strip.name === 'Pricing research' && strip.doing === 'Agent · Compare competitor D' && /^\d+m \d\ds$/.test(strip.timer) && same(strip.facts, ['86% memory']) && strip.figures === 1
      && strip.buttons === 2 && strip.pressed && !strip.nameCut && strip.short === 0 && !strip.spill && inList.mark === 'working' && inList.sub === strip.doing,
      `"${strip.name}" · ${strip.doing} · ${strip.timer} · ${strip.facts.join(' · ')}; in a strip of ${strip.head} px what it is doing is ${strip.doingCut ? 'cut short' : 'said in full'}`);
    check('the panel beside a chat shows its tool calls, subagents and numbers, every tab of it in sight, and the terminal makes room',
      beside.shown && beside.tabs.length === 5 && beside.tabs[0] === 'Overview*' && beside.calls === 5 && beside.agents === 4 && Boolean(narrower) && tabsFit,
      `tabs: ${beside.tabs.join(', ')}; ${beside.calls} tool calls, ${beside.agents} subagents; ${cols0} -> ${narrower} columns`);

    // what the chat holds on this computer (made-up figures): the RAM at the end of its row in the list, the rest in the hover notes, and line by line in the panel
    const frozenWas = await exec('Desk.state.frozen');
    await exec(`Desk.state.frozen = true; Desk.state.res = ${JSON.stringify(madeUpRes(a.id))}; paint()`);
    await wait(200);
    const heldHere = await inPage((id) => {
      const item = document.querySelector('#chat-list .nav-item.chat[data-row^="chat:"]');
      const head = document.querySelector(`#tiles .tile[data-id="${id}"] .tile-head`);
      const tips = item.dataset.tip.split('\n\n');
      return { side: item.querySelector('.res').textContent, place: tips[0].split('\n').pop(), sideTip: tips[1] || '',
        tip: head.querySelector('.th-facts').dataset.tip || '', sameTip: head.querySelector('.th-doing').dataset.tip === head.querySelector('.th-facts').dataset.tip,
        figures: head.querySelectorAll('.fact').length,
        pane: [...document.querySelectorAll('#inspector .d-body .sec-head h4')].map((x) => x.textContent), lines: document.querySelectorAll('#inspector .res-row:not(.head)').length,
        spill: document.querySelector('#inspector .d-body').scrollWidth > document.querySelector('#inspector .d-body').clientWidth + 1 };
    }, a.id);
    const REST = new RegExp('^Agent · Compare competitor D\\nOpus 5\\.5 · effort max · never asks permission\\nMemory: 402k of about 467k tokens \\(86%\\) · compacted 2×\\n3 subagents working\\n2 messages waiting their turn\\n'
      + 'Today: 121k tokens out · 47m of work\\n\\$42 at list prices since its program started\\nCache warm until \\d\\d:\\d\\d\\nOn this computer: 1\\.3 GB of RAM · 14% of the processor · a server on :5173\\n'
      + 'It runs: vite · python · 3 subagents · 2 MCP servers$');
    check('a chat says what it holds on this computer at the end of its row in the list, and the note on that row lists what it runs',
      heldHere.side === '1.3 GB' && heldHere.place === 'Ctrl 1'
      && heldHere.sideTip === 'This chat holds 1.3 GB of RAM in 16 programs and uses 14% of the processor.\nA server is up on :5173\nRAM as Task Manager counts it.\nIt runs: vite · python · 3 subagents · 2 MCP servers'
      && heldHere.pane.includes('On this computer') && heldHere.lines === 6 && !heldHere.spill,
      `list "${heldHere.side}", its note ends in "${heldHere.place}"; the panel lists ${heldHere.lines} programs`);
    check('everything the strip leaves out is in its hover note: the model, the memory in tokens, the subagents, what was used today, the cost, the cache, the RAM',
      REST.test(heldHere.tip) && heldHere.sameTip && heldHere.figures === 1, `${heldHere.tip.split('\n').length} lines in the note; figures on the strip itself: ${heldHere.figures}`);

    // A wide window: the strip reaches the edge of the window, what the chat is doing is said in full, and a name
    // too long for the strip is cut later.
    const [w1, h1] = win.getContentSize();
    const colsNow = await exec('term.cols');
    const LONG = 'Rebuild the checkout page so the tax field is kept when the basket is edited twice';
    const named = async (title) => {
      await exec(`desk.rename(${JSON.stringify(a.id)}, ${JSON.stringify(title)})`);
      return until(async () => { const n = (await stripOf(a.id)).name; return title ? n === title : n !== LONG; }, 4000);
    };
    await named(LONG);
    const nameSmall = await stripOf(a.id);
    await named('');
    win.setContentSize(1920, 1040);
    await wait(500);
    const wideStrip = await stripOf(a.id);
    await shoot('1-chat-wide');
    await named(LONG);
    const nameWide = await stripOf(a.id);
    await named('');
    const wideNow = win.getContentSize();
    win.setContentSize(w1, h1);
    await until(async () => (await exec('term.cols')) === colsNow, 5000);
    check('in a wide window the strip above a chat reaches the edge, says what the chat is doing in full, and a long name is cut later',
      wideStrip.head > 1100 && wideStrip.short === 0 && !wideStrip.doingCut && !wideStrip.nameCut && !wideStrip.spill && nameSmall.nameCut && !nameSmall.spill && nameWide.nameWide >= nameSmall.nameWide + 100,
      `window ${wideNow.join(' x ')}, a strip of ${wideStrip.head} px: the buttons end ${wideStrip.short} px from its edge; `
      + `a name of ${LONG.length} letters gets ${nameSmall.nameWide} px in the window as it was and ${nameWide.nameWide} px in the wide one`);
    await wait(300);
    await shoot('1-chat-panel');
    // its conversation, read beside its terminal
    await tabOf('inspector', 'conv');
    await wait(300);
    const reading = await inPage(pageReader, 'inspector');
    const fits = await inPage(() => { const b = document.querySelector('#inspector .d-body'); return b.scrollWidth <= b.clientWidth + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth; });
    check('its conversation can be read in the panel beside its terminal', reading.asks === 1 && reading.says === 2 && reading.tools === 5 && reading.running === 2 && reading.thoughts === 1 && fits,
      `${reading.asks} asked, ${reading.says} said, ${reading.tools} tool calls (${reading.running} running); nothing spills sideways: ${fits}`);
    await shoot('1-chat-reading');
    await tabOf('inspector', 'overview');
    await exec('Desk.setInspector(false)');
    await until(async () => (await exec('term.cols')) === cols0, 5000);
    await exec(`Desk.state.res = null; Desk.state.frozen = ${JSON.stringify(Boolean(frozenWas))}; takeSnapshot(${JSON.stringify(real)}); Reader.fake = null; History.fake = null`);
    watch.post({ type: 'pace', ms: 2000 });

    // text size, from the Settings panel
    await exec('Settings.open()');
    const rows16 = await exec('term.rows');
    // two steps: at this screen's scaling one step can leave a letter the same whole number of pixels wide
    await exec('document.querySelectorAll("#settings .stepper .btn")[1].click()');
    await until(async () => (await exec('Terms.fontSize()')) === 17, 3000);
    await exec('document.querySelectorAll("#settings .stepper .btn")[1].click()');
    const larger = await until(async () => ((await exec('Terms.fontSize()')) === 18 && (await exec('term.cols')) < cols0 ? { cols: await exec('term.cols'), rows: await exec('term.rows') } : null), 5000);
    // the console itself must have been told
    await type('$Host.UI.RawUI.WindowSize.Width\r');
    const told = larger && await until(async () => (await linesOf(a.id)).some((l) => l.trim() === String(larger.cols)), 5000);
    await exec('document.querySelectorAll("#settings .stepper .btn")[0].click()');
    await until(async () => (await exec('Terms.fontSize()')) === 17, 3000);
    await exec('document.querySelectorAll("#settings .stepper .btn")[0].click()');
    const back = await until(async () => (await exec('Terms.fontSize()')) === 16 && (await exec('term.cols')) === cols0 && (await exec('term.rows')) === rows16, 5000);
    await exec('Settings.close()');
    check('a larger text size gives the console fewer columns and rows, and stepping back restores them', Boolean(larger) && larger.rows < rows16 && Boolean(told) && Boolean(back),
      `${cols0} x ${rows16} cells at 16 px, ${larger ? `${larger.cols} x ${larger.rows}` : '?'} at 18 px`);
    await wait(300);
    return { cols0 };
  };

  // The console decides where the next character goes by counting cells, and
  // so does the widget. Where the two count an emoji or a kaomoji differently,
  // everything after it on that line is drawn off by the difference.
  const widthsPhase = async () => {
    const script = path.join(dir, 'widths.ps1');
    fs.writeFileSync(script, [
      '$samples = [ordered]@{',
      ...Object.entries(SAMPLES).map(([name, points]) => `  '${name}' = @(${points.map((p) => '0x' + p.toString(16)).join(', ')})`),
      '}',
      'foreach ($name in $samples.Keys) {',
      '  $s = -join ($samples[$name] | ForEach-Object { [char]::ConvertFromUtf32($_) })',
      "  Write-Host -NoNewline ($s + '|')",
      '  $x = $Host.UI.RawUI.CursorPosition.X',
      "  Write-Host ''",
      '  "$t-$name=$x"',
      '}',
      '"$t-done"',
      '',
    ].join('\r\n'));

    await type('cls\r');
    await wait(400);
    await type(`$t = 'w'; Invoke-Expression (Get-Content -Raw -LiteralPath '${script}')\r`);
    const done = await until(async () => (await linesOf(agent.chat)).some((l) => l.trim() === 'w-done'), 20000);
    notes.widths = done ? await inPage(pageWidths, 'w') : {};
    await type('cls\r');
    await wait(400);

    const names = Object.keys(SAMPLES);
    const differ = names.filter((name) => !notes.widths[name] || notes.widths[name].widget !== notes.widths[name].console);
    // both counts include the one cell of the end mark
    for (const name of differ) {
      const got = notes.widths[name];
      say(`      ${name}: the console counts ${got ? got.console - 1 : '?'} cells, the widget draws ${got ? got.widget - 1 : '?'}`);
    }
    check('emoji and kaomoji take the same number of cells in the console and in the widget',
      differ.length === 0, differ.length ? `differs for: ${differ.join(', ')}` : `${names.length} samples`);
  };

  // ---- chats side by side: each in a place of its own, each console the size of its place ----
  const twoPhase = async ({ cols0 }) => {
    const a = agent.chat;
    const idsOf = (x) => x.tiles.map((t) => t.id);
    const level = (x, y) => Math.abs(x - y) <= 1;
    const marks = async (list) => Promise.all(list.map(async (id) => (await stripOf(id)).marked));
    const listNow = async () => (await inPage(pageSide)).map((s) => [s.id, s.shown, s.active]);

    // ---- two: a second chat opens beside the first, and takes the keyboard ----
    const made = await inPage(pageNew, plain);
    const b = made && made.id;
    if (!check('a second chat opens in this window', Boolean(b) && b !== a)) throw new Error('no second chat');
    check('PowerShell starts in the second chat', Boolean(await until(promptBack, 30000)));
    let t = await tilesNow();
    check('the two stand side by side, each in half of the panel, and the new one holds the keyboard',
      t.n === 2 && same(idsOf(t), [a, b]) && level(t.tiles[0].y, t.tiles[1].y) && level(t.tiles[0].w, t.tiles[1].w) && t.tiles[1].x > t.tiles[0].x && t.tiles.every((x) => x.drawn)
      && t.tiles[1].on && !t.tiles[0].on && t.keyboard === b && same(t.split, ['1', '2*', '4']) && same(t.order, [a, b]) && t.parked === 0,
      t.tiles.map((x) => `${x.w} x ${x.h} px at ${x.x}`).join(' and '));
    check('the chat that holds the keyboard is marked on its strip and in the list, where both show as on screen',
      same(await marks([a, b]), [false, true]) && same(await listNow(), [[a, true, false], [b, true, true]]));

    // each console is told the width of its own place
    const colsA = t.tiles[0].cols;
    const colsB = t.tiles[1].cols;
    const rowsB = t.tiles[1].rows;
    await askWidth('wb');
    const toldB = await widthSeen(b, 'wb', colsB);
    // a press in the other place gives it the keyboard; the places themselves stay as they are
    await inPage(() => { document.querySelectorAll('#tiles .tile').forEach((el, i) => { el.dataset.kept = `k${i}`; }); return true; });
    const moved = await giveKeyboard(a);
    await wait(150);
    t = await tilesNow();
    check('a press in the other chat gives it the keyboard, and neither chat moves', moved && t.keyboard === a && (await exec('Desk.state.view')) === a && same(idsOf(t), [a, b])
      && same(t.tiles.map((x) => x.kept), ['k0', 'k1']) && same(await marks([a, b]), [true, false]) && same(await listNow(), [[a, true, true], [b, true, false]]));
    await askWidth('wa');
    const toldA = await widthSeen(a, 'wa', colsA);
    check('each console has the width of its own place, about half of what one chat alone has',
      Boolean(toldA) && Boolean(toldB) && colsA < cols0 && colsA <= Math.ceil(cols0 / 2) && colsA >= Math.floor(cols0 / 2) - 4 && level(colsA, colsB),
      `${cols0} columns alone; side by side ${colsA} and ${colsB}`);

    await type(`Write-Host 'only-in-first'\r`);
    const inA = await until(async () => (await linesOf(a)).includes('only-in-first'), 8000);
    const inB = (await linesOf(b)).some((l) => l.includes('only-in-first'));
    check('what is typed goes to the chat that holds the keyboard, and to no other', Boolean(inA) && !inB);
    // the chat beside it keeps taking its console's output
    await exec(`desk.input(${JSON.stringify(b)}, ${JSON.stringify("Start-Sleep -Milliseconds 1200; Write-Host 'late-in-second'\r")})`);
    const late = await until(async () => (await linesOf(b)).includes('late-in-second'), 8000);
    check('a chat that does not hold the keyboard keeps receiving its output', Boolean(late) && (await exec('Terms.active()')) === a);
    // more lines than its place is tall, so there is something above the end to be scrolled back to
    await exec(`desk.input(${JSON.stringify(b)}, ${JSON.stringify('1..80 | ForEach-Object { "row $_" }\r')})`);
    await until(async () => (await linesOf(b)).includes('row 80'), 8000);

    // ---- one chat big, and back: Ctrl Shift Enter ----
    await ctrl('Enter', { shift: true });
    const whole1 = await until(async () => (await exec('term.cols')) === cols0, 5000);
    await askWidth('w1');
    const told1 = await widthSeen(a, 'w1', cols0);
    const mainSays = await until(async () => { const s = settingsNow(); return s.tiles === 1 && s.split === 2; }, 3000, 100);
    t = await tilesNow();
    check('Ctrl Shift Enter makes the chat that holds the keyboard big: it has the whole panel, its console is told, and the choice is kept',
      Boolean(whole1) && Boolean(told1) && t.n === 1 && same(idsOf(t), [a]) && t.keyboard === a && same(t.saved, [1, 2]) && Boolean(mainSays) && same(t.split, ['1*', '2', '4']) && t.parked === 1
      && same(t.order, [a, b]) && same(await marks([a]), [false]) && same(await listNow(), [[a, true, true], [b, false, false]]),
      `${t.tiles[0] ? t.tiles[0].cols : '?'} columns; the other chat waits off screen`);
    // off screen it still takes its output, and keeps the size it had: a resize of the window reaches only what is on screen
    await exec(`desk.input(${JSON.stringify(b)}, ${JSON.stringify("Write-Host 'while-away'\r")})`);
    const away = await until(async () => (await linesOf(b)).includes('while-away'), 8000);
    const [w0, h0] = win.getContentSize();
    win.setContentSize(1180, 720);
    const cols1 = await until(async () => { const c = await exec('term.cols'); return c !== cols0 ? c : 0; }, 5000);
    await wait(400);
    const keptB = await colsOf(b);
    await ctrl('Enter', { shift: true });
    const refit = await until(async () => { const c = await colsOf(b); return c !== colsB ? c : 0; }, 5000);
    await wait(300);
    t = await tilesNow();
    const backB = t.tiles[1] || {};
    check('a chat that is off screen keeps receiving its output and keeps the size it had', Boolean(away) && Boolean(cols1) && keptB === colsB, `${keptB} columns while the window went from ${w0} to 1180 px`);
    check('Ctrl Shift Enter again puts the chats side by side as they were, and the one that comes back is fitted to its place',
      t.n === 2 && same(idsOf(t), [a, b]) && t.keyboard === a && same(t.saved, [2, 2]) && Boolean(refit) && refit < colsB && backB.drawn && t.parked === 0,
      `back with ${refit} columns in a narrower window (it had ${colsB})`);
    check('and it stands at the end of what it holds', Boolean(backB.atEnd));
    const kbB = await giveKeyboard(b);
    await askWidth('w2');
    const told2 = refit && await widthSeen(b, 'w2', refit);
    check('its console was told its new width', kbB && Boolean(told2), `${refit} columns`);
    // It came back into a lower place than it left, and its console has printed since. A terminal that is still
    // laid out against its old height is thrown up by the difference at the first line printed, and stays there.
    const following = (await tilesNow()).tiles[1] || {};
    check('and it goes on following what its console prints', Boolean(following.atEnd) && following.rows < rowsB,
      `${following.rows} rows now, it left with ${rowsB}; at the end: ${Boolean(following.atEnd)}`);
    win.setContentSize(w0, h0);
    await until(async () => (await colsOf(a)) === colsA && (await colsOf(b)) === colsB, 5000);
    await wait(300);

    notes.memoryTwo = await report('with two plain chats open');
    // what would be brought back after a restart, and how many share the screen
    const kept = await until(async () => {
      try { const d = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'desk.json'), 'utf8')); return Array.isArray(d.open) && d.open.length === 2 && d.tiles === 2 ? d : null; } catch { return null; }
    }, 3000, 200);
    check('the open chats, and how many share the screen, are written down for next time', Boolean(kept) && kept.open.every((c) => c.cwd === folder) && kept.split === 2,
      kept ? `${kept.open.length} chats, ${kept.tiles} on screen` : 'not on disk');

    // ---- a third chat: it takes the place of the chat used longest ago, which waits in line ----
    await giveKeyboard(a);
    const third = await inPage(pageNew, plain);
    const c = third && third.id;
    if (!check('a third chat opens', Boolean(c))) throw new Error('no third chat');
    await until(promptBack, 30000);
    t = await tilesNow();
    check('with two places and three chats, the new one takes the place of the chat used longest ago, and the one used last stays where it is',
      t.n === 2 && same(idsOf(t), [a, c]) && t.keyboard === c && same(t.order, [a, c, b]) && t.parked === 1 && same(await listNow(), [[a, true, false], [b, false, false], [c, true, true]]),
      `on screen: ${idsOf(t).join(', ')}; in line: ${t.order.slice(2).join(', ')}`);

    // ---- four at once ----
    await press('#split button[data-n="4"]');
    await wait(400);
    t = await tilesNow();
    const three = t.tiles;
    check('asked for four, three chats share the screen: two above, the third across the foot',
      t.n === 3 && same(idsOf(t), [a, c, b]) && level(three[0].y, three[1].y) && three[2].y > three[0].y && level(three[2].x, three[0].x) && Math.abs(three[2].w - (three[0].w + three[1].w + 1)) <= 2
      && t.tiles.every((x) => x.drawn) && same(t.saved, [4, 4]) && same(t.split, ['1', '2', '4*']) && t.keyboard === c && t.parked === 0,
      three.map((x) => `${x.w} x ${x.h} px`).join(', '));
    const fourth = await inPage(pageNew, plain);
    const d = fourth && fourth.id;
    if (!check('a fourth chat opens', Boolean(d))) throw new Error('no fourth chat');
    await until(promptBack, 30000);
    await wait(300);
    t = await tilesNow();
    const four = t.tiles;
    check('four chats stand two above two, each drawn, each with room to work in',
      t.n === 4 && same(idsOf(t), [a, c, b, d]) && level(four[0].y, four[1].y) && level(four[2].y, four[3].y) && four[2].y > four[0].y && level(four[0].x, four[2].x) && level(four[1].x, four[3].x)
      && level(four[0].w, four[3].w) && level(four[0].h, four[3].h) && t.tiles.every((x) => x.drawn && x.rows >= 6 && x.cols >= 20) && t.keyboard === d && same(await marks([a, c, b, d]), [false, false, false, true]),
      four.map((x) => `${x.cols} x ${x.rows} cells`).join(', '));
    await askWidth('w4');
    check('the console of the fourth is told the width of its quarter', Boolean(await widthSeen(d, 'w4', four[3] ? four[3].cols : 0)), `${four[3] ? four[3].cols : '?'} columns`);
    notes.memoryFour = await report('with four plain chats on screen');
    await shoot('1-four');

    // ---- the keys: a chat by its place, back to the chat used before this one, and further back ----
    const walked = [];
    const step = async (code, how) => { await ctrl(code, how); await wait(120); walked.push(await exec('Terms.active()')); };
    await step('Digit1');
    await step('Digit3');
    await step('Tab');
    await step('Tab');
    // Ctrl kept down: a second Tab goes one chat further back
    await ctrl('Tab', { held: true });
    await step('Tab');
    await step('Tab', { shift: true });
    check('Ctrl 1 to 9 goes to a chat by its place; Ctrl Tab goes back to the chat used before this one, and with Ctrl kept down a step further each time',
      same(walked, [a, b, a, b, d, c]), `asked for: place 1, place 3, back, back, back twice, the other way; the keyboard went to ${walked.join(', ')}`);

    // ---- another page of the window and back: the chats come back as they were ----
    await view('stats');
    await wait(200);
    const gone = await tilesNow();
    await ctrl('Tab');
    await wait(300);
    t = await tilesNow();
    const linesB = await linesOf(b);
    check('on another page of the window no terminal is drawn; "back" leads to the chat used last, and all four are on screen again as they were',
      gone.n === 0 && gone.parked === 4 && t.n === 4 && same(idsOf(t), [a, c, b, d]) && t.keyboard === c && t.tiles.every((x) => x.drawn) && t.parked === 0
      && ['late-in-second', 'while-away', 'row 80'].every((l) => linesB.includes(l)),
      `away: ${gone.parked} terminals waiting off screen; back: ${t.n} on screen, the keyboard in ${t.keyboard}`);
    check('each of them stands at the end of what it holds', t.tiles.every((x) => x.atEnd), t.tiles.map((x) => `${x.id}: ${x.atEnd ? 'at the end' : 'scrolled up'}`).join(', '));

    // ---- the search box knows the same commands ----
    await exec('Palette.open()');
    await wait(300);
    await typeInto('#palette input', 'show two');
    await wait(150);
    const found = await inPage(() => {
      const items = [...document.querySelectorAll('#palette .pal-item')];
      const hit = items.find((el) => el.querySelector('.label').textContent === 'Show two chats side by side');
      if (hit) hit.click();
      return { n: items.length, hit: Boolean(hit) };
    });
    await wait(300);
    t = await tilesNow();
    check('the search box finds "Show two chats side by side", and running it puts two on screen',
      found.hit && t.n === 2 && same(idsOf(t), [a, c]) && t.keyboard === c && same(t.saved, [2, 2]) && same(t.order, [a, c, b, d]) && (await exec('document.getElementById("palette").hidden')) === true,
      `${found.n} entries for "show two"; on screen: ${idsOf(t).join(', ')}`);

    // ---- closing one: the others stay, and its place goes to the chat that waits first in line ----
    await giveKeyboard(a);
    const goneC = await closeAndWait(c);
    await wait(200);
    t = await tilesNow();
    check('closing one chat leaves the others running, and its place goes to the chat that waits first in line',
      goneC && [a, b, d].every((id) => chats.all.has(id) && alive(chats.all.get(id).pid)) && t.n === 2 && same(idsOf(t), [a, b]) && t.keyboard === a && same(t.order, [a, b, d])
      && same((await inPage(pageSide)).map((s) => s.id), [a, b, d]), `still open: ${t.order.join(', ')}; on screen: ${idsOf(t).join(', ')}`);

    // the offer shown after a restart, with one chat on it
    await exec(`Desk.state.info.previous = ${JSON.stringify([{ cwd: folder, starter: 'shell', title: '', resume: '', mode: '' }])}; banner(Desk.state.info.previous)`);
    const offered = await exec('!document.querySelector("#notes > .callout:nth-child(3)").hidden');
    await exec('document.querySelector("#notes > .callout:nth-child(3) .btn.primary").click()');
    const again = await until(async () => {
      const front = await exec('Terms.active()');
      return chats.all.size === 4 && front && ![a, b, d].includes(front) ? front : '';
    }, 8000);
    check('the offer to bring back the chats of last time opens them, and the one that comes back takes the keyboard',
      offered && Boolean(again) && (await exec('document.querySelector("#notes > .callout:nth-child(3)").hidden')) === true, `reopened as ${again}`);
    if (again) {
      await until(promptBack, 20000);
      await closeAndWait(again);
    }

    // a chat that is the view of a background session: such a session runs outside every console here,
    // so the watcher has to be told which chat shows it
    const bg = watch.latest().chats.find((x) => x.job);
    if (!bg) {
      say('      no background session on this machine: tying one to the chat that shows it was not checked');
    } else {
      // a plain shell stands in for the view: nothing is attached to the real session
      const v = chats.create({ cwd: folder, command: '', starter: 'shell', title: 'View check', job: bg.job }).id;
      const rowOf = () => watch.latest().chats.find((x) => x.job === bg.job);
      const tied = await until(async () => rowOf() && rowOf().chat === v, 8000);
      await wait(400);
      // its session is in the list once: as the chat of this window that shows it (what it is called and says is the person's: only its shape is kept)
      const asListed = await inPage((key) => [...document.querySelectorAll('#chat-list .nav-item.chat')].filter((el) => el.dataset.key === key)
        .map((el) => ({ here: el.classList.contains('k-here'), id: el.dataset.id, label: el.querySelector('.label').textContent === 'View check', mark: el.dataset.mark })), bg.key);
      await exec(`Desk.showSession(${JSON.stringify(bg.key)})`);
      await wait(200);
      const led = await exec('Desk.state.view');
      check('a background session shown in a chat here is tied to that chat: it is in the list once, as that chat, and asking for it leads to its terminal',
        Boolean(tied) && asListed.length === 1 && asListed[0].here && asListed[0].id === v && asListed[0].label && asListed[0].mark !== 'none' && led === v,
        `rows for it in the list: ${asListed.length}; mark "${asListed[0] ? asListed[0].mark : ''}"`);
      await exec(`Desk.closeChat(${JSON.stringify(v)})`);
      const untied = await until(async () => !chats.all.has(v) && rowOf() && rowOf().chat === '', 20000, 100);
      check('closing that chat leaves the session where it was, offered again', Boolean(untied));
    }

    // back to one chat, with the whole panel
    const goneB = await closeAndWait(b);
    const goneD = await closeAndWait(d);
    await view(a);
    const alone = await until(async () => (await exec('term.cols')) === cols0, 5000);
    t = await tilesNow();
    check('with the others closed the first chat has the whole panel again', goneB && goneD && Boolean(alone) && t.n === 1 && same(idsOf(t), [a]) && t.keyboard === a && chats.all.size === 1,
      `${t.tiles[0] ? t.tiles[0].cols : '?'} columns`);
  };

  // ---- workspaces with real consoles: each has its own chats on screen, and a chat goes on running while another
  // ---- workspace is in front. Plain consoles in folders the run makes for itself.
  const spacesPhase = async ({ cols0 }) => {
    const a = agent.chat;
    const idsOf = (x) => x.tiles.map((t) => t.id);
    const spaceIn = () => exec('Desk.state.settings.space');
    const listed = async () => (await inPage(pageSide)).map((s) => s.id);
    const [one, two, three] = ['one', 'two', 'three'].map((name) => path.join(dir, 'work', name));
    for (const f of [one, two, three]) fs.mkdirSync(f, { recursive: true });
    // these folders have long paths: in half of the panel the prompt runs over two rows, and only its end says it is there
    const ready = () => until(async () => { const rows = (await screen()).filter((l) => l.trim()); return rows.length > 0 && />\s*$/.test(rows[rows.length - 1]); }, 30000);

    // ---- a new workspace: the chat that was open steps aside ----
    const first = await call('addSpace', 'First');
    await wait(300);
    let t = await tilesNow();
    const page = await inPage(pagePeek);
    check('a new workspace starts empty: the chat that was open steps aside, still running, and the start page says whose it is',
      /^w[0-9a-z]{1,12}$/.test(first || '') && t.n === 0 && t.parked === 1 && page.start === 'No chat of First is open in this window' && (await listed()).length === 0
      && chats.all.has(a) && alive(chats.all.get(a).pid), `on screen: ${t.n}; waiting off screen: ${t.parked}; the page: "${page.start}"`);

    // ---- started from the New chat panel in a folder that is in no workspace: the folder joins the one in front ----
    await exec('document.getElementById("toast").hidden = true; Desk.openPicker()');
    await wait(250);
    const offered = await inPage(() => {
      const shell = [...document.querySelectorAll('#picker .seg button')].find((b) => b.textContent === 'PowerShell');
      if (shell) shell.click();
      const note = document.querySelector('#picker .pick-note');
      return { shell: Boolean(shell), note: note && !note.hidden ? note.textContent : '' };
    });
    await typeInto('#picker .pathrow .input', one);
    await inPage(pageKey, 'Enter', '#picker .pathrow .input');
    const x1 = await until(async () => { const id = await exec('Terms.active()'); return id && id !== a ? id : ''; }, 10000, 100);
    const joined = await toastNow();
    if (!check('a chat opens from the New chat panel', Boolean(x1), x1 || 'no chat')) throw new Error('no chat in the workspace');
    await ready();
    t = await tilesNow();
    check('a chat started from the New chat panel in a folder that is in no workspace puts that folder in the workspace in front, and says so',
      offered.shell && offered.note === 'A folder that is in no workspace yet joins First. One that is in another workspace opens there.'
      && joined === '"one" is now part of First.' && Boolean(await until(async () => same(keptSpaces(), [['First', [one]]]), 3000, 100)) && (await spaceIn()) === first
      && t.n === 1 && same(idsOf(t), [x1]) && t.keyboard === x1 && t.parked === 1 && same(await listed(), [x1]), `"${joined}"; on screen: ${t.n}; waiting off screen: ${t.parked}`);

    // ---- a second chat beside it, then a second workspace with one chat ----
    await call('putFolder', two, first);
    const made2 = await inPage(pageNew, { cwd: two, starter: 'shell' });
    const x2 = made2 && made2.id;
    if (!check('a second chat opens in the same workspace', Boolean(x2), x2 || 'no chat')) throw new Error('no second chat in the workspace');
    await ready();
    const second = await call('addSpace', 'Second');
    await call('putFolder', three, second);
    const made3 = await inPage(pageNew, { cwd: three, starter: 'shell' });
    const x3 = made3 && made3.id;
    if (!check('a chat opens in a second workspace', Boolean(x3), x3 || 'no chat')) throw new Error('no chat in the second workspace');
    await ready();
    t = await tilesNow();
    const inSecond = { ids: idsOf(t), keyboard: t.keyboard, parked: t.parked, list: await listed(), tabs: tabsOf(await spacesNow()) };
    await press(tabOfSpace(first));
    await wait(400);
    t = await tilesNow();
    const inFirst = { ids: idsOf(t), keyboard: t.keyboard, parked: t.parked, list: await listed(), drawn: t.tiles.every((x) => x.drawn), tabs: tabsOf(await spacesNow()) };
    check('each workspace has its own chats on screen: its tab brings them back side by side, and the list holds only them',
      same(inSecond.ids, [x3]) && inSecond.keyboard === x3 && inSecond.parked === 3 && same(inSecond.list, [x3]) && same(inSecond.tabs.slice(0, 3), ['All', 'First', 'Second*'])
      && same(inFirst.ids, [x1, x2]) && inFirst.keyboard === x2 && inFirst.parked === 2 && same(inFirst.list, [x1, x2]) && inFirst.drawn && same(inFirst.tabs.slice(0, 3), ['All', 'First*', 'Second'])
      && (await spaceIn()) === first,
      `Second: ${inSecond.ids.length} on screen, ${inSecond.parked} waiting off screen; First: ${inFirst.ids.length} on screen, ${inFirst.parked} waiting off screen`);

    // ---- the keys stay inside the workspace in front ----
    const walked = [];
    const step = async (code, how) => { await ctrl(code, how); await wait(150); walked.push(await exec('Terms.active()')); };
    await step('Tab');
    await step('Digit2');
    await step('Digit1');
    await step('Digit3');
    await step('Tab');
    check('Ctrl Tab and Ctrl 1 to 9 stay inside the workspace in front: its chats only, and no third place to go to',
      same(walked, [x1, x2, x1, x1, x2]) && (await spaceIn()) === first, `asked for: back, place 2, place 1, place 3, back; the keyboard went to ${walked.join(', ')}`);

    // ---- a chat goes on running while another workspace is in front ----
    await exec(`desk.input(${JSON.stringify(x3)}, ${JSON.stringify("1..60 | ForEach-Object { \"row $_\" }; Write-Host 'while-elsewhere'\r")})`);
    const away = await until(async () => (await linesOf(x3)).includes('while-elsewhere'), 8000);
    await giveKeyboard(x1);
    await ctrl('Digit3', { shift: true });
    await wait(400);
    t = await tilesNow();
    const held = await linesOf(x3);
    check('a chat goes on running while another workspace is in front: it took everything its console printed, and stands at the end of it',
      Boolean(away) && same(idsOf(t), [x3]) && t.keyboard === x3 && t.tiles.every((x) => x.drawn && x.atEnd) && held.includes('row 60') && held.includes('while-elsewhere') && (await spaceIn()) === second,
      `${held.filter((l) => /^row \d+$/.test(l)).length} of 60 rows printed while First was in front`);
    await ctrl('Digit2', { shift: true });
    await wait(400);
    t = await tilesNow();
    const cols1 = t.tiles[0] ? t.tiles[0].cols : 0;
    await askWidth('ws');
    const told = await widthSeen(x1, 'ws', cols1);
    check('coming back to a workspace puts its chats where they stood, the keyboard in the one used last, each at the end of what it holds and as wide as its place',
      same(idsOf(t), [x1, x2]) && t.keyboard === x1 && t.tiles.every((x) => x.drawn && x.atEnd) && t.parked === 2 && Boolean(told) && cols1 > 0 && cols1 < cols0,
      `on screen: ${t.n}; ${cols1} columns each side by side (${cols0} alone)`);

    // ---- every chat, and what is asked for is followed into its workspace ----
    await ctrl('Digit1', { shift: true });
    await wait(400);
    t = await tilesNow();
    const inAll = { space: await spaceIn(), list: await listed(), ids: idsOf(t), keyboard: t.keyboard };
    await press(tabOfSpace(first));
    await wait(300);
    await view(x3);
    await wait(400);
    t = await tilesNow();
    const followed = { space: await spaceIn(), ids: idsOf(t), keyboard: t.keyboard };
    await view(a);
    await wait(400);
    t = await tilesNow();
    check('"All" holds the chats of every workspace and the ones in none; asking for a chat brings the workspace it is in in front with it',
      inAll.space === '' && same(inAll.list.slice().sort(), [a, x1, x2, x3].sort()) && same(inAll.ids, [x1, x2]) && inAll.keyboard === x1
      && followed.space === second && same(followed.ids, [x3]) && followed.keyboard === x3
      && (await spaceIn()) === '' && t.keyboard === a && t.n === 2 && idsOf(t).includes(a),
      `"All" lists ${inAll.list.length} chats; asking for the chat of Second led to ${followed.space === second ? 'Second' : 'somewhere else'}; asking for the one in no workspace led to ${(await spaceIn()) === '' ? '"All"' : 'somewhere else'}`);

    // ---- taken away again: the first chat is alone, under the word "Chats" ----
    const closed = (await closeAndWait(x1)) && (await closeAndWait(x2)) && (await closeAndWait(x3));
    await exec(`Desk.removeSpace(${JSON.stringify(first)}); Desk.removeSpace(${JSON.stringify(second)})`);
    await view(a);
    const alone = await until(async () => (await exec('term.cols')) === cols0, 5000);
    t = await tilesNow();
    const sp = await spacesNow();
    check('with the workspaces taken away and their chats closed, the first chat is alone again under the word "Chats"',
      closed && Boolean(alone) && t.n === 1 && same(idsOf(t), [a]) && t.keyboard === a && chats.all.size === 1 && !sp.on && sp.tabs.length === 0 && sp.label === 'Chats'
      && Boolean(await until(async () => settingsNow().spaces.length === 0 && settingsNow().space === '', 3000, 100)), `${t.tiles[0] ? t.tiles[0].cols : '?'} columns; tabs: ${sp.tabs.length}`);
  };

  const typingPart = async () => {
    const ready = (await screen()).some((l) => new RegExp(process.env.DESK_SELFTEST_READY || '^>\\s*$').test(l));
    if (!check('the prompt box is idle and ready', ready)) throw new Error('prompt box not recognised; nothing was typed');

    await type('desk typing check');
    check('typing shows up in the prompt box', Boolean(await until(async () => (await screen()).some((l) => l.includes('desk typing check')), 5000)));
    await inPage(pageShiftEnter);
    await wait(300);
    await type('second line');
    await wait(900);
    let rows = await screen();
    const a = rows.findIndex((l) => l.includes('desk typing check'));
    const b = rows.findIndex((l) => l.includes('second line'));
    check('Shift+Enter starts a new line instead of sending', a >= 0 && b > a, `rows ${a} and ${b}`);

    if (notes.modes.bracketedPasteMode) {
      await exec(`term.paste(${JSON.stringify('pasted one\npasted two')})`);
      await wait(1200);
      rows = await screen();
      const p1 = rows.findIndex((l) => l.includes('pasted one'));
      const p2 = rows.findIndex((l) => l.includes('pasted two'));
      check('a two-line paste lands as two lines, not as a sent message', p1 >= 0 && p2 > p1, `rows ${p1} and ${p2}`);
    } else {
      say('      paste check skipped: the CLI did not switch on paste protection');
    }
    await wait(600);
    rows = await screen();
    check('nothing was sent to the model', !rows.some((l) => /esc to interrupt/i.test(l)) && rows.some((l) => l.includes('desk typing check')));
    await keep('3-typed');
    await shoot('3-typed');
    if (notes.hook) {
      // by now the hook's slower second pass (the ancestry walk) has rewritten the record
      notes.hookLater = hookRecord();
      say(`      Perch hook record a few seconds in: ${JSON.stringify(notes.hookLater)}`);
      check('still no tab stored after the hook\'s second pass', Boolean(notes.hookLater) && !notes.hookLater.window);
    }

    await type('\x03');
    const cleared = await until(async () => !(await screen()).some((l) => l.includes('second line')), 4000);
    check('Ctrl+C clears the prompt box', Boolean(cleared));
    if (cleared) {
      await type('/exit');
      await wait(700);
      const asked = Date.now();
      await type('\r');
      check('/exit leaves the CLI and PowerShell is back', Boolean(await until(promptBack, 20000, 300)), `${Date.now() - asked} ms`);
      await wait(500);
      if (agent.pid) check('the agent process is gone after /exit', !alive(agent.pid));
      const end = await endedItself();
      check('/exit ends the session properly', end.fileGone, `own session file removed: ${end.fileGone}`);
      endScripts(end);
      const off = await until(async () => !watch.latest().chats.some((c) => c.pid === agent.pid), 12000, 400);
      check('the session leaves the dashboard once it has ended', Boolean(off));
      await keep('4-after-exit');
    }

    // How much a full scrollback costs per extra terminal, measured in the page that would hold them.
    const hasGc = await inPage(pageGc);
    await wait(800);
    const before = pageMemory();
    const filled = await inPage(pageFill, 10, 10000, 130);
    await wait(1500);
    const after = pageMemory();
    await inPage(pageDrop);
    if (before && after) {
      notes.scale = {
        terminals: filled.length,
        linesEach: Math.min(...filled),
        privateMbEach: Number(((after.privateMb - before.privateMb) / filled.length).toFixed(1)),
        workingMbEach: Number(((after.workingMb - before.workingMb) / filled.length).toFixed(1)),
        forcedCleanup: hasGc,
      };
      say(`      10 more terminals, each holding ${notes.scale.linesEach} lines of 130 columns: +${notes.scale.privateMbEach} MB private (+${notes.scale.workingMbEach} MB in use) per terminal`);
    }
  };

  // ---- a live agent session in the first chat ----
  const agentPhase = async () => {
    const chat = chats.all.get(agent.chat);
    await inPage(pageWatchFrames);
    await type('cls\r');
    await wait(400);
    notes.fullscreenBefore = fullscreenNotes();
    const launch = Date.now();
    await type(`claude${process.env.DESK_SELFTEST_AGENT_ARGS ? ` ${process.env.DESK_SELFTEST_AGENT_ARGS}` : ''}\r`);
    const drew = await until(async () => (await screen()).some((l) => /Claude Code/i.test(l)), 90000, 250);
    agent.firstFrameAt = Date.now();
    agent.pid = childrenNamed(chat.pid, 'claude.exe')[0] || 0;
    check('the agent CLI starts and draws its screen', Boolean(drew), `${((agent.firstFrameAt - launch) / 1000).toFixed(1)} s`);
    // a session this young must not have its console closed under it: two such closes turn fullscreen off for the machine
    const held = await until(async () => { const ms = chats.tooYoung(chat); return ms > 0 ? ms : 0; }, 4000, 200);
    check('a chat whose session only just started is not closed straight away', Boolean(held), `a close asked for now would wait ${((held || 0) / 1000).toFixed(1)} s`);
    await settle(1500, 25000);
    await keep('2-agent');
    notes.modes = await exec('JSON.parse(JSON.stringify(term.modes))');
    notes.drawing = await inPage(pageDrawing);
    say(`      terminal modes the CLI switched on: ${Object.entries(notes.modes).filter(([, v]) => v && v !== 'none').map(([k, v]) => (v === true ? k : `${k}=${v}`)).join(', ') || '(none)'}`);
    say(`      drawing: ${notes.drawing.canvases ? 'graphics card' : 'plain page text'}; the CLI uses ${notes.drawing.buffer === 'alternate' ? 'its fullscreen screen' : 'its classic screen'}; width table ${notes.drawing.widths}`);
    say(`      console shell pid ${chat.pid}, agent pid ${agent.pid || '(not found)'}`);

    const own = agent.pid && await until(async () => {
      try { return JSON.parse(fs.readFileSync(liveFile(), 'utf8')); } catch { return null; }
    }, 6000, 300);
    agent.sessionId = (own && own.sessionId) || '';
    notes.agent = { pid: agent.pid, shellPid: chat.pid, sessionId: agent.sessionId };

    // The dashboard has to find the new session on disk and trace it back to this chat.
    const traced = agent.pid && await until(async () => watch.latest().chats.find((c) => c.pid === agent.pid && c.chat === agent.chat), 25000, 300);
    check('the dashboard finds the session and knows which chat it runs in', Boolean(traced),
      traced ? `${Date.now() - agent.firstFrameAt} ms after its first frame; state "${traced.state}"` : `rows for this pid: ${JSON.stringify(watch.latest().chats.filter((c) => c.pid === agent.pid).map((c) => c.chat))}`);
    const side = await inPage(pageSide);
    check('the list shows the chat with its session', side.length === 1 && side[0].mark !== 'none', `${side.length} chat in the list, its mark: "${side[0] ? side[0].mark : ''}"`);
    await shoot('2-agent');
    if (traced) {
      // its session is in the list once: as the chat of this window that it runs in
      const mine = await inPage((key) => [...document.querySelectorAll('#chat-list .nav-item.chat')].filter((el) => el.dataset.key === key).map((el) => el.className), traced.key);
      check('its session is in the list once, as the chat of this window that holds the keyboard',
        mine.length === 1 && /\bk-here\b/.test(mine[0]) && /\bshown\b/.test(mine[0]) && /\bon\b/.test(mine[0]), `${mine.length} row for it`);
      // the panel beside it: nothing was said in the session yet, and its conversation says so
      const colsWas = await exec('term.cols');
      await exec('Desk.setInspector(true)');
      const narrower = await until(async () => { const n = await exec('term.cols'); return n < colsWas ? n : 0; }, 5000);
      await wait(300);
      const beside = await inPage(pageDetail, 'inspector');
      await tabOf('inspector', 'conv');
      const state = await until(() => exec(`(() => { const s = Desk.ChatView.detail().reader.state(); return s === 'none' || s === 'ready' ? s : ''; })()`), 8000);
      await wait(150);
      const read = await inPage(pageReader, 'inspector');
      await tabOf('inspector', 'overview');
      check('the panel beside it shows the session, and its conversation says there is nothing to read yet',
        Boolean(narrower) && beside.shown && beside.tabs.length >= 3 && beside.tabs[0] === 'Overview*' && Boolean(state) && (state === 'none' ? /^Nothing to read yet/.test(read.empty) : read.asks === 0),
        `tabs: ${beside.tabs.join(', ')}; the reader: ${state === 'none' ? 'no file on disk yet' : `${read.says} said, ${read.tools} tool calls`}; ${colsWas} -> ${narrower} columns`);
      await shoot('2-agent-panel');
      await exec('Desk.setInspector(false)');
      await until(async () => (await exec('term.cols')) === colsWas, 5000);
      // from another page of the window, a click on its row in the list leads back to its terminal
      await view('stats');
      await wait(200);
      await exec(`document.querySelector('#chat-list .nav-item.chat[data-row="chat:${agent.chat}"]').click()`);
      await wait(200);
      check('from the Dashboard, a click on its row in the list leads back to its terminal', (await exec('Desk.state.view')) === agent.chat && (await exec('Terms.active()')) === agent.chat);
    }
    await view(agent.chat);
    // the agent draws its screen again for each change of size: it is left to settle before anything more is read from it
    await settle(1200, 12000);

    notes.memory = await report('with the CLI on screen, before any token counting');

    // Token counts: off for a test run by default (the transcripts are gigabytes); on for a moment to see them arrive.
    watch.post({ type: 'counting', on: true });
    const counted = await until(async () => watch.latest().chats.find((c) => c.tokens && c.tokens.share > 0 && c.tokens.out > 0), 15000, 300);
    // the count of today's lines (the part read first) must have got going without an error: a few rounds of it are let run
    await wait(4000);
    const sofar = await watch.ask('usage', { range: 'today' });
    watch.post({ type: 'counting', on: false });
    say(`      after a few rounds of counting: ${sofar ? `${Math.round(sofar.reading.read / 1048576)} MB of ${Math.round(sofar.reading.bytes / 1048576)} MB read, today's part ${sofar.reading.today ? 'done' : 'still going'}, ${sofar.days[29].out} tokens out counted for today, ${watch.errors().length} errors reported` : 'no answer'}`);
    check('token counts arrive on the dashboard, with today set apart', Boolean(counted) && Boolean(counted.today) && Array.isArray(counted.pulse) && counted.pulse.length === 30,
      counted ? `first one: in ${counted.tokens.in + counted.tokens.cacheWrite}, out ${counted.tokens.out}, cached ${counted.tokens.cacheRead}, ${Math.round(counted.tokens.share * 100)}% read; today: out ${counted.today && counted.today.out}, ${counted.today && counted.today.replies} replies` : '');
    notes.memoryCounting = await report('right after a burst of token counting');

    // A session here has no Windows Terminal tab for the hook to find.
    if (agent.pid && fs.existsSync(path.join(hookDir, 'status'))) {
      notes.hook = await until(async () => hookRecord(), 8000, 400);
      say(`      Perch hook record at start: ${JSON.stringify(notes.hook)}`);
      check('the Perch hook tracks the session and stores no tab for it', Boolean(notes.hook) && !notes.hook.window);
    }

    const looks = watch.took();
    notes.looks = looks;
    say(`      watcher looks so far: ${looks.length}, slowest ${Math.max(...looks)} ms, typical ${looks.slice().sort((x, y) => x - y)[Math.floor(looks.length / 2)]} ms`);

    if (typing) await typingPart();
    notes.frames = await exec('window.deskFrames');
    check('the CLI marks its screen updates as whole frames and the marks reach the widget', notes.frames > 0, `${notes.frames} frames`);
  };

  /** Ends whatever is still running. Returns true when the window itself was closed, which also ends this program. */
  const leave = async () => {
    const chat = chats.all.get(agent.chat);
    if (!chat) return false;
    const shellPid = chat.pid;
    await view(agent.chat);
    if (agentUp() && !closing) {
      // ask it to leave by itself, once it is old enough; Ctrl+C first drops anything a failed check left in the prompt box
      const young = chats.tooYoung(chat);
      if (young > 0) await wait(young);
      await type('\x03');
      await wait(600);
      await type('/exit');
      await wait(700);
      await type('\r');
      await until(async () => !agentUp(), 20000, 300);
    }
    const wasUp = agentUp();
    if (wasUp && closing === 'quit') {
      notes.closedAt = Date.now();
      say('      closing the window with the CLI still running; what became of it is checked from outside');
      return true;
    }
    // the app's own way of closing a chat: it holds back while a session in it is too young
    const asked = Date.now();
    await chats.close(agent.chat);
    const t0 = Date.now();
    const agentGone = wasUp ? await until(async () => !agentUp(), 10000, 100) : true;
    const agentMs = Date.now() - t0;
    const gone = agentGone && await until(async () => !alive(shellPid) && !chats.all.has(agent.chat), 10000, 100);
    check('closing the last chat leaves nothing running', Boolean(gone) && chats.all.size === 0, `shell ${shellPid}${agent.pid ? `, agent ${agent.pid}` : ''}`);
    if (wasUp) {
      const end = await endedItself();
      check('a chat closed while it is running ends its session properly', end.fileGone,
        `held back ${t0 - asked} ms, then the CLI was gone after ${agentMs} ms; own session file removed: ${end.fileGone}`);
      endScripts(end);
    }
    const back = await until(async () => (await exec('Desk.state.view')) === 'peek' && (await inPage(pageSide)).length === 0 && (await inPage(pagePeek)).start === START, 4000);
    check('with no chat left the window is back on its start page', Boolean(back));
    return false;
  };

  /** The checks every run ends with, its result line and its notes. */
  const finish = () => {
    // an error inside the watcher thread is caught there and written to a log: without this a run could pass over one
    const errors = watch.errors();
    check('the part that reads the files reported nothing going wrong', errors.length === 0,
      errors.length ? `${errors.length} report(s); the first: ${String(errors[0]).split('\n').slice(0, 2).join(' | ').slice(0, 300)}` : '');
    check('the page itself reported nothing going wrong', pageErrors.length === 0,
      pageErrors.length ? `${pageErrors.length} error(s); the first: ${pageErrors[0].slice(0, 300)}` : '');
    say('');
    say(`RESULT: ${lines.filter((l) => l.startsWith('PASS')).length} passed, ${failed} failed   (${os.release()}, Electron ${process.versions.electron})`);
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(notes, null, 2));
  };

  // ---- leaving with chats open, and the start after it. Plain consoles only: no agent is started, nothing of the person's is opened. ----
  const KEPT_NAME = 'Kept by the test';
  const KEPT_SPACE = 'Kept space';
  const sideNow = () => inPage(pageSide);
  const leavePhase = async () => {
    check('the window loads', Boolean(await until(() => exec('typeof Desk === "object" && Desk !== null'), 15000)));
    // opened the way a chat that comes back is opened, so the profile keeps no word on how new chats start: the
    // next start can then show that bringing consoles back does not make consoles the way new chats start
    const a = await inPage(pageNew, { ...plain, restore: true });
    const first = Boolean(a && a.id) && Boolean(await until(promptBack, 30000));
    const b = await inPage(pageNew, { ...plain, restore: true });
    const second = Boolean(b && b.id) && Boolean(await until(promptBack, 30000));
    if (!check('two plain consoles open in this window', first && second)) throw new Error('no consoles');
    await exec(`desk.rename(${JSON.stringify(b.id)}, ${JSON.stringify(KEPT_NAME)})`);
    // the first one is brought to the front: the record says which chat is in front, not which was opened last
    await view(a.id);
    const want = [{ cwd: folder, starter: 'shell', title: '', named: false, resume: '', mode: '', front: true }, { cwd: folder, starter: 'shell', title: KEPT_NAME, named: true, resume: '', mode: '', front: false }];
    const written = await until(async () => same(settingsNow().open, want), 5000, 150);
    check('every open chat is written down as it changes: its folder, how it was started, the name it was given, and which one is in front',
      Boolean(written) && settingsNow().running === true, `kept: ${JSON.stringify(settingsNow().open.map((c) => [c.starter, c.title, c.named, c.front]))}; the run is marked as going: ${settingsNow().running}`);
    // on disk within the second, so that a crash loses nothing
    const file = path.join(app.getPath('userData'), 'desk.json');
    const onDisk = await until(async () => { try { return same(JSON.parse(fs.readFileSync(file, 'utf8')).open, want); } catch { return false; } }, 4000, 150);
    // the second one is brought to the front: the record follows, and it is the one to come back in front
    await view(b.id);
    const follows = await until(async () => { try { return same(JSON.parse(fs.readFileSync(file, 'utf8')).open.map((c) => c.front), [false, true]); } catch { return false; } }, 4000, 150);
    check('and it is in the settings file within moments, not only when the app closes: also which chat is in front, as that changes', Boolean(onDisk) && Boolean(follows));

    // a workspace made before the close, with the folder of both chats in it: the next start has to find it, in front
    const space = await call('addSpace', KEPT_SPACE);
    await call('putFolder', folder, space);
    const sorted = await until(async () => {
      try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return same(d.spaces, [{ id: space, name: KEPT_SPACE, folders: [folder] }]) && d.space === space && same(d.open.map((c) => c.front), [false, true]); } catch { return false; }
    }, 5000, 150);
    check('a workspace, the folders in it and which workspace is in front are in the settings file within moments too, and the chat in front stays in front',
      Boolean(sorted) && (await exec('Desk.state.view')) === b.id && (await sideNow()).length === 2, `tabs: ${tabsOf(await spacesNow()).slice(0, 2).join(', ')}`);

    // the question a close asks (the main process sends the same word when the window's own close button is pressed)
    win.webContents.send('desk:command', 'ask-leave');
    const asked = await until(async () => !(await exec('document.getElementById("leave").hidden')), 3000);
    const box = await inPage(() => {
      const root = document.getElementById('leave');
      return { title: root.querySelector('h2').textContent, names: root.querySelector('.leave-top .quiet').textContent,
        choices: [...root.querySelectorAll('.leave-choice')].map((x) => `${x.dataset.how}: ${x.querySelector('.leave-title').textContent}`),
        remember: Boolean(root.querySelector('#leave-remember')) && !root.querySelector('#leave-remember').checked, cancel: root.querySelector('.foot .btn').textContent,
        focus: document.activeElement && document.activeElement.dataset.how, logo: Boolean(root.querySelector('.leave-logo')) };
    });
    await shoot('2-leave');
    check('closing the window with chats open asks what should become of them', Boolean(asked) && box.title === 'You have 2 chats open' && box.names.endsWith(` · ${KEPT_NAME}`)
      && same(box.choices, ['keep: Keep them for next time', 'fresh: Start fresh next time', 'tray: Keep running by the clock']) && box.remember && box.cancel === 'Cancel' && box.focus === 'keep',
      `"${box.title}": ${box.choices.join(' / ')}; the first choice holds the keyboard: ${box.focus === 'keep'}`);
    await inPage(pageKey, 'Escape', '#leave');
    await wait(150);
    check('Esc takes the question away and nothing closes', (await exec('document.getElementById("leave").hidden')) === true && chats.all.size === 2 && (await sideNow()).length === 2);

    // "Keep them for next time": the app ends itself from here on, so this run's result is written first.
    // What it left behind is read from outside, and by the next start.
    win.webContents.send('desk:command', 'ask-leave');
    await until(async () => !(await exec('document.getElementById("leave").hidden')), 3000);
    say('      answering "Keep them for next time": the app now closes its chats and ends by itself');
    notes.shells = chats.list().map((c) => c.pid);
    finish();
    await exec(`document.querySelector('#leave .leave-choice[data-how="keep"]').click()`);
    // Two plain consoles close at once, and the app with them. (A close waits while a Claude Code that may be this
    // chat's is under 15 s old, and one just started anywhere on the machine counts as "may be": that can stretch
    // it.) Still here after 25 s, it did not work.
    await wait(25000);
    fs.appendFileSync(path.join(dir, 'report.txt'), 'FAIL  the app was still running 25 s after "Keep them for next time"\n');
    app.exit(1);
  };

  const backPhase = async () => {
    const expect = process.env.DESK_SELFTEST_EXPECT === 'crash' ? 'crash' : 'auto';
    const starterWas = settingsNow().starter;
    check('the window loads', Boolean(await until(() => exec('typeof Desk === "object" && Desk !== null'), 15000)));
    const how = await exec('Desk.state.info.restore');
    // While they are opened one after the other, the list on disk is left whole: an end in the middle loses none.
    const midway = await until(async () => {
      const s = await sideNow();
      return s.length === 1 ? { open: settingsNow().open.length, names: settingsNow().open.map((c) => c.title), shown: (await exec('Desk.state.view')) === s[0].id } : null;
    }, 15000, 60);
    const back = await until(async () => { const s = await sideNow(); return s.length === 2 ? s : null; }, 15000, 150);
    if (!check(`the chats that were open come back by themselves at the next start${expect === 'crash' ? ', also after a run that never reached its end' : ''}`,
      how === expect && Boolean(back) && back[1].label === KEPT_NAME && back[0].label !== KEPT_NAME,
      `this start decided "${how}"; ${back ? `${back.length} chats: "${back[0].label}" and "${back[1].label}"` : 'they did not come back'}`)) throw new Error('nothing came back');
    check('while they are opened one after the other, the list kept on disk stays whole, and a chat is on screen from the first one on', Boolean(midway) && midway.open === 2 && midway.names[1] === KEPT_NAME && midway.shown,
      midway ? `with 1 of 2 open, the list still held ${midway.open}; that first chat was on screen: ${midway.shown}` : 'the moment with one chat open was not caught');
    const said = await until(async () => { const t = await exec('document.getElementById("toast").textContent');
      return (expect === 'crash' ? /^Perch Desk did not close properly last time\. Your 2 chats are back\.$/ : /^Your 2 chats are back, as you left them\.$/).test(t) ? t : ''; }, 8000, 150);
    // the second one was in front when the app closed: the window moves on to it once it is there
    const front = await until(async () => (await exec('Desk.state.view')) === back[1].id, 6000, 150);
    const kept = chats.list();
    check('they come back as they were: the name that was given, the one that was in front in front again, and the window says so',
      Boolean(said) && Boolean(front) && kept.length === 2 && kept[0].starter === 'shell' && kept[1].named === true && kept[1].title === KEPT_NAME && kept[0].named === false,
      `"${said}"; in front: ${front ? `"${back[1].label}"` : 'not the one that was'}`);
    check('PowerShell runs in the one in front', Boolean(await until(promptBack, 30000)));
    // what they were started with is not made the way new chats start from now on
    const after = await until(async () => { const s = settingsNow(); return s.open.length === 2 && s.open[1].front === true && s.open[1].title === KEPT_NAME ? s : null; }, 6000, 150);
    check('bringing consoles back does not make consoles the way new chats start, and they are written down again for the next time',
      Boolean(after) && after.starter === starterWas && after.starter !== 'shell' && after.running === true,
      after ? `the starter for new chats is still ${after.starter ? `"${after.starter}"` : 'the default one'}; ${after.open.length} chats on record` : 'the record was not written again');
    // both were on screen when the app closed: they stand side by side again, the keyboard in the one that had it
    const t = await inPage(pageTiles);
    check('and they stand side by side again, the keyboard in the one that had it',
      t.n === 2 && same(t.tiles.map((x) => x.id), back.map((s) => s.id)) && t.keyboard === back[1].id && t.tiles.every((x) => x.drawn) && same(t.saved, [2, 2]),
      `${t.n} on screen; the keyboard is in ${t.keyboard === back[1].id ? 'the one that was in front' : 'another one'}`);
    // the workspace made before the close: there again with its folder, and in front, so both chats are in the list
    const sp = await spacesNow();
    const main = settingsNow();
    check('the workspaces come back too: the one that was in front is in front again, with the folders in it',
      sp.on && sp.spaces.length === 1 && same(sp.spaces.map((s) => [s.name, s.folders]), [[KEPT_SPACE, [folder]]]) && sp.space === sp.spaces[0].id && (sp.tabs.find((x) => x.on) || {}).name === KEPT_SPACE
      && same(main.spaces.map((s) => [s.name, s.folders]), [[KEPT_SPACE, [folder]]]) && main.space === sp.space,
      `tabs: ${tabsOf(sp).slice(0, 2).join(', ')}; the folder in it: ${sp.spaces[0] ? sp.spaces[0].folders.length : 0}`);
    await shoot('2-back', true);
  };

  // ---- pictures of the window that hold nothing of the person's: four plain consoles, each tied to a made-up session
  // ---- and drawn over with a made-up agent screen. Meant to be shown to people; run it with DESK_RENDERER=dom.
  const picturePhase = async () => {
    check('the window loads', Boolean(await until(() => exec('typeof Desk === "object" && Desk !== null'), 15000)));
    check('the watcher delivers its first picture of the machine', Boolean(await until(async () => watch.latest().at > 0 && watch.latest(), 20000)));
    win.setContentSize(1920, 1040);
    await wait(400);
    // four places before the first chat opens, so that each chat takes the next place as it opens
    await exec('Desk.setTiles(4)');
    const ids = [];
    for (const name of ['shop', 'pricing', 'api', 'landing']) {
      const cwd = path.join(dir, 'work', name);
      fs.mkdirSync(cwd, { recursive: true });
      const chat = await inPage(pageNew, { cwd, starter: 'shell', restore: true });
      if (!chat || !chat.id) throw new Error('a console did not open');
      ids.push(chat.id);
      await until(promptBack, 30000);
      // an empty prompt and a cleared screen: nothing of the console itself is left to see
      await type("function prompt { ' ' }; cls\r");
      await wait(600);
    }
    const [checkout, pricing, refactor, landing] = ids;
    const kindOf = { [checkout]: 'checkout', [pricing]: 'pricing', [refactor]: 'refactor', [landing]: 'landing' };
    // from here on what the consoles print stays out of the terminals: a console repaints itself whenever its size
    // changes, and would wipe what is drawn over it
    await exec('Terms.write = () => {}; true');

    // the real sessions step aside for the made-up ones, at twenty to four in the afternoon of a busy day
    watch.post({ type: 'pace', ms: 600000 });
    await wait(900);
    const afternoon = new Date();
    afternoon.setHours(15, 40, 0, 0);
    madeAt = await inPage(pageClock, afternoon.getTime() - Date.now());
    await installFakes();
    await showUsage('today');
    const res = madeUpRes(pricing);
    const chatRes = (key, extra, cpu) => ({ mem: res.sessions[key].mem + extra * MB, cpu, n: res.sessions[key].n + 2, ports: [] });
    Object.assign(res.chats, { [checkout]: chatRes('s-permission', 64, 0.4), [refactor]: chatRes('s-compact', 66, 3.3), [landing]: chatRes('s-finish', 61, 0.5) });
    await exec(`Desk.state.res = ${JSON.stringify(res)}`);
    // the keyboard in the chat that is at work: the one that finishes in the next picture of the machine then counts as unseen
    await view(pricing);
    const tie = { 's-permission': checkout, 's-agents': pricing, 's-compact': refactor, 's-finish': landing };
    const rowsFor = (flip) => madeUpRows(flip).map((r) => (tie[r.key] ? { ...r, chat: tie[r.key] } : r));
    await exec(`takeSnapshot(${fake(madeAt, rowsFor(false))})`);
    await exec(`takeSnapshot(${fake(madeAt + 1, rowsFor(true))})`);
    await wait(300);

    /** Draws the made-up agent screens into the terminals on screen, once their places have their size. True when each holds one. */
    const dress = async () => {
      await wait(700);
      const shown = await exec('Terms.shown()');
      for (const id of shown) await inPage(pageDress, id, kindOf[id]);
      await wait(350);
      await exec('paint()');
      return exec(`Terms.shown().every((id) => { const b = Terms.get(id).term.buffer.active; for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (l && l.translateToString(true).includes('\\u2570')) return true; } return false; })`);
    };
    /** A picture, after the hidden window was made to draw a few frames: a terminal only draws when a frame comes. */
    const picture = async (name) => {
      await exec('document.getElementById("toast").hidden = true');
      for (let i = 0; i < 3; i++) { await win.webContents.capturePage(); await wait(120); }
      await shoot(name);
    };
    const dressed = [];
    const counts = [];
    const seen = async () => { dressed.push(await dress()); counts.push((await inPage(pageTiles)).n); };

    await seen();
    await picture('picture-1-four');
    await exec('Desk.setTiles(2)');
    await seen();
    await picture('picture-2-two');
    await exec('Desk.setTiles(1)');
    await seen();
    await picture('picture-3-one');
    await exec('Desk.setInspector(true)');
    await seen();
    await picture('picture-4-panel');
    await exec('Desk.setInspector(false); Desk.setTiles(2)');
    await wait(300);
    // a chat that runs in another terminal, looked at from here
    await exec('Desk.look({ kind: "live", key: "s-words" })');
    await wait(400);
    await picture('picture-5-elsewhere');
    await exec('Desk.look(null)');
    await view('stats');
    await wait(500);
    await picture('picture-6-dashboard');
    const list = await inPage(pageList);
    check('the pictures were taken with made-up chats only: four consoles drawn over, four, two and one on screen, and nine made-up sessions in the list',
      dressed.every(Boolean) && same(counts, [4, 2, 1, 1]) && list.rows === 9 && list.here === 4 && list.away === 5 && list.ended === 0,
      `terminals drawn over each time: ${dressed.join(', ')}; on screen: ${counts.join(', ')}; ${list.rows} sessions in the list, ${list.here} of them chats of this window`);

    // ---- the same window with workspaces: three of them over made-up folders, and two more made-up sessions for the third ----
    const at = (name) => path.join(dir, 'work', name);
    const RENDERS = 'D:\\work\\renders';
    const renders = [
      row({ key: 's-light', title: 'Kitchen scene lighting', cwd: RENDERS, state: 'working', since: madeAt - 4 * 60e3, context: 152000,
        words: 'The key light is too hot on the counter. Lowering it and rendering a test frame.', doing: tool('Bash', 'Render frame 12 at half size', 35, 0) }),
      row({ key: 's-turn', title: 'Turntable export script', cwd: RENDERS, state: 'idle', since: madeAt - 50 * 60e3, at: madeAt - 50 * 60e3, context: 61000,
        words: 'The script exports 72 frames, one every five degrees.' }),
    ];
    Object.assign(res.sessions, { 's-light': { ...res.sessions['s-words'], mem: 1946 * MB }, 's-turn': { ...res.sessions['s-finish'], mem: 212 * MB } });
    await exec(`Desk.state.res = ${JSON.stringify(res)}`);
    await exec(`takeSnapshot(${fake(madeAt + 2, [...rowsFor(true), ...renders])})`);
    const mine = await call('addSpace', 'Mine');
    const upwork = await call('addSpace', 'Upwork');
    const third = await call('addSpace', '3D');
    for (const f of [at('pricing'), at('api'), 'D:\\work\\pricing', 'D:\\work\\api']) await call('putFolder', f, mine);
    for (const f of [at('shop'), at('landing'), 'D:\\work\\shop']) await call('putFolder', f, upwork);
    await call('putFolder', RENDERS, third);
    const seenAs = [];
    const inFront = async (name, id, tiles, drawOver) => {
      await exec(`Desk.setTiles(${tiles})`);
      await call('switchSpace', id);
      await wait(300);
      const ok = drawOver ? await dress() : true;
      const sp = await spacesNow();
      seenAs.push({ tabs: tabsOf(sp), rows: sp.keys.length, on: (await inPage(pageTiles)).n, ok, spill: sp.spill, lines: sp.lines });
      await picture(name);
    };
    await inFront('picture-7-spaces-all', '', 4, true);
    await inFront('picture-8-spaces-mine', mine, 2, true);
    await inFront('picture-9-spaces-upwork', upwork, 2, true);
    await inFront('picture-10-spaces-other-terminals', third, 2, false);
    check('and with workspaces: each has its own chats on screen and in the list, and a tab that is not in front counts the chats of its own that wait',
      same(seenAs.map((s) => s.tabs), [['All*', 'Mine', 'Upwork 3', '3D'], ['All', 'Mine*', 'Upwork 3', '3D'], ['All', 'Mine', 'Upwork*', '3D'], ['All', 'Mine', 'Upwork 3', '3D*']])
      && same(seenAs.map((s) => s.rows), [11, 3, 6, 2]) && same(seenAs.map((s) => s.on), [4, 2, 2, 0]) && seenAs.every((s) => s.ok && !s.spill),
      seenAs.map((s) => `${s.tabs.join(' ')}: ${s.rows} in the list, ${s.on} on screen, tabs on ${s.lines} line${s.lines === 1 ? '' : 's'}`).join('; '));
  };

  const only = process.env.DESK_SELFTEST_ONLY || '';
  try {
    if (only === 'leave') await leavePhase();
    else if (only === 'back') await backPhase();
    else if (only === 'picture') await picturePhase();
    else {
      await startPhase();
      if (process.env.DESK_SELFTEST_SKIP !== 'states') await statesPhase();
      if (only !== 'states') {
        const sizes = await consolePhase();
        // the workspaces with real consoles are a run of their own: together with the rest, one run would last too long
        if (only === 'spaces') await spacesPhase(sizes);
        else {
          await widthsPhase();
          await twoPhase(sizes);
          if (only !== 'widths') await agentPhase();
        }
      }
    }
  } catch (err) {
    failed++;
    say(`FAIL  self-test stopped: ${err && err.stack ? err.stack : err}`);
  }
  // A 'back' run ends here with its chats open and without the app's own goodbye: for the start after it, that is
  // a run that never reached its end.
  if (only === 'back') {
    notes.shells = chats.list().map((c) => c.pid);
    finish();
    app.exit(failed ? 1 : 0);
    return;
  }
  // A 'picture' run closes its consoles the way the app closes any chat, and ends.
  if (only === 'picture') {
    notes.shells = chats.list().map((c) => c.pid);
    await chats.closeAll();
    finish();
    app.exit(failed ? 1 : 0);
    return;
  }
  let windowClosing = false;
  try {
    windowClosing = await leave();
  } catch (err) {
    failed++;
    say(`FAIL  closing the chat stopped: ${err && err.stack ? err.stack : err}`);
  }
  if (agent.firstFrameAt && !windowClosing) {
    await wait(500);
    const before = notes.fullscreenBefore;
    const after = await until(async () => fullscreenNotes(), 3000, 200);
    notes.fullscreenAfter = after;
    say(`      Claude Code's notes on fullscreen starts for this machine: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
    check('the run left no failed-start mark with Claude Code',
      Boolean(after) && !after.pending.includes(String(agent.pid)) && !after.turnedOff && after.failedStarts <= (before ? before.failedStarts : 0));
  }

  finish();
  if (windowClosing) win.close();
  else app.exit(failed ? 1 : 0);
};
