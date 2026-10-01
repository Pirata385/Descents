// Procedural audio with the Web Audio API. Nothing is pre-recorded:
// - ambience beds (wind, water, waterfalls, cave air, deep hum) mixed from
//   noise and oscillators according to the environment around the explorer,
// - spatialised one-shots: creature calls synthesised from each species'
//   genome (call type, pitch, rhythm, length), footsteps by ground material,
//   the grappling arm, discoveries and the interface,
// - generative music whose scale, tempo and instruments change per layer.
import { clamp, lerp } from '../core/mathutil.js';

const LAYER_MUSIC = [
  { root: 146.83, scale: [0, 2, 4, 7, 9], chordLen: [9, 13], pad: 'warm', lead: 'pluck', density: 0.35, bright: 1600 },      // surface
  { root: 164.81, scale: [0, 2, 3, 5, 7, 9, 10], chordLen: [10, 15], pad: 'airy', lead: 'pluck', density: 0.3, bright: 1900 }, // layer 1
  { root: 138.59, scale: [0, 2, 3, 7, 8], chordLen: [12, 18], pad: 'glass', lead: 'bell', density: 0.22, bright: 1300 },       // layer 2
  { root: 110.0, scale: [0, 1, 5, 6, 8], chordLen: [14, 22], pad: 'dark', lead: 'bell', density: 0.12, bright: 700 },          // layer 3
];

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.ready = false;
    this.caveSend = 0;
    this.musicLayer = -1;
    this.nextChord = 0;
    this.phraseEnd = 0;
    this.resting = false;
    this.eventTimer = 2;
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.3;
    this.master.connect(comp).connect(ctx.destination);
    this.music = ctx.createGain(); this.music.connect(this.master);
    this.amb = ctx.createGain(); this.amb.connect(this.master);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.uiBus = ctx.createGain(); this.uiBus.connect(this.master);
    // reverb (caves and the great open spaces)
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.2, 2.4);
    this.reverbOut = ctx.createGain(); this.reverbOut.gain.value = 0.6;
    this.reverb.connect(this.reverbOut).connect(this.master);
    this.sfxSend = ctx.createGain(); this.sfxSend.gain.value = 0.15; this.sfxSend.connect(this.reverb);
    this.musicSend = ctx.createGain(); this.musicSend.gain.value = 0.35; this.musicSend.connect(this.reverb);
    this.music.connect(this.musicSend);
    // noise sources
    this.white = this.noiseBuffer('white');
    this.brown = this.noiseBuffer('brown');
    this.pink = this.noiseBuffer('pink');
    this.buildBeds();
    this.applyVolumes();
    this.ready = true;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime((s.volMaster ?? 0.8), t, 0.05);
    this.music.gain.setTargetAtTime((s.volMusic ?? 0.5) * 0.5, t, 0.05);
    this.amb.gain.setTargetAtTime((s.volAmbience ?? 0.7), t, 0.05);
    this.sfx.gain.setTargetAtTime((s.volEffects ?? 0.8), t, 0.05);
    this.uiBus.gain.setTargetAtTime((s.volEffects ?? 0.8) * 0.6, t, 0.05);
  }

  suspend(on) { if (this.ctx) { if (on) this.ctx.suspend(); else this.ctx.resume(); } }

  // ------------------------------------------------------------------ building blocks
  noiseBuffer(kind) {
    const ctx = this.ctx, n = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    }
    return buf;
  }

  impulse(sec, decay) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return buf;
  }

  loopNoise(buf) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.loopStart = Math.random(); s.loopEnd = buf.duration;
    s.start(0, Math.random() * 2);
    return s;
  }

  buildBeds() {
    const ctx = this.ctx;
    const bed = (buf, type, freq, Q) => {
      const src = this.loopNoise(buf);
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.amb);
      return { src, f, g };
    };
    this.beds = {
      wind: bed(this.brown, 'bandpass', 380, 0.6),
      gust: bed(this.pink, 'highpass', 2400, 0.3),
      water: bed(this.white, 'bandpass', 900, 0.8),
      river: bed(this.pink, 'lowpass', 1400, 0.4),
      fall: bed(this.brown, 'lowpass', 520, 0.5),
      cave: bed(this.brown, 'lowpass', 160, 0.7),
    };
    // deep hum: two detuned oscillators
    const hg = ctx.createGain(); hg.gain.value = 0;
    const hf = ctx.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 220;
    for (const fr of [55, 55.7, 82.4]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr; o.connect(hf); o.start();
    }
    hf.connect(hg).connect(this.amb);
    this.beds.hum = { g: hg, f: hf };
    // reel motor
    const mo = ctx.createOscillator(); mo.type = 'sawtooth'; mo.frequency.value = 80;
    const mf = ctx.createBiquadFilter(); mf.type = 'lowpass'; mf.frequency.value = 600;
    const mg = ctx.createGain(); mg.gain.value = 0;
    mo.connect(mf).connect(mg).connect(this.sfx); mo.start();
    this.motor = { o: mo, g: mg };
  }

  /** A panner at a world position (null = non-positional). */
  out(pos, bus = this.sfx, ref = 4) {
    if (!pos) return bus;
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref; p.rolloffFactor = 1.1; p.maxDistance = 400;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(bus);
    if (this.caveSend > 0.05) { const s = this.ctx.createGain(); s.gain.value = this.caveSend * 0.6; p.connect(s).connect(this.reverb); }
    return p;
  }

  envelope(g, t, a, peak, d, sustainT = 0) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    if (sustainT) g.gain.setValueAtTime(peak, t + a + sustainT);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + sustainT + d);
  }

  tone(dest, t, { freq = 440, type = 'sine', a = 0.01, d = 0.3, s = 0, gain = 0.3, glide = null, glideT = null, vib = 0, vibRate = 6, lp = null }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, glide), t + (glideT ?? a + s + d));
    if (vib) { const l = ctx.createOscillator(); l.frequency.value = vibRate; const lg = ctx.createGain(); lg.gain.value = freq * vib; l.connect(lg).connect(o.frequency); l.start(t); l.stop(t + a + s + d + 0.05); }
    const g = ctx.createGain();
    let node = o;
    if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node.connect(f); node = f; }
    node.connect(g).connect(dest);
    this.envelope(g, t, a, gain, d, s);
    o.start(t); o.stop(t + a + s + d + 0.05);
    return o;
  }

  noise(dest, t, { buf = this.white, type = 'bandpass', freq = 1000, Q = 1, a = 0.005, d = 0.1, s = 0, gain = 0.3, sweep = null, am = 0 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = Q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + a + s + d);
    const g = ctx.createGain();
    let node = src.connect(f);
    if (am) {
      const amG = ctx.createGain(); amG.gain.value = 0.5;
      const l = ctx.createOscillator(); l.frequency.value = am; const lg = ctx.createGain(); lg.gain.value = 0.5;
      l.connect(lg).connect(amG.gain); l.start(t); l.stop(t + a + s + d + 0.05);
      node = node.connect(amG);
    }
    node.connect(g).connect(dest);
    this.envelope(g, t, a, gain, d, s);
    src.start(t, Math.random() * 2); src.stop(t + a + s + d + 0.05);
  }

  // ------------------------------------------------------------------ creature calls
  creatureCall(sp, pos, kind = 'idle', scale = 1) {
    if (!this.ready) return;
    const c = sp.call, t = this.ctx.currentTime + 0.02;
    const out = this.out(pos, this.sfx, 3 + sp.morph.size * 4);
    const p = c.pitch * (kind === 'alarm' ? 1.25 : kind === 'threat' || kind === 'hunt' ? 0.8 : 1) / Math.sqrt(Math.max(0.5, scale));
    const n = kind === 'alarm' ? Math.min(6, c.rhythm + 2) : c.rhythm;
    const L = c.length * (kind === 'threat' ? 1.4 : 1);
    const vol = clamp(0.1 + sp.morph.size * 0.08, 0.08, 0.45);
    const gap = Math.max(0.08, L * 0.7);
    switch (c.type) {
      case 'growl':
        this.tone(out, t, { freq: p * 0.4, type: 'sawtooth', a: 0.08, s: L * 0.8, d: 0.25, gain: vol, lp: 500, vib: 0.08, vibRate: 23, glide: p * 0.33 });
        this.noise(out, t, { buf: this.brown, type: 'lowpass', freq: 400, a: 0.08, s: L * 0.8, d: 0.2, gain: vol * 0.5, am: 27 });
        break;
      case 'bleat':
        for (let i = 0; i < Math.max(1, n - 1); i++) this.tone(out, t + i * (L + 0.1), { freq: p, type: 'square', a: 0.03, s: L * 0.6, d: 0.12, gain: vol * 0.5, vib: 0.04, vibRate: 7, lp: p * 3, glide: p * 0.9 });
        break;
      case 'hoot':
        for (let i = 0; i < n; i++) this.tone(out, t + i * (0.35 + L * 0.4), { freq: p * 0.55, a: 0.04, s: L * 0.3, d: 0.25, gain: vol, glide: p * 0.48 });
        break;
      case 'bark':
        for (let i = 0; i < n; i++) { const tt = t + i * 0.22; this.noise(out, tt, { freq: p * 1.2, Q: 3, d: 0.1, gain: vol * 0.8 }); this.tone(out, tt, { freq: p * 0.7, type: 'sawtooth', d: 0.1, gain: vol * 0.4, lp: 1500, glide: p * 0.5 }); }
        break;
      case 'whistle':
        this.tone(out, t, { freq: p * 1.5, a: 0.05, s: L * 0.4, d: 0.15, gain: vol * 0.5, glide: p * 2.1, glideT: L * 0.5 });
        if (n > 2) this.tone(out, t + L * 0.7, { freq: p * 2.0, a: 0.05, s: L * 0.2, d: 0.2, gain: vol * 0.4, glide: p * 1.3 });
        break;
      case 'hiss':
        this.noise(out, t, { type: 'highpass', freq: 3200, a: 0.05, s: L, d: 0.3, gain: vol * 0.6 });
        break;
      case 'croak':
        for (let i = 0; i < n; i++) this.tone(out, t + i * (L * 0.6 + 0.1), { freq: p * 0.35, type: 'square', a: 0.02, s: L * 0.4, d: 0.08, gain: vol * 0.45, lp: 700, vib: 0.3, vibRate: 30 });
        break;
      case 'rattle':
        for (let i = 0; i < Math.floor(L * 28); i++) this.noise(out, t + i / 28, { freq: 3000 + Math.random() * 2000, Q: 4, d: 0.025, gain: vol * 0.5 });
        break;
      case 'chirp':
        for (let i = 0; i < n + 1; i++) this.tone(out, t + i * 0.11, { freq: p, a: 0.005, d: 0.06, gain: vol * 0.45, glide: p * 1.7, glideT: 0.05 });
        break;
      case 'trill':
        this.tone(out, t, { freq: p * 1.2, a: 0.02, s: L, d: 0.1, gain: vol * 0.4, vib: 0.12, vibRate: 22 + c.rhythm * 3 });
        break;
      case 'caw':
        for (let i = 0; i < n; i++) this.tone(out, t + i * (L * 0.5 + 0.15), { freq: p * 0.8, type: 'sawtooth', a: 0.02, s: L * 0.3, d: 0.15, gain: vol * 0.45, lp: 1600, glide: p * 0.6 });
        break;
      case 'click':
        for (let i = 0; i < n * 3; i++) this.noise(out, t + i * 0.06 + Math.random() * 0.02, { freq: p * 2 + 1500, Q: 6, d: 0.02, gain: vol * 0.7 });
        break;
      case 'buzz':
        this.tone(out, t, { freq: p * 0.3, type: 'sawtooth', a: 0.05, s: L, d: 0.15, gain: vol * 0.3, lp: 2400, vib: 0.03, vibRate: 9 });
        break;
      case 'chirr':
        this.noise(out, t, { freq: Math.min(7000, p * 2), Q: 5, a: 0.03, s: L, d: 0.1, gain: vol * 0.6, am: 40 });
        break;
      case 'grind':
        this.noise(out, t, { buf: this.brown, type: 'bandpass', freq: 260, Q: 1.2, a: 0.1, s: L * 1.3, d: 0.3, gain: vol * 1.2, am: 11 });
        break;
      case 'rumble':
        this.tone(out, t, { freq: 46, a: 0.2, s: L * 1.5, d: 0.6, gain: vol * 1.1 });
        this.noise(out, t, { buf: this.brown, type: 'lowpass', freq: 140, a: 0.2, s: L * 1.5, d: 0.6, gain: vol });
        break;
      case 'chime':
        for (let i = 0; i < n; i++) for (const [m, gg] of [[1, 1], [2.76, 0.5], [5.4, 0.25]]) this.tone(out, t + i * 0.28, { freq: p * m, a: 0.003, d: 1.4, gain: vol * 0.3 * gg });
        break;
      default:
        this.tone(out, t, { freq: p, d: L, gain: vol * 0.4 });
    }
    void gap;
  }

  // ------------------------------------------------------------------ explorer sounds
  footstep(kind, speed, wet) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, o = this.sfx;
    const v = clamp(0.06 + speed * 0.012, 0.06, 0.16);
    if (wet) { this.noise(o, t, { freq: 900, Q: 0.8, a: 0.01, d: 0.18, gain: v * 1.4, sweep: 400 }); return; }
    switch (kind) {
      case 'grass': this.noise(o, t, { type: 'highpass', freq: 1800, a: 0.01, d: 0.09, gain: v * 0.9 }); break;
      case 'dirt': this.noise(o, t, { freq: 500, Q: 0.8, d: 0.08, gain: v * 1.2 }); break;
      case 'sand': this.noise(o, t, { type: 'lowpass', freq: 1200, a: 0.02, d: 0.12, gain: v }); break;
      case 'gravel': for (let i = 0; i < 5; i++) this.noise(o, t + Math.random() * 0.06, { freq: 2000 + Math.random() * 2500, Q: 3, d: 0.03, gain: v * 0.7 }); break;
      case 'wood': this.tone(o, t, { freq: 190 + Math.random() * 30, d: 0.09, gain: v * 1.4 }); this.noise(o, t, { freq: 900, Q: 2, d: 0.05, gain: v * 0.6 }); break;
      case 'metal': this.tone(o, t, { freq: 620, d: 0.12, gain: v * 0.5 }); this.tone(o, t, { freq: 1530, d: 0.08, gain: v * 0.3 }); break;
      case 'mud': this.noise(o, t, { type: 'lowpass', freq: 600, d: 0.14, gain: v * 1.2, sweep: 250 }); break;
      default: this.noise(o, t, { freq: 2300, Q: 1.5, d: 0.045, gain: v * 1.1 }); this.tone(o, t, { freq: 140, d: 0.05, gain: v * 0.6 }); break;
    }
  }

  land(impact, kind) {
    if (!this.ready || impact < 3) return;
    const t = this.ctx.currentTime, v = clamp(impact / 25, 0.1, 0.8);
    this.tone(this.sfx, t, { freq: 70, d: 0.25, gain: v * 0.7, glide: 40 });
    this.noise(this.sfx, t, { type: 'lowpass', freq: kind === 'grass' ? 900 : 1600, d: 0.15, gain: v * 0.5 });
  }

  play(name, pos = null) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = pos ? this.out(pos) : this.sfx;
    switch (name) {
      case 'jump': this.noise(o, t, { type: 'highpass', freq: 900, a: 0.02, d: 0.12, gain: 0.04 }); break;
      case 'grapple-fire':
        this.noise(o, t, { type: 'bandpass', freq: 3000, Q: 0.7, a: 0.01, d: 0.35, gain: 0.25, sweep: 900 });
        this.tone(o, t, { freq: 180, type: 'square', d: 0.05, gain: 0.12, lp: 900 });
        break;
      case 'grapple-attach':
        this.tone(o, t, { freq: 740, d: 0.25, gain: 0.18 }); this.tone(o, t, { freq: 1850, d: 0.15, gain: 0.1 });
        this.noise(o, t, { freq: 2500, Q: 2, d: 0.06, gain: 0.25 });
        break;
      case 'grapple-miss': this.noise(o, t, { freq: 1200, Q: 1, d: 0.2, gain: 0.08, sweep: 500 }); break;
      case 'grapple-release': this.tone(o, t, { freq: 420, type: 'square', d: 0.04, gain: 0.08, lp: 1200 }); this.noise(o, t, { type: 'highpass', freq: 2000, d: 0.25, gain: 0.1, sweep: 5000 }); break;
      case 'grapple-stow': this.tone(o, t, { freq: 300, type: 'square', d: 0.05, gain: 0.08, lp: 900 }); this.tone(o, t + 0.06, { freq: 520, type: 'square', d: 0.04, gain: 0.06, lp: 1200 }); break;
      case 'pullup': case 'mantle': this.noise(o, t, { type: 'lowpass', freq: 700, a: 0.05, d: 0.25, gain: 0.12 }); break;
      case 'grab': this.noise(o, t, { freq: 1600, Q: 1, d: 0.1, gain: 0.1 }); break;
      case 'hurt': this.tone(o, t, { freq: 90, d: 0.3, gain: 0.35, glide: 50 }); this.noise(o, t, { type: 'lowpass', freq: 500, d: 0.2, gain: 0.3 }); break;
      case 'death': this.tone(this.sfx, t, { freq: 60, a: 0.05, d: 2.5, gain: 0.5, glide: 30 }); this.noise(this.sfx, t, { buf: this.brown, type: 'lowpass', freq: 300, a: 0.1, d: 2, gain: 0.4 }); break;
      case 'respawn': for (const [i, f] of [[0, 392], [1, 523.25]]) this.tone(this.uiBus, t + i * 0.18, { freq: f, a: 0.05, d: 1.2, gain: 0.08 }); break;
      case 'splash': this.noise(o, t, { freq: 1100, Q: 0.6, a: 0.01, d: 0.6, gain: 0.35, sweep: 300 }); break;
      case 'pickup':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(this.uiBus, t + i * 0.08, { freq: f, a: 0.005, d: 0.9, gain: 0.1 }));
        break;
      case 'species': [659.25, 880, 987.77].forEach((f, i) => this.tone(this.uiBus, t + i * 0.12, { freq: f, type: 'triangle', a: 0.005, d: 0.6, gain: 0.08 })); break;
      case 'discover': [440, 659.25].forEach((f, i) => this.tone(this.uiBus, t + i * 0.2, { freq: f, a: 0.01, d: 1.6, gain: 0.08 })); break;
      case 'fact': this.tone(this.uiBus, t, { freq: 1318.5, type: 'triangle', a: 0.003, d: 0.35, gain: 0.05 }); break;
      case 'layer':
        this.tone(this.uiBus, t, { freq: 55, a: 0.4, d: 6, gain: 0.35 });
        this.tone(this.uiBus, t, { freq: 82.4, a: 1.2, d: 6, gain: 0.18 });
        for (const [m, g] of [[1, 0.12], [2.76, 0.05], [5.4, 0.025]]) this.tone(this.uiBus, t + 0.2, { freq: 220 * m, a: 0.003, d: 5, gain: g });
        break;
      case 'ability': this.tone(o, t, { freq: 300, a: 0.05, d: 0.8, gain: 0.15, glide: 1200 }); this.noise(o, t, { type: 'highpass', freq: 2000, a: 0.05, d: 0.6, gain: 0.08 }); break;
      case 'lamp': this.tone(this.uiBus, t, { freq: 1400, type: 'square', d: 0.03, gain: 0.03, lp: 3000 }); break;
      case 'click': this.tone(this.uiBus, t, { freq: 900, type: 'triangle', d: 0.05, gain: 0.05 }); break;
      case 'open': this.noise(this.uiBus, t, { freq: 1800, Q: 0.5, a: 0.02, d: 0.25, gain: 0.05, sweep: 600 }); break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ per-frame update
  /**
   * env: { pos, quat (camera), layer, zone, enclosed, altitude (m above the
   * local ground), water (0..1 proximity), river (0..1), fall (0..1), city,
   * night, reeling, motorSpeed }
   */
  update(dt, e, camera) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    // listener
    const L = ctx.listener;
    const p = camera.position;
    const f = camera.getWorldDirection(this._fwd || (this._fwd = p.clone()));
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(f.x, t, 0.02); L.forwardY.setTargetAtTime(f.y, t, 0.02); L.forwardZ.setTargetAtTime(f.z, t, 0.02);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
    const B = this.beds;
    const layer = e.layer;
    const open = 1 - e.enclosed;
    // wind: strongest on the surface and when hanging over the void
    let wind = [0.5, 0.4, 0.16, 0.22][Math.min(3, layer)] * open + clamp(e.altitude / 60, 0, 1) * 0.35 * open;
    wind *= 0.75 + 0.25 * Math.sin(t * 0.13) * Math.sin(t * 0.071 + 1);
    const gust = Math.max(0, Math.sin(t * 0.23) * Math.sin(t * 0.37 + 2) - 0.3) * wind * 0.8;
    B.wind.g.gain.setTargetAtTime(wind * 0.5, t, 0.5);
    B.wind.f.frequency.setTargetAtTime(260 + wind * 300 + gust * 400, t, 0.5);
    B.gust.g.gain.setTargetAtTime(gust * 0.08, t, 0.4);
    B.water.g.gain.setTargetAtTime(e.water * 0.05, t, 0.4);
    B.river.g.gain.setTargetAtTime(e.river * 0.16, t, 0.4);
    B.fall.g.gain.setTargetAtTime(e.fall * 0.5, t, 0.6);
    B.fall.f.frequency.setTargetAtTime(400 + e.fall * 500, t, 0.6);
    B.cave.g.gain.setTargetAtTime(e.enclosed * 0.16 + (layer >= 3 ? 0.12 : 0), t, 0.8);
    B.hum.g.gain.setTargetAtTime((layer >= 2 ? 0.04 : 0) + (layer >= 3 ? 0.06 : 0) + e.enclosed * 0.02, t, 1.0);
    this.caveSend = e.enclosed;
    this.sfxSend.gain.setTargetAtTime(0.08 + e.enclosed * 0.5 + (layer >= 2 ? 0.15 : 0), t, 0.5);
    // grapple winch
    this.motor.g.gain.setTargetAtTime(e.reeling ? 0.05 : e.paying ? 0.025 : 0, t, 0.05);
    this.motor.o.frequency.setTargetAtTime(e.reeling ? 95 : 60, t, 0.1);
    // occasional ambient events
    this.eventTimer -= dt;
    if (this.eventTimer <= 0) {
      this.eventTimer = 1.5 + Math.random() * 4;
      this.ambientEvent(e);
    }
    this.updateMusic(e);
  }

  ambientEvent(e) {
    const t = this.ctx.currentTime;
    const p = e.pos;
    const around = (r, dy = 0) => { const a = Math.random() * Math.PI * 2; return { x: p.x + Math.cos(a) * r, y: p.y + dy + Math.random() * 10, z: p.z + Math.sin(a) * r }; };
    const layer = e.layer;
    if (e.enclosed > 0.5 || layer >= 2) {
      // water drips echo in caves and galleries
      if (Math.random() < 0.7) {
        const o = this.out(around(4 + Math.random() * 14, 3), this.amb, 3);
        const f = 1400 + Math.random() * 1600;
        this.tone(o, t, { freq: f, a: 0.002, d: 0.12, gain: 0.07, glide: f * 1.6, glideT: 0.04 });
      }
    }
    if (layer >= 3 && Math.random() < 0.3) {
      // the fault groans
      const o = this.out(around(60, -20), this.amb, 20);
      this.tone(o, t, { freq: 38 + Math.random() * 10, a: 1.5, s: 1, d: 3, gain: 0.25 });
      this.noise(o, t, { buf: this.brown, type: 'lowpass', freq: 120, a: 1.5, s: 1, d: 3, gain: 0.2 });
    }
    if (e.enclosed < 0.5 && layer <= 1) {
      if (!e.night && Math.random() < 0.55) {
        // small songbirds and insects that are never seen
        const o = this.out(around(20 + Math.random() * 40, 4), this.amb, 6);
        const base = 2200 + Math.random() * 2400;
        const n = 2 + Math.floor(Math.random() * 5);
        for (let i = 0; i < n; i++) this.tone(o, t + i * (0.08 + Math.random() * 0.05), { freq: base * (0.9 + Math.random() * 0.3), a: 0.005, d: 0.06, gain: 0.03, glide: base * 1.3, glideT: 0.05 });
      } else if (e.night && Math.random() < 0.7) {
        const o = this.out(around(10 + Math.random() * 20), this.amb, 5);
        this.noise(o, t, { freq: 4200 + Math.random() * 1500, Q: 12, a: 0.02, s: 0.4 + Math.random() * 0.6, d: 0.05, gain: 0.03, am: 28 + Math.random() * 20 });
      }
    }
    if (layer === 2 && e.enclosed < 0.8 && Math.random() < 0.25) {
      // distant hollow calls in the inverted forest
      const o = this.out(around(80 + Math.random() * 80, 10), this.amb, 30);
      const f = 300 + Math.random() * 250;
      this.tone(o, t, { freq: f, a: 0.2, s: 0.3, d: 1.2, gain: 0.08, glide: f * 0.7 });
    }
    if (e.city > 0.5 && Math.random() < 0.25) {
      // a bell tower or a windmill creak
      const o = this.out(around(80 + Math.random() * 60, 20), this.amb, 30);
      if (Math.random() < 0.45) for (const [m, g] of [[1, 0.1], [2.4, 0.05], [3.9, 0.03]]) this.tone(o, t, { freq: 196 * m, a: 0.003, d: 3.5, gain: g });
      else this.tone(o, t, { freq: 140 + Math.random() * 60, type: 'sawtooth', a: 0.2, s: 0.4, d: 0.3, gain: 0.025, lp: 600, glide: 120 });
    }
  }

  // ------------------------------------------------------------------ music
  updateMusic(e) {
    const t = this.ctx.currentTime;
    const layer = Math.min(3, e.layer);
    if (layer !== this.musicLayer) {
      this.musicLayer = layer;
      this.nextChord = t + 2;
      this.resting = false;
      this.phraseEnd = t + 70 + Math.random() * 40;
    }
    if (t < this.nextChord) return;
    if (this.resting) {
      this.resting = false;
      this.phraseEnd = t + 60 + Math.random() * 50;
    }
    if (t > this.phraseEnd) {
      // a stretch of silence between phrases
      this.resting = true;
      this.nextChord = t + 25 + Math.random() * 35;
      return;
    }
    const M = LAYER_MUSIC[layer];
    const len = M.chordLen[0] + Math.random() * (M.chordLen[1] - M.chordLen[0]);
    this.nextChord = t + len * 0.85;
    const sc = M.scale;
    const note = (deg, oct = 0) => {
      const n = sc.length;
      const o = Math.floor(deg / n) + oct;
      const i = ((deg % n) + n) % n;
      return M.root * Math.pow(2, (sc[i] + o * 12) / 12);
    };
    const rootDeg = [0, 0, 2, 3, 4, -1, 1][Math.floor(Math.random() * 7)];
    const voices = [rootDeg - sc.length, rootDeg, rootDeg + 2, rootDeg + 4];
    for (const dg of voices) this.padVoice(t, note(dg), len, M);
    // sparse melody over the chord
    const beats = Math.floor(len / 1.4);
    let deg = rootDeg + sc.length + Math.floor(Math.random() * 3);
    for (let b = 1; b < beats; b++) {
      if (Math.random() > M.density) continue;
      deg += [-2, -1, -1, 1, 1, 2, 0][Math.floor(Math.random() * 7)];
      deg = clamp(deg, rootDeg + 2, rootDeg + sc.length * 2 + 2);
      this.leadNote(t + b * 1.4 + Math.random() * 0.1, note(deg), M);
    }
  }

  padVoice(t, freq, len, M) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = M.bright * 0.6; f.Q.value = 0.5;
    f.frequency.linearRampToValueAtTime(M.bright, t + len * 0.5);
    f.frequency.linearRampToValueAtTime(M.bright * 0.5, t + len + 4);
    const types = { warm: ['triangle', 'sine'], airy: ['sine', 'triangle'], glass: ['sine', 'sine'], dark: ['sawtooth', 'sine'] }[M.pad];
    for (const [k, det] of [[0, -4], [1, 5]]) {
      const o = ctx.createOscillator(); o.type = types[k]; o.frequency.value = freq; o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + len + 6);
    }
    f.connect(g).connect(this.music);
    const peak = M.pad === 'dark' ? 0.05 : 0.06;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.min(4, len * 0.35));
    g.gain.setValueAtTime(peak, t + len);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len + 5.5);
  }

  leadNote(t, freq, M) {
    if (M.lead === 'bell') {
      for (const [m, g] of [[1, 0.06], [2.76, 0.025], [5.4, 0.012]]) this.tone(this.music, t, { freq: freq * m, a: 0.003, d: 3.2, gain: g });
    } else {
      this.tone(this.music, t, { freq, type: 'triangle', a: 0.004, d: 1.6, gain: 0.07, lp: 2200 });
      this.tone(this.music, t, { freq: freq * 2, a: 0.004, d: 0.5, gain: 0.015 });
    }
  }
}

export { lerp };
