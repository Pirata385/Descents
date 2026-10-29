// The sound engine. Every sound is baked into samples ahead of time (in a
// worker, from the recipes in recipes.js) and played back from a small pool of
// voices. Nothing is synthesised while playing: no oscillator graphs built per
// sound, no convolution reverb, no 3D panner nodes. Where a sound comes from is
// turned into its volume, its stereo balance and a muffled path for distant
// sounds right here, from the camera; the echo of the Great Fault is one delay
// line. Ambience is a set of looping beds faded in and out with the
// surroundings, music is a sequencer that plays baked instrument notes.
//
// Sound starts on the first click, tap or key press (the browser's rule) and is
// resumed by any later one, and when the page comes back into view.
import { STEP_KINDS, INSTRUMENT_BASE, bake } from './recipes.js';

const MAX_VOICES = 24;
const fin = Number.isFinite;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// what is baked first: what the player hears at once, then the rest
const FIRST = ['click', 'tick', 'open', 'test', ...STEP_KINDS.flatMap((k) => [0, 1, 2].map((v) => `step-${k}-${v}`)), 'jump', 'land-soft', 'land-hard',
  'amb-wind', 'amb-cave', 'amb-water', 'amb-river', 'amb-fall', 'mus-pad', 'mus-glass', 'mus-pluck', 'mus-bell'];
const LATER = ['hurt', 'death', 'respawn', 'splash', 'mantle', 'grab', 'pickup', 'species', 'fact', 'discover', 'layer', 'wield', 'lamp', 'ability',
  'grapple-fire', 'grapple-attach', 'grapple-miss', 'grapple-release', 'grapple-stow', 'pullup',
  'amb-gust', 'amb-hum', 'amb-howl', 'amb-drizzle', 'amb-night', 'amb-city', 'amb-shimmer', 'motor', 'beam', 'mus-choir', 'mus-chime', 'mus-drum', 'mus-drum-hi',
  'swing', 'swing-heavy', 'hit', 'hit-heavy', 'kill', 'bolt', 'shard', 'impact', 'overheat', 'shield-hit', 'shield-break', 'orb', 'bite',
  'ab-gamma', 'ab-shockwave', 'ab-thornburst', 'ab-stasis', 'ab-aegis', 'ab-phase', 'ab-mend', 'ab-repel', 'boss-roar', 'boss-slam', 'boss-volley', 'boss-fall',
  'drip-0', 'drip-1', 'drip-2', 'drip-3', 'bird-0', 'bird-1', 'bird-2', 'bird-3', 'cricket-0', 'cricket-1', 'glass-0', 'glass-1', 'glass-2', 'glass-3',
  'groan', 'scree', 'wings', 'bell-tower', 'creak', 'hollow-call'];

// ambience beds: their buses
const BEDS = {
  'amb-wind': 'amb', 'amb-gust': 'amb', 'amb-water': 'amb', 'amb-river': 'amb', 'amb-fall': 'amb', 'amb-cave': 'amb', 'amb-hum': 'amb',
  'amb-howl': 'amb', 'amb-drizzle': 'amb', 'amb-night': 'amb', 'amb-city': 'amb', 'amb-shimmer': 'amb', motor: 'sfx', beam: 'sfx',
};
// wind in the open, per layer
const LAYER_WIND = [0.55, 0.45, 0.18, 0.25, 0.08];
// music per layer: root (MIDI), scale, the pad and the lead instrument, how busy the melody is, chord length (s)
const MUSIC = [
  { root: 50, scale: [0, 2, 4, 7, 9], pad: 'pad', lead: 'pluck', density: 0.35, chord: [9, 13] },
  { root: 52, scale: [0, 2, 3, 5, 7, 9, 10], pad: 'glass', lead: 'pluck', density: 0.3, chord: [10, 14] },
  { root: 49, scale: [0, 2, 3, 7, 8], pad: 'glass', lead: 'bell', density: 0.22, chord: [11, 16] },
  { root: 48, scale: [0, 2, 3, 5, 7, 9], pad: 'choir', lead: 'bell', density: 0.2, chord: [12, 17] },
  { root: 47, scale: [0, 2, 4, 6, 7, 11], pad: 'choir', lead: 'chime', density: 0.2, chord: [12, 17] },
];

export class Sound {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.wanted = false;
    this.paused = false;
    this.tag = null;
    this.bank = new Map();
    this.queued = new Set();
    this.jobs = new Map();
    this.nextJob = 1;
    this.voices = [];
    this.beds = new Map();
    this.L = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
    this.bedT = 0;
    this.eventT = 3;
    this.mNext = 0;
    this.mLayer = -1;
    this.drumT = 0;
    this.drumN = 0;
    this.lastTime = -1;
    this.stuckT = 0;
    this.status = 'Sound starts with the first click, tap or key press.';
    const kick = () => this.kick();
    for (const ev of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'keydown', 'click']) window.addEventListener(ev, kick, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(); else if (this.tag) this.tag.pause(); });
  }

  /** Sound is playing now. */
  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  get ready() { return !!this.ctx; }

  // ------------------------------------------------------------------ start, resume, pause
  /** Called from a click, tap or key press: create (or wake) the audio context. */
  start() {
    this.wanted = true;
    this.kick();
  }

  kick() {
    if (!this.wanted) return;
    if (!this.ctx || this.ctx.state === 'closed') this.create();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running' && !this.paused) {
      ctx.resume().catch(() => {});
      // iPhones and iPads unlock sound with a sound started inside the gesture
      try { const b = ctx.createBuffer(1, 1, ctx.sampleRate); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch { /* ignore */ }
    }
    if (!this.paused) this.unmute();
  }

  /**
   * Older iPhones and iPads (before navigator.audioSession) mute Web Audio with the
   * ring/silent switch unless a media element is playing: a silent looping <audio>
   * started inside the gesture keeps the page in "playback" mode.
   */
  unmute() {
    if (this.tag) { if (this.tag.paused) this.tag.play().catch(() => {}); return; }
    if (navigator.audioSession) return;
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!ios) return;
    const n = 4000, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
    const tag = (o, t) => { for (let i = 0; i < 4; i++) b[o + i] = t.charCodeAt(i); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + n, true); tag(8, 'WAVE'); tag(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    tag(36, 'data'); v.setUint32(40, n, true); b.fill(128, 44);
    let str = ''; for (const x of b) str += String.fromCharCode(x);
    const a = document.createElement('audio');
    a.setAttribute('x-webkit-airplay', 'deny');
    a.loop = true; a.preload = 'auto'; a.src = `data:audio/wav;base64,${btoa(str)}`;
    a.play().catch(() => {});
    this.tag = a;
  }

  create() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.status = 'This browser has no Web Audio: the game is silent.'; return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }
    let ctx;
    try { ctx = new AC({ latencyHint: 'balanced' }); } catch { try { ctx = new AC(); } catch (err) { this.status = `Sound could not start (${err && err.message})`; return; } }
    this.ctx = ctx;
    ctx.onstatechange = () => this.describe();
    // buses: master -> gentle limiter (a soft clipping curve) -> speakers
    this.master = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) { const x = (i / 512 - 1) * 1.6; curve[i] = Math.tanh(x) / Math.tanh(1.6); }
    shaper.curve = curve;
    this.master.connect(shaper).connect(ctx.destination);
    const bus = () => { const g = ctx.createGain(); g.connect(this.master); return g; };
    this.bus = { music: bus(), amb: bus(), sfx: bus(), ui: bus() };
    // distant sounds pass through a lowpass (air and rock swallow the highs)
    this.far = ctx.createBiquadFilter();
    this.far.type = 'lowpass'; this.far.frequency.value = 1500; this.far.Q.value = 0.5;
    this.far.connect(this.bus.sfx);
    // the echo of the Great Fault
    this.echoIn = ctx.createGain(); this.echoIn.gain.value = 0;
    const delay = ctx.createDelay(1.5); delay.delayTime.value = 0.46;
    const fb = ctx.createGain(); fb.gain.value = 0.3;
    const elp = ctx.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 1600;
    this.echoIn.connect(delay).connect(elp).connect(fb).connect(delay);
    elp.connect(this.bus.sfx);
    this.setVolumes();
    // forget whatever belonged to an earlier context
    this.bank.clear(); this.queued.clear(); this.jobs.clear(); this.beds.clear(); this.voices.length = 0;
    this.startBaking();
    this.describe();
  }

  describe() {
    const c = this.ctx;
    if (!c) return;
    this.status = c.state === 'running' ? `Sound is on (${c.sampleRate} Hz, ${this.bank.size} sounds ready).`
      : c.state === 'suspended' ? (this.paused ? 'Sound is paused.' : 'Sound is waiting for a click, tap or key press.')
        : `Sound is ${c.state}.`;
  }

  pause(on) {
    this.paused = on;
    if (!this.ctx) return;
    if (on) { this.ctx.suspend().catch(() => {}); if (this.tag) this.tag.pause(); }
    else this.kick();
  }

  setVolumes() {
    if (!this.ctx) return;
    const s = this.settings, t = this.ctx.currentTime;
    const set = (g, v) => g.gain.setTargetAtTime(clamp(fin(v) ? v : 0, 0, 2), t, 0.05);
    // a fixed lift to a normal listening level (the soft clipper keeps the loudest moments round)
    set(this.master, (s.volMaster ?? 0.8) * 1.9);
    set(this.bus.music, (s.volMusic ?? 0.5) * 0.7);
    set(this.bus.amb, s.volAmbience ?? 0.7);
    set(this.bus.sfx, s.volEffects ?? 0.8);
    set(this.bus.ui, (s.volEffects ?? 0.8) * 0.7);
  }

  // ------------------------------------------------------------------ baking
  startBaking() {
    try {
      this.worker = new Worker(new URL('./bakeWorker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.baked(e.data);
      this.worker.onerror = () => { this.worker = null; this.flushToMainThread(); };
    } catch { this.worker = null; }
    this.queue(FIRST);
    this.queue(LATER);
  }

  queue(names) {
    const jobs = [];
    for (const name of names) {
      if (this.bank.has(name) || this.queued.has(name)) continue;
      this.queued.add(name);
      const id = this.nextJob++;
      const job = { id, name };
      this.jobs.set(id, job);
      jobs.push(job);
    }
    this.send(jobs);
  }

  /** A creature's own call, baked from its species genome. */
  queueCall(sp) {
    const name = `call-${sp.id}`;
    if (this.bank.has(name) || this.queued.has(name) || !sp.call) return;
    this.queued.add(name);
    const id = this.nextJob++;
    const job = { id, name, call: { type: sp.call.type, pitch: sp.call.pitch, rhythm: sp.call.rhythm, length: sp.call.length }, seed: (sp.id + 1) * 7919 };
    this.jobs.set(id, job);
    this.send([job]);
  }

  /** Bake the calls of every species of a world, after the rest. */
  prepareCalls(species) { for (const sp of species) this.queueCall(sp); }

  send(jobs) {
    if (!jobs.length) return;
    // small batches, so the first sounds arrive at once
    if (this.worker) { for (let i = 0; i < jobs.length; i += 6) this.worker.postMessage({ jobs: jobs.slice(i, i + 6) }); return; }
    this.pendingMain = (this.pendingMain || []).concat(jobs);
    this.pumpMain();
  }

  /** No worker: bake on this thread, one sound per slice of idle time. */
  pumpMain() {
    if (this.mainBusy || !this.pendingMain || !this.pendingMain.length) return;
    this.mainBusy = true;
    setTimeout(() => {
      this.mainBusy = false;
      const job = this.pendingMain.shift();
      if (job) {
        try { const r = bake(job); const chans = Array.isArray(r.data) ? r.data : [r.data]; this.baked({ id: job.id, sr: 24000, loop: !!r.loop, chans }); } catch (err) { this.baked({ id: job.id, error: String(err) }); }
      }
      this.pumpMain();
    }, 4);
  }

  flushToMainThread() {
    const rest = [...this.jobs.values()].filter((j) => !this.bank.has(j.name));
    this.pendingMain = rest;
    this.pumpMain();
  }

  baked(m) {
    const job = this.jobs.get(m.id);
    if (!job || !this.ctx) return;
    this.jobs.delete(m.id);
    this.queued.delete(job.name);
    if (m.error || !m.chans || !m.chans[0] || !m.chans[0].length) { console.warn('sound not baked', job.name, m.error); return; }
    try {
      const b = this.ctx.createBuffer(m.chans.length, m.chans[0].length, m.sr);
      m.chans.forEach((c, i) => b.copyToChannel ? b.copyToChannel(c, i) : b.getChannelData(i).set(c));
      this.bank.set(job.name, b);
    } catch (err) { console.warn('sound buffer failed', job.name, err); }
    if (this.bank.size % 20 === 0) this.describe();
  }

  // ------------------------------------------------------------------ playing
  /**
   * Play a baked sound. pos: world position (none: heard as from the explorer).
   * o: { gain, rate, prio (0 chatter, 1 normal, 2 important), bus, ref, max, delay }.
   */
  play(name, pos = null, o = {}) {
    if (!this.running) return;
    const b = this.bank.get(name);
    if (!b) { if (!this.queued.has(name) && !name.startsWith('call-')) this.queue([name]); return; }
    this.voice(b, pos, o);
  }

  voice(b, pos, o) {
    const ctx = this.ctx, t = ctx.currentTime;
    const prio = o.prio ?? 1;
    let g = o.gain ?? 1, pan = 0, far = false;
    if (pos) {
      if (!fin(pos.x) || !fin(pos.y) || !fin(pos.z)) return;
      const L = this.L, dx = pos.x - L.x, dy = pos.y - L.y, dz = pos.z - L.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const ref = o.ref ?? 4, max = o.max ?? 140;
      if (d > max) return;
      if (d > ref) g *= ref / (ref + (d - ref));
      if (d > max * 0.7) g *= 1 - (d - max * 0.7) / (max * 0.3);
      if (d > 0.5) pan = clamp((dx * L.rx + dz * L.rz) / d, -1, 1) * 0.75;
      far = d > 32;
    }
    if (!(g > 0.008) || !fin(g) || !fin(pan)) return;
    // the voice budget: chatter gives way to what matters
    if (this.voices.length >= MAX_VOICES) this.voices = this.voices.filter((v) => v.end > t);
    if (this.voices.length >= MAX_VOICES) {
      let low = null;
      for (const v of this.voices) if (!low || v.prio < low.prio || (v.prio === low.prio && v.start < low.start)) low = v;
      if (!low || low.prio > prio) return;
      try { low.src.stop(); } catch { /* ended */ }
      this.voices.splice(this.voices.indexOf(low), 1);
    }
    const rate = clamp(fin(o.rate) ? o.rate : 1, 0.25, 4);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const gn = ctx.createGain();
    gn.gain.value = Math.min(2, g);
    src.connect(gn);
    let out = gn;
    if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; gn.connect(p); out = p; }
    out.connect(far ? this.far : (this.bus[o.bus] || this.bus.sfx));
    if (pos && this.echoLevel > 0.05) out.connect(this.echoIn);
    const at = t + (o.delay || 0);
    src.start(at);
    const v = { src, start: at, end: at + b.duration / rate, prio };
    this.voices.push(v);
    src.onended = () => { try { out.disconnect(); gn.disconnect(); } catch { /* gone */ } };
  }

  // ------------------------------------------------------------------ what the game asks for
  fx(name, pos = null) {
    const ui = name === 'click' || name === 'tick' || name === 'open' || name === 'species' || name === 'fact' || name === 'discover' || name === 'pickup' || name === 'layer' || name === 'respawn' || name === 'wield' || name === 'test';
    const big = name.startsWith('boss') || name === 'ab-shockwave';
    this.play(name, pos, { bus: ui ? 'ui' : 'sfx', prio: ui ? 2 : 1, ref: big ? 14 : 5, max: big ? 260 : 140 });
  }

  step(kind, speed, wet) {
    const k = wet ? 'wet' : STEP_KINDS.includes(kind) ? kind : 'stone';
    this.play(`step-${k}-${Math.floor(Math.random() * 3)}`, null, { gain: clamp(0.45 + (speed || 0) * 0.06, 0.45, 1), rate: 0.94 + Math.random() * 0.12, prio: 1 });
  }

  land(impact, kind) {
    if (!(impact >= 3)) return;
    this.play(impact > 12 ? 'land-hard' : 'land-soft', null, { gain: clamp(impact / 18, 0.35, 1), rate: kind === 'grass' ? 0.95 : 1.05 });
  }

  /** A creature's call: its own sound, pitched by mood and age. */
  call(sp, pos, kind = 'idle', scale = 1) {
    if (!this.running || !sp) return;
    const name = `call-${sp.id}`;
    if (!this.bank.has(name)) { this.queueCall(sp); return; }
    const mood = kind === 'alarm' ? 1.25 : kind === 'threat' || kind === 'hunt' ? 0.82 : kind === 'court' ? 1.06 : 1;
    const size = sp.size ?? 1;
    const urgent = kind === 'alarm' || kind === 'threat' || kind === 'hunt';
    this.play(name, pos, { gain: clamp(0.45 + size * 0.22, 0.45, 1.1), rate: mood / Math.sqrt(Math.max(0.45, scale)) * (0.96 + Math.random() * 0.08), prio: urgent ? 1 : 0, ref: 3 + size * 4, max: urgent ? 150 : 90 });
  }

  /** The settings page's test: a short chime and a word on the state of sound. */
  test() {
    this.start();
    const go = (k) => { if (this.bank.has('test') && this.running) this.play('test', null, { bus: 'ui', prio: 2 }); else if (k < 10) setTimeout(() => go(k + 1), 300); };
    go(0);
    this.describe();
    return this.status;
  }

  // ------------------------------------------------------------------ every frame
  /**
   * e: { pos, layer, enclosed, altitude, water, river, fall, city, chasm, night, reeling, paying, beam, boss }
   */
  frame(dt, e, camera) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t = ctx.currentTime;
    // a context whose clock stopped (a broken audio device) is replaced at the next touch
    if (t === this.lastTime) { this.stuckT += dt; if (this.stuckT > 3) { this.stuckT = 0; try { ctx.close(); } catch { /* ignore */ } this.ctx = null; return; } } else this.stuckT = 0;
    this.lastTime = t;
    // the listener: the camera's position and its right-hand direction (for stereo)
    const m = camera.matrixWorld.elements;
    const L = this.L;
    if (fin(m[12]) && fin(m[14])) { L.x = m[12]; L.y = m[13]; L.z = m[14]; }
    const h = Math.hypot(m[0], m[2]);
    if (h > 1e-4) { L.rx = m[0] / h; L.rz = m[2] / h; }
    for (const k of ['enclosed', 'altitude', 'water', 'river', 'fall', 'city', 'chasm', 'beam', 'boss']) if (!fin(e[k])) e[k] = 0;
    const layer = clamp(fin(e.layer) ? e.layer : 0, 0, 4);
    this.bedT -= dt;
    if (this.bedT <= 0) { this.bedT = 0.1; this.mixBeds(e, layer, t); }
    this.eventT -= dt;
    if (this.eventT <= 0) { this.eventT = 1.2 + Math.random() * 3.5; this.ambientEvent(e, layer); }
    this.music(e, layer, t);
  }

  /** Ambience: each bed's level from the surroundings, faded smoothly; silent beds are stopped. */
  mixBeds(e, layer, t) {
    const open = 1 - clamp(e.enclosed, 0, 1);
    const chasm = clamp(e.chasm, 0, 1);
    const wind = Math.min(0.75, LAYER_WIND[layer] * open + clamp(e.altitude / 60, 0, 1) * 0.3 * open + chasm * 0.2);
    const gusty = Math.max(0, Math.sin(t * 0.23) * Math.sin(t * 0.37 + 2) - 0.2);
    const want = {
      'amb-wind': wind * 0.8,
      'amb-gust': wind * gusty * 0.7,
      'amb-water': clamp(e.water, 0, 1) * 0.45,
      'amb-river': clamp(e.river, 0, 1) * 0.6,
      'amb-fall': clamp(e.fall, 0, 1) * 0.85,
      'amb-cave': 0.12 + clamp(e.enclosed, 0, 1) * 0.4 + (layer >= 3 ? 0.08 : 0),
      'amb-hum': layer >= 2 ? 0.14 + clamp(e.enclosed, 0, 1) * 0.1 : 0,
      'amb-howl': chasm * 0.35,
      'amb-drizzle': layer >= 4 ? 0.45 * (1 - clamp(e.enclosed, 0, 1) * 0.7) : 0,
      'amb-shimmer': layer >= 4 ? 0.18 : 0,
      'amb-night': layer <= 1 && e.night ? open * 0.4 : 0,
      'amb-city': clamp(e.city, 0, 1) * 0.35,
      motor: e.reeling ? 0.45 : e.paying ? 0.22 : 0,
      beam: e.beam ? 0.6 : 0,
    };
    for (const [name, lv0] of Object.entries(want)) {
      const lv = fin(lv0) ? clamp(lv0, 0, 1) : 0;
      let b = this.beds.get(name);
      if (!b && lv > 0.004) {
        const buf = this.bank.get(name);
        if (!buf) continue;
        const src = this.ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const g = this.ctx.createGain(); g.gain.value = 0;
        src.connect(g).connect(this.bus[BEDS[name]] || this.bus.amb);
        src.start(0, Math.random() * buf.duration);
        b = { src, g, quietT: 0 };
        this.beds.set(name, b);
      }
      if (!b) continue;
      const fast = name === 'motor' || name === 'beam';
      b.g.gain.setTargetAtTime(lv, t, fast ? 0.04 : 0.5);
      b.quietT = lv <= 0.004 ? b.quietT + 0.1 : 0;
      if (b.quietT > 4) { try { b.src.stop(); b.src.disconnect(); b.g.disconnect(); } catch { /* gone */ } this.beds.delete(name); }
    }
    // the far wall of the Great Fault answers
    this.echoLevel = chasm;
    this.echoIn.gain.setTargetAtTime(chasm * 0.35, t, 0.5);
  }

  /** Now and then, a sound of the place: drips, birds, crickets, scree, wings, chimes, bells. */
  ambientEvent(e, layer) {
    const p = e.pos;
    if (!p) return;
    const around = (r, dy = 0) => { const a = Math.random() * Math.PI * 2; return { x: p.x + Math.cos(a) * r, y: p.y + dy + Math.random() * 8, z: p.z + Math.sin(a) * r }; };
    const pick = (base, n) => `${base}-${Math.floor(Math.random() * n)}`;
    const quiet = { prio: 0, bus: 'amb' };
    if ((e.enclosed > 0.5 || layer >= 2) && Math.random() < 0.6) this.play(pick('drip', 4), around(4 + Math.random() * 14, 3), { ...quiet, gain: 0.5, ref: 3, rate: 0.9 + Math.random() * 0.25 });
    if (layer === 3 && Math.random() < 0.18) this.play('groan', around(60, -20), { ...quiet, gain: 0.9, ref: 25, max: 300 });
    if (layer === 3 && e.chasm > 0.3 && Math.random() < 0.25) this.play('scree', around(90 + Math.random() * 90, (Math.random() - 0.5) * 120), { ...quiet, gain: 0.8, ref: 40, max: 400 });
    if (layer === 3 && e.chasm > 0.3 && Math.random() < 0.25) this.play('wings', around(30 + Math.random() * 50), { ...quiet, gain: 0.8, ref: 10 });
    if (layer >= 4 && Math.random() < 0.5) this.play(pick('glass', 4), around(20 + Math.random() * 50, 10), { ...quiet, gain: 0.7, ref: 15, max: 200 });
    if (e.enclosed < 0.5 && layer <= 1) {
      if (!e.night && Math.random() < 0.55) this.play(pick('bird', 4), around(15 + Math.random() * 35, 4), { ...quiet, gain: 0.6, ref: 8, rate: 0.9 + Math.random() * 0.25 });
      else if (e.night && Math.random() < 0.5) this.play(pick('cricket', 2), around(6 + Math.random() * 15), { ...quiet, gain: 0.5, ref: 5 });
    }
    if (layer === 2 && e.enclosed < 0.8 && Math.random() < 0.2) this.play('hollow-call', around(70 + Math.random() * 60, 10), { ...quiet, gain: 0.8, ref: 30, max: 300 });
    if (e.city > 0.5 && Math.random() < 0.2) this.play(Math.random() < 0.45 ? 'bell-tower' : 'creak', around(70 + Math.random() * 50, 20), { ...quiet, gain: 0.7, ref: 30, max: 300 });
  }

  /** Generative music: slow chords of the layer's pad with a sparse melody, and the warden's drums. */
  music(e, layer, t) {
    const M = MUSIC[layer];
    if (layer !== this.mLayer) { this.mLayer = layer; this.mNext = Math.max(this.mNext, t + 1.5); }
    if (e.boss) {
      if (t + 0.3 > this.drumT) {
        const at = Math.max(this.drumT, t + 0.05);
        this.drumN = (this.drumN + 1) % 8;
        this.note('mus-drum', 0, at, this.drumN % 4 === 0 ? 0.9 : 0.6, 1);
        if (this.drumN === 6) this.note('mus-drum-hi', 0, at + 0.37, 0.5, 1);
        this.drumT = at + 0.74;
      }
    }
    if (t + 0.5 < this.mNext) return;
    const at = Math.max(this.mNext, t + 0.05);
    const len = M.chord[0] + Math.random() * (M.chord[1] - M.chord[0]);
    this.mNext = at + len;
    // now and then a breath of silence (short: long silences sound like broken sound)
    if (Math.random() < 0.12) { this.mNext = at + 5 + Math.random() * 4; return; }
    const sc = M.scale, n = sc.length;
    const midi = (deg) => M.root + sc[((deg % n) + n) % n] + 12 * Math.floor(deg / n);
    const root = [0, 0, 2, 3, 4, -1, 1][Math.floor(Math.random() * 7)];
    const padBase = INSTRUMENT_BASE[M.pad];
    for (const d of [root - n, root, root + 2]) this.note(`mus-${M.pad}`, midi(d) - padBase, at + Math.random() * 0.3, 0.55);
    const beats = Math.floor(len / 1.4);
    let deg = root + n + Math.floor(Math.random() * 3);
    const leadBase = INSTRUMENT_BASE[M.lead];
    for (let b = 1; b < beats; b++) {
      if (Math.random() > M.density) continue;
      deg = clamp(deg + [-2, -1, -1, 1, 1, 2, 0][Math.floor(Math.random() * 7)], root + 2, root + n * 2 + 2);
      this.note(`mus-${M.lead}`, midi(deg) + 12 - leadBase, at + b * 1.4 + Math.random() * 0.08, 0.45);
    }
  }

  /** One instrument note, transposed by semitones from the instrument's baked note. */
  note(name, semis, at, gain, prio = 2) {
    const b = this.bank.get(name);
    if (!b) { if (!this.queued.has(name)) this.queue([name]); return; }
    const t = this.ctx.currentTime;
    this.voice(b, null, { bus: 'music', gain, rate: Math.pow(2, semis / 12), prio, delay: Math.max(0, at - t) });
  }
}
