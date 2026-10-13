// Phenotype: turns an individual's genes into a concrete anatomy (lengths in
// body units, ornaments, colours, pattern, locomotion stats). The body plan
// fixes the skeleton; every gene moves a proportion or a feature within the
// ranges of its family, so individuals of one species differ in build,
// ornament and colour while staying recognisably the same animal.
import { clamp, lerp, hsl2rgb } from '../core/mathutil.js';
import { G, ALLELES } from './genome.js';

const R = (g, a, b) => a + (b - a) * g;

/** Ranges per body plan for the proportion genes: [min, max] in body lengths. */
const PROP = {
  quadruped: { girth: [0.16, 0.3], height: [0.17, 0.32], neck: [0.12, 0.6], head: [0.18, 0.3], snout: [0.25, 0.75], leg: [0.32, 0.85], legThick: [0.045, 0.1], tail: [0.08, 0.85], tailThick: [0.04, 0.1] },
  biped: { girth: [0.16, 0.27], height: [0.18, 0.3], neck: [0.2, 0.7], head: [0.18, 0.3], snout: [0.3, 0.9], leg: [0.55, 1.1], legThick: [0.05, 0.1], tail: [0.4, 1.3], tailThick: [0.06, 0.12] },
  sprawler: { girth: [0.13, 0.23], height: [0.09, 0.16], neck: [0.08, 0.3], head: [0.15, 0.24], snout: [0.4, 1.0], leg: [0.18, 0.38], legThick: [0.035, 0.07], tail: [0.7, 1.6], tailThick: [0.06, 0.12] },
  serpent: { girth: [0.07, 0.12], height: [0.06, 0.11], neck: [0.0, 0.1], head: [0.11, 0.17], snout: [0.4, 0.9], leg: [0, 0], legThick: [0, 0], tail: [2.2, 3.6], tailThick: [0.05, 0.09] },
  avian: { girth: [0.18, 0.28], height: [0.2, 0.3], neck: [0.15, 0.6], head: [0.17, 0.25], snout: [0.25, 0.9], leg: [0.3, 0.8], legThick: [0.022, 0.045], tail: [0.25, 0.9], tailThick: [0.06, 0.1] },
  bat: { girth: [0.16, 0.24], height: [0.16, 0.24], neck: [0.04, 0.12], head: [0.22, 0.32], snout: [0.15, 0.6], leg: [0.22, 0.34], legThick: [0.025, 0.04], tail: [0.05, 0.4], tailThick: [0.025, 0.05] },
  glider: { girth: [0.14, 0.22], height: [0.1, 0.16], neck: [0.08, 0.25], head: [0.16, 0.24], snout: [0.3, 0.8], leg: [0.28, 0.45], legThick: [0.035, 0.06], tail: [0.6, 1.3], tailThick: [0.05, 0.09] },
  insect: { girth: [0.16, 0.26], height: [0.1, 0.18], neck: [0.02, 0.08], head: [0.18, 0.26], snout: [0.05, 0.2], leg: [0.35, 0.8], legThick: [0.018, 0.035], tail: [0, 0], tailThick: [0, 0] },
  spider: { girth: [0.2, 0.32], height: [0.14, 0.24], neck: [0.0, 0.04], head: [0.2, 0.28], snout: [0.05, 0.15], leg: [0.55, 1.3], legThick: [0.018, 0.035], tail: [0, 0], tailThick: [0, 0] },
  centipede: { girth: [0.08, 0.12], height: [0.05, 0.08], neck: [0.0, 0.03], head: [0.1, 0.14], snout: [0.05, 0.12], leg: [0.12, 0.22], legThick: [0.012, 0.02], tail: [0, 0], tailThick: [0, 0] },
  golem: { girth: [0.26, 0.4], height: [0.26, 0.4], neck: [0.0, 0.12], head: [0.18, 0.28], snout: [0.1, 0.35], leg: [0.25, 0.5], legThick: [0.08, 0.15], tail: [0.1, 0.6], tailThick: [0.08, 0.14] },
  roller: { girth: [0.4, 0.5], height: [0.4, 0.5], neck: [0, 0], head: [0.2, 0.26], snout: [0.05, 0.15], leg: [0, 0], legThick: [0, 0], tail: [0, 0], tailThick: [0, 0] },
};

function rgbOf(h, s, l) { return hsl2rgb(((h % 1) + 1) % 1, clamp(s, 0, 1), clamp(l, 0.04, 0.95)); }

export function phenotype(sp, genes) {
  const c = genes.c, a = genes.a;
  const plan = sp.plan, fam = sp.family;
  const P = PROP[plan];
  const juvenile = false;
  // overall body length (m): the species size with individual deviation
  const scale = sp.size * (0.82 + 0.36 * c[G.size]);
  const ph = {
    plan, family: fam, covering: sp.covering, scale, juvenile,
    body: {
      len: 1,
      girth: R(c[G.girth], P.girth[0], P.girth[1]),
      height: R(c[G.height], P.height[0], P.height[1]),
      hump: fam === 'mammal' && c[G.plates] > 0.75 ? (c[G.plates] - 0.75) * 0.6 : 0,
      segs: plan === 'centipede' ? sp.legPairs : plan === 'serpent' ? 3 : 4,
    },
    neck: { len: R(c[G.neckLen], P.neck[0], P.neck[1]), thick: R(c[G.neckThick], 0.45, 0.85) },
    head: { size: R(c[G.headSize], P.head[0], P.head[1]), snout: R(c[G.snout], P.snout[0], P.snout[1]), jaw: R(c[G.jaw], 0.3, 1), beak: fam === 'bird' },
    eyes: { count: a.eyes || 2, size: R(c[G.eyeSize], 0.07, 0.2), glow: (c[G.glow] > 0.6 || (sp.layer === 'layer3' && c[G.eyeSize] > 0.7)) ? c[G.glow] : 0 },
    ears: { shape: fam === 'mammal' ? a.ears : 'none', size: R(c[G.earSize], 0.1, plan === 'bat' ? 0.75 : 0.5) },
    horns: { type: a.horns, len: R(c[G.hornLen], 0.08, plan === 'quadruped' && fam === 'mammal' ? 0.55 : 0.32), curve: R(c[G.hornCurve], -1, 1) },
    crest: { type: a.crest, size: R(c[G.crestSize], 0.05, 0.42) },
    spikes: { rows: a.spikeRows ?? 0, count: Math.round(R(c[G.spikeCount], 4, 14)), len: R(c[G.spikeLen], 0.03, 0.2) },
    cheek: a.cheek || 'none',
    whisker: fam === 'mammal' ? c[G.whisker] : 0,
    frill: c[G.frill] > 0.8 && fam === 'reptile' ? R(c[G.frill], 0.1, 0.35) : 0,
    plates: fam === 'lithosere' ? R(c[G.plates], 0.4, 1) : fam === 'reptile' ? c[G.plates] * 0.4 : 0,
    shag: fam === 'mammal' ? c[G.shag] : 0,
    tail: {
      len: R(c[G.tailLen], P.tail[0], P.tail[1]), thick: R(c[G.tailThick], P.tailThick[0], P.tailThick[1]),
      tip: a.tailTip, segs: plan === 'serpent' ? 10 : 5,
    },
    legs: {
      pairs: sp.legPairs, len: R(c[G.legLen], P.leg[0], P.leg[1]), thick: R(c[G.legThick], P.legThick[0], P.legThick[1]),
      foot: R(c[G.footSize], 0.6, 1.5), posture: plan === 'quadruped' && fam === 'mammal' && c[G.legLen] > 0.55 ? 'digitigrade' : plan === 'golem' ? 'erect' : (planPosture[plan] || 'erect'),
      biped: plan === 'biped' || plan === 'avian',
    },
    arms: { len: plan === 'biped' ? R(c[G.armLen], 0.12, 0.45) : 0 },
    wings: { type: wingType(plan, fam), span: R(c[G.wingSpan], 1.4, 3.0), chord: R(c[G.wingChord], 0.25, 0.6) },
  };
  if (plan === 'avian' && sp.behavior.locomotion === 'walk') { ph.wings.span *= 0.45; }
  // gliding patagium spans the limbs
  if (plan === 'glider') ph.wings.span = R(c[G.wingSpan], 0.9, 1.6);
  // a long-necked browser
  if (sp.niche === 'browser' && c[G.neckLen] > 0.6) ph.neck.len *= 1.5;
  // colours
  const hue = c[G.hue];
  // secondary colour: analogous most of the time, complementary for species that lean that way
  const comp = sp.genome.mean[G.hue2] > 0.82;
  const hue2 = hue + (comp ? 0.5 : 0) + (c[G.hue2] - 0.5) * 0.36;
  const sat = Math.min(0.78, c[G.sat]), light = c[G.light];
  ph.colors = {
    primary: rgbOf(hue, sat, light),
    secondary: rgbOf(hue2, clamp(sat + (c[G.sat2] - 0.5) * 0.5, 0.03, 1), clamp(light + (c[G.light2] - 0.5) * 0.45, 0.06, 0.9)),
    belly: rgbOf(hue + 0.03, sat * 0.45, clamp(light + 0.12 + c[G.belly] * 0.28, 0.1, 0.92)),
    accent: rgbOf(c[G.accentHue], 0.8, 0.55),
    glow: rgbOf(c[G.accentHue], 0.9, 0.6),
    glowAmt: sp.layer === 'surface' || sp.layer === 'layer1' ? 0 : clamp((c[G.glow] - 0.45) * 2.2, 0, 1),
    eye: c[G.glow] > 0.6 ? rgbOf(c[G.accentHue], 0.9, 0.65) : fam === 'arthropod' ? [0.08, 0.08, 0.08] : rgbOf(c[G.accentHue] * 0.3 + 0.08, 0.7, 0.5),
  };
  ph.pattern = { type: a.pattern, scale: R(c[G.patternScale], 0.6, 2.6), contrast: R(c[G.patternContrast], 0.25, 0.95) };
  // locomotion and senses (metres and m/s)
  const legM = ph.legs.len * scale;
  const agility = c[G.agility], speedG = c[G.speed];
  let walk = clamp(0.45 + legM * 1.4, 0.3, 2.6), run = walk * R(speedG, 2.2, 4.0);
  if (fam === 'lithosere') { walk *= 0.6; run *= 0.55; }
  if (plan === 'sprawler' || plan === 'serpent') run *= 1.15;
  const flier = ph.wings.type === 'feather' || ph.wings.type === 'membrane' || ph.wings.type === 'insect';
  ph.stats = {
    walk, run,
    fly: flier ? clamp(3 + scale * 2.5, 3, 12) * R(speedG, 0.85, 1.35) : 0,
    climb: plan === 'sprawler' || plan === 'glider' || plan === 'spider' || plan === 'insect' || plan === 'centipede' ? R(c[G.footSize], 0.5, 1) : 0,
    agility,
    perception: clamp(10 + scale * 6 + ph.eyes.size * 70 + (ph.ears.size || 0) * 20, 8, 70),
    hearing: ph.ears.size,
    stride: Math.max(0.15, legM * (ph.legs.biped ? 1.4 : 1.1)),
  };
  return ph;
}

const planPosture = { biped: 'digitigrade', avian: 'digitigrade', sprawler: 'sprawl', glider: 'sprawl', bat: 'sprawl', insect: 'arthropod', spider: 'arthropod', centipede: 'arthropod', golem: 'erect' };

function wingType(plan, fam) {
  if (plan === 'avian') return 'feather';
  if (plan === 'bat') return 'membrane';
  if (plan === 'glider') return 'patagium';
  if (plan === 'insect' && fam === 'arthropod') return 'insect';
  return 'none';
}

/** Juveniles: big heads and eyes, short legs, muted ornaments. */
export function juvenilize(ph, t) {
  const k = 1 - t; // 0 adult .. 1 newborn
  ph.head.size *= 1 + 0.45 * k;
  ph.eyes.size *= 1 + 0.5 * k;
  ph.legs.len *= 1 - 0.15 * k;
  ph.horns.len *= 1 - 0.85 * k;
  ph.crest.size *= 1 - 0.7 * k;
  ph.spikes.len *= 1 - 0.7 * k;
  ph.tail.len *= 1 - 0.2 * k;
  ph.juvenile = k > 0.05;
  for (const key of ['primary', 'secondary']) ph.colors[key] = ph.colors[key].map((v, i) => lerp(v, ph.colors.belly[i], 0.25 * k));
  return ph;
}

/** Phenotype of a typical individual of a species (mean genes, commonest alleles). */
export function typicalPhenotype(sp, sub = 0) {
  const S = sp.subspecies[Math.min(sub, sp.subspecies.length - 1)];
  const c = sp.genome.mean.map((m, i) => Math.max(0, Math.min(1, m + (S ? S.offset[i] : 0))));
  const a = {};
  for (const k of Object.keys(ALLELES)) {
    const t = sp.genome.alleles[k].slice().sort((x, y) => y[1] - x[1]);
    a[k] = S && S.bias[k] !== undefined ? S.bias[k] : t[0][0];
  }
  return phenotype(sp, { c, a, sex: 'f', sub });
}
