// Procedural artifact generation. Every artifact is generated from the world
// seed and its site: category, shape archetype and parameters (for the mesh
// builder), material, size, rarity grade, passive effects, an active ability,
// drawbacks, a name and a short origin note. Placement is contextual (ruins,
// cave chambers, spires, crystal geodes, waterfalls, the threshold).
import { RNG } from '../core/rng.js';
import { clamp } from '../core/mathutil.js';
import { LAYERS } from '../world/layers.js';

export const GRADES = ['Fourth Grade', 'Third Grade', 'Second Grade', 'First Grade', 'Special Grade'];
export const CATEGORIES = ['tool', 'relic', 'amulet', 'equipment', 'mechanical', 'scientific', 'weapon', 'organic', 'unknown', 'ritual'];
export const CATEGORY_LABEL = {
  tool: 'Tool', relic: 'Relic', amulet: 'Amulet', equipment: 'Equipment', mechanical: 'Mechanical Object', scientific: 'Scientific Instrument',
  weapon: 'Weapon / Defensive Object', organic: 'Organic Artifact', unknown: 'Unknown Object', ritual: 'Ritual Object',
};

const ARCHETYPES = {
  tool: ['hammer', 'chisel', 'pick', 'compass', 'key'],
  relic: ['orb', 'tablet', 'idolHead', 'crown'],
  amulet: ['ring', 'pendant', 'torc'],
  equipment: ['gauntlet', 'buckle', 'visor', 'boot'],
  mechanical: ['gears', 'clockwork', 'gyro'],
  scientific: ['lens', 'astrolabe', 'flask', 'prism'],
  weapon: ['blade', 'spearhead', 'aegis'],
  organic: ['seedpod', 'shell', 'heartstone', 'coral'],
  unknown: ['knot', 'cubes', 'halo', 'tetra'],
  ritual: ['bowl', 'figurine', 'bell', 'mask'],
};
const NOUNS = {
  hammer: 'Hammer', chisel: 'Chisel', pick: 'Pick', compass: 'Compass', key: 'Key', orb: 'Orb', tablet: 'Tablet', idolHead: 'Idol', crown: 'Crown',
  ring: 'Ring', pendant: 'Pendant', torc: 'Torc', gauntlet: 'Gauntlet', buckle: 'Buckle', visor: 'Visor', boot: 'Sabaton', gears: 'Gearwork',
  clockwork: 'Clockwork', gyro: 'Gyroscope', lens: 'Lens', astrolabe: 'Astrolabe', flask: 'Phial', prism: 'Prism', blade: 'Blade',
  spearhead: 'Spearhead', aegis: 'Aegis', seedpod: 'Seedpod', shell: 'Shell', heartstone: 'Heartstone', coral: 'Coral', knot: 'Knot',
  cubes: 'Nested Cube', halo: 'Halo', tetra: 'Tetrahedron', bowl: 'Bowl', figurine: 'Figurine', bell: 'Bell', mask: 'Mask',
};

export const MATERIALS = {
  bronze: { label: 'bronze', color: [0.72, 0.5, 0.26], metal: 0.8, rough: 0.4, emissive: 0 },
  iron: { label: 'blackened iron', color: [0.3, 0.3, 0.32], metal: 0.7, rough: 0.6, emissive: 0 },
  silver: { label: 'pale silver', color: [0.82, 0.84, 0.88], metal: 0.95, rough: 0.25, emissive: 0 },
  gold: { label: 'tarnished gold', color: [0.85, 0.68, 0.3], metal: 0.95, rough: 0.3, emissive: 0 },
  alloy: { label: 'abyssal alloy', color: [0.4, 0.55, 0.6], metal: 0.9, rough: 0.2, emissive: 0.25 },
  jade: { label: 'jade', color: [0.35, 0.65, 0.48], metal: 0, rough: 0.3, emissive: 0 },
  obsidian: { label: 'obsidian', color: [0.1, 0.09, 0.12], metal: 0.1, rough: 0.1, emissive: 0 },
  bone: { label: 'bone', color: [0.88, 0.84, 0.72], metal: 0, rough: 0.7, emissive: 0 },
  wood: { label: 'petrified wood', color: [0.45, 0.33, 0.22], metal: 0, rough: 0.8, emissive: 0 },
  crystal: { label: 'living crystal', color: [0.6, 0.85, 0.95], metal: 0.1, rough: 0.05, emissive: 0.6 },
  chitin: { label: 'chitin', color: [0.32, 0.22, 0.3], metal: 0.2, rough: 0.3, emissive: 0 },
  flesh: { label: 'warm flesh-like matter', color: [0.75, 0.38, 0.4], metal: 0, rough: 0.5, emissive: 0.15 },
  amber: { label: 'amber', color: [0.95, 0.6, 0.15], metal: 0, rough: 0.15, emissive: 0.3 },
  ceramic: { label: 'glazed ceramic', color: [0.3, 0.45, 0.7], metal: 0, rough: 0.2, emissive: 0 },
  stone: { label: 'carved stone', color: [0.55, 0.53, 0.5], metal: 0, rough: 0.9, emissive: 0 },
};
const MAT_BY_CAT = {
  tool: { bronze: 3, iron: 3, alloy: 1, wood: 1, stone: 1 },
  relic: { gold: 2, jade: 2, obsidian: 2, stone: 2, crystal: 1, alloy: 1 },
  amulet: { silver: 3, gold: 2, jade: 2, bone: 1, amber: 2, crystal: 1 },
  equipment: { iron: 2, bronze: 2, alloy: 2, chitin: 1, bone: 1 },
  mechanical: { bronze: 3, iron: 2, alloy: 3, silver: 1 },
  scientific: { silver: 2, bronze: 2, crystal: 2, ceramic: 1, alloy: 1 },
  weapon: { iron: 2, obsidian: 2, bone: 1, alloy: 2, chitin: 1 },
  organic: { flesh: 3, chitin: 2, bone: 2, amber: 1, wood: 1 },
  unknown: { alloy: 3, crystal: 2, obsidian: 2, flesh: 1 },
  ritual: { bone: 2, ceramic: 2, gold: 2, jade: 1, wood: 1, stone: 2 },
};

/** Passive effects. magnitude ranges scale with grade (0..4). */
export const EFFECTS = {
  stride: { label: 'Stride', desc: (m) => `Running speed +${Math.round(m * 100)}%`, range: [0.06, 0.3], adj: ['Fleet', 'Swift', 'Wind-step'] },
  spring: { label: 'Spring', desc: (m) => `Jump height +${Math.round(m * 100)}%`, range: [0.1, 0.45], adj: ['Leaping', 'Hare-foot'] },
  feather: { label: 'Feather', desc: (m) => `Fall damage -${Math.round(m * 100)}%`, range: [0.2, 0.85], adj: ['Feather', 'Drifting', 'Downy'] },
  grip: { label: 'Grip', desc: (m) => `Climbing stamina use -${Math.round(m * 100)}%`, range: [0.15, 0.55], adj: ['Clinging', 'Gecko'] },
  reach: { label: 'Reach', desc: (m) => `Mechanical arm range +${Math.round(m)} m`, range: [6, 30], adj: ['Far-reaching', 'Long'] },
  winch: { label: 'Winch', desc: (m) => `Arm reel speed +${Math.round(m * 100)}%`, range: [0.15, 0.7], adj: ['Winding', 'Tireless'] },
  lantern: { label: 'Lantern', desc: (m) => `Emits light (radius ${Math.round(m)} m)`, range: [7, 20], adj: ['Glowing', 'Ember', 'Sunlit'] },
  sense: { label: 'Creature Sense', desc: (m) => `Senses creatures within ${Math.round(m)} m on the compass`, range: [40, 110], adj: ['Listening', 'Whispering'] },
  dowsing: { label: 'Dowsing', desc: (m) => `Points toward artifacts within ${Math.round(m)} m`, range: [150, 450], adj: ['Seeking', 'Lodestar'] },
  scholar: { label: 'Insight', desc: (m) => `Observation speed +${Math.round(m * 100)}%`, range: [0.2, 0.9], adj: ["Scholar's", 'Seeing'] },
  vigor: { label: 'Vigor', desc: (m) => `Health regeneration +${m.toFixed(1)}/s`, range: [0.3, 2.0], adj: ['Living', 'Warm'] },
  cartographer: { label: 'Wayfinding', desc: (m) => `Map reveal radius +${Math.round(m * 100)}%`, range: [0.2, 0.8], adj: ["Wanderer's", 'Pathfinding'] },
  swim: { label: 'Current', desc: (m) => `Swimming speed +${Math.round(m * 100)}%`, range: [0.2, 0.8], adj: ['Tidal', 'River'] },
};
export const ABILITIES = {
  flare: { label: 'Flare', desc: 'Bursts with light that floods the surroundings for 25 s.', cooldown: [60, 25], adj: ['Blaze', 'Dawn'] },
  updraft: { label: 'Updraft', desc: 'Launches the bearer upward on a column of air.', cooldown: [45, 15], adj: ['Gale', 'Rising'] },
  pulse: { label: 'Echo Pulse', desc: 'Reveals every creature within 80 m and notes them in the catalog.', cooldown: [90, 35], adj: ['Echo', 'Resonant'] },
  glide: { label: 'Glide', desc: 'While held in the air, slows your fall to a glide.', cooldown: [0, 0], adj: ['Wing', 'Soaring'] },
  survey: { label: 'Survey', desc: 'Reveals the map in a 160 m radius.', cooldown: [120, 50], adj: ['Surveying', 'All-seeing'] },
};
export const DRAWBACKS = {
  heavy: { label: 'Heavy', desc: (m) => `Movement speed -${Math.round(m * 100)}%`, range: [0.04, 0.12] },
  restless: { label: 'Restless', desc: () => 'Hums faintly; nearby creatures grow curious.', range: [1, 1] },
  dim: { label: 'Draining', desc: (m) => `Stamina regeneration -${Math.round(m * 100)}%`, range: [0.1, 0.3] },
};

function pickWeighted(rng, obj) { return rng.weighted(Object.entries(obj)); }

function shapeParams(rng, archetype) {
  // Parameters consumed by the mesh builder; ranges are deliberately broad so
  // two artifacts of the same archetype still look different.
  return {
    archetype,
    a: rng.range(0, 1), b: rng.range(0, 1), c: rng.range(0, 1), d: rng.range(0, 1),
    segments: rng.int(3, 9), twist: rng.range(-1, 1), symmetry: rng.pick([2, 3, 4, 5, 6, 8]),
    inlay: rng.chance(0.5), spikes: rng.chance(0.3), rings: rng.int(0, 3),
  };
}

const ORIGIN_SNIPPETS = [
  'Its maker is unknown; the workmanship predates the city by ages.',
  'Delvers say similar pieces surface after great collapses in the Abyss.',
  'Faint script circles it in a language no scholar can read.',
  'It is warm to the touch no matter how cold the air.',
  'The Guild archives list no comparable find.',
  'It seems to have been deliberately placed, as if left as an offering.',
  'Scratches suggest it was carried for a long time by someone, or something.',
  'Under a lens, its surface is patterned like the rings of a tree.',
  'It rings softly when the wind passes over it.',
  'The deeper it was found, the stranger it feels to hold.',
];

export function generateArtifact(seed, id, site, names) {
  const layer = LAYERS[clamp(site.layer, 0, 3)];
  const rng = RNG.derive(seed, 'artifact', id);
  const pool = layer.artifacts || LAYERS[1].artifacts;
  const category = pickWeighted(rng, pool.categories);
  const grade = rng.weighted(pool.rarity.map((w, i) => [i, w]));
  const archetype = rng.pick(ARCHETYPES[category]);
  const matKey = pickWeighted(rng, MAT_BY_CAT[category]);
  const mat = MATERIALS[matKey];
  const size = clamp(rng.range(0.12, 0.5) * (category === 'weapon' || category === 'tool' ? 1.4 : 1) * (archetype === 'crown' || archetype === 'aegis' ? 1.3 : 1), 0.08, 0.8);
  // effects by grade
  const effects = [];
  const nEff = [rng.chance(0.45) ? 1 : 0, 1, rng.int(1, 2), 2, rng.int(2, 3)][grade];
  const effKeys = rng.shuffle(Object.keys(EFFECTS)).slice(0, nEff);
  for (const k of effKeys) {
    const E = EFFECTS[k];
    const t = clamp(grade / 4 + rng.range(-0.15, 0.2), 0, 1);
    const m = E.range[0] + (E.range[1] - E.range[0]) * t;
    effects.push({ type: k, magnitude: m });
  }
  let ability = null;
  if (grade >= 3 || (grade === 2 && rng.chance(0.35))) {
    const k = rng.pick(Object.keys(ABILITIES));
    const A = ABILITIES[k];
    const t = grade / 4;
    ability = { type: k, cooldown: Math.round(A.cooldown[0] + (A.cooldown[1] - A.cooldown[0]) * t), power: 0.6 + t * 0.8 };
  }
  let drawback = null;
  if (rng.chance(0.18 + grade * 0.06) && (effects.length || ability)) {
    const k = rng.pick(Object.keys(DRAWBACKS));
    const D = DRAWBACKS[k];
    drawback = { type: k, magnitude: rng.range(D.range[0], D.range[1]) };
  }
  // name
  const noun = NOUNS[archetype];
  let adj;
  if (ability && rng.chance(0.6)) adj = rng.pick(ABILITIES[ability.type].adj);
  else if (effects.length) adj = rng.pick(EFFECTS[effects[0].type].adj);
  else adj = rng.pick(['Silent', 'Hollow', 'Forgotten', 'Weeping', 'Sleeping', 'Unheard', 'Patient', 'Crooked', 'Lonely', 'Pale']);
  let name = `${adj} ${noun}`;
  if (grade >= 3 && names) name += ` of ${names.name('artifactname', id)}`;
  const appearance = describeArtifact(rng, category, archetype, mat, size);
  const origin = rng.pick(ORIGIN_SNIPPETS);
  return {
    id, seed: RNG.derive(seed, 'artshape', id).seed,
    name, category, grade, gradeLabel: GRADES[grade], archetype, material: matKey,
    color: mat.color.map((v) => clamp(v + rng.range(-0.06, 0.06), 0, 1)),
    glow: clamp(mat.emissive + (ability ? 0.25 : 0) + grade * 0.05, 0, 1),
    accent: [rng.range(0.2, 1), rng.range(0.2, 1), rng.range(0.2, 1)],
    size, weight: Math.round(size * size * (mat.metal > 0.5 ? 9 : 4) * 10) / 10,
    shape: shapeParams(RNG.derive(seed, 'artshape', id), archetype),
    effects, ability, drawback, appearance, origin,
    site: { x: site.x, y: site.y, z: site.z, layer: site.layer, context: site.context, place: site.place, kind: site.kind },
  };
}

function describeArtifact(rng, category, archetype, mat, size) {
  const sz = size > 0.5 ? 'large' : size > 0.3 ? 'hand-sized' : 'small';
  const feel = rng.pick(['smooth', 'pitted', 'finely engraved', 'oddly warm', 'cold', 'faintly humming', 'heavier than it looks', 'lighter than it looks']);
  return `A ${sz} ${NOUNS[archetype].toLowerCase()} of ${mat.label}, ${feel}.`;
}

/** All artifacts for a world from contextual sites. Respects per-layer counts. */
export function generateArtifacts(seed, sites, names) {
  const rng = RNG.derive(seed, 'artifactsites');
  const byLayer = {};
  for (const s of sites) (byLayer[s.layer] = byLayer[s.layer] || []).push(s);
  const chosen = [];
  for (const [li, list] of Object.entries(byLayer)) {
    const layer = LAYERS[Number(li)];
    const want = layer?.artifacts?.count ?? 5;
    // prefer variety of site kinds
    rng.shuffle(list);
    list.sort((a, b) => (a.kind === 'cave' ? 1 : 0) - (b.kind === 'cave' ? 1 : 0));
    for (const s of list.slice(0, want)) chosen.push(s);
  }
  return chosen.map((s, i) => generateArtifact(seed, i, s, names));
}

export function describeEffect(e) { return EFFECTS[e.type].desc(e.magnitude); }
export function describeAbility(a) { return `${ABILITIES[a.type].label}: ${ABILITIES[a.type].desc}${a.cooldown ? ` (recharges in ${a.cooldown} s)` : ''}`; }
export function describeDrawback(d) { return `${DRAWBACKS[d.type].label}: ${DRAWBACKS[d.type].desc(d.magnitude)}`; }
