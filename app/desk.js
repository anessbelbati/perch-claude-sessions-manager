'use strict';
/* global desk, Terms, Side, Peek, History, Stats, ChatView, Picker, Palette, Settings, Parts, Detail, Reader, h, fill, icon, glyph, kept, held, labelOf, phrase, markOf, folderOf, toast, initTips, acctName */
// The window's shell: the title bar, which view is in front (the chats on
// screen, a session looked at from the sidebar, History or the Dashboard),
// which chats share the screen and which of them has the keyboard, and the
// wiring between the main process, the terminals and the views.

const state = {
  info: null,
  chats: [],                      // this window's chats, as the main process lists them
  // the watcher's newest picture: every session on the machine, and the accounts it logs in to
  snap: { at: 0, chats: [], ended: [], leaving: [], plan: null, accounts: null },
  // what the programs under every session and every chat take on this computer, as last measured: { sessions, chats, app, all, servers }
  res: null,
  view: 'peek',                   // 'peek', 'history', 'stats', or the id of the chat that has the keyboard
  shown: [],                      // this window's chats by place: the first ones are on screen, the rest wait in line
  recent: [],                     // this window's chats, the one used last first
  unread: new Set(),              // sessions that finished while nobody was looking at them
  sel: null,                      // the session looked at in the Peek view: { kind: 'live' | 'ended', key }
  selLeaving: '',                 // that session, while its program is on its way out: looked at again once it shows as ended
  before: new Map(),              // session -> its state in the picture before this one
  usage: null,                    // the watcher's newest sums: 30 days, 48 hours, and the totals of `range`
  range: 'today',                 // what the Dashboard adds up
  armed: new Set(),               // sessions in other terminals that open here once they end over there
  armedAs: new Map(),             // -> what each was called when that was asked, for the line said when it cannot come
  resumed: new Map(),             // conversations being opened here -> when that was asked
  // tiles: how many chats share the screen (1, 2 or 4). split: how many when it was last more than one
  // spaces: the workspaces, [{ id, name, folders }]. space: the one in front; '' shows every chat
  settings: { notify: {}, fontSize: 16, inspector: false, tiles: 2, split: 2, links: {}, solid: false, accountNames: {}, spaces: [], space: '' },
  loose: false,                   // only the chats that are in no workspace are shown (what is still to be sorted)
  seen: true,                     // the window can be seen (in front or not)
  stale: false,                   // the watcher stopped and was not started again: what is shown no longer moves
  frozen: false,                  // the numbers and the measurements are left as they are (the self-test shows made-up ones)
};
const $ = (id) => document.getElementById(id);
const RANK = { attention: 0, error: 1, working: 2, compacting: 2, idle: 3 };
const OLD_MS = 3 * 86400e3;
const PLACES = ['peek', 'history', 'stats'];
const isChat = (view) => !PLACES.includes(view);
const isOld = (c) => c.kind === 'bg' && !c.pid && Date.now() - c.at > OLD_MS;
const wants = (c) => c.state === 'attention' || c.state === 'error';

// ---- workspaces: a name, and the folders that belong to it. A chat is in the workspace that lists the folder it
// ---- works in, or the nearest folder above that one. The window shows one workspace at a time, or every chat. ----
const SPACES_MAX = 12;
const pathKey = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
let folderIndex = { of: null, list: [] };
/** Every folder that is in a workspace, the deepest first: a folder inside another is found before the one around it. */
function foldersByDepth() {
  const spaces = state.settings.spaces || [];
  if (folderIndex.of !== spaces) {
    const list = [];
    for (const s of spaces) for (const f of s.folders) list.push([pathKey(f), s.id, f]);
    list.sort((a, b) => b[0].length - a[0].length);
    folderIndex = { of: spaces, list };
  }
  return folderIndex.list;
}
/** Where a folder is sorted: { id, through } with the workspace and the listed folder that put it there, or null. */
function sortedBy(cwd) {
  const p = pathKey(cwd);
  if (!p) return null;
  for (const [f, id, through] of foldersByDepth()) if (p === f || p.startsWith(`${f}\\`)) return { id, through };
  return null;
}
/** The workspace a folder is in; '' when it is in none. */
const spaceOf = (cwd) => { const s = sortedBy(cwd); return s ? s.id : ''; };
const spaceNow = () => (state.settings.spaces || []).find((s) => s.id === state.settings.space) || null;
/** Whether what works in this folder shows in the workspace in front. */
function inView(cwd) {
  if (state.loose) return !spaceOf(cwd);
  return !state.settings.space || spaceOf(cwd) === state.settings.space;
}
/** Whether one of this window's chats shows in the workspace in front. */
const visible = (id) => { const c = state.chats.find((x) => x.id === id); return Boolean(c) && inView(c.cwd); };
/** What the workspace in front is called, for the pages that speak of it: null while every chat is shown. */
function spaceWords() {
  if (state.loose) return { name: '', loose: true, empty: false };
  const s = spaceNow();
  return s ? { name: s.name, loose: false, empty: s.folders.length === 0 } : null;
}

/** The session running in one of this window's chats; the one that most needs a look when there are several. */
function sessionOf(chatId) {
  return state.snap.chats.filter((c) => c.chat === chatId).sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at)[0] || null;
}
/** The mark a session is drawn with: what it is doing, and whether it finished unseen. */
const markFor = (s) => markOf(s, Boolean(s && state.unread.has(s.key)));

function chatLabel(chat) {
  const s = sessionOf(chat.id);
  return chat.title || (s ? labelOf(s) : folderOf(chat.cwd) || 'Chat');
}

function chatSub(chat) {
  if (chat.closing) return 'Closing…';
  const s = sessionOf(chat.id);
  if (s) return phrase(s) || (state.unread.has(s.key) ? 'Finished' : folderOf(chat.cwd));
  const starter = state.info.starters.find((x) => x.id === chat.starter);
  if (!starter || !starter.agent) return 'PowerShell';
  return Date.now() - chat.startedAt < 30000 ? `Starting ${starter.name}…` : starter.name;
}

/** The chats of the workspace in front that run in other terminals and could be moved into this window. */
function movable() {
  const here = new Set(state.chats.map((c) => c.id));
  return state.snap.chats.filter((c) => c.provider === 'claude' && c.pid && c.session && c.kind !== 'bg' && !(c.chat && here.has(c.chat)) && inView(c.cwd));
}
/** How many of them there are, the ones already on their way here left out. */
const elsewhere = () => movable().filter((c) => !state.armed.has(c.session)).length;

// ---- drawing. Nothing is redrawn while a mouse button is down: a click on a row that is swapped under the
// ---- pointer is lost. A pane that holds selected text leaves itself alone (see selectionIn). ----
let dirty = false;
let holding = false;

function paint() {
  if (holding) { dirty = true; return; }
  dirty = false;
  drawBar();
  Side.render(state);
  drawNotes();
  const chat = state.chats.find((c) => c.id === state.view);
  document.title = chat ? `${chatLabel(chat)} · Perch Desk` : 'Perch Desk';
  if (state.view === 'peek') Peek.render(state);
  else if (state.view === 'history') History.render(state);
  else if (state.view === 'stats') Stats.render(state);
  else ChatView.render(state);
}

/** The small mark on the taskbar button: how many sessions want the person. */
let badgeShown = -1;
function badge(n) {
  if (n === badgeShown) return;
  badgeShown = n;
  if (!n) { desk.badge('', ''); return; }
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#f5a524';
  g.beginPath();
  g.arc(16, 16, 15, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1a1205';
  g.font = '700 20px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(n > 9 ? '9+' : String(n), 16, 17);
  desk.badge(c.toDataURL('image/png'), `${n} waiting for you`);
}

/** The title bar: how many sessions wait for the person, and how many chats share the screen. */
function drawBar() {
  const needs = state.snap.chats.filter((c) => wants(c) && !isOld(c)).length;
  badge(needs);
  const tri = $('triage');
  tri.hidden = needs === 0;
  if (needs && tri.dataset.n !== String(needs)) {
    tri.dataset.n = String(needs);
    fill(tri, glyph('needs', 13), h('span', { text: `${needs} need${needs === 1 ? 's' : ''} you` }));
  }
  for (const b of $('split').children) {
    const on = Number(b.dataset.n) === state.settings.tiles;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

/** Said when another account logs in (the person typed /login in some chat). */
function sayLogin() {
  const v = Parts.acctView(state);
  if (!v.me) { toast('Claude Code is logged out on this machine.', 8000); return; }
  const words = Parts.restingWords(v.me);
  toast(`Now on ${acctName(v.me, v.names)}. ${words.length ? `When last seen: ${words.join(', ')}.` : 'Its limits show with the next reply.'}`, 9000);
}

// ---- what stands above every view while it matters: the part that reads the files has stopped, chats are on
// ---- their way here from other terminals, last time's chats are on offer ----
const notes = { stale: null, armed: null, reopen: null };
function initNotes(root) {
  notes.stale = h('div', { class: 'callout warn', hidden: true }, icon('alert', 16),
    h('div', null,
      h('div', { class: 'callout-title', text: 'The list of chats stopped updating' }),
      h('div', { class: 'callout-text', text: "The part of the app that reads Claude Code's files stopped several times in a row. The chats in this window are not affected." })),
    h('div', { class: 'callout-acts' }, h('button', { class: 'btn', text: 'Start it again', onclick: () => { state.stale = false; desk.watchAgain(); paint(); toast('Starting it again…'); } })));
  notes.armed = h('div', { class: 'callout', hidden: true });
  notes.reopen = h('div', { class: 'callout', hidden: true });
  root.append(notes.stale, notes.armed, notes.reopen);
}
function drawNotes() {
  notes.stale.hidden = !state.stale;
  const n = state.armed.size;
  notes.armed.hidden = n === 0;
  if (n && notes.armed.dataset.stamp !== String(n)) {
    notes.armed.dataset.stamp = String(n);
    fill(notes.armed, icon('bring', 16),
      h('div', null,
        h('div', { class: 'callout-title', text: `${n} chat${n === 1 ? '' : 's'} will open here as soon as you close ${n === 1 ? 'it' : 'them'} over there` }),
        h('div', { class: 'callout-text', text: 'In its own window: type /exit and press Enter, or close the tab. A chat that is still working loses the answer in progress, so let it finish first.' })),
      h('div', { class: 'callout-acts' }, h('button', { class: 'btn', text: 'Cancel', onclick: () => disarm() })));
  }
  Parts.tick($('notes'));
}
/** The offer to bring back the chats that were open when the app was last closed; null takes it away. */
function banner(previous) {
  notes.reopen.hidden = !previous || !previous.length;
  if (notes.reopen.hidden) return;
  const names = previous.map((p) => p.title || folderOf(p.cwd)).filter(Boolean);
  fill(notes.reopen, icon('history', 16),
    h('div', null,
      h('div', { class: 'callout-title', text: `Reopen the ${previous.length} chat${previous.length === 1 ? '' : 's'} from last time?` }),
      h('div', { class: 'callout-text', text: names.join(' · ') })),
    h('div', { class: 'callout-acts' },
      h('button', { class: 'btn primary', text: 'Reopen', onclick: () => reopen('') }),
      h('button', { class: 'btn ghost', text: 'Not now', onclick: () => { state.info.previous = []; banner(null); desk.previousDone(); } })));
}

// ---- which chats are on screen. One, two or four share it; each keeps its place, so the eye finds it again.
// ---- A chat without a place takes the one of the chat used longest ago. ----
/** The chats on screen right now, by place: one when a chat is big, else as many as share the screen. */
function onScreen() {
  if (!isChat(state.view)) return [];
  return state.settings.tiles === 1 ? [state.view] : state.shown.filter(visible).slice(0, state.settings.tiles);
}
/**
 * Where the window rests when nothing in particular is asked for: the chat of the workspace in front that was
 * used last, or the start page when none of its chats is open here.
 */
function rest() {
  const last = state.recent.find(visible);
  if (last) return last;
  const any = state.chats.find((c) => inView(c.cwd));
  return any ? any.id : 'peek';
}
const touch = (id) => { state.recent = [id, ...state.recent.filter((x) => x !== id)]; };

/**
 * Gives a chat a place on screen. One that has none takes the place of the chat used longest ago, so the others
 * stay where they are. A place that fell empty (its chat was closed) goes to the chat that waits first in line.
 * While one chat is big the places are kept as they were, for when the chats stand side by side again.
 * The places are those of the workspace in front: the chats of the others keep the order they stand in.
 */
function seat(id) {
  const alive = new Set(state.chats.filter((c) => inView(c.cwd)).map((c) => c.id));
  const others = state.chats.map((c) => c.id).filter((x) => !alive.has(x));
  const order = state.shown.filter((x) => !others.includes(x));
  const places = state.settings.tiles === 1 ? state.settings.split : state.settings.tiles;
  const on = order.slice(0, places).map((x) => (alive.has(x) ? x : ''));
  let line = order.slice(places).filter((x) => alive.has(x));
  if (id && alive.has(id) && !on.includes(id)) {
    line = line.filter((x) => x !== id);
    const hole = on.indexOf('');
    if (hole >= 0) on[hole] = id;
    else if (on.length < places) on.push(id);
    else {
      const age = (x) => { const i = state.recent.indexOf(x); return i < 0 ? Infinity : i; };
      let worst = 0;
      for (let i = 1; i < on.length; i++) if (age(on[i]) > age(on[worst])) worst = i;
      line.unshift(on[worst]);
      on[worst] = id;
    }
  }
  const spare = [...line, ...state.recent, ...state.chats.map((c) => c.id)].filter((x, i, all) => alive.has(x) && !on.includes(x) && all.indexOf(x) === i);
  for (let i = 0; i < on.length; i++) if (!on[i]) on[i] = spare.shift() || '';
  const placed = on.filter(Boolean);
  while (placed.length < places && spare.length) placed.push(spare.shift());
  const elsewhereOrder = [...state.shown.filter((x) => others.includes(x)), ...others.filter((x) => !state.shown.includes(x))];
  state.shown = [...placed, ...spare, ...elsewhereOrder];
}

// ---- which workspace is in front ----
/** What is asked for works in this folder: when the workspace in front does not hold it, the one that does comes in front. */
function follow(cwd) {
  if (inView(cwd)) return;
  state.loose = false;
  state.settings.space = spaceOf(cwd);
  desk.settings({ space: state.settings.space });
}

/**
 * Brings a workspace in front ('' for every chat; loose: only what is in no workspace yet). Its chats take the
 * screen in the places they had; with none of them open here, its start page shows.
 */
function switchSpace(id, loose = false) {
  const s = state.settings;
  const next = !loose && s.spaces.some((x) => x.id === id) ? id : '';
  if (next === s.space && loose === state.loose) {
    // already in front: a click on its tab still leads from History or the Dashboard back to its chats
    if (!isChat(state.view) && !(state.view === 'peek' && !state.sel)) setView(rest());
    return;
  }
  state.loose = loose;
  if (next !== s.space) {
    s.space = next;
    desk.settings({ space: next });
  }
  // a session that was being looked at stays with the workspace that is left, and counts as seen
  if (state.sel && state.sel.kind === 'live') state.unread.delete(state.sel.key);
  state.sel = null;
  lookFrom = '';
  setView(rest());
}

/** After the workspaces changed: what is on screen is what the workspace in front holds. */
function resettle() {
  // nothing is left to sort: the list of unsorted chats gives way to every chat
  if (state.loose && !state.snap.chats.some((c) => !spaceOf(c.cwd)) && !state.chats.some((c) => !spaceOf(c.cwd))) state.loose = false;
  if (isChat(state.view)) { setView(visible(state.view) ? state.view : rest()); return; }
  if (state.view === 'peek') {
    const sel = state.sel;
    const at = sel && (sel.kind === 'live' ? state.snap.chats.find((c) => c.key === sel.key) : (state.snap.ended || []).find((e) => e.id === sel.key));
    if (!sel || (at && !inView(at.cwd))) { state.sel = null; setView(rest()); return; }
  }
  paint();
}

function saveSpaces(next) {
  const s = state.settings;
  s.spaces = next;
  if (s.space && !next.some((x) => x.id === s.space)) s.space = '';
  // with no workspace left there is nothing to be sorted into
  if (!next.length) state.loose = false;
  desk.settings({ spaces: next, space: s.space });
}
const spaceName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);

/** A new workspace, brought in front. Returns its id; '' when it has no name, or there are as many as fit. */
function addSpace(name) {
  const tidy = spaceName(name);
  const s = state.settings;
  if (!tidy) return '';
  if (s.spaces.length >= SPACES_MAX) { toast(`${SPACES_MAX} workspaces is as many as fit. Take one away first.`); return ''; }
  let id = '';
  do { id = `w${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`; } while (s.spaces.some((x) => x.id === id));
  saveSpaces([...s.spaces, { id, name: tidy, folders: [] }]);
  switchSpace(id);
  return id;
}
function renameSpace(id, name) {
  const tidy = spaceName(name);
  if (!tidy) return;
  saveSpaces(state.settings.spaces.map((x) => (x.id === id ? { ...x, name: tidy } : x)));
  paint();
}
/** Takes a workspace away. Its chats are not touched: they show under every chat again, unsorted. */
function removeSpace(id) {
  saveSpaces(state.settings.spaces.filter((x) => x.id !== id));
  resettle();
}

/**
 * Puts a folder in a workspace; '' takes it out of the one that lists it. Every chat that works in it, or in a
 * folder inside it, goes along, now and later.
 */
function putFolder(cwd, id) {
  const key = pathKey(cwd);
  if (!key) return;
  const s = state.settings;
  const by = sortedBy(cwd);
  if (!id) {
    if (!by) return;
    // it is in a workspace through a folder above it: that one is not taken out behind the person's back
    if (pathKey(by.through) !== key) {
      const name = (s.spaces.find((x) => x.id === by.id) || {}).name || 'a workspace';
      toast(`"${folderOf(cwd)}" is in ${name} because ${by.through} is. Put it in another workspace, or take that folder out in Settings.`, 9000);
      return;
    }
  } else if ((by && by.id === id) || !s.spaces.some((x) => x.id === id)) {
    // already there, itself or through a folder above it; or a workspace that is gone
    return;
  }
  const next = s.spaces.map((x) => ({ ...x, folders: x.folders.filter((f) => pathKey(f) !== key) }));
  const to = next.find((x) => x.id === id);
  if (to) to.folders.push(folderAs(cwd));
  saveSpaces(next);
  // Said, because under "All" nothing else shows that it happened. Taken out of one workspace, a folder can
  // still be in another through a folder above it: what is said is where it is now.
  const now = sortedBy(cwd);
  const home = now && s.spaces.find((x) => x.id === now.id);
  toast(!home ? `"${folderOf(cwd)}" is in no workspace now.`
    : pathKey(now.through) === key ? `"${folderOf(cwd)}" is now part of ${home.name}.`
      : `"${folderOf(cwd)}" is now part of ${home.name}, because ${now.through} is.`, 5000);
  resettle();
}
/** A folder as it is kept: backslashes, none at the end; a whole drive keeps its one. */
function folderAs(cwd) {
  const f = String(cwd).replace(/\//g, '\\').replace(/\\+$/, '');
  return /^[a-z]:$/i.test(f) ? `${f}\\` : f;
}

/** A chat was started in a folder that is in no workspace, while one is in front: the folder joins that workspace. */
function adopt(cwd) {
  const now = spaceNow();
  if (!now || state.loose || !cwd || spaceOf(cwd)) return;
  const next = state.settings.spaces.map((x) => (x.id === now.id ? { ...x, folders: [...x.folders, folderAs(cwd)] } : x));
  saveSpaces(next);
  toast(`"${folderOf(cwd)}" is now part of ${now.name}.`, 5000);
}

// ---- views ----
/** walking: the person is stepping through the chats used last (Ctrl with Tab): which one was used last is settled when they stop. */
function setView(view, { walking = false } = {}) {
  // asked for a moment before the main process has listed it (a chat just made): it is shown as soon as it is
  wanted = isChat(view) && !state.chats.some((c) => c.id === view) ? view : '';
  if (wanted) view = rest();
  // a chat of another workspace was asked for: that workspace comes in front with it
  if (isChat(view)) follow(state.chats.find((c) => c.id === view).cwd);
  // a session is looked at only while its page is in front
  if (view !== 'peek') state.sel = null;
  state.view = view;
  if (isChat(view)) {
    if (!walking) touch(view);
    seat(view);
  }
  $('peek').hidden = view !== 'peek';
  $('history').hidden = view !== 'history';
  $('stats').hidden = view !== 'stats';
  // the places must have their size before a terminal is fitted to them
  $('chat').hidden = !isChat(view);
  ChatView.place(state, onScreen());
  for (const c of state.snap.chats) if (c.chat === view) state.unread.delete(c.key);
  if (!isChat(view)) refreshUsage(view === 'stats');
  // the chat that has the keyboard has it again next time
  const front = isChat(view) ? view : '';
  if (front !== frontSaid) { frontSaid = front; desk.front(front); }
  paint();
}
let frontSaid = '';
let wanted = '';

/** How many chats share the screen: 1, 2 or 4. */
function setTiles(n) {
  if (![1, 2, 4].includes(n) || n === state.settings.tiles) return;
  state.settings.tiles = n;
  if (n > 1) state.settings.split = n;
  desk.settings({ tiles: state.settings.tiles, split: state.settings.split });
  if (isChat(state.view)) setView(state.view); else paint();
}
/** One chat big, or back to the chats side by side. */
const toggleBig = () => setTiles(state.settings.tiles === 1 ? state.settings.split : 1);

// Back to the chat used before this one. Held down, Ctrl with Tab walks further back, the way Alt with Tab walks
// through windows; which chat counts as used last is settled when Ctrl is let go. The walk stays inside the
// workspace in front.
let walk = null;
function back(step) {
  if (!walk) {
    const list = state.recent.filter(visible);
    for (const c of state.chats) if (inView(c.cwd) && !list.includes(c.id)) list.push(c.id);
    if (!list.length) return;
    walk = { list, at: isChat(state.view) ? list.indexOf(state.view) : -1 };
  }
  const n = walk.list.length;
  walk.at = walk.at < 0 ? (step > 0 ? 0 : n - 1) : (walk.at + step + n) % n;
  setView(walk.list[walk.at], { walking: true });
}
function endWalk() {
  if (!walk) return;
  walk = null;
  if (isChat(state.view)) touch(state.view);
}

/**
 * Looks at a session that does not live in this window, or at a conversation that ended: its page takes the
 * panel. null: back to where the look began (History or the Dashboard), else to the chats. A session that
 * finished unseen counts as seen once the person moves on from it.
 */
let lookFrom = '';
function look(sel) {
  const was = state.sel;
  if (was && was.kind === 'live' && !(sel && sel.kind === 'live' && sel.key === was.key)) state.unread.delete(was.key);
  if (!sel) {
    const to = lookFrom || rest();
    lookFrom = '';
    state.sel = null;
    setView(to);
    return;
  }
  if (state.view !== 'peek') lookFrom = state.view === 'history' || state.view === 'stats' ? state.view : '';
  // one of another workspace: that workspace comes in front with it, so the list on the left holds it
  const at = sel.kind === 'live' ? state.snap.chats.find((c) => c.key === sel.key) : (state.snap.ended || []).find((e) => e.id === sel.key);
  if (at) follow(at.cwd);
  state.sel = sel;
  setView('peek');
}

/** Shows one session wherever it is: its terminal when it runs in a chat here, its page when it runs elsewhere. */
function showSession(key) {
  const c = state.snap.chats.find((x) => x.key === key);
  const chat = c && c.chat ? state.chats.find((x) => x.id === c.chat) : null;
  if (chat) setView(chat.id); else look({ kind: 'live', key });
  // a redraw held back by a click in progress would leave the row as it was
  setTimeout(() => { paint(); Side.reveal(key); }, 0);
}

/** The History view, opened on one conversation. */
function readPast(id) {
  setView('history');
  History.show(id);
}

/** The next chat here that wants the person, the one that has waited longest first; failing that, the session anywhere that has waited longest. */
function nextNeeding() {
  const mine = state.chats.map((c) => ({ id: c.id, s: sessionOf(c.id) })).filter((x) => x.s && wants(x.s)).sort((a, b) => a.s.since - b.s.since);
  if (mine.length) {
    setView(mine[(mine.findIndex((x) => x.id === state.view) + 1) % mine.length].id);
    return;
  }
  const other = state.snap.chats.filter((c) => wants(c) && !isOld(c)).sort((a, b) => a.since - b.since)[0];
  if (other) showSession(other.key);
  else toast('Nothing needs you right now.');
}

/** Where a click on a note near the clock, or a tray command, leads: 'stats', 'history', a chat, or 'row:<session>'. */
function goTo(target) {
  if (typeof target !== 'string') return;
  if (target.startsWith('row:')) showSession(target.slice(4));
  else setView(target);
}

async function closeChat(id) {
  if (state.chats.some((c) => c.id === id)) await desk.close(id);
}

// ---- leaving with chats open: keep them for next time, start fresh, or keep running by the clock ----
const LEAVE_CHOICES = [
  ['keep', 'Keep them for next time', 'Next time Perch Desk opens, they open again by themselves: the same conversations, the names you gave them, the same permission mode.'],
  ['fresh', 'Start fresh next time', 'Their conversations stay saved. History has every one of them, with "Resume here".'],
  ['tray', 'Keep running by the clock', 'Nothing closes. Your chats go on; the bird near the clock brings the window back.'],
];
const leaveOpen = () => !$('leave').hidden;
function closeLeave() {
  $('leave').hidden = true;
  if (isChat(state.view)) Terms.focus();
}
function askLeave() {
  const root = $('leave');
  if (leaveOpen()) return;
  const open = state.chats.filter((c) => !c.job && !c.closing);
  const remember = h('input', { type: 'checkbox', id: 'leave-remember' });
  const answer = (how) => {
    closeLeave();
    const fade = how !== 'tray' && !document.documentElement.classList.contains('still');
    // the window fades out before it goes: closing is calm, not a cut
    if (fade) {
      document.body.classList.add('leaving');
      // a window that is still there a while later (its chats take time to end) is hidden by then; should it not be, it shows again
      setTimeout(() => document.body.classList.remove('leaving'), 5000);
    }
    setTimeout(() => desk.leave(how, remember.checked), fade ? 220 : 0);
  };
  const names = open.map(chatLabel);
  fill(root, h('div', { class: 'dialog leave', role: 'dialog', 'aria-label': 'Closing Perch Desk' },
    h('div', { class: 'leave-top' },
      state.info.logo && h('img', { class: 'leave-logo', src: state.info.logo, alt: '' }),
      h('div', null,
        h('h2', { text: `You have ${open.length} chat${open.length === 1 ? '' : 's'} open` }),
        h('p', { class: 'quiet', text: names.length > 4 ? `${names.slice(0, 4).join(' · ')} and ${names.length - 4} more` : names.join(' · ') }))),
    h('div', { class: 'leave-choices' }, LEAVE_CHOICES.map(([how, title, note], i) => h('button', {
      class: `leave-choice${i === 0 ? ' first' : ''}`, data: { how }, onclick: () => answer(how),
    }, h('span', { class: 'leave-title', text: title }), h('span', { class: 'leave-note', text: note })))),
    h('div', { class: 'foot' },
      h('label', { class: 'leave-remember' }, remember, h('span', { text: 'Do this every time (Settings can change it)' })),
      h('button', { class: 'btn ghost', text: 'Cancel', onclick: closeLeave }))));
  root.hidden = false;
  root.onmousedown = (e) => { if (e.target === root) closeLeave(); };
  root.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLeave(); }
  };
  root.querySelector('.leave-choice.first').focus();
}

function openPicker() {
  const front = state.chats.find((c) => c.id === state.view);
  const live = state.snap.chats.slice().sort((a, b) => b.at - a.at).map((c) => c.cwd);
  const now = state.loose ? null : spaceNow();
  const names = new Map(state.settings.spaces.map((s) => [s.id, s.name]));
  Picker.open([front && front.cwd, ...state.chats.map((c) => c.cwd), ...(now ? now.folders : []), ...live], {
    // inside a workspace its own folders stand first, and each folder says which workspace it is in
    first: now ? (p) => spaceOf(p) === now.id : null,
    tag: (p) => names.get(spaceOf(p)) || '',
    note: now ? `A folder that is in no workspace yet joins ${now.name}. One that is in another workspace opens there.` : '',
  });
}

async function attach(c) {
  // already shown in a chat here: one view of it is enough
  const shown = state.chats.find((x) => x.job === c.job && !x.closing);
  if (shown) { setView(shown.id); return; }
  const ask = { attach: c.job, title: labelOf(c) };
  let chat = await desk.create({ ...ask, cwd: c.cwd || state.info.home });
  // its folder may be gone; the session itself does not need it
  if (chat && chat.error) chat = await desk.create({ ...ask, cwd: state.info.home });
  if (chat && !chat.error) setView(chat.id);
}

// Between two starts that each pick a conversation up: a Claude Code reads the whole of its conversation's file as
// it starts, and several doing that at once weigh on the machine.
const RESUME_GAP_MS = 3500;

/**
 * Brings back the chats that were open when the app last closed: each with its conversation, the name the person
 * gave it and the permission mode it was in. how: 'auto' after a normal close, 'crash' after one that never
 * reached its end, '' when the person pressed Reopen.
 */
async function reopen(how) {
  const list = state.info.previous;
  state.info.previous = [];
  banner(null);
  const from = state.view;
  let first = '';
  let failed = 0;
  for (const [i, p] of list.entries()) {
    const named = p.named === true && Boolean(p.title);
    const chat = await desk.create({ cwd: p.cwd, starter: p.starter, resume: p.resume || undefined, mode: p.mode, title: named ? p.title : '', named, restore: true });
    if (!chat || chat.error) { failed++; continue; }
    // A chat is on screen at once, and the one that had the keyboard gets it back as soon as it is there: not only
    // once the whole list is open. Unless the person has gone somewhere else meanwhile. A chat of another
    // workspace does not pull that workspace in front: only the one that had the keyboard does.
    if (!first && inView(chat.cwd)) first = chat.id;
    const waiting = state.view === from || state.view === first;
    if (waiting && (p.front || chat.id === first)) setView(chat.id);
    // one at a time: a start that picks a conversation up loads the whole of it
    if (i < list.length - 1) await new Promise((r) => setTimeout(r, p.resume ? RESUME_GAP_MS : 1500));
  }
  desk.previousDone();
  const back = list.length - failed;
  const lost = failed ? ` ${failed} could not open: ${failed === 1 ? 'its folder is' : 'their folders are'} gone. History still has ${failed === 1 ? 'its conversation' : 'their conversations'}.` : '';
  if (how === 'crash') toast(`Perch Desk did not close properly last time. Your ${back} chat${back === 1 ? ' is' : 's are'} back.${lost}`, 9000);
  else if (how === 'auto' || failed) toast(`${back ? `Your ${back} chat${back === 1 ? ' is' : 's are'} back, as you left ${back === 1 ? 'it' : 'them'}.` : ''}${lost}`, 7000);
}

// ---- bringing a conversation here: one that ended, or one that runs in another terminal ----
const queue = [];
let pumping = false;
/** Opens an ended conversation in a chat of this window. show: give that chat the keyboard. */
function resume(e, show) {
  if (state.resumed.has(e.id)) return;
  state.resumed.set(e.id, Date.now());
  queue.push({ e, show });
  paint();
  pump();
}
async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const { e, show } = queue.shift();
    const chat = await desk.create({ resume: e.id, cwd: e.cwd, mode: e.mode });
    if (!chat || chat.error) {
      // back on the list of ended conversations, to be tried again
      state.resumed.delete(e.id);
      paint();
      toast(`${labelOf(e)} could not be opened here. ${(chat && chat.error) || ''}`);
    } else if (show) {
      setView(chat.id);
    } else {
      toast(`${labelOf(e)} is now open here.`);
    }
    // one at a time: each start loads a whole conversation
    if (queue.length) await new Promise((r) => setTimeout(r, RESUME_GAP_MS));
  }
  pumping = false;
}

/** ids: the sessions to bring here once they end where they run; null for every one of the workspace in front that runs in another terminal. */
function arm(ids) {
  const list = ids || movable().map((c) => c.session);
  for (const id of list) {
    state.armed.add(id);
    const c = state.snap.chats.find((x) => x.session === id);
    if (c) state.armedAs.set(id, labelOf(c));
  }
  paint();
}
function disarm(id) {
  if (id) { state.armed.delete(id); state.armedAs.delete(id); } else { state.armed.clear(); state.armedAs.clear(); }
  paint();
}

// ---- looking again, now ----
let refreshing = false;
/**
 * Everything read again at once: the sessions, who is logged in, what the chats last said about the limits, and
 * the numbers. It cannot make a limit move: those figures come with a chat's next reply.
 */
async function refreshNow() {
  if (refreshing) return;
  refreshing = true;
  const btn = $('refresh');
  btn.classList.add('spin');
  const t0 = Date.now();
  const done = await desk.refresh();
  await refreshUsage(true);
  if (state.view === 'history') await History.refresh(true);
  // a turn too quick to see reads as nothing having happened
  const short = 500 - (Date.now() - t0);
  if (short > 0) await new Promise((r) => setTimeout(r, short));
  btn.classList.remove('spin');
  refreshing = false;
  if (!done) { toast('The part that reads the files did not answer. Try again in a moment.'); return; }
  const me = Parts.acctView(state).me;
  toast(`Looked again just now.${me ? ` Logged in: ${acctName(me, state.settings.accountNames)}.` : ''} Limits move when one of your chats next talks to Claude.`, 6000);
}

// ---- the numbers ----
let usageAt = 0;
let usageBusy = false;
async function refreshUsage(force) {
  if (state.frozen || usageBusy || (!force && Date.now() - usageAt < 9000)) return;
  usageBusy = true;
  // away from the Dashboard only today's limits are looked at: every answer carries them
  const u = await desk.usage(state.view === 'stats' ? state.range : 'today');
  usageBusy = false;
  if (!u) return;
  usageAt = Date.now();
  state.usage = u;
  paint();
}

function setInspector(on) {
  state.settings.inspector = on;
  $('inspector').hidden = !on;
  desk.settings({ inspector: on });
  paint();
}

// ---- what arrives from the main process ----
function takeChats(list) {
  for (const chat of list) Terms.create(chat.id);
  // read before the list changes: a chat that is gone from the list no longer counts as on screen
  const was = onScreen().join();
  state.chats = list;
  state.recent = state.recent.filter((id) => list.some((c) => c.id === id));
  if (wanted && list.some((c) => c.id === wanted)) { setView(wanted); return; }
  // the chat that had the keyboard is gone: the one used before it takes over. And the start page gives way to
  // the first chat that opens in the workspace in front.
  const gone = isChat(state.view) && !list.some((c) => c.id === state.view);
  if (gone || (state.view === 'peek' && !state.sel && !state.selLeaving && rest() !== 'peek')) {
    setView(rest());
    return;
  }
  if (isChat(state.view)) {
    // a place fell empty, or a new chat can take one that was free
    seat(state.view);
    if (onScreen().join() !== was) ChatView.place(state, onScreen());
  }
  paint();
}

function takeSnapshot(snap) {
  if (!snap.ended) snap.ended = [];
  if (!snap.leaving) snap.leaving = [];
  if (!snap.accounts) snap.accounts = null;
  // null: no picture so far said who is logged in, so there is nothing to compare with
  const was = state.snap.accounts ? state.snap.accounts.current : null;
  state.stale = false;
  // a chat on screen that does not have the keyboard still counts as unseen when it finishes: its mark says so
  const front = isChat(state.view) && document.hasFocus() ? state.view : '';
  const keys = new Set();
  const live = new Set();
  for (const c of snap.chats) {
    keys.add(c.key);
    live.add(c.session);
    const before = state.before.get(c.key);
    if (c.state !== 'idle') state.unread.delete(c.key);
    // finished just now, and not in the chat the person is typing in
    else if ((before === 'working' || before === 'compacting') && !(c.chat && c.chat === front)) state.unread.add(c.key);
  }
  for (const key of state.unread) if (!keys.has(key)) state.unread.delete(key);
  // the session looked at follows its conversation: from running to ended, and back when it is picked up again
  const sel = state.sel;
  if (sel && sel.kind === 'live' && !keys.has(sel.key)) {
    const over = snap.ended.some((e) => e.id === sel.key);
    // closed, its program still on its way out: for a few seconds it is neither running nor ended
    if (!over && snap.leaving.includes(sel.key)) state.selLeaving = sel.key;
    state.sel = over ? { kind: 'ended', key: sel.key } : null;
  } else if (sel && sel.kind === 'ended' && !snap.ended.some((e) => e.id === sel.key)) {
    const c = snap.chats.find((x) => x.session === sel.key);
    state.sel = c ? { kind: 'live', key: c.key } : null;
  }
  if (state.selLeaving) {
    if (snap.ended.some((e) => e.id === state.selLeaving)) {
      // nothing else was looked at in the meantime: the page goes back to it
      if (!state.sel && state.view === 'peek') state.sel = { kind: 'ended', key: state.selLeaving };
      state.selLeaving = '';
    } else if (!snap.leaving.includes(state.selLeaving)) state.selLeaving = '';
  }
  state.before = new Map(snap.chats.map((c) => [c.key, c.state]));
  state.snap = snap;
  // a session that was to come here and has now ended where it ran: pick it up
  const waiting = state.armed.size;
  for (const id of [...state.armed]) {
    if (live.has(id)) continue;
    const e = snap.ended.find((x) => x.id === id);
    // closed over there, its program still on its way out: it shows up as ended within seconds
    if (!e && snap.leaving.includes(id)) continue;
    const name = state.armedAs.get(id) || 'That chat';
    state.armed.delete(id);
    state.armedAs.delete(id);
    // the one chat that was asked for gets the keyboard; several open one after another without taking it
    if (e) resume(e, waiting === 1);
    // never silently: nothing ended that can be opened (it had no message yet, or it started a new conversation over there)
    else toast(`${name} did not come here: it left no conversation to open. If it had messages, History has it, with "Resume here".`, 15000);
  }
  const now = Date.now();
  for (const [id, at] of state.resumed) if (now - at > 60000 && !snap.ended.some((e) => e.id === id)) state.resumed.delete(id);
  // the session that was looked at is gone for good: back to the chats
  if (state.view === 'peek' && !state.sel && !state.selLeaving && rest() !== 'peek') setView(rest());
  else paint();
  if (snap.accounts && was !== null && snap.accounts.current !== was) sayLogin();
}

async function boot() {
  const info = await desk.info();
  state.info = info;
  state.chats = info.chats;
  state.snap = { ended: [], leaving: [], accounts: null, ...info.snapshot };
  state.res = info.res || null;
  state.settings = info.settings;
  state.before = new Map(info.snapshot.chats.map((c) => [c.key, c.state]));
  if (info.logo) $('logo').src = info.logo; else $('logo').hidden = true;
  initTips($('tip'));
  // the window was opened see-through: the page's own ground steps back so the desktop shows, blurred by Windows
  document.documentElement.classList.toggle('glass', Boolean(info.glass));
  // the hidden window of the self-test draws no frames: anything that fades in would stay invisible there
  document.documentElement.classList.toggle('still', Boolean(info.hidden));
  $('side-toggle').append(icon('side'));
  const toggleSide = () => kept.set('side', document.body.classList.toggle('no-side') ? '0' : '1');
  document.body.classList.toggle('no-side', kept.get('side', '1') === '0');
  $('side-toggle').addEventListener('click', toggleSide);
  $('triage').addEventListener('click', nextNeeding);
  $('new-chat').append(icon('plus', 14), h('span', { text: 'New chat' }));
  $('new-chat').addEventListener('click', openPicker);
  $('refresh').append(icon('refresh', 15));
  $('refresh').dataset.tip = 'Look again now (F5)\nYour sessions, the account Claude Code is logged in to, and the limits as your chats last reported them.\nA limit only moves when one of your chats next talks to Claude.';
  $('refresh').addEventListener('click', refreshNow);
  for (const [n, name, words] of [[1, 'tile-1', 'One chat on screen'], [2, 'tile-2', 'Two chats side by side'], [4, 'tile-4', 'Four chats on screen']]) {
    $('split').append(h('button', { data: { n: String(n) }, 'aria-label': words, tip: `${words}\nCtrl Shift Enter switches between one chat and the chats side by side.`, onclick: () => setTiles(n) }, icon(name, 15)));
  }
  $('jump').append(icon('search', 14), h('span', { text: 'Search sessions, commands, things you typed' }), h('kbd', { text: 'Ctrl Shift P' }));
  $('jump').addEventListener('click', () => Palette.open());
  $('inspector').hidden = !state.settings.inspector;
  initNotes($('notes'));

  let fontTimer = 0;
  Terms.init($('park'), $('tiles'), info, () => paint(), (size) => {
    state.settings.fontSize = size;
    clearTimeout(fontTimer);
    fontTimer = setTimeout(() => desk.settings({ fontSize: size }), 400);
  });
  for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
  const resumeHere = (e) => resume(e, true);
  const inspector = () => setInspector(!state.settings.inspector);
  const rename = (chatId) => { setView(chatId); ChatView.rename(); };
  const forget = (id) => { state.resumed.set(id, Date.now()); desk.forget(id); if (state.sel && state.sel.key === id) look(null); else paint(); };
  const spaceActs = { spaceOf, sortedBy, inView, switchSpace, addSpace, renameSpace, removeSpace, putFolder };
  Side.init($('side'), {
    session: sessionOf, label: chatLabel, sub: chatSub, mark: markFor, onScreen, elsewhere,
    focus: setView, look, go: setView, close: closeChat, rename, arm, disarm, attach, resume: resumeHere, forget,
    newChat: openPicker, settings: (section) => Settings.open(section), repaint: paint, ...spaceActs,
  });
  Peek.init($('peek'), { open: setView, attach, arm, disarm, resume: resumeHere, forget, rename, close: closeChat, look, elsewhere, newChat: openPicker, go: setView, space: spaceWords });
  // the chats open when the app last closed come back by themselves; asked about only when the person chose to start fresh
  if (info.previous.length && info.restore === 'ask') banner(info.previous);
  History.init($('history'), { open: setView, attach, arm, disarm, resume: resumeHere, rename, close: closeChat });
  Stats.init($('stats'), {
    range: (r) => { state.range = r; Stats.reset(); paint(); refreshUsage(true); },
    open: setView,
    show: showSession,
    read: readPast,
  });
  ChatView.init($('tiles'), $('inspector'), { session: sessionOf, label: chatLabel, close: closeChat, inspector, attach, arm, disarm, resume: resumeHere, focus: setView, big: toggleBig });
  Picker.init($('picker'), info, (id, chat) => {
    if (!id) { Terms.focus(); return; }
    // started inside a workspace, in a folder that is in none: the folder joins it, and the chat stays in sight
    if (chat) adopt(chat.cwd);
    setView(id);
  });
  const actions = { setView, showSession, openPicker, closeChat, nextNeeding, attach, arm, toggleSide, resume: resumeHere, read: readPast, session: sessionOf, label: chatLabel, mark: markFor,
    inspector, settings: () => Settings.open(), rename: () => { if (isChat(state.view)) ChatView.rename(); },
    big: toggleBig, tiles: setTiles, back: () => { back(1); endWalk(); },
    switchSpace, newSpace: () => { document.body.classList.remove('no-side'); Side.newSpace(); } };
  Palette.init($('palette'), state, actions);
  Settings.init($('settings'), state, {
    changed: (next) => {
      // what is not kept on disk stays as it is: which workspace is in front may have moved since the panel opened
      state.settings = { ...next, spaces: state.settings.spaces, space: state.settings.space };
      Terms.setFontSize(next.fontSize);
      $('inspector').hidden = !next.inspector;
      paint();
    },
    ...spaceActs,
  });
  for (const chat of state.chats) Terms.create(chat.id);

  desk.onOutput((id, data) => Terms.write(id, data));
  desk.onExit((id) => Terms.remove(id));
  desk.onChats(takeChats);
  desk.onSnapshot(takeSnapshot);
  desk.onRes((res) => { if (state.frozen) return; state.res = res; paint(); });
  desk.onCommand((name, arg) => {
    if (name === 'new') openPicker();
    else if (name === 'goto') goTo(arg);
    else if (name === 'stale') { state.stale = true; paint(); }
    else if (name === 'say') toast(String(arg || ''), 9000);
    else if (name === 'ask-leave') askLeave();
    else if (name === 'live' || name === 'seen' || name === 'away') {
      document.body.classList.toggle('live', name === 'live');
      state.seen = name !== 'away';
      if (state.seen) refreshUsage(false);
    }
  });

  window.addEventListener('pointerdown', () => { holding = true; }, true);
  for (const end of ['pointerup', 'pointercancel']) {
    // after the click this release belongs to has been delivered
    window.addEventListener(end, () => { holding = false; if (dirty) setTimeout(paint, 0); }, true);
  }
  // a pane that left itself alone because text was selected in it is brought up to date once the selection is gone
  document.addEventListener('selectionchange', () => {
    if (!held.skipped) return;
    const s = window.getSelection();
    if (s && !s.isCollapsed) return;
    held.skipped = false;
    paint();
  });

  // Before the terminal sees them. Ctrl with Alt is left alone: on many keyboards that is how @ # { [ are typed.
  const overlay = () => Picker.isOpen() || Palette.isOpen() || Settings.isOpen() || leaveOpen();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!overlay()) refreshNow();
      return;
    }
    if (!e.ctrlKey || e.altKey || e.metaKey) {
      // the keys of a page (Esc on a session looked at; J, K, the arrows, / and Esc in History), while nothing floats over it
      if (overlay() || !$('menu').hidden) return;
      const used = state.view === 'peek' ? Peek.key(e) : state.view === 'history' ? History.key(e) : false;
      if (used) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.shiftKey && e.code === 'KeyP') { if (!Picker.isOpen() && !Settings.isOpen()) Palette.toggle(); }
    else if (overlay()) return;
    else if (e.shiftKey && e.code === 'KeyT') openPicker();
    else if (e.shiftKey && e.code === 'KeyW' && isChat(state.view)) closeChat(state.view);
    else if (e.shiftKey && e.code === 'KeyN') nextNeeding();
    else if (e.shiftKey && e.code === 'KeyU') setView('stats');
    else if (e.shiftKey && e.code === 'KeyH') setView('history');
    else if (e.shiftKey && e.code === 'KeyI') inspector();
    else if (e.shiftKey && e.code === 'Enter') toggleBig();
    else if (!e.shiftKey && e.code === 'Comma') Settings.open();
    else if (e.code === 'Tab') back(e.shiftKey ? -1 : 1);
    else {
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (!digit) return;
      const n = Number(digit[1]);
      if (e.shiftKey) {
        // a workspace by its tab: Ctrl Shift 1 is every chat, 2 the first workspace, and so on
        const spaces = state.settings.spaces;
        if (!spaces.length || n > spaces.length + 1) return;
        switchSpace(n === 1 ? '' : spaces[n - 2].id);
      } else {
        // a chat by its place on screen: Ctrl 1 is the first place, and so on
        const id = state.shown.filter(visible)[n - 1];
        if (!id) return;
        setView(id);
      }
    }
    e.preventDefault();
    e.stopPropagation();
  }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Control') endWalk(); }, true);

  window.addEventListener('focus', () => {
    if (!overlay() && isChat(state.view)) Terms.focus();
    for (const c of state.snap.chats) if (c.chat === state.view) state.unread.delete(c.key);
    refreshUsage(false);
  });
  window.addEventListener('blur', endWalk);
  document.body.classList.toggle('live', document.hasFocus());

  // the marks that age on their own ("3m", "going for 2m 05s"), what a conversation being read has added, and the numbers
  let beat = 0;
  setInterval(() => {
    beat++;
    if (!state.seen) return;
    if (isChat(state.view)) ChatView.tick();
    else if (state.view === 'peek') Peek.tick();
    else if (state.view === 'history') History.tick();
    else Parts.tick($('stats'));
    if (beat % 10 === 0 && !holding) Side.render(state);
    else Side.tick();
    Parts.tick($('notes'));
    if (beat % 5 === 0) {
      // only the Dashboard shows them, and the limit line of the sidebar: away from it less often is enough
      if (state.view === 'stats' || Date.now() - usageAt > 30000) refreshUsage(false);
    }
  }, 1000);

  setView(rest());
  if (info.previous.length && (info.restore === 'auto' || info.restore === 'crash')) reopen(info.restore);
  // for the self-test, and for poking at from the developer tools
  window.Desk = { state, paint, setView, look, showSession, readPast, openPicker, closeChat, nextNeeding, arm, disarm, resume, setInspector, refreshUsage, setTiles, toggleBig, back, endWalk, onScreen,
    spaceOf, switchSpace, addSpace, renameSpace, removeSpace, putFolder,
    Terms, Side, Peek, History, Stats, ChatView, Picker, Palette, Settings, Detail, Reader };
}

boot();
