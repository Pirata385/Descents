// Layer registry. Each layer of the Abyss is described by data: depth range,
// visual identity, atmosphere, audio, ecology (species roles), artifact pools,
// vegetation and traversal notes. Terrain rules live in the layer generator
// modules (js/world/gen/*) that are registered by id in LAYER_GENERATORS.
// Adding a deeper layer means appending an entry here and a generator module.

export const LAYER_BOUNDARIES = {
  layer1Top: 80,      // above this is sky
  layer2Top: -350,    // depth 350 m below the rim
  layer3Top: -900,    // depth 900 m
  layer4Top: -2600,   // future
};

export const LAYERS = [
  {
    id: 'surface',
    index: 0,
    name: 'The Surface',
    title: 'Rim City',
    depthLabel: 'Surface',
    yTop: 200,
    yBottom: -40,
    implemented: true,
    visuals: {
      fogColor: [0.7, 0.8, 0.9], fogDensity: 0.00075,
      skyTint: [1, 1, 1], ambient: [0.62, 0.68, 0.78], sun: [1.0, 0.95, 0.86],
      particles: 'dust',
    },
    audio: { wind: 0.35, water: 1, birds: 0.7, city: 0.8, drips: 0, reverb: 0.05, music: 'city' },
    ecology: {
      roles: ['urban_flier', 'urban_small', 'scavenger_flier', 'pollinator'],
      density: 0.6,
    },
    artifacts: { count: 3, rarity: [0.85, 0.15, 0, 0, 0], categories: { tool: 3, mechanical: 2, scientific: 2, relic: 1 } },
    vegetation: { grass: 0.5, flowers: 0.25, shrubs: 0.1, trees: 0.08 },
    traversal: 'Streets, stairways and observation decks. The Descent Gates lead down the rim cliff.',
  },
  {
    id: 'layer1',
    index: 1,
    name: 'First Layer',
    title: 'The Verdant Edge',
    depthLabel: '0 - 350 m',
    yTop: -20,
    yBottom: -350,
    implemented: true,
    visuals: {
      fogColor: [0.66, 0.76, 0.84], fogDensity: 0.0011,
      skyTint: [1, 1, 1], ambient: [0.58, 0.66, 0.7], sun: [1.0, 0.94, 0.82],
      particles: 'pollen',
    },
    audio: { wind: 0.55, water: 1, birds: 1, city: 0, drips: 0.1, reverb: 0.08, music: 'verdant' },
    ecology: {
      roles: ['grazer', 'grazer_small', 'browser', 'mesopredator', 'apex_predator', 'insectivore_flier',
        'scavenger_flier', 'piscivore', 'pollinator', 'decomposer', 'lithophage', 'cliff_glider'],
      density: 1,
    },
    artifacts: { count: 26, rarity: [0.6, 0.3, 0.09, 0.01, 0], categories: { tool: 3, relic: 3, amulet: 2, equipment: 2, mechanical: 2, scientific: 2, weapon: 1, organic: 1, unknown: 1, ritual: 2 } },
    vegetation: { grass: 1, flowers: 0.5, shrubs: 0.35, trees: 0.05 },
    traversal: 'Terraced plains and cliffs. Roads and stairways descend toward the Abyss Eye; the upper shaft walls require care or the mechanical arm.',
  },
  {
    id: 'layer2',
    index: 2,
    name: 'Second Layer',
    title: 'The Inverted Forest',
    depthLabel: '350 - 900 m',
    yTop: -350,
    yBottom: -900,
    implemented: true,
    visuals: {
      fogColor: [0.2, 0.32, 0.31], fogDensity: 0.0024,
      skyTint: [0.7, 0.85, 0.8], ambient: [0.36, 0.5, 0.48], sun: [0.72, 0.86, 0.78],
      particles: 'spores',
    },
    audio: { wind: 0.35, water: 1, birds: 0.6, city: 0, drips: 0.6, reverb: 0.35, music: 'inverted' },
    ecology: {
      roles: ['ceiling_crawler', 'grazer', 'browser', 'mesopredator', 'apex_predator', 'insectivore_flier',
        'lithophage', 'lithophage_large', 'decomposer', 'cliff_glider', 'ambush_predator', 'scavenger_flier'],
      density: 1,
    },
    artifacts: { count: 30, rarity: [0.35, 0.38, 0.2, 0.06, 0.01], categories: { relic: 3, amulet: 2, equipment: 2, mechanical: 2, scientific: 2, weapon: 1, organic: 3, unknown: 2, ritual: 2, tool: 1 } },
    vegetation: { grass: 0.4, flowers: 0.2, shrubs: 0.6, trees: 0.3, invertedTrees: 1, vines: 1 },
    traversal: 'Galleries carved into the shaft walls hold an upside-down forest. The Great Spiral ledge winds down to the Stone Plain.',
  },
  {
    id: 'layer3',
    index: 3,
    name: 'Third Layer',
    title: 'The Great Fault',
    depthLabel: '900 - 2600 m',
    yTop: -900,
    yBottom: -2600,
    implemented: true,
    partial: true,
    visuals: {
      fogColor: [0.16, 0.1, 0.1], fogDensity: 0.006,
      skyTint: [0.5, 0.4, 0.4], ambient: [0.28, 0.2, 0.2], sun: [0.5, 0.36, 0.3],
      particles: 'embers',
    },
    audio: { wind: 0.7, water: 0.3, birds: 0, city: 0, drips: 0.4, reverb: 0.6, music: 'fault' },
    ecology: {
      roles: ['fault_stalker'],
      density: 0.4,
      playerAware: true,
    },
    artifacts: { count: 4, rarity: [0.1, 0.3, 0.35, 0.2, 0.05], categories: { relic: 2, unknown: 3, organic: 1, weapon: 1, ritual: 1 } },
    vegetation: { grass: 0, flowers: 0, shrubs: 0.05, trees: 0 },
    traversal: 'A vertical maze of shafts. Only the threshold has been charted.',
  },
  { id: 'layer4', index: 4, name: 'Fourth Layer', title: 'Uncharted', depthLabel: '2600 - 4000 m', yTop: -2600, yBottom: -4000, implemented: false },
  { id: 'layer5', index: 5, name: 'Fifth Layer', title: 'Uncharted', depthLabel: '4000 - 6000 m', yTop: -4000, yBottom: -6000, implemented: false },
  { id: 'layer6', index: 6, name: 'Sixth Layer', title: 'Uncharted', depthLabel: '6000 - 12000 m', yTop: -6000, yBottom: -12000, implemented: false },
  { id: 'layer7', index: 7, name: 'Seventh Layer', title: 'Uncharted', depthLabel: '12000 m +', yTop: -12000, yBottom: -20000, implemented: false },
];

export const LAYER_BY_ID = Object.fromEntries(LAYERS.map((l) => [l.id, l]));

/**
 * Determine the layer for a world position. zoneIsSurface is true for
 * positions outside the rim of the bowl (city / countryside / coast).
 */
export function layerIndexAt(y, zoneIsSurface) {
  if (zoneIsSurface && y > LAYER_BOUNDARIES.layer2Top) return 0;
  if (y > LAYER_BOUNDARIES.layer2Top) return 1;
  if (y > LAYER_BOUNDARIES.layer3Top) return 2;
  if (y > LAYER_BOUNDARIES.layer4Top) return 3;
  return 4;
}

export function layerById(id) { return LAYER_BY_ID[id]; }
