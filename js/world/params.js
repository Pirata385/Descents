// World parameters derived deterministically from the seed. These control the
// macro shape of the Abyss (eye, rim, bowl, galleries, plain, fault), the city
// style and the colour palette. Everything downstream reads from here.
import { RNG } from '../core/rng.js';
import { M, MATERIALS } from './materials.js';
import { hsl2rgb, mixRGB } from '../core/mathutil.js';
import { LAYER_BOUNDARIES } from './layers.js';

export const WORLD_HALF_X = 1500;      // 3000 hex columns wide (1 m per column)
export const WORLD_HALF_Z = 1299;      // 3000 hex rows (0.866 m per row)
export const BOTTOM_Y = -1120;
export const SEA_Y = -26;

const ROOF_PALETTES = [
  [[0.78, 0.38, 0.2], [0.62, 0.27, 0.18], [0.85, 0.5, 0.28]],   // terracotta
  [[0.36, 0.42, 0.5], [0.3, 0.33, 0.4], [0.45, 0.5, 0.56]],      // slate
  [[0.32, 0.55, 0.48], [0.25, 0.45, 0.42], [0.4, 0.62, 0.55]],   // copper
  [[0.55, 0.34, 0.24], [0.42, 0.28, 0.22], [0.68, 0.45, 0.3]],   // brown tile
  [[0.7, 0.24, 0.22], [0.55, 0.2, 0.2], [0.82, 0.36, 0.3]],      // red
];
const WALL_PALETTES = [
  [0.92, 0.89, 0.82], [0.88, 0.82, 0.68], [0.86, 0.78, 0.74], [0.8, 0.8, 0.78], [0.9, 0.86, 0.74],
];

export function makeParams(seed) {
  const rng = RNG.derive(seed, 'params');
  const eyeR = rng.range(215, 252);
  const lipY = rng.range(-232, -205);
  const plainY = rng.range(-872, -852);
  const bellExtra = rng.range(175, 230);
  const bellH = rng.range(125, 155);

  // Gallery tiers (Layer 2 inverted forest). Tier 0 starts right at the layer boundary.
  const galleries = [];
  const g0Top = LAYER_BOUNDARIES.layer2Top - rng.range(6, 14);
  const g0H = rng.range(105, 128);
  galleries.push({ yTop: g0Top, height: g0H, depthMin: 40, depthMax: rng.range(150, 185), open: rng.range(0.25, 0.4), seed: rng.int(1, 1e9), forest: 1 });
  const g1Top = g0Top - g0H - rng.range(55, 80);
  const g1H = rng.range(80, 98);
  galleries.push({ yTop: g1Top, height: g1H, depthMin: 30, depthMax: rng.range(110, 140), open: rng.range(0.1, 0.25), seed: rng.int(1, 1e9), forest: 0.75 });
  const bellTop = plainY + bellH;
  const g2Top = g1Top - g1H - rng.range(35, 45);
  const g2H = rng.range(45, 60);
  if (g2Top - g2H > bellTop + 18) {
    galleries.push({ yTop: g2Top, height: g2H, depthMin: 25, depthMax: rng.range(70, 95), open: rng.range(-0.05, 0.1), seed: rng.int(1, 1e9), forest: 0.5 });
  }

  const faultAngle = rng.range(0, Math.PI * 2);
  const faultR = rng.range(62, 84);
  const faultDist = rng.range(0.22, 0.42) * eyeR;

  // Palette
  const grassHue = rng.range(0.22, 0.33);
  const grass = hsl2rgb(grassHue, rng.range(0.42, 0.6), rng.range(0.36, 0.44));
  const meadow = hsl2rgb(grassHue - rng.range(0.02, 0.06), rng.range(0.45, 0.62), rng.range(0.42, 0.5));
  const mossHue = rng.range(0.3, 0.45);
  const roofs = rng.pick(ROOF_PALETTES);
  const altRoofs = rng.pick(ROOF_PALETTES);
  const wall = rng.pick(WALL_PALETTES);
  const rockTint = hsl2rgb(rng.range(0.05, 0.12), rng.range(0.05, 0.18), rng.range(0.46, 0.54));
  const palette = MATERIALS.map((m) => m.color.slice());
  palette[M.GRASS] = grass;
  palette[M.MEADOW] = meadow;
  palette[M.MOSS] = hsl2rgb(mossHue, rng.range(0.35, 0.55), rng.range(0.26, 0.33));
  palette[M.LITTER] = hsl2rgb(mossHue - 0.12, rng.range(0.3, 0.45), rng.range(0.22, 0.28));
  palette[M.ROOF_A] = roofs[0];
  palette[M.ROOF_B] = roofs[1];
  palette[M.ROOF_C] = altRoofs[2];
  palette[M.PLASTER] = wall;
  palette[M.ROCK] = rockTint;
  palette[M.SHAFTROCK] = mixRGB(rockTint, [0.36, 0.38, 0.4], 0.5);
  palette[M.STONEPLAIN] = hsl2rgb(rng.range(0.08, 0.14), rng.range(0.1, 0.22), rng.range(0.66, 0.74));
  palette[M.FIELD] = hsl2rgb(rng.range(0.1, 0.16), rng.range(0.45, 0.6), rng.range(0.48, 0.56));

  const foliage = {
    l1: hsl2rgb(grassHue + rng.range(-0.02, 0.03), rng.range(0.4, 0.55), rng.range(0.3, 0.38)),
    l1b: hsl2rgb(grassHue + rng.range(0.03, 0.08), rng.range(0.35, 0.5), rng.range(0.26, 0.34)),
    inverted: hsl2rgb(rng.range(0.42, 0.56), rng.range(0.35, 0.6), rng.range(0.3, 0.4)),
    invertedGlow: hsl2rgb(rng.range(0.45, 0.62), 0.8, 0.6),
    bark: hsl2rgb(rng.range(0.06, 0.1), rng.range(0.15, 0.3), rng.range(0.3, 0.42)),
    paleBark: hsl2rgb(rng.range(0.08, 0.14), rng.range(0.05, 0.15), rng.range(0.66, 0.78)),
    plainTree: hsl2rgb(rng.range(0.08, 0.5), rng.range(0.25, 0.45), rng.range(0.32, 0.42)),
    flowers: [hsl2rgb(rng.range(0, 1), 0.7, 0.62), hsl2rgb(rng.range(0, 1), 0.6, 0.7), hsl2rgb(rng.range(0, 1), 0.65, 0.6)],
  };

  return {
    seed,
    version: 1,
    worldHalfX: WORLD_HALF_X,
    worldHalfZ: WORLD_HALF_Z,
    bottomY: BOTTOM_Y,
    seaY: SEA_Y,
    warpAmp: rng.range(14, 26),
    eyeR,
    lipY,
    rimR: rng.range(740, 815),
    bowlTopY: rng.range(-46, -32),
    cityY: rng.range(6, 13),
    ridgeY: rng.range(34, 56),
    ridgeOffset: rng.range(250, 320),
    coastR: rng.range(1140, 1185),
    cityDepth: rng.range(205, 265),
    terraceStep: rng.range(26, 40),
    terraceSharp: rng.range(0.6, 0.78),
    hillAmp: rng.range(12, 22),
    ravineDepth: rng.range(14, 26),
    outcropAmp: rng.range(18, 32),
    plainY,
    bellR: eyeR + bellExtra,
    bellH,
    galleries,
    fault: {
      x: Math.cos(faultAngle) * faultDist,
      z: Math.sin(faultAngle) * faultDist,
      r: faultR,
      bottomY: plainY - rng.range(215, 240),
      thresholdY: LAYER_BOUNDARIES.layer3Top - rng.range(45, 65),
    },
    spiral: {
      startAngle: rng.range(0, Math.PI * 2),
      dir: rng.chance(0.5) ? 1 : -1,
      slope: rng.range(0.19, 0.23),
    },
    city: {
      radials: rng.int(9, 14),
      density: rng.range(0.7, 1.0),
      floorsBias: rng.range(-0.3, 0.6),
      hipRoofs: rng.range(0.1, 0.45),
      towerChance: rng.range(0.03, 0.08),
      hamlets: rng.int(4, 7),
      windmills: rng.int(7, 13),
    },
    palette,
    foliage,
  };
}
