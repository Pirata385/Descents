// Touch controls for phones and tablets in landscape:
// - a floating joystick under the left thumb (push fully to run),
// - drag anywhere else to look around,
// - action buttons under the right thumb (jump, grappling arm, crouch,
//   observe) plus buttons that appear when they are useful (take an
//   artifact, reel in / pay out while attached, artifact ability),
// - pause, map and journal buttons along the top.
// Everything feeds the same Input actions as the keyboard and mouse.
import { clamp } from '../core/mathutil.js';

const ICON = {
  jump: '<path d="M12 4l7 8h-4v7H9v-7H5z"/>',
  grapple: '<path d="M12 2v7M12 9l-5 6M12 9l5 6M12 9v8"/><circle cx="12" cy="19" r="2"/>',
  crouch: '<path d="M12 20l-7-8h4V5h6v7h4z"/>',
  observe: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  take: '<path d="M7 11V6a1.5 1.5 0 013 0v5M10 10V4.5a1.5 1.5 0 013 0V10M13 10V5.5a1.5 1.5 0 013 0V11M16 11V8a1.5 1.5 0 013 0v6a7 7 0 01-7 7h-1a6 6 0 01-5-3l-2.5-4.5a1.5 1.5 0 012.6-1.5L7 14"/>',
  reelIn: '<path d="M12 21V8M7 12l5-5 5 5M5 3h14"/>',
  reelOut: '<path d="M12 3v13M7 12l5 5 5-5M5 21h14"/>',
  ability: '<path d="M12 2l2.6 6.6L21 9l-5 4.4L17.5 21 12 17.3 6.5 21 8 13.4 3 9l6.4-.4z"/>',
  lamp: '<path d="M9 21h6M10 17h4M12 3a6 6 0 00-3.5 10.9V17h7v-3.1A6 6 0 0012 3z"/>',
  pause: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14"/>',
  journal: '<path d="M4 4h7a3 3 0 013 3v13a2 2 0 00-2-2H4zM20 4h-6M20 4v14h-6"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

export function detectTouch(settings) {
  const params = new URLSearchParams(location.search);
  if (params.get('touch') === '1') return true;
  if (params.get('touch') === '0') return false;
  if (settings.touchControls === 'on') return true;
  if (settings.touchControls === 'off') return false;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const fine = matchMedia('(any-pointer: fine)').matches;
  const touchCapable = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent);
  return (coarse && !fine) || (touchCapable && mobileUA);
}

export class TouchControls {
  constructor(game, app) {
    this.game = game;
    this.app = app;
    this.input = game.input;
    this.el = document.createElement('div');
    this.el.className = 'touch-ui hidden';
    this.el.innerHTML = `
      <div class="t-look"></div>
      <div class="t-stick hidden"><div class="t-knob"></div></div>
      <button class="t-btn t-sys t-pause" data-ui="pause" aria-label="Pause">${svg('pause')}</button>
      <div class="t-sysbar">
        <button class="t-btn t-sys" data-ui="map" aria-label="Map">${svg('map')}</button>
        <button class="t-btn t-sys" data-ui="journal" aria-label="Journal">${svg('journal')}</button>
      </div>
      <div class="t-actions">
        <button class="t-btn t-jump" data-act="jump" aria-label="Jump">${svg('jump')}<span>Jump</span></button>
        <button class="t-btn t-grapple" data-tap="grapple" aria-label="Grappling arm">${svg('grapple')}<span>Arm</span></button>
        <button class="t-btn t-crouch" data-act="crouch" aria-label="Crouch">${svg('crouch')}<span>Crouch</span></button>
        <button class="t-btn t-observe" data-act="observe" aria-label="Observe">${svg('observe')}<span>Observe</span></button>
        <button class="t-btn t-lamp" data-tap="lamp" aria-label="Lamp">${svg('lamp')}<span>Lamp</span></button>
        <button class="t-btn t-take ctx" data-tap="interact" aria-label="Take">${svg('take')}<span>Take</span></button>
        <button class="t-btn t-reelin ctx" data-act="reelIn" aria-label="Reel in">${svg('reelIn')}<span>Reel in</span></button>
        <button class="t-btn t-reelout ctx" data-act="reelOut" aria-label="Pay out">${svg('reelOut')}<span>Pay out</span></button>
        <button class="t-btn t-ability ctx" data-tap="ability" aria-label="Ability">${svg('ability')}<span>Ability</span><b></b></button>
      </div>`;
    app.ui.appendChild(this.el);
    this.$ = (s) => this.el.querySelector(s);
    this.stickEl = this.$('.t-stick');
    this.knob = this.$('.t-knob');
    this.stickId = null;
    this.lookId = null;
    this.held = new Map();      // pointerId -> action held by a button
    this.applySize();
    window.addEventListener('resize', () => this.applySize());
    this.bindLook();
    this.bindButtons();
  }

  applySize() {
    const s = this.app.settings;
    // tablets get slightly larger buttons than phones
    const device = Math.min(window.innerWidth, window.innerHeight) >= 600 ? 1.2 : 1;
    this.el.style.setProperty('--t-size', String(+(clamp(s.touchSize ?? 1, 0.7, 1.5) * device).toFixed(3)));
    this.el.style.setProperty('--t-alpha', String(clamp(s.touchOpacity ?? 0.85, 0.3, 1)));
  }

  setVisible(v) {
    this.el.classList.toggle('hidden', !v);
    if (!v) this.reset();
  }

  /** Let go of everything (pause, menus, lost focus). */
  reset() {
    this.stickId = null;
    this.lookId = null;
    this.stickEl.classList.add('hidden');
    for (const a of this.held.values()) this.input.release(a);
    this.held.clear();
    this.input.releaseVirtual();
    this.el.querySelectorAll('.t-btn.down').forEach((b) => b.classList.remove('down'));
  }

  // ------------------------------------------------------------------ stick & look
  bindLook() {
    const look = this.$('.t-look');
    const R = () => 56 * clamp(this.app.settings.touchSize ?? 1, 0.7, 1.5);
    look.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      look.setPointerCapture(e.pointerId);
      const w = window.innerWidth;
      if (e.clientX < w * 0.42 && this.stickId === null) {
        this.stickId = e.pointerId;
        this.origin = { x: e.clientX, y: e.clientY };
        this.stickEl.style.left = `${e.clientX}px`;
        this.stickEl.style.top = `${e.clientY}px`;
        this.stickEl.classList.remove('hidden');
        this.knob.style.transform = 'translate(-50%, -50%)';
        this.input.axis.active = true;
        this.input.axis.x = 0; this.input.axis.y = 0;
      } else if (this.lookId === null) {
        this.lookId = e.pointerId;
        this.last = { x: e.clientX, y: e.clientY };
      }
    });
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) {
        const r = R();
        let dx = e.clientX - this.origin.x, dy = e.clientY - this.origin.y;
        const d = Math.hypot(dx, dy);
        if (d > r) { dx *= r / d; dy *= r / d; }
        this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        const ax = dx / r, ay = -dy / r;
        const inp = this.input;
        inp.axis.x = ax; inp.axis.y = ay;
        const m = Math.hypot(ax, ay);
        if (m > 0.92) inp.press('run'); else inp.release('run');
        // digital directions too (climbing walls, ledges)
        for (const [act, on] of [['forward', ay > 0.45], ['back', ay < -0.45], ['right', ax > 0.45], ['left', ax < -0.45]]) {
          if (on) inp.press(act); else inp.release(act);
        }
      } else if (e.pointerId === this.lookId) {
        const k = 1.5 * (this.app.settings.touchLook ?? 1);
        this.input.mouseDX += (e.clientX - this.last.x) * k;
        this.input.mouseDY += (e.clientY - this.last.y) * k;
        this.last = { x: e.clientX, y: e.clientY };
      }
    });
    const end = (e) => {
      if (e.pointerId === this.stickId) {
        this.stickId = null;
        this.stickEl.classList.add('hidden');
        const inp = this.input;
        inp.axis.x = 0; inp.axis.y = 0; inp.axis.active = false;
        for (const a of ['run', 'forward', 'back', 'left', 'right']) inp.release(a);
      } else if (e.pointerId === this.lookId) {
        this.lookId = null;
      }
    };
    look.addEventListener('pointerup', end);
    look.addEventListener('pointercancel', end);
    look.addEventListener('lostpointercapture', end);
    look.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------------ buttons
  bindButtons() {
    const inp = this.input;
    for (const b of this.el.querySelectorAll('.t-btn')) {
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.setPointerCapture(e.pointerId);
        b.classList.add('down');
        const act = b.dataset.act, tap = b.dataset.tap;
        if (act) { inp.press(act); this.held.set(e.pointerId, act); }
        if (tap === 'grapple') inp.clicked |= 1;
        else if (tap) { inp.press(tap); this.held.set(e.pointerId, tap); }
        if (navigator.vibrate && (act === 'jump' || tap === 'grapple')) navigator.vibrate(8);
      });
      const up = (e) => {
        b.classList.remove('down');
        const a = this.held.get(e.pointerId);
        if (a) { inp.release(a); this.held.delete(e.pointerId); }
        const ui = b.dataset.ui;
        if (ui && e.type === 'pointerup') this.uiAction(ui);
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    }
  }

  uiAction(ui) {
    const app = this.app;
    if (app.state !== 'playing') return;
    app.audio.play('click');
    if (ui === 'pause') app.showPause();
    else if (ui === 'map') app.openJournal('map');
    else if (ui === 'journal') app.openJournal('creatures');
  }

  // ------------------------------------------------------------------ per frame
  update() {
    if (this.el.classList.contains('hidden')) return;
    const g = this.game, p = g.player, gr = g.grapple, A = g.artifacts;
    const attached = gr.attached;
    const show = (sel, on) => { const el = this.$(sel); if (el.classList.contains('show') !== on) el.classList.toggle('show', on); };
    show('.t-take', !!(A && A.focus) && p.mode !== 'dead');
    show('.t-reelin', attached);
    show('.t-reelout', attached);
    const abil = A ? A.abilityItems() : [];
    show('.t-ability', abil.length > 0 && !attached);
    if (abil.length) {
      const a = abil[A.activeIndex % abil.length];
      const cd = A.cooldowns.get(a.id) || 0;
      const label = cd > 0 ? String(Math.ceil(cd)) : '';
      const bEl = this.$('.t-ability b');
      if (bEl.textContent !== label) bEl.textContent = label;
    }
    const grEl = this.$('.t-grapple');
    grEl.classList.toggle('active', gr.state !== 'idle');
    const grLabel = attached ? 'Release' : 'Arm';
    const span = grEl.querySelector('span');
    if (span.textContent !== grLabel) span.textContent = grLabel;
    this.$('.t-observe').classList.toggle('active', !!p.zoomed);
    this.$('.t-lamp').classList.toggle('active', !!(g.lamp && g.lamp.on));
    const jLabel = p.mode === 'climb' ? 'Leap' : attached && !p.onGround ? 'Let go' : 'Jump';
    const js = this.$('.t-jump span');
    if (js.textContent !== jLabel) js.textContent = jLabel;
    const cLabel = p.mode === 'climb' ? 'Drop' : 'Crouch';
    const cs = this.$('.t-crouch span');
    if (cs.textContent !== cLabel) cs.textContent = cLabel;
  }
}
