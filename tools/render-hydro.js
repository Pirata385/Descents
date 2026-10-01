// Debug: render coarse grid + rivers + lakes.
import { makeParams } from '../js/world/params.js';
import { TerrainField, Z_EYE, Z_SEA } from '../js/world/field.js';
import { buildCoarseGrid, computeHydrology, buildRivers } from '../js/world/hydrology.js';
import { writePNG } from './png.js';
import { normalizeSeed, RNG } from '../js/core/rng.js';

const seed = normalizeSeed(process.argv[2] || '12345');
const out = process.argv[3] || 'hydro.png';
const p = makeParams(seed);
const f = new TerrainField(p);
let t0 = performance.now();
const coarse = buildCoarseGrid(f);
console.log('coarse ms', (performance.now() - t0).toFixed(0));
t0 = performance.now();
const hydro = computeHydrology(f, coarse, new RNG(1));
console.log('hydro ms', (performance.now() - t0).toFixed(0), 'lakes', hydro.lakes.length, 'raw rivers', hydro.rawRivers.length);
t0 = performance.now();
const { rivers, eyeFalls } = buildRivers(f, hydro, coarse);
console.log('rivers ms', (performance.now() - t0).toFixed(0), 'rivers', rivers.length, 'eyeFalls', eyeFalls.length);
console.log(rivers.map((r) => `${r.id}:${r.end}:${r.length}m`).join(' '));
console.log(hydro.lakes.map((l) => `lake${l.id} lvl ${l.level.toFixed(1)} cells ${l.cells} d ${l.depth.toFixed(1)}`).join('\n'));
const { nx, nz, h, zone } = coarse;
const S = 2;
const W = nx * S, H = nz * S;
const rgb = new Uint8Array(W * H * 3);
let mn = 1e9, mx = -1e9;
for (let k = 0; k < nx * nz; k++) if (zone[k] !== Z_EYE) { mn = Math.min(mn, h[k]); mx = Math.max(mx, h[k]); }
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const k = ((j / S) | 0) * nx + ((i / S) | 0);
  const o = (j * W + i) * 3;
  let c;
  if (zone[k] === Z_EYE) c = [10, 10, 20];
  else if (zone[k] === Z_SEA) c = [40, 80, 140];
  else if (hydro.lakeId[k]) c = [60, 120, 200];
  else { const t = (h[k] - mn) / (mx - mn); c = [80 + 150 * t, 110 + 120 * t, 60 + 100 * t]; }
  rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
}
for (const r of rivers) {
  for (let i = 0; i < r.x.length; i++) {
    const px = Math.floor((r.x[i] + 1500) / 8 * S), pz = Math.floor((r.z[i] + 1300) / 8 * S);
    const fall = r.fall[i] > 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const xx = px + a, zz = pz + b;
      if (xx < 0 || zz < 0 || xx >= W || zz >= H) continue;
      const o = (zz * W + xx) * 3;
      rgb[o] = fall ? 255 : 30; rgb[o + 1] = fall ? 255 : 90; rgb[o + 2] = fall ? 255 : 255;
    }
  }
}
writePNG(out, W, H, rgb);
