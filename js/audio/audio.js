// Procedural audio with the Web Audio API. Nothing is pre-recorded:
// - ambience beds (wind, water, waterfalls, cave air, deep hum) mixed from
//   noise and oscillators according to the environment around the explorer,
// - spatialised one-shots: creature calls synthesised from each species'
//   genome (call type, pitch, rhythm, length), footsteps by ground material,
//   the grappling arm, discoveries and the interface,
// - generative music whose scale, tempo and instruments change per layer.
//
// Keeping it audible. Sound on the web can die silently in a few ways, and
// each has a guard here:
// - a NaN or infinity reaching the graph (from a bad position, a degenerate
//   listener orientation, a filter pushed past its limits) poisons the
//   compressor and every filter with memory, which then output silence or
//   NaN forever. Every parameter is checked before use, the listener never
//   faces straight up or down, and a watchdog listens to the output: when it
//   finds NaN, or silence while the beds should be sounding, it rebuilds the
//   whole mixing graph (and, if that keeps happening, the audio context).
// - the browser suspending the context (another tab, a phone call, a device
//   change): it is resumed as soon as possible, on any gesture or by itself.
// - too many voices at once (swarms, rattles, fights) overload slow devices:
//   one-shots beyond a voice budget are dropped, the least important first.
import { clamp, lerp } from '../core/mathutil.js';

// The sounds are synthesised at modest levels (band-passed noise carries little
// energy); the output stage lifts the whole mix to a normal listening level and
// a limiter keeps the peaks from clipping.
const OUTPUT_GAIN = 2.2;   // about +7 dB on top of the compressor's own make-up gain
const MAX_VOICES = 70;     // one-shot voices sounding at once
const LOW_VOICES = 44;     // creature calls and ambient events stop here
const fin = Number.isFinite;

const LAYER_MUSIC = [
  { root: 146.83, scale: [0, 2, 4, 7, 9], chordLen: [9, 13], pad: 'warm', lead: 'pluck', density: 0.35, bright: 1600 },      // surface
  { root: 164.81, scale: [0, 2, 3, 5, 7, 9, 10], chordLen: [10, 15], pad: 'airy', lead: 'pluck', density: 0.3, bright: 1900 }, // layer 1
  { root: 138.59, scale: [0, 2, 3, 7, 8], chordLen: [12, 18], pad: 'glass', lead: 'bell', density: 0.22, bright: 1300 },       // layer 2
  { root: 130.81, scale: [0, 2, 3, 5, 7, 9], chordLen: [14, 22], pad: 'airy', lead: 'bell', density: 0.16, bright: 1500 },     // layer 3: the open tube
  { root: 123.47, scale: [0, 2, 4, 6, 7, 11], chordLen: [16, 24], pad: 'choir', lead: 'chime', density: 0.16, bright: 2600 },  // layer 4
];
// wind strength in the open, per layer
const LAYER_WIND = [0.5, 0.4, 0.16, 0.22, 0.05];

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
    this.wantRunning = true;
    this.voices = [];          // end times of the sounding one-shot voices
    this.lowPri = false;
    this.watchT = 0;
    this.silentN = 0;
    this.rebuilds = [];
    this.resumeT = 0;
    // browsers only let sound start from a click, tap or key press: any of them
    // (re)starts it, also after the phone was locked or another tab took over
    const unlock = () => {
      if (!this.ctx) return;
      if (this.ctx.state !== 'running' && this.wantRunning) this.ctx.resume().catch(() => {});
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.addEventListener(ev, unlock, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) unlock(); });
  }

  /** Whether sound is actually playing (the browser may still be holding it back). */
  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    // iPhone / iPad: play even when the ring/silent switch is on
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    ctx.onstatechange = () => { if (ctx.state !== 'running' && ctx.state !== 'closed' && this.wantRunning) ctx.resume().catch(() => {}); };
    // noise sources
    this.white = this.noiseBuffer('white');
    this.brown = this.noiseBuffer('brown');
    this.pink = this.noiseBuffer('pink');
    this.buildGraph();
    this.ready = true;
  }

  /** The mixing graph: buses, compressor and limiter, reverbs, echo, ambience beds. */
  buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.knee.value = 10; comp.ratio.value = 2.5; comp.attack.value = 0.008; comp.release.value = 0.3;
    const makeup = ctx.createGain(); makeup.gain.value = OUTPUT_GAIN;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.12;
    this.master.connect(comp).connect(makeup).connect(limiter).connect(ctx.destination);
    this.outTap = limiter;
    this.comp = comp; this.limiter = limiter; this.makeup = makeup;
    // the watchdog listens here
    this.probe = ctx.createAnalyser();
    this.probe.fftSize = 512;
    this.probeBuf = new Float32Array(this.probe.fftSize);
    limiter.connect(this.probe);
    this.music = ctx.createGain(); this.music.connect(this.master);
    this.amb = ctx.createGain(); this.amb.connect(this.master);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.uiBus = ctx.createGain(); this.uiBus.connect(this.master);
    // reverb: a tight one for caves and tunnels, a vast one for the chasm and
    // the galleries, and a slap-back echo off the far wall of the Great Fault
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.2, 2.6);
    this.reverbOut = ctx.createGain(); this.reverbOut.gain.value = 0.6;
    this.reverb.connect(this.reverbOut).connect(this.master);
    this.reverbBig = ctx.createConvolver();
    this.reverbBig.buffer = this.impulse(5.5, 3.2, 0.06);
    this.reverbBigOut = ctx.createGain(); this.reverbBigOut.gain.value = 0.5;
    this.reverbBig.connect(this.reverbBigOut).connect(this.master);
    this.echo = ctx.createDelay(2); this.echo.delayTime.value = 0.7;
    const fb = ctx.createGain(); fb.gain.value = 0.34;
    const elp = ctx.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 1700;
    this.echoIn = ctx.createGain(); this.echoIn.gain.value = 0;
    this.echoIn.connect(this.echo).connect(elp).connect(fb).connect(this.echo);
    elp.connect(this.master);
    this.sfxSend = ctx.createGain(); this.sfxSend.gain.value = 0.15; this.sfxSend.connect(this.reverb);
    this.sfxSendBig = ctx.createGain(); this.sfxSendBig.gain.value = 0; this.sfxSendBig.connect(this.reverbBig);
    this.sfx.connect(this.sfxSend);
    this.sfx.connect(this.sfxSendBig);
    this.musicSend = ctx.createGain(); this.musicSend.gain.value = 0.35; this.musicSend.connect(this.reverb);
    this.musicSendBig = ctx.createGain(); this.musicSendBig.gain.value = 0; this.musicSendBig.connect(this.reverbBig);
    this.music.connect(this.musicSend);
    this.music.connect(this.musicSendBig);
    this.bigSend = 0;
    this.echoAmt = 0;
    this.buildBeds();
    this.applyVolumes();
    this.voices.length = 0;
  }

  /** Take the graph apart: stop every bed and loop, disconnect the buses. */
  teardown() {
    const stop = (n) => { try { n.stop(); } catch { /* not started or already stopped */ } };
    for (const b of Object.values(this.beds || {})) { if (b.src) stop(b.src); if (b.oscs) b.oscs.forEach(stop); }
    if (this.motor) stop(this.motor.o);
    if (this.beamHum) this.beamHum.oscs.forEach(stop);
    for (const n of [this.master, this.comp, this.makeup, this.limiter, this.music, this.amb, this.sfx, this.uiBus, this.reverb, this.reverbBig, this.reverbOut, this.reverbBigOut, this.echo, this.echoIn, this.sfxSend, this.sfxSendBig, this.musicSend, this.musicSendBig, this.probe]) {
      try { if (n) n.disconnect(); } catch { /* already */ }
    }
  }

  /**
   * The output went bad (NaN) or silent when it should not be: rebuild the
   * graph; when that keeps happening, start a new audio context.
   */
  recover(why) {
    const now = performance.now();
    this.rebuilds = this.rebuilds.filter((t) => now - t < 60000);
    this.rebuilds.push(now);
    console.warn(`audio: ${why}, rebuilding the sound graph`);
    this.teardown();
    if (this.rebuilds.length > 3 && this.ctx.state !== 'closed') {
      // a fresh context: the browser allows it without a gesture once the page was used
      const old = this.ctx;
      this.ready = false;
      this.ctx = null;
      old.close().catch(() => {});
      this.rebuilds.length = 0;
      this.init();
      return;
    }
    this.buildGraph();
    this.musicLayer = -1;
  }

  /** Twice a second: is the output healthy? */
  watchdog(dt) {
    const ctx = this.ctx;
    if (!ctx) return;
    // a suspended or interrupted context comes back as soon as the browser lets it
    if (ctx.state !== 'running') {
      this.resumeT -= dt;
      if (this.wantRunning && this.resumeT <= 0) { this.resumeT = 1.5; ctx.resume().catch(() => {}); }
      this.silentN = 0;
      return;
    }
    this.watchT -= dt;
    if (this.watchT > 0) return;
    this.watchT = 0.5;
    this.probe.getFloatTimeDomainData(this.probeBuf);
    let peak = 0, bad = false;
    for (let i = 0; i < this.probeBuf.length; i++) {
      const v = this.probeBuf[i];
      if (!fin(v)) { bad = true; break; }
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    if (bad) { this.recover('the output carried NaN'); return; }
    // the beds always breathe a little; total silence for 4 s means a dead graph
    const s = this.settings;
    const expect = (s.volMaster ?? 0.8) > 0.05 && Math.max(s.volAmbience ?? 0.7, s.volMusic ?? 0.5, s.volEffects ?? 0.8) > 0.05;
    if (expect && peak < 1e-7) {
      if (++this.silentN >= 8) { this.silentN = 0; this.recover('the output fell silent'); }
    } else this.silentN = 0;
  }

  /** Room for one more one-shot voice? (the least important go first) */
  voice(end) {
    const now = this.ctx.currentTime;
    if (this.voices.length > 24) this.voices = this.voices.filter((t) => t > now);
    if (this.voices.length >= (this.lowPri ? LOW_VOICES : MAX_VOICES)) return false;
    this.voices.push(end);
    return true;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime((s.volMaster ?? 0.8), t, 0.05);
    this.music.gain.setTargetAtTime((s.volMusic ?? 0.5) * 0.42, t, 0.05);
    this.amb.gain.setTargetAtTime((s.volAmbience ?? 0.7), t, 0.05);
    this.sfx.gain.setTargetAtTime((s.volEffects ?? 0.8), t, 0.05);
    this.uiBus.gain.setTargetAtTime((s.volEffects ?? 0.8) * 0.6, t, 0.05);
  }

  suspend(on) {
    this.wantRunning = !on;
    if (!this.ctx) return;
    if (on) this.ctx.suspend().catch(() => {}); else this.ctx.resume().catch(() => {});
  }

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

  impulse(sec, decay, predelay = 0) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec), pd = Math.floor(ctx.sampleRate * predelay);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      // darker tail: a one-pole lowpass that closes as the sound decays
      let lp = 0;
      for (let i = pd; i < n; i++) {
        const u = (i - pd) / (n - pd);
        const k = 0.9 - 0.75 * u;
        lp += ((Math.random() * 2 - 1) - lp) * k;
        d[i] = lp * Math.pow(1 - u, decay);
      }
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
      howl: bed(this.pink, 'bandpass', 190, 9),
      shimmer: bed(this.white, 'bandpass', 5200, 6),
    };
    // deep hum: two detuned oscillators
    const hg = ctx.createGain(); hg.gain.value = 0;
    const hf = ctx.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 220;
    const humOscs = [];
    for (const fr of [55, 55.7, 82.4]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr; o.connect(hf); o.start(); humOscs.push(o);
    }
    hf.connect(hg).connect(this.amb);
    this.beds.hum = { g: hg, f: hf, oscs: humOscs };
    // reel motor
    const mo = ctx.createOscillator(); mo.type = 'sawtooth'; mo.frequency.value = 80;
    const mf = ctx.createBiquadFilter(); mf.type = 'lowpass'; mf.frequency.value = 600;
    const mg = ctx.createGain(); mg.gain.value = 0;
    mo.connect(mf).connect(mg).connect(this.sfx); mo.start();
    this.motor = { o: mo, g: mg };
    // the gamma ray: a crackling, singing hum while it pours
    const bg = ctx.createGain(); bg.gain.value = 0;
    const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 900; bf.Q.value = 0.7;
    const oscs = [];
    for (const [fr, ty] of [[110, 'sawtooth'], [220.6, 'square'], [880, 'sine']]) { const o = ctx.createOscillator(); o.type = ty; o.frequency.value = fr; o.connect(bf); o.start(); oscs.push(o); }
    bf.connect(bg).connect(this.sfx);
    this.beamHum = { g: bg, f: bf, oscs };
  }

  /** A panner at a world position (null = non-positional). */
  out(pos, bus = this.sfx, ref = 4) {
    if (!pos || !fin(pos.x) || !fin(pos.y) || !fin(pos.z)) return bus;
    if (!fin(ref) || ref <= 0) ref = 4;
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref; p.rolloffFactor = 1.1; p.maxDistance = 400;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(bus);
    // the effects bus has its own reverb sends; ambience gets them per sound
    if (bus !== this.sfx) {
      if (this.caveSend > 0.05) { const s = this.ctx.createGain(); s.gain.value = this.caveSend * 0.6; p.connect(s).connect(this.reverb); }
      if (this.bigSend > 0.05) { const s = this.ctx.createGain(); s.gain.value = this.bigSend * 0.55; p.connect(s).connect(this.reverbBig); }
    }
    if (this.echoAmt > 0.05) p.connect(this.echoIn);
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
    if (!fin(freq) || !fin(gain) || !fin(a) || !fin(d) || !fin(s) || !fin(t) || gain <= 0) return null;
    if ((glide !== null && !fin(glide)) || (glideT !== null && !fin(glideT)) || !fin(vib) || (lp !== null && !fin(lp))) return null;
    freq = clamp(freq, 15, 18000);
    if (!this.voice(t + a + s + d)) return null;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, glide), t + (glideT ?? a + s + d));
    if (vib) { const l = ctx.createOscillator(); l.frequency.value = vibRate; const lg = ctx.createGain(); lg.gain.value = freq * vib; l.connect(lg).connect(o.frequency); l.start(t); l.stop(t + a + s + d + 0.05); }
    const g = ctx.createGain();
    let node = o;
    if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = clamp(lp, 20, ctx.sampleRate * 0.45); node.connect(f); node = f; }
    node.connect(g).connect(dest);
    this.envelope(g, t, a, gain, d, s);
    o.start(t); o.stop(t + a + s + d + 0.05);
    return o;
  }

  noise(dest, t, { buf = this.white, type = 'bandpass', freq = 1000, Q = 1, a = 0.005, d = 0.1, s = 0, gain = 0.3, sweep = null, am = 0 }) {
    const ctx = this.ctx;
    if (!fin(freq) || !fin(gain) || !fin(a) || !fin(d) || !fin(s) || !fin(Q) || !fin(t) || gain <= 0 || (sweep !== null && !fin(sweep)) || !fin(am)) return;
    // filters are kept well inside their stable range
    const ny = ctx.sampleRate * 0.45;
    freq = clamp(freq, 20, ny); Q = clamp(Q, 0.05, 30);
    if (sweep !== null) sweep = clamp(sweep, 20, ny);
    if (!this.voice(t + a + s + d)) return;
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
    if (!this.ready || !sp || !sp.call) return;
    this.lowPri = kind === 'idle' || kind === 'court';
    try { this.callVoice(sp, pos, kind, scale); } finally { this.lowPri = false; }
  }

  callVoice(sp, pos, kind, scale) {
    const c = sp.call, t = this.ctx.currentTime + 0.02;
    if (!fin(c.pitch) || !fin(c.length)) return;
    const size = sp.size ?? 1;
    const out = this.out(pos, this.sfx, 3 + size * 4);
    const p = c.pitch * (kind === 'alarm' ? 1.25 : kind === 'threat' || kind === 'hunt' ? 0.8 : 1) / Math.sqrt(Math.max(0.5, scale));
    const n = kind === 'alarm' ? Math.min(6, c.rhythm + 2) : c.rhythm;
    const L = c.length * (kind === 'threat' ? 1.4 : 1);
    const vol = clamp(0.25 + size * 0.2, 0.22, 0.9);
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
      case 'squeak':
        // tiny, high and quick (bats and shrews)
        for (let i = 0; i < n; i++) this.tone(out, t + i * 0.07, { freq: Math.min(6000, p * 2.2), a: 0.003, d: 0.035, gain: vol * 0.35, glide: Math.min(7000, p * 2.8), glideT: 0.03 });
        break;
      case 'chitter':
        for (let i = 0; i < n * 2 + 2; i++) this.tone(out, t + i * 0.045 + Math.random() * 0.01, { freq: p * (1.4 + Math.random() * 0.3), type: 'square', a: 0.002, d: 0.025, gain: vol * 0.25, lp: 4000 });
        break;
      case 'scream':
        this.tone(out, t, { freq: p * 1.1, type: 'sawtooth', a: 0.02, s: L * 0.6, d: 0.25, gain: vol * 0.4, lp: 3200, vib: 0.06, vibRate: 11, glide: p * 0.8 });
        this.noise(out, t, { freq: p * 2, Q: 2, a: 0.02, s: L * 0.5, d: 0.2, gain: vol * 0.25 });
        break;
      case 'chime':
        for (let i = 0; i < n; i++) for (const [m, gg] of [[1, 1], [2.76, 0.5], [5.4, 0.25]]) this.tone(out, t + i * 0.28, { freq: p * m, a: 0.003, d: 1.4, gain: vol * 0.3 * gg });
        break;
      case 'peep':
        // little rising peeps (tree frogs)
        for (let i = 0; i < n + 1; i++) this.tone(out, t + i * (0.16 + L * 0.2), { freq: p * 1.6, a: 0.01, d: 0.09, gain: vol * 0.4, glide: p * 2.1, glideT: 0.07 });
        break;
      case 'burble':
        // a wet, bubbling warble
        this.tone(out, t, { freq: p * 0.5, type: 'triangle', a: 0.03, s: L * 0.8, d: 0.15, gain: vol * 0.45, vib: 0.25, vibRate: 13 + c.rhythm * 2, lp: 1400 });
        this.noise(out, t, { freq: p * 1.2, Q: 4, a: 0.03, s: L * 0.8, d: 0.12, gain: vol * 0.18, am: 17 });
        break;
      case 'hum':
        // a soft, slowly swelling drone with a shimmer
        this.tone(out, t, { freq: p * 0.4, a: L * 0.5, s: L, d: 0.6, gain: vol * 0.5, vib: 0.02, vibRate: 4 });
        this.tone(out, t, { freq: p * 0.8 * 1.005, a: L * 0.5, s: L, d: 0.6, gain: vol * 0.18 });
        break;
      case 'coo':
        for (let i = 0; i < Math.min(3, n); i++) this.tone(out, t + i * (0.42 + L * 0.3), { freq: p * 0.6, a: 0.06, s: L * 0.3, d: 0.22, gain: vol * 0.5, glide: p * 0.5, lp: 1200 });
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
    const v = clamp(0.06 + speed * 0.012, 0.06, 0.16) * 3.2;
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
    const t = this.ctx.currentTime, v = clamp(impact / 25, 0.1, 0.8) * 1.6;
    this.tone(this.sfx, t, { freq: 70, d: 0.25, gain: v * 0.7, glide: 40 });
    this.noise(this.sfx, t, { type: 'lowpass', freq: kind === 'grass' ? 900 : 1600, d: 0.15, gain: v * 0.5 });
  }

  play(name, pos = null) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = pos ? this.out(pos) : this.sfx;
    switch (name) {
      case 'jump': this.noise(o, t, { type: 'bandpass', freq: 700, Q: 0.6, a: 0.02, d: 0.14, gain: 0.3 }); break;
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
      // ---- combat
      case 'swing': this.noise(o, t, { type: 'bandpass', freq: 1800, Q: 0.9, a: 0.03, d: 0.16, gain: 0.32, sweep: 600 }); break;
      case 'swing-heavy':
        this.noise(o, t, { type: 'bandpass', freq: 900, Q: 0.7, a: 0.06, d: 0.28, gain: 0.42, sweep: 260 });
        this.tone(o, t, { freq: 120, a: 0.05, d: 0.22, gain: 0.12, glide: 70 });
        break;
      case 'hit':
        this.noise(o, t, { type: 'lowpass', freq: 1300, a: 0.002, d: 0.12, gain: 0.55 });
        this.tone(o, t, { freq: 150, a: 0.002, d: 0.14, gain: 0.35, glide: 70 });
        break;
      case 'hit-heavy':
        this.noise(o, t, { buf: this.brown, type: 'lowpass', freq: 700, a: 0.003, d: 0.3, gain: 0.8 });
        this.tone(o, t, { freq: 90, a: 0.003, d: 0.35, gain: 0.5, glide: 45 });
        break;
      case 'kill':
        this.tone(o, t, { freq: 220, a: 0.003, d: 0.45, gain: 0.3, glide: 60 });
        this.noise(o, t, { type: 'lowpass', freq: 900, a: 0.01, d: 0.5, gain: 0.4, sweep: 200 });
        break;
      case 'bolt':
        this.tone(o, t, { freq: 900, type: 'square', a: 0.002, d: 0.08, gain: 0.08, lp: 3000, glide: 300 });
        this.noise(o, t, { type: 'highpass', freq: 2500, a: 0.002, d: 0.18, gain: 0.22, sweep: 7000 });
        break;
      case 'shard': for (let i = 0; i < 3; i++) this.noise(o, t + i * 0.015, { freq: 3000 + i * 900, Q: 3, a: 0.002, d: 0.12, gain: 0.18 }); break;
      case 'impact': this.noise(o, t, { freq: 1400, Q: 1.2, a: 0.002, d: 0.09, gain: 0.25 }); break;
      case 'overheat':
        this.noise(o, t, { type: 'highpass', freq: 3000, a: 0.01, s: 0.3, d: 0.6, gain: 0.18 });
        this.tone(o, t, { freq: 1200, type: 'triangle', a: 0.01, d: 0.4, gain: 0.08, glide: 600 });
        break;
      case 'shield-hit': this.tone(o, t, { freq: 640, type: 'triangle', a: 0.002, d: 0.3, gain: 0.14 }); this.tone(o, t, { freq: 1730, a: 0.002, d: 0.2, gain: 0.06 }); break;
      case 'shield-break': for (let i = 0; i < 6; i++) this.tone(o, t + i * 0.03, { freq: 1500 + Math.random() * 1800, a: 0.002, d: 0.3, gain: 0.07 }); break;
      case 'orb':
        this.noise(o, t, { buf: this.pink, type: 'lowpass', freq: 1800, a: 0.005, d: 0.4, gain: 0.45, sweep: 300 });
        this.tone(o, t, { freq: 330, a: 0.005, d: 0.4, gain: 0.15, glide: 120 });
        break;
      case 'bite':
        this.noise(o, t, { freq: 2200, Q: 1.5, a: 0.002, d: 0.06, gain: 0.35 });
        this.noise(o, t + 0.05, { type: 'lowpass', freq: 800, a: 0.002, d: 0.1, gain: 0.3 });
        break;
      case 'wield': this.tone(this.uiBus, t, { freq: 520, type: 'triangle', a: 0.003, d: 0.12, gain: 0.06 }); this.noise(this.uiBus, t, { type: 'highpass', freq: 4000, a: 0.005, d: 0.2, gain: 0.05 }); break;
      case 'ab-gamma':
        this.tone(o, t, { freq: 110, type: 'sawtooth', a: 0.05, s: 2.6, d: 0.4, gain: 0.1, lp: 1600, vib: 0.02, vibRate: 31 });
        this.tone(o, t, { freq: 880, a: 0.05, s: 2.6, d: 0.4, gain: 0.05, vib: 0.01, vibRate: 7 });
        this.noise(o, t, { type: 'highpass', freq: 3500, a: 0.05, s: 2.6, d: 0.4, gain: 0.08 });
        break;
      case 'ab-shockwave':
        this.tone(o, t, { freq: 70, a: 0.005, d: 0.8, gain: 0.6, glide: 35 });
        this.noise(o, t, { buf: this.brown, type: 'lowpass', freq: 600, a: 0.005, d: 0.7, gain: 0.7, sweep: 120 });
        break;
      case 'ab-thornburst': for (let i = 0; i < 8; i++) { this.noise(o, t + i * 0.04, { freq: 2500 + Math.random() * 2000, Q: 4, a: 0.002, d: 0.15, gain: 0.16 }); this.tone(o, t + i * 0.04, { freq: 1800 + i * 160, a: 0.002, d: 0.3, gain: 0.03 }); } break;
      case 'ab-stasis':
        this.tone(o, t, { freq: 1900, a: 0.01, d: 1.4, gain: 0.08, glide: 900 });
        this.noise(o, t, { type: 'highpass', freq: 5000, a: 0.01, d: 1.0, gain: 0.08 });
        break;
      case 'ab-aegis': [392, 587.33, 783.99].forEach((f, i) => this.tone(o, t + i * 0.05, { freq: f, a: 0.02, d: 1.2, gain: 0.08 })); break;
      case 'ab-phase': this.noise(o, t, { type: 'bandpass', freq: 600, Q: 0.6, a: 0.01, d: 0.4, gain: 0.3, sweep: 4000 }); break;
      case 'ab-mend': [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(o, t + i * 0.12, { freq: f, type: 'triangle', a: 0.05, d: 1.5, gain: 0.05 })); break;
      case 'ab-repel': this.tone(o, t, { freq: 55, a: 0.2, d: 1.8, gain: 0.45, vib: 0.06, vibRate: 5 }); this.tone(o, t, { freq: 58.3, a: 0.2, d: 1.8, gain: 0.3 }); break;
      // ---- the warden
      case 'boss-roar':
        this.tone(o, t, { freq: 75, type: 'sawtooth', a: 0.15, s: 1.2, d: 0.9, gain: 0.5, lp: 600, vib: 0.1, vibRate: 19, glide: 55 });
        this.noise(o, t, { buf: this.brown, type: 'lowpass', freq: 500, a: 0.15, s: 1.2, d: 0.8, gain: 0.6, am: 23 });
        this.tone(o, t, { freq: 310, type: 'sawtooth', a: 0.2, s: 0.8, d: 0.6, gain: 0.08, lp: 1400, glide: 220 });
        break;
      case 'boss-slam':
        this.tone(o, t, { freq: 48, a: 0.004, d: 1.2, gain: 0.8, glide: 28 });
        this.noise(o, t, { buf: this.brown, type: 'lowpass', freq: 400, a: 0.004, d: 1.0, gain: 0.8 });
        this.noise(o, t + 0.05, { buf: this.white, type: 'bandpass', freq: 900, Q: 0.6, a: 0.02, d: 0.9, gain: 0.3, sweep: 300 });
        break;
      case 'boss-volley': this.tone(o, t, { freq: 180, a: 0.05, d: 0.5, gain: 0.25, glide: 520 }); this.noise(o, t, { type: 'bandpass', freq: 1200, Q: 2, a: 0.05, d: 0.4, gain: 0.15, sweep: 3000 }); break;
      case 'boss-fall':
        this.tone(o, t, { freq: 60, type: 'sawtooth', a: 0.2, s: 1.5, d: 3, gain: 0.4, lp: 500, glide: 30 });
        this.noise(o, t + 1.2, { buf: this.brown, type: 'lowpass', freq: 300, a: 0.02, d: 2.5, gain: 0.9 });
        for (const [m, g] of [[1, 0.1], [2.01, 0.05], [3.02, 0.03]]) this.tone(this.uiBus, t + 2.4, { freq: 392 * m, a: 0.01, d: 5, gain: g });
        break;
      case 'click': this.tone(this.uiBus, t, { freq: 900, type: 'triangle', d: 0.05, gain: 0.05 }); break;
      case 'tick': this.tone(this.uiBus, t, { freq: 1500, type: 'triangle', d: 0.025, gain: 0.025 }); break;
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
    this.watchdog(dt);
    if (!this.ready) return;
    // bad input (a NaN from anywhere) must not reach the audio graph
    for (const k of ['enclosed', 'altitude', 'water', 'river', 'fall', 'city', 'chasm', 'beam', 'boss']) if (!fin(e[k])) e[k] = 0;
    if (!fin(e.layer)) e.layer = 0;
    const ctx = this.ctx, t = ctx.currentTime;
    // listener
    const L = ctx.listener;
    const p = camera.position;
    const f = camera.getWorldDirection(this._fwd || (this._fwd = p.clone()));
    // never straight up or down: a forward parallel to "up" has no defined right
    if (Math.abs(f.y) > 0.97) { const h = Math.hypot(f.x, f.z) || 1; const k = Math.sqrt(1 - 0.97 * 0.97); f.set(f.x / h * k, Math.sign(f.y) * 0.97, f.z / h * k); if (!fin(f.x)) f.set(0, Math.sign(f.y) * 0.97, -k); }
    if (!fin(p.x) || !fin(p.y) || !fin(p.z) || !fin(f.x) || !fin(f.y) || !fin(f.z)) return;
    if (L.positionX) {
      L.positionX.setTargetAtTime(p.x, t, 0.02); L.positionY.setTargetAtTime(p.y, t, 0.02); L.positionZ.setTargetAtTime(p.z, t, 0.02);
      L.forwardX.setTargetAtTime(f.x, t, 0.02); L.forwardY.setTargetAtTime(f.y, t, 0.02); L.forwardZ.setTargetAtTime(f.z, t, 0.02);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
    const B = this.beds;
    const layer = e.layer;
    const open = 1 - e.enclosed;
    // wind: strongest on the surface and when hanging over the void
    const chasm = e.chasm || 0;
    // the Great Fault breathes: an updraft howls along its walls
    let wind = Math.min(0.6, LAYER_WIND[Math.min(LAYER_WIND.length - 1, layer)] * open + clamp(e.altitude / 60, 0, 1) * 0.3 * open + chasm * 0.12);
    wind *= 0.75 + 0.25 * Math.sin(t * 0.13) * Math.sin(t * 0.071 + 1);
    const gust = Math.max(0, Math.sin(t * 0.23) * Math.sin(t * 0.37 + 2) - 0.3) * wind * 0.8;
    B.wind.g.gain.setTargetAtTime(wind * 0.5, t, 0.5);
    B.wind.f.frequency.setTargetAtTime(260 + wind * 300 + gust * 400, t, 0.5);
    B.gust.g.gain.setTargetAtTime(gust * 0.08, t, 0.4);
    B.water.g.gain.setTargetAtTime(e.water * 0.05, t, 0.4);
    B.river.g.gain.setTargetAtTime(e.river * 0.16, t, 0.4);
    B.fall.g.gain.setTargetAtTime(e.fall * 0.5, t, 0.6);
    B.fall.f.frequency.setTargetAtTime(400 + e.fall * 500, t, 0.6);
    B.howl.g.gain.setTargetAtTime(chasm * 0.025 * (0.6 + 0.4 * Math.sin(t * 0.09)), t, 1.2);
    B.howl.f.frequency.setTargetAtTime(170 + 60 * Math.sin(t * 0.05) + wind * 80, t, 1.5);
    // a quiet room tone everywhere: the world is never dead silent
    B.cave.g.gain.setTargetAtTime(0.008 + e.enclosed * 0.08 + (layer === 3 ? 0.03 : layer >= 4 ? 0.02 : 0), t, 0.8);
    B.hum.g.gain.setTargetAtTime((layer >= 2 ? 0.01 : 0) + (layer === 3 ? 0.012 : 0) + e.enclosed * 0.006, t, 1.0);
    B.shimmer.g.gain.setTargetAtTime(layer >= 4 ? 0.018 * (1 - e.enclosed * 0.5) : 0, t, 2);
    // reverb character: tight in caves, vast in the chasm and the lower layers' open halls
    const big = clamp(Math.max(chasm, layer >= 2 ? open * 0.55 : 0), 0, 1);
    this.caveSend = e.enclosed * (1 - chasm * 0.6);
    this.bigSend = big;
    this.echoAmt = chasm;
    this.sfxSend.gain.setTargetAtTime(0.08 + e.enclosed * 0.5 * (1 - chasm * 0.6) + (layer >= 2 ? 0.1 : 0), t, 0.5);
    this.sfxSendBig.gain.setTargetAtTime(big * 0.22, t, 0.6);
    this.musicSendBig.gain.setTargetAtTime(big * 0.4, t, 1.5);
    this.echoIn.gain.setTargetAtTime(chasm * 0.3, t, 0.6);
    // grapple winch
    this.motor.g.gain.setTargetAtTime(e.reeling ? 0.05 : e.paying ? 0.025 : 0, t, 0.05);
    this.motor.o.frequency.setTargetAtTime(e.reeling ? 95 : 60, t, 0.1);
    // the gamma ray
    const bh = this.beamHum;
    bh.g.gain.setTargetAtTime(e.beam ? 0.045 : 0, t, e.beam ? 0.03 : 0.12);
    if (e.beam) bh.f.frequency.setTargetAtTime(700 + Math.random() * 900, t, 0.02);
    this.bossOn = e.boss > 0;
    // a fight with the warden has a heartbeat of drums under the music
    if (this.bossOn) {
      this.drumT = (this.drumT ?? 0) - dt;
      if (this.drumT <= 0) {
        this.drumT = 0.74;
        this.drumN = ((this.drumN || 0) + 1) % 8;
        const accent = this.drumN % 4 === 0;
        this.tone(this.music, t, { freq: accent ? 62 : 55, a: 0.004, d: accent ? 0.7 : 0.4, gain: accent ? 0.5 : 0.3, glide: 38 });
        this.noise(this.music, t, { buf: this.brown, type: 'lowpass', freq: 260, a: 0.004, d: 0.25, gain: accent ? 0.35 : 0.2 });
        if (this.drumN === 6) this.noise(this.music, t + 0.37, { type: 'bandpass', freq: 1800, Q: 1, a: 0.002, d: 0.08, gain: 0.12 });
      }
    }
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
    if (layer === 3 && Math.random() < 0.22) {
      // the fault groans
      const o = this.out(around(60, -20), this.amb, 20);
      this.tone(o, t, { freq: 38 + Math.random() * 10, a: 1.5, s: 1, d: 3, gain: 0.25 });
      this.noise(o, t, { buf: this.brown, type: 'lowpass', freq: 120, a: 1.5, s: 1, d: 3, gain: 0.2 });
    }
    if (layer === 3 && (e.chasm || 0) > 0.3 && Math.random() < 0.3) {
      // scree slipping somewhere on the far wall: a rush of gravel and a few knocks
      const o = this.out(around(90 + Math.random() * 90, (Math.random() - 0.5) * 120), this.amb, 40);
      this.noise(o, t, { buf: this.pink, type: 'bandpass', freq: 900 + Math.random() * 700, Q: 0.7, a: 0.2, s: 0.6 + Math.random(), d: 1.2, gain: 0.12 });
      for (let i = 0, n = 3 + Math.floor(Math.random() * 6); i < n; i++) this.noise(o, t + 0.2 + Math.random() * 1.6, { freq: 600 + Math.random() * 900, Q: 3, a: 0.002, d: 0.08, gain: 0.18 });
    }
    if (layer === 3 && (e.chasm || 0) > 0.3 && Math.random() < 0.25) {
      // wings beating somewhere out in the tube
      const o = this.out(around(30 + Math.random() * 60, (Math.random() - 0.5) * 40), this.amb, 10);
      for (let i = 0, n = 3 + Math.floor(Math.random() * 4); i < n; i++) this.noise(o, t + i * 0.16, { type: 'lowpass', freq: 600, a: 0.02, d: 0.08, gain: 0.08 });
    }
    if (layer >= 4 && Math.random() < 0.5) {
      // glassy chimes of the Lantern Sea and the slow lap of dark water
      const o = this.out(around(20 + Math.random() * 60, Math.random() * 20), this.amb, 12);
      const f = [987.77, 1174.66, 1318.51, 1567.98, 1975.53][Math.floor(Math.random() * 5)];
      for (const [m, g] of [[1, 0.035], [2.01, 0.012], [3.03, 0.006]]) this.tone(o, t, { freq: f * m, a: 0.004, d: 2.6, gain: g });
      if (Math.random() < 0.5) this.noise(this.out(around(8 + Math.random() * 20, -2), this.amb, 6), t, { buf: this.brown, type: 'lowpass', freq: 380, a: 0.5, s: 0.3, d: 1.1, gain: 0.08 });
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
    const layer = Math.min(LAYER_MUSIC.length - 1, e.layer);
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
      // a short breath between phrases (long silences sounded like the sound had died)
      this.resting = true;
      this.nextChord = t + 8 + Math.random() * 10;
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
    const types = { warm: ['triangle', 'sine'], airy: ['sine', 'triangle'], glass: ['sine', 'sine'], dark: ['sawtooth', 'sine'], choir: ['triangle', 'triangle'] }[M.pad];
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
    if (M.lead === 'chime') {
      for (const [m, g] of [[1, 0.045], [2.01, 0.02], [4.1, 0.008]]) this.tone(this.music, t, { freq: freq * 2 * m, a: 0.002, d: 4.5, gain: g });
    } else if (M.lead === 'bell') {
      for (const [m, g] of [[1, 0.06], [2.76, 0.025], [5.4, 0.012]]) this.tone(this.music, t, { freq: freq * m, a: 0.003, d: 3.2, gain: g });
    } else {
      this.tone(this.music, t, { freq, type: 'triangle', a: 0.004, d: 1.6, gain: 0.07, lp: 2200 });
      this.tone(this.music, t, { freq: freq * 2, a: 0.004, d: 0.5, gain: 0.015 });
    }
  }
}

export { lerp };
