// What every sound is made of. Each recipe renders one sound into samples
// (see dsp.js): interface blips, footsteps by ground, the grappling arm,
// combat, the warden, ambience loops, music instruments and creature calls.
// A recipe returns { data, loop } where data is a Float32Array (mono) or a
// pair of them (stereo).
import { SR, rng, buf, noise, biquad, lowpass1, env, osc, mix, burst, normalize, fade, loopify, wobble, reverb, saturate, mtof, TAU } from './dsp.js';

const one = (data, peak = 0.8) => ({ data: fade(normalize(data, peak)) });
const loop = (data, peak = 0.5) => ({ data: Array.isArray(data) ? data.map((d) => normalize(d, peak)) : normalize(data, peak), loop: true });

/** A stereo loop from a mono generator run twice with different seeds. */
function stereo(make, sec, cross = 0.6) { return [loopify(make(1, sec + cross), cross), loopify(make(2, sec + cross), cross)]; }

// ------------------------------------------------------------------ footsteps
function step(kind, v) {
  const x = buf(0.22);
  const s = 11 + v * 7;
  const thump = (f, g) => osc(x, { freq: (t) => f * (1 - t * 2), gain: g, len: 0.12, a: 0.002, decay: 0.05 });
  switch (kind) {
    case 'grass': burst(x, { kind: 'pink', type: 'highpass', freq: 1700 + v * 300, gain: 0.7, len: 0.16, a: 0.01, decay: 0.07, seed: s }); thump(90, 0.25); break;
    case 'dirt': burst(x, { type: 'bandpass', freq: 520 + v * 80, Q: 0.8, gain: 0.8, len: 0.12, decay: 0.05, seed: s }); thump(85, 0.4); break;
    case 'sand': burst(x, { type: 'lowpass', freq: 1300, gain: 0.8, len: 0.18, a: 0.02, decay: 0.08, seed: s }); thump(70, 0.2); break;
    case 'gravel': for (let i = 0; i < 6; i++) burst(x, { type: 'bandpass', freq: 2200 + ((v * 7 + i * 13) % 10) * 260, Q: 3, gain: 0.5, start: i * 0.011 + v * 0.003, len: 0.05, decay: 0.012, seed: s + i }); thump(95, 0.35); break;
    case 'wood': osc(x, { freq: 185 + v * 15, gain: 0.7, len: 0.12, decay: 0.05 }); burst(x, { type: 'bandpass', freq: 900, Q: 2, gain: 0.3, len: 0.06, decay: 0.02, seed: s }); break;
    case 'metal': osc(x, { freq: 610 + v * 30, gain: 0.35, len: 0.2, decay: 0.08 }); osc(x, { freq: 1530 + v * 60, gain: 0.2, len: 0.15, decay: 0.05 }); thump(110, 0.3); break;
    case 'mud': burst(x, { type: 'lowpass', freq: (t) => 650 - t * 2500, gain: 0.8, len: 0.2, a: 0.01, decay: 0.09, seed: s }); break;
    case 'wet': burst(x, { type: 'bandpass', freq: (t) => 1100 - t * 3500, Q: 0.7, gain: 0.8, len: 0.22, a: 0.005, decay: 0.1, seed: s }); osc(x, { freq: (t) => 500 + t * 2500, gain: 0.08, start: 0.05, len: 0.05, decay: 0.03 }); break;
    default: burst(x, { type: 'bandpass', freq: 2300 + v * 200, Q: 1.5, gain: 0.6, len: 0.07, decay: 0.022, seed: s }); thump(140, 0.45); break;
  }
  return one(x, 0.7);
}

// ------------------------------------------------------------------ interface and the explorer
const UI = {
  click() { const x = buf(0.06); osc(x, { freq: 900, shape: 'tri', gain: 0.6, len: 0.05, decay: 0.02 }); return one(x, 0.5); },
  tick() { const x = buf(0.04); osc(x, { freq: 1500, shape: 'tri', gain: 0.5, len: 0.03, decay: 0.012 }); return one(x, 0.35); },
  open() { const x = buf(0.3); burst(x, { type: 'bandpass', freq: (t) => 1800 - t * 4000, Q: 0.6, gain: 1, len: 0.28, a: 0.02, decay: 0.1 }); return one(x, 0.4); },
  pickup() { const x = buf(1.3); [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => osc(x, { freq: f, gain: 0.3, start: i * 0.08, len: 1, decay: 0.45 })); return one(reverb(x, { mix: 0.25 }), 0.6); },
  species() { const x = buf(1.1); [659.25, 880, 987.77].forEach((f, i) => osc(x, { freq: f, shape: 'tri', gain: 0.3, start: i * 0.12, len: 0.8, decay: 0.3 })); return one(reverb(x, { mix: 0.25 }), 0.5); },
  fact() { const x = buf(0.5); osc(x, { freq: 1318.5, shape: 'tri', gain: 0.4, len: 0.45, decay: 0.15 }); return one(x, 0.3); },
  discover() { const x = buf(2.2); osc(x, { freq: 440, gain: 0.4, len: 2, a: 0.01, decay: 0.7 }); osc(x, { freq: 659.25, gain: 0.35, start: 0.2, len: 1.8, a: 0.01, decay: 0.7 }); return one(reverb(x, { mix: 0.3, tail: 1 }), 0.5); },
  layer() {
    const x = buf(6.5);
    osc(x, { freq: 55, gain: 0.6, len: 6.4, a: 0.4, hold: 1, decay: 2 });
    osc(x, { freq: 82.4, gain: 0.3, len: 6, a: 1.2, hold: 0.5, decay: 2 });
    for (const [m, g] of [[1, 0.25], [2.76, 0.1], [5.4, 0.05]]) osc(x, { freq: 220 * m, gain: g, start: 0.2, len: 5.5, decay: 1.6 });
    return one(x, 0.6);
  },
  respawn() { const x = buf(1.6); osc(x, { freq: 392, gain: 0.3, len: 1.4, a: 0.05, decay: 0.5 }); osc(x, { freq: 523.25, gain: 0.3, start: 0.18, len: 1.3, a: 0.05, decay: 0.5 }); return one(x, 0.4); },
  wield() { const x = buf(0.35); burst(x, { type: 'highpass', freq: 4000, gain: 0.5, len: 0.3, a: 0.01, decay: 0.12 }); osc(x, { freq: 520, shape: 'tri', gain: 0.4, len: 0.15, decay: 0.05 }); return one(x, 0.45); },
  test() { const x = buf(1.6); [523.25, 659.25, 783.99].forEach((f, i) => osc(x, { freq: f, gain: 0.35, start: i * 0.15, len: 1.3, decay: 0.5 })); return one(reverb(x, { mix: 0.2 }), 0.7); },
  lamp() { const x = buf(0.04); osc(x, { freq: 1400, shape: 'square', gain: 0.25, len: 0.03, decay: 0.01 }); return one(lowpass1(x, 3000), 0.3); },
  jump() { const x = buf(0.2); burst(x, { kind: 'pink', type: 'bandpass', freq: 700, Q: 0.6, gain: 1, len: 0.18, a: 0.02, decay: 0.07 }); return one(x, 0.45); },
  'land-soft'() { const x = buf(0.3); osc(x, { freq: (t) => 75 - t * 60, gain: 0.7, len: 0.25, decay: 0.1 }); burst(x, { type: 'lowpass', freq: 1200, gain: 0.5, len: 0.15, decay: 0.06 }); return one(x, 0.6); },
  'land-hard'() { const x = buf(0.5); osc(x, { freq: (t) => 70 - t * 50, gain: 0.9, len: 0.4, decay: 0.16 }); burst(x, { kind: 'brown', type: 'lowpass', freq: 900, gain: 0.8, len: 0.3, decay: 0.12 }); burst(x, { type: 'bandpass', freq: 2000, Q: 1, gain: 0.3, len: 0.1, decay: 0.04, seed: 3 }); return one(saturate(x, 1.4), 0.8); },
  hurt() { const x = buf(0.4); osc(x, { freq: (t) => 95 - t * 80, gain: 0.8, len: 0.35, decay: 0.14 }); burst(x, { type: 'lowpass', freq: 500, gain: 0.6, len: 0.25, decay: 0.1 }); return one(saturate(x, 1.5), 0.8); },
  death() { const x = buf(3); osc(x, { freq: (t) => 60 - t * 10, gain: 0.7, len: 2.8, a: 0.05, decay: 1 }); burst(x, { kind: 'brown', type: 'lowpass', freq: 300, gain: 0.8, len: 2.5, a: 0.1, decay: 0.8 }); return one(x, 0.8); },
  splash() {
    const x = buf(0.8);
    burst(x, { type: 'bandpass', freq: (t) => 1300 - t * 1400, Q: 0.6, gain: 1, len: 0.7, a: 0.005, decay: 0.25 });
    const r = rng(9);
    for (let i = 0; i < 7; i++) osc(x, { freq: (t) => 400 + r() * 500 + t * 3000, gain: 0.12, start: 0.08 + r() * 0.4, len: 0.05, decay: 0.02 });
    return one(x, 0.7);
  },
  mantle() { const x = buf(0.35); burst(x, { kind: 'pink', type: 'lowpass', freq: 700, gain: 1, len: 0.3, a: 0.05, decay: 0.12 }); return one(x, 0.4); },
  grab() { const x = buf(0.15); burst(x, { type: 'bandpass', freq: 1600, Q: 1, gain: 1, len: 0.12, decay: 0.04 }); return one(x, 0.35); },
  ability() { const x = buf(1); osc(x, { freq: (t) => 300 + t * 900, gain: 0.5, len: 0.9, a: 0.05, decay: 0.35 }); burst(x, { type: 'highpass', freq: 2000, gain: 0.3, len: 0.7, a: 0.05, decay: 0.25 }); return one(reverb(x, { mix: 0.3 }), 0.6); },
};

// ------------------------------------------------------------------ the grappling arm
const ARM = {
  'grapple-fire'() { const x = buf(0.4); burst(x, { type: 'bandpass', freq: (t) => 3000 - t * 5000, Q: 0.7, gain: 0.8, len: 0.38, a: 0.005, decay: 0.15 }); osc(x, { freq: 180, shape: 'square', gain: 0.3, len: 0.06, decay: 0.02 }); return one(x, 0.6); },
  'grapple-attach'() { const x = buf(0.4); osc(x, { freq: 740, gain: 0.5, len: 0.35, decay: 0.12 }); osc(x, { freq: 1850, gain: 0.25, len: 0.2, decay: 0.07 }); burst(x, { type: 'bandpass', freq: 2500, Q: 2, gain: 0.6, len: 0.07, decay: 0.02 }); return one(x, 0.6); },
  'grapple-miss'() { const x = buf(0.3); burst(x, { type: 'bandpass', freq: (t) => 1200 - t * 2000, gain: 1, len: 0.25, decay: 0.1 }); return one(x, 0.3); },
  'grapple-release'() { const x = buf(0.35); osc(x, { freq: 420, shape: 'square', gain: 0.3, len: 0.05, decay: 0.015 }); burst(x, { type: 'highpass', freq: (t) => 2000 + t * 9000, gain: 0.5, len: 0.3, decay: 0.12 }); return one(lowpass1(x, 6000), 0.4); },
  'grapple-stow'() { const x = buf(0.2); osc(x, { freq: 300, shape: 'square', gain: 0.3, len: 0.05, decay: 0.015 }); osc(x, { freq: 520, shape: 'square', gain: 0.25, start: 0.06, len: 0.05, decay: 0.015 }); return one(lowpass1(x, 2500), 0.35); },
  pullup() { return UI.mantle(); },
};

// ------------------------------------------------------------------ combat and abilities
const FIGHT = {
  swing() { const x = buf(0.25); burst(x, { type: 'bandpass', freq: (t) => 1900 - t * 5000, Q: 0.9, gain: 1, len: 0.22, a: 0.03, decay: 0.08 }); return one(x, 0.55); },
  'swing-heavy'() { const x = buf(0.4); burst(x, { kind: 'pink', type: 'bandpass', freq: (t) => 950 - t * 1800, Q: 0.7, gain: 1, len: 0.36, a: 0.06, decay: 0.13 }); osc(x, { freq: (t) => 120 - t * 120, gain: 0.3, len: 0.3, a: 0.04, decay: 0.12 }); return one(x, 0.6); },
  hit() { const x = buf(0.25); burst(x, { type: 'lowpass', freq: 1400, gain: 0.9, len: 0.15, decay: 0.05 }); osc(x, { freq: (t) => 160 - t * 400, gain: 0.7, len: 0.16, decay: 0.06 }); return one(saturate(x, 1.6), 0.75); },
  'hit-heavy'() { const x = buf(0.45); burst(x, { kind: 'brown', type: 'lowpass', freq: 800, gain: 1, len: 0.35, decay: 0.13 }); osc(x, { freq: (t) => 95 - t * 100, gain: 0.8, len: 0.4, decay: 0.15 }); return one(saturate(x, 1.8), 0.85); },
  kill() { const x = buf(0.7); osc(x, { freq: (t) => 220 - t * 220, gain: 0.6, len: 0.6, decay: 0.22 }); burst(x, { type: 'lowpass', freq: (t) => 900 - t * 1000, gain: 0.7, len: 0.6, a: 0.01, decay: 0.2 }); return one(x, 0.7); },
  bolt() { const x = buf(0.3); osc(x, { freq: (t) => 900 - t * 2000, shape: 'square', gain: 0.25, len: 0.12, decay: 0.04 }); burst(x, { type: 'highpass', freq: (t) => 2500 + t * 15000, gain: 0.6, len: 0.25, decay: 0.09 }); return one(lowpass1(x, 7000), 0.55); },
  shard() { const x = buf(0.25); for (let i = 0; i < 4; i++) burst(x, { type: 'bandpass', freq: 3000 + i * 900, Q: 3, gain: 0.5, start: i * 0.015, len: 0.15, decay: 0.05, seed: 20 + i }); return one(x, 0.5); },
  impact() { const x = buf(0.15); burst(x, { type: 'bandpass', freq: 1400, Q: 1.2, gain: 1, len: 0.12, decay: 0.035 }); return one(x, 0.45); },
  overheat() { const x = buf(1.2); burst(x, { type: 'highpass', freq: 3000, gain: 0.6, len: 1.1, a: 0.01, hold: 0.3, decay: 0.3 }); osc(x, { freq: (t) => 1200 - t * 600, shape: 'tri', gain: 0.3, len: 0.6, decay: 0.2 }); return one(x, 0.5); },
  'shield-hit'() { const x = buf(0.5); osc(x, { freq: 640, shape: 'tri', gain: 0.5, len: 0.45, decay: 0.15 }); osc(x, { freq: 1730, gain: 0.25, len: 0.3, decay: 0.1 }); return one(x, 0.5); },
  'shield-break'() { const x = buf(0.8); const r = rng(5); for (let i = 0; i < 8; i++) osc(x, { freq: 1400 + r() * 2200, gain: 0.25, start: i * 0.03, len: 0.4, decay: 0.12 }); burst(x, { type: 'highpass', freq: 3000, gain: 0.4, len: 0.3, decay: 0.1 }); return one(x, 0.6); },
  orb() { const x = buf(0.6); burst(x, { kind: 'pink', type: 'lowpass', freq: (t) => 1800 - t * 2500, gain: 1, len: 0.5, a: 0.005, decay: 0.18 }); osc(x, { freq: (t) => 330 - t * 350, gain: 0.4, len: 0.5, decay: 0.18 }); return one(x, 0.7); },
  bite() { const x = buf(0.2); burst(x, { type: 'bandpass', freq: 2200, Q: 1.5, gain: 0.8, len: 0.07, decay: 0.02 }); burst(x, { type: 'lowpass', freq: 800, gain: 0.7, start: 0.05, len: 0.12, decay: 0.04, seed: 2 }); return one(x, 0.65); },
  'ab-gamma'() {
    const x = buf(3.2);
    osc(x, { freq: 110, shape: 'saw', gain: 0.35, len: 3.1, a: 0.08, hold: 2.5, decay: 0.15, vib: 0.02, vibRate: 31 });
    osc(x, { freq: 880, gain: 0.15, len: 3.1, a: 0.08, hold: 2.5, decay: 0.15, vib: 0.01, vibRate: 7 });
    burst(x, { type: 'highpass', freq: 3500, gain: 0.25, len: 3.1, a: 0.08, hold: 2.5, decay: 0.15 });
    return one(lowpass1(x, 5000), 0.6);
  },
  'ab-shockwave'() { const x = buf(1.2); osc(x, { freq: (t) => 70 - t * 35, gain: 0.9, len: 1, decay: 0.35 }); burst(x, { kind: 'brown', type: 'lowpass', freq: (t) => 700 - t * 500, gain: 0.9, len: 1, decay: 0.3 }); return one(saturate(x, 1.5), 0.85); },
  'ab-thornburst'() { const x = buf(0.9); for (let i = 0; i < 8; i++) { burst(x, { type: 'bandpass', freq: 2600 + i * 250, Q: 4, gain: 0.4, start: i * 0.04, len: 0.2, decay: 0.06, seed: 40 + i }); osc(x, { freq: 1800 + i * 160, gain: 0.08, start: i * 0.04, len: 0.4, decay: 0.15 }); } return one(x, 0.6); },
  'ab-stasis'() { const x = buf(1.6); osc(x, { freq: (t) => 1900 - t * 700, gain: 0.3, len: 1.5, a: 0.01, decay: 0.5 }); burst(x, { type: 'highpass', freq: 5000, gain: 0.3, len: 1.2, a: 0.01, decay: 0.4 }); return one(reverb(x, { mix: 0.3 }), 0.5); },
  'ab-aegis'() { const x = buf(1.6); [392, 587.33, 783.99].forEach((f, i) => osc(x, { freq: f, gain: 0.3, start: i * 0.05, len: 1.4, a: 0.03, decay: 0.45 })); return one(reverb(x, { mix: 0.3 }), 0.5); },
  'ab-phase'() { const x = buf(0.5); burst(x, { type: 'bandpass', freq: (t) => 600 + t * 9000, Q: 0.6, gain: 1, len: 0.45, a: 0.01, decay: 0.15 }); return one(x, 0.6); },
  'ab-mend'() { const x = buf(2); [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => osc(x, { freq: f, shape: 'tri', gain: 0.2, start: i * 0.12, len: 1.6, a: 0.06, decay: 0.5 })); return one(reverb(x, { mix: 0.3 }), 0.5); },
  'ab-repel'() { const x = buf(2.2); osc(x, { freq: 55, gain: 0.7, len: 2.1, a: 0.2, decay: 0.6, vib: 0.06, vibRate: 5 }); osc(x, { freq: 58.3, gain: 0.5, len: 2.1, a: 0.2, decay: 0.6 }); return one(x, 0.7); },
  'boss-roar'() {
    const x = buf(2.6);
    osc(x, { freq: (t) => 78 - t * 10, shape: 'saw', gain: 0.6, len: 2.5, a: 0.15, hold: 1.2, decay: 0.3, vib: 0.08, vibRate: 19 });
    osc(x, { freq: (t) => 310 - t * 50, shape: 'saw', gain: 0.12, len: 2, a: 0.2, hold: 0.8, decay: 0.25 });
    burst(x, { kind: 'brown', type: 'lowpass', freq: 600, gain: 0.7, len: 2.4, a: 0.15, hold: 1.2, decay: 0.3 });
    lowpass1(x, 1200);
    return one(saturate(reverb(x, { size: 1.6, mix: 0.25, tail: 1.2 }), 1.8), 0.9);
  },
  'boss-slam'() { const x = buf(1.6); osc(x, { freq: (t) => 48 - t * 15, gain: 1, len: 1.4, a: 0.003, decay: 0.45 }); burst(x, { kind: 'brown', type: 'lowpass', freq: 420, gain: 1, len: 1.2, a: 0.003, decay: 0.4 }); burst(x, { type: 'bandpass', freq: (t) => 900 - t * 600, Q: 0.6, gain: 0.4, start: 0.05, len: 1, decay: 0.3, seed: 4 }); return one(saturate(x, 2), 0.95); },
  'boss-volley'() { const x = buf(0.7); osc(x, { freq: (t) => 180 + t * 600, gain: 0.5, len: 0.6, a: 0.05, decay: 0.2 }); burst(x, { type: 'bandpass', freq: (t) => 1200 + t * 3000, Q: 2, gain: 0.4, len: 0.5, a: 0.05, decay: 0.16 }); return one(x, 0.65); },
  'boss-fall'() {
    const x = buf(6);
    osc(x, { freq: (t) => 60 - t * 8, shape: 'saw', gain: 0.4, len: 3, a: 0.2, hold: 1, decay: 0.8 });
    burst(x, { kind: 'brown', type: 'lowpass', freq: 300, gain: 1, start: 1.2, len: 2.5, a: 0.02, decay: 0.8 });
    for (const [m, g] of [[1, 0.2], [2.01, 0.1], [3.02, 0.06]]) osc(x, { freq: 392 * m, gain: g, start: 2.4, len: 3.5, decay: 1.2 });
    return one(lowpass1(x, 3000), 0.85);
  },
};

// ------------------------------------------------------------------ occasional sounds of the world
const WORLD = {
  drip(v) { const x = buf(0.5); const f = 1300 + v * 500; osc(x, { freq: (t) => f + t * f * 12, gain: 0.6, len: 0.06, a: 0.001, decay: 0.03 }); return one(reverb(x, { size: 1.2, mix: 0.5, tail: 0.6 }), 0.4); },
  groan() { const x = buf(4); osc(x, { freq: 40, gain: 0.6, len: 4, a: 1.2, hold: 0.8, decay: 1.2 }); burst(x, { kind: 'brown', type: 'lowpass', freq: 130, gain: 0.8, len: 4, a: 1.2, hold: 0.8, decay: 1.2 }); return one(x, 0.6); },
  scree() { const x = buf(2.2); burst(x, { kind: 'pink', type: 'bandpass', freq: 1100, Q: 0.7, gain: 0.6, len: 2, a: 0.2, hold: 0.6, decay: 0.6 }); const r = rng(7); for (let i = 0; i < 8; i++) burst(x, { type: 'bandpass', freq: 600 + r() * 900, Q: 3, gain: 0.5, start: 0.2 + r() * 1.5, len: 0.1, decay: 0.03, seed: 50 + i }); return one(x, 0.5); },
  wings() { const x = buf(1); for (let i = 0; i < 5; i++) burst(x, { type: 'lowpass', freq: 650, gain: 0.7, start: i * 0.16, len: 0.12, a: 0.02, decay: 0.04, seed: 60 + i }); return one(x, 0.45); },
  bird(v) {
    const x = buf(0.8);
    const r = rng(70 + v), base = 2200 + r() * 2400, n = 2 + Math.floor(r() * 5);
    let t = 0;
    for (let i = 0; i < n; i++) { const f = base * (0.9 + r() * 0.3); osc(x, { freq: (tt) => f + tt * f * 6, gain: 0.4, start: t, len: 0.07, a: 0.004, decay: 0.03 }); t += 0.08 + r() * 0.05; }
    return one(x, 0.35);
  },
  cricket(v) { const x = buf(1); const f = 4200 + v * 700; osc(x, { freq: f, gain: 0.4, len: 0.6 + v * 0.2, a: 0.02, hold: 0.4, decay: 0.05 }); const am = new Float32Array(x.length); for (let i = 0; i < x.length; i++) am[i] = 0.5 + 0.5 * Math.sin(TAU * (32 + v * 10) * i / SR); for (let i = 0; i < x.length; i++) x[i] *= am[i]; return one(x, 0.25); },
  'bell-tower'() { const x = buf(4); for (const [m, g] of [[1, 0.3], [2.4, 0.15], [3.9, 0.08], [5.2, 0.04]]) osc(x, { freq: 196 * m, gain: g, len: 3.9, decay: 1.2 }); return one(reverb(x, { size: 1.5, mix: 0.3 }), 0.4); },
  creak() { const x = buf(1); osc(x, { freq: (t) => 150 - t * 30, shape: 'saw', gain: 0.4, len: 0.9, a: 0.2, decay: 0.2, vib: 0.05, vibRate: 13 }); return one(lowpass1(x, 700), 0.25); },
  'hollow-call'() { const x = buf(2); osc(x, { freq: (t) => 380 - t * 90, gain: 0.5, len: 1.8, a: 0.2, hold: 0.3, decay: 0.4 }); return one(reverb(x, { size: 1.8, mix: 0.45, tail: 1.5 }), 0.4); },
  glass(v) { const x = buf(3); const f = [987.77, 1174.66, 1318.51, 1567.98, 1975.53][v % 5]; for (const [m, g] of [[1, 0.35], [2.01, 0.12], [3.03, 0.06]]) osc(x, { freq: f * m, gain: g, len: 2.9, a: 0.004, decay: 0.9 }); return one(reverb(x, { size: 1.4, mix: 0.4, tail: 1 }), 0.3); },
};

// ------------------------------------------------------------------ ambience loops
const AMB = {
  'amb-wind'() {
    return loop(stereo((seed, sec) => {
      const n = Math.round(sec * SR), r = rng(100 + seed);
      const x = noise(n, 'brown', r), w = wobble(n, 0.35, r);
      biquad(x, 'bandpass', (t) => 260 + 260 * w[Math.min(n - 1, Math.round(t * SR))], 0.7);
      for (let i = 0; i < n; i++) x[i] *= 0.45 + 0.55 * w[i];
      return x;
    }, 9), 0.6);
  },
  'amb-gust'() { return loop(stereo((seed, sec) => { const n = Math.round(sec * SR), r = rng(110 + seed); const x = noise(n, 'pink', r), w = wobble(n, 0.5, r); biquad(x, 'highpass', 2200, 0.5); for (let i = 0; i < n; i++) x[i] *= Math.max(0, w[i] - 0.35) * 1.6; return x; }, 7), 0.5); },
  'amb-water'() { return loop(stereo((seed, sec) => { const n = Math.round(sec * SR), r = rng(120 + seed); const x = noise(n, 'pink', r), w = wobble(n, 1.2, r); biquad(x, 'bandpass', 700, 0.8); for (let i = 0; i < n; i++) x[i] *= 0.3 + 0.7 * w[i] * w[i]; return x; }, 7), 0.5); },
  'amb-river'() { return loop(stereo((seed, sec) => { const n = Math.round(sec * SR), r = rng(130 + seed); const x = noise(n, 'pink', r); biquad(x, 'lowpass', 1500, 0.5); const y = noise(n, 'white', r); biquad(y, 'bandpass', 2800, 1.5); const w = wobble(n, 3, r); for (let i = 0; i < n; i++) x[i] += y[i] * 0.25 * w[i]; return x; }, 6), 0.55); },
  'amb-fall'() { return loop(stereo((seed, sec) => { const n = Math.round(sec * SR), r = rng(140 + seed); const x = noise(n, 'brown', r); biquad(x, 'lowpass', 520, 0.5); const y = noise(n, 'pink', r); biquad(y, 'bandpass', 1500, 0.6); for (let i = 0; i < n; i++) x[i] = x[i] * 0.8 + y[i] * 0.5; return x; }, 6), 0.7); },
  'amb-cave'() { return loop(stereo((seed, sec) => { const n = Math.round(sec * SR), r = rng(150 + seed); const x = noise(n, 'brown', r); biquad(x, 'lowpass', 170, 0.7); const w = wobble(n, 0.2, r); for (let i = 0; i < n; i++) x[i] *= 0.6 + 0.4 * w[i]; return x; }, 9), 0.5); },
  'amb-hum'() { const x = buf(8.6); for (const [f, g] of [[55, 0.5], [55.7, 0.4], [82.4, 0.25], [110.3, 0.08]]) osc(x, { freq: f, gain: g, len: 8.6, a: 0.01, hold: 8.6, decay: 1 }); return loop(loopify(x, 0.6), 0.5); },
  'amb-howl'() { return loop(stereo((seed, sec) => { const n = Math.round(sec * SR), r = rng(160 + seed); const x = noise(n, 'pink', r), w = wobble(n, 0.15, r); biquad(x, 'bandpass', (t) => 160 + 90 * w[Math.min(n - 1, Math.round(t * SR))], 9); for (let i = 0; i < n; i++) x[i] *= 0.5 + 0.5 * w[i]; return x; }, 10), 0.5); },
  'amb-drizzle'() {
    return loop(stereo((seed, sec) => {
      const n = Math.round(sec * SR), r = rng(170 + seed);
      const x = noise(n, 'white', r); biquad(x, 'highpass', 3500, 0.5); for (let i = 0; i < n; i++) x[i] *= 0.25;
      for (let k = 0; k < sec * 40; k++) burst(x, { type: 'bandpass', freq: 2500 + r() * 4000, Q: 4, gain: 0.25 + r() * 0.4, start: r() * (sec - 0.05), len: 0.03, decay: 0.008, seed: 1000 + k + seed * 977 });
      return x;
    }, 6), 0.45);
  },
  'amb-night'() {
    return loop(stereo((seed, sec) => {
      const n = Math.round(sec * SR), r = rng(180 + seed), x = new Float32Array(n);
      for (let k = 0; k < 5; k++) { const f = 3800 + r() * 1500, rate = 25 + r() * 25, t0 = r() * (sec - 1.5), len = 0.4 + r() * 1; for (let i = Math.round(t0 * SR); i < Math.min(n, Math.round((t0 + len) * SR)); i++) { const t = i / SR - t0; x[i] += Math.sin(TAU * f * t) * (0.5 + 0.5 * Math.sin(TAU * rate * t)) * Math.min(1, t * 20, (len - t) * 20) * 0.3; } }
      return x;
    }, 6), 0.35);
  },
  'amb-city'() { return loop(stereo((seed, sec) => { const n = Math.round(sec * SR), r = rng(190 + seed); const x = noise(n, 'pink', r), w = wobble(n, 2, r); biquad(x, 'bandpass', 420, 0.9); for (let i = 0; i < n; i++) x[i] *= 0.5 + 0.5 * w[i]; for (let k = 0; k < 3; k++) burst(x, { type: 'bandpass', freq: 1800 + r() * 2000, Q: 6, gain: 0.3, start: r() * (sec - 0.2), len: 0.12, decay: 0.04, seed: 2000 + k + seed * 31 }); return x; }, 8), 0.4); },
  'amb-shimmer'() { return loop(stereo((seed, sec) => { const n = Math.round(sec * SR), r = rng(200 + seed); const x = noise(n, 'white', r), w = wobble(n, 0.4, r); biquad(x, 'bandpass', 5200, 6); for (let i = 0; i < n; i++) x[i] *= w[i]; return x; }, 7), 0.4); },
  motor() { const x = buf(1); osc(x, { freq: 80, shape: 'saw', gain: 0.5, len: 1, a: 0.001, hold: 1, decay: 1 }); osc(x, { freq: 160, shape: 'saw', gain: 0.15, len: 1, a: 0.001, hold: 1, decay: 1 }); lowpass1(x, 600); return loop(x, 0.5); },
  beam() {
    const x = buf(2.6);
    osc(x, { freq: 110, shape: 'saw', gain: 0.4, len: 2.6, a: 0.001, hold: 3, decay: 1 });
    osc(x, { freq: 220.6, shape: 'square', gain: 0.15, len: 2.6, a: 0.001, hold: 3, decay: 1 });
    osc(x, { freq: 880, gain: 0.12, len: 2.6, a: 0.001, hold: 3, decay: 1, vib: 0.01, vibRate: 7 });
    const c = noise(x.length, 'white', rng(210)); biquad(c, 'bandpass', 3000, 1);
    const w = wobble(x.length, 25, rng(211));
    for (let i = 0; i < x.length; i++) x[i] += c[i] * 0.3 * w[i];
    biquad(x, 'bandpass', 900, 0.6);
    return loop(loopify(x, 0.4), 0.6);
  },
};

// ------------------------------------------------------------------ music instruments (one note each, transposed when played)
export const INSTRUMENT_BASE = { pad: 48, glass: 60, choir: 48, bell: 72, pluck: 60, chime: 84 };
const MUS = {
  'mus-pad'() { const x = buf(9); const f = mtof(48); for (const [k, d] of [[1, -0.004], [1, 0.005], [2, 0.002]]) osc(x, { freq: f * k * (1 + d), shape: 'tri', gain: k === 1 ? 0.35 : 0.1, len: 9, a: 2.5, hold: 2.5, decay: 3.5 }); return one(lowpass1(x, 1500), 0.45); },
  'mus-glass'() { const x = buf(9); const f = mtof(60); for (const [m, g] of [[1, 0.35], [2, 0.12], [3.01, 0.05]]) osc(x, { freq: f * m, gain: g, len: 9, a: 2, hold: 2.5, decay: 3.5, vib: 0.003, vibRate: 4 }); return one(x, 0.4); },
  'mus-choir'() { const x = buf(9); const f = mtof(48); for (const d of [-0.006, 0, 0.007]) osc(x, { freq: f * (1 + d), shape: 'saw', gain: 0.2, len: 9, a: 2.5, hold: 2.5, decay: 3.5, vib: 0.006, vibRate: 5 }); biquad(x, 'bandpass', 700, 1.2); biquad(x, 'peak', 1200, 2, 6); return one(x, 0.4); },
  'mus-bell'() { const x = buf(4); const f = mtof(72); for (const [m, g] of [[1, 0.35], [2.76, 0.12], [5.4, 0.05]]) osc(x, { freq: f * m, gain: g, len: 4, a: 0.003, decay: 1.2 }); return one(x, 0.45); },
  'mus-pluck'() {
    // Karplus-Strong
    const f = mtof(60), n = Math.round(1.8 * SR), x = new Float32Array(n), d = Math.round(SR / f), r = rng(300);
    const line = new Float32Array(d); for (let i = 0; i < d; i++) line[i] = r() * 2 - 1;
    let p = 0;
    for (let i = 0; i < n; i++) { const a = line[p], b = line[(p + 1) % d]; const v = (a + b) * 0.5 * 0.996; line[p] = v; x[i] = a; p = (p + 1) % d; }
    return one(lowpass1(x, 2600), 0.45);
  },
  'mus-chime'() { const x = buf(4.5); const f = mtof(84); for (const [m, g] of [[1, 0.3], [2.01, 0.1], [4.1, 0.04]]) osc(x, { freq: f * m, gain: g, len: 4.5, a: 0.002, decay: 1.4 }); return one(x, 0.4); },
  'mus-drum'() { const x = buf(0.9); osc(x, { freq: (t) => 62 - t * 30, gain: 0.9, len: 0.85, a: 0.003, decay: 0.3 }); burst(x, { kind: 'brown', type: 'lowpass', freq: 260, gain: 0.6, len: 0.3, decay: 0.1 }); return one(saturate(x, 1.4), 0.8); },
  'mus-drum-hi'() { const x = buf(0.2); burst(x, { type: 'bandpass', freq: 1800, Q: 1, gain: 1, len: 0.15, decay: 0.03 }); return one(x, 0.4); },
};

// ------------------------------------------------------------------ creature calls (one per species, from its genome)
export function creatureCall({ type, pitch, rhythm, length }, seed = 1) {
  const p = Math.max(60, Math.min(4200, pitch)), n = Math.max(1, rhythm), L = Math.max(0.1, Math.min(1, length));
  const x = buf(Math.min(2.6, 0.3 + L * 1.8 + n * 0.2));
  const r = rng(seed);
  switch (type) {
    case 'growl': osc(x, { freq: (t) => p * 0.4 - t * p * 0.1, shape: 'saw', gain: 0.6, len: L + 0.3, a: 0.08, hold: L * 0.6, decay: 0.15, vib: 0.08, vibRate: 23 }); burst(x, { kind: 'brown', type: 'lowpass', freq: 420, gain: 0.5, len: L + 0.3, a: 0.08, hold: L * 0.6, decay: 0.12 }); lowpass1(x, 600); break;
    case 'bleat': for (let i = 0; i < Math.max(1, n - 1); i++) osc(x, { freq: (t) => p * (1 - t * 0.2), shape: 'square', gain: 0.35, start: i * (L * 0.7 + 0.1), len: L * 0.7, a: 0.03, hold: L * 0.4, decay: 0.08, vib: 0.04, vibRate: 7 }); lowpass1(x, p * 3); break;
    case 'hoot': for (let i = 0; i < n; i++) osc(x, { freq: (t) => p * 0.55 * (1 - t * 0.25), gain: 0.6, start: i * (0.35 + L * 0.4), len: L * 0.5 + 0.2, a: 0.04, hold: L * 0.2, decay: 0.12 }); break;
    case 'bark': for (let i = 0; i < n; i++) { burst(x, { type: 'bandpass', freq: p * 1.2, Q: 3, gain: 0.6, start: i * 0.22, len: 0.12, decay: 0.04, seed: seed + i }); osc(x, { freq: (t) => p * 0.7 * (1 - t * 3), shape: 'saw', gain: 0.35, start: i * 0.22, len: 0.12, decay: 0.04 }); } lowpass1(x, 1600); break;
    case 'whistle': osc(x, { freq: (t) => p * 1.5 * (1 + t / Math.max(0.1, L) * 0.4), gain: 0.5, len: L * 0.6 + 0.1, a: 0.04, hold: L * 0.3, decay: 0.08 }); if (n > 2) osc(x, { freq: (t) => p * 2 * (1 - t * 0.5), gain: 0.35, start: L * 0.7, len: L * 0.4 + 0.1, a: 0.04, decay: 0.08 }); break;
    case 'hiss': burst(x, { type: 'highpass', freq: 3200, gain: 0.6, len: L + 0.3, a: 0.05, hold: L * 0.7, decay: 0.12 }); break;
    case 'croak': for (let i = 0; i < n; i++) osc(x, { freq: p * 0.35, shape: 'square', gain: 0.4, start: i * (L * 0.6 + 0.1), len: L * 0.5 + 0.05, a: 0.02, hold: L * 0.3, decay: 0.05, vib: 0.3, vibRate: 30 }); lowpass1(x, 800); break;
    case 'rattle': for (let i = 0; i < Math.floor(L * 28); i++) burst(x, { type: 'bandpass', freq: 3000 + r() * 2000, Q: 4, gain: 0.5, start: i / 28, len: 0.03, decay: 0.008, seed: seed + i }); break;
    case 'chirp': for (let i = 0; i < n + 1; i++) osc(x, { freq: (t) => p * (1 + t * 14), gain: 0.4, start: i * 0.11, len: 0.07, a: 0.004, decay: 0.03 }); break;
    case 'trill': osc(x, { freq: p * 1.2, gain: 0.4, len: L + 0.1, a: 0.02, hold: L * 0.8, decay: 0.05, vib: 0.12, vibRate: 22 + n * 3 }); break;
    case 'caw': for (let i = 0; i < n; i++) osc(x, { freq: (t) => p * 0.8 * (1 - t * 0.8), shape: 'saw', gain: 0.4, start: i * (L * 0.5 + 0.15), len: L * 0.4 + 0.1, a: 0.02, hold: L * 0.2, decay: 0.07 }); lowpass1(x, 1700); break;
    case 'click': for (let i = 0; i < n * 3; i++) burst(x, { type: 'bandpass', freq: p * 2 + 1500, Q: 6, gain: 0.6, start: i * 0.06 + r() * 0.02, len: 0.03, decay: 0.008, seed: seed + i }); break;
    case 'buzz': osc(x, { freq: p * 0.3, shape: 'saw', gain: 0.35, len: L + 0.2, a: 0.05, hold: L * 0.8, decay: 0.07, vib: 0.03, vibRate: 9 }); lowpass1(x, 2400); break;
    case 'chirr': { burst(x, { type: 'bandpass', freq: Math.min(7000, p * 2), Q: 5, gain: 0.6, len: L + 0.15, a: 0.03, hold: L * 0.8, decay: 0.05 }); for (let i = 0; i < x.length; i++) x[i] *= 0.5 + 0.5 * Math.sin(TAU * 40 * i / SR); break; }
    case 'grind': { burst(x, { kind: 'brown', type: 'bandpass', freq: 260, Q: 1.2, gain: 1, len: L * 1.3 + 0.4, a: 0.1, hold: L, decay: 0.15 }); for (let i = 0; i < x.length; i++) x[i] *= 0.5 + 0.5 * Math.sin(TAU * 11 * i / SR); break; }
    case 'rumble': osc(x, { freq: 46, gain: 0.7, len: L * 1.5 + 0.8, a: 0.2, hold: L, decay: 0.3 }); burst(x, { kind: 'brown', type: 'lowpass', freq: 140, gain: 0.7, len: L * 1.5 + 0.8, a: 0.2, hold: L, decay: 0.3 }); break;
    case 'squeak': for (let i = 0; i < n; i++) osc(x, { freq: (t) => Math.min(6000, p * 2.2) * (1 + t * 9), gain: 0.35, start: i * 0.07, len: 0.04, a: 0.003, decay: 0.015 }); break;
    case 'chitter': for (let i = 0; i < n * 2 + 2; i++) osc(x, { freq: p * (1.4 + r() * 0.3), shape: 'square', gain: 0.25, start: i * 0.045 + r() * 0.01, len: 0.03, a: 0.002, decay: 0.01 }); lowpass1(x, 4000); break;
    case 'scream': osc(x, { freq: (t) => p * 1.1 * (1 - t * 0.3), shape: 'saw', gain: 0.45, len: L * 0.6 + 0.3, a: 0.02, hold: L * 0.4, decay: 0.1, vib: 0.06, vibRate: 11 }); burst(x, { type: 'bandpass', freq: p * 2, Q: 2, gain: 0.25, len: L * 0.5 + 0.2, a: 0.02, hold: L * 0.3, decay: 0.08 }); lowpass1(x, 3200); break;
    case 'chime': for (let i = 0; i < n; i++) for (const [m, g] of [[1, 1], [2.76, 0.5], [5.4, 0.25]]) osc(x, { freq: p * m, gain: 0.3 * g, start: i * 0.28, len: 1.4, a: 0.003, decay: 0.45 }); break;
    case 'peep': for (let i = 0; i < n + 1; i++) osc(x, { freq: (t) => p * 1.6 * (1 + t * 4), gain: 0.4, start: i * (0.16 + L * 0.2), len: 0.1, a: 0.01, decay: 0.03 }); break;
    case 'burble': { osc(x, { freq: p * 0.5, shape: 'tri', gain: 0.45, len: L * 0.8 + 0.25, a: 0.03, hold: L * 0.6, decay: 0.08, vib: 0.25, vibRate: 13 + n * 2 }); burst(x, { type: 'bandpass', freq: p * 1.2, Q: 4, gain: 0.18, len: L * 0.8 + 0.2, a: 0.03, hold: L * 0.6, decay: 0.07 }); lowpass1(x, 1400); break; }
    case 'hum': osc(x, { freq: p * 0.4, gain: 0.5, len: L * 2 + 0.6, a: L * 0.5 + 0.05, hold: L, decay: 0.25, vib: 0.02, vibRate: 4 }); osc(x, { freq: p * 0.8 * 1.005, gain: 0.18, len: L * 2 + 0.6, a: L * 0.5 + 0.05, hold: L, decay: 0.25 }); break;
    case 'coo': for (let i = 0; i < Math.min(3, n); i++) osc(x, { freq: (t) => p * 0.6 * (1 - t * 0.3), gain: 0.5, start: i * (0.42 + L * 0.3), len: L * 0.3 + 0.25, a: 0.06, hold: L * 0.2, decay: 0.09 }); lowpass1(x, 1200); break;
    default: osc(x, { freq: p, gain: 0.4, len: L, decay: L * 0.3 });
  }
  return one(x, 0.7);
}

const STEP_KINDS = ['grass', 'dirt', 'sand', 'gravel', 'wood', 'metal', 'mud', 'wet', 'stone'];

/** Every named sound the game can ask for: name -> () => { data, loop }. */
export const RECIPES = (() => {
  const R = { ...UI, ...ARM, ...FIGHT, ...AMB, ...MUS };
  for (const k of STEP_KINDS) for (let v = 0; v < 3; v++) R[`step-${k}-${v}`] = () => step(k, v);
  for (let v = 0; v < 4; v++) { R[`drip-${v}`] = () => WORLD.drip(v); R[`bird-${v}`] = () => WORLD.bird(v); R[`cricket-${v}`] = () => WORLD.cricket(v); R[`glass-${v}`] = () => WORLD.glass(v); }
  for (const k of ['groan', 'scree', 'wings', 'bell-tower', 'creak', 'hollow-call']) R[k] = WORLD[k];
  return R;
})();

/** Bake one job: a named recipe or a creature call. */
export function bake(job) {
  if (job.call) return creatureCall(job.call, job.seed || 1);
  const f = RECIPES[job.name];
  if (!f) throw new Error(`no recipe ${job.name}`);
  return f();
}

export { STEP_KINDS };
void mix; void env;
