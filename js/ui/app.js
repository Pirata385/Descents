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
import { SaveStore, captureSave, applySave, exportSave, validateSave } from '../systems/save.js';
import { AudioEngine } from '../audio/audio.js';
import { HUD } from './hud.js';
import { Journal } from './journal.js';
import { LAYERS } from '../world/layers.js';
import { FAMILY_LABEL } from '../creatures/genetics.js';

const SETTINGS_KEY = 'descents.settings.v1';
const DEFAULT_SETTINGS = {
  viewDistance: 1.0, shadows: true, fov: 75, sensitivity: 1, invertY: false, pixelRatio: 1.5, particles: 1,
  volMaster: 0.8, volMusic: 0.5, volAmbience: 0.7, volEffects: 0.8, showArm: true, showFps: false,
};

const TIPS = [
  'The Abyss Eye sits at the centre of the world. Every route down begins at its rim.',
  'Creatures of the first two layers ignore explorers. Below that, be careful.',
  'Hold F to study a creature. Patience reveals what it eats and how it lives.',
  'The grappling arm reaches 60 metres. Reel in to climb, pay out to rappel.',
  'Artifacts rest where few would look: ruins, cave chambers, the tops of spires.',
  'Rivers carve the bowl and plunge into the Eye as great falls.',
  'The Inverted Forest grows from the ceilings of vast galleries in the Abyss wall.',
  'Your map only shows what you have explored. Wander, and it will grow.',
  'Water breaks a fall. Stone does not.',
  'Equipped artifacts reveal their properties over time.',
];

const CONTROLS = [
  ['W A S D', 'Move'], ['Mouse', 'Look'], ['Space', 'Jump · climb a wall when held against it · let go of the cable'], ['Shift', 'Run'], ['Ctrl / C', 'Crouch · drop from a wall'],
  ['Left click', 'Fire / release the grappling arm'], ['Right click / Q / wheel up', 'Reel in the cable'], ['Z / wheel down', 'Pay out the cable'], ['X', 'Release the cable'],
  ['E', 'Take an artifact'], ['F (hold)', 'Observe creatures (zoom)'], ['R', 'Use an artifact ability'], ['L', "Explorer's lamp"],
  ['M', 'Map'], ['N', 'Vertical abyss map'], ['J / Tab', 'Creature catalog'], ['I', 'Equipment'], ['Esc / P', 'Pause'],
];

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
    this.settings = loadSettings();
    this.audio = new AudioEngine(this.settings);
    this.state = 'title';
    this.game = null;
    this.screen = document.createElement('div');
    this.screen.className = 'screen';
    this.ui.appendChild(this.screen);
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.__app = this;
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
    this.screen.querySelector('[data-act=new]').onclick = () => { const s = seedEl.value.trim() || randomSeedLabel(); this.audio.init(); this.startGame({ seedLabel: s }); };
    const cont = this.screen.querySelector('[data-act=continue]');
    if (cont) cont.onclick = async () => { this.audio.init(); const save = await SaveStore.load(latest.id); if (save) this.startGame({ save }); else this.toast('That save could not be read.'); };
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
            <div><b>${esc(m.name)}</b>${m.auto ? ' <span class="muted">(autosave)</span>' : ''}<br><span class="muted">${fmtDate(m.time)} · seed “${esc(m.seedLabel)}” · ${m.depth} m · ${LAYERS[m.layer]?.title || ''} · ${m.species} species · ${m.artifacts} artifacts</span></div>
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
        ${slider('viewDistance', 'View distance', 0.5, 1.6, 0.1, (v) => `${Math.round(v * 100)}%`)}
        ${slider('pixelRatio', 'Resolution scale', 0.5, 2, 0.25, (v) => `${v}×`)}
        ${slider('particles', 'Particles', 0, 1, 0.25, (v) => `${Math.round(v * 100)}%`)}
        ${check('shadows', 'Shadows')}
        ${slider('fov', 'Field of view', 60, 100, 1, (v) => `${v}°`)}
        ${check('showArm', 'Show the grappling arm')}
        ${check('showFps', 'Show frame rate')}
        <h3>Controls</h3>
        ${slider('sensitivity', 'Mouse sensitivity', 0.2, 3, 0.05, (v) => Number(v).toFixed(2))}
        ${check('invertY', 'Invert vertical look')}
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
          valEl.textContent = key === 'viewDistance' || key === 'particles' || key.startsWith('vol') ? `${Math.round(v * 100)}%` : key === 'fov' ? `${v}°` : key === 'pixelRatio' ? `${v}×` : Number(v).toFixed(2);
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
    if (!g || !g.renderer) return;
    if (key === 'viewDistance') g.chunks.setQuality(this.settings.viewDistance);
    if (key === 'shadows') g.renderer.setShadows(this.settings.shadows);
    if (key === 'pixelRatio') g.renderer.setPixelRatio(this.settings.pixelRatio);
  }

  showControls(back) {
    this.screen.className = `screen panel-screen ${back === 'pause' ? 'over-game' : 'title-screen'}`;
    this.screen.innerHTML = `
      ${back === 'title' ? '<div class="title-bg"></div>' : ''}
      <div class="panel">
        <h2>Controls</h2>
        <table class="controls">${CONTROLS.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</table>
        <p class="muted">Climb rock by holding <kbd>Space</kbd> while walking into a wall; stamina drains while climbing. Ledges within reach are mantled automatically. Running into water lets you swim; rivers carry you with their current.</p>
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
    g.paused = st === 'paused' || st === 'journal';
    if (this.hud) this.hud.setVisible(st === 'playing' || st === 'resume');
    if (this.audio.ready) this.audio.suspend(st === 'paused');
  }

  resume() {
    this.hideScreen();
    if (this.journal && this.journal.open) this.journal.close();
    this.setState('playing');
    this.game.input.lock();
    this.audio.init();
  }

  openJournal(tab) {
    if (!this.game || !this.game.player) return;
    this.wantUnlock = true;
    this.game.input.unlock();
    this.hideScreen();
    this.setState('journal');
    this.journal.show(tab);
    this.audio.play('open');
  }

  closeJournal(relock) {
    this.journal.open = false;
    this.journal.el.classList.add('hidden');
    if (this.journal.preview) this.journal.preview.detach();
    if (relock) this.resume();
    else { this.setState('resume'); this.showClickToPlay(); }
  }

  onKey(e) {
    if (!this.game || !this.game.player) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const code = e.code;
    const tabFor = { KeyM: 'map', KeyN: 'abyss', KeyJ: 'creatures', Tab: 'creatures', KeyI: 'equipment' }[code];
    if (this.state === 'playing') {
      if (tabFor) { e.preventDefault(); this.openJournal(tabFor); return; }
      if (code === 'Escape' || code === 'KeyP') { this.wantUnlock = true; this.game.input.unlock(); this.showPause(); }
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
    this.showLoading();
    const game = this.game = new Game(this.canvas, this.settings, {
      onProgress: (stage, p) => this.setProgress(stage, p),
      onWorldReady: (g) => this.attachSystems(g, save),
      onPausedFrame: () => {},
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
    window.__ready = true;
  }

  /** Create and connect every gameplay system once the world exists. */
  attachSystems(g, save) {
    const plan = g.plan;
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
    this.journal.onClose = () => { if (this.state === 'journal') { this.setState('resume'); this.showClickToPlay(); } };
    g.systems.push({ lateUpdate: (dt) => { this.hud.update(dt); this.audioUpdate(dt); } });
    this.wireEvents(g);
    this.autosaveTimer = 120;
  }

  wireEvents(g) {
    const A = this.audio, H = this.hud, p = g.player, gr = g.grapple;
    p.on('step', (kind, speed, wet) => A.footstep(kind, speed, wet));
    p.on('land', (impact, kind) => A.land(impact, kind));
    p.on('jump', () => A.play('jump'));
    p.on('hurt', (amt) => { A.play('hurt'); H.flashHurt(amt); });
    p.on('death', () => A.play('death'));
    p.on('respawn', () => A.play('respawn'));
    p.on('splash', () => A.play('splash'));
    p.on('mantle', () => A.play('mantle'));
    p.on('grab', () => A.play('grab'));
    gr.on('fire', () => A.play('grapple-fire'));
    gr.on('attach', () => A.play('grapple-attach', gr.anchor));
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
    const seq = [
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
        for (const a of g.ecosystem.agentsNear(p.pos, 35)) {
          if (a.sp.behavior.diet === 'carnivore' || a.airborne || a.state === 'flee' || a.state === 'hunt') continue;
          a.state = 'wander'; a.target = { pos: p.pos.clone().add({ x: Math.random() * 4 - 2, y: 0, z: Math.random() * 4 - 2 }) }; a.timer = 6;
          break;
        }
      }
    }
    // autosave
    this.autosaveTimer -= dt;
    if (this.autosaveTimer <= 0) { this.autosaveTimer = 120; if (p.mode !== 'dead' && p.onGround) this.save(true); }
  }

  audioUpdate(dt) {
    const g = this.game;
    if (!this.audio.ready) return;
    const e = g.envProbe.state, info = g.layerInfo || { layer: 0 };
    this.audio.update(dt, {
      pos: g.player.pos, layer: info.layer, zone: info.zone, enclosed: g.envEnclosed || 0, altitude: e.altitude,
      water: e.water, river: e.river, fall: e.fall, city: e.city, night: g.renderer.night > 0.5,
      reeling: g.grapple.attached && g.grapple.reeling, paying: g.grapple.attached && g.grapple.paying,
    }, g.camera);
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
