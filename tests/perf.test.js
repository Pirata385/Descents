// Performance budgets for the generator (measured in Node; browsers with a
// JIT behave similarly, and chunk work runs in parallel web workers).
import { test, assert, note } from './lib.js';
import { ColumnGen, ColumnData } from '../js/world/column.js';
import { ChunkMesher, CHUNK } from '../js/world/mesher.js';
import { buildFlora } from '../js/world/flora.js';
import { worldToAxial } from '../js/core/hex.js';

export async function perfTests(seeds, plans, planTimes) {
  await test('world plan generation time', () => {
    const avg = planTimes.reduce((a, b) => a + b, 0) / planTimes.length;
    note(`plans: ${planTimes.map((t) => `${Math.round(t)} ms`).join(', ')} (avg ${Math.round(avg)} ms)`);
    assert(avg < 8000, 'world plans take too long to generate');
  });

  await test('column evaluation throughput', () => {
    const plan = plans.get(seeds[0]);
    const gen = new ColumnGen(plan);
    const col = new ColumnData();
    const N = 30000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) gen.column(-1400 + ((i * 7919) % 2800), -1200 + ((i * 104729) % 2400), 0, col);
    const per = (performance.now() - t0) / N;
    note(`${(per * 1000).toFixed(1)} µs per column (${Math.round(1000 / per)} columns/s per thread)`);
    assert(per < 0.25, 'column evaluation is too slow');
  });

  await test('chunk meshing time near the spawn (LOD 0 and far LODs)', () => {
    const plan = plans.get(seeds[0]);
    const gen = new ColumnGen(plan);
    const mesher = new ChunkMesher(gen, buildFlora(plan.params), plan);
    const ax = { q: 0, r: 0 };
    worldToAxial(plan.spawn.x, plan.spawn.z, ax);
    const cq = Math.floor(ax.q / CHUNK), cr = Math.floor(ax.r / CHUNK);
    const times = [];
    let tris = 0;
    for (let k = 0; k < 4; k++) {
      const t0 = performance.now();
      const out = mesher.build(0, cq + (k % 2), cr + (k >> 1));
      times.push(performance.now() - t0);
      tris += out.terrain ? out.terrain.idx.length / 3 : 0;
    }
    const far = [];
    for (let L = 2; L <= 5; L++) { const t0 = performance.now(); mesher.build(L, Math.floor(cq / (1 << L)), Math.floor(cr / (1 << L))); far.push(performance.now() - t0); }
    note(`LOD0 chunks ${times.map((t) => Math.round(t)).join(', ')} ms (${Math.round(tris / 4)} terrain tris avg) · LOD2-5 ${far.map((t) => Math.round(t)).join(', ')} ms`);
    assert(times.reduce((a, b) => a + b, 0) / times.length < 600, 'LOD0 chunk meshing too slow');
  });
}
