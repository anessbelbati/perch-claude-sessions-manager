'use strict';
// The window's own icons, built the way Heron's are: a 24-unit grid, strokes 1.75 wide with round ends, and
// inside the main shape a faint fill that gives the set its depth. Each icon is an outline (d), most carry
// that fill (t), and a few small marks are solid (s). Nothing here comes from an icon pack. The shapes Heron
// already has are its own drawings, taken over as they are; the rest are drawn to match.

const Icons = (() => {
  const n = (v) => +v.toFixed(2);
  /** A circle as a path, so it can join the others in one d. */
  const c = (x, y, r) => `M${n(x - r)} ${n(y)}a${r} ${r} 0 1 0 ${n(2 * r)} 0a${r} ${r} 0 1 0 ${n(-2 * r)} 0Z`;
  /** A box with round corners, drawn clockwise from its top left. */
  const box = (x, y, w, h, r) =>
    `M${n(x + r)} ${n(y)}h${n(w - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${n(h - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${r}h${n(-(w - 2 * r))}a${r} ${r} 0 0 1 ${-r} ${-r}v${n(-(h - 2 * r))}a${r} ${r} 0 0 1 ${r} ${-r}Z`;
  /** A round dot the width of the stroke. */
  const dot = (x, y) => `M${x} ${y}h.01`;

  const PAGE = 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8Z';
  const PAGE_FOLD = 'M14 3v3.5A1.5 1.5 0 0 0 15.5 8H19';
  const BUBBLE = 'M7 4.5h10A3.5 3.5 0 0 1 20.5 8v6a3.5 3.5 0 0 1-3.5 3.5h-4.3l-4.1 3.1c-.5.4-1.1 0-1.1-.6v-2.5H7A3.5 3.5 0 0 1 3.5 14V8A3.5 3.5 0 0 1 7 4.5Z';
  const RING = c(12, 12, 9);
  const WINDOW = box(3, 4.5, 18, 15, 2.5);
  const FOLDER = 'M3 7.5A2.5 2.5 0 0 1 5.5 5h3.4c.7 0 1.3.3 1.8.7L12 7h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z';
  const HOUSE = 'M4 11.2 12 4.5l8 6.7V18.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z';
  const BELL = 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z';
  const BOLT = 'M13 3 5 13.5h6L10 21l8.5-10.5h-6Z';
  const PLAY = 'M8 5.6v12.8a1 1 0 0 0 1.5.86l10.6-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6Z';

  const ICONS = {
    // ---------- places ----------
    home: { t: HOUSE, d: HOUSE + 'M10 20.5v-5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5' },
    history: { t: RING, d: RING + 'M12 7.5V12l3 2' },
    usage: { t: box(3, 3.5, 18, 17, 3.5), d: box(3, 3.5, 18, 17, 3.5) + 'M8 16.5v-3M12 16.5v-6M16 16.5V8' },
    // Settings: two switches, one of them on.
    settings: { t: box(3, 13, 18, 7, 3.5), s: c(7.5, 7.5, 2) + c(16.5, 16.5, 2), d: box(3, 4, 18, 7, 3.5) + box(3, 13, 18, 7, 3.5) },
    terminal: { t: WINDOW, d: WINDOW + 'M7.5 9.5l3 2.5-3 2.5M12.5 15h4' },
    folder: { t: FOLDER, d: FOLDER },
    // The sidebar, and the panel beside a chat: a window with one side filled in.
    side: { t: 'M9.5 4.5h-4A2.5 2.5 0 0 0 3 7v10a2.5 2.5 0 0 0 2.5 2.5h4Z', d: WINDOW + 'M9.5 4.5v15' },
    panel: { t: 'M14.5 4.5h4A2.5 2.5 0 0 1 21 7v10a2.5 2.5 0 0 1-2.5 2.5h-4Z', d: WINDOW + 'M14.5 4.5v15' },
    // How many chats share the screen: the same window, whole, cut in two, cut in four.
    'tile-1': { t: WINDOW, d: WINDOW },
    'tile-2': { t: 'M12 4.5H5.5A2.5 2.5 0 0 0 3 7v10a2.5 2.5 0 0 0 2.5 2.5H12Z', d: WINDOW + 'M12 4.5v15' },
    'tile-4': { t: 'M12 4.5H5.5A2.5 2.5 0 0 0 3 7v5h9Z', d: WINDOW + 'M12 4.5v15M3 12h18' },

    // ---------- actions ----------
    search: { t: c(10.5, 10.5, 6.5), d: c(10.5, 10.5, 6.5) + 'M15.2 15.2 20 20' },
    plus: { d: 'M12 5v14M5 12h14' },
    x: { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' },
    check: { d: 'M5 12.5l4.5 4.5L19 7.5' },
    'chevron-right': { d: 'M9.5 6l6 6-6 6' },
    'chevron-down': { d: 'M6 9.5l6 6 6-6' },
    'arrow-right': { d: 'M5 12h14M13 6l6 6-6 6' },
    'arrow-left': { d: 'M19 12H5M11 6l-6 6 6 6' },
    'arrow-up': { d: 'M12 19V5M6 11l6-6 6 6' },
    'arrow-down': { d: 'M12 5v14M6 13l6 6 6-6' },
    // Bring here: an arrow coming down into a tray.
    bring: { d: 'M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 15.5v2A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-2' },
    external: { d: 'M13.5 4.5H19.5V10.5M19.5 4.5l-8.5 8.5M10 6H7a2.5 2.5 0 0 0-2.5 2.5V17A2.5 2.5 0 0 0 7 19.5h8.5A2.5 2.5 0 0 0 18 17v-3' },
    copy: { t: box(8.5, 8.5, 12.5, 12.5, 2.5), d: box(8.5, 8.5, 12.5, 12.5, 2.5) + 'M15.5 8.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h3.5' },
    pencil: { t: 'M16.5 4.5a2.12 2.12 0 0 1 3 3L8.3 18.7 4 20l1.3-4.3Z', d: 'M16.5 4.5a2.12 2.12 0 0 1 3 3L8.3 18.7 4 20l1.3-4.3ZM14.4 6.6l3 3' },
    play: { t: PLAY, d: PLAY },
    refresh: { d: 'M20 12a8 8 0 0 1-13.9 5.4M4 12a8 8 0 0 1 13.9-5.4M18.2 3.2V7h-3.8M5.8 20.8V17h3.8' },
    more: { s: c(5.5, 12, 1.6) + c(12, 12, 1.6) + c(18.5, 12, 1.6) },
    filter: { d: 'M4 6.5h16M7 12h10M10 17.5h4' },
    keyboard: { t: box(2.5, 6, 19, 12, 2.5), d: box(2.5, 6, 19, 12, 2.5) + dot(6.5, 10) + dot(10, 10) + dot(13.5, 10) + dot(17.5, 10) + 'M7.5 14h9' },

    // ---------- states and facts ----------
    bell: { t: BELL, d: BELL + 'M10 20.5a2 2 0 0 0 4 0' },
    info: { t: RING, d: RING + 'M12 11v5.5' + dot(12, 7.9) },
    alert: {
      t: 'M10.27 4.5a2 2 0 0 1 3.46 0l7.1 12.3a2 2 0 0 1-1.73 3H4.9a2 2 0 0 1-1.73-3Z',
      d: 'M10.27 4.5a2 2 0 0 1 3.46 0l7.1 12.3a2 2 0 0 1-1.73 3H4.9a2 2 0 0 1-1.73-3ZM12 9.5v4' + dot(12, 16.6),
    },
    clock: { t: RING, d: RING + 'M12 7.5V12l3 2' },
    user: { t: c(12, 8, 4), d: c(12, 8, 4) + 'M4.5 20.5c.8-3.6 3.8-6 7.5-6s6.7 2.4 7.5 6' },
    // What a person typed: a speech bubble with lines in it.
    asked: { t: BUBBLE, d: BUBBLE + 'M8 9.5h8M8 13h5' },
    // A tool call.
    bolt: { t: BOLT, d: BOLT },
    // Subagents: one node handing work to two.
    agents: { t: c(12, 5.5, 2.5), d: c(12, 5.5, 2.5) + c(6, 18.5, 2.5) + c(18, 18.5, 2.5) + 'M12 8v2.5M12 10.5c0 3.2-6 2.3-6 5.5M12 10.5c0 3.2 6 2.3 6 5.5' },
    // A change to a file: a page with a plus and a minus.
    diff: { t: PAGE, d: PAGE + PAGE_FOLD + 'M9.5 12h5M12 9.5v5M9.5 17.5h5' },
    file: { t: PAGE, d: PAGE + PAGE_FOLD + 'M9 12.5h6M9 16h4' },
    coins: { t: c(9.5, 9.5, 6), d: c(9.5, 9.5, 6) + 'M15.43 8.57A6 6 0 1 1 8.57 15.43' },
    gauge: { s: c(12, 13, 1.6), d: 'M6 19A8.5 8.5 0 1 1 18 19M12 13l3.5-3.5' },
    // Memory: a chip.
    memory: {
      t: box(9.5, 9.5, 5, 5, 1),
      d: box(6, 6, 12, 12, 2.5) + box(9.5, 9.5, 5, 5, 1) + 'M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5',
    },
    // The cache: layers kept warm.
    layers: { t: box(3, 8, 13.5, 12.5, 2.5), d: box(3, 8, 13.5, 12.5, 2.5) + 'M6.5 8A2.5 2.5 0 0 1 9 5.5h8.5A2.5 2.5 0 0 1 20 8v7.5a2.5 2.5 0 0 1-2.5 2.5h-1' },
    // Memory squeezed to make room: two arrows closing on a line.
    compact: { d: 'M4 12h16M12 3.5v5M9.5 6l2.5 2.5L14.5 6M12 20.5v-5M9.5 18l2.5-2.5 2.5 2.5' },
    list: { d: 'M9 6.5h11M9 12h11M9 17.5h11' + dot(4.5, 6.5) + dot(4.5, 12) + dot(4.5, 17.5) },
    calendar: { t: 'M3.5 7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5V10h-17Z', d: box(3.5, 5, 17, 15.5, 2.5) + 'M8 3v4M16 3v4M3.5 10h17' },
  };

  const NS = 'http://www.w3.org/2000/svg';
  /** An icon as an element. size in px. An unknown name gives an empty one, so a typo never breaks a view. */
  function icon(name, size = 16, extra = '') {
    const g = ICONS[name] || {};
    const svg = document.createElementNS(NS, 'svg');
    const set = (el, attrs) => { for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
    set(svg, { class: `i${extra ? ' ' + extra : ''}`, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    if (g.t) svg.append(set(document.createElementNS(NS, 'path'), { class: 'i-t', d: g.t, fill: 'currentColor', 'fill-opacity': '0.16', stroke: 'none' }));
    if (g.s) svg.append(set(document.createElementNS(NS, 'path'), { d: g.s, fill: 'currentColor', stroke: 'none' }));
    if (g.d) svg.append(set(document.createElementNS(NS, 'path'), { d: g.d }));
    return svg;
  }

  // What a session is doing, told by shape as well as by colour, so it reads without the hue:
  //   needs      a solid disc with an exclamation mark     it waits for the person
  //   error      a ring struck through                     it stopped on an error
  //   working    a ring, half full                         it is at work
  //   compacting a broken ring, half full                  it is squeezing its memory
  //   done       a solid disc with a tick                  it finished, and nobody has looked yet
  //   idle       an empty ring                             nothing is asked of it
  //   ended      a ring with a dash                        its program has ended
  //   none       a dotted ring                             nothing is known
  const G_RING = '<circle cx="7" cy="7" r="5.65" fill="none" stroke="currentColor" stroke-width="1.5"';
  const GLYPHS = {
    needs: '<circle cx="7" cy="7" r="6.4" fill="currentColor"/><path d="M7 3.7v3.9" fill="none" stroke="#111113" stroke-width="1.7" stroke-linecap="round"/><circle cx="7" cy="10.15" r="1" fill="#111113"/>',
    error: G_RING + '/><path d="M3.05 10.95 10.95 3.05" stroke="currentColor" stroke-width="1.5"/>',
    working: G_RING + '/><path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/>',
    compacting: G_RING + ' stroke-dasharray="3.2 2.72"/><path d="M7 3.9a3.1 3.1 0 0 1 0 6.2z" fill="currentColor"/>',
    done: '<circle cx="7" cy="7" r="6.4" fill="currentColor"/><path d="M4.3 7.1l1.8 1.8 3.6-3.7" fill="none" stroke="#111113" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    idle: G_RING + '/>',
    ended: G_RING + '/><path d="M4.6 7h4.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    none: G_RING + ' stroke-dasharray="1.77 2.66"/>',
  };
  const parser = new DOMParser();
  /** The mark of a state, as an element. An unknown state reads as "nothing is known". */
  function glyph(state, size = 14) {
    const k = Object.hasOwn(GLYPHS, state) ? state : 'none';
    // the marks are constants of this file: nothing read from a transcript ever reaches this markup
    const doc = parser.parseFromString(`<svg xmlns="${NS}" class="glyph g-${k}" width="${size}" height="${size}" viewBox="0 0 14 14" aria-hidden="true">${GLYPHS[k]}</svg>`, 'image/svg+xml');
    return document.importNode(doc.documentElement, true);
  }

  return { icon, glyph, names: Object.keys(ICONS), states: Object.keys(GLYPHS) };
})();
const icon = Icons.icon;
const glyph = Icons.glyph;
