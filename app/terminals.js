'use strict';
/* global Terminal, FitAddon, UnicodeGraphemesAddon, WebglAddon, desk, toast */
// The terminal widgets: one per chat. Up to four are on screen at a time, each
// in a place of its own and sized to it. One that is not on screen keeps taking
// its chat's output into its own history; it only stops drawing.

// Windows Terminal's default look (Cascadia Mono 12pt, the Campbell colours),
// so a session here reads like the tabs it replaces. Only the ground is the
// window's own: the colour of the panel the terminal sits in (--panel in
// styles/base.css), so the terminal has no edge of its own.
const CAMPBELL = {
  background: '#111113',
  foreground: '#cccccc',
  cursor: '#ffffff',
  cursorAccent: '#111113',
  selectionBackground: '#ffffff40',
  black: '#0c0c0c',
  red: '#c50f1f',
  green: '#13a10e',
  yellow: '#c19c00',
  blue: '#0037da',
  magenta: '#881798',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#767676',
  brightRed: '#e74856',
  brightGreen: '#16c60c',
  brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff',
  brightMagenta: '#b4009e',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2',
};
const FONT_MIN = 10;
const FONT_MAX = 26;
// a web address as it appears in running text; what may trail it (a full stop, a closing bracket) is cut off below
const WEB_ADDRESS = /https?:\/\/[^\s<>"'`\\^{}|]+/g;

/**
 * How many cells each character takes. The console lays text out by counting
 * cells and the widget must count the same, or everything after a miscounted
 * character on that line is drawn off. The widget's built-in table gives most
 * emoji one cell; the add-on's counts them as the console does (two cells,
 * also when an emoji is built from several code points), but its data stops at
 * the emoji of 2020 and draws every later one a cell short. Those sit in
 * blocks that hold nothing but emoji, so the blocks are widened here, which
 * covers the ones still to come as well.
 */
function widthTable() {
  const found = [];
  // the add-on hands its tables to whatever terminal it is given; this stand-in only collects them
  new UnicodeGraphemesAddon.UnicodeGraphemesAddon().activate({ unicode: { register: (table) => found.push(table) } });
  const base = found.find((table) => table.version === '15-graphemes');
  const newer = (cp) => (cp >= 0x1FA70 && cp <= 0x1FAFF)
    || (cp >= 0x1F90C && cp <= 0x1F9FF && cp !== 0x1F93B && cp !== 0x1F946)
    || (cp >= 0x1F6D5 && cp <= 0x1F6DF)
    || cp === 0x1F7F0;
  return {
    version: 'desk',
    wcwidth: (cp) => (newer(cp) ? 2 : base.wcwidth(cp)),
    charProperties(cp, preceding) {
      const props = base.charProperties(cp, preceding);
      // bit 0: joined onto the character before it; bits 1-2: its cells.
      // Only a one-cell character standing on its own is widened.
      return newer(cp) && (props & 7) === 2 ? (props & ~6) | 4 : props;
    },
  };
}

const Terms = (() => {
  const all = new Map();       // chat id -> { id, term, fit, el, opened, gl, title, told }
  let park = null;             // where the terminals that are not on screen wait
  let info = null;
  let table = null;
  let shown = [];              // the chats on screen
  let active = '';             // the one that holds the keyboard
  // the size a new terminal starts at: the one last fitted
  let cols = 120;
  let rows = 30;
  let fontSize = 16;
  let onTitle = () => {};
  let onFont = () => {};

  /**
   * parkEl: a hidden element that holds the terminals not on screen. room: the element the places on screen share;
   * when its size changes, so does theirs.
   */
  function init(parkEl, room, deskInfo, titleChanged, fontChanged) {
    park = parkEl;
    info = deskInfo;
    table = widthTable();
    cols = info.size.cols;
    rows = info.size.rows;
    fontSize = (info.settings && info.settings.fontSize) || 16;
    onTitle = titleChanged;
    onFont = fontChanged || onFont;
    // A timer, not an animation frame: frames stop while the window is hidden,
    // and a resize must still reach the consoles.
    let pending = 0;
    new ResizeObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(fit, 60);
    }).observe(room);
  }

  function copy(term) {
    const text = term.getSelection();
    if (text) desk.writeClipboard(text);
    return Boolean(text);
  }
  async function paste(term) {
    const text = await desk.readClipboard();
    if (text) term.paste(text);
  }

  function keys(term, id) {
    let copiedAt = 0;
    term.attachCustomKeyEventHandler((e) => {
      const bare = !e.altKey && !e.metaKey;
      // Shift+Enter would send the same byte as Enter. A line feed is the
      // newline every agent CLI accepts (it is what Ctrl+J sends).
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && bare) {
        if (e.type === 'keydown') {
          e.preventDefault();
          desk.input(id, '\n');
        }
        return false;
      }
      // Ctrl+Shift+C and Ctrl+Shift+V: copy and paste, whatever the program in the terminal does with Ctrl+C and Ctrl+V.
      if ((e.code === 'KeyC' || e.code === 'KeyV') && e.ctrlKey && e.shiftKey && bare) {
        if (e.type === 'keydown') {
          e.preventDefault();
          if (e.code === 'KeyC') copy(term); else paste(term);
        }
        return false;
      }
      // Ctrl+V pastes instead of sending ^V, as Windows Terminal does (there too an agent CLI takes a picture with Alt+V).
      if (e.code === 'KeyV' && e.ctrlKey && !e.shiftKey && bare) {
        if (e.type === 'keydown') {
          e.preventDefault();
          paste(term);
        }
        return false;
      }
      // Ctrl+C copies when text is selected and interrupts otherwise, as Windows Terminal does.
      if (e.code === 'KeyC' && e.ctrlKey && !e.shiftKey && bare) {
        if (term.hasSelection()) {
          if (e.type === 'keydown') {
            e.preventDefault();
            copy(term);
            term.clearSelection();
            copiedAt = Date.now();
          }
          return false;
        }
        // the key still held down from that copy must not turn into an interrupt
        if (e.repeat && Date.now() - copiedAt < 3000) return false;
      }
      return true;
    });
  }

  /** A click on a web address opens it in the browser, with Ctrl held: a bare click belongs to the program in the terminal. */
  function follow(event, address) {
    if (event.ctrlKey) desk.openUrl(address);
    else toast('Hold Ctrl and click to open the link.', 2200);
  }

  /** Web addresses in plain text. A line the console wrapped is read as one, so an address broken over two rows stays whole. */
  function links(term) {
    term.registerLinkProvider({
      provideLinks(y, done) {
        const buf = term.buffer.active;
        let first = y - 1;
        while (first > 0 && buf.getLine(first) && buf.getLine(first).isWrapped) first--;
        let last = y - 1;
        while (buf.getLine(last + 1) && buf.getLine(last + 1).isWrapped) last++;
        if (last - first > 24) { done(undefined); return; }
        let text = '';
        const at = [];           // where each character of `text` sits: [column, row]
        for (let row = first; row <= last; row++) {
          const line = buf.getLine(row);
          if (!line) break;
          for (let x = 0; x < line.length; x++) {
            const cell = line.getCell(x);
            // the second cell of a wide character holds nothing of its own
            if (!cell || cell.getWidth() === 0) continue;
            const chars = cell.getChars() || ' ';
            for (let i = 0; i < chars.length; i++) at.push([x, row]);
            text += chars;
          }
        }
        const found = [];
        for (const m of text.matchAll(WEB_ADDRESS)) {
          const address = m[0].replace(/[.,;:!?)\]]+$/, '');
          const start = at[m.index];
          const end = at[m.index + address.length - 1];
          if (!start || !end || end[1] < y - 1 || start[1] > y - 1) continue;
          found.push({ text: address, range: { start: { x: start[0] + 1, y: start[1] + 1 }, end: { x: end[0] + 1, y: end[1] + 1 } }, activate: follow });
        }
        done(found.length ? found : undefined);
      },
    });
  }

  /**
   * A program in the terminal asking to put text on the clipboard (how the
   * agent CLI copies a selection made on its own screen). It may write; a
   * request to read the clipboard is never answered.
   */
  function clipboardRequest(data) {
    const cut = data.indexOf(';');
    const body = cut < 0 ? '' : data.slice(cut + 1);
    if (!body || body === '?') return true;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0)));
      if (text) desk.writeClipboard(text);
    } catch {
      // not the encoding the request is meant to carry: nothing is copied
    }
    return true;
  }

  function mouse(entry) {
    const { term, el } = entry;
    // Right click copies the selection, or pastes when there is none, as Windows Terminal does. While the program
    // in the terminal is taking the mouse for itself, the click is its own unless Shift is held.
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (term.hasSelection()) { copy(term); term.clearSelection(); return; }
      if (term.modes.mouseTrackingMode === 'none' || e.shiftKey) paste(term);
    });
    // A file dropped on a terminal types its path, quoted when it holds a space.
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('drop', (e) => {
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
      if (!files.length) return;
      e.preventDefault();
      const paths = files.map((f) => desk.pathOf(f)).filter(Boolean).map((p) => (/\s/.test(p) ? `"${p}"` : p));
      if (paths.length) term.paste(paths.join(' '));
      term.focus();
    });
    // Ctrl and the wheel: text size.
    term.attachCustomWheelEventHandler((e) => {
      if (!e.ctrlKey) return true;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
      return false;
    });
  }

  function create(id) {
    if (all.has(id)) return all.get(id);
    const el = document.createElement('div');
    el.className = 'term';
    el.hidden = true;
    park.append(el);
    const term = new Terminal({
      cols,
      rows,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize,
      theme: CAMPBELL,
      cursorStyle: 'bar',
      cursorBlink: true,
      scrollback: 10000,
      // The Windows console re-wraps long lines itself on resize; told so, the widget does not wrap them a second time.
      windowsPty: { backend: 'conpty', buildNumber: info.build },
      // links a program marks as such (it names their target itself)
      linkHandler: { activate: follow, allowNonHttpProtocols: false },
      // needed for the width-table switch below, which the widget still labels "proposed"
      allowProposedApi: true,
    });
    const fitter = new FitAddon.FitAddon();
    term.loadAddon(fitter);
    term.unicode.register(table);
    term.unicode.activeVersion = 'desk';
    // told: the size its console was last given ('' until it has been fitted once)
    const entry = { id, term, fit: fitter, el, opened: false, gl: null, title: '', told: '' };
    keys(term, id);
    links(term);
    mouse(entry);
    term.parser.registerOscHandler(52, clipboardRequest);
    term.onData((data) => desk.input(id, data));
    term.onTitleChange((title) => { entry.title = title; onTitle(id, title); });
    all.set(id, entry);
    return entry;
  }

  function remove(id) {
    const entry = all.get(id);
    if (!entry) return;
    if (active === id) { active = ''; window.term = null; }
    shown = shown.filter((x) => x !== id);
    entry.term.dispose();
    entry.el.remove();
    all.delete(id);
  }

  /**
   * A graphics-card context for each terminal on screen, and for no other. It
   * paints box and block characters itself, so frames, bars and block art come
   * out seamless; plain page text leaves hairline gaps between them. If the
   * context is lost it steps aside and the plain renderer carries on.
   */
  function addGl(entry) {
    if (info.renderer !== 'webgl' || entry.gl) return;
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => { gl.dispose(); if (entry.gl === gl) entry.gl = null; });
      entry.term.loadAddon(gl);
      entry.gl = gl;
    } catch {
      // no usable graphics context: the plain renderer is already drawing
    }
  }
  function dropGl(entry) {
    if (!entry.gl) return;
    try { entry.gl.dispose(); } catch { /* its context was already gone */ }
    entry.gl = null;
  }

  /**
   * Tells a terminal that it can be seen again. The widget finds that out by itself only when the next frame is
   * drawn, and until then it puts off every change of size: output that arrives in between is laid out against
   * the height the terminal had before, which leaves it scrolled up by the difference, and no longer following
   * what is printed. It has no public way to be told, so this reaches into it (as its own fit add-on does); if a
   * later version has no such part, the terminal behaves as it would without this.
   */
  function wake(entry) {
    const render = entry.term._core && entry.term._core._renderService;
    if (render && render._isPaused && typeof render._handleIntersectionChange === 'function') {
      render._handleIntersectionChange({ isIntersecting: true, intersectionRatio: 1 });
    }
  }

  /**
   * Puts terminals on screen, each in its place. places: [{ id, host }], the chats to show and the element each
   * is drawn in; none hides them all. front: the one that takes the keyboard. The others stop drawing.
   */
  function show(places, front) {
    const want = new Map(places.filter((p) => all.has(p.id)).map((p) => [p.id, p.host]));
    for (const [id, t] of all) {
      if (want.has(id)) continue;
      t.el.hidden = true;
      dropGl(t);
      if (t.el.parentElement !== park) park.append(t.el);
    }
    for (const [id, host] of want) {
      const t = all.get(id);
      if (t.el.parentElement !== host) host.append(t.el);
      t.el.hidden = false;
      // opened only once it can be seen: the widget measures its font on the spot
      if (!t.opened) {
        t.term.open(t.el);
        t.opened = true;
      }
      wake(t);
      addGl(t);
    }
    shown = [...want.keys()];
    active = want.has(front) ? front : '';
    window.term = active ? all.get(active).term : null;
    fit();
    if (active) all.get(active).term.focus();
  }

  /**
   * Sizes each terminal on screen to the place it is drawn in, and tells its console. One that is not on screen
   * keeps the size it had: it is fitted when it comes back. A place without a size (hidden, or the window
   * mid-minimise) is skipped: fitting to that would squeeze the console to two columns and re-wrap everything
   * on its screen.
   */
  function fit() {
    for (const id of shown) {
      const t = all.get(id);
      const host = t && t.el.parentElement;
      if (!t || !t.opened || !host || host.clientWidth < 80 || host.clientHeight < 40) continue;
      const want = t.fit.proposeDimensions();
      if (!want || !Number.isFinite(want.cols) || !Number.isFinite(want.rows)) continue;
      if (id === active || !active) { cols = want.cols; rows = want.rows; }
      if (t.term.cols !== want.cols || t.term.rows !== want.rows) t.term.resize(want.cols, want.rows);
      const size = `${want.cols}x${want.rows}`;
      if (t.told !== size) {
        t.told = size;
        desk.resize(id, want.cols, want.rows);
      }
    }
  }

  /** The text size of every terminal; the consoles on screen are then given their new number of rows and columns. */
  function setFontSize(size) {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(Number(size)) || fontSize));
    if (next === fontSize) return;
    fontSize = next;
    for (const t of all.values()) t.term.options.fontSize = next;
    fit();
  }
  function zoom(step) {
    const before = fontSize;
    setFontSize(fontSize + step);
    if (fontSize !== before) onFont(fontSize);
  }

  function write(id, data) {
    create(id).term.write(data);
  }

  function focus() {
    const entry = all.get(active);
    if (entry) entry.term.focus();
  }

  return { init, create, remove, show, fit, write, focus, setFontSize, get: (id) => all.get(id), active: () => active, shown: () => shown.slice(),
    size: () => ({ cols, rows }), fontSize: () => fontSize };
})();
