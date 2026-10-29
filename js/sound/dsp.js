// Offline sound synthesis: plain JavaScript that writes samples into
// Float32Arrays. Nothing here touches the Web Audio API, so it runs in the
// baking worker (see bakeWorker.js) as well as on the main thread.
// Building blocks: seeded noise, oscillators, filters, envelopes, a small
// baked reverb, loop crossfades and normalisation.

export const SR = 24000;             // baking sample rate (the browser resamples on playback)
export const TAU = Math.PI * 2;

/** Seeded random numbers (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const buf = (sec) => new Float32Array(Math.max(1, Math.round(sec * SR)));
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** White, pink or brown noise. */
export function noise(n, kind = 'white', r = rng(1)) {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    if (kind === 'white') out[i] = w;
    else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22; }
    else { last = (last + 0.02 * w) / 1.02; out[i] = last * 3.5; }
  }
  return out;
}

/**
 * Biquad filter (RBJ cookbook) in place. type: lowpass | highpass | bandpass | peak.
 * freq may be a number or a function of the time in seconds (a sweep).
 */
export function biquad(x, type, freq, Q = 0.707, gainDb = 0) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let b0, b1, b2, a1, a2;
  const set = (f) => {
    const w = TAU * clamp(f, 10, SR * 0.45) / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Q);
    let B0, B1, B2, A0, A1, A2;
    if (type === 'lowpass') { B0 = (1 - c) / 2; B1 = 1 - c; B2 = (1 - c) / 2; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; }
    else if (type === 'highpass') { B0 = (1 + c) / 2; B1 = -(1 + c); B2 = (1 + c) / 2; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; }
    else if (type === 'bandpass') { B0 = al; B1 = 0; B2 = -al; A0 = 1 + al; A1 = -2 * c; A2 = 1 - al; }
    else { const A = Math.pow(10, gainDb / 40); B0 = 1 + al * A; B1 = -2 * c; B2 = 1 - al * A; A0 = 1 + al / A; A1 = -2 * c; A2 = 1 - al / A; }
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
  };
  const sweep = typeof freq === 'function';
  if (!sweep) set(freq);
  for (let i = 0; i < x.length; i++) {
    if (sweep && (i & 31) === 0) set(freq(i / SR));
    const v = x[i];
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

/** One-pole lowpass in place (cheap smoothing). */
export function lowpass1(x, freq) {
  const k = 1 - Math.exp(-TAU * freq / SR);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += (x[i] - y) * k; x[i] = y; }
  return x;
}

/** Attack / hold / exponential decay envelope multiplied in place, starting at sample `at`. */
export function env(x, a, hold, decay, at = 0) {
  const A = Math.max(1, Math.round(a * SR)), H = Math.round(hold * SR), D = Math.max(1, Math.round(decay * SR));
  for (let i = 0; i < x.length; i++) {
    const j = i - at;
    let g;
    if (j < 0) g = 0;
    else if (j < A) g = j / A;
    else if (j < A + H) g = 1;
    else g = Math.exp(-((j - A - H) / D) * 5);
    x[i] *= g;
  }
  return x;
}

/**
 * Add an oscillator into `out`: freq in Hz (number or function of time),
 * shape sine | tri | saw | square, gain, start and length in seconds,
 * a / decay envelope, vibrato depth (fraction) and rate.
 */
export function osc(out, { freq = 440, shape = 'sine', gain = 0.5, start = 0, len = 0.5, a = 0.005, hold = 0, decay = 0.2, vib = 0, vibRate = 5, phase = 0 }) {
  const s0 = Math.round(start * SR), n = Math.min(out.length - s0, Math.round(len * SR));
  if (n <= 0) return out;
  const A = Math.max(1, a * SR), H = hold * SR, D = Math.max(1, decay * SR);
  let ph = phase;
  const fn = typeof freq === 'function';
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let f = fn ? freq(t) : freq;
    if (vib) f *= 1 + vib * Math.sin(TAU * vibRate * t);
    ph += f / SR;
    ph -= Math.floor(ph);
    let v;
    if (shape === 'sine') v = Math.sin(TAU * ph);
    else if (shape === 'tri') v = 1 - 4 * Math.abs(ph - 0.5);
    else if (shape === 'saw') v = 2 * ph - 1;
    else v = ph < 0.5 ? 1 : -1;
    const g = i < A ? i / A : i < A + H ? 1 : Math.exp(-((i - A - H) / D) * 5);
    out[s0 + i] += v * g * gain;
  }
  return out;
}

/** Add `src` into `dst` at a time offset with a gain. */
export function mix(dst, src, gain = 1, start = 0) {
  const s0 = Math.round(start * SR);
  for (let i = 0; i < src.length && s0 + i < dst.length; i++) if (s0 + i >= 0) dst[s0 + i] += src[i] * gain;
  return dst;
}

/** Filtered noise burst added into out (a hit, a breath, a splash, a rustle). */
export function burst(out, { kind = 'white', type = 'bandpass', freq = 1000, Q = 1, gain = 0.5, start = 0, len = 0.2, a = 0.003, hold = 0, decay = 0.1, seed = 1 }) {
  const n = Math.round(len * SR);
  if (n <= 0) return out;
  const x = noise(n, kind, rng(seed));
  if (type) biquad(x, type, freq, Q);
  env(x, a, hold, decay);
  return mix(out, x, gain, start);
}

/** Scale to a peak level. */
export function normalize(x, peak = 0.8) {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  if (m > 1e-6) { const k = peak / m; for (let i = 0; i < x.length; i++) x[i] *= k; }
  return x;
}

/** Fade the ends (avoids clicks). */
export function fade(x, fin = 0.004, fout = 0.02) {
  const a = Math.round(fin * SR), b = Math.round(fout * SR);
  for (let i = 0; i < a && i < x.length; i++) x[i] *= i / a;
  for (let i = 0; i < b && i < x.length; i++) x[x.length - 1 - i] *= i / b;
  return x;
}

/** Make a seamless loop: the last `cross` seconds are blended into the start, then cut off. */
export function loopify(x, cross = 0.5) {
  const c = Math.round(cross * SR);
  const n = x.length - c;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i];
  for (let i = 0; i < c; i++) { const t = i / c; out[i] = x[n + i] * (1 - t) + x[i] * t; }
  return out;
}

/** Slow random modulation curve (0..1) with `n` samples, changing about `rate` times a second. */
export function wobble(n, rate, r) {
  const out = new Float32Array(n);
  const step = Math.max(1, Math.round(SR / rate));
  let a = r(), b = r();
  for (let i = 0; i < n; i++) {
    const k = (i % step) / step;
    if (i % step === 0 && i) { a = b; b = r(); }
    const s = k * k * (3 - 2 * k);
    out[i] = a + (b - a) * s;
  }
  return out;
}

/**
 * A small Schroeder reverb baked into the sound (no reverb runs while playing):
 * four combs and two allpasses; size scales the delays, mix the wet part.
 */
export function reverb(x, { size = 1, decay = 0.8, mix: wet = 0.3, tail = 1.5, damp = 0.3 } = {}) {
  const n = x.length + Math.round(tail * SR);
  const dry = new Float32Array(n); dry.set(x);
  const out = new Float32Array(n);
  for (const [d0, g0] of [[1116, 0.84], [1188, 0.83], [1277, 0.82], [1356, 0.81]]) {
    const d = Math.max(8, Math.round(d0 * size * SR / 44100));
    const line = new Float32Array(d);
    let p = 0, lp = 0;
    const g = g0 * decay;
    for (let i = 0; i < n; i++) {
      const y = line[p];
      lp = y * (1 - damp) + lp * damp;
      line[p] = dry[i] + lp * g;
      p = (p + 1) % d;
      out[i] += y * 0.25;
    }
  }
  for (const d0 of [556, 441]) {
    const d = Math.max(4, Math.round(d0 * size * SR / 44100));
    const line = new Float32Array(d);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const b = line[p], v = out[i];
      const y = -v * 0.5 + b;
      line[p] = v + b * 0.5;
      p = (p + 1) % d;
      out[i] = y;
    }
  }
  for (let i = 0; i < n; i++) out[i] = dry[i] * (1 - wet * 0.5) + out[i] * wet;
  return out;
}

/** Soft saturation (warmth, and keeps peaks round). */
export function saturate(x, drive = 1.5) {
  const k = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / k;
  return x;
}

/** Equal-tempered frequency of a MIDI note. */
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
