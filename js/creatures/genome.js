// Creature genomes. Species are generated per layer from ecological niches;
// each species is a distribution over a genome rather than a fixed template:
// - continuous genes (0..1): proportions, ornaments, colours, temperament;
//   every species has a mean and a spread, so no two individuals share an anatomy,
// - discrete alleles: ear shape, horns, crest, tail tip, pattern, eye count...;
//   individuals draw them from the species' allele frequencies,
// - subspecies: regional forms with their own gene offsets and allele biases,
//   assigned by where in the world a population lives (depth, sector, tier),
// - inheritance: offspring mix both parents gene by gene, plus mutation.
// Body plans (quadruped, biped, sprawler, serpent, avian, bat, glider, insect,
// spider, centipede, golem, roller) fix the skeleton; genes shape everything else.
// Pure data, no rendering.
import { RNG } from '../core/rng.js';
import { clamp, lerp } from '../core/mathutil.js';
import { LAYERS } from '../world/layers.js';

export const FAMILIES = ['mammal', 'reptile', 'bird', 'arthropod', 'lithosere'];
export const FAMILY_LABEL = { mammal: 'Mammal', reptile: 'Reptilian', bird: 'Bird', arthropod: 'Arthropod', lithosere: 'Lithosere' };

// ------------------------------------------------------------------ genes
export const GENES = [
  'size', 'bodyLen', 'girth', 'height', 'neckLen', 'neckThick', 'headSize', 'snout', 'jaw', 'earSize', 'eyeSize',
  'legLen', 'legThick', 'footSize', 'armLen', 'tailLen', 'tailThick', 'wingSpan', 'wingChord',
  'hornLen', 'hornCurve', 'crestSize', 'spikeLen', 'spikeCount', 'frill', 'plates', 'whisker', 'shag',
  'hue', 'sat', 'light', 'hue2', 'sat2', 'light2', 'belly', 'accentHue', 'patternScale', 'patternContrast', 'glow',
  'boldness', 'curiosity', 'sociality', 'aggression', 'agility', 'speed', 'nocturnal', 'callPitch', 'callRate', 'territory',
];
export const G = Object.fromEntries(GENES.map((n, i) => [n, i]));
export const NG = GENES.length;
// genes that never shift much between individuals (identity of the species)
const STABLE = new Set([G.size, G.hue, G.callPitch]);

export const ALLELES = {
  ears: ['none', 'round', 'pointed', 'long', 'tufted', 'fan'],
  horns: ['none', 'straight', 'curved', 'spiral', 'antler', 'nose', 'crown', 'tusk'],
  crest: ['none', 'sail', 'ridge', 'fin', 'plume', 'fan', 'spikes', 'casque', 'frills'],
  tailTip: ['none', 'tuft', 'club', 'spike', 'fan', 'plume', 'fork', 'stinger'],
  pattern: ['none', 'stripes', 'spots', 'bands', 'mottled', 'gradient', 'saddle', 'ocelli'],
  eyes: [2, 3, 4, 6, 8],
  spikeRows: [0, 1, 2],
  cheek: ['none', 'spikes', 'whiskers', 'dewlap'],
};
const ALLELE_KEYS = Object.keys(ALLELES);

// ------------------------------------------------------------------ body plans
export const PLANS = {
  quadruped: { legs: 2, biped: false, posture: 'erect', families: ['mammal', 'reptile', 'lithosere'] },
  biped: { legs: 1, biped: true, posture: 'digitigrade', families: ['mammal', 'reptile', 'bird'] },
  sprawler: { legs: 2, biped: false, posture: 'sprawl', families: ['reptile'] },
  serpent: { legs: 0, biped: false, posture: 'none', families: ['reptile'] },
  avian: { legs: 1, biped: true, posture: 'digitigrade', wings: 'feather', families: ['bird'] },
  bat: { legs: 1, biped: false, posture: 'sprawl', wings: 'membrane', families: ['mammal'] },
  glider: { legs: 2, biped: false, posture: 'sprawl', wings: 'patagium', families: ['reptile', 'mammal'] },
  insect: { legs: 3, biped: false, posture: 'arthropod', families: ['arthropod'] },
  spider: { legs: 4, biped: false, posture: 'arthropod', families: ['arthropod'] },
  centipede: { legs: 7, biped: false, posture: 'arthropod', families: ['arthropod'] },
  golem: { legs: 2, biped: false, posture: 'erect', families: ['lithosere'] },
  roller: { legs: 0, biped: false, posture: 'none', families: ['lithosere'] },
};

// ------------------------------------------------------------------ niches
// Ecological niches by layer: what a species does, where it lives, which body
// plans can fill it, and how its genes lean. These are the original roles of
// the world's fauna; Layer 3 holds only cave and chasm fauna.
//  habitat: ground | cave | wall (chasm walls) | air | ceiling | shore
//  move: locomotion styles the agent uses
export const NICHES = {
  // surface
  urban_flier: { diet: 'omnivore', size: [0.2, 0.45], plans: { avian: 1 }, social: [['flock', 4]], habitat: 'air', move: 'fly', nest: 'roof' },
  urban_small: { diet: 'omnivore', size: [0.2, 0.55], plans: { quadruped: 4, sprawler: 1 }, social: [['group', 2], ['solitary', 1]], habitat: 'ground', move: 'run' },
  scavenger_flier: { diet: 'scavenger', size: [0.7, 1.5], plans: { avian: 1 }, social: [['solitary', 2], ['group', 2]], habitat: 'air', move: 'soar', nest: 'cliff' },
  pollinator: { diet: 'nectar', size: [0.05, 0.2], plans: { insect: 5, avian: 1 }, social: [['swarm', 3], ['solitary', 1]], habitat: 'air', move: 'hover' },
  // layer 1 and 2
  grazer: { diet: 'grazer', size: [1.3, 3.0], plans: { quadruped: 6, golem: 1 }, social: [['herd', 4], ['group', 2]], habitat: 'ground', move: 'walk' },
  grazer_small: { diet: 'grazer', size: [0.3, 0.85], plans: { quadruped: 4, biped: 2 }, social: [['group', 3], ['colony', 2], ['pair', 1]], habitat: 'ground', move: 'hop' },
  browser: { diet: 'browser', size: [1.0, 2.6], plans: { quadruped: 4, biped: 1 }, social: [['group', 2], ['solitary', 1], ['pair', 1]], habitat: 'ground', move: 'walk', tall: true },
  mesopredator: { diet: 'carnivore', size: [0.6, 1.4], plans: { quadruped: 4, sprawler: 2, biped: 2 }, social: [['solitary', 3], ['pair', 2], ['pack', 2]], habitat: 'ground', move: 'run' },
  apex_predator: { diet: 'carnivore', size: [2.0, 4.2], plans: { quadruped: 3, biped: 3, sprawler: 1 }, social: [['solitary', 3], ['pair', 1.5], ['pack', 1]], habitat: 'ground', move: 'run' },
  insectivore_flier: { diet: 'insectivore', size: [0.14, 0.4], plans: { avian: 5, insect: 1 }, social: [['flock', 4], ['pair', 1]], habitat: 'air', move: 'fly', nest: 'cliff' },
  piscivore: { diet: 'piscivore', size: [0.5, 1.5], plans: { avian: 1 }, social: [['solitary', 2], ['group', 1]], habitat: 'shore', move: 'wade', nest: 'shore' },
  decomposer: { diet: 'detritivore', size: [0.15, 0.7], plans: { insect: 3, centipede: 2, spider: 1 }, social: [['colony', 3], ['solitary', 1]], habitat: 'ground', move: 'crawl' },
  lithophage: { diet: 'lithophage', size: [0.5, 1.5], plans: { golem: 4, roller: 2 }, social: [['group', 2], ['solitary', 2]], habitat: 'ground', move: 'walk' },
  lithophage_large: { diet: 'lithophage', size: [2.6, 5.0], plans: { golem: 1 }, social: [['family', 4], ['solitary', 1]], habitat: 'ground', move: 'walk' },
  cliff_glider: { diet: 'insectivore', size: [0.35, 1.0], plans: { glider: 1 }, social: [['group', 2], ['solitary', 1]], habitat: 'air', move: 'glide', nest: 'cliff' },
  ceiling_crawler: { diet: 'insectivore', size: [0.4, 1.3], plans: { spider: 3, sprawler: 3, centipede: 1 }, social: [['colony', 2], ['solitary', 2]], habitat: 'ceiling', move: 'ceiling' },
  ambush_predator: { diet: 'carnivore', size: [1.0, 2.4], plans: { spider: 2, golem: 2, sprawler: 2 }, social: [['solitary', 4]], habitat: 'ground', move: 'stalk' },
  // layer 3: caves (small lizards and mammals of confined spaces)
  cave_skink: { diet: 'insectivore', size: [0.18, 0.42], plans: { sprawler: 4, serpent: 1 }, social: [['solitary', 2], ['pair', 1]], habitat: 'cave', move: 'scurry', cave: true },
  cave_gecko: { diet: 'lichen', size: [0.15, 0.36], plans: { sprawler: 1 }, social: [['colony', 2], ['group', 1]], habitat: 'cave', move: 'climb', cave: true },
  cave_shrew: { diet: 'insectivore', size: [0.1, 0.28], plans: { quadruped: 1 }, social: [['group', 2], ['colony', 1]], habitat: 'cave', move: 'scurry', cave: true },
  cave_ferret: { diet: 'carnivore', size: [0.45, 0.85], plans: { quadruped: 1 }, social: [['solitary', 3], ['pair', 1]], habitat: 'cave', move: 'run', cave: true },
  // layer 3: the chasm (birds, lizards and flying mammals of the vertical void)
  chasm_swift: { diet: 'insectivore', size: [0.16, 0.34], plans: { avian: 1 }, social: [['flock', 4]], habitat: 'air', move: 'fly', nest: 'wall' },
  chasm_hawk: { diet: 'carnivore', size: [0.6, 1.2], plans: { avian: 1 }, social: [['solitary', 3], ['pair', 2]], habitat: 'air', move: 'soar', nest: 'ledge' },
  chasm_drake: { diet: 'insectivore', size: [0.35, 0.9], plans: { sprawler: 3, glider: 2 }, social: [['group', 2], ['solitary', 1]], habitat: 'wall', move: 'climb', nest: 'ledge' },
  chasm_bat: { diet: 'insectivore', size: [0.12, 0.3], plans: { bat: 1 }, social: [['swarm', 4]], habitat: 'air', move: 'flutter', nest: 'roost' },
  chasm_fox: { diet: 'lichen', size: [0.4, 0.8], plans: { bat: 1 }, social: [['colony', 3], ['group', 1]], habitat: 'air', move: 'fly', nest: 'roost' },
};

const LAYER_NICHES = {
  surface: { niches: ['urban_flier', 'urban_small', 'scavenger_flier', 'pollinator'], n: [4, 5] },
  layer1: { niches: ['grazer', 'grazer_small', 'browser', 'mesopredator', 'apex_predator', 'insectivore_flier', 'scavenger_flier', 'piscivore', 'pollinator', 'decomposer', 'lithophage', 'cliff_glider'], n: [10, 12] },
  layer2: { niches: ['ceiling_crawler', 'grazer', 'browser', 'mesopredator', 'apex_predator', 'insectivore_flier', 'lithophage', 'lithophage_large', 'decomposer', 'cliff_glider', 'ambush_predator', 'scavenger_flier'], n: [10, 12] },
  layer3: { niches: ['cave_skink', 'cave_shrew', 'cave_ferret', 'chasm_swift', 'chasm_drake', 'chasm_bat', 'chasm_hawk', 'cave_gecko', 'chasm_fox'], n: [8, 9] },
};

export const NICHE_LABEL = {
  urban_flier: 'city flier', urban_small: 'city scavenger', scavenger_flier: 'carrion flier', pollinator: 'pollinator',
  grazer: 'grazer', grazer_small: 'small grazer', browser: 'browser', mesopredator: 'hunter', apex_predator: 'apex predator',
  insectivore_flier: 'insect hunter of the air', piscivore: 'fisher', decomposer: 'decomposer', lithophage: 'stone eater',
  lithophage_large: 'great stone eater', cliff_glider: 'cliff glider', ceiling_crawler: 'ceiling crawler', ambush_predator: 'ambush predator',
  cave_skink: 'crevice skink', cave_gecko: 'lichen gecko', cave_shrew: 'cave forager', cave_ferret: 'tunnel hunter',
  chasm_swift: 'wall-nesting swift', chasm_hawk: 'chasm raptor', chasm_drake: 'wall climber', chasm_bat: 'roosting flier', chasm_fox: 'lichen-eating flier',
};

// gene leanings per niche / plan: [gene, mean] pairs override the uniform draw
const LEAN = {
  cave_skink: [['eyeSize', 0.2], ['legLen', 0.25], ['bodyLen', 0.8], ['tailLen', 0.75], ['glow', 0.35], ['light', 0.35], ['agility', 0.8]],
  cave_gecko: [['eyeSize', 0.85], ['footSize', 0.9], ['headSize', 0.7], ['glow', 0.6], ['tailThick', 0.7], ['agility', 0.7]],
  cave_shrew: [['eyeSize', 0.15], ['earSize', 0.9], ['whisker', 0.9], ['snout', 0.85], ['legLen', 0.25], ['shag', 0.7], ['sociality', 0.7]],
  cave_ferret: [['bodyLen', 0.95], ['legLen', 0.25], ['neckLen', 0.6], ['earSize', 0.5], ['whisker', 0.7], ['aggression', 0.8], ['agility', 0.9], ['speed', 0.8]],
  chasm_swift: [['wingSpan', 0.9], ['wingChord', 0.25], ['legLen', 0.12], ['tailLen', 0.6], ['speed', 0.9], ['agility', 0.95], ['sociality', 0.9]],
  chasm_hawk: [['wingSpan', 0.85], ['wingChord', 0.7], ['snout', 0.5], ['eyeSize', 0.75], ['aggression', 0.85], ['boldness', 0.8]],
  chasm_drake: [['footSize', 0.85], ['tailLen', 0.8], ['crestSize', 0.65], ['spikeLen', 0.55], ['agility', 0.75], ['glow', 0.4]],
  chasm_bat: [['wingSpan', 0.8], ['earSize', 0.95], ['eyeSize', 0.25], ['snout', 0.3], ['sociality', 0.95], ['nocturnal', 0.9]],
  chasm_fox: [['wingSpan', 0.75], ['earSize', 0.5], ['eyeSize', 0.75], ['snout', 0.7], ['shag', 0.6], ['sociality', 0.8]],
  apex_predator: [['aggression', 0.85], ['boldness', 0.85], ['jaw', 0.8]],
  mesopredator: [['aggression', 0.7], ['agility', 0.75]],
  grazer: [['neckLen', 0.45], ['legLen', 0.6]],
  browser: [['neckLen', 0.75], ['legLen', 0.7]],
  grazer_small: [['earSize', 0.75], ['legLen', 0.45]],
  piscivore: [['legLen', 0.9], ['neckLen', 0.85], ['snout', 0.85]],
  lithophage_large: [['plates', 0.85], ['legThick', 0.85]],
  pollinator: [['wingSpan', 0.8], ['snout', 0.85]],
};

// allele leanings: niche -> {key: [[allele, weight], ...]}
const ALLELE_LEAN = {
  cave_skink: { ears: [['none', 1]], horns: [['none', 4], ['nose', 1]], crest: [['none', 3], ['ridge', 1]], cheek: [['none', 3], ['spikes', 1]] },
  cave_gecko: { ears: [['none', 1]], horns: [['none', 5], ['crown', 1]], crest: [['none', 2], ['frills', 1], ['ridge', 1]], tailTip: [['none', 2], ['club', 2], ['fan', 1]] },
  cave_shrew: { ears: [['round', 2], ['fan', 2], ['tufted', 1], ['long', 1]], horns: [['none', 1]], crest: [['none', 1]], cheek: [['whiskers', 4], ['none', 1]], tailTip: [['none', 2], ['tuft', 1]] },
  cave_ferret: { ears: [['round', 2], ['pointed', 2], ['tufted', 1]], horns: [['none', 6], ['tusk', 1]], crest: [['none', 3], ['plume', 1]], cheek: [['whiskers', 3], ['none', 1]], tailTip: [['plume', 2], ['tuft', 2], ['none', 1]] },
  chasm_swift: { crest: [['none', 2], ['plume', 2], ['casque', 1], ['fan', 1]], tailTip: [['fork', 5], ['fan', 1]], horns: [['none', 1]] },
  chasm_hawk: { crest: [['none', 2], ['plume', 2], ['spikes', 1], ['casque', 1]], tailTip: [['fan', 3], ['fork', 1], ['plume', 1]], horns: [['none', 4], ['crown', 1]] },
  chasm_drake: { ears: [['none', 1]], horns: [['none', 2], ['curved', 1], ['crown', 1], ['nose', 1]], crest: [['sail', 2], ['spikes', 2], ['frills', 2], ['ridge', 1], ['fin', 1]], tailTip: [['none', 2], ['spike', 2], ['club', 1], ['fan', 1]], cheek: [['spikes', 2], ['dewlap', 2], ['none', 1]] },
  chasm_bat: { ears: [['long', 3], ['fan', 2], ['pointed', 2]], horns: [['none', 6], ['nose', 1]], crest: [['none', 4], ['frills', 1]], cheek: [['none', 2], ['whiskers', 1]], tailTip: [['none', 3], ['fork', 1]] },
  chasm_fox: { ears: [['pointed', 3], ['round', 1], ['tufted', 1]], horns: [['none', 1]], crest: [['none', 3], ['plume', 1]], cheek: [['none', 1], ['whiskers', 1]], tailTip: [['none', 1]] },
};

// ------------------------------------------------------------------ helpers
function pickWeighted(rng, list) { return rng.weighted(list); }
const HUE_NAMES = [[0.0, 'Crimson'], [0.04, 'Rust'], [0.08, 'Ochre'], [0.12, 'Amber'], [0.16, 'Golden'], [0.22, 'Olive'], [0.3, 'Moss'], [0.38, 'Jade'], [0.46, 'Teal'], [0.54, 'Azure'], [0.62, 'Cobalt'], [0.7, 'Indigo'], [0.78, 'Violet'], [0.86, 'Plum'], [0.93, 'Rose'], [1.0, 'Crimson']];
export function hueName(h) {
  h = ((h % 1) + 1) % 1;
  let best = HUE_NAMES[0][1], bd = 9;
  for (const [hv, n] of HUE_NAMES) { const d = Math.abs(hv - h); if (d < bd) { bd = d; best = n; } }
  return best;
}

/** Colour leanings of a layer: hue range, saturation, lightness (mostly natural tones, some vivid species). */
function layerPalette(layerId, niche, rng) {
  const earthy = { hue: [0.04, 0.14], sat: [0.18, 0.5], light: [0.26, 0.5] };
  const green = { hue: [0.17, 0.36], sat: [0.2, 0.5], light: [0.25, 0.45] };
  const grey = { hue: [0, 1], sat: [0.02, 0.12], light: [0.3, 0.6] };
  const vivid = { hue: [0, 1], sat: [0.45, 0.72], light: [0.32, 0.52] };
  switch (layerId) {
    case 'surface': return rng.weighted([[earthy, 4], [grey, 3], [vivid, 0.6]]);
    case 'layer1': return rng.weighted([[earthy, 4], [green, 2.5], [grey, 1.2], [vivid, 1.4]]);
    case 'layer2': return rng.weighted([[{ hue: [0.42, 0.62], sat: [0.18, 0.5], light: [0.26, 0.48] }, 3], [{ hue: [0.68, 0.84], sat: [0.18, 0.45], light: [0.25, 0.45] }, 2], [grey, 1], [vivid, 1]]);
    case 'layer3': return NICHES[niche].habitat === 'cave'
      ? { hue: [0.02, 0.14], sat: [0.05, 0.35], light: [0.45, 0.76] }   // pale, depigmented cave forms
      // the open tube: pale greys and whites against the limestone, slate blue, soft browns, a few crimson species
      : rng.weighted([[{ hue: [0, 1], sat: [0.02, 0.1], light: [0.45, 0.78] }, 3], [{ hue: [0.55, 0.65], sat: [0.12, 0.3], light: [0.35, 0.6] }, 2], [{ hue: [0.05, 0.12], sat: [0.18, 0.4], light: [0.3, 0.55] }, 2], [{ hue: [0.96, 1.02], sat: [0.45, 0.7], light: [0.3, 0.45] }, 1]]);
    default: return vivid;
  }
}

// ------------------------------------------------------------------ species
function familyFor(rng, plan, niche) {
  const fam = PLANS[plan].families;
  if (niche === 'cave_shrew' || niche === 'cave_ferret' || niche === 'chasm_bat' || niche === 'chasm_fox' || niche === 'urban_small') return 'mammal';
  if (niche.startsWith('cave_') || niche === 'chasm_drake') return 'reptile';
  if (plan === 'glider') return rng.chance(0.6) ? 'reptile' : 'mammal';
  if (plan === 'quadruped') {
    if (niche === 'grazer' || niche === 'browser') return rng.weighted([['mammal', 5], ['reptile', 2], ['lithosere', 0.6]]);
    if (niche === 'mesopredator' || niche === 'apex_predator') return rng.weighted([['mammal', 4], ['reptile', 3]]);
    if (niche === 'lithophage' || niche === 'lithophage_large') return 'lithosere';
    return rng.weighted(fam.map((f) => [f, f === 'mammal' ? 3 : 1]));
  }
  if (plan === 'biped') return rng.weighted([['mammal', 2], ['reptile', 3], ['bird', 2]]);
  return fam[0];
}

function makeSpecies(seed, layer, niche, index, names, used) {
  const N = NICHES[niche];
  const rng = RNG.derive(seed, 'species', layer.id, niche, index);
  const plan = pickWeighted(rng, Object.entries(N.plans));
  const family = familyFor(rng, plan, niche);
  const mean = new Float32Array(NG);
  for (let i = 0; i < NG; i++) mean[i] = rng.range(0.15, 0.85);
  for (const [g, v] of LEAN[niche] || []) mean[G[g]] = clamp(v + rng.range(-0.12, 0.12), 0, 1);
  mean[G.size] = rng.next();
  // colours from the layer palette
  const pal = layerPalette(layer.id, niche, rng);
  mean[G.hue] = ((rng.range(pal.hue[0], pal.hue[1]) % 1) + 1) % 1;
  mean[G.sat] = rng.range(pal.sat[0], pal.sat[1]);
  mean[G.light] = rng.range(pal.light[0], pal.light[1]);
  if (family === 'lithosere') { mean[G.sat] = rng.range(0.02, 0.15); mean[G.light] = rng.range(0.3, 0.5); }
  mean[G.hue2] = rng.range(0, 1);
  mean[G.accentHue] = rng.range(0, 1);
  // the deep and the dark glow
  if (layer.id === 'layer2') mean[G.glow] = Math.max(mean[G.glow], rng.range(0.25, 0.7));
  if (layer.id === 'layer3') mean[G.glow] = clamp(mean[G.glow] + 0.15, 0, 1);
  if (layer.id === 'surface' || layer.id === 'layer1') mean[G.glow] *= 0.3;
  // spread: how much individuals of the species differ (large on purpose)
  const sd = new Float32Array(NG);
  for (let i = 0; i < NG; i++) sd[i] = STABLE.has(i) ? rng.range(0.03, 0.06) : rng.range(0.07, 0.16);
  sd[G.hue] = rng.range(0.015, 0.05);
  sd[G.hue2] = rng.range(0.03, 0.12);
  sd[G.accentHue] = rng.range(0.04, 0.15);
  // allele frequencies: a few common alleles per trait, the rest rare (mutations)
  const alleles = {};
  for (const k of ALLELE_KEYS) {
    const lean = ALLELE_LEAN[niche] && ALLELE_LEAN[niche][k];
    let table;
    if (lean) table = lean.map(([a, w]) => [a, w]);
    else {
      const opts = rng.shuffle(ALLELES[k].slice());
      table = [[opts[0], rng.range(2, 6)], [opts[1], rng.range(0.5, 2.5)], [opts[2], rng.range(0, 1.2)]];
    }
    // plan constraints
    if (k === 'ears' && (family === 'bird' || family === 'arthropod' || family === 'lithosere' || family === 'reptile')) table = [['none', 1]];
    if (k === 'horns' && (family === 'bird' || plan === 'bat')) table = table.filter(([a]) => a === 'none' || a === 'crown').concat([['none', 3]]);
    if (k === 'eyes') {
      const e = family === 'arthropod' ? [[2, 1], [4, 2], [6, 2], [8, plan === 'spider' ? 4 : 0.5]] : family === 'lithosere' ? [[2, 1], [3, 2], [4, 2], [6, 1]] : [[2, 12], [4, 0.8], [3, 0.4]];
      table = e;
    }
    if (k === 'tailTip' && family === 'bird') table = table.filter(([a]) => ['fan', 'fork', 'plume', 'none'].includes(a)).concat([['fan', 1]]);
    if (k === 'tailTip' && plan !== 'spider' && family === 'arthropod') table = [['none', 4], ['stinger', 1]];
    if (k === 'crest' && family === 'bird') table = table.filter(([a]) => ['none', 'plume', 'fan', 'casque', 'spikes'].includes(a)).concat([['plume', 1], ['none', 1]]);
    if (k === 'crest' && family === 'mammal') table = table.filter(([a]) => ['none', 'plume', 'ridge', 'spikes'].includes(a)).concat([['none', 3]]);
    if (k === 'cheek' && family !== 'mammal' && family !== 'reptile') table = [['none', 1]];
    alleles[k] = table;
  }
  // body-plan specific numbers
  const legPairs = plan === 'centipede' ? rng.int(6, 11) : PLANS[plan].legs;
  const covering = { mammal: 'fur', reptile: 'scales', bird: 'feathers', arthropod: 'chitin', lithosere: 'stone' }[family];
  const social = pickWeighted(rng, N.social);
  const groupSize = { solitary: [1, 1], pair: [2, 2], group: [3, 6], herd: [5, 11], flock: [6, 14], swarm: [8, 18], colony: [5, 12], pack: [3, 5], family: [2, 4] }[social];
  const size = lerp(N.size[0], N.size[1], mean[G.size]);
  const activity = layer.id === 'layer3' ? (niche === 'chasm_bat' || mean[G.nocturnal] > 0.6 ? 'nocturnal' : 'cathemeral')
    : mean[G.nocturnal] > 0.72 ? 'nocturnal' : mean[G.nocturnal] > 0.55 ? 'crepuscular' : mean[G.nocturnal] < 0.25 ? 'diurnal' : 'cathemeral';
  const sp = {
    id: 0,
    key: `${layer.id}:${niche}`,
    layer: layer.id, layerIndex: layer.index,
    niche, role: niche, plan, family, covering,
    size, legPairs,
    genome: { mean: Array.from(mean), sd: Array.from(sd), alleles },
    behavior: {
      diet: N.diet, habitat: N.habitat, move: N.move, nest: N.nest || null, social, groupSize, activity,
      cave: !!N.cave, locomotion: locoFor(plan, N.move),
      reproduction: {
        maturity: clamp(110 + size * 140, 70, 800),
        clutch: plan === 'avian' || family === 'reptile' ? rng.int(2, 4) : social === 'swarm' || social === 'colony' ? rng.int(1, 3) : size > 2 ? 1 : rng.int(1, 3),
        cooldown: clamp(150 + size * 90 + rng.range(0, 80), 110, 800),
        care: plan === 'avian' || N.nest ? 'nest' : family === 'arthropod' ? 'none' : 'follow',
        eggs: plan === 'avian' || family === 'reptile' || family === 'arthropod',
      },
      lifespan: clamp(1400 + size * 700, 800, 5000),
      // creatures of the upper layers ignore explorers; only large deep hunters stalk them
      playerAware: N.diet === 'carnivore' && size > 1.8 && layer.index >= 3 ? 'predator' : null,
    },
    call: callFor(rng, family, plan, size),
    relations: { prey: [], predators: [], competitors: [], symbiontOf: null, hosts: [], mobs: [], nestsNear: [] },
    subspecies: [],
  };
  // subspecies: regional forms
  const nSub = layer.id === 'surface' ? 2 : rng.int(2, 3);
  for (let s = 0; s < nSub; s++) {
    const off = new Float32Array(NG);
    if (s > 0) {
      const genes = rng.shuffle(GENES.map((_, i) => i).filter((i) => !STABLE.has(i) || i === G.hue)).slice(0, rng.int(5, 9));
      for (const gi of genes) off[gi] = rng.sign() * rng.range(0.1, 0.28);
      off[G.hue] = rng.sign() * rng.range(0.03, 0.1);
      off[G.size] = rng.range(-0.15, 0.15);
    }
    const bias = {};
    if (s > 0) {
      const k = rng.pick(['crest', 'tailTip', 'pattern', 'horns', 'cheek']);
      const opts = alleles[k].map(([a]) => a);
      const rare = ALLELES[k].filter((a) => !opts.includes(a) || rng.chance(0.3));
      if (rare.length) bias[k] = rng.pick(rare);
      if (k === 'horns' && (family === 'bird' || plan === 'bat')) delete bias[k];
      if (k === 'crest' && family !== 'reptile' && bias[k] && !['plume', 'none', 'ridge'].includes(bias[k])) bias[k] = 'plume';
      if (k === 'tailTip' && family === 'bird') bias[k] = rng.pick(['fan', 'fork', 'plume']);
      if (k === 'cheek' && family !== 'mammal' && family !== 'reptile') delete bias[k];
    }
    sp.subspecies.push({ index: s, offset: Array.from(off), bias, name: '' });
  }
  sp.regionRule = regionRule(layer.id, niche, rng);
  sp.name = commonName(rng, sp, used);
  sp.binomial = names ? names.binomial('species', layer.id, niche, index) : `Species ${index}`;
  sp.subspecies.forEach((sub, s) => {
    sub.name = s === 0 ? 'nominate form' : `${names ? names.name('subsp', layer.id, niche, s).toLowerCase() : 'form' + s}`;
    sub.label = s === 0 ? sp.binomial : `${sp.binomial} ${sub.name}`;
  });
  return sp;
}

function locoFor(plan, move) {
  if (plan === 'avian' || plan === 'bat') return move === 'soar' ? 'soar' : move === 'hover' ? 'hover' : move === 'flutter' ? 'flutter' : 'fly';
  if (plan === 'insect' && move === 'hover') return 'hover';
  if (plan === 'glider') return 'glide';
  if (plan === 'serpent') return 'slither';
  if (plan === 'roller') return 'roll';
  if (move === 'ceiling') return 'ceiling';
  if (move === 'climb') return 'climb';
  if (move === 'hop') return plan === 'biped' ? 'hop' : 'run';
  return move === 'run' || move === 'scurry' ? 'run' : 'walk';
}

/** Where the subspecies live: a rule mapping positions to a subspecies index. */
function regionRule(layerId, niche, rng) {
  if (layerId === 'layer3') return { type: 'depth', cuts: [rng.range(-1250, -1350), rng.range(-1550, -1650)] };
  if (layerId === 'layer2') return { type: 'tier' };
  if (layerId === 'surface') return { type: 'zone' };
  return { type: 'sector', phase: rng.range(0, Math.PI * 2) };
}

/** Subspecies index (and hybrid blend) of a population at a position. */
export function subspeciesAt(sp, x, y, z, info) {
  const n = sp.subspecies.length;
  const R = sp.regionRule;
  let f = 0;
  switch (R.type) {
    case 'depth': f = y > R.cuts[0] ? 0 : y > R.cuts[1] ? 1 : 2; break;
    case 'tier': f = info && info.tier !== undefined ? info.tier : 0; break;
    case 'zone': f = info && info.city ? 0 : 1; break;
    case 'sector': {
      const a = ((Math.atan2(z, x) + R.phase) / (Math.PI * 2) % 1 + 1) % 1;
      f = Math.floor(a * n);
      break;
    }
    default: f = 0;
  }
  return Math.min(n - 1, Math.max(0, f % n));
}

function callFor(rng, family, plan, size) {
  const types = {
    mammal: plan === 'bat' ? ['squeak', 'click', 'chitter'] : ['growl', 'bleat', 'hoot', 'bark', 'whistle', 'chitter'],
    reptile: ['hiss', 'croak', 'rattle', 'chirp'], bird: ['chirp', 'trill', 'caw', 'whistle', 'scream'],
    arthropod: ['click', 'buzz', 'chirr'], lithosere: ['grind', 'rumble', 'chime'],
  }[family];
  const type = rng.pick(types);
  const pitch = clamp((900 / (0.5 + size)) * rng.range(0.6, 1.5), 60, 4200);
  return { type, pitch, rhythm: rng.int(1, 5), length: rng.range(0.15, 0.8), interval: rng.range(6, 28) };
}

// ------------------------------------------------------------------ names
const NOUNS = {
  mammal: { grazer: ['Grazer', 'Strider', 'Ruminant'], grazer_small: ['Hopper', 'Nibbler', 'Gnawer'], browser: ['Browser', 'Loper'], mesopredator: ['Prowler', 'Hound'], apex_predator: ['Ravager', 'Maw'], urban_small: ['Scurrier', 'Gnawer'], cliff_glider: ['Glider', 'Sailback'], cave_shrew: ['Shrew', 'Burrowmouse', 'Snuffler'], cave_ferret: ['Ferret', 'Tunnelcat', 'Mink'], chasm_bat: ['Bat', 'Flittermouse', 'Rift-bat'], chasm_fox: ['Flying Fox', 'Duskwing', 'Lantern-bat'], default: ['Beast', 'Loper'] },
  reptile: { grazer: ['Plodder', 'Shellback'], browser: ['Longneck', 'Browser'], mesopredator: ['Runner', 'Snapjaw'], apex_predator: ['Tyrant', 'Drake'], cliff_glider: ['Kite-lizard', 'Glider'], ceiling_crawler: ['Gecko', 'Clinger'], ambush_predator: ['Lurker', 'Ambusher'], cave_skink: ['Skink', 'Crevice-lizard', 'Slatecrawler'], cave_gecko: ['Gecko', 'Lichen-licker', 'Glowtoe'], chasm_drake: ['Wall-drake', 'Cliff-dragon', 'Ledge-lizard'], urban_small: ['Lizard'], default: ['Lizard', 'Crawler'] },
  bird: { urban_flier: ['Sparrow', 'Roofwing'], scavenger_flier: ['Vulture', 'Carrion-kite'], insectivore_flier: ['Swift', 'Flitter', 'Finch'], piscivore: ['Heron', 'Kingfisher'], pollinator: ['Hummer', 'Sipper'], mesopredator: ['Shrike', 'Talon'], apex_predator: ['Terror-bird', 'Hook-beak'], browser: ['Strider'], grazer_small: ['Quail'], chasm_swift: ['Swift', 'Cliff-swallow', 'Wallwing'], chasm_hawk: ['Rift-hawk', 'Falcon', 'Chasm-kite'], default: ['Bird'] },
  arthropod: { pollinator: ['Moth', 'Bee', 'Drifter'], decomposer: ['Beetle', 'Mite', 'Borer'], ceiling_crawler: ['Weaver', 'Hangspider', 'Centipede'], ambush_predator: ['Trapjaw', 'Lurker'], insectivore_flier: ['Dart-wing'], default: ['Crawler', 'Skitter'] },
  lithosere: { grazer: ['Moss-golem', 'Plodder'], lithophage: ['Pebbler', 'Quarrier', 'Geode'], lithophage_large: ['Golem', 'Cairn', 'Crag-beast'], ambush_predator: ['Mimic-stone', 'Crag-maw'], default: ['Boulderling'] },
};

function commonName(rng, sp, used) {
  const m = sp.genome.mean, al = sp.genome.alleles;
  const top = (k) => al[k].slice().sort((a, b) => b[1] - a[1])[0][0];
  const adjs = [hueName(m[G.hue])];
  const pat = top('pattern');
  if (pat === 'stripes') adjs.push('Striped');
  if (pat === 'spots' || pat === 'ocelli') adjs.push('Spotted');
  if (pat === 'bands') adjs.push('Banded');
  if (pat === 'mottled') adjs.push('Mottled');
  const crest = top('crest');
  if (crest !== 'none') adjs.push(crest === 'sail' ? 'Sail-backed' : crest === 'frills' ? 'Frilled' : crest === 'spikes' ? 'Spiny' : crest === 'casque' ? 'Helmeted' : 'Crested');
  const horns = top('horns');
  if (horns !== 'none') adjs.push(horns === 'antler' ? 'Antlered' : horns === 'tusk' ? 'Tusked' : horns === 'crown' ? 'Crowned' : 'Horned');
  if (top('tailTip') === 'club') adjs.push('Clubtail');
  if (top('tailTip') === 'fork') adjs.push('Fork-tailed');
  if (m[G.glow] > 0.65) adjs.push('Glowing');
  if (m[G.eyeSize] < 0.22 && sp.layer === 'layer3') adjs.push('Blind');
  if (m[G.earSize] > 0.85 && sp.family === 'mammal') adjs.push('Long-eared');
  if (m[G.neckLen] > 0.8) adjs.push('Long-necked');
  if (sp.behavior.activity === 'nocturnal') adjs.push('Night');
  const nouns = (NOUNS[sp.family] && (NOUNS[sp.family][sp.niche] || NOUNS[sp.family].default)) || ['Creature'];
  for (let i = 0; i < 40; i++) {
    const noun = rng.pick(nouns);
    const k = i < 12 ? 1 : 2;
    const name = [...rng.shuffle(adjs.slice()).slice(0, k), noun].join(' ');
    if (!used.has(name)) { used.add(name); return name; }
  }
  const fb = `${adjs[0]} ${nouns[0]} ${used.size}`;
  used.add(fb);
  return fb;
}

/** Generate all species for the world. */
export function generateSpecies(seed, names) {
  const species = [];
  const used = new Set();
  for (const layer of LAYERS) {
    const def = LAYER_NICHES[layer.id];
    if (!def || !layer.implemented) continue;
    const rng = RNG.derive(seed, 'species', layer.id);
    const n = rng.int(def.n[0], def.n[1]);
    const chosen = def.niches.slice(0, Math.min(n, def.niches.length));
    while (chosen.length < n) chosen.push(rng.pick(def.niches));
    chosen.forEach((niche, i) => {
      const sp = makeSpecies(seed, layer, niche, i, names, used);
      sp.id = species.length;
      species.push(sp);
    });
  }
  buildFoodWeb(species, seed);
  return species;
}

/** Relationships: predator/prey, competition, symbiosis, mobbing, shared nest sites. */
export function buildFoodWeb(species, seed) {
  const rng = RNG.derive(seed, 'foodweb');
  const byLayer = {};
  for (const s of species) (byLayer[s.layer] = byLayer[s.layer] || []).push(s);
  for (const list of Object.values(byLayer)) {
    for (const a of list) {
      const da = a.behavior.diet;
      for (const b of list) {
        if (a === b) continue;
        const db = b.behavior.diet;
        const sa = a.size, sb = b.size;
        let eats = false;
        if (da === 'carnivore' && b.family !== 'lithosere' && sb < sa * 0.85 && sb > sa * 0.06) eats = true;
        if (da === 'carnivore' && b.family === 'lithosere' && a.family === 'lithosere' && sb < sa * 0.6) eats = true;
        // cave hunters keep to the caves, chasm hunters to the air and walls
        if (eats && a.layer === 'layer3') {
          const aCave = a.behavior.habitat === 'cave', bCave = b.behavior.habitat === 'cave';
          if (aCave !== bCave) eats = false;
        }
        if (da === 'insectivore' && b.family === 'arthropod' && sb < sa * 0.8) eats = true;
        if (da === 'omnivore' && b.family === 'arthropod' && sb < sa * 0.7) eats = true;
        if (eats) { a.relations.prey.push(b.id); b.relations.predators.push(a.id); }
        if (da === db && da !== 'carnivore' && a.id < b.id && Math.abs(Math.log(sa / sb)) < 1.2) {
          a.relations.competitors.push(b.id); b.relations.competitors.push(a.id);
        }
        if (da === 'carnivore' && db === 'carnivore' && a.id < b.id) { a.relations.competitors.push(b.id); b.relations.competitors.push(a.id); }
      }
    }
    // mobbing: small social fliers harass the predators that hunt them
    for (const a of list) {
      if (!['flock', 'swarm', 'colony'].includes(a.behavior.social) || a.behavior.habitat !== 'air') continue;
      for (const pid of a.relations.predators) a.relations.mobs.push(pid);
    }
    // shared cliffs: wall nesters settle near each other (safety in numbers)
    const nesters = list.filter((s) => ['wall', 'ledge', 'roost', 'cliff'].includes(s.behavior.nest));
    for (const a of nesters) for (const b of nesters) if (a !== b && !a.relations.prey.includes(b.id) && !b.relations.prey.includes(a.id)) a.relations.nestsNear.push(b.id);
    // symbiosis: a small insect-eater cleans a large grazer, or a lichen-eater rides a wall-dweller
    const hosts = list.filter((s) => s.size > 1.3 && ['grazer', 'browser', 'lithophage'].includes(s.behavior.diet));
    const cleaners = list.filter((s) => s.size < 0.6 && ['insectivore', 'omnivore', 'detritivore'].includes(s.behavior.diet) && s.behavior.habitat !== 'cave');
    if (hosts.length && cleaners.length) {
      const c = rng.pick(cleaners), h = rng.pick(hosts);
      if (!c.relations.symbiontOf) {
        c.relations.symbiontOf = h.id;
        h.relations.hosts.push(c.id);
        h.relations.prey = h.relations.prey.filter((p) => p !== c.id);
        c.relations.predators = c.relations.predators.filter((p) => p !== h.id);
      }
    }
  }
}

// ------------------------------------------------------------------ individuals
/**
 * A new individual of a species: genes drawn around its subspecies (or a blend
 * of two subspecies in a hybrid zone), alleles drawn from the frequencies.
 */
export function individualGenes(sp, rng, sub = 0, hybridWith = -1, hybridT = 0) {
  const g = sp.genome;
  const S = sp.subspecies[Math.min(sub, sp.subspecies.length - 1)];
  const H = hybridWith >= 0 ? sp.subspecies[hybridWith] : null;
  const c = new Array(NG);
  for (let i = 0; i < NG; i++) {
    let m = g.mean[i] + S.offset[i];
    if (H) m = lerp(m, g.mean[i] + H.offset[i], hybridT);
    let v = m + rng.gauss(0, g.sd[i]);
    if (i === G.hue || i === G.hue2 || i === G.accentHue) v = ((v % 1) + 1) % 1;
    else v = clamp(v, 0, 1);
    c[i] = v;
  }
  const a = {};
  for (const k of ALLELE_KEYS) {
    const bias = (H && rng.chance(hybridT) ? H.bias[k] : S.bias[k]);
    if (bias !== undefined && rng.chance(0.75)) a[k] = bias;
    else a[k] = rng.weighted(g.alleles[k]);
    // rare mutations: any allele of the trait
    if (rng.chance(0.03) && !(k === 'ears' && g.alleles.ears.length === 1 && g.alleles.ears[0][0] === 'none') && k !== 'eyes') a[k] = rng.pick(ALLELES[k]);
  }
  return { c, a, sex: rng.chance(0.5) ? 'f' : 'm', sub, gen: 0 };
}

/** Offspring: each gene from either parent or a blend, plus mutation; alleles from one parent. */
export function inheritGenes(sp, A, B, rng) {
  const g = sp.genome;
  const c = new Array(NG);
  for (let i = 0; i < NG; i++) {
    const r = rng.next();
    let v = r < 0.35 ? A.c[i] : r < 0.7 ? B.c[i] : lerp(A.c[i], B.c[i], rng.next());
    v += rng.gauss(0, g.sd[i] * 0.45);
    if (i === G.hue || i === G.hue2 || i === G.accentHue) v = ((v % 1) + 1) % 1;
    else v = clamp(v, 0, 1);
    c[i] = v;
  }
  const a = {};
  for (const k of ALLELE_KEYS) {
    a[k] = rng.chance(0.5) ? A.a[k] : B.a[k];
    if (rng.chance(0.05) && k !== 'eyes' && !(k === 'ears' && sp.family !== 'mammal')) a[k] = rng.weighted(g.alleles[k]);
  }
  return { c, a, sex: rng.chance(0.5) ? 'f' : 'm', sub: rng.chance(0.5) ? A.sub : B.sub, gen: Math.max(A.gen || 0, B.gen || 0) + 1 };
}

// ------------------------------------------------------------------ text
export const DIET_TEXT = {
  grazer: 'Grazes on grasses and low plants', browser: 'Browses shrubs and foliage', carnivore: 'Hunts other creatures',
  insectivore: 'Feeds on small arthropods', scavenger: 'Scavenges carcasses', piscivore: 'Catches fish in open water',
  nectar: 'Drinks nectar from flowers', detritivore: 'Feeds on decaying matter', lithophage: 'Grinds and eats minerals and lichen',
  omnivore: 'Eats almost anything it can find', lichen: 'Grazes moss and lichen from the rock',
};

export const LOCO_TEXT = {
  walk: 'walks', run: 'runs swiftly', hop: 'hops', fly: 'flies', soar: 'soars on rising air', hover: 'hovers', flutter: 'flutters in erratic swarms',
  glide: 'glides between heights', climb: 'climbs sheer rock', ceiling: 'clings to ceilings and overhangs', slither: 'slithers', roll: 'rolls its body like a boulder',
};

export const HABITAT_TEXT = {
  ground: 'open ground', cave: 'the caves', wall: 'the walls of the Great Fault', air: 'the open air', ceiling: 'ceilings and overhangs', shore: 'shores and shallows',
};

/** Plain-language summary of the species' look and its variability (catalog). */
export function describeAppearance(sp) {
  const m = sp.genome.mean, al = sp.genome.alleles;
  const top = (k) => al[k].slice().sort((a, b) => b[1] - a[1])[0][0];
  const sizeWord = sp.size > 3.5 ? 'huge' : sp.size > 2 ? 'large' : sp.size > 0.9 ? 'medium-sized' : sp.size > 0.35 ? 'small' : 'tiny';
  const body = {
    quadruped: 'four-legged', biped: 'bipedal', sprawler: 'low, sprawling', serpent: 'legless, serpentine', avian: 'winged', bat: 'bat-winged',
    glider: 'membrane-gliding', insect: 'six-legged', spider: 'eight-legged', centipede: 'many-legged', golem: 'stone-bodied', roller: 'boulder-like',
  }[sp.plan];
  const cover = { fur: 'fur', scales: 'scales', feathers: 'feathers', chitin: 'a chitinous shell', stone: 'stony plates' }[sp.covering];
  const pat = top('pattern');
  const parts = [];
  const crest = top('crest'), horns = top('horns'), tail = top('tailTip');
  if (horns !== 'none') parts.push(horns === 'antler' ? 'branching antlers' : horns === 'tusk' ? 'tusks' : horns === 'crown' ? 'a crown of horns' : `${horns} horns`);
  if (crest !== 'none') parts.push(crest === 'spikes' ? 'a row of dorsal spikes' : crest === 'frills' ? 'frilled skin flaps' : `a ${crest} crest`);
  if (tail !== 'none' && sp.plan !== 'spider') parts.push(`a ${tail}-tipped tail`);
  if (m[G.glow] > 0.55) parts.push('glowing markings');
  if (m[G.eyeSize] < 0.22) parts.push('tiny, almost useless eyes');
  else if (m[G.eyeSize] > 0.8) parts.push('very large eyes');
  if (sp.family === 'mammal' && m[G.earSize] > 0.8) parts.push('enormous ears');
  if (m[G.whisker] > 0.75 && sp.family === 'mammal') parts.push('long whiskers');
  const feats = parts.length ? ` It has ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts[parts.length - 1]}.` : '';
  const variable = ` Individuals vary strongly in proportions, colour and ornament; ${sp.subspecies.length} regional forms are known.`;
  return `A ${sizeWord} (~${sp.size.toFixed(1)} m) ${body} ${FAMILY_LABEL[sp.family].toLowerCase()} covered in ${hueName(m[G.hue]).toLowerCase()} ${cover}${pat !== 'none' ? ` with ${pat === 'gradient' ? 'graded' : pat} markings` : ''}.${feats}${variable}`;
}
