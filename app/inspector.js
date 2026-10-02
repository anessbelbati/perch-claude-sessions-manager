'use strict';
/* global desk, h, fill, icon, glyph, sync, folderOf, phrase, markOf, menuUnder, toast, Parts, Terms, Detail */
// The chats on screen. Each has a place of its own: a slim strip (which chat
// it is, what it is doing, how full its memory is; the rest shows on hover)
// and under it the room its terminal is drawn in. One, two or four share the
// screen, and the one that holds the keyboard is marked. Beside them, when
// asked for, the panel of that chat: the same pane a session gets when it is
// looked at from the sidebar, with its tool calls, its conversation as it can
// be read, the files it changed, its subagents and its numbers, live.

const ChatView = (() => {
  let grid = null;               // the places on screen
  let side = null;               // the panel beside them
  let act = null;
  let detail = null;
  let none = null;
  let noneStamp = '';
  let editing = '';              // the chat whose name is being typed
  let last = null;
  const tiles = new Map();       // chat id -> { id, el, head, body, stamp, doing, rest, wasOn }

  function init(gridEl, sideEl, actions) {
    grid = gridEl;
    side = sideEl;
    act = actions;
    none = h('div', { class: 'insp-empty', hidden: true });
    const host = h('div');
    side.append(none, host);
    detail = Detail.create(host, { attach: act.attach, arm: act.arm, disarm: act.disarm, resume: act.resume }, { compact: true });
  }

  /** One chat's place on screen, made the first time it is asked for. */
  function tileOf(id) {
    let t = tiles.get(id);
    if (t) return t;
    const head = h('div', { class: 'tile-head' });
    const body = h('div', { class: 'tile-body' });
    t = { id, el: h('div', { class: 'tile', data: { id } }, head, body), head, body, stamp: '', doing: null, rest: null, wasOn: false };
    // a press anywhere in a place gives its chat the keyboard
    t.el.addEventListener('pointerdown', () => {
      t.wasOn = Boolean(last) && last.view === id;
      if (!t.wasOn) act.focus(id);
    }, true);
    // the strip is a toolbar: a press on it does not take the keyboard away from the terminal
    head.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
    // as with a window's own title bar: a double click on the strip makes the chat big, and small again
    head.addEventListener('dblclick', (e) => { if (!e.target.closest('button, input')) act.big(); });
    tiles.set(id, t);
    return t;
  }

  /**
   * Lays out the chats that share the screen, each in its place, and hands every terminal its room.
   * ids: the chats on screen, by place; none when no chat is in front.
   */
  function place(state, ids) {
    last = state;
    const list = ids.map(tileOf);
    grid.dataset.n = String(list.length);
    sync(grid, list.map((t) => t.el));
    for (const t of list) t.el.classList.toggle('on', t.id === state.view);
    Terms.show(list.map((t) => ({ id: t.id, host: t.body })), state.view);
    for (const id of [...tiles.keys()]) if (!ids.includes(id)) tiles.delete(id);
  }

  function more(chat, s, target) {
    const copy = (text, what) => () => { desk.writeClipboard(text); toast(`Copied ${what}.`); };
    const big = last.settings.tiles === 1;
    const items = [
      { label: 'Rename', icon: 'pencil', run: () => rename() },
      last.chats.length > 1 && { label: big ? 'Back to the chats side by side' : 'Make this chat big', icon: big ? 'tile-2' : 'tile-1', key: 'Ctrl Shift Enter', run: () => act.big() },
      { label: 'Open its folder', icon: 'folder', run: () => desk.openFolder(chat.cwd) },
      { label: 'Copy the folder path', icon: 'copy', run: copy(chat.cwd, 'the path') },
    ].filter(Boolean);
    if (s && s.session && s.provider === 'claude') {
      items.push(null,
        { label: 'Copy the session id', icon: 'copy', run: copy(s.session, 'the session id') },
        { label: 'Copy the command that reopens it', icon: 'terminal', run: copy(`claude --resume ${s.session}`, 'the command') },
        { label: "Show the conversation's file", icon: 'file', run: async () => { if (!(await desk.showFile(s.key, ''))) toast('Its file could not be found.'); } });
    }
    items.push(null, { label: 'Close this chat', icon: 'x', key: 'Ctrl Shift W', danger: true, run: () => act.close(chat.id) });
    menuUnder(target, items);
  }

  /** The strip above one chat: its mark and name, what it is doing, how full its memory is, and its two buttons. */
  function drawHead(t, state, chat, s) {
    const on = state.view === chat.id;
    const label = act.label(chat);
    const unread = Boolean(s && state.unread.has(s.key));
    const panel = on && Boolean(state.settings.inspector);
    const stamp = JSON.stringify([chat.id, chat.cwd, label, chat.closing, panel, s && [s.key, s.state, s.waiting, s.background, s.doing, s.since, s.turn && [s.turn.start, s.turn.end],
      s.context, s.ceiling, s.limit, unread]]);
    if (stamp === t.stamp || editing === chat.id) return;
    t.stamp = stamp;
    const mark = chat.closing ? 'ended' : markOf(s, unread);
    const folder = folderOf(chat.cwd);
    const name = h('button', { class: 'th-name', text: label, title: 'Rename this chat', onclick: () => { if (t.wasOn) rename(); } });
    const id = h('div', { class: 'th-id' }, glyph(mark), name, folder !== label && h('span', { class: 'th-folder', text: folder, title: chat.cwd }));
    const doing = h('div', { class: `th-doing s-${mark}` });
    if (chat.closing) {
      doing.append(h('span', { class: 'words', text: 'Closing…' }));
    } else if (s) {
      const words = phrase(s) || (unread ? 'Finished' : '');
      if (words) doing.append(h('span', { class: 'words', text: words }));
      const going = s.state === 'working' && !s.background && s.turn && s.turn.start && !s.turn.end;
      if (going) doing.append(h('span', { class: 'timer', data: { since: s.turn.start } }));
      else if (s.state !== 'idle') doing.append(h('span', { class: 'timer', data: { time: s.since } }));
      if (s.limit && s.limit.until) doing.append(h('span', { class: 'timer' }, 'lifts in ', h('b', { data: { until: s.limit.until } })));
    }
    t.doing = doing;
    t.rest = h('div', { class: 'th-facts' }, s && Parts.memoryFact(s));
    const tools = h('div', { class: 'th-tools' },
      h('button', { class: `icon-btn${panel ? ' on' : ''}`, title: 'Show or hide the panel with its tool calls, its conversation and the files it changed (Ctrl+Shift+I)',
        'aria-pressed': String(panel), onclick: () => act.inspector() }, icon('panel')),
      h('button', { class: 'icon-btn', title: 'More', onclick: (e) => more(chat, s, e.currentTarget) }, icon('more')));
    fill(t.head, id, doing, t.rest, tools);
  }

  /**
   * What the strip leaves out, as the note that shows on hover: the model, the memory in tokens, what was used
   * today, the cache, and what everything under the chat's console holds on this computer. Measured every few
   * seconds, so it is written in without redrawing the strip.
   */
  function drawRest(t, state, chat, s) {
    if (!t.rest) return;
    const r = (state.res && state.res.chats[chat.id]) || null;
    const mine = s ? Parts.resOf(state, s) : null;
    const runs = mine ? Parts.itemsShort(mine, s) : '';
    const tip = `${Parts.restTip(s, r)}${runs ? `\nIt runs: ${runs}` : ''}`;
    for (const el of [t.rest, t.doing]) {
      if (tip) el.dataset.tip = tip; else delete el.dataset.tip;
    }
  }

  function drawSide(state, chat, s) {
    if (!state.settings.inspector) { detail.show(null, state); return; }
    none.hidden = Boolean(s);
    detail.el.hidden = !s;
    detail.show(s ? { kind: 'live', c: s } : null, state);
    if (s) return;
    const starter = state.info.starters.find((x) => x.id === chat.starter);
    const agent = Boolean(starter && starter.agent);
    if (noneStamp === `${chat.id}|${agent}`) return;
    noneStamp = `${chat.id}|${agent}`;
    fill(none,
      h('p', { text: agent ? 'Waiting for the session in this chat to show up…' : 'No agent session in this chat.' }),
      h('p', { class: 'quiet', text: agent ? 'It appears here a few seconds after the program starts.' : 'Type claude in the terminal to start one. Its tool calls, its conversation and its numbers then show here.' }));
  }

  function render(state) {
    last = state;
    for (const t of tiles.values()) {
      const chat = state.chats.find((c) => c.id === t.id);
      if (!chat) continue;
      const s = act.session(chat.id);
      drawHead(t, state, chat, s);
      drawRest(t, state, chat, s);
    }
    const front = state.chats.find((c) => c.id === state.view);
    if (front) drawSide(state, front, act.session(front.id));
    tick();
  }

  /** Lets the person type a name for the chat that has the keyboard. An empty name hands the naming back to the session. */
  function rename() {
    if (!last) return;
    const chat = last.chats.find((c) => c.id === last.view);
    const t = chat && tiles.get(chat.id);
    const button = t && t.head.querySelector('.th-name');
    if (!button || editing) return;
    editing = chat.id;
    const input = h('input', { class: 'th-rename', type: 'text', value: act.label(chat), maxlength: '120', spellcheck: 'false', 'aria-label': 'A name for this chat' });
    let over = false;
    const end = (save) => {
      if (over) return;
      over = true;
      editing = '';
      t.stamp = '';
      if (save && input.value.trim() !== act.label(chat)) desk.rename(chat.id, input.value);
      render(last);
      Terms.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') end(true);
      else if (e.key === 'Escape') end(false);
    });
    input.addEventListener('blur', () => end(true));
    button.replaceWith(input);
    input.focus();
    input.select();
  }

  function tick() {
    for (const t of tiles.values()) Parts.tick(t.head);
    if (!side.hidden) detail.tick();
  }

  return { init, place, render, rename, tick, detail: () => detail };
})();
