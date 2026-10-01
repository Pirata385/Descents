// Creature genetics. Species are generated per layer from ecological roles.
// Each species has a genome (morphology + behaviour + voice) sampled from a
// family template; individuals carry small heritable deviations and
// offspring inherit a mix of both parents plus mutation. Pure data, no rendering.
import { RNG } from '../core/rng.js';
import { clamp, lerp } from '../core/mathutil.js';
import { LAYERS } from '../world/layers.js';

export const FAMILIES = ['mammal', 'reptile', 'bird', 'arthropod', 'lithosere'];
export const FAMILY_LABEL = { mammal: 'Mammal', reptile: 'Reptilian', bird: 'Bird', arthropod: 'Arthropod', lithosere: 'Lithosere' };

/** Ecological roles: what a species does, which families can fill it and rough constraints. */
export const ROLES = {
  grazer: { diet: 'grazer', size: [1.3, 3.2], social: [['herd', 4], ['group', 2]], fam: { mammal: 5, reptile: 2, lithosere: 1, bird: 0.6 }, habitat: ['plains', 'meadow'], loco: [['walk', 3], ['run', 2]] },
  grazer_small: { diet: 'grazer', size: [0.3, 0.9], social: [['group', 3], ['colony', 2], ['pair', 1]], fam: { mammal: 4, reptile: 1.5, bird: 1 }, habitat: ['plains', 'meadow', 'shrubs'], loco: [['hop', 2], ['run', 2], ['walk', 1]] },
  browser: { diet: 'browser', size: [1.0, 2.8], social: [['group', 2], ['solitary', 1], ['pair', 1]], fam: { mammal: 3, reptile: 2, bird: 1 }, habitat: ['shrubs', 'forest', 'meadow'], loco: [['walk', 3]] },
  mesopredator: { diet: 'carnivore', size: [0.6, 1.5], social: [['solitary', 3], ['pair', 2], ['pack', 2]], fam: { mammal: 3, reptile: 3, bird: 1, arthropod: 1 }, habitat: ['plains', 'shrubs', 'rocky'], loco: [['run', 3], ['walk', 1]] },
  apex_predator: { diet: 'carnivore', size: [2.2, 4.6], social: [['solitary', 3], ['pair', 1.5], ['pack', 1]], fam: { mammal: 3, reptile: 4, bird: 1 }, habitat: ['plains', 'rocky', 'forest'], loco: [['run', 3], ['walk', 1]] },
  insectivore_flier: { diet: 'insectivore', size: [0.14, 0.45], social: [['flock', 4], ['pair', 1]], fam: { bird: 5, reptile: 0.8, arthropod: 0.6 }, habitat: ['air', 'shrubs', 'cliffs'], loco: [['fly', 5]] },
  scavenger_flier: { diet: 'scavenger', size: [0.7, 1.6], social: [['solitary', 2], ['group', 2]], fam: { bird: 5, reptile: 1 }, habitat: ['air', 'cliffs'], loco: [['fly', 4], ['glide', 2]] },
  piscivore: { diet: 'piscivore', size: [0.5, 1.6], social: [['solitary', 2], ['group', 1]], fam: { bird: 4, mammal: 1, reptile: 1.5 }, habitat: ['water'], loco: [['fly', 3], ['walk', 1], ['swim', 1]] },
  pollinator: { diet: 'nectar', size: [0.05, 0.22], social: [['swarm', 3], ['solitary', 1]], fam: { arthropod: 5, bird: 1.5 }, habitat: ['meadow', 'shrubs'], loco: [['fly', 5]] },
  decomposer: { diet: 'detritivore', size: [0.15, 0.8], social: [['colony', 3], ['solitary', 1]], fam: { arthropod: 5, lithosere: 1 }, habitat: ['forest', 'caves', 'litter'], loco: [['walk', 4]] },
  lithophage: { diet: 'lithophage', size: [0.5, 1.6], social: [['group', 2], ['solitary', 2]], fam: { lithosere: 6, arthropod: 1 }, habitat: ['rocky', 'cliffs', 'caves'], loco: [['walk', 3], ['roll', 1]] },
  lithophage_large: { diet: 'lithophage', size: [2.6, 5.2], social: [['family', 4], ['solitary', 1]], fam: { lithosere: 8 }, habitat: ['plain', 'rocky'], loco: [['walk', 4]] },
  cliff_glider: { diet: 'insectivore', size: [0.35, 1.1], social: [['group', 2], ['solitary', 1]], fam: { reptile: 3, mammal: 2, bird: 1.5 }, habitat: ['cliffs', 'air'], loco: [['glide', 5]] },
  ceiling_crawler: { diet: 'insectivore', size: [0.4, 1.4], social: [['colony', 2], ['solitary', 2]], fam: { arthropod: 4, reptile: 3, mammal: 1 }, habitat: ['ceiling'], loco: [['ceiling', 5]] },
  ambush_predator: { diet: 'carnivore', size: [1.0, 2.6], social: [['solitary', 4]], fam: { arthropod: 3, lithosere: 3, reptile: 2 }, habitat: ['rocky', 'forest', 'litter'], loco: [['walk', 3]] },
  urban_flier: { diet: 'omnivore', size: [0.2, 0.5], social: [['flock', 4]], fam: { bird: 6 }, habitat: ['city', 'air'], loco: [['fly', 5]] },
  urban_small: { diet: 'omnivore', size: [0.2, 0.6], social: [['group', 2], ['solitary', 1]], fam: { mammal: 5, reptile: 1 }, habitat: ['city', 'meadow'], loco: [['run', 3]] },
  fault_stalker: { diet: 'carnivore', size: [2.0, 3.4], social: [['solitary', 4]], fam: { reptile: 2, mammal: 2, arthropod: 2, lithosere: 1 }, habitat: ['fault'], loco: [['walk', 2], ['ceiling', 1]], playerAware: 'predator' },
};

const HUE_NAMES = [[0.0, 'Crimson'], [0.04, 'Rust'], [0.08, 'Ochre'], [0.12, 'Amber'], [0.16, 'Golden'], [0.22, 'Olive'], [0.3, 'Moss'], [0.38, 'Jade'], [0.46, 'Teal'], [0.54, 'Azure'], [0.62, 'Cobalt'], [0.7, 'Indigo'], [0.78, 'Violet'], [0.86, 'Plum'], [0.93, 'Rose'], [1.0, 'Crimson']];
const NOUNS = {
  mammal: { grazer: ['Grazer', 'Ruminant', 'Strider'], grazer_small: ['Gnawer', 'Hopper', 'Nibbler'], browser: ['Browser', 'Loper', 'Shambler'], mesopredator: ['Prowler', 'Hound', 'Stalker'], apex_predator: ['Ravager', 'Maw', 'Stalker'], piscivore: ['Otterling', 'Diver'], cliff_glider: ['Glider', 'Sailback'], ceiling_crawler: ['Hangclaw', 'Roostling'], urban_small: ['Scurrier', 'Gnawer'], fault_stalker: ['Shade-hound', 'Gloomstalker'], default: ['Beast', 'Loper'] },
  reptile: { grazer: ['Plodder', 'Shellback'], grazer_small: ['Skink', 'Nibbler'], browser: ['Browser', 'Longneck'], mesopredator: ['Runner', 'Snapjaw'], apex_predator: ['Tyrant', 'Splitjaw', 'Drake'], piscivore: ['Snapper', 'Wader'], cliff_glider: ['Glider', 'Kite-lizard'], ceiling_crawler: ['Gecko', 'Clinger'], ambush_predator: ['Lurker', 'Ambusher'], fault_stalker: ['Wyrm', 'Rift-drake'], default: ['Lizard', 'Crawler'] },
  bird: { grazer: ['Strider', 'Grazing-fowl'], grazer_small: ['Quail', 'Pecker'], browser: ['Strider', 'Browser'], mesopredator: ['Shrike', 'Talon'], apex_predator: ['Terror-bird', 'Hook-beak'], insectivore_flier: ['Swift', 'Flitter', 'Finch'], scavenger_flier: ['Vulture', 'Carrion-kite'], piscivore: ['Heron', 'Diver', 'Kingfisher'], pollinator: ['Hummer', 'Sipper'], cliff_glider: ['Glider'], urban_flier: ['Sparrow', 'Roofwing', 'Pigeon'], default: ['Bird', 'Wing'] },
  arthropod: { mesopredator: ['Mantis', 'Hunter'], insectivore_flier: ['Dart-wing'], pollinator: ['Moth', 'Bee', 'Drifter'], decomposer: ['Beetle', 'Mite', 'Borer'], lithophage: ['Gravel-mite', 'Rockborer'], ceiling_crawler: ['Weaver', 'Hangspider', 'Centipede'], ambush_predator: ['Trapjaw', 'Lurker'], fault_stalker: ['Chasm-weaver'], default: ['Crawler', 'Skitter'] },
  lithosere: { grazer: ['Plodder', 'Moss-golem'], lithophage: ['Pebbler', 'Quarrier', 'Geode'], lithophage_large: ['Golem', 'Cairn', 'Crag-beast'], decomposer: ['Grit-eater'], ambush_predator: ['Mimic-stone', 'Crag-maw'], fault_stalker: ['Rift-golem'], default: ['Boulderling', 'Slatehide'] },
};

function hueName(h) {
  let best = HUE_NAMES[0][1], bd = 9;
  for (const [hv, n] of HUE_NAMES) { const d = Math.abs(hv - h); if (d < bd) { bd = d; best = n; } }
  return best;
}

function hsl(rng, h, s, l, jitter = 0) {
  return { h: ((h + rng.range(-jitter, jitter)) % 1 + 1) % 1, s: clamp(s, 0, 1), l: clamp(l, 0, 1) };
}

/** Build the morphology part of a genome for a family. */
function morphology(rng, family, role, size) {
  const R = ROLES[role];
  const m = {
    size, bodyLen: 1, bodyGirth: 0.3, bodyHeight: 0.3, segments: 1,
    neckLen: 0.2, neckThick: 0.5, headSize: 0.3, snoutLen: 0.4, jaw: 'jaw', beakLen: 0, beakCurve: 0,
    eyes: { count: 2, size: 0.12, glow: 0, stalk: false },
    ears: { size: 0, shape: 'none' },
    horns: { type: 'none', count: 0, len: 0, curve: 0 },
    crest: { type: 'none', size: 0 },
    frill: 0, spines: { count: 0, len: 0 }, plates: 0,
    tail: { len: 0.5, thick: 0.3, tip: 'none' },
    legs: { pairs: 2, len: 0.5, thick: 0.12, posture: 'erect', biped: false },
    arms: { len: 0 },
    wings: { type: 'none', span: 0, flight: 0 },
    antennae: 0,
    covering: 'fur', shag: 0,
    colors: null, pattern: { type: 'none', scale: 1, contrast: 0.5 },
  };
  const diet = R.diet;
  const carn = diet === 'carnivore';
  switch (family) {
    case 'mammal': {
      m.covering = 'fur';
      m.shag = rng.range(0, 1);
      m.bodyLen = rng.range(0.72, 0.95);
      m.bodyGirth = rng.range(0.3, 0.46);
      m.bodyHeight = m.bodyGirth * rng.range(1.0, 1.3);
      m.neckLen = rng.range(0.12, carn ? 0.3 : 0.5);
      m.neckThick = rng.range(0.6, 0.85);
      if (role === 'browser' && rng.chance(0.5)) m.neckLen = rng.range(0.6, 1.1);
      m.headSize = rng.range(0.27, 0.38);
      m.snoutLen = rng.range(carn ? 0.3 : 0.25, carn ? 0.7 : 0.75);
      m.legs.len = rng.range(0.5, 0.88) * (role === 'grazer' ? 1.15 : 1) * (role === 'urban_small' || role === 'grazer_small' ? 0.8 : 1);
      m.legs.thick = rng.range(0.11, 0.19) * (size > 2 ? 1.3 : 1);
      m.legs.posture = rng.chance(0.5) ? 'digitigrade' : 'erect';
      if (rng.chance(0.12)) m.legs.pairs = 3; // hexapod abyssal mammals
      if (role === 'grazer_small' && rng.chance(0.4) || rng.chance(0.06)) { m.legs.biped = true; m.legs.pairs = 1; m.arms.len = rng.range(0.15, 0.35); m.legs.len *= 1.3; }
      m.ears = { size: rng.range(0.12, role === 'grazer_small' ? 0.55 : 0.32), shape: rng.pick(['pointed', 'round', 'long', 'tufted']) };
      if ((diet === 'grazer' || diet === 'browser') && rng.chance(0.65)) {
        m.horns = { type: rng.pick(['straight', 'curved', 'antlers', 'spiral', 'nose']), count: rng.pick([1, 2, 2, 2, 4]), len: rng.range(0.15, 0.6), curve: rng.range(-1, 1) };
      }
      if (carn && rng.chance(0.3)) m.horns = { type: 'tusks', count: 2, len: rng.range(0.1, 0.25), curve: 0.5 };
      m.tail = { len: rng.chance(0.3) ? rng.range(0.06, 0.2) : rng.range(0.2, 0.7), thick: rng.range(0.18, 0.4), tip: rng.pick(['none', 'tuft', 'tuft', 'plume', 'plume', 'club']) };
      if (rng.chance(0.12)) m.spines = { count: rng.int(4, 10), len: rng.range(0.08, 0.25) };
      m.eyes.count = rng.chance(0.12) ? 4 : 2;
      m.eyes.size = rng.range(0.08, 0.14);
      break;
    }
    case 'reptile': {
      m.covering = 'scales';
      m.bodyGirth = rng.range(0.16, 0.3);
      m.bodyHeight = m.bodyGirth * rng.range(0.7, 1.0);
      m.legs.posture = rng.chance(0.65) ? 'sprawl' : 'erect';
      m.legs.len = rng.range(0.24, 0.5);
      m.legs.thick = rng.range(0.09, 0.15);
      m.neckLen = rng.range(0.1, 0.35);
      if (role === 'browser' && rng.chance(0.6)) m.neckLen = rng.range(0.7, 1.3);
      m.headSize = rng.range(0.2, 0.32);
      m.snoutLen = rng.range(0.4, 1.0);
      m.tail = { len: rng.range(0.8, 1.6), thick: rng.range(0.25, 0.5), tip: rng.pick(['none', 'none', 'club', 'spike', 'fan']) };
      if ((carn && size > 1.5 && rng.chance(0.65)) || role === 'mesopredator' && rng.chance(0.35)) {
        // theropod-like biped
        m.legs.biped = true; m.legs.pairs = 1; m.legs.posture = 'digitigrade'; m.legs.len = rng.range(0.45, 0.7); m.arms.len = rng.range(0.1, 0.3);
      }
      if (rng.chance(0.1) && !m.legs.biped && role !== 'cliff_glider' && role !== 'ceiling_crawler') { m.legs.pairs = 0; m.tail.len = rng.range(1.6, 2.6); } // serpentine
      if (rng.chance(0.3)) m.frill = rng.range(0.2, 0.6);
      if (rng.chance(0.45)) m.spines = { count: rng.int(5, 16), len: rng.range(0.05, 0.3) };
      if (rng.chance(0.35)) m.horns = { type: rng.pick(['straight', 'curved', 'nose', 'crown']), count: rng.pick([1, 2, 3, 4]), len: rng.range(0.08, 0.35), curve: rng.range(-1, 1) };
      if (rng.chance(0.25)) m.crest = { type: rng.pick(['sail', 'ridge', 'fin']), size: rng.range(0.15, 0.5) };
      if (role === 'cliff_glider') m.wings = { type: 'membrane', span: rng.range(1.2, 2.0), flight: 0.4 };
      m.eyes.count = rng.chance(0.12) ? 3 : 2;
      m.eyes.size = rng.range(0.07, 0.14);
      break;
    }
    case 'bird': {
      m.covering = 'feathers';
      m.legs.biped = true; m.legs.pairs = 1;
      m.bodyGirth = rng.range(0.25, 0.4);
      m.bodyHeight = m.bodyGirth * rng.range(1.0, 1.25);
      m.bodyLen = rng.range(0.7, 1.0);
      m.neckLen = rng.range(0.2, role === 'piscivore' ? 1.0 : 0.6);
      m.headSize = rng.range(0.22, 0.32);
      m.jaw = 'beak';
      const beak = diet === 'nectar' ? [0.8, 1.6, 0.1] : diet === 'piscivore' ? [0.8, 1.4, 0] : carn || diet === 'scavenger' ? [0.35, 0.6, 0.8] : diet === 'grazer' ? [0.25, 0.45, 0.2] : [0.25, 0.6, 0.3];
      m.beakLen = rng.range(beak[0], beak[1]);
      m.beakCurve = beak[2] * rng.range(0.5, 1.2);
      m.legs.len = rng.range(0.4, 0.9) * (role === 'piscivore' ? 1.5 : 1);
      m.legs.thick = rng.range(0.04, 0.08);
      m.legs.posture = 'digitigrade';
      let flight = 0.8;
      if (size > 1.8 || role === 'apex_predator' || role === 'grazer') flight = rng.chance(0.75) ? 0 : 0.3; // big birds tend to be flightless runners
      if (role === 'scavenger_flier') flight = 0.7;
      if (role === 'insectivore_flier' || role === 'pollinator' || role === 'urban_flier') flight = 1;
      if (role === 'cliff_glider') flight = 0.45;
      m.wings = { type: 'feather', span: flight > 0 ? rng.range(1.6, 2.8) : rng.range(0.6, 1.0), flight };
      m.tail = { len: rng.range(0.2, 0.9), thick: 0.2, tip: rng.pick(['fan', 'fork', 'plume', 'none']) };
      if (rng.chance(0.45)) m.crest = { type: rng.pick(['plume', 'fan', 'spike', 'casque']), size: rng.range(0.1, 0.45) };
      m.eyes.size = rng.range(0.1, 0.18);
      if (rng.chance(0.08)) m.eyes.count = 4;
      break;
    }
    case 'arthropod': {
      m.covering = 'chitin';
      const kind = role === 'ceiling_crawler' ? rng.pick(['spider', 'centipede', 'beetle']) : role === 'pollinator' || role === 'insectivore_flier' ? rng.pick(['moth', 'fly']) : role === 'mesopredator' || role === 'ambush_predator' ? rng.pick(['mantis', 'spider', 'scorpion', 'beetle']) : rng.pick(['beetle', 'centipede', 'mite', 'crab']);
      m.kind = kind;
      m.segments = kind === 'centipede' ? rng.int(7, 14) : rng.int(2, 3);
      m.legs.pairs = kind === 'spider' || kind === 'scorpion' || kind === 'mite' ? 4 : kind === 'centipede' ? m.segments : kind === 'crab' ? 4 : 3;
      m.legs.posture = 'arthropod';
      m.legs.len = rng.range(0.4, kind === 'spider' ? 1.2 : 0.8);
      m.legs.thick = rng.range(0.03, 0.06);
      m.bodyGirth = rng.range(0.2, 0.38);
      m.bodyHeight = m.bodyGirth * rng.range(0.5, 0.9);
      m.headSize = rng.range(0.18, 0.3);
      m.snoutLen = 0.1;
      m.jaw = 'mandible';
      m.antennae = kind === 'spider' || kind === 'mite' ? 0 : rng.range(0.3, 1.2);
      m.eyes = { count: kind === 'spider' ? 8 : rng.pick([2, 2, 4, 6]), size: rng.range(0.05, 0.12), glow: rng.chance(0.2) ? rng.range(0.4, 1) : 0, stalk: kind === 'crab' };
      if (kind === 'moth' || kind === 'fly' || (kind === 'beetle' && rng.chance(0.3))) m.wings = { type: 'insect', span: rng.range(1.2, 2.6), flight: 1 };
      if (kind === 'mantis' || kind === 'scorpion' || kind === 'crab') m.arms.len = rng.range(0.3, 0.6);
      m.tail = kind === 'scorpion' ? { len: rng.range(0.8, 1.3), thick: 0.15, tip: 'stinger' } : { len: 0, thick: 0, tip: 'none' };
      if (rng.chance(0.25)) m.spines = { count: rng.int(3, 8), len: rng.range(0.05, 0.2) };
      if (rng.chance(0.2)) m.horns = { type: 'nose', count: 1, len: rng.range(0.15, 0.4), curve: 0.4 };
      break;
    }
    case 'lithosere': {
      m.covering = 'stone';
      m.kind = role === 'lithophage_large' ? 'golem' : rng.pick(['golem', 'golem', 'shell', 'roller', 'crystal']);
      if (R.loco.some((l) => l[0] === 'roll') && rng.chance(0.4)) m.kind = 'roller';
      m.bodyGirth = rng.range(0.35, 0.6);
      m.bodyHeight = m.bodyGirth * rng.range(0.9, 1.3);
      m.bodyLen = rng.range(0.7, 1.1);
      m.plates = rng.range(0.4, 1.0);
      m.legs.pairs = m.kind === 'roller' ? 0 : rng.chance(0.3) ? 3 : 2;
      m.legs.len = rng.range(0.25, 0.5);
      m.legs.thick = rng.range(0.12, 0.2);
      m.legs.posture = 'erect';
      m.neckLen = rng.range(0, 0.15);
      m.headSize = rng.range(0.25, 0.4);
      m.snoutLen = rng.range(0.1, 0.3);
      m.eyes = { count: rng.pick([2, 3, 4, 5, 6]), size: rng.range(0.05, 0.1), glow: rng.range(0.6, 1), stalk: false };
      m.tail = { len: rng.range(0.2, 0.9), thick: rng.range(0.25, 0.45), tip: rng.pick(['none', 'club', 'club']) };
      if (m.kind === 'crystal') m.spines = { count: rng.int(4, 9), len: rng.range(0.2, 0.5) };
      if (m.kind === 'shell') m.plates = 1.2;
      break;
    }
    default: break;
  }
  return m;
}

function colorsFor(rng, family, layerId, role) {
  // Palettes leaning on the layer: surface browns/greys, layer 1 earthy and vivid,
  // layer 2 teal/violet/pale, layer 3 dark reds
  const baseHue = {
    surface: rng.pick([0.07, 0.1, 0.6, 0.0, 0.12]), layer1: rng.range(0, 1), layer2: rng.pick([0.45, 0.5, 0.55, 0.7, 0.78, 0.12, 0.3]), layer3: rng.pick([0.0, 0.02, 0.95, 0.7]),
  }[layerId] ?? rng.range(0, 1);
  let sat = rng.range(0.25, 0.7), light = rng.range(0.3, 0.55);
  if (family === 'lithosere') { sat = rng.range(0.03, 0.18); light = rng.range(0.28, 0.5); }
  if (family === 'bird' || family === 'arthropod') sat += 0.1;
  if (layerId === 'layer3') { light *= 0.6; }
  const primary = hsl(rng, baseHue, sat, light, 0.04);
  const secondary = hsl(rng, baseHue + rng.pick([0.5, 0.08, -0.08, 0.33, 0]), clamp(sat + rng.range(-0.2, 0.2), 0.05, 0.9), clamp(light + rng.range(-0.22, 0.15), 0.1, 0.8), 0.05);
  const belly = hsl(rng, baseHue + rng.range(-0.05, 0.05), sat * 0.5, clamp(light + rng.range(0.1, 0.3), 0.2, 0.9));
  const accentHue = family === 'lithosere' ? rng.pick([0.0, 0.02, 0.55, 0.6, 0.12, 0.33, 0.8]) : rng.range(0, 1);
  const accent = { h: accentHue, s: 0.85, l: 0.55 };
  return { primary, secondary, belly, accent };
}

function behaviourFor(rng, family, role, morph, layerId) {
  const R = ROLES[role];
  const loco = rng.weighted(R.loco);
  let locomotion = loco;
  if (morph.wings.type !== 'none' && morph.wings.flight >= 0.9) locomotion = 'fly';
  else if (morph.wings.type !== 'none' && morph.wings.flight >= 0.4 && morph.wings.flight < 0.9) locomotion = morph.wings.flight > 0.6 ? 'fly' : 'glide';
  else if (locomotion === 'fly' && morph.wings.flight < 0.4) locomotion = morph.legs.biped ? 'run' : 'walk';
  if (morph.legs.pairs === 0 && family === 'reptile') locomotion = 'slither';
  if (morph.kind === 'roller') locomotion = 'roll';
  if (role === 'ceiling_crawler') locomotion = 'ceiling';
  const social = rng.weighted(R.social);
  const groupSize = { solitary: [1, 1], pair: [2, 2], group: [3, 6], herd: [5, 12], flock: [6, 16], swarm: [8, 20], colony: [6, 14], pack: [3, 5], family: [2, 4] }[social];
  const s = morph.size;
  const legLen = morph.legs.len * s * 0.5;
  let walk = clamp(0.6 + legLen * 1.6, 0.4, 3.0);
  let run = walk * (locomotion === 'run' ? rng.range(3.2, 4.5) : rng.range(2.0, 3.0));
  if (family === 'lithosere') { walk *= 0.6; run *= 0.55; }
  if (locomotion === 'fly' || locomotion === 'glide') { walk = clamp(3 + s * 3, 3, 10); run = walk * 1.6; }
  if (locomotion === 'slither') { walk *= 0.8; run *= 0.8; }
  const nocturnalBias = layerId === 'layer2' ? 0.35 : layerId === 'layer3' ? 0.5 : 0.2;
  const activity = rng.chance(nocturnalBias) ? 'nocturnal' : rng.chance(0.25) ? 'crepuscular' : rng.chance(0.2) ? 'cathemeral' : 'diurnal';
  const carn = R.diet === 'carnivore';
  return {
    diet: R.diet,
    locomotion,
    activity,
    social,
    groupSize,
    aggression: clamp(carn ? rng.range(0.5, 1) : rng.range(0, 0.45), 0, 1),
    territoriality: rng.range(0, carn ? 0.9 : 0.6),
    curiosity: rng.range(0, 1),
    fearfulness: clamp(carn ? rng.range(0, 0.4) : rng.range(0.3, 1) - s * 0.08, 0.05, 1),
    perception: clamp(12 + s * 6 + morph.eyes.size * 60 + morph.eyes.count * 1.5, 10, 60),
    speed: { walk, run },
    strength: clamp(s * (family === 'lithosere' ? 1.6 : 1) * (0.6 + morph.legs.thick * 3), 0.05, 10),
    habitat: R.habitat.slice(),
    reproduction: {
      maturity: clamp(120 + s * 140 + rng.range(-40, 40), 80, 900),
      litter: family === 'lithosere' ? 1 : social === 'swarm' || social === 'colony' ? rng.int(2, 4) : s > 2 ? 1 : rng.int(1, 3),
      cooldown: clamp(160 + s * 90 + rng.range(0, 90), 120, 900),
      care: family === 'arthropod' && rng.chance(0.6) ? 'none' : family === 'bird' ? 'nest' : 'follow',
    },
    lifespan: clamp(1500 + s * 800, 900, 6000),
    playerAware: R.playerAware || null,
  };
}

function callFor(rng, family, morph) {
  const size = morph.size;
  const types = {
    mammal: ['growl', 'bleat', 'hoot', 'bark', 'whistle'], reptile: ['hiss', 'croak', 'rattle', 'growl'],
    bird: ['chirp', 'trill', 'caw', 'whistle', 'hoot'], arthropod: ['click', 'buzz', 'chirr'], lithosere: ['grind', 'rumble', 'chime'],
  }[family];
  const type = rng.pick(types);
  const pitch = clamp(900 / (0.5 + size) * rng.range(0.6, 1.5), 60, 4000);
  return { type, pitch, rhythm: rng.int(1, 5), length: rng.range(0.15, 0.9), interval: rng.range(6, 30) };
}

function commonName(rng, sp, used) {
  const m = sp.morph;
  const adjs = [];
  adjs.push(hueName(m.colors.primary.h));
  if (m.pattern.type === 'stripes') adjs.push('Striped');
  if (m.pattern.type === 'spots') adjs.push('Spotted');
  if (m.pattern.type === 'bands') adjs.push('Banded');
  if (m.pattern.type === 'mottled') adjs.push('Mottled');
  if (m.horns.type !== 'none') adjs.push(m.horns.type === 'antlers' ? 'Antlered' : m.horns.type === 'tusks' ? 'Tusked' : m.horns.count >= 3 ? 'Crowned' : 'Horned');
  if (m.spines.count) adjs.push('Spined');
  if (m.crest.type !== 'none') adjs.push('Crested');
  if (m.frill) adjs.push('Frilled');
  if (m.tail.tip === 'club') adjs.push('Clubtail');
  if (m.eyes.count >= 4) adjs.push(['', '', '', '', 'Four-eyed', 'Five-eyed', 'Six-eyed', '', 'Eight-eyed'][m.eyes.count] || 'Many-eyed');
  if (m.neckLen > 0.8) adjs.push('Long-necked');
  if (m.legs.pairs === 3 && sp.family === 'mammal') adjs.push('Six-legged');
  if (sp.behavior.locomotion === 'glide') adjs.push('Gliding');
  if (sp.behavior.activity === 'nocturnal') adjs.push('Night');
  if (m.size > 3) adjs.push('Great');
  if (m.size < 0.3) adjs.push('Lesser');
  const nounList = NOUNS[sp.family][sp.role] || NOUNS[sp.family].default;
  for (let i = 0; i < 30; i++) {
    const noun = rng.pick(nounList);
    const n = i < 10 ? rng.int(1, 1) : 2;
    const picks = rng.shuffle(adjs.slice()).slice(0, n);
    const name = [...picks, noun].join(' ');
    if (!used.has(name)) { used.add(name); return name; }
  }
  const fallback = adjs[0] + ' ' + nounList[0] + ' ' + used.size;
  used.add(fallback);
  return fallback;
}

/** Generate all species for the world. */
export function generateSpecies(seed, names) {
  const species = [];
  const used = new Set();
  const counts = { surface: [4, 5], layer1: [10, 12], layer2: [10, 12], layer3: [1, 2] };
  for (const layer of LAYERS) {
    if (!layer.implemented || !layer.ecology) continue;
    const rng = RNG.derive(seed, 'species', layer.id);
    const [lo, hi] = counts[layer.id] || [3, 5];
    const n = rng.int(lo, hi);
    const roles = layer.ecology.roles.slice();
    const chosenRoles = [];
    // make sure the core roles exist first, then fill the rest
    for (let i = 0; i < n; i++) chosenRoles.push(i < roles.length ? roles[i] : rng.pick(roles));
    chosenRoles.forEach((role, i) => {
      const R = ROLES[role];
      const srng = RNG.derive(seed, 'sp', layer.id, i);
      const family = srng.weighted(Object.entries(R.fam));
      const size = srng.range(R.size[0], R.size[1]);
      const morph = morphology(srng, family, role, size);
      morph.colors = colorsFor(srng, family, layer.id, role);
      morph.pattern = {
        type: srng.weighted([['none', 2], ['stripes', 2], ['spots', 2], ['bands', 1.5], ['mottled', 1.5], ['gradient', 1]]),
        scale: srng.range(0.5, 2.5), contrast: srng.range(0.25, 0.9),
      };
      if (family === 'lithosere') morph.pattern = { type: srng.pick(['mottled', 'none', 'bands']), scale: srng.range(1, 3), contrast: srng.range(0.2, 0.5) };
      const behavior = behaviourFor(srng, family, role, morph, layer.id);
      const sp = {
        id: species.length,
        key: `${layer.id}:${i}`,
        layer: layer.id,
        layerIndex: layer.index,
        role, family,
        morph, behavior,
        call: callFor(srng, family, morph),
        variance: { hue: srng.range(0.01, 0.08), light: srng.range(0.03, 0.12), size: srng.range(0.05, 0.18), proportion: srng.range(0.04, 0.14) },
        relations: { prey: [], predators: [], competitors: [], symbiontOf: null, hosts: [] },
      };
      sp.name = commonName(srng, sp, used);
      sp.binomial = names ? names.binomial('species', layer.id, i) : `Species ${i}`;
      species.push(sp);
    });
  }
  buildFoodWeb(species, seed);
  return species;
}

/** Relationships: predator/prey, competition, symbiosis. */
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
        const sa = a.morph.size, sb = b.morph.size;
        let eats = false;
        if (da === 'carnivore' && b.family !== 'lithosere' && sb < sa * 0.85 && sb > sa * 0.08) eats = true;
        if (da === 'carnivore' && b.family === 'lithosere' && a.family === 'lithosere' && sb < sa * 0.6) eats = true;
        if (da === 'insectivore' && b.family === 'arthropod' && sb < sa * 0.8) eats = true;
        if (da === 'omnivore' && (b.family === 'arthropod') && sb < sa * 0.7) eats = true;
        if (eats) { a.relations.prey.push(b.id); b.relations.predators.push(a.id); }
        if (da === db && da !== 'carnivore' && a.id < b.id && Math.abs(Math.log(sa / sb)) < 1.2) {
          a.relations.competitors.push(b.id); b.relations.competitors.push(a.id);
        }
        if (da === 'carnivore' && db === 'carnivore' && a.id < b.id) { a.relations.competitors.push(b.id); b.relations.competitors.push(a.id); }
      }
    }
    // symbiosis: a small insectivore/omnivore cleans a large herbivore/lithosere
    const hosts = list.filter((s) => s.morph.size > 1.4 && ['grazer', 'browser', 'lithophage'].includes(s.behavior.diet));
    const cleaners = list.filter((s) => s.morph.size < 0.6 && ['insectivore', 'omnivore', 'detritivore'].includes(s.behavior.diet));
    if (hosts.length && cleaners.length) {
      const c = rng.pick(cleaners);
      const h = rng.pick(hosts);
      if (!c.relations.symbiontOf) {
        c.relations.symbiontOf = h.id;
        h.relations.hosts.push(c.id);
        // a cleaner does not get eaten by its host
        h.relations.prey = h.relations.prey.filter((p) => p !== c.id);
        c.relations.predators = c.relations.predators.filter((p) => p !== h.id);
      }
    }
  }
}

/** Per-individual heritable traits. */
export function individualGenes(sp, rng) {
  const v = sp.variance;
  return {
    hue: rng.gauss(0, v.hue),
    light: rng.gauss(0, v.light),
    sat: rng.gauss(0, v.light),
    size: 1 + rng.gauss(0, v.size),
    leg: 1 + rng.gauss(0, v.proportion),
    head: 1 + rng.gauss(0, v.proportion),
    tail: 1 + rng.gauss(0, v.proportion * 1.5),
    pattern: rng.range(-0.5, 0.5),
    sex: rng.chance(0.5) ? 'f' : 'm',
  };
}

/** Offspring genes: blend of parents plus mutation. */
export function inheritGenes(sp, a, b, rng) {
  const mix = (x, y, sd) => lerp(x, y, rng.next()) + rng.gauss(0, sd);
  const v = sp.variance;
  return {
    hue: mix(a.hue, b.hue, v.hue * 0.5),
    light: mix(a.light, b.light, v.light * 0.4),
    sat: mix(a.sat, b.sat, v.light * 0.4),
    size: clamp(mix(a.size, b.size, v.size * 0.4), 0.6, 1.5),
    leg: clamp(mix(a.leg, b.leg, v.proportion * 0.4), 0.7, 1.4),
    head: clamp(mix(a.head, b.head, v.proportion * 0.4), 0.7, 1.4),
    tail: clamp(mix(a.tail, b.tail, v.proportion * 0.5), 0.5, 1.6),
    pattern: clamp(mix(a.pattern, b.pattern, 0.1), -1, 1),
    sex: rng.chance(0.5) ? 'f' : 'm',
  };
}

/** Plain-language appearance summary (catalog). */
export function describeAppearance(sp) {
  const m = sp.morph;
  const sizeWord = m.size > 3.5 ? 'huge' : m.size > 2 ? 'large' : m.size > 0.9 ? 'medium-sized' : m.size > 0.35 ? 'small' : 'tiny';
  const body = m.legs.pairs === 0 ? (sp.family === 'lithosere' ? 'boulder-like' : 'legless, serpentine') : m.legs.biped ? 'bipedal' : `${m.legs.pairs * 2}-legged`;
  const cover = { fur: 'fur', scales: 'scales', feathers: 'feathers', chitin: 'a chitinous shell', stone: 'stony plates' }[m.covering];
  const color = hueName(m.colors.primary.h).toLowerCase();
  const pat = m.pattern.type === 'none' ? '' : ` with ${m.pattern.type === 'gradient' ? 'graded' : m.pattern.type} markings`;
  const parts = [];
  if (m.horns.type !== 'none') parts.push(m.horns.type === 'antlers' ? 'branching antlers' : m.horns.type === 'tusks' ? 'tusks' : `${m.horns.count > 1 ? m.horns.count + ' ' : 'a '}${m.horns.type} horn${m.horns.count > 1 ? 's' : ''}`);
  if (m.crest.type !== 'none') parts.push(`a ${m.crest.type} crest`);
  if (m.frill) parts.push('a neck frill');
  if (m.spines.count) parts.push('dorsal spines');
  if (m.wings.type !== 'none') parts.push(`${m.wings.type === 'insect' ? 'gauzy' : m.wings.type === 'membrane' ? 'membranous' : 'feathered'} wings`);
  if (m.eyes.count > 2) parts.push(`${m.eyes.count} ${m.eyes.glow > 0.3 ? 'glowing ' : ''}eyes`);
  else if (m.eyes.glow > 0.3) parts.push('glowing eyes');
  if (m.tail.tip !== 'none' && m.tail.len > 0.2) parts.push(`a ${m.tail.tip}-tipped tail`);
  if (m.neckLen > 0.8) parts.push('a very long neck');
  if (m.antennae > 0.5) parts.push('long antennae');
  if (m.beakLen > 1.0) parts.push('a long slender beak');
  const feats = parts.length ? ` It has ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts[parts.length - 1]}.` : '';
  return `A ${sizeWord} (${m.size.toFixed(1)} m) ${body} ${FAMILY_LABEL[sp.family].toLowerCase()} covered in ${color} ${cover}${pat}.${feats}`;
}

export const DIET_TEXT = {
  grazer: 'Grazes on grasses and low plants', browser: 'Browses shrubs and foliage', carnivore: 'Hunts other creatures',
  insectivore: 'Feeds on small arthropods', scavenger: 'Scavenges carcasses', piscivore: 'Catches fish in open water',
  nectar: 'Drinks nectar from flowers', detritivore: 'Feeds on decaying matter', lithophage: 'Grinds and eats minerals and lichen',
  omnivore: 'Eats almost anything it can find',
};

export const LOCO_TEXT = {
  walk: 'walks', run: 'runs swiftly', hop: 'hops', fly: 'flies', glide: 'glides between heights', swim: 'swims',
  ceiling: 'clings to ceilings and overhangs', slither: 'slithers', roll: 'rolls its body like a boulder',
};
