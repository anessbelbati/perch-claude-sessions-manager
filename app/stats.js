'use strict';
/* global h, fill, glyph, figure, selectionIn, count, whole, hours, left, took, dollars, dollarsShort, modelName, labelOf, dayLabel, dateTime, clock, clockShort, whenOf, whenShort, limitName, bar, barChart, acctColor, acctName, planName, windowOf, forecast, ACCT_NONE, Parts */
// The Dashboard: every number of the app lives here, and nowhere else. What
// the sessions hold on this computer right now and what each is doing call by
// call, the accounts this machine logs in to and what was done under each,
// then what every conversation added up to, by day, by hour, by chat, by
// project, by model and by tool. The sums are counted from the transcripts
// the CLI writes on disk.

const Stats = (() => {
  const RANGES = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']];
  const METRICS = [
    { id: 'out', name: 'Tokens out', get: (x) => x.out, format: count, unit: 'tokens out' },
    { id: 'work', name: 'Agent work', get: (x) => x.work, format: hours, unit: 'of work' },
    { id: 'replies', name: 'Replies', get: (x) => x.replies, format: count, unit: 'replies' },
    { id: 'cacheRead', name: 'Cache re-read', get: (x) => x.cacheRead, format: count, unit: 'tokens re-read' },
  ];
  const UNKNOWN = '?';           // what was done while nothing on disk said which account was logged in
  const RIBBON_DAYS = 14;
  const RUN_SHOWN = 12;          // sessions listed by the RAM they hold; the rest are added up in one line
  const FEED_MS = 30 * 60e3;
  const FEED_SHOWN = 14;
  let root = null;
  let wrap = null;
  let act = null;
  let metric = METRICS[0];
  let drawn = '';

  // what the sessions take on this computer right now: measured every few seconds, so it is drawn by itself
  // while the sums under it are redrawn only when they change
  const runBox = h('section', { class: 'sec block run-sec', hidden: true });

  function init(el, actions) {
    root = el;
    act = actions;
    wrap = h('div', { class: 'd-wrap wide' });
    root.append(wrap);
  }

  function drawRunning(state) {
    const stamp = Parts.runningStamp(state, RUN_SHOWN);
    runBox.hidden = !stamp;
    if (runBox.dataset.stamp === stamp || (stamp && runBox.dataset.stamp && selectionIn(runBox))) return;
    runBox.dataset.stamp = stamp;
    if (!stamp) return;
    const run = Parts.runningBlock(state, (key) => act.show(key), RUN_SHOWN);
    fill(runBox, h('div', { class: 'sec-head' }, h('h3', { text: 'On this computer' }), h('span', { class: 'note' }, run.note)), run.body);
  }

  // what every session is doing right now, call by call: it moves all the time, so it is drawn by itself too
  const feedBox = h('section', { class: 'sec block feed-sec' });

  /** The latest tool calls of every session and subagent, newest first, and what the open chats have used so far. */
  function drawFeed(state, now) {
    const alias = new Map(state.chats.filter((c) => c.title).map((c) => [c.id, c.title]));
    const list = [];
    let usd = 0;
    let spoke = 0;
    for (const c of state.snap.chats) {
      if (c.live && c.live.usd > 0) { usd += c.live.usd; spoke++; }
      const who = alias.get(c.chat) || labelOf(c);
      if (c.turn) for (const t of c.turn.tools) list.push({ at: t.at, done: t.done, name: t.name, what: t.what, who, key: c.key });
      for (const a of c.agents ? c.agents.list : []) if (a.doing) list.push({ at: a.doing.at, done: 0, name: a.doing.name, what: a.doing.what, who, sub: a.name, key: c.key });
    }
    const shown = list.filter((x) => now - x.at < FEED_MS).sort((a, b) => b.at - a.at).slice(0, FEED_SHOWN);
    const stamp = JSON.stringify([shown, usd.toFixed(2), spoke, state.snap.chats.length]);
    if (feedBox.dataset.stamp === stamp || (feedBox.dataset.stamp && selectionIn(feedBox))) return;
    feedBox.dataset.stamp = stamp;
    const running = shown.filter((x) => !x.done).length;
    fill(feedBox,
      h('div', { class: 'sec-head' }, h('h3', { text: 'Happening now' }),
        h('span', { class: 'note', text: shown.length ? `the latest tool calls of every session${running ? ` · ${running} running` : ''}` : '' })),
      shown.length ? h('div', { class: 'feed' }, shown.map((x) => h('div', { class: `feed-row${x.done ? '' : ' running'}`, role: 'button', tabindex: '0',
        tip: `${clock(x.at)} · ${x.who}${x.sub ? ` › ${x.sub}` : ''}\n${x.name}${x.what ? ` · ${x.what}` : ''}`,
        onclick: () => act.show(x.key), onkeydown: (e) => { if (e.key === 'Enter') act.show(x.key); } },
      h('span', { class: 'at', text: clockShort(x.at) }),
      h('span', { class: 'who' }, x.who, x.sub && h('i', { text: ` › ${x.sub}` })),
      h('span', { class: 'tool', text: x.name }),
      h('span', { class: 'what', text: x.what }),
      x.done ? h('span', { class: 'len', text: x.done - x.at >= 1000 ? took(x.done - x.at) : '' }) : h('span', { class: 'len', data: { since: x.at } }))))
        : h('p', { class: 'quiet', text: 'No tool was run in the last half hour.' }),
      usd > 0 && h('p', { class: 'cost-line quiet',
        tip: `${dollars(usd)}, added up from what Claude Code itself reckons each open chat has used at list prices since its program started.\n${spoke} of the ${state.snap.chats.length} sessions have said so far: a chat says it when it next answers.\nA subscription does not pay list prices: it is a measure of how much was used.` },
      'The chats open now have used ', h('b', { text: dollarsShort(usd) }), ' at list prices so far.'));
  }

  const seg = (items, on, pick) => h('div', { class: 'seg' }, items.map(([id, name]) => h('button', { class: id === on ? 'on' : '', text: name, onclick: () => pick(id) })));
  const kpi = (value, label, tip) => h('div', { class: 'kpi', tip }, figure(value), h('span', { class: 'k-label', text: label }));
  const panel = (title, note, ...body) => h('section', { class: 'sec block' },
    h('div', { class: 'sec-head' }, h('h3', { text: title }), note && (typeof note === 'string' ? h('span', { class: 'note', text: note }) : note)), ...body);
  const share = (part, color) => h('span', { class: 'share' }, h('i', { style: `width:${Math.max(part > 0 ? 2 : 0, Math.round(part * 100))}%${color ? `;background:${color}` : ''}` }));
  const none = (text) => h('p', { class: 'quiet', text });

  function table(cols, head, lines) {
    const t = h('div', { class: 'table', style: `--cols:${cols}` });
    t.append(h('div', { class: 'tr th' }, head.map((x) => h('span', { text: x }))));
    for (const cells of lines) t.append(h('div', { class: 'tr' }, cells));
    return t;
  }

  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  function rangeWords(range) {
    return range === 'today' ? 'today' : range === '7d' ? 'in the last 7 days' : 'in the last 30 days';
  }

  // ---- the accounts: where each one's limits stand, and what was done under each in the range ----
  function accounts(u, v, now, words) {
    const by = new Map((u.who || []).map((w) => [w.key, w]));
    const all = (u.who || []).reduce((n, w) => n + w.out, 0);
    // where the limits of the account in use are heading at the pace of late; once it runs out, the other account
    // with the most room is pointed at (the person does the switching)
    const me = v.me;
    const heads = { five: me && me.five && me.five.until > now ? forecast(me.five, me.pace.five, now) : null, week: me && me.week && me.week.until > now ? forecast(me.week, me.pace.week, now) : null };
    const tight = Boolean(me && ((me.five && me.five.until > now && me.five.used >= 90) || (heads.five && heads.five.full) || (me.week && me.week.until > now && me.week.used >= 90)));
    const best = tight ? Parts.roomiest(v.list, now) : null;
    /** One limit of one account. Of an account at rest only what was last seen is known: a floor ("≥"). */
    const limit = (a, x, kind, pace) => {
      if (!x) return h('div', { class: 'lim-cell none' }, bar(0), h('span', { class: 'r', text: 'no reading yet' }));
      if (!x.open) {
        return h('div', { class: 'lim-cell fresh', tip: `The last ${kind === 'five' ? '5-hour window' : 'week'} seen for this account ended ${whenOf(x.until)}.\nA new one starts with the first message under it.` },
          bar(0), h('span', { class: 'r' }, h('b', { text: 'fresh' }), ` since ${whenShort(x.until, now)}`));
      }
      const name = `${kind === 'five' ? '5-hour' : 'weekly'} limit`;
      const f = a.here ? heads[kind] : null;
      return h('div', { class: `lim-cell ${x.tone}` },
        h('div', { class: 'lim-now', tip: a.here ? Parts.limitTip(name, x, pace, f) : Parts.restingTip(a, v.names, now) },
          bar(x.used / 100, x.tone, f ? f.at / 100 : 0),
          h('span', { class: 'r' }, h('b', { text: `${a.here ? '' : '≥ '}${Math.round(x.used)}%` }),
            a.here ? [' · resets in ', h('span', { data: { left: x.until } })] : ` · resets ${whenShort(x.until, now)}`)),
        Parts.heading(f, x, name));
    };
    const lines = v.list.map((a) => {
      const w = by.get(a.key);
      const part = w && all ? w.out / all : 0;
      const plan = planName(a.plan);
      return h('div', { class: `tr acct-tr${a.here ? ' here' : ''}`, data: { acct: a.key } },
        h('div', { class: 'acct-who' },
          h('div', { class: 'acct-name', title: a.email || a.key }, h('i', { class: 'swatch', style: `background:${acctColor(a)}` }), h('b', { text: acctName(a, v.names) }),
            plan && h('span', { class: 'chip', text: plan }), a.here && h('span', { class: 'chip here', text: 'in use' }),
            a === best && h('span', { class: 'chip here', text: 'most room', tip: 'The most room of your other accounts, as last seen on this machine.' })),
          h('div', { class: 'acct-when', text: a.here ? (a.from ? `since ${whenOf(a.from)}` : 'in use now') : a.to ? `last used ${dateTime(a.to)}` : 'not seen in use' })),
        limit(a, windowOf(a.five, now), 'five', a.pace.five),
        limit(a, windowOf(a.week, now), 'week', a.pace.week),
        h('div', { class: 'acct-use', tip: w ? `Under this account ${words}:\n${whole(w.out)} tokens out · ${whole(w.in + w.cacheWrite)} in · ${whole(w.cacheRead)} re-read from the cache\n${whole(w.replies)} replies · ${hours(w.work)} of agent work` : '' },
          w ? [h('b', { text: count(w.out) }), h('span', { text: ` out · ${hours(w.work)} work` })] : h('span', { class: 'quiet', text: 'nothing' })),
        h('div', { class: 'acct-share' }, share(part, acctColor(a)), h('span', { text: w && all ? `${Math.round(part * 100)}%` : '' })));
    });
    const t = h('div', { class: 'table accts', style: '--cols:minmax(200px,1.5fr) minmax(150px,1fr) minmax(150px,1fr) minmax(130px,.9fr) minmax(90px,.6fr)' },
      h('div', { class: 'tr th' }, ['Account', '5-hour limit', 'Weekly limit', u.range === 'today' ? 'Today' : u.range === '7d' ? '7 days' : '30 days', 'Share of tokens out'].map((x) => h('span', { text: x }))),
      lines);
    const lost = by.get(UNKNOWN);
    return panel('Your accounts', 'found on this machine · a figure with "≥" is what was last seen: it may have been used elsewhere since',
      h('div', { class: 'table-box' }, t),
      lost && all > 0 && lost.out > 0 && h('p', { class: 'quiet', tip: 'An account is known from the moment this app first ran, and before that wherever Claude Code left a trace on disk of who was logged in.\nFrom now on every change of account is recorded as it happens.' },
        `${Math.round((lost.out / all) * 100)}% of the tokens written ${words} cannot be tied to an account: nothing on disk says which one was logged in at the time.`));
  }

  /** Who was logged in when, the last fourteen days, as one band. */
  function ribbon(v, now) {
    const first = new Date(now);
    first.setHours(0, 0, 0, 0);
    first.setDate(first.getDate() - (RIBBON_DAYS - 1));
    const from = first.getTime();
    const by = new Map(v.list.map((a) => [a.key, a]));
    const segs = [];
    for (let i = 0; i < v.marks.length; i++) {
      const s = Math.max(from, v.marks[i].at);
      const e = i + 1 < v.marks.length ? v.marks[i + 1].at : now;
      if (e > s) segs.push({ key: v.marks[i].key, seen: v.marks[i].seen, s, e });
    }
    if (!segs.length) return null;
    if (segs[0].s > from) segs.unshift({ key: '', seen: false, s: from, e: segs[0].s });
    const band = h('div', { class: 'ribbon' }, segs.map((g) => {
      const a = by.get(g.key);
      const who = !g.key ? 'Not known' : a ? acctName(a, v.names) : `Account ${g.key}`;
      const how = !g.key ? 'Nothing on disk says which account was logged in then.'
        : g.seen ? 'Seen by this app as it happened.' : 'Worked out from when /login was typed and from what Claude Code kept on disk.';
      return h('i', { class: `${g.key ? '' : 'unknown'}${g.key && !g.seen ? ' worked-out' : ''}`, style: `flex:${g.e - g.s} 0 0${a ? `;background:${acctColor(a)}` : ''}`,
        tip: `${who}\n${dateTime(g.s)} to ${g.e >= now ? 'now' : dateTime(g.e)} · ${left(g.e - g.s)}\n${how}` });
    }));
    const axis = h('div', { class: 'ribbon-axis' });
    for (let i = 0; i < RIBBON_DAYS; i++) {
      const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      axis.append(h('span', { style: `left:${(((day.getTime() - from) / (now - from)) * 100).toFixed(2)}%`,
        text: i % 2 === 0 ? day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '' }));
    }
    return panel('Which account was logged in', 'the last 14 days · striped: worked out, not seen', band, axis);
  }

  function render(state) {
    const u = state.usage;
    const now = Date.now();
    drawRunning(state);
    drawFeed(state, now);
    if (!u || u.range !== state.range) {
      if (drawn !== 'wait') {
        drawn = 'wait';
        fill(wrap, h('div', { class: 'page-head' }, h('div', null, h('h1', { class: 'd-title', text: 'Dashboard' }), h('p', { class: 'd-sum', text: 'Adding it up…' })), seg(RANGES, state.range, act.range)), runBox, feedBox);
      }
      Parts.tick(root);
      return;
    }
    const v = Parts.acctView(state);
    const told = (w) => w && [w.used, w.until, Math.floor(w.at / 60e3)];
    // where a limit is heading moves with the clock: a look every five minutes keeps it honest
    const stamp = `${u.at}|${metric.id}|${Math.floor(now / 300e3)}|${JSON.stringify([v.list.map((a) => [a.key, a.here, a.to, told(a.five), told(a.week), a.here && a.pace]), v.names, v.marks.length])}`;
    if (stamp === drawn || selectionIn(root)) { Parts.tick(root); return; }
    drawn = stamp;
    const t = u.total;
    const words = rangeWords(u.range);
    const input = t.in + t.cacheWrite + t.cacheRead;
    const strip = h('div', { class: 'kpis eight' },
      kpi(count(t.out), 'tokens out', `Written by the models ${words}: ${whole(t.out)} tokens.\n${whole(t.think)} of them (${t.out ? Math.round((t.think / t.out) * 100) : 0}%) spent thinking.`),
      kpi(count(t.in + t.cacheWrite), 'tokens in', `Read by the models as new input ${words}:\n${whole(t.in)} new + ${whole(t.cacheWrite)} written to the cache.`),
      kpi(count(t.cacheRead), 'cache re-read', `Re-read from the cache ${words}: ${whole(t.cacheRead)} tokens.\nThat is ${input ? ((t.cacheRead / input) * 100).toFixed(1) : '0'}% of everything the models were given to read.`),
      kpi(hours(t.work), 'agent work', 'Time your agents spent working, added up over every chat and subagent.\nSeveral at once count several times. Waiting for you does not count.'),
      kpi(whole(t.replies), 'replies', 'Answers the models gave: tool calls and words alike.'),
      kpi(whole(t.asked), 'typed by you', 'Messages you typed into a chat.'),
      kpi(whole(t.tools), 'tool calls', `${whole(u.toolKinds)} different tools.`),
      kpi(whole(t.agents), 'subagents', 'Subagents started by your chats.'));

    // ---- day by day; the tokens written are drawn in the shades of the accounts they were written under ----
    const today = u.days[u.days.length - 1].day;
    const inRange = u.range === 'today' ? 1 : u.range === '7d' ? 7 : 30;
    const stacked = metric.id === 'out' && v.list.length > 1;
    const days = barChart(u.days.map((d, i) => {
      const who = d.who || {};
      const split = v.list.filter((a) => who[a.key] > 0).map((a) => `${acctName(a, v.names)}: ${count(who[a.key])}`);
      if (who[UNKNOWN] > 0) split.push(`account not known: ${count(who[UNKNOWN])}`);
      return {
        value: metric.get(d),
        mark: d.day === today ? 'now' : i < u.days.length - inRange ? 'dim' : '',
        label: dayLabel(d.day).split(' ').slice(1).join(' '),
        parts: stacked ? [...v.list.map((a) => ({ value: who[a.key] || 0, color: acctColor(a) })), { value: who[UNKNOWN] || 0, color: ACCT_NONE }] : null,
        tip: `${dayLabel(d.day, true)}\n${count(d.out)} tokens out · ${hours(d.work)} of work\n${whole(d.replies)} replies · ${whole(d.tools)} tool calls · ${whole(d.asked)} typed\n${count(d.in + d.cacheWrite)} in · ${count(d.cacheRead)} re-read from cache${split.length ? `\n${split.join(' · ')}` : ''}`,
      };
    }), { height: 132, format: metric.format, every: 5 });
    const byDay = panel('Day by day', seg(METRICS.map((m) => [m.id, m.name]), metric.id, (id) => { metric = METRICS.find((m) => m.id === id); render(state); }), days,
      stacked && h('div', { class: 'legend' }, v.list.map((a) => h('span', null, h('i', { class: 'swatch', style: `background:${acctColor(a)}` }), acctName(a, v.names))),
        h('span', null, h('i', { class: 'swatch', style: `background:${ACCT_NONE}` }), 'not known')));

    // ---- hour by hour: yesterday, then today ----
    const nowHour = new Date().getHours();
    const hoursChart = barChart(u.hours.map((x, i) => {
      const hour = i % 24;
      return {
        value: metric.get(x),
        mark: i === 24 + nowHour ? 'now' : i > 24 + nowHour ? 'dim' : '',
        label: hour === 0 ? (i < 24 ? 'yesterday' : 'today') : String(hour).padStart(2, '0'),
        tip: `${i < 24 ? 'Yesterday' : 'Today'}, ${String(hour).padStart(2, '0')}:00 to ${String((hour + 1) % 24).padStart(2, '0')}:00\n${count(x.out)} tokens out · ${whole(x.replies)} replies · ${hours(x.work)} of work`,
      };
    }), { height: 96, format: metric.format, every: 6 });
    const byHour = panel('Hour by hour', `yesterday and today · ${metric.name.toLowerCase()}`, hoursChart);

    // ---- today, chat by chat: one cell per hour, the brighter the more its agents worked in it ----
    const lanes = u.lanes || [];
    const where = new Map(state.snap.chats.map((c) => [c.session, c]));
    const byChat = panel('Today, chat by chat', 'one cell per hour · brighter: more agent work', lanes.length
      ? h('div', { class: 'lanes' }, lanes.map((lane) => h('div', { class: `lane${where.has(lane.key) ? ' live' : ''}` },
        h('span', { class: 'name two' }, h('span', { text: lane.title || 'Untitled conversation', title: lane.title }), h('em', { text: lane.name })),
        h('div', { class: 'cells' }, lane.work.map((ms, i) => {
          const on = ms > 0 || lane.out[i] > 0;
          return h('i', { class: `${on ? 'on' : ''}${i > nowHour ? ' ahead' : ''}`, style: on ? `opacity:${(0.22 + 0.78 * Math.min(1, ms / 3600e3)).toFixed(2)}` : null,
            tip: on ? `${String(i).padStart(2, '0')}:00 to ${String((i + 1) % 24).padStart(2, '0')}:00\n${hours(ms)} of agent work · ${count(lane.out[i])} tokens out` : null });
        })),
        h('b', { text: hours(lane.sum), tip: `${hours(lane.sum)} of agent work today · ${count(lane.tokens)} tokens out` }))),
      h('div', { class: 'lane axis' }, h('span'), h('div', { class: 'cells' }, Array.from({ length: 24 }, (_, i) => h('span', { text: i % 3 === 0 ? String(i).padStart(2, '0') : '' }))), h('span')))
      : none('Nothing yet today.'));

    // ---- by project, by model ----
    const topOut = Math.max(1, ...u.projects.map((p) => p.out));
    const projects = panel('By project', `${whole(u.active.projects)} active ${words}`, u.projects.length
      ? table('minmax(0,1fr) 84px 64px 72px 60px', ['Project', '', 'Out', 'Work', 'Typed'], u.projects.map((p) => [
        h('span', { class: 'name', text: p.name, title: p.name }), share(p.out / topOut),
        h('b', { text: count(p.out) }), h('span', { text: hours(p.work) }), h('span', { text: whole(p.asked) })]))
      : none('Nothing yet.'));
    const allOut = Math.max(1, u.models.reduce((n, m) => n + m.out, 0));
    const models = panel('By model', 'share of the tokens written', u.models.length
      ? table('minmax(0,1fr) 84px 48px 64px 64px 64px', ['Model', '', '', 'Out', 'In', 'Cached'], u.models.map((m) => [
        h('span', { class: 'name', text: modelName(m.key), title: m.key }), share(m.out / allOut), h('span', { text: `${Math.round((m.out / allOut) * 100)}%` }),
        h('b', { text: count(m.out) }), h('span', { text: count(m.in + m.cacheWrite) }), h('span', { text: count(m.cacheRead) })]))
      : none('Nothing yet.'));

    // ---- the busiest conversations, the tools ----
    const busiest = panel('Busiest chats', `${whole(u.active.chats)} active ${words}`, u.chats.length
      ? table('minmax(0,1fr) 64px 72px 84px', ['Chat', 'Out', 'Work', ''], u.chats.map((c) => {
        const live = where.get(c.key);
        const here = live && live.chat && state.chats.some((x) => x.id === live.chat);
        const button = here ? h('button', { class: 'btn sm', text: 'Open', onclick: () => act.open(live.chat) })
          : live ? h('button', { class: 'btn ghost sm', text: 'Show', tip: 'It runs in another terminal: look at it from here', onclick: () => act.show(live.key) })
            : h('button', { class: 'btn ghost sm', text: 'Read', tip: 'Read this conversation in History', onclick: () => act.read(c.key) });
        return [h('span', { class: 'name two' }, h('span', { text: c.title || 'Untitled conversation', title: c.title }), h('em', { text: c.name })),
          h('b', { text: count(c.out) }), h('span', { text: hours(c.work) }), button];
      }))
      : none('Nothing yet.'));
    const topCalls = Math.max(1, ...u.tools.map((x) => x.calls));
    const tools = panel('Tools', `${whole(u.toolKinds)} different ones ${words}`, u.tools.length
      ? table('minmax(0,1fr) 120px 64px', ['Tool', '', 'Calls'], u.tools.map((x) => [
        h('span', { class: 'name mono', text: x.name, title: x.name }), share(x.calls / topCalls), h('b', { text: whole(x.calls) })]))
      : none('No tool was run.'));

    // ---- limits reached, and the rest ----
    const limits = panel('Limits you ran into', 'the last 30 days', u.limits.length
      ? h('div', { class: 'list-lines' }, u.limits.map((l) => h('div', { class: `line${l.until > now ? ' live' : ''}` },
        glyph(l.until > now ? 'needs' : 'idle', 13),
        h('span', { class: 'name', text: limitName(l.type).replace(/^./, (ch) => ch.toUpperCase()) }),
        h('span', { text: `${dateTime(l.at)}${l.until ? ` · ${l.until > now ? 'lifts' : 'lifted'} ${sameDay(l.at, l.until) ? clockShort(l.until) : dateTime(l.until)}` : ''}`,
          tip: `Reached ${dateTime(l.at)}.${l.until ? `\n${l.until > now ? 'Lifts' : 'Lifted'} ${dateTime(l.until)}.` : ''}` }),
        h('span', { class: 'end', text: `${l.chats} chat${l.chats === 1 ? '' : 's'}`, tip: 'How many conversations were turned down by it' }))))
      : none('None. No chat was turned down for a usage limit in the last 30 days.'));
    const r = u.recorded;
    const facts = h('dl', { class: 'plist' });
    const fact = (k, val, tip) => facts.append(h('dt', { text: k }), h('dd', { text: val, tip }));
    fact('Memory compactions', `${whole(t.comp)}${t.comp ? ` · ${hours(t.compMs)} spent compacting` : ''}`, 'Times a chat squeezed its memory to make room, and how long that took in all.');
    fact('Errors from the service', `${whole(t.err)}${t.lim ? ` · ${whole(t.lim)} of them a usage limit` : ''}`, 'Requests the service answered with an error instead of a reply.');
    fact('Thinking', `${count(t.think)} tokens · ${t.out ? Math.round((t.think / t.out) * 100) : 0}% of what was written`, 'Output tokens the models spent reasoning before they answered.');
    fact('Web searches and page reads', whole(t.web), 'Searches and page fetches the service ran for your chats.');
    if (r.conversations) {
      fact("Claude Code's own cost notes", `${dollars(r.usd)} at list prices · +${whole(r.added)} / −${whole(r.removed)} lines · ${whole(r.conversations)} chats`,
        'Added up from the cost note Claude Code itself saves into a conversation when its program ends, for the chats of the last 30 days that have one.\nNot every chat has one, and list prices are not what a subscription pays: a floor, not a bill.');
    }
    const rest = panel('Memory, errors and extras', words, facts);

    const rd = u.reading;
    const behind = rd.counting && rd.read < rd.bytes * 0.999;
    const foot = h('p', { class: 'foot-note quiet' },
      behind
        ? `${rd.today === false ? 'Counting today first.' : 'Today is counted.'} Still reading your older history: ${Math.floor((rd.read / Math.max(1, rd.bytes)) * 100)}% of ${(rd.bytes / 1073741824).toFixed(1)} GB (${whole(rd.done)} of ${whole(rd.files)} files). The older days grow until it is done.`
        : `Counted from the ${whole(rd.files)} conversation files (${(rd.bytes / 1073741824).toFixed(1)} GB) Claude Code keeps on this machine. Nothing here asks Anthropic anything.`,
      ' Day-by-day detail goes back 40 days.');

    const at = root.scrollTop;
    fill(wrap,
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { class: 'd-title', text: 'Dashboard' }), h('p', { class: 'd-sum', text: 'What is running now, your accounts, and every Claude Code conversation on this machine, subagents included.' })),
        seg(RANGES, u.range, act.range)),
      runBox,
      feedBox,
      v.list.length > 0 && accounts(u, v, now, words),
      v.list.length > 0 && ribbon(v, now),
      panel(u.range === 'today' ? 'Today' : u.range === '7d' ? 'The last 7 days' : 'The last 30 days', '', strip),
      byDay, byHour, byChat,
      h('div', { class: 'cols2' }, projects, models),
      h('div', { class: 'cols2' }, busiest, tools),
      h('div', { class: 'cols2' }, limits, rest),
      foot);
    root.scrollTop = at;
    Parts.tick(root);
  }

  return { init, render, reset: () => { drawn = ''; } };
})();
