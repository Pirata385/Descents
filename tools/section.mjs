// Debug: render a vertical section of the world as a PNG.
// usage: node tools/section.mjs <seed> <out.png> [angleDeg] [halfWidth] [yTop] [yBot] [mPerPx]
// The section passes through the Great Fault centre at the given angle.
import { generatePlan } from '../js/world/plan.js';
import { ColumnGen, ColumnData, CF } from '../js/world/column.js';
import { MATERIALS } from '../js/world/materials.js';
import { writePNG } from './png.js';

const [seed = '12345', out = 'section.png', angDeg = '0', halfW = '420', yTopS, yBotS, mpp = '2'] = process.argv.slice(2);
const t0 = performance.now();
const plan = generatePlan(seed);
console.log('plan ms', Math.round(performance.now() - t0), 'valid', plan.validation.ok);
const gen = new ColumnGen(plan);
const col = new ColumnData();
const p = plan.params;
const ang = (Number(angDeg) * Math.PI) / 180;
const HW = Number(halfW), S = Number(mpp);
const yTop = yTopS ? Number(yTopS) : p.plainY + 80;
const yBot = yBotS ? Number(yBotS) : -2070;
const W = Math.round((2 * HW) / S), H = Math.round((yTop - yBot) / S);
const rgb = new Uint8Array(W * H * 3);
const cx = p.fault.x, cz = p.fault.z;
let evals = 0, colMs = 0;
const t1 = performance.now();
for (let i = 0; i < W; i++) {
  const s = -HW + (i + 0.5) * S;
  const x = cx + Math.cos(ang) * s, z = cz + Math.sin(ang) * s;
  const tc = performance.now();
  gen.column(x, z, 0, col);
  colMs += performance.now() - tc;
  evals++;
  for (let j = 0; j < H; j++) {
    const y = yTop - (j + 0.5) * S;
    let c = [10, 12, 22];
    for (let k = 0; k < col.n; k++) {
      if (y > col.y0[k] && y <= col.y1[k]) {
        const m = MATERIALS[y > col.y1[k] - S ? col.top[k] : col.side[k]] || MATERIALS[3];
        const shade = 0.55 + 0.45 * Math.min(1, Math.max(0, (y + 2100) / 1300));
        c = m.color.map((v) => Math.round(v * 255 * shade));
        if (col.flags & CF.CAVE) c = c.map((v) => Math.min(255, v + 0));
        break;
      }
    }
    for (let w = 0; w < col.nw; w++) if (y <= col.wl[w] && y > col.y1[col.wsp[w]]) c = [40, 90, 160];
    const o = (j * W + i) * 3;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
}
console.log('columns', evals, 'us/col', (colMs * 1000 / evals).toFixed(1), 'total ms', Math.round(performance.now() - t1));
writePNG(out, W, H, rgb);
console.log('wrote', out, W, 'x', H);
