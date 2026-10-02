'use strict';
/* global desk, h, fill, icon, glyph, bar, sync, foldGroups, popMenu, menuUnder, labelOf, phrase, folderOf, limitName, clockShort, acctName, acctShort, planName, windowOf, forecast, Parts */
// The sidebar: every chat on this machine, once. The chats open in this window
// and the ones that run in other terminals stand in the same list, sorted by
// what they want from the person: the one that has waited longest on top, then
// the ones that finished unseen, the ones at work and the idle ones. A click on
// a chat of this window gives it the keyboard; a click on one that runs
// elsewhere shows it in the panel, where it can be moved here. Once there are
// workspaces, a row of tabs stands above the list and the list holds the chats
// of the workspace in front. Under the list: a usage limit that was reached,
// the account in use with its two limits, and the other places of the window.

const Side = (() => {
  const OLD_MS = 3 * 86400e3;
  const ENDED_SHOWN = 6;
  const GROUPS = [['needs', 'Needs you'], ['done', 'Finished'], ['working', 'Working'], ['idle', 'Idle'], ['old', 'Old background sessions'], ['ended', 'Ended in the last day']];
  const rows = new Map();        // row id -> { el, stamp, res }
  let root = null;
  let els = null;
  let act = null;
  let last = null;
  let allEnded = false;
  const folds = foldGroups('side-fold', () => { if (last) render(last); }, ['old', 'ended']);
  const $ = (id) => document.getElementById(id);

  function init(el, actions) {
    root = el;
    act = actions;
    els = { list: $('chat-list'), n: $('side-n'), label: $('side-label'), spaces: $('spaces'), more: $('side-more'), empty: $('side-empty'), limit: $('side-limit'), acct: $('acct') };
    els.more.append(icon('more', 14));
    els.more.addEventListener('click', () => moreMenu());
    els.list.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('nav-item')) { e.preventDefault(); e.target.click(); }
    });
    els.acct.addEventListener('click', () => act.go('stats'));
    $('go-history').addEventListener('click', () => act.go('history'));
    $('go-stats').addEventListener('click', () => act.go('stats'));
    $('open-settings').append(icon('settings'));
    $('open-settings').addEventListener('click', () => act.settings());
  }

  function moreMenu() {
    const n = act.elsewhere();
    const coming = last ? last.armed.size : 0;
    const spaces = last ? last.settings.spaces || [] : [];
    menuUnder(els.more, [
      { label: 'New chat', icon: 'plus', key: 'Ctrl Shift T', run: () => act.newChat() },
      n > 0 && { label: `Bring the ${n} in other terminals here`, icon: 'bring', run: () => act.arm(null) },
      coming > 0 && { label: coming === 1 ? 'Cancel the one that is coming here' : `Cancel the ${coming} that are coming here`, icon: 'x', run: () => act.disarm() },
      null,
      { label: 'New workspace…', icon: 'layers', run: () => newSpace() },
      spaces.length > 0 && { label: 'Workspaces and their folders…', icon: 'settings', run: () => act.settings('spaces') },
    ].filter((it) => it !== false));
  }

  // ---- the workspaces: "All", one tab each, and what is still unsorted. A tab says in yellow how many of its
  // ---- chats wait for the person while another one is in front. ----
  let edit = null;               // a name being typed: { id, name, el }; id '' is a workspace that is being made
  function newSpace() {
    // asked for again while its name is still being typed: the same field, not a second one
    if (edit && edit.el && edit.el.isConnected) { edit.el.focus(); return; }
    edit = { id: '', name: '', el: null };
    if (last) render(last);
    if (edit && edit.el) edit.el.focus();
  }
  function spaceMenu(id, px, py) {
    const s = (last.settings.spaces || []).find((x) => x.id === id);
    if (!s) return;
    popMenu(px, py, [
      { label: 'Rename', icon: 'pencil', run: () => { edit = { id, name: s.name, el: null }; render(last); if (edit && edit.el) { edit.el.focus(); edit.el.select(); } } },
      { label: 'Its folders…', icon: 'folder', run: () => act.settings('spaces') },
      null,
      { label: 'Take this workspace away', icon: 'x', danger: true, run: () => act.removeSpace(id) },
    ]);
  }
  function nameBox() {
    const input = h('input', { type: 'text', class: 'space-input', maxlength: '24', spellcheck: 'false', placeholder: 'Name it', value: edit.name,
      'aria-label': edit.id ? 'A new name for the workspace' : 'A name for the new workspace' });
    const end = (keep) => {
      if (!edit || edit.el !== input) return;
      const was = edit;
      edit = null;
      if (keep && input.value.trim()) { if (was.id) act.renameSpace(was.id, input.value); else act.addSpace(input.value); }
      // The window's own drawing waits while a mouse button is down. A press on a tab takes the keyboard from this
      // field first: drawn again at once, the tab would be swapped under the pointer and the press lost.
      act.repaint();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); end(true); }
      else if (e.key === 'Escape') { e.preventDefault(); end(false); }
    });
    input.addEventListener('blur', () => end(true));
    edit.el = input;
    return input;
  }
  function drawSpaces(state, every) {
    const spaces = state.settings.spaces || [];
    const on = spaces.length > 0 || Boolean(edit);
    els.spaces.hidden = !on;
    els.label.hidden = on;
    els.n.hidden = on;
    if (!on) {
      if (els.spaces.childElementCount) fill(els.spaces);
      els.spaces.dataset.stamp = '';
      return;
    }
    // a name is being typed: the row is left as it is until that is over
    if (edit && edit.el && edit.el.isConnected) return;
    const count = new Map();
    const needs = new Map();
    let total = 0;
    for (const x of every) {
      if (x.group === 'old') continue;
      const id = act.spaceOf(x.cwd) || '?';
      total++;
      count.set(id, (count.get(id) || 0) + 1);
      if (x.group === 'needs') needs.set(id, (needs.get(id) || 0) + 1);
    }
    const cur = state.loose ? '?' : state.settings.space;
    const stamp = JSON.stringify([spaces.map((s) => [s.id, s.name]), cur, [...count], [...needs], total, edit && [edit.id]]);
    if (els.spaces.dataset.stamp === stamp) return;
    els.spaces.dataset.stamp = stamp;
    const tab = (id, name, n, wait, lines) => {
      const active = cur === id;
      const tip = [lines[0], `${n} chat${n === 1 ? '' : 's'}${wait ? ` · ${wait} need${wait === 1 ? 's' : ''} you` : ''}`, ...lines.slice(1)].filter(Boolean).join('\n');
      return h('button', {
        class: `space-tab${active ? ' on' : ''}`, role: 'tab', 'aria-selected': String(active), data: { space: id }, tip,
        onclick: () => act.switchSpace(id === '?' ? '' : id, id === '?'),
        oncontextmenu: id && id !== '?' ? (e) => { e.preventDefault(); spaceMenu(id, e.clientX, e.clientY); } : null,
      }, h('span', { class: 'space-name', text: name }),
      // the title bar already counts everyone who waits: a tab says it for its own chats only
      id !== '' && !active && wait > 0 && h('span', { class: 'space-n', text: String(wait) }));
    };
    const kids = [tab('', 'All', total, [...needs.values()].reduce((a, b) => a + b, 0), ['Every chat on this machine', 'Ctrl Shift 1'])];
    spaces.forEach((s, i) => {
      if (edit && edit.id === s.id) { kids.push(nameBox()); return; }
      kids.push(tab(s.id, s.name, count.get(s.id) || 0, needs.get(s.id) || 0, [s.name, i < 8 ? `Ctrl Shift ${i + 2}` : '', 'Right-click to rename it or take it away.']));
    });
    // a new one is named where its tab will stand
    if (edit && !edit.id) kids.push(nameBox());
    // what is in no workspace yet: there while something is, and while it is being looked at
    if (spaces.length && (count.get('?') || cur === '?')) {
      kids.push(tab('?', 'Unsorted', count.get('?') || 0, needs.get('?') || 0, ['The chats that are in no workspace yet', 'Right-click a chat to put its folder in a workspace.']));
    }
    fill(els.spaces, kids);
  }

  /** What a row's menu offers once there are workspaces: which one its folder belongs to. */
  function spaceItems(cwd) {
    const spaces = last.settings.spaces || [];
    if (!spaces.length || !cwd) return [];
    const at = act.spaceOf(cwd);
    return [
      null,
      { heading: `"${folderOf(cwd)}" and the folders in it are in` },
      ...spaces.map((s) => ({ label: s.name, on: at === s.id, run: () => act.putFolder(cwd, s.id) })),
      { label: 'No workspace', on: !at, run: () => act.putFolder(cwd, '') },
    ];
  }

  /** A background session nobody runs any more and nobody answered for days is kept out of the way. */
  const isOld = (c, now) => c.kind === 'bg' && !c.pid && now - c.at > OLD_MS;
  function groupOf(c, state, now) {
    if (isOld(c, now)) return 'old';
    if (c.state === 'attention' || c.state === 'error') return 'needs';
    if (c.state === 'working' || c.state === 'compacting') return 'working';
    return state.unread.has(c.key) ? 'done' : 'idle';
  }
  /** Among the chats at work and the idle ones nothing moves: the ones of this window first, then by when they started. */
  const steady = (a, b) => (a.kind === 'away') - (b.kind === 'away') || a.born - b.born || (a.id < b.id ? -1 : 1);
  const longest = (a, b) => a.since - b.since || (a.id < b.id ? -1 : 1);
  const ORDER = { needs: longest, done: longest, working: steady, idle: steady, old: (a, b) => b.since - a.since };

  /** Every chat on the machine as a row to be: the chats of this window, then every session that is not in one of them. */
  function listOf(state, now) {
    const here = new Map(state.chats.map((c) => [c.id, c]));
    const onScreen = act.onScreen();
    const peeked = state.view === 'peek' && state.sel && state.sel.kind === 'live' ? state.sel.key : '';
    const used = new Set();
    const out = [];
    // a chat's place is counted among the chats of the workspace in front
    const order = state.shown.filter((id) => here.has(id) && act.inView(here.get(id).cwd));
    const hereRow = (id, chat, c, label, sub) => {
      const place = order.indexOf(chat.id);
      const group = chat.closing || !c ? 'idle' : groupOf(c, state, now);
      return { id, kind: 'here', chat, c, key: c ? c.key : '', label, sub, mark: chat.closing ? 'ended' : act.mark(c), group: group === 'old' ? 'idle' : group,
        since: c ? c.since : 0, born: chat.startedAt, on: state.view === chat.id, shown: onScreen.includes(chat.id), place: place >= 0 && place < 4 ? place + 1 : 0, cwd: chat.cwd };
    };
    for (const chat of state.chats) {
      const c = act.session(chat.id);
      if (c) used.add(c.key);
      out.push(hereRow(`chat:${chat.id}`, chat, c, act.label(chat), act.sub(chat)));
    }
    for (const c of state.snap.chats) {
      if (used.has(c.key)) continue;
      const chat = (c.chat && here.get(c.chat)) || null;
      const sub = phrase(c) || (state.unread.has(c.key) ? 'Finished' : 'Idle');
      // a second session in a chat of this window: listed too, and it leads to that chat
      if (chat) { out.push(hereRow(`live:${c.key}`, chat, c, labelOf(c), sub)); continue; }
      out.push({ id: `live:${c.key}`, kind: 'away', chat: null, c, key: c.key, label: labelOf(c), sub, mark: act.mark(c), group: groupOf(c, state, now),
        since: c.since, born: c.started || c.at, on: peeked === c.key, shown: false, place: 0, cwd: c.cwd });
    }
    return out;
  }

  function pick(x) {
    if (x.kind === 'here') act.focus(x.chat.id);
    else if (x.kind === 'ended') act.look({ kind: 'ended', key: x.e.id });
    else act.look({ kind: 'live', key: x.key });
  }

  function menu(x, px, py) {
    if (x.kind === 'here') {
      popMenu(px, py, [
        { label: 'Rename', icon: 'pencil', run: () => act.rename(x.chat.id) },
        { label: 'Open its folder', icon: 'folder', run: () => desk.openFolder(x.chat.cwd) },
        ...spaceItems(x.chat.cwd),
        null,
        { label: 'Close this chat', icon: 'x', key: 'Ctrl Shift W', danger: true, run: () => act.close(x.chat.id) },
      ]);
      return;
    }
    if (x.kind === 'ended') {
      popMenu(px, py, [
        { label: 'Resume here', icon: 'play', run: () => act.resume(x.e) },
        { label: 'Look at it', icon: 'arrow-right', run: () => pick(x) },
        ...spaceItems(x.e.cwd),
        null,
        { label: 'Take it off this list', icon: 'x', run: () => act.forget(x.e.id) },
      ]);
      return;
    }
    const c = x.c;
    const items = [];
    if (c.kind === 'bg' && c.job) items.push({ label: 'Open here', icon: 'terminal', run: () => act.attach(c) });
    else if (c.provider === 'claude' && c.pid && c.session) {
      items.push(last.armed.has(c.session) ? { label: 'Leave it where it is', icon: 'x', run: () => act.disarm(c.session) } : { label: 'Bring here', icon: 'bring', run: () => act.arm([c.session]) });
    }
    items.push({ label: 'Look at it', icon: 'arrow-right', run: () => pick(x) });
    if (c.cwd) items.push({ label: 'Open its folder', icon: 'folder', run: () => desk.openFolder(c.cwd) });
    items.push(...spaceItems(c.cwd));
    popMenu(px, py, items);
  }

  function buildRow(x, armed) {
    // a chat that waits says for how long; any other says what its programs hold on this computer, written in as it is measured
    const waits = x.kind === 'ended' || x.group === 'needs' || x.group === 'done';
    const res = waits ? null : h('span', { class: 'res' });
    const el = h('div', {
      class: `nav-item chat k-${x.kind}${x.on ? ' on' : ''}${x.shown ? ' shown' : ''}${x.chat && x.chat.closing ? ' closing' : ''}`, role: 'button', tabindex: '0', 'aria-current': x.on ? 'true' : 'false',
      data: { row: x.id, id: x.kind === 'here' ? x.chat.id : '', key: x.key, sub: x.sub, mark: x.mark },
      onclick: () => pick(x), oncontextmenu: (e) => { e.preventDefault(); menu(x, e.clientX, e.clientY); },
      ondblclick: x.kind === 'ended' ? () => act.resume(x.e) : null,
    },
    glyph(x.mark, 13),
    h('span', { class: 'label', text: x.label }),
    waits ? h('span', { class: `when${x.group === 'needs' ? ' needs' : ''}`, data: { time: x.since } }) : res,
    x.kind === 'away' && icon(armed ? 'bring' : 'external', 12, `out${armed ? ' coming' : ''}`),
    x.kind === 'here' && h('button', { class: 'x', title: 'Close this chat (Ctrl+Shift+W)', onclick: (e) => { e.stopPropagation(); act.close(x.chat.id); } }, icon('x', 12)));
    return { el, res };
  }

  /** What a row's hover note says before the measurements: its name, what it is doing, where it is. */
  function baseTip(x, armed) {
    const lines = [x.label];
    if (x.sub) lines.push(x.sub);
    if (x.cwd) lines.push(x.cwd);
    if (x.kind === 'ended') lines.push('Its program has ended. Click to look at it, double-click to pick it up again here.');
    else if (x.kind === 'away') {
      lines.push(x.c.kind === 'bg' ? 'A background session: it runs outside every terminal. Click to look at it.'
        : armed ? 'It opens here as soon as you close it where it runs now.' : 'It runs in another terminal. Click to look at it, and to move it here.');
    } else if (x.place) lines.push(`Ctrl ${x.place}`);
    return lines.join('\n');
  }

  function render(state) {
    last = state;
    const now = Date.now();
    const every = listOf(state, now);
    drawSpaces(state, every);
    // with workspaces, the list holds what the one in front holds
    const list = every.filter((x) => act.inView(x.cwd));
    const by = new Map(GROUPS.map(([id]) => [id, []]));
    for (const x of list) by.get(x.group).push(x);
    for (const [id, items] of by) if (ORDER[id]) items.sort(ORDER[id]);
    const endedSel = state.view === 'peek' && state.sel && state.sel.kind === 'ended' ? state.sel.key : '';
    const ended = (state.snap.ended || []).filter((e) => !state.resumed.has(e.id) && act.inView(e.cwd));
    for (const e of allEnded ? ended : ended.slice(0, ENDED_SHOWN)) {
      by.get('ended').push({ id: `ended:${e.id}`, kind: 'ended', chat: null, c: null, e, key: e.id, label: labelOf(e), sub: e.cut ? 'Ended while it was still working' : 'Ended', mark: 'ended',
        group: 'ended', since: e.at, born: e.at, on: endedSel === e.id, shown: false, place: 0, cwd: e.cwd });
    }

    const seen = new Set();
    const kids = [];
    for (const [gid, title] of GROUPS) {
      const items = by.get(gid);
      if (!items.length) continue;
      const sec = folds.draw(gid, title, gid === 'ended' ? ended.length : items.length);
      const els_ = [];
      for (const x of items) {
        seen.add(x.id);
        const armed = Boolean(x.c && state.armed.has(x.c.session));
        // a row is rebuilt only when something it shows changed
        const stamp = JSON.stringify([x.kind, x.label, x.sub, x.mark, x.group, x.on, x.shown, x.place, x.cwd, x.chat && x.chat.closing, armed, x.c && x.c.kind,
          (x.kind === 'ended' || x.group === 'needs' || x.group === 'done') && x.since]);
        let row = rows.get(x.id);
        if (!row || row.stamp !== stamp) rows.set(x.id, row = { ...buildRow(x, armed), stamp, base: baseTip(x, armed) });
        // Everything under a chat's console (the console itself, the agent, what the agent started), or what a
        // session elsewhere holds. The line is narrow, so it says the RAM only; the rest is in the note.
        const r = x.kind === 'here' ? (state.res && state.res.chats[x.chat.id]) || null : x.c ? Parts.resOf(state, x.c) : null;
        if (row.res) {
          const text = r ? Parts.ramText(r.mem) : '';
          if (row.res.textContent !== text) row.res.textContent = text;
        }
        const mine = x.c ? Parts.resOf(state, x.c) : null;
        const runs = mine ? Parts.itemsShort(mine, x.c) : '';
        row.el.dataset.tip = r ? `${row.base}\n\n${Parts.resTip(r, x.kind === 'here' ? 'This chat' : 'This session')}${runs ? `\nIt runs: ${runs}` : ''}` : row.base;
        els_.push(row.el);
      }
      if (gid === 'ended' && ended.length > ENDED_SHOWN) {
        const moreId = `more:${allEnded}:${ended.length}`;
        seen.add(moreId);
        let row = rows.get(moreId);
        if (!row) rows.set(moreId, row = { el: h('button', { class: 'side-all link', text: allEnded ? 'Show fewer' : `Show all ${ended.length}`, onclick: () => { allEnded = !allEnded; if (last) render(last); } }), stamp: '', res: null });
        els_.push(row.el);
      }
      sync(sec.inner, els_);
      kids.push(sec.el);
    }
    sync(els.list, kids);
    for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
    folds.keep(kids);
    const running = list.filter((x) => x.group !== 'old').length;
    els.n.textContent = running ? String(running) : '';
    els.empty.hidden = kids.length > 0;
    if (!els.empty.hidden) {
      const words = state.loose ? 'Nothing is left to sort: every chat is in a workspace.'
        : state.settings.space ? 'No chat of this workspace is running. Start one with New chat: its folder joins this workspace.'
          : 'No chat is running on this machine. Start one with New chat.';
      if (els.empty.textContent !== words) els.empty.textContent = words;
    }

    drawLimit(state, now);
    drawAccount(state, now);
    place('go-history', 'history', 'History', state.view === 'history');
    place('go-stats', 'usage', 'Dashboard', state.view === 'stats');
    // the times just drawn get their text now, not a second from now
    Parts.tick(root, now);
  }

  function place(id, name, label, on) {
    const el = $(id);
    el.classList.toggle('on', on);
    el.setAttribute('aria-current', on ? 'page' : 'false');
    if (el.dataset.stamp === label) return;
    el.dataset.stamp = label;
    fill(el, icon(name), h('span', { class: 'label', text: label }));
  }

  /** A usage limit that was reached and has not lifted yet: one line above the account, until it lifts. */
  function drawLimit(state, now) {
    let found = null;
    for (const c of state.snap.chats) if (c.limit && c.limit.until > now && (!found || c.limit.until > found.until)) found = c.limit;
    for (const l of state.usage ? state.usage.limits : []) if (l.until > now && (!found || l.until > found.until)) found = l;
    els.limit.hidden = !found;
    if (!found) return;
    const stamp = `${found.type}|${found.until}`;
    if (els.limit.dataset.stamp === stamp) return;
    els.limit.dataset.stamp = stamp;
    const name = limitName(found.type);
    els.limit.dataset.tip = `You reached the ${name}.\nIt lifts at ${clockShort(found.until)}.\nRead from what Claude Code wrote in the chats that ran into it.`;
    fill(els.limit, icon('gauge', 14), h('span', { class: 'words' }, `${name.replace(/^./, (ch) => ch.toUpperCase())} reached`), h('span', { class: 'r' }, 'lifts in ', h('b', { data: { left: found.until, zero: 'a moment' } })));
  }

  /** One usage limit of the account in use: a line that fills, how much is used, how long until it resets. f: where it is heading. */
  function limitRow(short, label, w, pace, f) {
    const k = h('span', { class: 'k', text: short });
    if (!w) return h('div', { class: 'slim none' }, k, bar(0), h('span', { class: 'r', text: 'no reading yet' }));
    if (!w.open) return h('div', { class: 'slim fresh', tip: 'The last one ended. A new one starts with your next message.' }, k, bar(0), h('span', { class: 'r', text: 'fresh' }));
    // one that will be used up before it resets is pointed out before it is nearly full
    const tone = w.tone || (f && f.full ? 'warm' : '');
    return h('div', { class: `slim ${tone}`, tip: Parts.limitTip(label, w, pace, f) }, k, bar(w.used / 100, tone, f ? f.at / 100 : 0), h('b', { text: `${Math.round(w.used)}%` }), h('span', { class: 'r', data: { left: w.until } }));
  }

  /** The account in use: who, how much of its two limits is used, and, once it runs out, which other account has the most room. */
  function drawAccount(state, now) {
    const v = Parts.acctView(state);
    const me = v.me;
    const card = els.acct;
    const five = me ? windowOf(me.five, now) : null;
    const week = me ? windowOf(me.week, now) : null;
    const f5 = five && five.open ? forecast(me.five, me.pace.five, now) : null;
    const fw = week && week.open ? forecast(me.week, me.pace.week, now) : null;
    const tight = Boolean((five && five.open && five.used >= 90) || (f5 && f5.full) || (week && week.open && week.used >= 90));
    // the person does the switching: the app only points at the one with the most room, as last seen on this machine
    const best = tight ? Parts.roomiest(v.list, now) : null;
    const told = (w) => w && [w.used, w.until, Math.floor(w.at / 60e3), w.until > now];
    const stamp = JSON.stringify([v.known, me && [me.key, me.email, me.plan, told(me.five), told(me.week), me.pace, f5 && [Math.round(f5.at), Boolean(f5.full)], fw && [Math.round(fw.at), Boolean(fw.full)]], v.names, best && best.key]);
    if (card.dataset.stamp === stamp) return;
    card.dataset.stamp = stamp;
    const plan = me ? planName(me.plan) : '';
    if (me) card.dataset.tip = `${acctName(me, v.names)}\nThe account Claude Code is logged in to on this machine.\nClick for the Dashboard: every account, and what was done under each.`;
    else delete card.dataset.tip;
    fill(card,
      me && h('div', { class: 'acct-top' }, h('span', { class: 'acct-name', text: acctShort(me, v.names) }), plan && h('span', { class: 'acct-plan', text: plan })),
      me && limitRow('5h', '5-hour limit', five, me.pace.five, f5),
      me && limitRow('Week', 'weekly limit', week, me.pace.week, fw),
      best && h('div', { class: 'acct-room', tip: `The most room of your other accounts, as last seen on this machine.\n\n${Parts.restingTip(best, v.names, now)}` }, 'most room: ', h('b', { text: acctShort(best, v.names) })),
      !me && h('div', { class: 'acct-top' }, h('span', { class: 'acct-name', text: v.known ? 'Not logged in' : 'Looking for your account…' })));
  }

  /** Brings one session's row into view; its group is unfolded if need be. */
  function reveal(key) {
    const find = () => els.list.querySelector(`.nav-item[data-key="${CSS.escape(key)}"]`);
    let el = find();
    if (!el) return;
    const sec = el.closest('.group');
    if (sec && sec.classList.contains('folded')) {
      folds.set(sec.dataset.group, false);
      if (last) render(last);
      el = find();
      if (!el) return;
    }
    el.scrollIntoView({ block: 'nearest' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  }

  return { init, render, reveal, newSpace, tick: () => { if (root) Parts.tick(root); } };
})();
