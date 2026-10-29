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
      tris += [].concat(out.terrain || []).reduce((a, m) => a + m.idx.length / 3, 0);
    }
    const far = [];
    for (let L = 2; L <= 5; L++) { const t0 = performance.now(); mesher.build(L, Math.floor(cq / (1 << L)), Math.floor(cr / (1 << L))); far.push(performance.now() - t0); }
    note(`LOD0 chunks ${times.map((t) => Math.round(t)).join(', ')} ms (${Math.round(tris / 4)} terrain tris avg) · LOD2-5 ${far.map((t) => Math.round(t)).join(', ')} ms`);
    assert(times.reduce((a, b) => a + b, 0) / times.length < 600, 'LOD0 chunk meshing too slow');
  });

  await test('lowest settings: coarse far chunks and thinner vegetation cut the triangles', () => {
    const plan = plans.get(seeds[0]);
    const gen = new ColumnGen(plan);
    const mesher = new ChunkMesher(gen, buildFlora(plan.params), plan);
    const ax = { q: 0, r: 0 };
    worldToAxial(plan.spawn.x, plan.spawn.z, ax);
    const tri = (o) => ['terrain', 'foliage', 'terrainDeep', 'foliageDeep'].reduce((a, k) => a + [].concat(o[k] || []).reduce((b, m) => b + m.idx.length / 3, 0), 0);
    const whole = (m) => { if (!Array.isArray(m)) return m; let n = 0; for (const p of m) n += p.pos.length; const pos = new Float32Array(n); let o = 0; for (const p of m) { pos.set(p.pos, o); o += p.pos.length; } return { pos }; };
    let full = 0, coarse = 0, box = true;
    for (let L = 1; L <= 4; L++) {
      const cq = Math.floor(ax.q / (CHUNK << L)), cr = Math.floor(ax.r / (CHUNK << L));
      const a = mesher.build(L, cq, cr), b = mesher.build(L, cq, cr, { coarse: true, foliage: 0.4 });
      full += tri(a); coarse += tri(b);
      // the coarse mesh covers the same ground
      const mid = (m) => { let x = 0, z = 0; const p = m.pos, n = p.length / 3; for (let i = 0; i < p.length; i += 3) { x += p[i]; z += p[i + 2]; } return [x / n, z / n]; };
      if (a.terrain && b.terrain) { const [ax0, az0] = mid(whole(a.terrain)), [bx0, bz0] = mid(whole(b.terrain)); if (Math.hypot(ax0 - bx0, az0 - bz0) > (CHUNK << L) * 0.25) box = false; }
      assert(b.L === L && b.mL === L + 1, 'a coarse chunk keeps its level and is meshed one level coarser');
    }
    const g0 = mesher.build(0, Math.floor(ax.q / CHUNK), Math.floor(ax.r / CHUNK)), g1 = mesher.build(0, Math.floor(ax.q / CHUNK), Math.floor(ax.r / CHUNK), { foliage: 0.4 });
    const ft = (m) => [].concat(m || []).reduce((b, p) => b + p.idx.length / 3, 0);
    const f0 = ft(g0.foliage), f1 = ft(g1.foliage);
    note(`levels 1-4: ${Math.round(full)} → ${Math.round(coarse)} triangles (${Math.round(coarse / full * 100)}%) · LOD0 vegetation ${Math.round(f0)} → ${Math.round(f1)}`);
    assert(coarse < full * 0.45, 'coarse chunks are not much lighter');
    assert(f1 < f0 * 0.7 || f0 < 200, 'thinner vegetation is not thinner');
    assert(box, 'a coarse chunk moved');
  });
}
