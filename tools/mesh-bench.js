// Benchmark chunk meshing for a few chunks at different LODs.
import { generatePlan } from '../js/world/plan.js';
import { ColumnGen } from '../js/world/column.js';
import { ChunkMesher, CHUNK } from '../js/world/mesher.js';
import { buildFlora } from '../js/world/flora.js';

const plan = generatePlan(process.argv[2] || '12345');
const gen = new ColumnGen(plan);
const flora = buildFlora(plan.params);
const mesher = new ChunkMesher(gen, flora, plan);
const toChunk = (x, z, L) => {
  const r = z / 0.8660254, q = x - r / 2;
  const s = CHUNK << L;
  return [Math.floor(q / s), Math.floor(r / s)];
};
const spots = [
  ['spawn', plan.spawn.x, plan.spawn.z],
  ['bowl', plan.station.x * 2, plan.station.z * 2],
  ['lip', plan.station.x, plan.station.z],
  ['eye', 0, 0],
  ['gallery', plan.station.x * 1.3, plan.station.z * 1.3],
];
for (const [name, x, z] of spots) {
  for (const L of [0, 1, 2, 3]) {
    const [cq, cr] = toChunk(x, z, L);
    const t0 = performance.now();
    const out = mesher.build(L, cq, cr);
    const dt = performance.now() - t0;
    const sum = (m, f) => [].concat(m || []).reduce((a, p) => a + f(p), 0);
    const tv = sum(out.terrain, (p) => p.count), fv = sum(out.foliage, (p) => p.count), wv = sum(out.water, (p) => p.count);
    const tt = sum(out.terrain, (p) => p.idx.length / 3), ft = sum(out.foliage, (p) => p.idx.length / 3);
    console.log(`${name.padEnd(8)} L${L} ${dt.toFixed(1).padStart(6)}ms terrain v${tv} t${tt} foliage v${fv} t${ft} water v${wv} colliders ${out.colliders.length}`);
  }
}
