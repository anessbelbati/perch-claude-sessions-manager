'use strict';
/* global desk, h, fill, icon, glyph, ago, took, left, leftShort, count, whole, hours, dollars, dollarsShort, modelName, folderOf, labelOf, clock, clockShort, dateTime, whenOf, bar, phrase, limitName, acctName, planName, toast */
// The pieces of a session's picture that the sidebar, a chat's strip, the panel beside a chat, the Dashboard and
// the History view all draw.

const Parts = (() => {
  const MODES = {
    bypassPermissions: 'never asks permission',
    acceptEdits: 'edits files without asking',
    plan: 'plan mode',
    auto: 'auto',
    default: 'asks permission',
  };
  const SOON_MS = 5 * 60e3;        // a cache this close to going cold is pointed out,
  const COLD_MATTERS = 100e3;      // when going cold means reading at least this many tokens afresh
  const QUIET_MS = 5 * 60e3;       // a session that says it works and wrote nothing for this long

  /** A titled stretch of a detail view. */
  function section(title, note, ...body) {
    return h('div', { class: 'sec' }, h('div', { class: 'sec-head' }, h('h4', { text: title }), note && h('span', { class: 'note' }, note)), ...body);
  }

  /** Nothing of the conversation has been read yet: there is no number to show, not a zero. */
  const uncounted = (t) => t.share < 0.999 && t.in + t.out + t.cacheWrite + t.cacheRead === 0;

  // ---- memory: how much the model is holding, against where it compacts on its own ----
  function memoryOf(c) {
    if (!c.context) return null;
    const part = c.ceiling ? Math.min(1, c.context / c.ceiling) : 0;
    return { part, known: Boolean(c.ceiling), tone: part >= 0.9 ? 'hot' : part >= 0.72 ? 'warm' : '' };
  }
  function memoryTip(c) {
    const lines = [`In its memory now: ${whole(c.context)} tokens.`];
    if (c.ceiling) {
      lines.push(`It compacts on its own at about ${whole(c.ceiling)}`
        + (c.ceilingOwn ? ' (where this chat last did).' : ' (where another chat on the same model last did).'));
    } else {
      lines.push('No chat on this model has compacted on its own yet, so there is nothing to measure it against.');
    }
    if (c.compacts) lines.push(`Compacted ${c.compacts} time${c.compacts === 1 ? '' : 's'} so far.`);
    return lines.join('\n');
  }
  /**
   * How full the model's memory is, as the one figure a chat's strip keeps: a line that fills, and its percentage.
   * null when it is not known. The word after the figure steps aside where the strip is narrow.
   */
  function memoryFact(c) {
    const m = memoryOf(c);
    if (!m) return null;
    if (!m.known) return h('span', { class: 'fact f-mem' }, icon('memory', 13), h('span', null, count(c.context), h('span', { class: 'w', text: ' in memory' })));
    return h('span', { class: `fact f-mem${m.tone ? ' ' + m.tone : ''}` }, bar(m.part, m.tone), h('span', null, `${Math.round(m.part * 100)}%`, h('span', { class: 'w', text: ' memory' })));
  }

  /**
   * Everything about a chat that its strip does not say, as one hover note: what it is doing in full, its model,
   * its memory in tokens, its subagents, what it used today, its cache, and what its programs hold on this
   * computer. c: its session, null for a plain console. r: what was measured for the chat, null when nothing was.
   */
  function restTip(c, r, now = Date.now()) {
    const lines = [];
    if (c) {
      const doing = phrase(c);
      if (doing) lines.push(doing);
      const how = [c.model && modelName(c.model), c.effort && `effort ${c.effort}`, c.mode && MODES[c.mode]].filter(Boolean).join(' · ');
      if (how) lines.push(how);
      const m = memoryOf(c);
      if (m) {
        lines.push(m.known ? `Memory: ${count(c.context)} of about ${count(c.ceiling)} tokens (${Math.round(m.part * 100)}%)${c.compacts ? ` · compacted ${c.compacts}×` : ''}`
          : `Memory: ${count(c.context)} tokens`);
      }
      if (c.agents && c.agents.running) lines.push(`${c.agents.running} subagent${c.agents.running === 1 ? '' : 's'} working`);
      if (c.queued) lines.push(`${c.queued} message${c.queued === 1 ? '' : 's'} waiting their turn`);
      const d = c.today;
      if (d && d.whole === false) lines.push('Today: still being read');
      else if (d && c.tokens) lines.push(`Today: ${count(d.out)} tokens out · ${hours(d.work)} of work`);
      if (c.live && c.live.usd > 0) lines.push(`${dollarsShort(c.live.usd)} at list prices since its program started`);
      const k = cacheOf(c, now);
      if (k) lines.push(k.warm ? `Cache warm until ${clockShort(k.until)}` : 'Cache cold');
    }
    if (r) {
      const cpu = cpuText(r.cpu);
      lines.push(`On this computer: ${ramText(r.mem)} of RAM${cpu ? ` · ${cpu} of the processor` : ''}${r.ports.length ? ` · a server on ${r.ports.map((p) => `:${p}`).join(', ')}` : ''}`);
    }
    return lines.join('\n');
  }

  // ---- what a session last told its status line: its cost, and how warm the cache of its conversation is ----
  /** { warm, until, cold, hit, big }, or null when it never said. big: going cold costs enough to point out. */
  function cacheOf(c, now = Date.now()) {
    const l = c.live;
    if (!l || !l.cacheUntil) return null;
    return { warm: l.warm && l.cacheUntil > now, until: l.cacheUntil, cold: l.cacheCold, hit: l.cacheHit, big: l.cacheCold >= COLD_MATTERS };
  }
  function cacheTip(k) {
    const lines = [];
    if (k.warm) lines.push(`Its cache stays warm until ${clockShort(k.until)}.`, 'A message sent before then reads the conversation from the cache, which counts for a fraction.');
    else lines.push('Its cache has gone cold.');
    if (k.cold > 0) lines.push(`${k.warm ? 'Once it is cold, the' : 'The'} next message reads about ${count(k.cold)} tokens afresh.`);
    if (k.hit >= 0) lines.push(`So far ${Math.round(k.hit * 100)}% of what it read came from the cache.`);
    return lines.join('\n');
  }
  /** "cache 42m", counting down, then "cache cold". */
  function cacheMark(c, now = Date.now()) {
    const k = cacheOf(c, now);
    if (!k) return null;
    const soon = k.warm && k.big && k.until - now < SOON_MS;
    return h('span', { class: `cache${k.warm ? (soon ? ' soon' : '') : ' cold'}`, tip: cacheTip(k) }, 'cache ',
      k.warm ? h('span', { data: { left: k.until, zero: 'cold', ...(k.big ? { soon: SOON_MS } : {}) } }) : 'cold');
  }
  const costTip = (usd) => `${dollars(usd)}: what Claude Code reckons this chat has used at list prices, since its program started.\nA subscription does not pay list prices. It is a measure of how much was used.`;

  /** What the conversation used today, and since it began, as one hover note. */
  function useTip(c) {
    const t = c.tokens;
    const d = c.today;
    const lines = [];
    if (d && d.whole !== false) lines.push(`Today: ${whole(d.out)} tokens out · ${whole(d.replies)} replies · ${whole(d.tools)} tool calls · ${hours(d.work)} of work`);
    else if (d) lines.push('Today: still being read.');
    if (t && !uncounted(t)) {
      lines.push(`${t.share < 0.999 ? `So far, with ${Math.floor(t.share * 100)}% of its history read` : 'Since it began'}: ${whole(t.out)} out · ${whole(t.in + t.cacheWrite)} in · ${whole(t.cacheRead)} re-read from the cache`);
    }
    if (t) lines.push('Its subagents included.');
    return lines.join('\n');
  }

  /**
   * The facts of a session in one line: how full its memory is, what it used, how warm its cache is. Each is a
   * small mark and a few words; none of them is there when it has nothing to say. wide: room for all of them.
   */
  function facts(c, now = Date.now(), wide = true) {
    const out = [];
    const fact = (kind, mark, body, tip, tone) => out.push(h('span', { class: `fact f-${kind}${tone ? ' ' + tone : ''}`, tip }, mark && icon(mark, 13), body));
    const m = memoryOf(c);
    if (m && m.known) fact('mem', '', [bar(m.part, m.tone), h('span', { text: `${Math.round(m.part * 100)}% memory` })], memoryTip(c), m.tone);
    else if (m) fact('mem', 'memory', `${count(c.context)} in memory`, memoryTip(c));
    if (c.agents && c.agents.running) fact('agents', 'agents', `${c.agents.running} subagent${c.agents.running === 1 ? '' : 's'} working`, 'Subagents working right now');
    if (c.queued) fact('queued', 'list', `${c.queued} queued`, 'Messages typed while it worked, waiting their turn');
    if (c.today && c.today.whole === false) fact('out', '', 'reading today…', "Today's part of this conversation is still being read. Its numbers show in a moment.");
    else if (c.today && c.tokens) fact('out', '', [h('b', { text: count(c.today.out) }), ' out today'], useTip(c));
    if (wide && c.today && c.today.whole !== false && c.today.work > 0) fact('work', '', [h('b', { text: hours(c.today.work) }), ' of work'], 'Time this chat and its subagents spent working today. Waiting for you does not count.');
    if (c.live && c.live.usd > 0) fact('cost', '', [h('b', { text: dollarsShort(c.live.usd) }), ' at list prices'], costTip(c.live.usd));
    const mark = cacheMark(c, now);
    if (mark) out.push(h('span', { class: 'fact f-cache' }, mark));
    return out;
  }

  /** One tool call of the turn, as a line on a rail: when, which tool, on what, how long. */
  function toolLine(t) {
    return h('div', { class: `tl-row${t.done ? '' : ' running'}`, tip: `${clock(t.at)} · ${t.name}${t.what ? `\n${t.what}` : ''}` },
      h('span', { class: 'at', text: clock(t.at) }),
      h('span', { class: 'pt' }),
      h('span', { class: 'what' }, h('span', { class: 'name', text: t.name }), t.what && h('span', { text: t.what })),
      t.done ? h('span', { class: 'len', text: took(t.done - t.at) }) : h('span', { class: 'len', data: { since: t.at } }));
  }
  function toolList(turn) {
    const list = h('div', { class: 'timeline' });
    const hidden = turn.count - turn.tools.length;
    if (hidden > 0) list.append(h('div', { class: 'tl-more', text: `${whole(hidden)} earlier call${hidden === 1 ? '' : 's'} not shown here. The Conversation tab has them all.` }));
    for (const t of turn.tools) list.append(toolLine(t));
    if (!turn.tools.length) list.append(h('div', { class: 'tl-more', text: 'No tool calls.' }));
    return list;
  }

  /**
   * The subagents of a session as a tree: each under the one that started it. model: the conversation's own; a
   * subagent's is named only when it runs on a different one. read(agent): opens that subagent's conversation.
   */
  function agentTree(list, model, read) {
    const kids = new Map();
    const ids = new Set(list.map((a) => a.id));
    for (const a of list) {
      const parent = a.parent && ids.has(a.parent) ? a.parent : '';
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(a);
    }
    const out = h('div', { class: 'ag-tree' });
    const walk = (parent, depth) => {
      for (const a of kids.get(parent) || []) {
        const line = a.doing ? (a.doing.what ? `${a.doing.name} · ${a.doing.what}` : a.doing.name) : a.said;
        const meta = [a.state === 'stopped' && 'stopped', a.tools > 0 && `${whole(a.tools)} tool${a.tools === 1 ? '' : 's'}`, a.out > 0 && `${count(a.out)} out`,
          took(a.at - a.started), a.model && a.model !== model && modelName(a.model)].filter(Boolean).join(' · ');
        out.append(h('div', { class: `ag-row ${a.state}`, style: `--depth:${Math.min(depth, 5)}`, data: { agent: a.id } },
          glyph(a.state === 'working' ? 'working' : a.state === 'done' ? 'done' : 'ended', 13),
          h('div', { class: 'ag-what' },
            h('div', { class: 'ag-title' },
              h('span', { class: 'name', text: a.name }),
              a.what && h('span', { class: 'about', text: a.what, title: a.what })),
            line && h('div', { class: `ag-line${a.doing ? ' doing' : ''}`, text: line, title: line }),
            h('div', { class: 'ag-meta', tip: 'Tool calls and output tokens so far, and how long it has run' }, meta)),
          h('div', { class: 'ag-end' },
            h('span', { class: 'when', data: { time: a.at }, tip: 'Since it last did something' }),
            read && h('button', { class: 'btn ghost sm', text: 'Read', tip: "Read this subagent's own conversation", onclick: (e) => { e.stopPropagation(); read(a); } }))));
        walk(a.id, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }

  // ---- the accounts this machine logs in to ----
  /** What the watcher knows about them, with the names the person gave them. me: the one logged in now, or null. */
  function acctView(state) {
    const a = state.snap.accounts;
    const list = a && Array.isArray(a.list) ? a.list : [];
    return {
      known: Boolean(a),
      list,
      me: list.find((x) => x.here) || null,
      names: (state.settings && state.settings.accountNames) || {},
      marks: a && Array.isArray(a.marks) ? a.marks : [],
    };
  }
  const atWords = (t) => (new Date(t).toDateString() === new Date().toDateString() ? `at ${clockShort(t)}` : `on ${dateTime(t)}`);
  /**
   * What stands behind one limit's figure. label: "5-hour limit". pace: percent an hour, 0 when not known.
   * f: where it is heading at that pace (see forecast), when that can be told.
   */
  function limitTip(label, w, pace, f) {
    const lines = [`${Math.round(w.used)}% of the ${label} is used, as Claude Code last reported it (${whenOf(w.at)}).`, `It resets ${whenOf(w.until)}.`];
    if (pace > 0) lines.push(`Lately it grows by about ${pace >= 10 ? Math.round(pace) : pace.toFixed(1)}% an hour.`);
    if (f && f.full) lines.push(`At that pace it is used up ${atWords(f.full)}: ${leftShort(w.until - f.full)} before it resets.`);
    else if (f) lines.push(`At that pace about ${Math.round(f.at)}% is used by the time it resets.`);
    lines.push('Claude Code is told this with each reply. Nothing here asks Anthropic.');
    return lines.join('\n');
  }
  /** Where a limit is heading at the pace of late, in a few words; null when the pace is too slow to tell. name: "5-hour limit". */
  function heading(f, w, name) {
    if (!f) return null;
    if (f.full) {
      return h('span', { class: 'go warn', tip: `At the pace of late the ${name} is used up ${atWords(f.full)}.\nThat is ${leftShort(w.until - f.full)} before it resets (${whenOf(w.until)}).` },
        'at this pace full ', h('b', { text: atWords(f.full) }), `, ${leftShort(w.until - f.full)} early`);
    }
    return h('span', { class: 'go', tip: `At the pace of late about ${Math.round(f.at)}% of the ${name} is used by the time it resets (${whenOf(w.until)}).` },
      'at this pace ', h('b', { text: `${Math.round(f.at)}%` }), ' by the reset');
  }
  /** Of the accounts not in use, the one with the most room as last seen here; null when none is known well enough to say. */
  function roomiest(list, now = Date.now()) {
    let best = null;
    for (const a of list) {
      if (a.here || !a.week) continue;
      const five = a.five && a.five.until > now ? a.five.used : 0;
      const week = a.week.until > now ? a.week.used : 0;
      if (five >= 80 || week >= 90) continue;
      if (!best || week < best.week) best = { a, week };
    }
    return best ? best.a : null;
  }
  /**
   * What is known about the limits of an account that is not the one in use, in a few words each. A figure
   * seen earlier is a floor: the account may have been used elsewhere since. short: for a tight place.
   */
  function restingWords(a, now = Date.now(), short = false) {
    const out = [];
    const floor = (used) => (short ? `≥ ${Math.round(used)}%` : `at least ${Math.round(used)}%`);
    if (a.five) out.push(a.five.until <= now ? (short ? '5-hour free' : '5-hour window free') : `5-hour ${floor(a.five.used)}`);
    if (a.week) out.push(a.week.until <= now ? (short ? 'week reset' : 'week has reset') : `week ${floor(a.week.used)}`);
    return out;
  }
  function restingTip(a, names, now = Date.now()) {
    const lines = [[acctName(a, names), planName(a.plan)].filter(Boolean).join(' · ')];
    if (a.to) lines.push(`Last in use until ${dateTime(a.to)}.`);
    if (a.five) {
      lines.push(a.five.until <= now ? `5-hour limit: the window it was in ended ${whenOf(a.five.until)}. A new one starts with the first message under it.`
        : `5-hour limit: ${Math.round(a.five.used)}% when last seen (${whenOf(a.five.at)}). That window runs until ${whenOf(a.five.until)}.`);
    }
    if (a.week) {
      lines.push(a.week.until <= now ? `Weekly limit: the week it was in ended ${whenOf(a.week.until)}.`
        : `Weekly limit: ${Math.round(a.week.used)}% when last seen (${whenOf(a.week.at)}). It resets ${whenOf(a.week.until)}.`);
    }
    lines.push(a.five || a.week ? 'The last figures seen on this machine: it may have been used elsewhere since.'
      : 'This app has not seen it in use yet, so it knows nothing about its limits. They show the next time you log into it.');
    return lines.join('\n');
  }

  // ---- the blocks of a session's overview; each returns null when it has nothing to say ----
  /** What it wants from the person, or what stopped it: the one thing on the page that asks for a look. */
  function needBlock(c) {
    if (c.limit) {
      return h('div', { class: 'callout bad' }, icon('gauge', 16), h('div', null,
        h('div', { class: 'callout-title', text: `It ran into the ${limitName(c.limit.type)}` }),
        h('div', { class: 'callout-text' }, c.limit.until ? ['That lifts at ', clockShort(c.limit.until), ', in ', h('b', { data: { until: c.limit.until } }), '.'] : 'When it lifts is not on record.')));
    }
    if (c.state !== 'attention' && c.state !== 'error') return null;
    return h('div', { class: `callout ${c.state === 'error' ? 'bad' : 'warn'}` }, icon(c.state === 'error' ? 'alert' : 'bell', 16), h('div', null,
      h('div', { class: 'callout-title', text: phrase(c) }),
      c.words && h('div', { class: 'callout-text quote', text: c.words })));
  }
  const askedBlock = (c) => (c.prompt ? section('You last asked', '', h('p', { class: 'quote clamp', text: c.prompt })) : null);
  function wordsBlock(c) {
    // what it needs is said in the notice at the top
    if (!c.words || c.state === 'attention' || c.state === 'error') return null;
    return section(c.state === 'working' ? 'Its latest words' : 'Its last words', '', h('p', { class: 'quote', text: c.words }));
  }
  function recapBlock(c) {
    if (!c.recap) return null;
    return section('While you were away', c.recapAt ? `Claude Code's own summary, ${clockShort(c.recapAt)}` : "Claude Code's own summary",
      h('p', { class: 'quote', text: c.recap }));
  }
  function turnBlock(c) {
    if (!c.turn) return null;
    const turn = c.turn;
    const going = !turn.end && turn.start && c.state === 'working';
    const note = [`${whole(turn.count)} tool call${turn.count === 1 ? '' : 's'}`,
      turn.end && turn.ms ? ` · took ${took(turn.ms)}` : '',
      going ? ' · going for ' : '', going ? h('span', { data: { since: turn.start } }) : ''];
    return section(turn.end || c.state !== 'working' ? 'Last turn' : 'This turn', note, toolList(turn));
  }
  function agentsBlock(c, read) {
    if (!c.agents || !c.agents.total) return null;
    const a = c.agents;
    const recent = a.list.length - a.running;
    const bits = [`${a.running} working`];
    if (recent) bits.push(`${recent} finished in the last half hour`);
    bits.push(`${whole(a.total)} in all`);
    return section('Subagents', bits.join(' · '), a.list.length ? agentTree(a.list, c.model, read) : h('p', { class: 'quiet', text: 'None active in the last half hour.' }));
  }
  /** Today against the conversation's whole life. */
  function numbersBlock(c) {
    const t = c.tokens;
    if (!t) return null;
    if (uncounted(t) && !(c.today && c.today.whole !== false)) return section('Numbers', '', h('p', { class: 'quiet', text: 'Not counted yet.' }));
    const d = c.today && c.today.whole !== false ? c.today : null;
    const all = !uncounted(t);
    const partial = t.share < 0.999;
    // [name, today, all time, how to write it]; null: not known
    const rows = [
      ['Tokens out', d ? d.out : null, all ? t.out : null, count],
      ['Tokens in', d ? d.in + d.cacheWrite : null, all ? t.in + t.cacheWrite : null, count],
      ['Re-read from cache', d ? d.cacheRead : null, all ? t.cacheRead : null, count],
      ['Tool calls', d ? d.tools : null, all ? t.tools : null, whole],
      d && ['Replies', d.replies, null, whole],
      d && ['Things you typed', d.asked, null, whole],
      d && ['Subagents started', d.agents, null, whole],
      d && ['Time working', d.work, null, hours],
    ].filter(Boolean);
    const grid = h('div', { class: 'nums' }, h('span', { class: 'th' }), h('em', { class: 'th', text: 'Today' }), h('em', { class: 'th', text: 'All time' }));
    for (const [name, today, sum, write] of rows) {
      // Today's lines are read before the older ones, so a sum still on its way can stand below today's own
      // number. Until it is whole it is a floor: what was read so far, and never less than today.
      const least = sum == null ? null : partial && today != null ? Math.max(sum, today) : sum;
      grid.append(h('span', { text: name }), h('b', { text: today == null ? '' : write(today) }),
        h('b', { class: `all${partial ? ' floor' : ''}`, text: least == null ? '' : `${partial ? '≥ ' : ''}${write(least)}`, tip: partial && least != null ? 'At least this much: its older history is still being read.' : '' }));
    }
    return section('Numbers', partial ? `its older history is still being read: ${Math.floor(t.share * 100)}%` : 'its subagents included', grid);
  }
  /** What it last told its status line. */
  function liveBlock(c, now = Date.now()) {
    const l = c.live;
    if (!l) return null;
    const dl = h('dl', { class: 'plist' });
    const add = (k, v, tip) => dl.append(h('dt', { text: k }), h('dd', { tip }, v));
    if (l.usd > 0) add('Used so far', `${dollars(l.usd)} at list prices`, costTip(l.usd));
    if (l.added || l.removed) add('Lines changed', `+${whole(l.added)} / −${whole(l.removed)}`, 'Lines it added to and took out of files since its program started.');
    const k = cacheOf(c, now);
    if (k) {
      add('Cache', k.warm
        ? h('span', { class: 'cache' }, 'warm for ', h('span', { data: { left: k.until, zero: 'a moment more' } }), k.cold ? ` · ${count(k.cold)} tokens to read afresh once cold` : '')
        : `cold${k.cold ? ` · the next message reads ${count(k.cold)} tokens afresh` : ''}`, cacheTip(k));
    }
    if (!dl.children.length) return null;
    return section('Right now', 'as it last told its status line', dl);
  }
  function aboutBlock(c) {
    const copy = (text, what, mark) => h('button', { class: 'mini', title: `Copy ${what}`, onclick: (e) => { e.stopPropagation(); desk.writeClipboard(text); toast(`Copied ${what}.`); } }, icon(mark, 13));
    const pairs = [];
    const m = memoryOf(c);
    if (m) {
      pairs.push(['Memory', h('span', { tip: memoryTip(c) }, m.known
        ? `${count(c.context)} of about ${count(c.ceiling)} tokens (${Math.round(m.part * 100)}%)`
        : `${count(c.context)} tokens`, c.compacts ? ` · compacted ${c.compacts}×` : '')]);
    }
    if (c.model) pairs.push(['Model', [modelName(c.model), c.effort && `effort ${c.effort}`].filter(Boolean).join(' · ')]);
    if (c.mode) pairs.push(['Permissions', MODES[c.mode] || c.mode]);
    if (c.queued) pairs.push(['Queued', `${c.queued} message${c.queued === 1 ? '' : 's'} waiting their turn`]);
    if (c.started) pairs.push(['Program started', whenOf(c.started)]);
    if (c.cwd) {
      pairs.push(['Folder', h('span', { class: 'path' }, c.cwd, ' ', h('button', { class: 'mini', title: 'Open this folder', onclick: (e) => { e.stopPropagation(); desk.openFolder(c.cwd); } }, icon('folder', 13)))]);
    }
    if (c.session && c.provider === 'claude') {
      pairs.push(['Session', h('span', { class: 'path' }, c.session, ' ', copy(c.session, 'the session id', 'copy'), copy(`claude --resume ${c.session}`, 'the command that reopens it', 'terminal'))]);
    }
    // what its program wrote down when it last ended: only until the running one has spoken
    if (!(c.live && c.live.usd > 0) && c.cost && (c.cost.usd > 0 || c.cost.added || c.cost.removed)) {
      const bits = [];
      if (c.cost.usd > 0) bits.push(`${dollars(c.cost.usd)} at list prices`);
      if (c.cost.added || c.cost.removed) bits.push(`+${whole(c.cost.added)} / −${whole(c.cost.removed)} lines`);
      pairs.push(["Claude Code's note", h('span', { tip: 'What Claude Code itself wrote into this conversation the last time its program ended.\nList prices: not what a subscription pays.' }, bits.join(' · '))]);
    }
    if (!pairs.length) return null;
    const dl = h('dl', { class: 'plist' });
    for (const [k, v] of pairs) dl.append(h('dt', { text: k }), h('dd', null, v));
    return section('About', '', dl);
  }

  // ---- what a session's programs take on this computer. "Memory" in this app is what the model holds, so the
  // ---- computer's own is called RAM: the figure of Task Manager's Memory column. CPU: a share of the whole processor. ----
  const GB = 1073741824;
  const ramText = (b) => (b >= GB ? `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB` : b >= 1048576 ? `${Math.round(b / 1048576)} MB` : b > 0 ? '<1 MB' : '0 MB');
  const cpuText = (v) => (v === null || v === undefined ? '' : v < 0.05 ? '0%' : v < 1 ? '<1%' : `${Math.round(v)}%`);
  // in a tight place the processor is only said from this share on: under it, the RAM says enough
  const CPU_SAID = 5;
  const RES_TIP = "RAM: what it holds of the computer's memory right now, the figure of Task Manager's Memory column.\nCPU: how much of the whole processor it used over the last few seconds.";
  /** What the watcher last measured for a session; null when it was not measured (it only just started, or measuring is off). */
  const resOf = (state, c) => (state.res && c && state.res.sessions[c.key]) || null;
  const KIND_WORDS = {
    mcp: 'MCP server',
    server: 'a server',
    tool: 'started by a command',
    command: 'a command it runs',
    start: 'started with the session',
    claude: 'started by a command',
    program: 'a program it started',
  };
  const KIND_TIPS = {
    mcp: 'An MCP server: a helper program that gives this session extra tools. Claude Code starts it with the session.',
    server: 'It listens on a port: your browser, or another program, can connect to it.',
    tool: 'Started by a command the agent ran, and still running.',
    start: 'Claude Code started it when the session began. That is how it starts its MCP servers and plugins.',
    command: 'A command the agent ran (the Bash tool) that is still running.',
    claude: 'A second Claude Code, started by a command of this one.',
    program: 'Started by this session, and still running.',
  };
  /** One program a session started: what to call it, and what it is. */
  function itemWords(it) {
    if (it.kind === 'mcp') return { name: it.label || 'MCP server', what: it.label ? KIND_WORDS.mcp : '' };
    if (it.kind === 'claude') return { name: 'another Claude Code', what: KIND_WORDS.claude };
    return { name: it.label || 'a program', what: KIND_WORDS[it.kind] || '' };
  }
  /** A port a program listens on: a click opens it in the browser. */
  const portChip = (p) => h('button', { class: 'port', text: `:${p}`, tip: `A server is up on port ${p}.\nClick to open http://localhost:${p} in your browser.`,
    onclick: (e) => { e.stopPropagation(); desk.openUrl(`http://localhost:${p}`); } });
  /** What a session or a chat takes, in a few words, for a tight place: "612 MB", "1.2 GB · CPU 14% · :3000". */
  function resShort(r, withPorts = true) {
    if (!r) return '';
    const bits = [ramText(r.mem)];
    if (r.cpu !== null && r.cpu >= CPU_SAID) bits.push(`CPU ${Math.round(r.cpu)}%`);
    if (withPorts && r.ports.length) bits.push(`:${r.ports[0]}${r.ports.length > 1 ? ` +${r.ports.length - 1}` : ''}`);
    return bits.join(' · ');
  }
  /** The same as a hover note: the totals, then what it runs. */
  function resTip(r, who = 'This session') {
    if (!r) return '';
    const cpu = cpuText(r.cpu);
    const lines = [`${who} holds ${ramText(r.mem)} of RAM in ${r.n} program${r.n === 1 ? '' : 's'}${cpu ? ` and uses ${cpu} of the processor` : ''}.`];
    if (r.own) lines.push(`The agent itself: ${ramText(r.own.mem)}`);
    const by = new Map();
    for (const it of r.items || []) {
      const key = it.kind === 'mcp' ? 'MCP servers' : itemWords(it).name;
      const g = by.get(key) || { n: 0, mem: 0 };
      g.n++;
      g.mem += it.mem;
      by.set(key, g);
    }
    for (const [key, g] of [...by].sort((a, b) => b[1].mem - a[1].mem).slice(0, 6)) lines.push(`${key}${g.n > 1 || key === 'MCP servers' ? ` (${g.n})` : ''}: ${ramText(g.mem)}`);
    if (r.more) lines.push(`${r.more.n} smaller programs: ${ramText(r.more.mem)}`);
    if (r.ports.length) lines.push(`A server is up on ${r.ports.map((p) => `:${p}`).join(', ')}`);
    lines.push('RAM as Task Manager counts it.');
    return lines.join('\n');
  }
  /**
   * Fills a fact (one of the few words in a line under a title) with what a session or a chat holds:
   * "1.2 GB RAM · CPU 14%" and the ports a server is up on. Hidden while nothing was measured.
   */
  function resFact(el, r, tip) {
    el.hidden = !r;
    if (!r) return;
    el.dataset.tip = tip;
    const text = resShort(r, false);
    const stamp = `${text}|${r.ports.join(',')}`;
    if (el.dataset.stamp === stamp) return;
    el.dataset.stamp = stamp;
    const [ram, ...rest] = text.split(' · ');
    fill(el, h('b', { text: ram }), h('span', { text: ['RAM', ...rest].join(' · ') }), r.ports.map(portChip));
  }
  /** What the block below would show, as one string: it is drawn again only when this changes. */
  const resStamp = (c, r) => (!r ? '' : JSON.stringify([ramText(r.mem), cpuText(r.cpu), r.n, r.ports, ramText(r.own.mem), cpuText(r.own.cpu), c.agents ? c.agents.running : 0,
    r.items.map((it) => [it.kind, it.label, ramText(it.mem), cpuText(it.cpu), it.n, it.ports]), r.more && [r.more.n, ramText(r.more.mem)]]));
  /** The programs of one session, one per line: the agent itself, then what it started, biggest first. */
  function resBlock(c, r) {
    if (!r) return null;
    const line = (name, what, mem, cpu, ports, tip) => h('div', { class: 'res-row', tip },
      h('div', { class: 'res-what' }, h('span', { class: 'name', text: name }), what && h('span', { class: 'about', text: what }), ports && ports.map(portChip)),
      h('b', { class: 'res-mem', text: ramText(mem) }),
      h('span', { class: 'res-cpu', text: cpuText(cpu) }));
    const held = new Set(r.items.flatMap((it) => it.ports));
    const working = c.agents ? c.agents.running : 0;
    const rows = [
      h('div', { class: 'res-row head' }, h('span'), h('span', { text: 'RAM' }), h('span', { text: 'CPU' })),
      line(c.provider === 'codex' ? 'Codex' : 'Claude Code', working ? `the agent itself · ${working} subagent${working === 1 ? '' : 's'} working inside it` : 'the agent itself',
        r.own.mem, r.own.cpu, r.ports.filter((p) => !held.has(p)), 'The agent program of this session. Its subagents run inside it: what they take is part of this figure.')];
    for (const it of r.items) {
      const w = itemWords(it);
      rows.push(line(w.name, [w.what, it.n > 1 && `${it.n} programs`].filter(Boolean).join(' · '), it.mem, it.cpu, it.ports, KIND_TIPS[it.kind] || ''));
    }
    if (r.more) rows.push(line(`${r.more.n} more`, 'smaller programs', r.more.mem, null, null, ''));
    const cpu = cpuText(r.cpu);
    return section('On this computer', [h('b', { text: ramText(r.mem) }), ' RAM', cpu && [' · ', h('b', { text: cpu }), ' CPU'], ` · ${r.n} program${r.n === 1 ? '' : 's'}`],
      h('div', { class: 'res-list', tip: RES_TIP }, rows));
  }

  /** What a session runs besides the agent, in a few words: "esbuild · 2 subagents · 3 MCP servers". */
  function itemsShort(r, c) {
    // what a command started comes first; what came up with the session comes last
    const names = [...new Set(r.items.filter((it) => it.kind !== 'mcp').sort((a, b) => (a.kind === 'start') - (b.kind === 'start')).map((it) => itemWords(it).name))];
    const servers = r.items.filter((it) => it.kind === 'mcp').length;
    const working = c && c.agents ? c.agents.running : 0;
    const bits = names.slice(0, 2);
    if (names.length > 2) bits.push(`${names.length - 2} more`);
    if (working) bits.push(`${working} subagent${working === 1 ? '' : 's'}`);
    if (servers) bits.push(`${servers} MCP server${servers === 1 ? '' : 's'}`);
    return bits.join(' · ');
  }
  /** Every session that was measured, the one that holds the most RAM first, each with the name it goes by. */
  function runningRows(state) {
    const res = state.res;
    if (!res || !res.all) return [];
    const alias = new Map(state.chats.filter((c) => c.title).map((c) => [c.id, c.title]));
    return state.snap.chats.filter((c) => res.sessions[c.key])
      .map((c) => ({ c, r: res.sessions[c.key], name: alias.get(c.chat) || labelOf(c) }))
      .sort((a, b) => b.r.mem - a.r.mem);
  }
  /** What runningBlock would show, as one string ('' when nothing was measured): it is drawn again only when this changes. */
  function runningStamp(state, limit = 6) {
    const list = runningRows(state);
    if (!list.length) return '';
    const res = state.res;
    const top = Math.max(1, list[0].r.mem);
    return JSON.stringify([ramText(res.all.mem), cpuText(res.all.cpu), res.all.n, ramText(res.memory),
      list.slice(0, limit).map(({ c, r, name }) => [c.key, name, itemsShort(r, c), r.ports, Math.round((r.mem / top) * 50), ramText(r.mem), cpuText(r.cpu)]),
      list.length, ramText(list.slice(limit).reduce((a, x) => a + x.r.mem, 0)),
      res.servers.map((s) => [s.port, s.key, s.label]), res.app && [ramText(res.app.mem), cpuText(res.app.cpu), res.app.n]]);
  }
  /**
   * Everything the sessions run, at a glance: the totals, the sessions by what they hold, the servers that are
   * up, and this app itself. pick(key): shows a session. Returns { note, body }, or null when nothing was measured.
   */
  function runningBlock(state, pick, limit = 6) {
    const list = runningRows(state);
    if (!list.length) return null;
    const res = state.res;
    const top = Math.max(1, list[0].r.mem);
    const cpu = cpuText(res.all.cpu);
    const note = [h('b', { text: ramText(res.all.mem) }), ` of ${ramText(res.memory)} RAM`, cpu && [' · ', h('b', { text: cpu }), ' CPU'],
      ` · ${res.all.n} programs in ${list.length} session${list.length === 1 ? '' : 's'}`];
    const rows = list.slice(0, limit).map(({ c, r, name }) => h('div', { class: 'run-row', role: 'button', tabindex: '0', data: { key: c.key }, tip: resTip(r, name),
      onclick: () => pick(c.key), onkeydown: (e) => { if (e.key === 'Enter') pick(c.key); } },
    h('span', { class: 'name', text: name }),
    h('span', { class: 'runs' }, h('span', { text: itemsShort(r, c) }), r.ports.map(portChip)),
    bar(Math.round((r.mem / top) * 50) / 50),
    h('b', { class: 'res-mem', text: ramText(r.mem) }),
    h('span', { class: 'res-cpu', text: cpuText(r.cpu) })));
    const rest = list.slice(limit);
    const body = [h('div', { class: 'run-list', tip: RES_TIP },
      h('div', { class: 'run-row head' }, h('span', { text: 'Session' }), h('span', { class: 'runs', text: 'What it runs besides the agent' }), h('span'), h('span', { text: 'RAM' }), h('span', { text: 'CPU' })),
      rows,
      rest.length > 0 && h('div', { class: 'run-row rest' }, h('span', { class: 'name', text: `${rest.length} smaller session${rest.length === 1 ? '' : 's'}` }), h('span', { class: 'runs' }), h('span', { class: 'track-gap' }),
        h('b', { class: 'res-mem', text: ramText(rest.reduce((a, x) => a + x.r.mem, 0)) }), h('span', { class: 'res-cpu' })))];
    if (res.servers.length) {
      const where = new Map(list.map((x) => [x.c.key, x.name]));
      body.push(h('div', { class: 'run-servers' }, h('span', { class: 'k', text: res.servers.length === 1 ? 'Server up' : 'Servers up' }),
        res.servers.map((s) => h('span', { class: 'run-server' }, portChip(s.port), h('span', { text: [s.label, where.get(s.key)].filter(Boolean).join(' · ') })))));
    }
    if (res.app) {
      const own = cpuText(res.app.cpu);
      body.push(h('p', { class: 'quiet run-app', tip: 'This app: its window, the consoles it draws for your chats, and the small helper that measures all of this.\nWhat your chats run is not in it.' },
        `Perch Desk itself holds ${ramText(res.app.mem)} of RAM${own ? ` and uses ${own} of the processor` : ''}.`));
    }
    return { note, body };
  }

  /**
   * Rewrites the marks that age without anything else changing: "3m" since, "2m 05s" going, "42m 05s" until,
   * "42m" left in a tight place, and "quiet 6m" on a session that says it works and has written nothing for a while.
   */
  function tick(root, now = Date.now()) {
    for (const el of root.querySelectorAll('[data-time]')) el.textContent = ago(Number(el.dataset.time), now);
    for (const el of root.querySelectorAll('[data-since]')) el.textContent = took(now - Number(el.dataset.since));
    for (const el of root.querySelectorAll('[data-until]')) el.textContent = left(Math.max(0, Number(el.dataset.until) - now));
    for (const el of root.querySelectorAll('[data-left]')) {
      const ms = Number(el.dataset.left) - now;
      el.textContent = ms > 0 ? leftShort(ms) : el.dataset.zero || '0s';
      if (el.dataset.soon) el.parentElement.classList.toggle('soon', ms > 0 && ms < Number(el.dataset.soon));
      if (el.dataset.zero === 'cold') el.parentElement.classList.toggle('cold', ms <= 0);
    }
    for (const el of root.querySelectorAll('[data-quiet]')) {
      const at = Number(el.dataset.quiet);
      el.hidden = now - at < QUIET_MS;
      if (!el.hidden) el.textContent = `quiet ${ago(at, now)}`;
    }
  }

  return { MODES, section, uncounted, memoryOf, memoryTip, memoryFact, restTip, cacheOf, cacheTip, cacheMark, costTip, useTip, facts, toolLine, toolList, agentTree,
    acctView, limitTip, heading, roomiest, restingWords, restingTip,
    needBlock, askedBlock, wordsBlock, recapBlock, turnBlock, agentsBlock, numbersBlock, liveBlock, aboutBlock, tick, folderOf,
    ramText, cpuText, resOf, resShort, resTip, resFact, resStamp, resBlock, itemWords, itemsShort, portChip, runningStamp, runningBlock };
})();
