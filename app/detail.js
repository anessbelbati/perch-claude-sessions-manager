'use strict';
/* global desk, h, fill, icon, glyph, Parts, Reader, selectionIn, labelOf, phrase, markOf, folderOf, modelName, whenOf, dateTime, clockShort, count, whole, bytes, dollars, areaChart, spark, menuUnder, toast */
// Everything about one conversation, in one pane: what it is doing, the conversation itself as it can be read,
// the files it changed, its subagents and its numbers. A session picked in the sidebar that runs elsewhere gets it
// across the whole panel, the History view shows it beside the list of past conversations, and a chat of this
// window in the panel beside its terminal.
//
// What it is shown ("the subject") is one of:
//   { kind: 'live',  c }   a session that is running: a row of the watcher's picture
//   { kind: 'ended', e }   a conversation whose program ended in the last day
//   { kind: 'past',  r }   any conversation still on disk: a row of the History view

const Detail = (() => {
  const TABS = [['overview', 'Overview'], ['conv', 'Conversation'], ['changes', 'Changes'], ['agents', 'Subagents'], ['numbers', 'Numbers']];
  const subjectKey = (s) => (!s ? '' : s.kind === 'live' ? s.c.key : s.kind === 'ended' ? s.e.id : s.r.id);
  const firstWords = (text, n = 70) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

  /**
   * host: the element it fills. act: what its buttons do (open, attach, arm, disarm, resume, forget, rename,
   * close, dismiss). compact: the narrow form beside a terminal, without the large title.
   */
  function create(host, act, { compact = false, tab = 'overview' } = {}) {
    const st = { sub: null, state: null, tab, agent: null, headStamp: '', bodyStamp: '', tabStamp: '', mounted: null };
    const els = {
      bar: h('div', { class: 'd-bar' }),
      head: h('div', { class: 'd-head' }),
      tabs: h('div', { class: 'd-tabs' }),
      // while a subagent's conversation is what is read: whose it is, and the way back. It stays put above what scrolls.
      crumb: h('div', { class: 'crumb', hidden: true }),
      // it can hold the keyboard, so that the arrow keys and Page Down scroll what is being read
      body: h('div', { class: 'd-body', tabindex: '0' }),
    };
    // what the session's programs take on this computer: measured every few seconds, so it is redrawn by itself
    // and the rest of the overview is left alone
    const resBox = h('div', { class: 'res-box' });
    // ... and the same in a few words, among the facts under the title
    const resFact = h('span', { class: 'fact f-res', hidden: true });
    const reader = Reader.create({ scroller: () => els.body, changed: () => { drawTabs(); if (st.tab === 'numbers') drawBody(); } });
    host.classList.add('detail');
    if (compact) host.classList.add('compact');
    host.append(els.bar, els.head, els.tabs, els.crumb, els.body);
    // Where the row of tabs does not fit: the wheel moves it sideways, and the end that has more is marked (it fades out).
    const edges = () => {
      const more = els.tabs.scrollWidth - els.tabs.clientWidth;
      els.tabs.classList.toggle('more-left', more > 1 && els.tabs.scrollLeft > 1);
      els.tabs.classList.toggle('more-right', more > 1 && els.tabs.scrollLeft < more - 1);
    };
    els.tabs.addEventListener('scroll', edges, { passive: true });
    new ResizeObserver(edges).observe(els.tabs);
    els.tabs.addEventListener('wheel', (e) => {
      if (els.tabs.scrollWidth <= els.tabs.clientWidth || e.shiftKey || !e.deltaY) return;
      e.preventDefault();
      els.tabs.scrollLeft += e.deltaY;
    }, { passive: false });

    // ---- what the subject comes to, whichever kind it is ----
    function facts() {
      const s = st.sub;
      const state = st.state;
      if (s.kind === 'live') {
        const c = s.c;
        const chat = c.chat ? state.chats.find((x) => x.id === c.chat) : null;
        const unread = state.unread.has(c.key);
        return {
          kind: 'live', key: c.key, c, chat, here: Boolean(chat), title: (chat && chat.title) || labelOf(c), cwd: c.cwd, model: c.model,
          mark: markOf(c, unread), words: phrase(c) || (unread ? 'Finished' : 'Idle'),
          session: c.provider === 'claude' ? c.session : '', readable: c.provider === 'claude' && Boolean(c.session),
          armed: state.armed.has(c.session), live: Boolean(c.pid) || c.state === 'working',
        };
      }
      if (s.kind === 'ended') {
        const e = s.e;
        return { kind: 'ended', key: e.id, e, here: false, title: labelOf(e), cwd: e.cwd, model: '', mark: 'ended',
          words: e.cut ? 'Ended while it was still working' : 'Ended', session: e.id, readable: true, live: false };
      }
      const r = s.r;
      return { kind: 'past', key: r.id, r, here: false, title: r.name || r.title || firstWords(r.prompt) || 'Untitled conversation', cwd: r.cwd, model: r.model, mark: 'ended',
        words: 'Not running', session: r.id, readable: true, live: false };
    }

    const available = (f) => TABS.filter(([id]) => {
      if (id === 'conv' || id === 'changes') return f.readable;
      if (id === 'agents') return f.kind === 'live' && f.c.agents && f.c.agents.total > 0;
      if (id === 'numbers') return f.kind === 'live' && Boolean(f.c.tokens || f.c.live || f.c.pulse);
      return true;
    });

    // ---- what its buttons do ----
    function primary(f) {
      if (f.kind === 'live') {
        const c = f.c;
        // beside its own terminal there is nothing to open
        if (f.here) return act.open ? h('button', { class: 'btn primary', onclick: () => act.open(c.chat) }, icon('terminal', 14), h('span', { text: 'Open' })) : null;
        if (c.kind === 'bg' && c.job) return h('button', { class: 'btn', tip: 'Open this background session in a chat of this window', onclick: () => act.attach(c) }, icon('terminal', 14), h('span', { text: 'Open here' }));
        if (c.provider === 'claude' && c.pid && c.session) {
          if (f.armed) return h('button', { class: 'btn armed', tip: 'It opens here as soon as you close it in its own window (type /exit there).\nClick to cancel.', onclick: () => act.disarm(c.session) }, h('span', { text: 'Waiting…' }));
          return h('button', { class: 'btn', tip: 'Move this chat into this window.\nYou close it where it runs now; it then opens here by itself, with its whole conversation.', onclick: () => act.arm([c.session]) }, icon('bring', 14), h('span', { text: 'Bring here' }));
        }
        return null;
      }
      if (f.kind === 'ended') return h('button', { class: 'btn primary', tip: 'Pick this conversation up again in a chat of this window', onclick: () => act.resume(f.e) }, icon('play', 14), h('span', { text: 'Resume here' }));
      const r = f.r;
      if (r.live || !r.cwd) return null;
      return h('button', { class: 'btn primary', tip: 'Pick this conversation up again in a chat of this window', onclick: () => act.resume({ id: r.id, cwd: r.cwd, mode: r.mode, title: f.title }) }, icon('play', 14), h('span', { text: 'Resume here' }));
    }

    function more(f, target) {
      const items = [];
      const copy = (text, what) => () => { desk.writeClipboard(text); toast(`Copied ${what}.`); };
      if (f.session) {
        items.push({ label: 'Copy the session id', icon: 'copy', run: copy(f.session, 'the session id') });
        items.push({ label: 'Copy the command that reopens it', icon: 'terminal', run: copy(`claude --resume ${f.session}`, 'the command') });
      }
      if (f.cwd) {
        items.push({ label: 'Copy the folder path', icon: 'copy', run: copy(f.cwd, 'the path') });
        items.push({ label: 'Open its folder', icon: 'folder', run: () => desk.openFolder(f.cwd) });
      }
      if (f.readable) items.push({ label: "Show the conversation's file", icon: 'file', run: async () => { if (!(await desk.showFile(f.key, st.agent ? st.agent.id : ''))) toast('Its file could not be found.'); } });
      if (f.kind === 'live' && f.here && act.rename && act.close) {
        items.push(null, { label: 'Rename', icon: 'pencil', run: () => act.rename(f.c.chat) }, { label: 'Close this chat', icon: 'x', danger: true, run: () => act.close(f.c.chat) });
      }
      if (f.kind === 'ended') items.push(null, { label: 'Take it off this list', icon: 'x', run: () => act.forget(f.e.id) });
      if (items.length) menuUnder(target, items);
    }

    // ---- drawing ----
    function drawHead(f) {
      const c = f.c;
      const stamp = JSON.stringify([f.kind, f.key, f.title, f.mark, f.words, f.here, f.armed, f.cwd, f.model, st.agent && st.agent.id,
        c && [c.since, c.background, c.turn && [c.turn.start, c.turn.end], c.effort, c.mode, c.kind, c.provider, c.context, c.ceiling, c.today && [c.today.out, c.today.work, c.today.whole],
          c.agents && c.agents.running, c.queued, c.limit, c.live, c.tokens && c.tokens.share],
        f.e && [f.e.at], f.r && [f.r.at, f.r.size, f.r.out, f.r.live]]);
      if (stamp === st.headStamp) return;
      st.headStamp = stamp;

      const timer = c ? (c.state === 'working' && !c.background && c.turn && c.turn.start && !c.turn.end
        ? h('span', { class: 'timer', data: { since: c.turn.start }, tip: 'How long this turn has been going' })
        : c.state !== 'idle' || f.mark === 'done' ? h('span', { class: 'timer', data: { time: c.since } }) : h('span', { class: 'timer' }, 'for ', h('span', { data: { time: c.since } })))
        : f.e ? h('span', { class: 'timer' }, h('span', { data: { time: f.e.at } }), ' ago')
          : h('span', { class: 'timer', text: `last active ${whenOf(f.r.at)}` });
      fill(els.bar,
        h('div', { class: `d-state s-${f.mark}` }, glyph(f.mark, 15), h('span', { class: 'words', text: f.words }), timer,
          c && c.state === 'working' && !c.background && h('span', { class: 'timer still', hidden: true, data: { quiet: c.at }, tip: 'It says it is working, but it has written nothing for this long.\nA long tool call looks like this too.' })),
        h('div', { class: 'd-acts' }, primary(f),
          h('button', { class: 'icon-btn', title: 'More', onclick: (e) => more(f, e.currentTarget) }, icon('more')),
          act.dismiss && h('button', { class: 'icon-btn', title: 'Close this pane (Esc)', onclick: () => act.dismiss() }, icon('x'))));

      const chips = [];
      if (c && c.provider === 'codex') chips.push(h('span', { class: 'chip', text: 'Codex' }));
      if (c && c.kind === 'bg') chips.push(h('span', { class: 'chip', text: 'background' }));
      if (f.here) chips.push(h('span', { class: 'chip here', text: 'in this window' }));
      if (f.r && f.r.live) chips.push(h('span', { class: 'chip here', text: 'running now' }));
      if (f.e && f.e.cut) chips.push(h('span', { class: 'chip', text: 'cut off mid-answer', tip: 'Its program ended while it was still working: the answer in progress was lost.' }));
      const sub = [];
      if (f.cwd) sub.push(h('button', { class: 'd-path', title: `${f.cwd}\nClick to open this folder`, onclick: () => desk.openFolder(f.cwd) }, icon('folder', 13), h('span', { text: compact ? folderOf(f.cwd) : f.cwd })));
      if (f.model) sub.push(h('span', { text: [modelName(f.model), c && c.effort && `effort ${c.effort}`].filter(Boolean).join(' · '), title: f.model }));
      if (c && c.mode && Parts.MODES[c.mode]) sub.push(h('span', { text: Parts.MODES[c.mode] }));
      const liveFacts = c ? h('div', { class: 'd-facts' }, Parts.facts(c, Date.now(), !compact)) : null;
      // what its programs hold on this computer: second in line, after how full the model's memory is
      if (liveFacts) liveFacts.insertBefore(resFact, liveFacts.children[1] || null);
      fill(els.head,
        !compact && h('h1', { class: 'd-title', text: f.title }),
        h('div', { class: 'd-sub' }, sub, chips),
        c ? liveFacts
          : f.r ? h('div', { class: 'd-facts' },
            f.r.out > 0 && h('span', { class: 'fact' }, h('b', { text: count(f.r.out) }), ` out${f.r.counted ? '' : ' so far'}`),
            f.r.replies > 0 && h('span', { class: 'fact' }, h('b', { text: whole(f.r.replies) }), ' replies'),
            f.r.tools > 0 && h('span', { class: 'fact' }, h('b', { text: whole(f.r.tools) }), ' tool calls'),
            h('span', { class: 'fact' }, h('b', { text: bytes(f.r.size) }), ' on disk')) : null);
    }

    function drawTabs() {
      if (!st.sub) return;
      const f = facts();
      const tabs = available(f);
      if (!tabs.some(([id]) => id === st.tab)) st.tab = tabs[0][0];
      const n = reader.counts();
      const badge = { changes: n.ready && n.files ? String(n.files) : '', agents: f.kind === 'live' && f.c.agents && f.c.agents.running ? String(f.c.agents.running) : '' };
      const stamp = JSON.stringify([tabs.map((t) => t[0]), st.tab, badge]);
      if (stamp === st.tabStamp) return;
      st.tabStamp = stamp;
      fill(els.tabs, h('div', { class: 'seg tabs', role: 'tablist' }, tabs.map(([id, name]) =>
        h('button', { class: id === st.tab ? 'on' : '', role: 'tab', 'aria-selected': String(id === st.tab), data: { tab: id }, onclick: () => setTab(id) }, name, badge[id] && h('span', { class: 'n', text: badge[id] })))));
      // in a narrow pane the row of tabs is wider than the pane: the one in front is brought into sight
      const on = els.tabs.querySelector('button.on');
      if (on && els.tabs.scrollWidth > els.tabs.clientWidth) {
        const room = els.tabs.getBoundingClientRect();
        const r = on.getBoundingClientRect();
        if (r.left < room.left + 40) els.tabs.scrollLeft -= room.left + 40 - r.left;
        else if (r.right > room.right - 40) els.tabs.scrollLeft += r.right - (room.right - 40);
      }
      edges();
    }

    function pastFacts(r) {
      const dl = h('dl', { class: 'plist' });
      const add = (k, v, tip) => { if (v) dl.append(h('dt', { text: k }), h('dd', { tip }, v)); };
      add('Folder', r.cwd && h('span', { class: 'path', text: r.cwd }));
      add('Last active', dateTime(r.at));
      add('First reply', r.first ? dateTime(r.first) : '');
      add('Size on disk', bytes(r.size));
      add('Tokens out', r.out > 0 ? `${whole(r.out)}${r.counted ? '' : ' so far: it is still being read'}` : r.counted ? '0' : 'not counted yet', 'Written by the models in this conversation, its subagents included.');
      add('Replies', r.replies > 0 ? whole(r.replies) : '');
      add('Tool calls', r.tools > 0 ? whole(r.tools) : '');
      add('Subagents', r.agents > 0 ? whole(r.agents) : '');
      add('Compactions', r.compacts > 0 ? whole(r.compacts) : '');
      add('Model', r.model ? modelName(r.model) : '');
      add("Claude Code's note", r.usd > 0 || r.added || r.removed ? `${dollars(r.usd)} at list prices · +${whole(r.added)} / −${whole(r.removed)} lines` : '',
        'What Claude Code itself wrote into this conversation the last time its program ended.\nList prices: not what a subscription pays.');
      add('Session', h('span', { class: 'path', text: r.id }));
      return dl;
    }

    function overview(f) {
      const read = f.readable ? (a) => { st.agent = { id: a.id, name: a.name }; st.headStamp = ''; setTab('conv'); } : null;
      if (f.kind === 'live') {
        const c = f.c;
        return [Parts.needBlock(c), Parts.askedBlock(c), Parts.wordsBlock(c), Parts.recapBlock(c), Parts.turnBlock(c), Parts.agentsBlock(c, read), resBox, Parts.aboutBlock(c)];
      }
      if (f.kind === 'ended') {
        const e = f.e;
        const dl = h('dl', { class: 'plist' });
        dl.append(h('dt', { text: 'Ended' }), h('dd', { text: dateTime(e.at) }), h('dt', { text: 'Folder' }), h('dd', null, h('span', { class: 'path', text: e.cwd })),
          h('dt', { text: 'Session' }), h('dd', null, h('span', { class: 'path', text: e.id })));
        return [
          e.cut && h('div', { class: 'callout warn' }, icon('alert', 16), h('div', null, h('div', { class: 'callout-title', text: 'Its program ended while it was still working' }), h('div', { class: 'callout-text', text: 'The answer in progress was lost. Resuming picks the conversation up from before that answer.' }))),
          e.prompt && Parts.section('You last asked', '', h('p', { class: 'quote clamp', text: e.prompt })),
          e.words && Parts.section('Its last words', '', h('p', { class: 'quote', text: e.words })),
          Parts.section('About', '', dl)];
      }
      return [f.r.prompt && Parts.section('You last asked', '', h('p', { class: 'quote clamp', text: f.r.prompt })), Parts.section('About', '', pastFacts(f.r))];
    }

    function numbers(f) {
      const c = f.c;
      const points = reader.memory();
      const out = [Parts.numbersBlock(c), Parts.liveBlock(c)];
      if (points.length > 1) {
        const m = Parts.memoryOf(c);
        out.push(Parts.section('Memory, reply after reply', `the part read: from ${whenOf(points[0].at)} on`,
          h('div', { class: 'area-box', tip: 'How many tokens the model was holding at each reply. A drop is a compaction; the line across the top is where it compacts on its own.' },
            areaChart(points, { top: c.ceiling || 0 })),
          h('div', { class: 'area-foot' }, h('span', { text: clockShort(points[0].at) }),
            h('span', { text: m && m.known ? `now ${count(c.context)} of about ${count(c.ceiling)}` : `now ${count(points[points.length - 1].v)}` }), h('span', { text: clockShort(points[points.length - 1].at) }))));
      }
      if (c.pulse) {
        const acts = c.pulse.reduce((a, b) => a + b, 0);
        out.push(Parts.section('The last 30 minutes', acts ? `${whole(acts)} replies and tool calls · one bar a minute, now on the right` : 'nothing', h('div', { class: 'pulse-box' }, spark(c.pulse, { width: 300, height: 34, gap: 2, tone: c.state === 'working' ? 'on' : '' }))));
      }
      return out;
    }

    function drawRes() {
      const f = st.sub && st.sub.kind === 'live' ? st.sub.c : null;
      const r = f ? Parts.resOf(st.state, f) : null;
      Parts.resFact(resFact, r, r ? Parts.resTip(r) : '');
      const stamp = Parts.resStamp(f, r);
      if (resBox.dataset.stamp === stamp) return;
      // a number being copied is not swapped under the selection
      if (stamp && resBox.dataset.stamp && selectionIn(resBox)) return;
      resBox.dataset.stamp = stamp;
      resBox.hidden = !r;
      fill(resBox, Parts.resBlock(f, r));
    }

    function drawCrumb(on) {
      els.crumb.hidden = !on;
      const stamp = on ? st.agent.id : '';
      if (els.crumb.dataset.stamp === stamp) return;
      els.crumb.dataset.stamp = stamp;
      if (!on) return;
      fill(els.crumb,
        h('button', { class: 'btn ghost sm', onclick: () => { st.agent = null; st.headStamp = ''; st.mounted = null; show(st.sub, st.state); } }, icon('arrow-left', 13), h('span', { text: 'The main conversation' })),
        h('span', { class: 'quiet', text: `Subagent: ${st.agent.name}` }));
    }

    function drawBody(force) {
      const f = facts();
      const face = st.tab === 'conv' ? 'conv' : st.tab === 'changes' ? 'changes' : '';
      els.body.dataset.tab = st.tab;
      drawCrumb(Boolean(st.agent && face));
      if (face) {
        const node = face === 'conv' ? reader.conv : reader.changes;
        if (st.mounted !== node || force) {
          // told before its other face replaces it, while the conversation can still say how far down it was
          reader.show('');
          fill(els.body, node);
          st.mounted = node;
        }
        st.bodyStamp = '';
        reader.show(face);
        return;
      }
      reader.show('');
      st.mounted = null;
      const stamp = JSON.stringify([st.tab, f.kind, f.c || f.e || f.r, f.here, st.state.unread.has(f.key), st.tab === 'numbers' && reader.memory().length]);
      if (stamp === st.bodyStamp && !force) return;
      if (st.bodyStamp && selectionIn(els.body)) return;
      st.bodyStamp = stamp;
      const at = els.body.scrollTop;
      const kids = st.tab === 'agents' ? [Parts.agentsBlock(f.c, f.readable ? (a) => { st.agent = { id: a.id, name: a.name }; st.headStamp = ''; setTab('conv'); } : null)]
        : st.tab === 'numbers' ? numbers(f) : overview(f);
      fill(els.body, h('div', { class: 'd-wrap' }, kids));
      els.body.scrollTop = at;
    }

    function setTab(id) {
      st.tab = id;
      st.tabStamp = '';
      if (st.sub) show(st.sub, st.state);
      // the conversation goes back to where it was being read; everything else opens at its top
      if (id !== 'conv') els.body.scrollTop = 0;
    }

    /** Shows a subject; called again with the same one whenever the picture of the machine changes. */
    function show(sub, state) {
      const changed = subjectKey(sub) !== subjectKey(st.sub) || (sub && st.sub && sub.kind !== st.sub.kind);
      st.sub = sub;
      st.state = state;
      if (!sub) { reader.close(); return; }
      if (changed) {
        st.agent = null;
        st.headStamp = st.bodyStamp = st.tabStamp = '';
        st.mounted = null;
        els.body.scrollTop = 0;
      }
      const f = facts();
      drawHead(f);
      if (f.readable) reader.open({ key: f.key, agent: st.agent ? st.agent.id : '', live: f.live });
      else reader.close();
      drawTabs();
      drawRes();
      drawBody();
      Parts.tick(host);
    }

    function tick() {
      if (!st.sub) return;
      Parts.tick(host);
      reader.tick();
    }

    return { show, tick, setTab, reader, tab: () => st.tab, subject: () => st.sub, agent: () => st.agent, el: host };
  }

  return { create, subjectKey };
})();
