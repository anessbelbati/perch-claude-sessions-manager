'use strict';
/* global h, fill, icon, Detail, Parts */
// Looking at a chat that does not live in this window: one that runs in another
// terminal, a background session, or a conversation whose program ended. It is
// picked in the sidebar and takes the whole panel: what it is doing, its
// conversation as it can be read, the files it changed, and the button that
// moves it here. With nothing picked and no chat open in this window, this is
// the page the window starts on.

const Peek = (() => {
  let root = null;
  let els = null;
  let act = null;
  let detail = null;
  let last = null;
  let shown = false;             // a session is being looked at

  function init(el, actions) {
    root = el;
    act = actions;
    els = { blank: h('div', { class: 'blank start' }), detail: h('div', { hidden: true }) };
    root.append(els.blank, els.detail);
    detail = Detail.create(els.detail, {
      open: act.open, attach: act.attach, arm: act.arm, disarm: act.disarm, resume: act.resume, forget: act.forget, rename: act.rename, close: act.close,
      dismiss: () => act.look(null),
    });
  }

  function subjectOf(state) {
    const sel = state.sel;
    if (sel && sel.kind === 'live') {
      const c = state.snap.chats.find((x) => x.key === sel.key);
      return c ? { kind: 'live', c } : null;
    }
    if (sel && sel.kind === 'ended') {
      const e = (state.snap.ended || []).find((x) => x.id === sel.key);
      return e ? { kind: 'ended', e } : null;
    }
    return null;
  }

  /** What the panel says while no session is looked at. */
  function drawBlank(state) {
    const away = act.elsewhere();
    const coming = state.armed.size;
    // with workspaces, the page speaks of the one in front
    const space = act.space();
    const stamp = `${state.selLeaving ? 'leaving' : ''}|${away}|${coming}|${space ? `${space.name}|${space.loose}|${space.empty}` : ''}`;
    if (els.blank.dataset.stamp === stamp) return;
    els.blank.dataset.stamp = stamp;
    if (state.selLeaving) {
      // closed where it ran, its program still on its way out: for a few seconds it is neither running nor ended
      fill(els.blank, icon('clock', 28), h('h2', { text: 'It is closing…' }), h('p', { text: 'It shows here again in a moment, with a way to pick it up.' }));
      return;
    }
    const title = !space ? 'No chat is open in this window' : space.loose ? 'No unsorted chat is open in this window' : `No chat of ${space.name} is open in this window`;
    const words = away
      ? `${away} chat${away === 1 ? ' runs' : 's run'} in other terminals: ${away === 1 ? 'it is' : 'they are'} in the list on the left. Click one to look at it, or move ${away === 1 ? 'it' : 'them'} here.`
      : !space ? 'Start one here. Every chat you start, in this window or in any terminal, shows in the list on the left.'
        : space.loose ? 'Every chat that runs is in a workspace.'
          : space.empty ? `Nothing is sorted into ${space.name} yet. Start a chat here and its folder joins ${space.name}. Or go to "All", right-click a chat and put its folder in ${space.name}: every chat in that folder follows, now and later.`
            : `Start one here: a folder that is in no workspace yet joins ${space.name}.`;
    fill(els.blank, icon('terminal', 28),
      h('h2', { text: title }),
      h('p', { text: words }),
      h('div', { class: 'blank-acts' },
        h('button', { class: 'btn primary', onclick: () => act.newChat() }, icon('plus', 14), h('span', { text: 'New chat' })),
        away > 0 && h('button', { class: 'btn', tip: 'Each one opens here as soon as you close it where it runs now (type /exit there), with its whole conversation.', onclick: () => act.arm(null) },
          icon('bring', 14), h('span', { text: away === 1 ? 'Bring it here' : `Bring all ${away} here` })),
        h('button', { class: 'btn ghost', text: 'History', onclick: () => act.go('history') })));
  }

  function render(state) {
    last = state;
    const sub = subjectOf(state);
    shown = Boolean(sub);
    els.blank.hidden = shown;
    els.detail.hidden = !shown;
    detail.show(sub, state);
    if (!sub) drawBlank(state);
    Parts.tick(root);
  }

  /** Esc goes back to the chats, while nothing else has the keyboard. True: the key was used. */
  function key(e) {
    if (!last || !shown || e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return false;
    const on = document.activeElement;
    if (on && (on.tagName === 'INPUT' || on.tagName === 'TEXTAREA')) return false;
    act.look(null);
    return true;
  }

  return {
    init, render, key,
    tick: () => { if (root) { Parts.tick(root); detail.tick(); } },
    detail: () => detail,
  };
})();
