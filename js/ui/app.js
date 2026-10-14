// Application shell: title screen, world loading, pause menu, settings,
// controls, save/load, and the wiring that attaches every gameplay system
// (explorer, grappling arm, ecosystem, artifacts, discovery, maps, HUD,
// journal, audio) to a running game.
import { Game } from '../game.js';
import { Player } from '../player/player.js';
import { Grapple } from '../player/grapple.js';
import { Ecosystem } from '../creatures/ecosystem.js';
import { ArtifactSystem } from '../artifacts/artifacts.js';
import { Discovery } from '../systems/discovery.js';
import { MapData } from '../systems/mapdata.js';
import { EnvironmentProbe } from '../systems/environment.js';
import { SaveStore, captureSave, applySave, exportSave, validateSave, isLegacySave, SAVE_VERSION } from '../systems/save.js';
import { AudioEngine } from '../audio/audio.js';
import { HUD } from './hud.js';
import { TouchControls, detectTouch } from './touch.js';
import { Journal } from './journal.js';
import { LAYERS } from '../world/layers.js';
import { FAMILY_LABEL } from '../creatures/genome.js';
import { GamepadInput, GLYPH } from '../core/gamepad.js';

const SETTINGS_KEY = 'descents.settings.v1';
// graphics presets; changing any of these values by hand makes the preset 'custom'
const QUALITY = {
  low: { renderChunks: 6, viewDistance: 0.55, pixelRatio: 0.75, shadows: false, shadowSize: 1024, particles: 0.35, creatures: 32 },
  medium: { renderChunks: 9, viewDistance: 0.8, pixelRatio: 1, shadows: true, shadowSize: 1024, particles: 0.6, creatures: 48 },
  high: { renderChunks: 12, viewDistance: 1.0, pixelRatio: 1.5, shadows: true, shadowSize: 2048, particles: 1, creatures: 60 },
  ultra: { renderChunks: 20, viewDistance: 1.4, pixelRatio: 2, shadows: true, shadowSize: 4096, particles: 1, creatures: 84 },
};
const QUALITY_KEYS = ['renderChunks', 'viewDistance', 'pixelRatio', 'shadows', 'particles', 'creatures'];
function presetOf(s) {
  for (const [name, q] of Object.entries(QUALITY)) if (QUALITY_KEYS.every((k) => s[k] === q[k])) return name;
  return 'custom';
}

const DEFAULT_SETTINGS = {
  quality: 'high', shadowSize: 2048, creatures: 60, fpsLimit: 0, renderChunks: 12,
  viewDistance: 1.0, shadows: true, fov: 75, sensitivity: 1, invertY: false, pixelRatio: 1.5, particles: 1,
  volMaster: 0.8, volMusic: 0.5, volAmbience: 0.7, volEffects: 0.8, showArm: true, showFps: false, autoQuality: true,
  touchControls: 'auto', touchLook: 1, touchSize: 1, touchOpacity: 0.85,
  padLook: 1, padDeadzone: 0.15, rumble: true,
};
// lighter defaults the first time the game runs on a phone or tablet
// phones and tablets cannot show more frames than their screen refreshes, so
// drawing extra ones only drains the battery: they start in step with the display
const MOBILE_DEFAULTS = { ...QUALITY.low, antialias: false, fpsLimit: -1 };

const TIPS = [
  'The Abyss Eye sits at the centre of the world. Every route down begins at its rim.',
  'Creatures of the first two layers ignore explorers. In the Great Fault, keep clear of nests.',
  'There is no stair into the Great Fault: look for the stone arches on the Stone Plain. Each one marks a sinkhole into the caves of the tube walls.',
  'Windows in the fault walls look out over the chasm. Swifts and falcons nest on the ledges around them.',
  'No two creatures of a species are alike. Regional forms differ in build, crests and colour.',
  'A PS4 controller works everywhere, menus and journal included. Press any button to connect it.',
  'Hold F to study a creature. Patience reveals what it eats and how it lives.',
  'The grappling arm reaches 60 metres. Reel in to climb, pay out to rappel.',
  'Artifacts rest where few would look: ruins, cave chambers, the tops of spires.',
  'Rivers carve the bowl and plunge into the Eye as great falls.',
  'The Inverted Forest grows from the ceilings of vast galleries in the Abyss wall.',
  'Your map only shows what you have explored. Wander, and it will grow.',
  'Water breaks a fall. Stone does not.',
  'Equipped artifacts reveal their properties over time.',
];

const TOUCH_CONTROLS = [
  ['Left thumb', 'Drag to move · push fully to run'], ['Right side', 'Drag to look around'], ['Jump', 'Jump · hold while pushing into a wall to climb'],
  ['Arm', 'Fire / release the grappling arm at the centre of the view'], ['Reel in · Pay out', 'Appear while the cable is attached'],
  ['Crouch', 'Crouch · drop from a wall'], ['Observe (hold)', 'Zoom in and study a creature'], ['Take', 'Appears next to an artifact'],
  ['Ability · Lamp', 'Artifact ability · explorer\'s lamp'], ['☰ · map · book', 'Pause · map · journal'],
];

const CONTROLS = [
  ['W A S D', 'Move'], ['Mouse', 'Look'], ['Space', 'Jump · climb a wall when held against it · let go of the cable'], ['Shift', 'Run'], ['Ctrl / C', 'Crouch · drop from a wall'],
  ['Left click', 'Fire / release the grappling arm'], ['Right click / Q / wheel up', 'Reel in the cable'], ['Z / wheel down', 'Pay out the cable'], ['X', 'Release the cable'],
  ['E', 'Take an artifact'], ['F (hold)', 'Observe creatures (zoom)'], ['R', 'Use an artifact ability'], ['L', "Explorer's lamp"],
  ['M', 'Map'], ['N', 'Vertical abyss map'], ['J / Tab', 'Creature catalog'], ['I', 'Equipment'], ['Esc / P', 'Pause'],
];

// PlayStation 4 controller (DualShock 4); any standard-mapping gamepad uses the same positions
const PAD_CONTROLS = [
  [`${GLYPH.lstick} stick`, 'Move · push up or down to climb'], [GLYPH.L3, 'Run (toggle; stopping ends it)'], [`${GLYPH.rstick} stick`, 'Look'],
  [GLYPH.cross, 'Jump · hold against a wall to climb · let go of the cable'], [GLYPH.circle, 'Crouch · drop from a wall'],
  [GLYPH.square, 'Take an artifact'], [`${GLYPH.triangle} / ${GLYPH.R3} (hold)`, 'Observe creatures (zoom)'],
  [GLYPH.R2, 'Fire / release the grappling arm'], [GLYPH.L2, 'Reel in the cable'], [GLYPH.L1, 'Pay out the cable'], [GLYPH.R1, 'Release the cable'],
  [GLYPH.up, "Explorer's lamp"], [GLYPH.down, 'Use an artifact ability'], [`${GLYPH.left} ${GLYPH.right}`, 'Map · vertical abyss map'],
  [GLYPH.share, 'Creature catalog'], [GLYPH.touchpad, 'Equipment'], [GLYPH.options, 'Pause'],
  ['Menus', `D-pad or left stick to choose · ${GLYPH.cross} select · ${GLYPH.circle} back · ${GLYPH.L1} ${GLYPH.R1} journal tabs · right stick scrolls (on the map it pans; ${GLYPH.L2} ${GLYPH.R2} zoom)`],
];

function padTable(show) {
  if (!show) return '';
  return `<h3>PS4 controller</h3><table class="controls">${PAD_CONTROLS.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
}

function hasSavedSettings() {
  try { return !!localStorage.getItem(SETTINGS_KEY); } catch { return false; }
}
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ } }

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function randomSeedLabel() {
  const A = ['Ashen', 'Hollow', 'Gilded', 'Silent', 'Deep', 'Verdant', 'Pale', 'Winding', 'Sunken', 'Amber', 'Mossy', 'Iron', 'Echoing', 'Veiled'];
  const B = ['Rim', 'Eye', 'Descent', 'Hollow', 'Falls', 'Stair', 'Grove', 'Chasm', 'Gate', 'Spire', 'Root', 'Well', 'Vault', 'Lantern'];
  return `${A[Math.floor(Math.random() * A.length)]} ${B[Math.floor(Math.random() * B.length)]} ${Math.floor(Math.random() * 9000 + 1000)}`;
}

function fmtDate(t) {
  const d = new Date(t);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.ui = document.getElementById('ui');
    const fresh = !hasSavedSettings();
    this.settings = loadSettings();
    this.touch = detectTouch(this.settings);
    if (this.touch && fresh) Object.assign(this.settings, MOBILE_DEFAULTS);
    // settings saved before render distance existed: take it from their preset
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (raw.renderChunks === undefined && QUALITY[raw.quality]) this.settings.renderChunks = QUALITY[raw.quality].renderChunks;
    } catch { /* no saved settings */ }
    this.settings.quality = presetOf(this.settings);
    this.dynScale = 1;
    document.body.classList.toggle('touch', this.touch);
    this.audio = new AudioEngine(this.settings);
    this.state = 'title';
    this.game = null;
    this.screen = document.createElement('div');
    this.screen.className = 'screen';
    this.ui.appendChild(this.screen);
    window.addEventListener('keydown', (e) => { this.setInputDevice(this.touch ? 'touch' : 'kbm'); this.onKey(e); });
    // whichever device was used last decides the prompts and the touch buttons
    // (mouse events that browsers emulate after a tap do not count as the mouse)
    const realMouse = (e) => !(e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) && performance.now() - (this.touchT || -1e9) > 1000;
    window.addEventListener('mousedown', (e) => { if (realMouse(e)) this.setInputDevice('kbm'); });
    window.addEventListener('mousemove', (e) => {
      // ignore the jump some browsers report as the pointer locks
      const m = Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
      if (m > 4 && m < 250 && realMouse(e) && !(this.game && performance.now() - this.game.input.lockTime < 400)) this.setInputDevice('kbm');
    });
    window.addEventListener('touchstart', () => { this.touchT = performance.now(); this.setInputDevice('touch'); }, { passive: true, capture: true });
    this.device = this.touch ? 'touch' : 'kbm';
    this.pad = new GamepadInput(this);
    // after playing with a controller (no pointer lock), a click takes the mouse back
    canvas.addEventListener('click', () => { if (this.state === 'playing' && !this.touch && this.game && !this.game.input.locked) this.game.input.lock(); });
    // phones: play in landscape; turning to portrait pauses (the overlay asks to rotate back)
    const onTurn = () => { this.needsRedraw = true; this.checkOrientation(); };
    window.addEventListener('resize', onTurn);
    window.addEventListener('orientationchange', onTurn);
    if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', onTurn);
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    window.__app = this;
  }

  isPortrait() { return window.innerHeight > window.innerWidth; }

  /** 'kbm', 'touch' or 'pad': prompts, glyphs and the touch buttons follow the device in use. */
  setInputDevice(dev) {
    if (!dev) dev = this.touch ? 'touch' : 'kbm';
    if (dev === this.device) return;
    this.device = dev;
    if (dev !== 'pad' && this.pad && this.pad.active) { this.pad.active = false; this.pad.clearFocus(); this.pad.releaseGame(); }
    document.body.classList.toggle('gamepad', dev === 'pad');
    if (this.game) this.game.pad = dev === 'pad';
    if (this.touchUI) this.touchUI.setVisible(this.touch && dev !== 'pad' && this.state === 'playing');
    if (this.state === 'resume') {
      // only the wording changes: rebuilding the screen mid-click would swallow the click
      const m = this.screen.querySelector('.click-msg');
      if (m) m.textContent = this.clickWording(this.clickText);
    }
  }

  clickWording(text = 'Click to continue the descent') {
    if (this.device === 'pad') return text.replace(/^Click/, 'Press ✕');
    if (this.touch) return text.replace(/^Click/, 'Tap');
    return text;
  }

  /** Options on the controller, or the controller was disconnected mid-play. */
  pauseFromPad() {
    if (this.state !== 'playing') return;
    if (document.pointerLockElement) { this.wantUnlock = true; this.game.input.unlock(); }
    this.showPause();
  }

  showPauseFromPad() { if (this.device === 'pad') this.pauseFromPad(); }

  checkOrientation() {
    if (!this.touch) return;
    if (this.isPortrait() && this.state === 'playing') this.showPause();
  }

  /** Full screen and landscape lock where the browser allows it (needs a tap). */
  enterFullscreen() {
    if (!this.touch) return;
    const el = document.documentElement;
    const lock = () => { try { const p = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'); if (p && p.catch) p.catch(() => {}); } catch { /* unsupported */ } };
    if (!document.fullscreenElement && el.requestFullscreen) {
      try { el.requestFullscreen({ navigationUI: 'hide' }).then(lock, () => {}); } catch { /* unsupported */ }
    } else lock();
  }

  /** Switch touch controls on or off while running. */
  setTouchMode(on) {
    this.touch = on;
    document.body.classList.toggle('touch', on);
    const g = this.game;
    if (g && g.player) {
      g.touch = on;
      if (g.grapple) g.grapple.setTouchLayout(on);
      if (on && !this.touchUI) this.touchUI = new TouchControls(g, this);
      if (this.touchUI) this.touchUI.setVisible(on && this.state === 'playing');
    }
  }

  // ------------------------------------------------------------------ screens
  showTitle() {
    this.state = 'title';
    const latest = SaveStore.latest();
    this.screen.className = 'screen title-screen';
    this.screen.innerHTML = `
      <div class="title-bg"></div>
      <div class="title-panel">
        <div class="logo">DESCENTS</div>
        <div class="tagline">An expedition into the Abyss</div>
        <div class="menu">
          ${latest ? `<button class="btn primary" data-act="continue">Continue <small>${esc(latest.name)} · ${latest.depth} m</small></button>` : ''}
          <div class="seed-row">
            <label for="seed">World seed</label>
            <div class="seed-input"><input id="seed" type="text" maxlength="48" spellcheck="false" value="${esc(randomSeedLabel())}"><button class="btn icon" data-act="dice" title="Random seed">⚄</button></div>
          </div>
          <button class="btn ${latest ? '' : 'primary'}" data-act="new">Begin a new descent</button>
          <button class="btn" data-act="load">Load expedition</button>
          <button class="btn" data-act="settings">Settings</button>
          <button class="btn" data-act="controls">Controls</button>
        </div>
        <div class="foot">Every seed creates a different city, abyss, wildlife and set of artifacts.</div>
      </div>`;
    const seedEl = this.screen.querySelector('#seed');
    this.screen.querySelector('[data-act=dice]').onclick = () => { seedEl.value = randomSeedLabel(); };
    this.screen.querySelector('[data-act=new]').onclick = () => { const s = seedEl.value.trim() || randomSeedLabel(); this.enterFullscreen(); this.audio.init(); this.startGame({ seedLabel: s }); };
    const cont = this.screen.querySelector('[data-act=continue]');
    if (cont) cont.onclick = async () => { this.enterFullscreen(); this.audio.init(); const save = await SaveStore.load(latest.id); if (save) this.startGame({ save }); else this.toast('That save could not be read.'); };
    this.screen.querySelector('[data-act=load]').onclick = () => this.showLoad('title');
    this.screen.querySelector('[data-act=settings]').onclick = () => this.showSettings('title');
    this.screen.querySelector('[data-act=controls]').onclick = () => this.showControls('title');
    seedEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.screen.querySelector('[data-act=new]').click(); });
  }

  showLoad(back) {
    const list = SaveStore.list();
    this.screen.className = `screen panel-screen ${back === 'pause' ? 'over-game' : 'title-screen'}`;
    this.screen.innerHTML = `
      ${back === 'title' ? '<div class="title-bg"></div>' : ''}
      <div class="panel">
        <h2>Expeditions</h2>
        <div class="save-list">${list.map((m) => `
          <div class="save-item">
            <div><b>${esc(m.name)}</b>${m.auto ? ' <span class="muted">(autosave)</span>' : ''}${(m.version || 1) < SAVE_VERSION ? ' <span class="muted">(older version: begins anew)</span>' : ''}<br><span class="muted">${fmtDate(m.time)} · seed “${esc(m.seedLabel)}” · ${m.depth} m · ${LAYERS[m.layer]?.title || ''} · ${m.species} species · ${m.artifacts} artifacts</span></div>
            <div class="row"><button class="btn small" data-load="${esc(m.id)}">Load</button><button class="btn small" data-export="${esc(m.id)}">Export</button><button class="btn small danger" data-del="${esc(m.id)}">Delete</button></div>
          </div>`).join('') || '<p class="muted">No saved expeditions yet.</p>'}</div>
        <div class="row">
          <label class="btn">Import from file<input type="file" accept="application/json,.json" hidden></label>
          <button class="btn" data-act="back">Back</button>
        </div>
      </div>`;
    this.screen.querySelectorAll('[data-load]').forEach((b) => {
      b.onclick = async () => {
        const save = await SaveStore.load(b.dataset.load);
        if (!save) { this.toast('That save could not be read.'); return; }
        this.audio.init();
        if (this.game) { sessionStorage.setItem('descents.pendingLoad', b.dataset.load); location.reload(); return; }
        this.startGame({ save });
      };
    });
    this.screen.querySelectorAll('[data-export]').forEach((b) => { b.onclick = async () => { const s = await SaveStore.load(b.dataset.export); if (s) exportSave(s); }; });
    this.screen.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { if (confirm('Delete this expedition?')) { SaveStore.remove(b.dataset.del); this.showLoad(back); } }; });
    this.screen.querySelector('input[type=file]').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        if (!validateSave(obj)) throw new Error('not a Descents save');
        obj.id = obj.id || `exp-${Date.now().toString(36)}`;
        await SaveStore.write(obj);
        this.toast('Expedition imported.');
        this.showLoad(back);
      } catch (err) { this.toast(`Import failed: ${err.message}`); }
    };
    this.screen.querySelector('[data-act=back]').onclick = () => (back === 'pause' ? this.showPause() : this.showTitle());
  }

  showSettings(back) {
    const s = this.settings;
    const slider = (key, label, min, max, step, fmt = (v) => v) => `
      <div class="set-row"><label>${label}</label><input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}"><span class="val" data-val="${key}">${fmt(s[key])}</span></div>`;
    const check = (key, label) => `<div class="set-row"><label>${label}</label><input type="checkbox" data-key="${key}" ${s[key] ? 'checked' : ''}></div>`;
    this.screen.className = `screen panel-screen ${back === 'pause' ? 'over-game' : 'title-screen'}`;
    this.screen.innerHTML = `
      ${back === 'title' ? '<div class="title-bg"></div>' : ''}
      <div class="panel settings">
        <h2>Settings</h2>
        <h3>Graphics</h3>
        <div class="set-row"><label>Quality</label><select data-key="quality">${[['low', 'Low (phones, older laptops)'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom']].map(([v, l]) => `<option value="${v}" ${s.quality === v ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="val"></span></div>
        ${slider('renderChunks', 'Render distance (chunks of 32 m)', 3, 32, 1, (v) => `${v}`)}
        ${slider('viewDistance', 'Terrain detail', 0.5, 1.6, 0.05, (v) => `${Math.round(v * 100)}%`)}
        ${slider('pixelRatio', 'Resolution scale', 0.5, 2, 0.25, (v) => `${v}×`)}
        ${slider('particles', 'Particles', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
        ${slider('creatures', 'Creatures nearby', 16, 96, 4, (v) => `${v}`)}
        ${check('shadows', 'Shadows')}
        ${check('autoQuality', 'Adapt resolution and terrain detail to keep the frame rate smooth')}
        <div class="set-row"><label>Frame rate limit</label><select data-key="fpsLimit">${[[0, 'Unlimited'], [-1, 'Display refresh rate (V-Sync)'], [30, '30 FPS'], [45, '45 FPS'], [60, '60 FPS'], [90, '90 FPS'], [120, '120 FPS'], [144, '144 FPS'], [165, '165 FPS'], [240, '240 FPS']].map(([v, l]) => `<option value="${v}" ${Number(s.fpsLimit ?? 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="val"></span></div>
        ${slider('fov', 'Field of view', 60, 100, 1, (v) => `${v}°`)}
        ${check('showArm', 'Show the grappling arm')}
        ${check('showFps', 'Show frame rate')}
        <h3>Controls</h3>
        ${slider('sensitivity', 'Mouse sensitivity', 0.2, 3, 0.05, (v) => Number(v).toFixed(2))}
        ${check('invertY', 'Invert vertical look')}
        <h3>Controller</h3>
        ${slider('padLook', 'Stick look speed', 0.3, 3, 0.05, (v) => Number(v).toFixed(2))}
        ${slider('padDeadzone', 'Stick dead zone', 0.05, 0.35, 0.01, (v) => Number(v).toFixed(2))}
        ${check('rumble', 'Vibration')}
        <h3>Touch</h3>
        <div class="set-row"><label>Touch controls</label><select data-key="touchControls">${[['auto', 'Automatic'], ['on', 'On'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${s.touchControls === v ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="val"></span></div>
        ${slider('touchLook', 'Touch look speed', 0.4, 3, 0.05, (v) => Number(v).toFixed(2))}
        ${slider('touchSize', 'Button size', 0.7, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`)}
        ${slider('touchOpacity', 'Button opacity', 0.3, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
        <h3>Audio</h3>
        ${slider('volMaster', 'Master volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
        ${slider('volMusic', 'Music', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
        ${slider('volAmbience', 'Ambience', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
        ${slider('volEffects', 'Effects', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
        <div class="row"><button class="btn" data-act="defaults">Defaults</button><button class="btn primary" data-act="back">Done</button></div>
      </div>`;
    const fmts = {};
    this.screen.querySelectorAll('input[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const valEl = this.screen.querySelector(`[data-val=${key}]`);
      fmts[key] = valEl ? valEl.textContent : '';
      el.oninput = () => {
        s[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
        if (valEl) {
          const v = s[key];
          valEl.textContent = key === 'viewDistance' || key === 'particles' || key.startsWith('vol') || key === 'touchSize' || key === 'touchOpacity' ? `${Math.round(v * 100)}%` : key === 'fov' ? `${v}°` : key === 'pixelRatio' ? `${v}×` : key === 'creatures' || key === 'renderChunks' ? `${v}` : Number(v).toFixed(2);
        }
        if (QUALITY_KEYS.includes(key)) {
          s.quality = presetOf(s);
          const q = this.screen.querySelector('select[data-key=quality]');
          if (q) q.value = s.quality;
        }
        this.applySettings(key);
      };
    });
    this.screen.querySelectorAll('select[data-key]').forEach((el) => {
      el.onchange = () => {
        const key = el.dataset.key;
        s[key] = key === 'fpsLimit' ? Number(el.value) : el.value;
        if (key === 'quality' && QUALITY[el.value]) {
          // a preset sets every graphics value at once
          Object.assign(s, QUALITY[el.value]);
          for (const k of [...QUALITY_KEYS, 'shadowSize']) this.applySettings(k);
          this.showSettings(back);
          return;
        }
        this.applySettings(key);
      };
    });
    this.screen.querySelector('[data-act=defaults]').onclick = () => { Object.assign(s, DEFAULT_SETTINGS); for (const k of Object.keys(s)) this.applySettings(k); this.showSettings(back); };
    this.screen.querySelector('[data-act=back]').onclick = () => { saveSettings(s); back === 'pause' ? this.showPause() : this.showTitle(); };
  }

  applySettings(key) {
    saveSettings(this.settings);
    const g = this.game;
    if (key.startsWith('vol')) this.audio.applyVolumes();
    if (key === 'touchControls') this.setTouchMode(detectTouch(this.settings));
    if ((key === 'touchSize' || key === 'touchOpacity') && this.touchUI) this.touchUI.applySize();
    if (!g || !g.renderer) return;
    if (key === 'viewDistance') g.chunks.setQuality(this.settings.viewDistance);
    if (key === 'renderChunks') { g.chunks.setRenderDistance(this.settings.renderChunks); g.renderer.setRenderDistance(this.settings.renderChunks); g.chunks.update(g.focusPoint()); }
    if (key === 'shadows') g.renderer.setShadows(this.settings.shadows);
    if (key === 'shadowSize') g.renderer.setShadowSize(this.settings.shadowSize);
    if (key === 'pixelRatio') { this.dynScale = 1; g.renderer.setPixelRatio(this.settings.pixelRatio); }
    if (key === 'creatures' && g.ecosystem) g.ecosystem.maxAgents = this.settings.creatures;
  }

  showControls(back) {
    this.screen.className = `screen panel-screen ${back === 'pause' ? 'over-game' : 'title-screen'}`;
    this.screen.innerHTML = `
      ${back === 'title' ? '<div class="title-bg"></div>' : ''}
      <div class="panel">
        <h2>Controls</h2>
        ${this.touch ? `<h3>Touch</h3><table class="controls">${TOUCH_CONTROLS.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
        ${padTable(this.device === 'pad')}
        <h3>Keyboard &amp; mouse</h3>
        <table class="controls">${CONTROLS.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</table>
        ${padTable(this.device !== 'pad')}
        <p class="muted">Climb rock by ${this.touch ? 'holding Jump' : 'holding <kbd>Space</kbd>'} while walking into a wall; stamina drains while climbing. Ledges within reach are mantled automatically. Running into water lets you swim; rivers carry you with their current.</p>
        <div class="row"><button class="btn primary" data-act="back">Back</button></div>
      </div>`;
    this.screen.querySelector('[data-act=back]').onclick = () => (back === 'pause' ? this.showPause() : this.showTitle());
  }

  showLoading() {
    this.state = 'loading';
    const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
    this.screen.className = 'screen loading-screen';
    this.screen.innerHTML = `
      <div class="title-bg"></div>
      <div class="loading">
        <div class="logo small">DESCENTS</div>
        <div class="load-stage">Preparing the expedition</div>
        <div class="load-bar"><i></i></div>
        <div class="load-tip">${esc(tip)}</div>
      </div>`;
  }

  setProgress(stage, p) {
    const st = this.screen.querySelector('.load-stage'), bar = this.screen.querySelector('.load-bar i');
    if (st) st.textContent = stage;
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  }

  showPause() {
    this.setState('paused');
    this.screen.className = 'screen panel-screen over-game';
    this.screen.innerHTML = `
      <div class="panel pause">
        <h2>Paused</h2>
        <div class="muted center">${esc(this.game.expeditionName || '')} · seed “${esc(this.game.seedLabel)}”</div>
        <div class="menu">
          <button class="btn primary" data-act="resume">Resume</button>
          <button class="btn" data-act="save">Save expedition</button>
          <button class="btn" data-act="load">Load expedition</button>
          <button class="btn" data-act="export">Export save to file</button>
          <button class="btn" data-act="settings">Settings</button>
          <button class="btn" data-act="controls">Controls</button>
          <button class="btn" data-act="quit">Save and return to title</button>
        </div>
      </div>`;
    this.screen.querySelector('[data-act=resume]').onclick = () => this.resume();
    this.screen.querySelector('[data-act=save]').onclick = async () => { await this.save(false); this.toast('Expedition saved.'); };
    this.screen.querySelector('[data-act=load]').onclick = () => this.showLoad('pause');
    this.screen.querySelector('[data-act=export]').onclick = () => exportSave(captureSave(this.game));
    this.screen.querySelector('[data-act=settings]').onclick = () => this.showSettings('pause');
    this.screen.querySelector('[data-act=controls]').onclick = () => this.showControls('pause');
    this.screen.querySelector('[data-act=quit]').onclick = async () => { await this.save(false); location.reload(); };
  }

  showClickToPlay(text = 'Click to continue the descent') {
    this.clickText = text;
    text = this.clickWording(text);
    this.screen.className = 'screen click-screen';
    this.screen.innerHTML = `<div class="click-msg">${esc(text)}</div>`;
    this.screen.onclick = () => { this.screen.onclick = null; this.resume(); };
  }

  hideScreen() { this.screen.className = 'screen hidden'; this.screen.innerHTML = ''; this.screen.onclick = null; }

  toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    this.ui.appendChild(t);
    setTimeout(() => t.classList.add('fade'), 2200);
    setTimeout(() => t.remove(), 3000);
  }

  // ------------------------------------------------------------------ state
  setState(st) {
    this.state = st;
    const g = this.game;
    if (!g) return;
    const playing = st === 'playing';
    g.uiBlocking = !playing;
    g.paused = st === 'paused' || st === 'journal' || st === 'resume';
    if (this.hud) this.hud.setVisible(st === 'playing' || st === 'resume');
    if (this.touchUI) this.touchUI.setVisible(this.touch && playing && this.device !== 'pad');
    if (this.audio.ready) this.audio.suspend(st === 'paused');
  }

  resume() {
    this.hideScreen();
    if (this.journal && this.journal.open) this.journal.close();
    this.setState('playing');
    if (this.touch) this.enterFullscreen();
    else this.game.input.lock();
    this.audio.init();
  }

  openJournal(tab) {
    if (!this.game || !this.game.player) return;
    if (document.pointerLockElement) { this.wantUnlock = true; this.game.input.unlock(); }
    this.hideScreen();
    this.setState('journal');
    this.journal.show(tab);
    this.audio.play('open');
  }

  closeJournal(relock) {
    this.journal.open = false;
    this.journal.el.classList.add('hidden');
    if (this.journal.preview) this.journal.preview.detach();
    if (relock || this.touch) this.resume();
    else { this.setState('resume'); this.showClickToPlay(); }
  }

  onKey(e) {
    if (!this.game || !this.game.player) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const code = e.code;
    const tabFor = { KeyM: 'map', KeyN: 'abyss', KeyJ: 'creatures', Tab: 'creatures', KeyI: 'equipment' }[code];
    if (this.state === 'playing') {
      if (tabFor) { e.preventDefault(); this.openJournal(tabFor); return; }
      if (code === 'Escape' || code === 'KeyP') { if (document.pointerLockElement) { this.wantUnlock = true; this.game.input.unlock(); } this.showPause(); }
    } else if (this.state === 'journal') {
      if (code === 'Escape') { this.closeJournal(false); return; }
      if (tabFor) {
        e.preventDefault();
        if (this.journal.tab === tabFor) this.closeJournal(true);
        else this.journal.show(tabFor);
      }
    } else if (this.state === 'paused') {
      if (code === 'Escape' || code === 'KeyP') {
        if (this.screen.querySelector('.pause')) this.showClickToPlay();
        else this.showPause();
      }
    } else if (this.state === 'resume' && code === 'Escape') {
      this.showPause();
    }
  }

  // ------------------------------------------------------------------ game
  async startGame({ seedLabel, save = null }) {
    let legacy = false;
    if (save && isLegacySave(save)) {
      // the world below the plain and its creatures changed since this save:
      // the same seed starts again from the rim
      legacy = true;
      seedLabel = save.seedLabel || String(save.seed);
      save = null;
    }
    this.showLoading();
    const game = this.game = new Game(this.canvas, this.settings, {
      onProgress: (stage, p) => this.setProgress(stage, p),
      onWorldReady: (g) => this.attachSystems(g, save),
      onPausedFrame: (dt) => {
        // the world waits for the player, but stays drawn (and is redrawn after a resize)
        if (this.state === 'resume' || this.needsRedraw) { this.needsRedraw = false; game.renderOnly(dt); }
      },
    });
    window.__descents = game;
    try {
      await game.start({ seed: seedLabel, save });
    } catch (err) {
      console.error(err);
      this.screen.innerHTML = `<div class="panel"><h2>The expedition could not start</h2><pre>${esc(err.stack || err)}</pre><button class="btn" onclick="location.reload()">Back</button></div>`;
      return;
    }
    game.input.onUnlock = () => {
      if (this.wantUnlock) { this.wantUnlock = false; return; }
      if (this.state === 'playing') this.showPause();
    };
    this.setState('resume');
    this.showClickToPlay(save ? 'Click to continue the descent' : 'Click to begin the descent');
    if (!save) this.introHints();
    if (legacy) this.hud.notify('This expedition was saved by an older version. The Abyss has changed below the Stone Plain, so it begins anew.', 'info', 12);
    window.__ready = true;
  }

  /** Create and connect every gameplay system once the world exists. */
  attachSystems(g, save) {
    const plan = g.plan;
    g.touch = this.touch;
    g.pad = this.device === 'pad';
    const p = new Player(g);
    const s = plan.spawn;
    p.spawn(s.x, s.y, s.z, s.yaw);
    g.player = p;
    g.grapple = new Grapple(g, p);
    p.grapple = g.grapple;
    g.ecosystem = new Ecosystem(g);
    g.artifacts = new ArtifactSystem(g);
    g.discovery = new Discovery(g);
    g.mapData = new MapData(g);
    g.envProbe = new EnvironmentProbe(g);
    g.discovery.attachEcosystem(g.ecosystem);
    g.discovery.attachArtifacts(g.artifacts);
    g.artifacts.recompute();
    g.saveId = `exp-${Date.now().toString(36)}`;
    g.expeditionName = `Expedition “${g.seedLabel}”`;
    if (save) applySave(g, save);
    g.camera.position.set(p.pos.x, p.pos.y + p.eyeH, p.pos.z);
    g.camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
    // per-frame glue that is not a system of its own
    const glue = { update: (dt) => this.glueUpdate(dt) };
    g.systems.push(glue, p, g.grapple, g.ecosystem, g.artifacts, g.discovery, g.mapData, g.envProbe);
    // interface
    this.hud = new HUD(g, this.ui);
    this.hud.setVisible(false);
    this.journal = new Journal(g, this.ui);
    this.journal.onClose = () => {
      if (this.state !== 'journal') return;
      if (this.touch) this.resume();
      else { this.setState('resume'); this.showClickToPlay(); }
    };
    g.touch = this.touch;
    if (this.touch) this.touchUI = new TouchControls(g, this);
    g.systems.push({ lateUpdate: (dt) => { this.hud.update(dt); if (this.touchUI) this.touchUI.update(); this.audioUpdate(dt); this.adaptQuality(); } });
    this.wireEvents(g);
    this.autosaveTimer = 120;
  }

  wireEvents(g) {
    const A = this.audio, H = this.hud, p = g.player, gr = g.grapple;
    p.on('step', (kind, speed, wet) => A.footstep(kind, speed, wet));
    const R = this.pad;
    p.on('land', (impact, kind) => { A.land(impact, kind); if (impact > 6) R.rumble(120, Math.min(1, impact / 18), 0.3); });
    p.on('jump', () => A.play('jump'));
    p.on('hurt', (amt) => { A.play('hurt'); H.flashHurt(amt); R.rumble(220, 0.4 + Math.min(0.6, amt / 40), 0.6); });
    p.on('death', () => { A.play('death'); R.rumble(700, 1, 0.8); });
    p.on('respawn', () => A.play('respawn'));
    p.on('splash', () => A.play('splash'));
    p.on('mantle', () => A.play('mantle'));
    p.on('grab', () => A.play('grab'));
    gr.on('fire', () => { A.play('grapple-fire'); R.rumble(60, 0, 0.45); });
    gr.on('attach', () => { A.play('grapple-attach', gr.anchor); R.rumble(90, 0.15, 0.7); });
    gr.on('miss', () => A.play('grapple-miss'));
    gr.on('release', () => A.play('grapple-release'));
    gr.on('stowed', () => A.play('grapple-stow'));
    gr.on('pullup', () => A.play('pullup'));
    // creature voices: nearby and urgent calls first, never a cacophony
    let lastCall = 0;
    g.ecosystem.on((type, d) => {
      if (type !== 'call' || !d.a) return;
      const dist = d.a.pos.distanceTo(p.pos);
      const urgent = d.kind === 'alarm' || d.kind === 'threat' || d.kind === 'hunt';
      const now = g.gameTime;
      if (dist > (urgent ? 140 : 70) || now - lastCall < (urgent ? 0.15 : 0.6)) return;
      lastCall = now;
      A.creatureCall(d.a.sp, d.a.pos, d.kind, d.a.juvenile ? 0.45 : 1);
    });
    const D = g.discovery;
    D.on((type, d) => {
      switch (type) {
        case 'species': H.notify(`New species recorded: <b>${esc(d.name)}</b> <span class="muted">${FAMILY_LABEL[d.family]}</span>`, 'creature', 6); A.play('species'); break;
        case 'observed': H.notify(`Observations of the <b>${esc(d.name)}</b> are complete.`, 'creature'); A.play('fact'); break;
        case 'fact': if (p.zoomed) A.play('fact'); break;
        case 'interaction': H.notify(`Observed — ${esc(d.text)}`, 'interaction', 6); A.play('fact'); break;
        case 'landmark': H.notify(`Discovered <b>${esc(d.name)}</b>`, 'landmark', 6); A.play('discover'); break;
        case 'route': H.notify(`Route found: <b>${esc(d.name)}</b>`, 'route', 5); break;
        case 'spotted': H.notify('Something glints nearby…', 'artifact', 4); break;
        case 'layer': {
          if (d.index > 0) {
            const L = d.layer;
            H.banner(L.name, L.title, `Depth ${Math.round(Math.max(0, -p.pos.y))} m`, 6);
            A.play('layer');
            this.save(true);
          }
          break;
        }
        case 'layer-change': {
          const L = d.layer;
          H.notify(d.index === 0 ? 'Back on the surface' : `${L.name} — ${L.title}`, 'layer', 4);
          break;
        }
        default: break;
      }
    });
    g.artifacts.on((type, a) => {
      switch (type) {
        case 'collect': H.notify(`Recovered <b>${esc(a.name)}</b> <span class="muted">${a.gradeLabel}</span>${g.artifacts.equipped.includes(a.id) ? ' — equipped' : ' — carried (press I)'}`, 'artifact', 7); A.play('pickup'); break;
        case 'identified': H.notify(`You now understand the <b>${esc(a.name)}</b>.`, 'artifact', 6); A.play('fact'); break;
        case 'cooldown': H.notify(`${esc(a.a.name)} is recharging (${Math.ceil(a.cd)} s)`, 'info', 2); break;
        case 'lamp': A.play('lamp'); break;
        case 'ability': {
          A.play('ability', p.pos);
          if (a.ability.type === 'pulse') { const n = D.pulse(80); H.notify(`Echo pulse: ${n} kinds of creature nearby.`, 'creature', 4); }
          if (a.ability.type === 'survey') { g.mapData.reveal(p.pos.x, p.pos.y, p.pos.z, 160); H.notify('Surveyed the surroundings — the map has grown.', 'route', 4); }
          if (a.ability.type === 'flare') H.notify('The flare floods the area with light.', 'info', 3);
          break;
        }
        default: break;
      }
    });
  }

  introHints() {
    const H = this.hud;
    const G = GLYPH;
    const seq = this.device === 'pad' ? [
      [1, `Left stick moves (${G.L3} to run) · right stick looks · ${G.cross} jump`],
      [11, 'The Abyss Eye lies at the centre of the world. Head for the gates in the rim wall to start your descent.'],
      [22, `${G.R2} fires the grappling arm · ${G.L2} reels in · ${G.L1} pays out · ${G.R1} lets go`],
      [34, `Hold ${G.triangle} to observe creatures · ${G.square} takes artifacts · ${G.up} lamp`],
      [46, `${G.left} map · ${G.right} vertical abyss map · ${G.share} catalog · ${G.touchpad} equipment`],
    ] : this.touch ? [
      [1, 'Drag on the left to move (push fully to run) · drag on the right to look'],
      [11, 'The Abyss Eye lies at the centre of the world. Head for the gates in the rim wall to start your descent.'],
      [22, '<b>Arm</b> fires the grappling claw where you aim · <b>Reel in</b> and <b>Pay out</b> appear once it bites'],
      [34, 'Hold <b>Observe</b> to study creatures · <b>Take</b> appears beside artifacts · hold <b>Jump</b> against rock to climb'],
      [46, 'The buttons at the top open the map and the journal · ☰ pauses'],
    ] : [
      [1, '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> jump'],
      [11, 'The Abyss Eye lies at the centre of the world. Head for the gates in the rim wall to start your descent.'],
      [22, '<kbd>Left click</kbd> fires the grappling arm · <kbd>Right click</kbd> reels in · <kbd>Z</kbd> pays out'],
      [34, 'Hold <kbd>F</kbd> to observe creatures · <kbd>E</kbd> takes artifacts · <kbd>L</kbd> lamp'],
      [46, '<kbd>M</kbd> map · <kbd>N</kbd> vertical abyss map · <kbd>J</kbd> catalog · <kbd>I</kbd> equipment'],
    ];
    this.hintQueue = seq.map(([t, h]) => ({ t, h }));
    this.hintClock = 0;
  }

  glueUpdate(dt) {
    const g = this.game, p = g.player;
    p.zoomed = g.input.is('observe') && !g.uiBlocking && p.mode !== 'dead' && p.mode !== 'climb';
    // intro hints
    if (this.hintQueue && this.hintQueue.length) {
      this.hintClock += dt;
      if (this.hintClock >= this.hintQueue[0].t) this.hud.hint(this.hintQueue.shift().h, 9);
    }
    // restless artifacts draw the curiosity of nearby creatures
    const mods = g.artifacts.mods;
    if (mods && mods.restless) {
      this.restlessT = (this.restlessT || 0) - dt;
      if (this.restlessT <= 0) {
        this.restlessT = 6;
        g.ecosystem.attract(p.pos, 6);
      }
    }
    // autosave
    this.autosaveTimer -= dt;
    if (this.autosaveTimer <= 0) { this.autosaveTimer = 120; if (p.mode !== 'dead' && p.onGround) this.save(true); }
  }

  /**
   * Keep the frame rate playable on slower machines: first lower the
   * rendering resolution (instant, no rebuild), then the view distance; give
   * both back when there is headroom again.
   */
  adaptQuality() {
    const now = performance.now();
    const ms = this.lastFrameT ? now - this.lastFrameT : 16;
    this.lastFrameT = now;
    if (ms > 250) return; // a hitch (tab switch, loading), not a trend
    this.frameEma = (this.frameEma ?? 16) * 0.95 + ms * 0.05;
    const s = this.settings, g = this.game;
    if (!s.autoQuality || this.state !== 'playing') return;
    this.qualityT = (this.qualityT || 0) + ms / 1000;
    if (this.qualityT < 1.5) return;
    this.qualityT = 0;
    // phones aim for a steady 30+, computers for 50+
    // (a frame rate cap chosen by the player is not a reason to lower the quality)
    const cap = (s.fpsLimit ?? 0) > 0 ? 1000 / s.fpsLimit : 0;
    const target = Math.max(this.touch ? 30 : 20, cap * 1.08);
    const cur = g.chunks.quality ?? s.viewDistance;
    const setRes = (k) => {
      if (Math.abs(k - this.dynScale) < 0.02) return;
      this.dynScale = k;
      g.renderer.setPixelRatio(s.pixelRatio * k);
    };
    if (this.frameEma > target * 1.2) {
      this.slowT = (this.slowT || 0) + 1;
      this.fastT = 0;
      if (this.dynScale > 0.62) setRes(Math.max(0.6, this.dynScale * 0.88));
      else if (this.slowT > 2 && cur > 0.55) {
        this.slowT = 0;
        g.chunks.setQuality(Math.max(0.5, cur - 0.1));
        if (!this.qualityNoted) { this.qualityNoted = true; this.hud.notify('Lowering terrain detail to keep the frame rate smooth (see Settings).', 'info', 6); }
      }
    } else if (this.frameEma < target * 0.8) {
      this.slowT = 0;
      this.fastT = (this.fastT || 0) + 1;
      if (cur < s.viewDistance - 0.01) { if (this.fastT > 2) { this.fastT = 0; g.chunks.setQuality(Math.min(s.viewDistance, cur + 0.1)); } }
      else if (this.dynScale < 1) setRes(Math.min(1, this.dynScale * 1.06));
    }
  }

  audioUpdate(dt) {
    const g = this.game;
    // the browser keeps sound off until a click, tap or key press (a controller does not count)
    if (this.audio.ctx && !this.audio.running && this.state === 'playing') {
      this.mutedT = (this.mutedT || 0) + dt;
      if (this.mutedT > 2 && !this.mutedNoted) { this.mutedNoted = true; this.hud.notify('Sound is waiting for a click, tap or key press — the browser requires one before it plays audio.', 'info', 10); }
    } else this.mutedT = 0;
    if (!this.audio.ready) return;
    const e = g.envProbe.state, info = g.layerInfo || { layer: 0 };
    // sound must never stop the picture: a failure here is reported once and skipped
    try {
    this.audio.update(dt, {
      pos: g.player.pos, layer: info.layer, zone: info.zone, enclosed: g.envEnclosed || 0, altitude: e.altitude,
      water: e.water, river: e.river, fall: e.fall, city: e.city, chasm: e.chasm, night: g.renderer.night > 0.5,
      reeling: g.grapple.attached && g.grapple.reeling, paying: g.grapple.attached && g.grapple.paying,
    }, g.camera);
    } catch (err) {
      if (!this.audioErr) { this.audioErr = true; console.warn('audio update failed', err); }
    }
  }

  async save(auto) {
    const g = this.game;
    if (!g || !g.player) return null;
    try {
      const s = captureSave(g, { auto });
      if (auto) { s.id = `${g.saveId}-auto`; s.name = `${g.expeditionName}`; }
      return await SaveStore.write(s);
    } catch (err) {
      console.warn('Save failed', err);
      if (!auto) this.toast('Saving failed: storage is full or unavailable.');
      return null;
    }
  }
}

export function boot(canvas) {
  const app = new App(canvas);
  const pending = sessionStorage.getItem('descents.pendingLoad');
  if (pending) {
    sessionStorage.removeItem('descents.pendingLoad');
    SaveStore.load(pending).then((save) => { if (save) app.startGame({ save }); else app.showTitle(); });
  } else app.showTitle();
  return app;
}
