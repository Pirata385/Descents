// Debug: unrolled map of the Layer 3 cave network. x = angle around the chasm
// axis, y = depth. Passages, halls, windows, dens and sinkholes are drawn.
// usage: node tools/fault-map.mjs <seed> <out.png>
import { generatePlan } from '../js/world/plan.js';
import { ColumnGen } from '../js/world/column.js';
import { writePNG } from './png.js';

const [seed = '12345', out = 'fault-map.png'] = process.argv.slice(2);
const plan = generatePlan(seed);
const gen = new ColumnGen(plan);
const ch = gen.chasm;
const p = plan.params;
const W = 900, H = 700;
const yTop = p.plainY + 20, yBot = p.chasm.floorY - 30;
const rgb = new Uint8Array(W * H * 3).fill(16);
const px = (x, y, z) => {
  const [cx, cz] = ch.centreAt(y);
  const phi = Math.atan2(z - cz, x - cx);
  return [Math.floor(((phi + Math.PI) / (2 * Math.PI)) * W), Math.floor(((yTop - y) / (yTop - yBot)) * H)];
};
const dot = (i, j, c, r = 1) => {
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    const x = i + di, y = j + dj;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const o = (y * W + x) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
};
const COL = { fault: [220, 160, 90], sinkhole: [120, 220, 120], window: [90, 170, 255], den: [200, 90, 200], hall: [255, 255, 255], gate: [255, 220, 60] };
for (const c of plan.caves) {
  if (!COL[c.kind] || !c.nodes) continue;
  for (let i = 0; i < c.nodes.length; i++) {
    const n = c.nodes[i];
    const [a, b] = px(n.x, n.y, n.z);
    dot(a, b, COL[c.kind], c.kind === 'hall' ? 4 : 1);
    if (i) {
      const m = c.nodes[i - 1];
      const [a0, b0] = px(m.x, m.y, m.z);
      if (Math.abs(a - a0) < W / 2) for (let t = 0; t <= 1; t += 0.1) dot(Math.round(a0 + (a - a0) * t), Math.round(b0 + (b - b0) * t), COL[c.kind], 0);
    }
  }
}
for (const s of plan.fault.shelves) { const [a, b] = px(s.x, s.y, s.z); dot(a, b, [80, 120, 80], 2); }
for (const n of plan.fault.nests) { const [a, b] = px(n.x, n.y, n.z); dot(a, b, [160, 120, 60], 0); }
writePNG(out, W, H, rgb);
console.log('wrote', out, 'halls', plan.fault.halls.length, 'valid', plan.validation.ok);
