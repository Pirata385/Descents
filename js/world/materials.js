// Terrain/structure material registry. Pure data; shared by the generator,
// the chunk mesher (colours), the player (footstep sounds) and creatures (food).

export const M = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  ROCK: 3,
  SAND: 4,
  GRAVEL: 5,
  MOSS: 6,
  DARKROCK: 7,
  COBBLE: 8,
  PLASTER: 9,
  ROOF_A: 10,
  ROOF_B: 11,
  WOOD: 12,
  RUIN: 13,
  RUIN2: 14,
  STONEPLAIN: 15,
  BASALT: 16,
  FIELD: 17,
  WINDOW: 18,
  DOOR: 19,
  BRICK: 20,
  CRYSTAL: 21,
  LITTER: 22,
  CLAY: 23,
  ROOF_C: 24,
  METAL: 25,
  PATH: 26,
  FUNGUS: 27,
  MEADOW: 28,
  SHAFTROCK: 29,
};

/**
 * Per material properties.
 * color: base sRGB colour (0..1)
 * flag: shader effect (0 none, 1 window glow at night, 2 lava veins, 3 crystal glow, 4 fungus glow)
 * sound: footstep class
 * natural: natural terrain (side faces resolve to dirt/rock strata)
 * food: forage tags for herbivores/lithophages
 */
export const MATERIALS = [];
function def(id, name, color, opts = {}) {
  MATERIALS[id] = {
    id, name, color,
    flag: opts.flag || 0,
    sound: opts.sound || 'stone',
    natural: !!opts.natural,
    food: opts.food || null,
    climb: opts.climb ?? 1,
  };
}
def(M.AIR, 'air', [0, 0, 0]);
def(M.GRASS, 'grass', [0.36, 0.62, 0.22], { sound: 'grass', natural: true, food: 'graze' });
def(M.DIRT, 'dirt', [0.45, 0.33, 0.21], { sound: 'dirt', natural: true });
def(M.ROCK, 'rock', [0.52, 0.5, 0.47], { sound: 'stone', natural: true, food: 'mineral' });
def(M.SAND, 'sand', [0.78, 0.7, 0.5], { sound: 'sand', natural: true });
def(M.GRAVEL, 'gravel', [0.55, 0.52, 0.48], { sound: 'gravel', natural: true, food: 'mineral' });
def(M.MOSS, 'moss', [0.2, 0.42, 0.24], { sound: 'grass', natural: true, food: 'graze' });
def(M.DARKROCK, 'dark rock', [0.32, 0.34, 0.36], { sound: 'stone', natural: true, food: 'mineral' });
def(M.COBBLE, 'cobblestone', [0.56, 0.54, 0.5], { sound: 'stone' });
def(M.PLASTER, 'plaster', [0.9, 0.87, 0.8], { sound: 'stone', climb: 0.6 });
def(M.ROOF_A, 'roof tiles', [0.78, 0.38, 0.2], { sound: 'stone' });
def(M.ROOF_B, 'roof tiles', [0.5, 0.25, 0.2], { sound: 'stone' });
def(M.WOOD, 'wood', [0.55, 0.4, 0.26], { sound: 'wood' });
def(M.RUIN, 'ancient stone', [0.66, 0.66, 0.6], { sound: 'stone' });
def(M.RUIN2, 'abyssal masonry', [0.42, 0.48, 0.46], { sound: 'stone' });
def(M.STONEPLAIN, 'pale stone', [0.74, 0.71, 0.64], { sound: 'stone', natural: true, food: 'mineral' });
def(M.BASALT, 'fault basalt', [0.17, 0.15, 0.16], { sound: 'stone', natural: true, flag: 2, food: 'mineral' });
def(M.FIELD, 'crop field', [0.74, 0.66, 0.3], { sound: 'grass', natural: true, food: 'graze' });
def(M.WINDOW, 'window', [0.2, 0.24, 0.3], { sound: 'stone', flag: 1, climb: 0.3 });
def(M.DOOR, 'door', [0.33, 0.22, 0.14], { sound: 'wood' });
def(M.BRICK, 'masonry', [0.62, 0.58, 0.52], { sound: 'stone' });
def(M.CRYSTAL, 'crystal', [0.55, 0.8, 0.9], { sound: 'stone', flag: 3, food: 'mineral' });
def(M.LITTER, 'forest floor', [0.3, 0.3, 0.18], { sound: 'grass', natural: true, food: 'graze' });
def(M.CLAY, 'mud', [0.4, 0.33, 0.25], { sound: 'mud', natural: true });
def(M.ROOF_C, 'roof tiles', [0.36, 0.42, 0.48], { sound: 'stone' });
def(M.METAL, 'metal', [0.42, 0.42, 0.44], { sound: 'metal' });
def(M.PATH, 'packed path', [0.6, 0.5, 0.36], { sound: 'dirt', natural: true });
def(M.FUNGUS, 'glow fungus', [0.25, 0.4, 0.42], { sound: 'grass', natural: true, flag: 4, food: 'graze' });
def(M.MEADOW, 'meadow', [0.48, 0.66, 0.26], { sound: 'grass', natural: true, food: 'graze' });
def(M.SHAFTROCK, 'shaft rock', [0.42, 0.42, 0.42], { sound: 'stone', natural: true, food: 'mineral' });

export const MATERIAL_COUNT = MATERIALS.length;

export function isNatural(m) { return MATERIALS[m] ? MATERIALS[m].natural : false; }
export function isGrassy(m) { return m === M.GRASS || m === M.MEADOW || m === M.MOSS || m === M.FIELD || m === M.LITTER; }
