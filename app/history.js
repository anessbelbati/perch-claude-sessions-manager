'use strict';
/* global desk, h, fill, icon, glyph, kept, sync, foldGroups, count, bytes, whole, folderOf, modelName, markOf, whenShort, dateTime, Detail, Parts */
// The History view: every conversation Claude Code still keeps on this machine, newest first, by date or by
// project. Pick one and it can be read as it was, with the files it changed, and picked up again in a chat of
// this window.

const History = (() => {
  const FRESH_MS = 60e3;         // how old the list may be before it is asked for again while the view is open
  const rows = new Map();        // conversation id -> { el, stamp }
  let root = null;
  let els = null;
  let act = null;
  let detail = null;
  let last = null;
  let data = null;               // { at, list, total, bytes, counting }, as the watcher last listed them
  let asked = 0;
  let busy = false;
  let query = '';
  let sel = '';
  let picked = false;            // the person chose a conversation, or chose to look at none
  let order = [];
  let groupBy = kept.get('hist-group', 'date') === 'project' ? 'project' : 'date';
  const folds = foldGroups('hist-fold', () => draw());

  const titleOf = (r) => r.name || r.title || String(r.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Untitled conversation';

  function init(el, actions) {
    root = el;
    act = actions;
    els = {
      total: h('span', { class: 'list-n' }),
      seg: h('div', { class: 'seg' }),
      filter: h('input', { type: 'text', class: 'input', placeholder: 'Find a conversation', spellcheck: 'false', 'aria-label': 'Find a conversation' }),
      groups: h('div', { class: 'groups', role: 'listbox', 'aria-label': 'Conversations' }),
      empty: h('p', { class: 'empty', hidden: true }),
      foot: h('p', { class: 'list-foot quiet', hidden: true }),
      none: h('div', { class: 'blank' }),
      detail: h('div', { hidden: true }),
    };
    for (const [id, name] of [['date', 'By date'], ['project', 'By project']]) {
      els.seg.append(h('button', { text: name, data: { by: id }, onclick: () => { groupBy = id; kept.set('hist-group', id); draw(); } }));
    }
    els.filter.addEventListener('input', () => { query = els.filter.value.trim().toLowerCase(); draw(); });
    els.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); els.filter.value = ''; query = ''; draw(); els.filter.blur(); }
      else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); els.filter.blur(); move(1); }
    });
    root.append(h('div', { class: 'split' },
      h('div', { class: 'list-pane' },
        h('div', { class: 'list-top' },
          h('div', { class: 'list-title' }, h('h1', { text: 'History' }), els.total,
            h('button', { class: 'icon-btn', title: 'Look again', onclick: () => refresh(true) }, icon('refresh'))),
          h('label', { class: 'filter-box' }, icon('search', 14), els.filter, h('kbd', { text: '/' })),
          els.seg),
        h('div', { class: 'list-scroll' }, els.groups, els.empty, els.foot)),
      h('div', { class: 'detail-pane' }, els.none, els.detail)));
    detail = Detail.create(els.detail, {
      open: act.open, attach: act.attach, arm: act.arm, disarm: act.disarm, resume: act.resume, rename: act.rename, close: act.close,
      dismiss: () => select(''),
    });
  }

  async function refresh(force) {
    if (busy || (!force && Date.now() - asked < FRESH_MS)) return;
    busy = true;
    asked = Date.now();
    const found = await (History.fake ? History.fake() : desk.history());
    busy = false;
    if (!found || !Array.isArray(found.list)) return;
    data = found;
    draw();
  }

  function select(id) {
    sel = id;
    picked = true;
    draw();
  }

  /** Which heading a conversation last active at `at` goes under, by date: [id, title]. */
  function bucket(at, start) {
    if (at >= start) return ['d0', 'Today'];
    if (at >= start - 86400e3) return ['d1', 'Yesterday'];
    if (at >= start - 6 * 86400e3) return ['d7', 'The last 7 days'];
    if (at >= start - 29 * 86400e3) return ['d30', 'The last 30 days'];
    const d = new Date(at);
    return [`m${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`, d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })];
  }

  function buildRow(r, x) {
    const facts = [x.folder, r.model && modelName(r.model), r.out > 0 && `${count(r.out)} out`, bytes(r.size)].filter(Boolean).join(' · ');
    return h('div', { class: `row${x.sel ? ' sel' : ''}${r.live ? ' live' : ''}`, role: 'option', 'aria-selected': String(x.sel), data: { id: r.id }, onclick: () => select(r.id) },
      h('div', { class: 'row-main' },
        x.mark ? glyph(x.mark) : h('span', { class: 'glyph-gap' }),
        h('div', { class: 'row-body' },
          h('div', { class: 'row-top' }, h('span', { class: 'row-name', text: titleOf(r) }),
            r.live && h('span', { class: 'tag', text: 'running' }),
            h('span', { class: 'row-when', text: whenShort(r.at), tip: `Last active ${dateTime(r.at)}` })),
          h('div', { class: 'row-sub' }, h('span', { class: 'row-say idle', text: facts })))));
  }

  function draw() {
    if (!root || !last) return;
    const state = last;
    for (const b of els.seg.children) b.classList.toggle('on', b.dataset.by === groupBy);
    if (!data) {
      els.total.textContent = '';
      els.groups.replaceChildren();
      els.empty.hidden = false;
      els.empty.textContent = 'Listing your conversations…';
      els.foot.hidden = true;
      fill(els.none);
      return;
    }
    const running = new Map(state.snap.chats.map((c) => [c.session, c]));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const byProject = groupBy === 'project';
    const groups = new Map();    // id -> { id, title, list, at }
    for (const r of data.list) {
      if (query && !`${r.title} ${r.name} ${r.prompt} ${r.cwd} ${r.project} ${r.id}`.toLowerCase().includes(query)) continue;
      const folder = folderOf(r.cwd) || r.project || 'No folder';
      const [id, title] = byProject ? [`p:${folder.toLowerCase()}`, folder] : bucket(r.at, start.getTime());
      let g = groups.get(id);
      if (!g) groups.set(id, g = { id, title, list: [], at: 0 });
      g.list.push(r);
      g.at = Math.max(g.at, r.at);
    }
    // by date the list arrives in order already; by project the one worked in last comes first
    const shown = [...groups.values()];
    if (byProject) shown.sort((a, b) => b.at - a.at);

    // the first time the view is looked at, the newest conversation is opened: something to read at once.
    // Not when the list and what is read share the same space: the list would be gone behind it.
    if (!picked && !sel && data.list.length && root.clientWidth >= 880) sel = data.list[0].id;

    const seen = new Set();
    order = [];
    const kids = [];
    let total = 0;
    for (const g of shown) {
      const sec = folds.draw(g.id, g.title, g.list.length);
      const folded = folds.folded(g.id);
      const list = [];
      for (const r of g.list) {
        total++;
        seen.add(r.id);
        const c = running.get(r.id);
        const x = { sel: sel === r.id, mark: c ? markOf(c, state.unread.has(c.key)) : '', folder: byProject ? '' : folderOf(r.cwd) || r.project };
        const stamp = JSON.stringify([r, x]);
        let row = rows.get(r.id);
        if (!row || row.stamp !== stamp) rows.set(r.id, row = { el: buildRow(r, x), stamp });
        list.push(row.el);
        if (!folded) order.push({ key: r.id, el: row.el });
      }
      sync(sec.inner, list);
      kids.push(sec.el);
    }
    sync(els.groups, kids);
    for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id);
    folds.keep(kids);
    els.total.textContent = whole(data.total);
    els.empty.hidden = total > 0;
    els.empty.textContent = query ? 'No conversation matches that.' : 'No conversation is kept on this machine yet.';
    els.foot.hidden = !(data.total > data.list.length) || Boolean(query);
    els.foot.textContent = `The ${whole(data.list.length)} newest of ${whole(data.total)} are listed.`;

    // ---- what the right side shows ----
    const r = sel ? data.list.find((x) => x.id === sel) : null;
    const c = r ? running.get(r.id) : null;
    const subject = c ? { kind: 'live', c } : r ? { kind: 'past', r } : null;
    root.classList.toggle('has-sel', Boolean(subject));
    els.none.hidden = Boolean(subject);
    els.detail.hidden = !subject;
    detail.show(subject, state);
    if (!subject) {
      const oldest = data.list.length ? data.list[data.list.length - 1] : null;
      const stamp = `${data.total}|${data.bytes}|${data.counting}`;
      if (els.none.dataset.stamp !== stamp) {
        els.none.dataset.stamp = stamp;
        fill(els.none, icon('history', 28),
          h('h2', { text: `${whole(data.total)} conversation${data.total === 1 ? '' : 's'} on this machine` }),
          h('p', { text: `${bytes(data.bytes)} on disk, subagents included${oldest && data.total <= data.list.length ? `, going back to ${dateTime(oldest.first || oldest.at)}` : ''}.` }),
          h('p', { text: 'Pick one to read it as it was, see which files it changed, or pick it up again in a chat here.' }),
          data.counting && h('p', { class: 'quiet', text: 'Their numbers are still being counted: a figure marked "so far" grows until that is done.' }));
      }
    }
    Parts.tick(root);
  }

  /** Called with the picture of the machine whenever it changes while this view is in front. */
  function render(state) {
    last = state;
    refresh(false);
    draw();
  }

  function move(step) {
    if (!order.length) return;
    const at = order.findIndex((o) => o.key === sel);
    const next = order[at < 0 ? (step > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + step))];
    select(next.key);
    const row = rows.get(next.key);
    if (row) row.el.scrollIntoView({ block: 'nearest' });
  }

  /** Keys that belong to the list while this view is in front and nothing else has the keyboard. True: the key was used. */
  function key(e) {
    if (!last || e.ctrlKey || e.altKey || e.metaKey) return false;
    const on = document.activeElement;
    if (on && (on.tagName === 'INPUT' || on.tagName === 'TEXTAREA')) return false;
    if (e.key === '/') { els.filter.focus(); els.filter.select(); return true; }
    if (e.key === 'Escape') {
      if (!sel) return false;
      select('');
      return true;
    }
    // inside the pane on the right the arrows scroll what is being read
    if (on && on !== document.body && els.detail.contains(on)) return false;
    if (e.key === 'j' || e.key === 'ArrowDown') { move(1); return true; }
    if (e.key === 'k' || e.key === 'ArrowUp') { move(-1); return true; }
    return false;
  }

  /** Opens the view on one conversation: from the search box, or from something that was typed in it. */
  function show(id) {
    sel = id;
    picked = true;
    els.filter.value = '';
    query = '';
    draw();
    // it may not be on the list yet (it began after the list was made): look again
    if (data && !data.list.some((r) => r.id === id)) refresh(true);
    setTimeout(() => { const row = rows.get(id); if (row) row.el.scrollIntoView({ block: 'nearest' }); }, 0);
  }

  return {
    init, render, key, show, refresh,
    tick: () => { if (root && last) { Parts.tick(root); detail.tick(); } },
    counts: () => (data ? root.querySelectorAll('.row').length : 0),
    detail: () => detail,
    selected: () => sel,
    // set by the self-test to list made-up conversations instead of the real ones
    fake: null,
  };
})();
