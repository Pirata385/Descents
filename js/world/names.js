// Seeded naming language. Each world gets its own phonology so that place,
// species and artifact names feel consistent within a seed and differ between seeds.
import { RNG } from '../core/rng.js';

const ONSETS = ['b', 'br', 'c', 'd', 'dr', 'f', 'g', 'gr', 'h', 'k', 'kr', 'l', 'm', 'n', 'p', 'pr', 'r', 's', 'st', 'sh', 't', 'th', 'tr', 'v', 'vr', 'z', 'y', 'w', 'ch', 'sk', 'q', 'j'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ei', 'ou', 'ia', 'y', 'au', 'io', 'aa', 'ui'];
const CODAS = ['', 'n', 'r', 'l', 's', 'th', 'm', 'nd', 'rn', 'x', 'k', 'sh', 'lt', 'st', 'rk', 'v'];

export class NameGen {
  constructor(seed) {
    const rng = RNG.derive(seed, 'language');
    this.rng = rng;
    const pickSome = (arr, n) => rng.shuffle(arr.slice()).slice(0, n).map((s) => [s, rng.range(0.3, 1.5)]);
    this.onsets = pickSome(ONSETS, rng.int(12, 20));
    this.onsets.push(['', rng.range(0.2, 0.8)]);
    this.vowels = pickSome(VOWELS, rng.int(5, 9));
    this.codas = pickSome(CODAS, rng.int(5, 10));
    this.codas.push(['', rng.range(1.0, 2.5)]);
    this.endings = rng.shuffle(['a', 'el', 'is', 'on', 'ar', 'eth', 'ia', 'or', 'une', 'ane', 'os', 'ith', 'ra', 'en']).slice(0, 5);
    this.used = new Set();
  }

  syllable(rng) {
    return rng.weighted(this.onsets) + rng.weighted(this.vowels) + rng.weighted(this.codas);
  }

  /** A word from a dedicated rng (deterministic per call site). */
  word(rng, minSyl = 2, maxSyl = 3) {
    let w = '';
    const n = rng.int(minSyl, maxSyl);
    for (let i = 0; i < n; i++) w += this.syllable(rng);
    if (rng.chance(0.35)) w += rng.pick(this.endings);
    w = w.replace(/(.)\1\1+/g, '$1$1');
    if (w.length > 11) w = w.slice(0, 11);
    return w.charAt(0).toUpperCase() + w.slice(1);
  }

  /** Unique proper name derived from labels. */
  name(...labels) {
    const rng = RNG.derive(this.rng.seed, ...labels);
    for (let tries = 0; tries < 8; tries++) {
      const w = this.word(rng);
      if (!this.used.has(w) && w.length >= 3) { this.used.add(w); return w; }
    }
    return this.word(rng) + 'a';
  }

  /** Pseudo-latin binomial for species. */
  binomial(...labels) {
    const rng = RNG.derive(this.rng.seed, 'bin', ...labels);
    const genus = this.word(rng, 2, 3);
    let sp = this.word(rng, 2, 2).toLowerCase();
    sp += rng.pick(['us', 'a', 'is', 'um', 'ensis', 'ii', 'ata', 'oides']);
    return genus + ' ' + sp;
  }
}
