// Gamepad support, laid out for the PlayStation 4 controller (DualShock 4;
// a DualSense or any controller with the browser's "standard" mapping works
// the same way).
//
// In play the sticks move and look, the face buttons jump, crouch, take and
// observe, the triggers work the grappling arm and the d-pad holds the lamp,
// the artifact ability and the maps. Outside play the controller drives the
// menus and the journal: the d-pad or left stick moves a focus highlight
// between buttons, ✕ selects, ○ goes back, L1/R1 switch journal tabs and the
// right stick scrolls (or pans the map).
//
// The controller is polled once per animation frame. Game actions go through
// Input's pad sets so the keyboard, mouse and touch layers keep working
// alongside it.

// standard mapping, DualShock 4 names
export const PAD = {
  CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3, L1: 4, R1: 5, L2: 6, R2: 7, SHARE: 8, OPTIONS: 9,
  L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15, PS: 16, TOUCHPAD: 17,
};

const k = (cls, t) => `<kbd class="ps ${cls}">${t}</kbd>`;
/** On-screen glyphs for prompts. */
export const GLYPH = {
  cross: k('ps-x', '✕'), circle: k('ps-o', '○'), square: k('ps-s', '□'), triangle: k('ps-t', '△'),
  L1: k('', 'L1'), R1: k('', 'R1'), L2: k('', 'L2'), R2: k('', 'R2'), L3: k('', 'L3'), R3: k('', 'R3'),
  up: k('ps-d', '▲'), down: k('ps-d', '▼'), left: k('ps-d', '◀'), right: k('ps-d', '▶'),
  share: k('', 'SHARE'), options: k('', 'OPTIONS'), touchpad: k('', 'TOUCHPAD'), lstick: k('', 'L'), rstick: k('', 'R'),
};

// held buttons → game actions (Input.is / Input.was)
const HOLD = [
  [PAD.CROSS, 'jump'], [PAD.CIRCLE, 'crouch'], [PAD.SQUARE, 'interact'], [PAD.TRIANGLE, 'observe'], [PAD.R3, 'observe'],
  [PAD.L2, 'reelIn'], [PAD.L1, 'reelOut'], [PAD.R1, 'release'], [PAD.UP, 'lamp'], [PAD.DOWN, 'ability'],
];
// pressed buttons → journal tabs
const TAB_BUTTON = [[PAD.LEFT, 'map'], [PAD.RIGHT, 'abyss'], [PAD.SHARE, 'creatures'], [PAD.TOUCHPAD, 'equipment']];
const JOURNAL_TABS = ['map', 'abyss', 'creatures', 'artifacts', 'equipment'];

const FOCUSABLE = 'button, input:not([type=file]):not([hidden]), select, label.btn, [data-sp], [data-art], [data-eq], [data-un], [data-ab], [data-tab]';
const NB = 18;

function radial(x, y, dz) {
  const m = Math.hypot(x, y);
  if (m <= dz) return [0, 0, 0];
  const s = Math.min(1, (m - dz) / (1 - dz));
  return [x / m * s, y / m * s, s];
}

export class GamepadInput {
  constructor(app) {
    this.app = app;
    this.index = -1;
    this.down = new Uint8Array(NB);
    this.prev = new Uint8Array(NB);
    this.edge = new Uint8Array(NB);
    this.block = new Uint8Array(NB);   // held across a mode change: ignored until released
    this.mode = 'menu';
    this.active = false;                // the controller is the device in use
    this.connected = false;
    this.runLatch = false;
    this.stillT = 0;
    this.fullT = 0;
    this.ownAxis = false;
    this.focus = null;
    this.focusSig = null;
    this.repeat = { dir: null, t: 0 };
    this.scrollBox = null;
    this.lastT = performance.now();
    this.supported = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
    if (!this.supported) return;
    window.addEventListener('gamepadconnected', (e) => {
      this.connected = true;
      this.index = e.gamepad.index;
      const name = (e.gamepad.id || 'Controller').replace(/\s*\(.*$/, '').trim() || 'Controller';
      this.app.toast(`${/054c|sony|dualshock|wireless controller|dualsense/i.test(e.gamepad.id) ? 'PlayStation controller' : name} connected`);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad.index === this.index) { this.index = -1; this.releaseGame(); this.setActive(false); }
      this.connected = this.find() !== null;
      if (!this.connected && this.app.state === 'playing' && this.app.game) this.app.showPauseFromPad?.();
    });
    const loop = () => { requestAnimationFrame(loop); this.poll(); };
    requestAnimationFrame(loop);
  }

  find() {
    let pads;
    try { pads = navigator.getGamepads(); } catch { return null; }
    if (!pads) return null;
    if (this.index >= 0 && pads[this.index] && pads[this.index].connected) return pads[this.index];
    let best = null;
    for (const p of pads) if (p && p.connected && p.buttons.length >= 16 && (!best || p.timestamp > best.timestamp)) best = p;
    if (best) this.index = best.index;
    return best;
  }

  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    this.app.setInputDevice(on ? 'pad' : null);
    if (!on) this.clearFocus();
  }

  /** Short vibration on the controller (DualShock 4 / DualSense). */
  rumble(ms, strong, weak = strong) {
    if (!this.active || this.app.settings.rumble === false) return;
    const p = this.find();
    const va = p && p.vibrationActuator;
    if (!va || !va.playEffect) return;
    try {
      const r = va.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) });
      if (r && r.catch) r.catch(() => {});
    } catch { /* not supported */ }
  }

  poll() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    if (!this.supported) return;
    const pad = this.find();
    if (!pad) { if (this.mode === 'play') this.releaseGame(); return; }
    const B = pad.buttons;
    let any = false;
    for (let i = 0; i < NB; i++) {
      const b = B[i];
      let d = 0;
      if (b) {
        // analog triggers: a light touch is not a press, with a little hysteresis
        if (i === PAD.L2 || i === PAD.R2) d = b.value > (this.prev[i] ? 0.25 : 0.4) || (b.pressed && b.value === 0) ? 1 : 0;
        else d = b.pressed ? 1 : 0;
      }
      this.down[i] = d;
      this.edge[i] = d && !this.prev[i] ? 1 : 0;
      if (this.edge[i]) any = true;
      if (!d) this.block[i] = 0;
    }
    const s = this.app.settings;
    const dz = s.padDeadzone ?? 0.15;
    const ax = pad.axes;
    const [lx, ly, lm] = radial(ax[0] || 0, ax[1] || 0, dz);
    const [rx, ry, rm] = radial(ax[2] || 0, ax[3] || 0, dz);
    if (lm > 0.3 || rm > 0.3) any = true;
    if (any) this.setActive(true);
    const g = this.app.game;
    const mode = this.app.state === 'playing' && g && g.player ? 'play' : 'menu';
    if (mode !== this.mode) {
      if (this.mode === 'play') this.releaseGame();
      // whatever is held while the mode changes waits to be released
      for (let i = 0; i < NB; i++) if (this.down[i]) this.block[i] = 1;
      this.mode = mode;
      this.repeat.dir = null;
    }
    const D = (i) => this.down[i] && !this.block[i];
    const E = (i) => this.edge[i] && !this.block[i];
    if (this.active) {
      if (mode === 'play') this.play(g, D, E, lx, ly, lm, rx, ry, rm, dt);
      else this.menu(D, E, lx, ly, rx, ry, dt);
    }
    this.prev.set(this.down);
  }

  // ------------------------------------------------------------------ play
  play(g, D, E, lx, ly, lm, rx, ry, rm, dt) {
    const inp = g.input, app = this.app, s = app.settings;
    if (E(PAD.OPTIONS)) { this.releaseGame(); app.pauseFromPad(); return; }
    for (const [b, tab] of TAB_BUTTON) if (E(b)) { this.releaseGame(); app.openJournal(tab); return; }
    // movement: analog, like the touch stick
    if (lm > 0) {
      inp.axis.x = lx; inp.axis.y = -ly; inp.axis.active = true; this.ownAxis = true;
    } else if (this.ownAxis) {
      inp.axis.x = 0; inp.axis.y = 0; inp.axis.active = false; this.ownAxis = false;
    }
    // run: L3 toggles; coming to a stop after running ends it
    if (E(PAD.L3)) { this.runLatch = !this.runLatch; this.runMoved = false; }
    if (lm >= 0.25) this.runMoved = true;
    this.stillT = lm < 0.25 ? this.stillT + dt : 0;
    if (this.runMoved && this.stillT > 0.3) this.runLatch = false;
    const want = new Set();
    for (const [b, act] of HOLD) if (D(b)) want.add(act);
    if (this.runLatch) want.add('run');
    // the stick also works the climbing and mantling controls
    if (ly < -0.5) want.add('forward');
    if (ly > 0.5) want.add('back');
    for (const a of want) if (!inp.padDown.has(a)) inp.padPressed.add(a);
    inp.padDown.clear();
    for (const a of want) inp.padDown.add(a);
    if (E(PAD.R2)) inp.clicked |= 1;
    // look: a response curve for fine aim, and the turn speeds up when held fully over
    if (rm > 0) {
      const curve = Math.pow(rm, 1.7) / rm;
      this.fullT = rm > 0.94 ? this.fullT + dt : 0;
      const boost = 1 + Math.min(1, Math.max(0, this.fullT - 0.25) / 0.4) * 0.6;
      const sens = (s.padLook ?? 1) * boost;
      inp.padLookX += rx * curve * 3.3 * sens * dt;
      inp.padLookY += ry * curve * 2.3 * sens * dt;
    } else this.fullT = 0;
  }

  /** Let go of everything the controller holds in the game. */
  releaseGame() {
    const g = this.app.game;
    this.runLatch = false;
    if (!g || !g.input) return;
    g.input.padDown.clear();
    if (this.ownAxis) { g.input.axis.x = 0; g.input.axis.y = 0; g.input.axis.active = false; this.ownAxis = false; }
  }

  // ------------------------------------------------------------------ menus
  root() {
    const app = this.app;
    if (app.state === 'journal' && app.journal && app.journal.open) return app.journal.el;
    if (app.screen && !app.screen.classList.contains('hidden')) return app.screen;
    return null;
  }

  focusables(root) {
    const out = [];
    for (const el of root.querySelectorAll(FOCUSABLE)) {
      if (el.disabled || el.closest('.hidden')) continue;
      if (el.tagName === 'INPUT' && el.type === 'file') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // nested matches (a button inside a [data-sp] row): keep the outer one
      if (el.parentElement && el.parentElement.closest(FOCUSABLE) && root.contains(el.parentElement.closest(FOCUSABLE))) continue;
      out.push(el);
    }
    return out;
  }

  sig(el) {
    const d = el.dataset || {};
    return `${el.tagName}|${Object.entries(d).map(([a, b]) => `${a}=${b}`).join(',')}|${d.key || el.textContent.trim().slice(0, 24)}`;
  }

  setFocus(el) {
    if (this.focus === el) return;
    if (this.focus) this.focus.classList.remove('gp-focus');
    this.focus = el;
    if (!el) return;
    el.classList.add('gp-focus');
    this.focusSig = this.sig(el);
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* old browsers */ }
  }

  clearFocus() {
    if (this.focus) this.focus.classList.remove('gp-focus');
    this.focus = null;
  }

  ensureFocus(root) {
    if (this.focus && this.focus.isConnected && root.contains(this.focus) && !this.focus.closest('.hidden')) return;
    const list = this.focusables(root);
    if (!list.length) { this.clearFocus(); return; }
    // the same control after a redraw, else the first primary button
    // then the main choice of a menu, the selected entry of a list, or the first control
    const same = this.focusSig && list.find((e) => this.sig(e) === this.focusSig);
    this.focus = null;
    this.setFocus(same || list.find((e) => e.classList.contains('primary') && e.closest('.menu'))
      || list.find((e) => (e.classList.contains('active') || e.classList.contains('sel')) && !e.dataset.tab)
      || list.find((e) => !e.dataset.tab && !e.dataset.act) || list[0]);
  }

  move(dir, root) {
    const list = this.focusables(root);
    const cur = this.focus;
    if (!cur) { this.ensureFocus(root); return; }
    const a = cur.getBoundingClientRect();
    const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2;
    const [dx, dy] = dir;
    let best = null, bestS = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2;
      const along = (bx - ax) * dx + (by - ay) * dy;
      if (along <= 3) continue;
      // overlap on the other axis counts as straight ahead
      const overlap = dx ? (b.top < a.bottom && b.bottom > a.top) : (b.left < a.right && b.right > a.left);
      const across = overlap ? 0 : Math.abs((bx - ax) * dy - (by - ay) * dx);
      const sc = along + across * 2.2;
      if (sc < bestS) { bestS = sc; best = el; }
    }
    if (best) { this.setFocus(best); this.app.audio.play?.('tick'); }
  }

  /** Left/right on a slider or list changes its value instead of moving. */
  adjust(el, sign) {
    if (el.tagName === 'INPUT' && el.type === 'range') {
      const step = Number(el.step) || 1;
      const v = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) + step * sign));
      el.value = String(Math.round(v / step) * step);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (el.tagName === 'SELECT') {
      const n = el.options.length;
      el.selectedIndex = (el.selectedIndex + sign + n) % n;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  activate(el) {
    if (el.tagName === 'SELECT') { this.adjust(el, 1); return; }
    if (el.tagName === 'INPUT' && el.type === 'text') { el.focus(); el.select(); return; }
    if (el.tagName === 'INPUT' && el.type === 'range') return;
    el.click();
  }

  back() {
    const app = this.app;
    if (app.state === 'journal') { app.closeJournal(true); return; }
    if (app.state === 'resume') { app.showPause(); return; }
    const b = app.screen.querySelector('[data-act=back]');
    if (b) { b.click(); return; }
    if (app.state === 'paused' && app.screen.querySelector('.pause')) app.resume();
  }

  menu(D, E, lx, ly, rx, ry, dt) {
    const app = this.app;
    const root = this.root();
    if (!root || app.state === 'loading') { this.clearFocus(); return; }
    if (document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text') {
      // typing a seed: ✕ or ○ leaves the field
      if (E(PAD.CROSS) || E(PAD.CIRCLE)) document.activeElement.blur();
      return;
    }
    if (app.state === 'resume') {
      if (E(PAD.CROSS) || E(PAD.OPTIONS)) app.resume();
      else if (E(PAD.CIRCLE)) app.showPause();
      return;
    }
    this.ensureFocus(root);
    // journal shortcuts
    if (app.state === 'journal') {
      const J = app.journal;
      if (E(PAD.OPTIONS)) { app.closeJournal(true); return; }
      const idx = JOURNAL_TABS.indexOf(J.tab);
      if (E(PAD.L1) || E(PAD.R1)) {
        const n = JOURNAL_TABS.length;
        J.show(JOURNAL_TABS[(idx + (E(PAD.R1) ? 1 : -1) + n) % n]);
        this.clearFocus();
        app.audio.play?.('open');
        return;
      }
      for (const [b, tab] of TAB_BUTTON) {
        if ((b === PAD.SHARE || b === PAD.TOUCHPAD) && E(b)) {
          if (J.tab === tab) app.closeJournal(true); else { J.show(tab); this.clearFocus(); }
          return;
        }
      }
      // the map: right stick pans, the triggers zoom
      if (J.tab === 'map' && J.map) {
        const M = J.map;
        let changed = false;
        if (rx || ry) { M.follow = false; M.cx += rx * 260 * dt / M.zoom; M.cz += ry * 260 * dt / M.zoom; changed = true; }
        if (D(PAD.R2)) { M.zoom = Math.min(12, M.zoom * Math.exp(dt * 1.6)); changed = true; }
        if (D(PAD.L2)) { M.zoom = Math.max(0.15, M.zoom * Math.exp(-dt * 1.6)); changed = true; }
        if (changed) M.draw();
      } else if (ry) this.scroll(root, ry * 900 * dt);
    } else {
      if (E(PAD.OPTIONS) && app.state === 'paused' && app.screen.querySelector('.pause')) { app.resume(); return; }
      if (ry) this.scroll(root, ry * 900 * dt);
    }
    if (E(PAD.CIRCLE)) { this.back(); return; }
    if (E(PAD.CROSS) && this.focus) { this.activate(this.focus); return; }
    // directions, with key repeat
    let dir = null;
    if (D(PAD.UP) || ly < -0.6) dir = 'up';
    else if (D(PAD.DOWN) || ly > 0.6) dir = 'down';
    else if (D(PAD.LEFT) || lx < -0.6) dir = 'left';
    else if (D(PAD.RIGHT) || lx > 0.6) dir = 'right';
    const R = this.repeat;
    if (dir !== R.dir) { R.dir = dir; R.t = 0.4; if (dir) this.step(dir, root); }
    else if (dir) {
      R.t -= dt;
      if (R.t <= 0) { R.t = 0.09; this.step(dir, root); }
    }
  }

  step(dir, root) {
    const el = this.focus;
    if (el && (dir === 'left' || dir === 'right') && this.adjust(el, dir === 'left' ? -1 : 1)) return;
    this.move({ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir], root);
  }

  scroll(root, dy) {
    let el = this.focus;
    while (el && el !== root.parentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2) { el.scrollTop += dy; return; }
      el = el.parentElement;
    }
    // no scrolling ancestor: the largest scrollable box in the menu (looked up once per screen)
    const S = this.scrollBox;
    if (!S || S.root !== root || !S.el || !S.el.isConnected || performance.now() - S.t > 1500) {
      let best = null;
      for (const c of root.querySelectorAll('div, section, ul, table')) {
        if (c.scrollHeight > c.clientHeight + 2 && (!best || c.clientHeight > best.clientHeight) && /(auto|scroll)/.test(getComputedStyle(c).overflowY)) best = c;
      }
      this.scrollBox = { root, el: best, t: performance.now() };
    }
    if (this.scrollBox.el) this.scrollBox.el.scrollTop += dy;
  }
}
