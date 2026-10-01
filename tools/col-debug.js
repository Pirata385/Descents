import { generatePlan } from '../js/world/plan.js';
import { ColumnGen, ColumnData } from '../js/world/column.js';
const [seed, ...coords] = process.argv.slice(2);
const plan = generatePlan(seed);
const gen = new ColumnGen(plan);
const col = new ColumnData();
for (let i = 0; i < coords.length; i += 2) {
  const x = Number(coords[i]), z = Number(coords[i + 1]);
  gen.column(x, z, 0, col);
  const P = gen.field.polar(x, z, {});
  console.log(`col ${x},${z} zone ${col.zone} flags ${col.flags} r ${P.r.toFixed(1)} Re ${P.Re.toFixed(1)}`);
  for (let k = 0; k < col.n; k++) console.log(`  [${col.y0[k]}, ${col.y1[k]}] top ${col.top[k]} side ${col.side[k]} exp ${col.exp[k].toFixed(2)}`);
  for (let k = 0; k < col.nw; k++) console.log(`  water ${col.wl[k].toFixed(2)} kind ${col.wkind[k]} on span ${col.wsp[k]}`);
  // routes nearby
  for (const code of gen.routeGrid.query(x, z)) {
    const ri = Math.floor(code / 65536), si = code % 65536;
    const rt = gen.routes[ri];
    const p = rt.pts;
    const d = Math.hypot(x - p[si * 3], z - p[si * 3 + 2]);
    if (d < 6) console.log(`  route ${rt.name || rt.style} seg ${si} y ${p[si * 3 + 1].toFixed(2)} d ${d.toFixed(2)}`);
  }
}
