'use strict';
/* global desk, h, icon, folderOf, dateTime, acctColor, planName, Parts, Terms */
// The Settings panel: when to put a note near the clock, the terminal's text
// size, the workspaces and their folders, what the accounts are called,
// shortcuts to the app (made only when asked for), and the keys.

const Settings = (() => {
  const KEYS = [
    ['Ctrl Shift P', 'Search chats, commands, things you typed'],
    ['Ctrl Shift T', 'New chat'],
    ['Ctrl Shift W', 'Close the chat that has the keyboard'],
    ['Ctrl Shift N', 'Next chat that needs you'],
    ['Ctrl Tab', 'Back to the chat you were just in. Keep Ctrl down and press Tab again to go further back'],
    ['Ctrl 1 … 9', 'A chat by its place: the first ones are the chats on screen'],
    ['Ctrl Shift 1 … 9', 'A workspace by its tab: 1 is every chat'],
    ['Ctrl Shift Enter', 'One chat big, or back to the chats side by side'],
    ['Ctrl Shift I', 'The panel beside the chat'],
    ['Ctrl Shift H', 'History'],
    ['Ctrl Shift U', 'Dashboard'],
    ['F5', 'Look again now: sessions, the account logged in, the limits'],
    ['Ctrl ,', 'Settings'],
    ['J K or ↑ ↓', 'In History: the next or the previous row'],
    ['/', 'In History: the filter box'],
    ['Esc', 'Back: from a chat you are only looking at, or to the list in History'],
    ['Shift Enter', 'A new line in the prompt box'],
    ['Right click', 'Copy the selection, or paste'],
    ['Ctrl Shift C / V', 'Copy and paste'],
    ['Ctrl click', 'Open a web link'],
    ['Ctrl wheel', 'Text size'],
  ];
  // what closing the window with chats open does
  const KEEP = [['ask', 'Ask me'], ['always', 'Keep them'], ['never', 'Start fresh'], ['tray', 'Keep running']];
  let root = null;
  let state = null;
  let act = null;
  let body = null;

  const isOpen = () => Boolean(root) && !root.hidden;

  function init(el, deskState, actions) {
    root = el;
    state = deskState;
    act = actions;
    body = h('div', { class: 'set-body' });
    root.append(h('div', { class: 'dialog settings', role: 'dialog', 'aria-label': 'Settings' },
      h('h2', { text: 'Settings' }), body,
      h('div', { class: 'foot' }, h('span', { class: 'hint', text: 'Changes apply at once · Esc closes' }), h('button', { class: 'btn primary', text: 'Done', onclick: close }))));
    root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    });
  }

  /** quiet: the panel is left as it is (a name being typed into the next field must not be swept away). */
  async function set(patch, quiet) {
    const next = await desk.settings(patch);
    if (next) act.changed(next);
    if (!quiet) draw();
  }
  async function link(kind, on) {
    const links = await desk.shortcut(kind, on);
    if (links) state.settings.links = links;
    draw();
  }

  function toggle(on, label, note, flip) {
    return h('div', { class: 'set-row', onclick: flip },
      h('div', { class: 'what' }, h('div', { text: label }), note && h('div', { class: 'quiet', text: note })),
      h('button', { class: `switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label }, h('i')));
  }
  const section = (title, note, ...kids) => h('section', null, h('h3', null, title, note && h('span', { text: note })), ...kids);

  /** One line per account this machine has logged in to: what it is, and a field for what to call it. */
  function accountRows() {
    const v = Parts.acctView(state);
    if (!v.list.length) return [h('p', { class: 'quiet', text: 'No account found yet. It shows here once Claude Code is logged in.' })];
    return v.list.map((a) => {
      const kept = v.names[a.key] || '';
      const input = h('input', { type: 'text', class: 'input name-input', value: kept, placeholder: 'Call it…', maxlength: '40', spellcheck: 'false', 'aria-label': `A name for ${a.email || a.key}` });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') input.blur();
        else if (e.key === 'Escape') { input.value = kept; input.blur(); }
      });
      input.addEventListener('blur', () => { if (input.value.trim() !== kept) set({ accountNames: { [a.key]: input.value.trim() } }, true); });
      const facts = [planName(a.plan), a.here ? 'in use now' : a.to ? `last in use ${dateTime(a.to)}` : '',
        !a.email && 'its name is not on this disk yet: it fills in the next time you log into it'].filter(Boolean).join(' · ');
      return h('div', { class: 'set-row acct-row' },
        h('i', { class: 'swatch', style: `background:${acctColor(a)}` }),
        h('div', { class: 'what' }, h('div', { text: a.email || `Account ${a.key}` }), facts && h('div', { class: 'quiet', text: facts })),
        input);
    });
  }

  /** A field for a name: Enter keeps it, Esc puts back what was there. keep(name) is told only a name that changed. */
  function nameField(value, label, placeholder, keep) {
    let was = value;
    const input = h('input', { type: 'text', class: 'input name-input', value, placeholder, maxlength: '24', spellcheck: 'false', 'aria-label': label });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') { input.value = was; input.blur(); }
    });
    input.addEventListener('blur', () => {
      const name = input.value.replace(/\s+/g, ' ').trim();
      if (name && name !== was) { was = name; input.value = name; keep(name); } else input.value = was;
    });
    return input;
  }

  /**
   * After a change to the workspaces: the panel is drawn again and the keyboard stays in it. The window behind
   * may have moved to another chat meanwhile, and that chat's terminal takes the keyboard when it does.
   */
  function redrawSpaces() {
    draw();
    const field = body.querySelector('.space-new');
    if (field) field.focus({ preventScroll: true });
  }

  /** The workspaces: what each is called, the folders it holds, and a field for a new one. */
  function spaceRows() {
    const rows = [];
    for (const sp of state.settings.spaces || []) {
      const n = sp.folders.length;
      rows.push(h('div', { class: 'set-row space-row', data: { space: sp.id } },
        // The panel is left as it is: the field already says the new name, and it loses the keyboard to whatever
        // was pressed next. Drawn again, that press would land on something that is no longer there.
        nameField(sp.name, `The name of the workspace ${sp.name}`, 'Name', (name) => act.renameSpace(sp.id, name)),
        h('div', { class: 'what quiet', text: n ? `${n} folder${n === 1 ? '' : 's'}` : 'No folder yet' }),
        h('button', { class: 'btn sm', text: 'Take away', tip: 'The workspace goes, its chats stay: they show under "All" again, unsorted.', onclick: () => { act.removeSpace(sp.id); redrawSpaces(); } })));
      for (const f of sp.folders) {
        rows.push(h('div', { class: 'set-row space-folder' }, icon('folder', 14),
          h('div', { class: 'what' }, h('b', { text: folderOf(f) }), h('span', { class: 'quiet', text: f })),
          h('button', { class: 'mini', 'aria-label': `Take ${f} out of ${sp.name}`, tip: 'Take this folder out of the workspace', onclick: () => { act.putFolder(f, ''); redrawSpaces(); } }, icon('x', 12))));
      }
    }
    const fresh = nameField('', 'A name for a new workspace', 'A new workspace: its name', (name) => { act.addSpace(name); redrawSpaces(); });
    fresh.classList.add('space-new');
    rows.push(h('div', { class: 'set-row space-row' }, fresh,
      h('div', { class: 'what quiet', text: 'Type a name and press Enter.' })));
    return rows;
  }

  function draw() {
    const s = state.settings;
    const n = s.notify || {};
    const links = s.links || {};
    const size = h('div', { class: 'set-row' },
      h('div', { class: 'what' }, h('div', { text: 'Text size in the terminals' }), h('div', { class: 'quiet', text: 'Also: hold Ctrl and turn the mouse wheel over a terminal.' })),
      h('div', { class: 'stepper' },
        h('button', { class: 'btn sm', text: '−', 'aria-label': 'Smaller', onclick: () => set({ fontSize: s.fontSize - 1 }) }),
        h('b', { text: `${s.fontSize} px` }),
        h('button', { class: 'btn sm', text: '+', 'aria-label': 'Larger', onclick: () => set({ fontSize: s.fontSize + 1 }) })));
    body.replaceChildren(
      section('Notes near the clock', 'while this window is not in front',
        toggle(n.here, 'When a chat in this window needs you', 'It asks a question, wants your permission, or stops on an error.', () => set({ notify: { here: !n.here } })),
        toggle(n.elsewhere, 'When a session in another terminal needs you', 'The same, for chats that run in Windows Terminal or elsewhere.', () => set({ notify: { elsewhere: !n.elsewhere } })),
        toggle(n.finished, 'When a chat in this window finishes its turn', '', () => set({ notify: { finished: !n.finished } })),
        toggle(n.limit, 'When a usage limit is nearly used up', 'Once per 5-hour window and once per week, at 90%, for the account in use. Said in this window instead when you are looking at it.', () => set({ notify: { limit: !n.limit } }))),
      section('Terminal', '', size),
      section('Window', '',
        toggle(!s.solid, 'See-through window', 'Your desktop shows through the sidebar and the title bar, blurred. Windows draws the effect, only while the window is in front. A change applies the next time the app starts. Switch it off if the window ever looks wrong.', () => set({ solid: !s.solid })),
        h('div', { class: 'set-row' },
          h('div', { class: 'what' }, h('div', { text: 'Closing the window with chats open' }),
            h('div', { class: 'quiet', text: 'Kept chats open again by themselves next time, with their names and their permission mode. After a crash or a forced close they come back too.' })),
          h('div', { class: 'seg' }, KEEP.map(([id, name]) => h('button', { class: s.keepChats === id ? 'on' : '', text: name, onclick: () => set({ keepChats: id }) }))))),
      h('section', { data: { section: 'spaces' } }, h('h3', null, 'Workspaces', h('span', { text: 'one tab each above the list of chats' })),
        ...spaceRows(),
        h('p', { class: 'quiet', text: 'A workspace is a name and the folders that belong to it. A chat is in the workspace its folder is in, and so is every chat in a folder inside that one, wherever it runs. To sort a chat, right-click it in the list and pick the workspace. A chat you start while a workspace is in front puts its folder there by itself.' })),
      section('Your accounts', 'found on this machine by themselves · a name is only for you', ...accountRows()),
      section('Ways to open Perch Desk', 'nothing is added until you switch it on',
        toggle(links.startmenu, 'In the Start menu', '', () => link('startmenu', !links.startmenu)),
        toggle(links.desktop, 'On the desktop', '', () => link('desktop', !links.desktop)),
        toggle(links.startup, 'Start with Windows', 'It waits by the clock instead of opening over your work.', () => link('startup', !links.startup))),
      section('Keys', 'the terminal keeps every other key',
        h('div', { class: 'keys' }, KEYS.flatMap(([key, what]) => [h('kbd', { text: key }), h('span', { text: what })]))),
      section('What this app reads', '',
        h('p', { class: 'quiet', text: 'The files Claude Code and Codex write on this machine: which sessions are running, their transcripts and their subagents, and what Claude Code hands your status line (that is where the usage limits, the cost and the cache come from).' }),
        h('p', { class: 'quiet', text: "To tell your accounts apart it reads the name on the account that is logged in (its email, its plan, its id) from Claude Code's settings file, and when you typed /login. It never opens the file that holds the key to an account, it cannot log in, log out or switch, and it never talks to Anthropic. The chats are the real programs, running in real terminals." }),
        h('p', { class: 'quiet', text: 'To show what each session holds on this computer it asks Windows for the programs running under your sessions: their names, the RAM they hold, the processor time they used and the ports they listen on. Every 4 seconds while this window is in front, every 30 seconds otherwise. To tell an MCP server or a dev server from any other program it looks once at how that program was started, and keeps a short name only: never the line itself.' })));
  }

  /** section: the part to open on ('spaces'); the top otherwise. */
  function open(section) {
    if (isOpen()) return;
    draw();
    root.hidden = false;
    const part = typeof section === 'string' ? body.querySelector(`section[data-section="${section}"]`) : null;
    if (part) {
      body.scrollTop = part.offsetTop - body.offsetTop;
      const field = part.querySelector('.name-input');
      if (field) field.focus();
      return;
    }
    body.scrollTop = 0;
    const first = root.querySelector('.switch');
    if (first) first.focus();
  }

  function close() {
    if (!isOpen()) return;
    root.hidden = true;
    Terms.focus();
  }

  return { init, open, close, isOpen };
})();
