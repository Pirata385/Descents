// Debug: render the macro surface of a seed as a shaded top-down PNG.
import { makeParams } from '../js/world/params.js';
import { TerrainField, Z_EYE } from '../js/world/field.js';
import { writePNG } from './png.js';
import { normalizeSeed } from '../js/core/rng.js';

const seed = normalizeSeed(process.argv[2] || '12345');
const out = process.argv[3] || 'field.png';
const scale = Number(process.argv[4] || 4);
const p = makeParams(seed);
const f = new TerrainField(p);
const W = Math.floor(3000 / scale), H = Math.floor(2600 / scale);
const hs = new Float32Array(W * H);
const sea = new Uint8Array(W * H);
const P = {}, S = {};
const t0 = performance.now();
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const x = -1500 + (i + 0.5) * scale, z = -1300 + (j + 0.5) * scale;
  f.polar(x, z, P);
  if (P.zone === Z_EYE) { hs[j * W + i] = NaN; continue; }
  f.surface(x, z, P, S);
  hs[j * W + i] = S.h;
  sea[j * W + i] = (P.r > P.Rc - 40 && S.h < p.seaY) ? 1 : 0;
}
console.log('eval ms', (performance.now() - t0).toFixed(0), 'per sample us', ((performance.now() - t0) * 1000 / (W * H)).toFixed(2));
const rgb = new Uint8Array(W * H * 3);
let mn = 1e9, mx = -1e9;
for (const h of hs) if (!Number.isNaN(h)) { mn = Math.min(mn, h); mx = Math.max(mx, h); }
console.log('height range', mn.toFixed(1), mx.toFixed(1));
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const h = hs[j * W + i];
  const k = (j * W + i) * 3;
  if (Number.isNaN(h)) { rgb[k] = 10; rgb[k + 1] = 10; rgb[k + 2] = 20; continue; }
  const hx = hs[j * W + Math.min(W - 1, i + 1)], hz = hs[Math.min(H - 1, j + 1) * W + i];
  let shade = 1;
  if (!Number.isNaN(hx) && !Number.isNaN(hz)) shade = 0.75 + Math.max(-0.5, Math.min(0.5, ((h - hx) + (h - hz)) / scale * 0.6));
  let c;
  if (sea[j * W + i]) c = [40, 80, 140];
  else {
    const t = (h - mn) / (mx - mn);
    const cols = [[90, 60, 40], [110, 140, 70], [150, 170, 90], [200, 190, 140], [240, 240, 230]];
    const ft = t * (cols.length - 1);
    const a = Math.floor(ft), b = Math.min(cols.length - 1, a + 1), u = ft - a;
    c = cols[a].map((v, q) => v + (cols[b][q] - v) * u);
  }
  rgb[k] = Math.min(255, c[0] * shade); rgb[k + 1] = Math.min(255, c[1] * shade); rgb[k + 2] = Math.min(255, c[2] * shade);
}
writePNG(out, W, H, rgb);
console.log('wrote', out, W, H);
