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
    const tv = out.terrain ? out.terrain.count : 0, fv = out.foliage ? out.foliage.count : 0, wv = out.water ? out.water.count : 0;
    const tt = out.terrain ? out.terrain.idx.length / 3 : 0, ft = out.foliage ? out.foliage.idx.length / 3 : 0;
    console.log(`${name.padEnd(8)} L${L} ${dt.toFixed(1).padStart(6)}ms terrain v${tv} t${tt} foliage v${fv} t${ft} water v${wv} colliders ${out.colliders.length}`);
  }
}
