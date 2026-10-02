'use strict';
/* global desk, h, icon, clock, clockShort, whenOf, took, count, whole, folderOf, popMenu, toast */
// A conversation read from its transcript and laid out for the eye: what was asked, what was said, every tool
// call with what it was given and what came back, edits as changed lines, and the marks between turns. It is
// read a page at a time from the end of the file, further back on request, and it keeps up with a session
// that is still writing. Everything on the page is built from text nodes: nothing a transcript holds is ever
// parsed as markup.

const Reader = (() => {
  const POLL_S = 3;              // seconds between looks for new lines while a live conversation is on screen
  const FIRST_PAGES = 6;         // a first page can be a handful of huge lines: read back until there is something to look at
  const ENOUGH = 60;
  const CLAMP_CHARS = 1400;
  const CLAMP_LINES = 16;

  // ---- markdown, as far as replies use it ----
  // `code`, **bold**, __bold__, *italic*, _italic_, ~~struck~~, [text](address), and a bare web address
  const INLINE = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<!\w)_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)|~~(?=\S)([^\n]*?\S)~~|\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]{1,2000})\)|(https?:\/\/[^\s<>"'`]+)/g;

  function link(text, url) {
    const go = (e) => { e.preventDefault(); e.stopPropagation(); desk.openUrl(url); };
    return h('span', { class: 'md-link', role: 'link', tabindex: '0', tip: url, onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(e); } }, text);
  }

  function inline(text, depth = 0) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      last = m.index + m[0].length;
      const deeper = (s) => (depth < 3 ? inline(s, depth + 1) : s);
      if (m[2] != null) out.push(h('code', { text: m[2] }));
      else if (m[3] != null || m[4] != null) out.push(h('strong', null, deeper(m[3] != null ? m[3] : m[4])));
      else if (m[5] != null || m[6] != null) out.push(h('em', null, deeper(m[5] != null ? m[5] : m[6])));
      else if (m[7] != null) out.push(h('s', null, deeper(m[7])));
      else if (m[8] != null) out.push(link(m[8], m[9]));
      else {
        // what trails an address in running text (a full stop, a closing bracket) is not part of it
        const url = m[10].replace(/[.,;:!?)\]]+$/, '');
        out.push(link(url, url));
        if (url.length < m[10].length) out.push(m[10].slice(url.length));
      }
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function codeBlock(body, lang) {
    const pre = h('pre', { class: 'md-code' });
    if (lang === 'diff') {
      for (const l of body.split('\n')) pre.append(h('span', { class: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('@@') ? 'hunk' : '', text: `${l}\n` }));
    } else {
      pre.textContent = body;
    }
    return h('div', { class: 'md-pre' },
      h('div', { class: 'md-pre-top' }, h('span', { class: 'md-lang', text: lang && lang !== 'diff' ? lang : '' }),
        h('button', { class: 'mini', title: 'Copy', onclick: () => { desk.writeClipboard(body); toast('Copied.'); } }, icon('copy', 13))),
      pre);
  }

  const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  function listOf(block) {
    const root = h('div', { class: 'md-lists' });
    const stack = [];            // open lists, outermost first: { indent, el, li }
    for (const line of block) {
      const m = LIST.exec(line);
      if (!m) {
        // an indented line that is not an item carries on the item above it
        const top = stack[stack.length - 1];
        if (top && top.li) top.li.append('\n', ...inline(line.trim()));
        continue;
      }
      const indent = m[1].length;
      while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
      let top = stack[stack.length - 1];
      if (!top || top.indent < indent) {
        const el = h(/\d/.test(m[2]) ? 'ol' : 'ul');
        if (/\d/.test(m[2])) el.setAttribute('start', String(parseInt(m[2], 10) || 1));
        (top && top.li ? top.li : root).append(el);
        top = { indent, el, li: null };
        stack.push(top);
      }
      top.li = h('li', null, inline(m[3]));
      top.el.append(top.li);
    }
    return root;
  }

  const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((s) => s.trim().replace(/\\\|/g, '|'));
  const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

  /** A reply's text as elements: paragraphs, headings, lists, tables, quotes and code. A line break stays a line break, as in the terminal. */
  function md(text) {
    const out = document.createDocumentFragment();
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const para = [];
    const flush = () => {
      if (para.length) out.append(h('p', null, inline(para.join('\n'))));
      para.length = 0;
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(line);
      if (fence) {
        flush();
        const body = [];
        i++;
        for (; i < lines.length; i++) {
          const t = lines[i].trim();
          if (t.length >= fence[1].length && t === fence[1][0].repeat(t.length)) break;
          body.push(lines[i]);
        }
        i++;
        out.append(codeBlock(body.join('\n'), fence[2].toLowerCase()));
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      const head = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (head) {
        flush();
        out.append(h('div', { class: `md-h md-h${Math.min(4, head[1].length)}`, role: 'heading' }, inline(head[2])));
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.append(h('hr')); i++; continue; }
      if (/^\s*>/.test(line)) {
        flush();
        const inner = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) inner.push(lines[i].replace(/^\s*>\s?/, ''));
        out.append(h('blockquote', null, md(inner.join('\n'))));
        continue;
      }
      if (LIST.test(line)) {
        flush();
        const block = [];
        for (; i < lines.length && (LIST.test(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]))); i++) block.push(lines[i]);
        out.append(listOf(block));
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
        flush();
        const heads = cellsOf(line);
        const body = h('tbody');
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
          const cells = cellsOf(lines[i]);
          body.append(h('tr', null, heads.map((_, n) => h('td', null, inline(cells[n] || '')))));
        }
        out.append(h('div', { class: 'md-table' }, h('table', null, h('thead', null, h('tr', null, heads.map((c) => h('th', null, inline(c))))), body)));
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return out;
  }

  // ---- a change to a file ----
  function diffBody(d) {
    const numbered = d.hunks.some((hk) => hk.a > 0 || hk.b > 0);
    const body = h('div', { class: `diff-body${numbered ? '' : ' plain'}` });
    d.hunks.forEach((hk, n) => {
      let a = hk.a;
      let b = hk.b;
      if (numbered && n > 0) body.append(h('div', { class: 'hunk-gap' }));
      for (const l of hk.lines) {
        const sign = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l[0] === '\\' ? 'meta' : 'ctx';
        body.append(h('div', { class: `dl ${sign}` },
          h('span', { class: 'ln', text: numbered && sign !== 'add' && sign !== 'meta' ? String(a) : '' }),
          h('span', { class: 'ln', text: numbered && sign !== 'del' && sign !== 'meta' ? String(b) : '' }),
          h('span', { class: 'sg', text: sign === 'add' ? '+' : sign === 'del' ? '−' : '' }),
          h('span', { class: 'tx', text: sign === 'meta' ? l : l.slice(1) || ' ' })));
        if (sign === 'meta') continue;
        if (sign !== 'add') a++;
        if (sign !== 'del') b++;
      }
    });
    if (d.more > 0) body.append(h('div', { class: 'diff-more', text: `${whole(d.more)} more line${d.more === 1 ? '' : 's'} not shown` }));
    if (!d.hunks.length) body.append(h('div', { class: 'diff-more', text: d.kind === 'new' ? 'An empty file.' : 'No changed lines on record.' }));
    return body;
  }

  /** "+12 −3", each part only when it is not nought. */
  function delta(added, removed) {
    return h('span', { class: 'delta' }, added > 0 && h('i', { class: 'add', text: `+${whole(added)}` }), removed > 0 && h('i', { class: 'del', text: `−${whole(removed)}` }));
  }

  const dirOf = (file) => String(file || '').replace(/[\\/][^\\/]*$/, '');
  const copyButton = (text, what) => h('button', { class: 'mini', title: `Copy ${what}`, onclick: (e) => { e.stopPropagation(); desk.writeClipboard(text); toast(`Copied ${what}.`); } }, icon('copy', 13));
  const block = (cls, text, what) => h('div', { class: `t-pre ${cls}` }, copyButton(text, what), h('pre', { text }));

  /** Hangs what came back on the call it answers (the same as the reader of the files does within one page). */
  function settle(call, res) {
    call.done = res.done;
    call.error = res.error;
    call.out = res.out;
    call.note = res.note;
    if (res.diff) call.diff = res.diff;
    call.applied = Boolean(call.diff) && !res.error;
    call._el = null;
  }

  /**
   * One reader. scroller(): the element that scrolls it, for staying at the newest line and for keeping the
   * place when older lines are added above. changed(): called when what it holds has changed.
   */
  function create({ scroller, changed }) {
    const st = {
      source: null,              // { key, agent, live, brief }
      items: [],                 // oldest first
      calls: new Map(),          // tool call id -> its item
      orphans: new Map(),        // results whose call is on a page not read yet
      replies: [],               // { at, ctx, out } per reply, oldest first
      from: 0,
      to: 0,
      start: false,
      state: 'idle',             // 'loading', 'ready', 'none' (no transcript), 'idle'
      busy: false,
      seq: 0,
      mode: 'all',               // 'all', 'words' (no tool calls), 'asks' (only what was typed)
      query: '',
      open: new Set(),           // items unfolded
      marks: new Map(),          // the lines between items (days, runs of tool calls), kept by what they stand for
      fresh: 0,                  // items that arrived below while the person was reading further up
      beat: 0,
      visible: '',               // 'conv', 'changes' or '': which of its two faces is on screen
      keptAt: -1,                // how far down the conversation was when it left the screen; -1: at its newest line
      n: 0,
      title: '',
      cwd: '',
      openFiles: new Set(),
    };
    const els = {
      conv: h('div', { class: 'reader' }),
      changes: h('div', { class: 'changes' }),
      bar: h('div', { class: 'rd-bar' }),
      list: h('div', { class: 'rd-list' }),
      top: h('div', { class: 'rd-top' }),
      jump: h('button', { class: 'rd-jump', hidden: true }),
      find: h('input', { type: 'text', class: 'input sm', placeholder: 'Find in what is read', spellcheck: 'false' }),
      seg: h('div', { class: 'seg' }),
      asked: h('span'),
    };
    const MODES = [['all', 'Everything', 'Every reply, thought and tool call'], ['words', 'Words', 'What was asked and what was answered, with the tool calls folded away'], ['asks', 'Prompts', 'Only what was typed']];
    for (const [id, name, tip] of MODES) {
      els.seg.append(h('button', { text: name, tip, data: { mode: id }, onclick: () => { if (st.mode !== id) { st.mode = id; st.marks.clear(); render(); toBottom(); } } }));
    }
    els.toc = h('button', { class: 'btn ghost sm', tip: 'Jump to something that was asked', onclick: (e) => {
      const asks = st.items.filter((it) => it.k === 'ask');
      if (!asks.length) return;
      const r = e.currentTarget.getBoundingClientRect();
      popMenu(r.left, r.bottom + 6, asks.slice(-40).reverse().map((it) => ({
        label: it.text.replace(/\s+/g, ' ').slice(0, 64) + (it.text.length > 64 ? '…' : ''), key: whenOf(it.at),
        run: () => { if (it._el && it._el.isConnected) it._el.scrollIntoView({ block: 'start' }); },
      })));
    } }, icon('list', 14), els.asked);
    els.bar.append(els.seg, els.toc, h('label', { class: 'rd-find' }, icon('search', 13), els.find));
    els.jump.addEventListener('click', () => { st.fresh = 0; toBottom(); drawJump(); });
    els.find.addEventListener('input', () => { st.query = els.find.value.trim().toLowerCase(); render(); });
    els.find.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { els.find.value = ''; st.query = ''; render(); els.find.blur(); } });
    els.conv.append(els.bar, els.top, els.list, els.jump);

    const ask = (more) => (Reader.fake ? Promise.resolve(Reader.fake(st.source, more)) : desk.read({ key: st.source.key, agent: st.source.agent || '', ...more }));
    const sameSource = (a, b) => Boolean(a && b && a.key === b.key && (a.agent || '') === (b.agent || ''));
    // The scroller is shared with whatever else the pane shows: it is only this reader's to move while the
    // conversation is what is on screen.
    const atBottom = () => { if (st.visible !== 'conv') return true; const s = scroller(); return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 48; };
    const toBottom = () => { if (st.visible !== 'conv') return; const s = scroller(); if (s) s.scrollTop = s.scrollHeight; };

    function reset() {
      st.items = [];
      st.calls.clear();
      st.orphans.clear();
      st.replies = [];
      st.from = st.to = 0;
      st.start = false;
      st.open.clear();
      st.marks.clear();
      st.openFiles.clear();
      st.fresh = 0;
      st.keptAt = -1;
      st.title = st.cwd = '';
      st.query = '';
      els.find.value = '';
    }

    /** Takes a page in: older lines go above what is held, newer ones below. */
    function take(page, where) {
      for (const it of page.items) {
        it._n = ++st.n;
        if (it.k === 'tool') st.calls.set(it.id, it);
      }
      if (where === 'older') {
        // results met earlier, whose call is on this page
        for (const it of page.items) {
          if (it.k !== 'tool' || it.done) continue;
          const res = st.orphans.get(it.id);
          if (res) { settle(it, res); st.orphans.delete(it.id); }
        }
        for (const [id, res] of Object.entries(page.orphans || {})) st.orphans.set(id, res);
        st.items = page.items.concat(st.items);
        st.replies = (page.replies || []).concat(st.replies);
        // the lines between items are worked out afresh: a run of tool calls may now begin earlier
        st.marks.clear();
        st.from = page.from;
        st.start = page.start;
      } else {
        for (const [id, res] of Object.entries(page.orphans || {})) {
          const call = st.calls.get(id);
          if (call) settle(call, res); else st.orphans.set(id, res);
        }
        if (where === 'newer') for (const it of page.items) it._new = true;
        st.items = st.items.concat(page.items);
        st.replies = st.replies.concat(page.replies || []);
        st.to = page.to;
        if (where === 'first') { st.from = page.from; st.start = page.start; }
      }
      if (page.title) st.title = page.title;
      if (page.name) st.title = page.name;
      if (page.cwd) st.cwd = page.cwd;
    }

    async function open(source) {
      if (sameSource(source, st.source) && st.state !== 'idle') { st.source = source; return; }
      const seq = ++st.seq;
      reset();
      st.source = source;
      st.state = 'loading';
      st.busy = true;
      render();
      const page = await ask({});
      if (seq !== st.seq) return;
      if (!page) { st.state = 'none'; st.busy = false; render(); changed(); return; }
      take(page, 'first');
      for (let n = 0; n < FIRST_PAGES && !st.start && (st.items.length < ENOUGH || !st.items.some((it) => it.k === 'ask')); n++) {
        const more = await ask({ before: st.from });
        if (seq !== st.seq) return;
        if (!more) break;
        take(more, 'older');
      }
      st.state = 'ready';
      st.busy = false;
      render();
      toBottom();
      changed();
    }

    async function earlier() {
      if (st.busy || st.start || st.state !== 'ready') return;
      const seq = st.seq;
      st.busy = true;
      drawTop();
      const s = scroller();
      const page = await ask({ before: st.from });
      if (seq !== st.seq) return;
      st.busy = false;
      if (!page) { drawTop(); return; }
      const tall = s ? s.scrollHeight : 0;
      const at = s ? s.scrollTop : 0;
      take(page, 'older');
      render();
      // the lines that were on screen stay where they were; asked for from the list of changed files, the
      // place kept in the conversation no longer holds
      if (st.visible !== 'conv') st.keptAt = -1;
      else if (s) s.scrollTop = at + (s.scrollHeight - tall);
      changed();
    }

    async function newer() {
      if (st.busy || st.state !== 'ready') return;
      const seq = st.seq;
      st.busy = true;
      const page = await ask({ after: st.to });
      if (seq !== st.seq) return;
      st.busy = false;
      if (!page) return;
      if (page.skipped) {
        // more was written than is worth walking: what is held is dropped and the newest page stands alone
        const mode = st.mode;
        reset();
        st.mode = mode;
        take(page, 'first');
        render();
        toBottom();
        changed();
        return;
      }
      const moved = page.to !== st.to;
      if (!moved && !page.items.length && !Object.keys(page.orphans || {}).length) return;
      const stuck = atBottom();
      const before = st.items.length;
      take(page, 'newer');
      render();
      if (stuck) toBottom();
      else if (st.items.length > before) { st.fresh += st.items.length - before; drawJump(); }
      changed();
    }

    /** Once a second while it is on screen. */
    function tick() {
      if (!st.visible || !st.source || !st.source.live || st.state !== 'ready') return;
      if (++st.beat % POLL_S === 0) newer();
      if (st.fresh && atBottom()) { st.fresh = 0; drawJump(); }
    }

    // ---- drawing ----
    const matches = (it) => {
      if (!st.query) return true;
      const hay = `${it.text || ''}\n${it.label || ''}\n${it.what || ''}\n${it.input || ''}\n${it.out || ''}\n${it.diff ? it.diff.file : ''}`.toLowerCase();
      return hay.includes(st.query);
    };
    const toggle = (it) => {
      if (!st.open.delete(it._n)) st.open.add(it._n);
      it._el = null;
      render();
    };

    function toolBody(it) {
      const body = h('div', { class: 'rd-tool-body' });
      if (it.input && !(it.diff && it.input === it.diff.file)) body.append(block('t-in', it.input, 'what it was given'));
      if (it.diff) {
        body.append(h('div', { class: 'diff' },
          h('div', { class: 'diff-head' }, icon(it.diff.kind === 'new' ? 'file' : 'diff', 13), h('span', { class: 'f-name', text: folderOf(it.diff.file) }),
            h('span', { class: 'f-dir', text: dirOf(it.diff.file), title: it.diff.file }), delta(it.diff.added, it.diff.removed), copyButton(it.diff.file, 'the path')),
          diffBody(it.diff)));
        if (it.done && !it.applied) body.append(h('div', { class: 't-note bad', text: 'This change was not made: the call failed.' }));
      }
      if (it.note) body.append(h('div', { class: 't-note', text: it.note }));
      if (it.out) body.append(block(`t-out${it.error ? ' bad' : ''}`, it.out, 'what came back'));
      if (!it.done) body.append(h('div', { class: 't-note', text: 'Still running: nothing has come back yet.' }));
      else if (!it.out && !it.diff && !it.note) body.append(h('div', { class: 't-note', text: 'Nothing came back.' }));
      return body;
    }

    function build(it) {
      const open = st.open.has(it._n);
      if (it.k === 'tool') {
        const running = !it.done;
        const head = h('button', { class: 'rd-tool-head', 'aria-expanded': String(open), onclick: () => toggle(it) },
          icon('chevron-right', 12, 'caret'), h('span', { class: 't-name', text: it.label }), h('span', { class: 't-what', text: it.what }),
          it.error && h('span', { class: 't-err', text: 'failed' }),
          it.diff && (it.applied || running) && delta(it.diff.added, it.diff.removed),
          running ? h('span', { class: 't-len run', text: 'running' }) : h('span', { class: 't-len', text: it.done - it.at >= 1000 ? took(it.done - it.at) : '' }));
        const el = h('div', { class: `rd-tool${open ? ' open' : ''}${it.error ? ' err' : ''}${running ? ' run' : ''}`, tip: open ? '' : `${clock(it.at)} · ${it.label}` }, head);
        if (open) el.append(toolBody(it));
        return el;
      }
      if (it.k === 'ask') {
        const long = it.text.length > CLAMP_CHARS || it.text.split('\n').length > CLAMP_LINES;
        const text = h('div', { class: `rd-ask-text${long && !open ? ' clamp' : ''}`, text: it.text });
        return h('div', { class: 'rd-ask' },
          h('div', { class: 'rd-who' }, h('span', { class: 'who', text: st.source && st.source.agent ? 'The brief it was given' : 'You' }), h('span', { class: 'at', text: whenOf(it.at) }),
            it.queued && h('span', { class: 'chip', text: 'typed while it worked' }),
            it.pictures > 0 && h('span', { class: 'chip', text: `${it.pictures} picture${it.pictures === 1 ? '' : 's'}` }),
            copyButton(it.text, 'what you typed')),
          text,
          long && h('button', { class: 'link', text: open ? 'Show less' : 'Show all of it', onclick: () => toggle(it) }));
      }
      if (it.k === 'say') return h('div', { class: 'rd-say md' }, md(it.text));
      if (it.k === 'think') {
        const label = `Thought${it.ms >= 1000 ? ` for ${took(it.ms)}` : ''}`;
        if (!it.text) return h('div', { class: 'rd-think none' }, h('span', { class: 'rd-think-head' }, h('span', { class: 'icon-gap' }), label));
        const el = h('div', { class: `rd-think${open ? ' open' : ''}` },
          h('button', { class: 'rd-think-head', 'aria-expanded': String(open), onclick: () => toggle(it) }, icon('chevron-right', 12, 'caret'), label));
        if (open) el.append(h('div', { class: 'rd-think-text', text: it.text }));
        return el;
      }
      if (it.k === 'turn') return h('div', { class: 'rd-turn' }, turnWords(it));
      if (it.k === 'compact') {
        const bits = [it.auto ? 'Its memory filled up and was compacted here' : 'Its memory was compacted here', it.pre ? `it held ${count(it.pre)} tokens` : '', it.ms ? `took ${took(it.ms)}` : ''].filter(Boolean);
        return h('div', { class: 'rd-mark' }, icon('compact', 13), h('span', { text: `${bits.join(' · ')} · ${whenOf(it.at)}` }));
      }
      if (it.k === 'summary') {
        const el = h('div', { class: `rd-note${open ? ' open' : ''}` },
          h('button', { class: 'rd-note-head', 'aria-expanded': String(open), onclick: () => toggle(it) }, icon('chevron-right', 12, 'caret'), 'The summary it carried over after compacting'));
        if (open) el.append(h('div', { class: 'rd-note-text md' }, md(it.text)));
        return el;
      }
      if (it.k === 'recap') return h('div', { class: 'rd-note open' }, h('div', { class: 'rd-note-head plain', text: `While you were away · Claude Code's own summary, ${whenOf(it.at)}` }), h('div', { class: 'rd-note-text', text: it.text }));
      if (it.k === 'note') return h('div', { class: 'rd-mark' }, icon('info', 13), h('span', { text: `${it.from === 'task-notification' ? 'A background task reported back' : 'A notice reached it'}: ${it.text}` }));
      if (it.k === 'cmd') return h('div', { class: 'rd-mark' }, icon('terminal', 13), h('code', { text: it.text }), h('span', { class: 'at', text: whenOf(it.at) }));
      if (it.k === 'stop') return h('div', { class: 'rd-mark' }, icon('x', 13), h('span', { text: `You interrupted it · ${whenOf(it.at)}` }));
      if (it.k === 'fail') return h('div', { class: 'rd-fail' }, icon('alert', 14), h('div', { text: it.text }));
      return null;
    }

    /** What a turn came to, counted from what was asked up to its end. */
    function turnWords(end) {
      const at = st.items.indexOf(end);
      let tools = 0;
      const files = new Set();
      let from = 0;
      for (let i = at - 1; i >= 0; i--) {
        const it = st.items[i];
        if (it.k === 'turn') break;
        if (it.k === 'tool') { tools++; if (it.diff && it.applied) files.add(it.diff.file); }
        if (it.k === 'ask') { from = it.at; break; }
      }
      let out = 0;
      if (from) for (const r of st.replies) if (r.at >= from && r.at <= end.at) out += r.out;
      const bits = [end.ms ? `Turn over after ${took(end.ms)}` : 'Turn over', clockShort(end.at)];
      if (tools) bits.push(`${whole(tools)} tool call${tools === 1 ? '' : 's'}`);
      if (files.size) bits.push(`${files.size} file${files.size === 1 ? '' : 's'} changed`);
      if (out) bits.push(`${count(out)} tokens out`);
      return bits.join(' · ');
    }

    /** A line that stands between items; the same one is used again as long as what it stands for is the same. */
    function mark(key, make) {
      let el = st.marks.get(key);
      if (!el) st.marks.set(key, el = make());
      return el;
    }

    function drawBar() {
      for (const b of els.seg.children) b.classList.toggle('on', b.dataset.mode === st.mode);
      const asks = st.items.reduce((n, it) => n + (it.k === 'ask' ? 1 : 0), 0);
      els.asked.textContent = `${whole(asks)} asked`;
      els.toc.disabled = asks === 0;
    }

    function drawTop() {
      if (st.state !== 'ready') { els.top.replaceChildren(); return; }
      const first = st.items.find((it) => it.at);
      const since = first ? `Read from ${whenOf(first.at)} on.` : '';
      if (st.start) {
        els.top.replaceChildren(h('span', { class: 'quiet', text: 'This is where the conversation begins.' }));
      } else {
        els.top.replaceChildren(h('span', { class: 'quiet', text: since }),
          h('button', { class: 'btn sm', disabled: st.busy, onclick: earlier }, icon('arrow-up', 13), h('span', { text: st.busy ? 'Reading…' : 'Read further back' })));
      }
    }

    function drawJump() {
      els.jump.hidden = st.fresh === 0;
      if (st.fresh) els.jump.replaceChildren(icon('arrow-down', 13), h('span', { text: `${whole(st.fresh)} new below` }));
    }

    function render() {
      if (st.visible === 'changes') { renderChanges(); return; }
      if (st.visible !== 'conv') return;
      if (st.state === 'loading') {
        els.bar.hidden = true;
        els.top.replaceChildren();
        els.list.replaceChildren(h('p', { class: 'empty', text: 'Reading the conversation…' }));
        return;
      }
      if (st.state === 'none') {
        els.bar.hidden = true;
        els.top.replaceChildren();
        els.list.replaceChildren(h('p', { class: 'empty', text: st.source && String(st.source.key).startsWith('codex:') ? 'Codex keeps its conversations in a form this view does not read yet.'
          : 'Nothing to read yet: a conversation has no file on disk until its first message.' }));
        return;
      }
      els.bar.hidden = false;
      drawBar();
      drawTop();
      const kids = [];
      let day = '';
      let run = null;            // in the "words" view: the tool calls and thoughts between two things said
      const endRun = () => {
        if (!run) return;
        const names = new Map();
        for (const it of run.items) if (it.k === 'tool') names.set(it.label, (names.get(it.label) || 0) + 1);
        const calls = [...names.values()].reduce((a, b) => a + b, 0);
        const first = run.items[0];
        if (calls) {
          const el = mark(`run:${first._n}`, () => h('div', { class: 'rd-run' }));
          el.textContent = `${whole(calls)} tool call${calls === 1 ? '' : 's'}: ${[...names].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => `${name}${n > 1 ? ` ${n}` : ''}`).join(' · ')}${names.size > 5 ? ' …' : ''}`;
          kids.push(el);
        }
        run = null;
      };
      for (const it of st.items) {
        if (st.mode === 'asks' && it.k !== 'ask' && it.k !== 'cmd' && it.k !== 'turn') continue;
        const folded = st.mode === 'words' && (it.k === 'tool' || it.k === 'think');
        if (st.mode !== 'asks' && it.k === 'think' && !it.text && it.ms < 1000) continue;
        if (!matches(it)) continue;
        if (folded) {
          if (!st.query) { (run || (run = { items: [] })).items.push(it); continue; }
        } else {
          endRun();
        }
        if (it.at) {
          const key = new Date(it.at).toDateString();
          if (key !== day) {
            day = key;
            kids.push(mark(`day:${key}`, () => h('div', { class: 'rd-day' }, h('span', { text: new Date(it.at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) }))));
          }
        }
        if (!it._el || it.k === 'turn') {
          it._el = build(it);
          if (it._new && it._el) it._el.classList.add('rise');
          it._new = false;
        }
        if (it._el) kids.push(it._el);
      }
      endRun();
      if (!kids.length) kids.push(h('p', { class: 'empty', text: st.query ? 'Nothing in what is read holds that.' : 'Nothing was said in this stretch.' }));
      // only what changed is touched: text selected further up stays selected while new lines arrive
      kids.forEach((el, i) => { if (els.list.children[i] !== el) els.list.insertBefore(el, els.list.children[i] || null); });
      while (els.list.children.length > kids.length) els.list.lastChild.remove();
      drawJump();
    }

    // ---- the files it changed ----
    function changedFiles() {
      const files = new Map();
      for (const it of st.items) {
        if (it.k !== 'tool' || !it.diff || !it.applied) continue;
        let f = files.get(it.diff.file);
        if (!f) files.set(it.diff.file, f = { file: it.diff.file, edits: [], added: 0, removed: 0, at: 0, made: false });
        f.edits.push(it);
        f.added += it.diff.added;
        f.removed += it.diff.removed;
        f.at = Math.max(f.at, it.done || it.at);
        if (it.diff.kind === 'new') f.made = true;
      }
      return [...files.values()].sort((a, b) => b.at - a.at);
    }

    function renderChanges() {
      if (st.state === 'loading') { els.changes.replaceChildren(h('p', { class: 'empty', text: 'Reading the conversation…' })); return; }
      if (st.state === 'none') { els.changes.replaceChildren(h('p', { class: 'empty', text: 'Nothing to read yet.' })); return; }
      const files = changedFiles();
      const first = st.items.find((it) => it.at);
      const added = files.reduce((n, f) => n + f.added, 0);
      const removed = files.reduce((n, f) => n + f.removed, 0);
      const top = h('div', { class: 'chg-top' },
        h('div', null,
          h('div', { class: 'chg-sum' }, files.length ? [`${whole(files.length)} file${files.length === 1 ? '' : 's'} changed `, delta(added, removed)] : 'No file was changed'),
          h('div', { class: 'quiet', text: st.start ? 'In the whole conversation.' : first ? `In the part read so far: from ${whenOf(first.at)} on.` : '' })),
        !st.start && h('button', { class: 'btn sm', disabled: st.busy, onclick: earlier }, icon('arrow-up', 13), h('span', { text: st.busy ? 'Reading…' : 'Read further back' })));
      const list = h('div', { class: 'chg-list' });
      for (const f of files) {
        const open = st.openFiles.has(f.file);
        const head = h('button', { class: 'chg-head', 'aria-expanded': String(open), onclick: () => { if (!st.openFiles.delete(f.file)) st.openFiles.add(f.file); renderChanges(); } },
          icon('chevron-right', 12, 'caret'), icon(f.made ? 'file' : 'diff', 14),
          h('span', { class: 'f-name', text: folderOf(f.file) }), h('span', { class: 'f-dir', text: dirOf(f.file), title: f.file }),
          f.made && h('span', { class: 'chip', text: 'new' }),
          delta(f.added, f.removed),
          h('span', { class: 'f-n', text: `${f.edits.length} edit${f.edits.length === 1 ? '' : 's'}` }),
          h('span', { class: 'f-at', text: whenOf(f.at) }));
        const el = h('div', { class: `chg-file${open ? ' open' : ''}` }, head);
        if (open) {
          const body = h('div', { class: 'chg-body' });
          for (const it of f.edits) {
            body.append(h('div', { class: 'chg-edit' }, h('span', { text: clock(it.done || it.at) }), h('span', { text: it.label }), delta(it.diff.added, it.diff.removed)), diffBody(it.diff));
          }
          body.append(h('div', { class: 'chg-foot' }, h('button', { class: 'btn ghost sm', onclick: () => { desk.writeClipboard(f.file); toast('Copied the path.'); } }, icon('copy', 13), h('span', { text: 'Copy the path' })),
            h('button', { class: 'btn ghost sm', onclick: () => desk.openFolder(dirOf(f.file)) }, icon('folder', 13), h('span', { text: 'Open its folder' }))));
          el.append(body);
        }
        list.append(el);
      }
      if (!files.length) list.append(h('p', { class: 'empty', text: st.start ? 'This conversation changed no files.' : 'No file was changed in the part read so far. Read further back to look earlier.' }));
      els.changes.replaceChildren(top, list);
    }

    /** Which of its faces is on screen: 'conv', 'changes' or '' for neither. */
    function show(face) {
      if (st.visible === face) return;
      // called before the conversation is taken off the screen: where it was being read is kept for its return
      if (st.visible === 'conv') { const s = scroller(); st.keptAt = !s || atBottom() ? -1 : s.scrollTop; }
      st.visible = face;
      render();
      if (face !== 'conv' || st.state !== 'ready') return;
      const s = scroller();
      if (s && st.keptAt >= 0) s.scrollTop = st.keptAt; else toBottom();
    }

    function close() {
      st.seq++;
      reset();
      st.source = null;
      st.state = 'idle';
      st.visible = '';
    }

    return {
      conv: els.conv,
      changes: els.changes,
      open, close, show, tick, earlier,
      /** What the tabs say about it: how many files were changed and how many things were asked in the part read. */
      counts() {
        const files = new Set();
        let asks = 0;
        for (const it of st.items) {
          if (it.k === 'ask') asks++;
          else if (it.k === 'tool' && it.diff && it.applied) files.add(it.diff.file);
        }
        return { files: files.size, asks, ready: st.state === 'ready', whole: st.start };
      },
      /** How full its memory was, reply after reply, in the part read: [{ at, v }]. */
      memory: () => st.replies.map((r) => ({ at: r.at, v: r.ctx })),
      title: () => st.title,
      cwd: () => st.cwd,
      state: () => st.state,
      source: () => st.source,
    };
  }

  // fake: set by the self-test to hand the reader a made-up conversation instead of a real one
  return { create, md, diffBody, delta, fake: null };
})();
