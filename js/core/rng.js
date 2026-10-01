// Deterministic seeded random number generation and hashing.
// Every procedural system in the game derives its randomness from these
// helpers so that a world seed fully determines the generated world.

function mix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash up to four integers into a well-mixed unsigned 32-bit integer. */
export function hash32(a, b = 0, c = 0, d = 0) {
  let h = mix32((a | 0) ^ 0x9e3779b9);
  h = mix32(h ^ ((b | 0) + 0x85ebca6b));
  h = mix32(h ^ ((c | 0) + 0xc2b2ae35));
  h = mix32(h ^ ((d | 0) + 0x27d4eb2f));
  return h;
}

/** Hash to a float in [0, 1). */
export function hashFloat(a, b = 0, c = 0, d = 0) {
  return hash32(a, b, c, d) / 4294967296;
}

/** Stable string hash (FNV-1a followed by a mix). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h >>> 0);
}

/** Convert a user supplied seed (number or text) into a uint32. */
export function normalizeSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return (Math.floor(Math.abs(seed)) % 4294967296) >>> 0;
  const s = String(seed ?? '').trim();
  if (/^\d+$/.test(s) && s.length < 10) return Number(s) >>> 0;
  return hashString(s || 'abyss');
}

/** Small fast PRNG (sfc32). */
export class RNG {
  constructor(seed) {
    const s = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
    this.seed = s;
    this.a = hash32(s, 1);
    this.b = hash32(s, 2);
    this.c = hash32(s, 3);
    this.d = hash32(s, 4) | 1;
    for (let i = 0; i < 12; i++) this.u32();
  }

  /** Create an independent generator derived from a seed and labels (order independent of usage). */
  static derive(seed, ...labels) {
    let h = seed >>> 0;
    for (const l of labels) h = hash32(h, typeof l === 'number' ? l | 0 : hashString(String(l)));
    return new RNG(h);
  }

  u32() {
    const t = (this.a + this.b | 0) + this.d | 0;
    this.d = this.d + 1 | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = this.c + (this.c << 3) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = this.c + t | 0;
    return t >>> 0;
  }

  next() { return this.u32() / 4294967296; }
  float() { return this.next(); }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }

  /** Pick from [[item, weight], ...] */
  weighted(pairs) {
    let total = 0;
    for (const p of pairs) total += Math.max(0, p[1]);
    if (total <= 0) return pairs[0][0];
    let v = this.next() * total;
    for (const p of pairs) {
      v -= Math.max(0, p[1]);
      if (v <= 0) return p[0];
    }
    return pairs[pairs.length - 1][0];
  }

  gauss(mean = 0, sd = 1) {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
}
