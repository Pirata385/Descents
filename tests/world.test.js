// World generation tests: determinism, seed variety, city, layer structure,
// guaranteed routes and their connectivity, water rules, caves.
import { test, assert, note, hashOf } from './lib.js';
import { generatePlan } from '../js/world/plan.js';
import { ColumnGen, ColumnData, CF } from '../js/world/column.js';
import { Z_CITY, Z_BOWL, Z_EYE } from '../js/world/field.js';
import { LAYER_BOUNDARIES } from '../js/world/layers.js';

const REQUIRED = ['Lip Approach', 'The Great Spiral', 'The Long Stair', 'Plain Trail', 'Threshold Descent'];
const L1_JOURNEYS = ["Delvers' Road", 'River Trail', 'Cavern Way', 'Ridge Trail'];

export function planSignature(plan) {
  return hashOf({
    prims: plan.prims.length,
    routes: plan.routes.map((r) => [r.name || '', r.pts.length, Math.round(r.pts[0]), Math.round(r.pts[r.pts.length - 1])]),
    landmarks: plan.landmarks.map((l) => [l.name, Math.round(l.x), Math.round(l.z)]),
    species: plan.species.map((s) => s.name),
    artifacts: plan.artifacts.map((a) => [a.name, Math.round(a.site.x), Math.round(a.site.z)]),
    lakes: plan.lakes.map((l) => l.level),
  });
}

export async function worldTests(seeds, plans) {
  const first = seeds[0];

  await test('generation is deterministic for a seed', () => {
    const again = generatePlan(first, () => {});
    assert(planSignature(again) === planSignature(plans.get(first)), 'two generations of the same seed differ');
    const gA = new ColumnGen(plans.get(first)), gB = new ColumnGen(again);
    const a = new ColumnData(), b = new ColumnData();
    for (let i = 0; i < 400; i++) {
      const x = -1400 + (i * 97) % 2800, z = -1200 + (i * 61) % 2400;
      gA.column(x, z, 0, a); gB.column(x, z, 0, b);
      assert(a.n === b.n, `span count differs at ${x},${z}`);
      for (let s = 0; s < a.n; s++) assert(a.y0[s] === b.y0[s] && a.y1[s] === b.y1[s] && a.top[s] === b.top[s], `span differs at ${x},${z}`);
    }
  });

  await test('different seeds create different worlds', () => {
    const sigs = new Set(seeds.map((s) => planSignature(plans.get(s))));
    assert(sigs.size === seeds.length, 'two seeds produced identical worlds');
    const eye = seeds.map((s) => plans.get(s).params.eyeR.toFixed(1));
    const cities = seeds.map((s) => plans.get(s).names.city);
    note(`eye radii ${eye.join(', ')} · cities ${cities.join(', ')}`);
    assert(new Set(cities).size === seeds.length, 'city names repeat');
  });

  for (const seed of seeds) {
    const plan = plans.get(seed);
    const gen = new ColumnGen(plan);
    const col = new ColumnData();
    const f = gen.field;
    const P = {};

    await test(`[${seed}] procedural city around the abyss`, () => {
      const c = plan.city;
      const types = new Set(plan.landmarks.filter((l) => l.layer === 0).map((l) => l.type));
      note(`${plan.names.city}: ${c.buildings} buildings, ${c.gates.length} gates, ${c.platforms.length} observation platforms, ${c.windmills.length} windmills, ${c.hamlets.length} hamlets`);
      assert(c.buildings > 120, `too few buildings (${c.buildings})`);
      assert(c.gates.length >= 2, 'needs several gates to the abyss');
      assert(c.platforms.length >= 2, 'needs observation platforms');
      for (const t of ['gate', 'guild', 'market']) assert(types.has(t), `missing city landmark ${t}`);
      f.polar(plan.spawn.x, plan.spawn.z, P);
      assert(P.zone === Z_CITY, 'spawn must be inside the city');
      gen.column(plan.spawn.x, plan.spawn.z, 0, col);
      const fl = col.floorBelow(plan.spawn.y + 0.5);
      assert(fl >= 0 && Math.abs(col.y1[fl] - plan.spawn.y) < 1, 'spawn is not on solid ground');
      const streets = plan.routes.filter((r) => r.style === 'street' || r.style === 'avenue' || r.style === 'lane' || r.style === 'promenade' || r.style === 'ring');
      assert(streets.length > 10, 'city needs a street network');
    });

    await test(`[${seed}] layer structure: rim, Layer 1 bowl, Abyss Eye, Layer 2, Layer 3 entrance`, () => {
      const p = plan.params;
      let bowlOk = 0, n = 0;
      for (let k = 0; k < 72; k++) {
        const th = -Math.PI + (k / 72) * Math.PI * 2;
        const Re = f.tab(f.eyeTab, th), Rr = f.tab(f.rimTab, th);
        assert(Rr - Re > 150, `Layer 1 too narrow at angle ${th.toFixed(2)}`);
        const [x, z] = f.fromPolar((Re + Rr) / 2, th);
        f.polar(x, z, P);
        if (P.zone !== Z_BOWL) continue;
        n++;
        gen.column(x, z, 0, col);
        const top = col.topY();
        if (top < p.bowlTopY + 30 && top > p.lipY - 30) bowlOk++;
      }
      assert(n > 50 && bowlOk / n > 0.9, `bowl heights outside Layer 1 (${bowlOk}/${n})`);
      // the Eye is open: the centre column has nothing above the deep floors
      gen.column(0, 0, 0, col);
      f.polar(0, 0, P);
      assert(P.zone === Z_EYE, 'world centre must be the Eye');
      assert(col.topY() < LAYER_BOUNDARIES.layer2Top, 'the Eye must be open down into Layer 2');
      assert(plan.galleryWindows.length >= 2, 'Layer 2 needs gallery openings');
      assert(p.plainY < LAYER_BOUNDARIES.layer2Top && p.plainY > LAYER_BOUNDARIES.layer3Top, 'Stone Plain must be in Layer 2');
      assert(plan.threshold.y < LAYER_BOUNDARIES.layer3Top, 'the Threshold must reach Layer 3');
      const lmTypes = new Set(plan.landmarks.map((l) => l.type));
      for (const t of ['eye', 'station', 'gallery', 'plain', 'fault', 'threshold']) assert(lmTypes.has(t), `missing landmark ${t}`);
      // inverted forest: gallery windows open to galleries with ceilings
      let ceil = 0;
      for (const w of plan.galleryWindows) {
        const Re = f.tab(f.eyeTab, w.th);
        const [x, z] = f.fromPolar(Re + 40, w.th);
        gen.column(x, z, 0, col);
        const fi = col.floorBelow(w.y + 3);
        if (fi >= 0 && fi + 1 < col.n && col.y0[fi + 1] - col.y1[fi] > 8) ceil++;
      }
      assert(ceil >= Math.ceil(plan.galleryWindows.length * 0.6), 'gallery chambers need floors and ceilings');
      note(`eye ${p.eyeR.toFixed(0)} m · lip ${p.lipY.toFixed(0)} m · plain ${p.plainY.toFixed(0)} m · threshold ${plan.threshold.y.toFixed(0)} m · ${plan.galleryWindows.length} gallery windows`);
    });

    await test(`[${seed}] guaranteed routes validate (city → Layer 1 → Layer 2 → Layer 3)`, () => {
      const v = plan.validation.routes;
      const byName = new Map(v.map((r) => [r.name, r]));
      for (const name of REQUIRED) {
        const r = byName.get(name);
        assert(r, `missing route ${name}`);
        assert(r.ok, `${name} has ${r.failures} unwalkable samples: ${JSON.stringify(r.first)}`);
      }
      const l1 = L1_JOURNEYS.filter((n) => byName.get(n)?.ok);
      assert(l1.length >= 2, `need several Layer 1 journeys, have ${l1.join(', ')}`);
      const bad = v.filter((r) => !r.ok);
      assert(bad.length === 0, `routes failing validation: ${bad.map((r) => r.name).join(', ')}`);
      const gates = v.filter((r) => /Stairway$/.test(r.name));
      assert(gates.length >= 2, 'several gate stairways should lead into Layer 1');
      const caves = plan.validation.caves;
      const okCaves = caves.filter((c) => c.ok).length;
      note(`${v.length} journeys valid (${l1.join(', ')}) · ${okCaves}/${caves.length} walkable caves valid`);
      assert(okCaves / Math.max(1, caves.length) >= 0.85, 'too many caves fail validation');
    });

    await test(`[${seed}] route network connects the city to Layer 3`, () => {
      // routes are connected where their points come close in 3D
      const routes = plan.routes;
      const cells = new Map();
      const key = (x, z) => `${Math.floor(x / 6)}:${Math.floor(z / 6)}`;
      routes.forEach((r, ri) => {
        for (let i = 0; i < r.pts.length; i += 3) {
          const k = key(r.pts[i], r.pts[i + 2]);
          let l = cells.get(k); if (!l) cells.set(k, (l = []));
          l.push(ri, r.pts[i + 1]);
        }
      });
      const adj = routes.map(() => new Set());
      routes.forEach((r, ri) => {
        for (let i = 0; i < r.pts.length; i += 3) {
          const cx = Math.floor(r.pts[i] / 6), cz = Math.floor(r.pts[i + 2] / 6);
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            const l = cells.get(`${cx + dx}:${cz + dz}`);
            if (!l) continue;
            for (let q = 0; q < l.length; q += 2) if (l[q] !== ri && Math.abs(l[q + 1] - r.pts[i + 1]) < 4) adj[ri].add(l[q]);
          }
        }
      });
      // also join a route's end to a cave/tunnel that continues it: treat validated caves as links
      const start = routes.map((r, i) => [i, Math.hypot(r.pts[0] - plan.spawn.x, r.pts[2] - plan.spawn.z)]).sort((a, b) => a[1] - b[1])[0][0];
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) { const r = queue.shift(); for (const n of adj[r]) if (!seen.has(n)) { seen.add(n); queue.push(n); } }
      const reach = (name) => routes.some((r, i) => r.name === name && seen.has(i));
      for (const name of REQUIRED) assert(reach(name), `${name} is not connected to the city by the route network`);
      note(`${seen.size}/${routes.length} route segments reachable from the spawn`);
    });

    await test(`[${seed}] water rules: level lakes, downhill rivers, no floating water`, () => {
      const { cs, ox, oz, nx } = plan.coarse;
      let lakeCells = 0, lakeBad = 0, floatBad = 0, shoreBad = 0, shoreN = 0;
      for (const lk of plan.lakes) {
        if (lk.cells < 6) continue;
        let k = 0;
        for (let idx = 0; idx < plan.lakeGrid.length && k < 40; idx++) {
          if (plan.lakeGrid[idx] !== lk.id) continue;
          const i = idx % nx, j = (idx / nx) | 0;
          const x = ox + (i + 0.5) * cs, z = oz + (j + 0.5) * cs;
          gen.column(x, z, 0, col);
          let w = -1;
          for (let q = 0; q < col.nw; q++) if (col.wkind[q] === 0) w = q;
          if (w < 0) continue;
          k++; lakeCells++;
          if (Math.abs(col.wl[w] - lk.level) > 0.01) lakeBad++;
          const fl = col.y1[col.wsp[w]];
          if (!(fl < col.wl[w] - 0.05)) floatBad++;
          // shore: walking out of the lake, the first dry column must hold the water in
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            for (let d = 1; d <= 28; d++) {
              gen.column(x + dx * d, z + dz * d, 0, col);
              let wet = false;
              for (let q = 0; q < col.nw; q++) if (Math.abs(col.wl[q] - lk.level) < 0.05) wet = true;
              if (wet) continue;
              shoreN++;
              if (col.topY() < lk.level + 0.1 && !(col.flags & (CF.RIVER | CF.ROUTE | CF.POOL))) shoreBad++;
              break;
            }
          }
        }
      }
      // rivers flow downhill (falls only go down)
      let riverBad = 0, riverN = 0, riverWet = 0, riverS = 0;
      for (const r of plan.rivers) {
        for (let i = 1; i < r.level.length; i++) { riverN++; if (r.level[i] > r.level[i - 1] + 0.05) riverBad++; }
        for (let i = 2; i < r.x.length - 2; i += 7) {
          // skip waterfall steps, and stretches that cross the source or target lake
          let nearFall = false;
          for (let d = -2; d <= 2; d++) if (r.fall[i + d] > 0.3) nearFall = true;
          const ci = Math.floor((r.x[i] - ox) / cs), cj = Math.floor((r.z[i] - oz) / cs);
          const lid = plan.lakeGrid[cj * nx + ci];
          if (nearFall || (lid && (lid === r.fromLake || lid === r.toLake))) continue;
          gen.column(r.x[i], r.z[i], 0, col);
          if (col.flags & CF.ROUTE) continue; // fords and bridges
          riverS++;
          for (let q = 0; q < col.nw; q++) if (Math.abs(col.wl[q] - r.level[i]) < 1.2) { riverWet++; const fl = col.y1[col.wsp[q]]; if (!(fl < col.wl[q])) floatBad++; break; }
        }
      }
      note(`${plan.lakes.length} lakes (${lakeCells} cells sampled), ${plan.rivers.length} rivers, ${plan.waterfalls.length} great waterfalls · shore ok ${shoreN - shoreBad}/${shoreN}`);
      assert(lakeCells > 20, 'world should have lakes');
      assert(plan.rivers.length >= 3, 'world should have rivers');
      assert(lakeBad === 0, `${lakeBad} lake cells not at the lake level`);
      assert(floatBad === 0, `${floatBad} water samples without a floor below`);
      assert(riverBad === 0, `${riverBad}/${riverN} river segments flow uphill`);
      assert(riverWet / riverS > 0.97, `river beds missing water (${riverWet}/${riverS})`);
      assert(shoreBad / Math.max(1, shoreN) < 0.01, `lake water spills over its shores (${shoreBad}/${shoreN})`);
    });

    await test(`[${seed}] caves, overhangs and vertical terrain exist`, () => {
      let multi = 0, cliffs = 0, n = 0;
      for (let k = 0; k < 2000; k++) {
        const th = (k * 2.399963) % (Math.PI * 2) - Math.PI;
        const Re = f.tab(f.eyeTab, th), Rr = f.tab(f.rimTab, th);
        const r = Re + 4 + ((k * 0.618034) % 1) * (Rr - Re + 40);
        const [x, z] = f.fromPolar(r, th);
        gen.column(x, z, 0, col);
        n++;
        if (col.n >= 2) multi++;
        const t0 = col.topY();
        gen.column(x + 2, z, 0, col);
        if (Math.abs(col.topY() - t0) > 3) cliffs++;
      }
      const caves = plan.caves.filter((c) => c.kind === 'cave' || c.kind === 'through');
      note(`${caves.length} caves, ${plan.caves.filter((c) => c.kind === 'deep').length} deep tunnels · ${(100 * multi / n).toFixed(1)}% of Layer 1 samples have overhangs/caves · ${(100 * cliffs / n).toFixed(1)}% cliff edges`);
      assert(caves.length >= 3, 'needs caves');
      assert(multi > 10, 'needs overhangs or caves (multi-span columns)');
      assert(cliffs > 20, 'needs cliffs');
    });
  }
}
