'use strict';
/* global desk, h, icon, ago, folderOf */
// The "New chat" panel: which program to start, in which folder, or which
// past conversation to pick up again.

const Picker = (() => {
  let root = null;
  let info = null;
  let done = () => {};
  let folders = [];
  let recent = [];
  let starter = '';
  let filter = '';
  let chosen = 0;
  let busy = false;
  let els = null;
  // with workspaces: which folders stand first (those of the one in front), and what each folder is tagged with
  let ways = { first: null, tag: () => '', note: '' };

  const isOpen = () => root && !root.hidden;
  const tidy = (p) => (info.home && p.toLowerCase().startsWith(info.home.toLowerCase()) ? '~' + p.slice(info.home.length) : p);

  function init(el, deskInfo, onStarted) {
    root = el;
    info = deskInfo;
    done = onStarted;
    els = {
      starters: h('div', { class: 'seg' }),
      filter: h('input', { type: 'text', class: 'input', placeholder: 'Type to filter, or paste a full path', spellcheck: 'false', 'aria-label': 'Folder' }),
      folders: h('div', { class: 'list folders' }),
      recent: h('div', { class: 'list recent' }),
      note: h('p', { class: 'quiet pick-note', hidden: true }),
      error: h('p', { class: 'error', hidden: true }),
      start: h('button', { class: 'btn primary', text: 'Start chat', onclick: () => start() }),
    };
    els.filter.addEventListener('input', () => { filter = els.filter.value; chosen = 0; drawFolders(); });
    root.append(h('div', { class: 'dialog', role: 'dialog', 'aria-label': 'New chat' },
      h('h2', { text: 'New chat' }),
      h('div', { class: 'field' }, h('label', { text: 'Start with' }), els.starters),
      h('div', { class: 'field' }, h('label', { text: 'In this folder' }),
        h('div', { class: 'pathrow' }, els.filter, h('button', { class: 'btn', text: 'Browse…', onclick: browse })),
        els.folders, els.note),
      h('div', { class: 'field' }, h('label', { text: 'Or pick up a past conversation' }), els.recent),
      els.error,
      h('div', { class: 'foot' },
        h('span', { class: 'hint', text: 'Enter starts in the highlighted folder · Esc closes' }),
        h('button', { class: 'btn ghost', text: 'Cancel', onclick: close }),
        els.start)));
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') move(e.key === 'ArrowDown' ? 1 : -1);
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') start();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function shown() {
    const q = filter.trim().toLowerCase();
    const list = folders.filter((p) => !q || p.toLowerCase().includes(q));
    // a typed path that is not on the list is offered as it is; the main process checks it exists
    if (/^[a-z]:[\\/]/i.test(filter.trim()) && !list.some((p) => p.toLowerCase() === q)) list.unshift(filter.trim());
    return list;
  }

  function move(step) {
    const list = shown();
    if (!list.length) return;
    chosen = (chosen + step + list.length) % list.length;
    drawFolders();
    const el = els.folders.children[chosen];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function drawStarters() {
    els.starters.replaceChildren(...info.starters.map((s) => h('button', {
      class: s.id === starter ? 'on' : '', text: s.name, 'aria-pressed': String(s.id === starter), onclick: () => { starter = s.id; drawStarters(); },
    })));
  }

  function drawFolders() {
    const list = shown();
    if (chosen >= list.length) chosen = Math.max(0, list.length - 1);
    els.folders.replaceChildren(...list.map((p, i) => h('div', {
      class: `pick${i === chosen ? ' on' : ''}`, onclick: () => { chosen = i; drawFolders(); }, ondblclick: () => { chosen = i; start(); },
    }, icon('folder', 14), h('span', { class: 'name', text: folderOf(p) }), h('span', { class: 'path', text: tidy(p) }), ways.tag(p) && h('span', { class: 'tag', text: ways.tag(p) }))));
    if (!list.length) els.folders.append(h('p', { class: 'quiet', text: 'No folder matches. Paste a full path, or use Browse.' }));
  }
  /** The folders of the workspace in front stand first; among themselves, both parts keep their order. */
  const sorted = (list) => (ways.first ? [...list.filter((p) => ways.first(p)), ...list.filter((p) => !ways.first(p))] : list);

  function drawRecent(loading) {
    if (loading) { els.recent.replaceChildren(h('p', { class: 'quiet', text: 'Looking for past conversations…' })); return; }
    els.recent.replaceChildren(...recent.map((r) => h('div', { class: 'pick', onclick: () => start({ cwd: r.cwd, resume: r.id, mode: r.mode }) },
      h('span', { class: 'name', text: r.title || r.prompt || 'Untitled conversation' }),
      h('span', { class: 'path', text: folderOf(r.cwd) }),
      h('span', { class: 'when', text: ago(r.at) }))));
    if (!recent.length) els.recent.append(h('p', { class: 'quiet', text: 'No past conversations found.' }));
  }

  async function browse() {
    const picked = await desk.pickFolder();
    if (!picked) { els.filter.focus(); return; }
    filter = picked;
    els.filter.value = picked;
    chosen = 0;
    drawFolders();
    els.start.focus();
  }

  function fail(text) {
    els.error.textContent = text;
    els.error.hidden = !text;
  }

  async function start(ask) {
    if (busy) return;
    const cwd = ask ? ask.cwd : shown()[chosen];
    if (!cwd) { fail('Pick a folder first.'); return; }
    busy = true;
    const chat = await desk.create({ starter, cwd, ...(ask || {}) });
    busy = false;
    if (!chat || chat.error) { fail((chat && chat.error) || 'The chat could not be started.'); return; }
    info.starter = ask ? info.starter : starter;
    close(true);
    done(chat.id, chat);
  }

  /**
   * known: folders already in sight (the open chats', the running sessions'), best guess first.
   * how: { first(path), tag(path), note } while there are workspaces (see `ways`).
   */
  async function open(known, how) {
    if (isOpen()) return;
    ways = { first: null, tag: () => '', note: '', ...(how || {}) };
    starter = info.starter;
    const seen = new Set();
    // one folder once, however it was written
    folders = sorted(known.filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())));
    filter = '';
    chosen = 0;
    els.filter.value = '';
    els.note.textContent = ways.note;
    els.note.hidden = !ways.note;
    fail('');
    root.hidden = false;
    drawStarters();
    drawFolders();
    drawRecent(true);
    els.filter.focus();
    const found = await desk.recent();
    if (!isOpen()) return;
    const have = new Set(folders.map((p) => p.toLowerCase()));
    for (const p of found.folders) if (!have.has(p.toLowerCase())) { have.add(p.toLowerCase()); folders.push(p); }
    // the folder that was highlighted stays the one that is, wherever the newly found ones land
    const was = shown()[chosen];
    folders = sorted(folders);
    const at = shown().indexOf(was);
    if (at >= 0) chosen = at;
    recent = found.chats;
    drawFolders();
    drawRecent(false);
  }

  /** started: a chat was started, and whoever opened the panel is told about that chat instead. */
  function close(started) {
    if (!isOpen()) return;
    root.hidden = true;
    if (started !== true) done('');
  }

  return { init, open, close, isOpen };
})();
