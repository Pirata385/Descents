// World plan: the complete deterministic description of a generated world.
// generatePlan(seed) runs every macro generation stage and returns plain,
// structured-clone friendly data that chunk workers and the main thread use
// to evaluate any column on demand.
import { RNG, normalizeSeed } from '../core/rng.js';
import { TAU, wrapAngle, clamp } from '../core/mathutil.js';
import { makeParams } from './params.js';
import { NameGen } from './names.js';
import { TerrainField, Z_EYE, Z_BOWL } from './field.js';
import { buildCoarseGrid, computeHydrology, buildRivers } from './hydrology.js';
import { generateCaves, cavesToCapsules } from './caves.js';
import { planSpiral, planGalleryWindows, planRibs, planLongStair, planFaultSpiral, planDeepTunnels } from './abyss.js';
import { generateCity } from './city.js';
import { generateL1Features, generateL2Features, compileRuin } from './ruins.js';
import { ColumnGen, ColumnData } from './column.js';
import { M } from './materials.js';
import { box, cyl, flat, building, OP_ADD, resetPrimOrder } from './structures.js';
import { STYLES, astar, trailCost, smoothPath, profileRoute, makeRoute, validatePath, densify, routeTo3, RouteIndex } from './routes.js';
import { SpatialGrid } from './spatial.js';
import { LAYER_BOUNDARIES } from './layers.js';
import { generateSpecies } from '../creatures/genetics.js';
import { generateArtifacts } from '../artifacts/artifactGen.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function buildWaterDist(coarse, hydro, rivers) {
  const { nx, nz, cs, ox, oz } = coarse;
  const N = nx * nz;
  const d = new Float32Array(N).fill(1e9);
  const q = [];
  const seed = (k) => { if (d[k] > 0) { d[k] = 0; q.push(k); } };
  for (let k = 0; k < N; k++) if (hydro.lakeId[k]) seed(k);
  for (const r of rivers) {
    for (let i = 0; i < r.x.length; i++) {
      const ci = Math.floor((r.x[i] - ox) / cs), cj = Math.floor((r.z[i] - oz) / cs);
      if (ci >= 0 && cj >= 0 && ci < nx && cj < nz) seed(cj * nx + ci);
    }
  }
  // two-pass chamfer distance
  const D1 = cs, D2 = cs * Math.SQRT2;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i > 0) d[k] = Math.min(d[k], d[k - 1] + D1);
      if (j > 0) d[k] = Math.min(d[k], d[k - nx] + D1);
      if (i > 0 && j > 0) d[k] = Math.min(d[k], d[k - nx - 1] + D2);
      if (i < nx - 1 && j > 0) d[k] = Math.min(d[k], d[k - nx + 1] + D2);
    }
    for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (i < nx - 1) d[k] = Math.min(d[k], d[k + 1] + D1);
      if (j < nz - 1) d[k] = Math.min(d[k], d[k + nx] + D1);
      if (i < nx - 1 && j < nz - 1) d[k] = Math.min(d[k], d[k + nx + 1] + D2);
      if (i > 0 && j < nz - 1) d[k] = Math.min(d[k], d[k + nx - 1] + D2);
    }
  }
  void q;
  return d;
}

export function generatePlan(seedInput, progress = () => {}) {
  const T0 = now();
  const timings = {};
  let tm = now();
  const mark = (name) => { const t = now(); timings[name] = Math.round(t - tm); tm = t; };
  const seed = normalizeSeed(seedInput);
  resetPrimOrder();
  const params = makeParams(seed);
  const names = new NameGen(seed);
  const field = new TerrainField(params);
  progress('Shaping the island', 0.03);
  const coarse = buildCoarseGrid(field);
  mark('coarse');
  progress('Tracing rivers and lakes', 0.12);
  const hydro = computeHydrology(field, coarse);
  const { rivers, eyeFalls } = buildRivers(field, hydro, coarse);
  const lakes = hydro.lakes;
  for (const l of lakes) l.name = `Lake ${names.name('lake', l.id)}`;
  const waterDistGrid = buildWaterDist(coarse, hydro, rivers);
  const waterDist = (x, z) => {
    const i = clamp(Math.floor((x - coarse.ox) / coarse.cs), 0, coarse.nx - 1), j = clamp(Math.floor((z - coarse.oz) / coarse.cs), 0, coarse.nz - 1);
    return waterDistGrid[j * coarse.nx + i];
  };
  mark('hydro');

  progress('Carving caves', 0.2);
  const caves = generateCaves(field, coarse, params, names, waterDist);
  mark('caves');
  const spiral = planSpiral(field, params);
  const galleryWindows = planGalleryWindows(params, spiral);
  const bellRibs = planRibs(params, spiral);

  progress('Raising the rim city', 0.28);
  const city = generateCity({ field, params, names, waterDist });
  mark('city');
  progress('Scattering ancient ruins', 0.34);
  const l1 = generateL1Features({ field, params, names, waterDist });
  mark('ruins1');

  // ---- base plan without structures/routes for deep queries
  const plan = {
    version: 1, seed, params, coarse: { ...coarse }, lakeGrid: hydro.lakeId, lakes, rivers,
    capsules: cavesToCapsules(caves), galleryWindows, bellRibs, prims: [], routes: [], pools: [],
  };
  let tempGen = new ColumnGen(plan);
  const col = new ColumnData();
  const floorIn = (x, z, yTop, yBottom, minAir = 3) => {
    tempGen.column(x, z, 0, col);
    for (let i = col.n - 1; i >= 0; i--) {
      const y = col.y1[i];
      if (y > yTop || y < yBottom) continue;
      const above = i + 1 < col.n ? col.y0[i + 1] : Infinity;
      if (above - y >= minAir) return y;
    }
    return null;
  };
  const eyeR = (th) => field.tab(field.eyeTab, th);
  const galleryFloorAt = (k, th, u) => {
    const D = tempGen.galleryDepth(k, th);
    if (D < 8) return null;
    const g = params.galleries[k];
    const [x, z] = field.fromPolar(eyeR(th) + D * u, th);
    return floorIn(x, z, g.yTop, g.yTop - g.height - 12);
  };
  const plainFloorAt = (x, z) => floorIn(x, z, params.plainY + 60, params.plainY - 30);

  progress('Boring deep tunnels', 0.4);
  const avoid1 = [...l1.spires, ...l1.arches, ...l1.ruins];
  const deep = planDeepTunnels(field, params, names, galleryFloorAt, plainFloorAt, caves, floorIn, (k, th) => tempGen.galleryDepth(k, th), (x, z) => Math.min(waterDist(x, z), ...avoid1.map((a) => Math.hypot(a.x - x, a.z - z) - 14)));
  for (const t of deep) { t.id = caves.length; caves.push(t); }
  // landing pads: flat floor where a deep tunnel opens into a gallery or onto the plain
  const pads = [];
  for (const t of deep) {
    for (const [end, place] of [[0, t.from], [1, t.to]]) {
      if (!place || place === 'bowl') continue;
      const nodes = end ? t.nodes.slice().reverse() : t.nodes;
      const m = nodes[0];
      const padY = Math.round((m.y - m.r * 0.55) * 2) / 2;
      const tier = place.startsWith('gallery') ? Number(place.slice(7)) : -1;
      pads.push({ x: m.x, z: m.z, r: 18, y: padY, tier, plain: place === 'plain' });
      // flatten tunnel nodes inside the pad, then keep the rest of the tunnel within a walkable slope
      let k = 0;
      for (; k < nodes.length; k++) {
        if (Math.hypot(nodes[k].x - m.x, nodes[k].z - m.z) > 15) break;
        nodes[k].y = padY + nodes[k].r * 0.55;
      }
      const kPad = k;
      for (let pass = 0; pass < 2; pass++) {
        for (let q = Math.max(1, kPad); q < Math.min(nodes.length, kPad + 40); q++) {
          const a = nodes[q - 1], b = nodes[q];
          const lim = 0.42 * Math.hypot(b.x - a.x, b.z - a.z);
          if (Math.abs(b.y - a.y) > lim) b.y = a.y + Math.sign(b.y - a.y) * lim;
        }
      }
    }
  }
  plan.pads = pads;
  plan.capsules = cavesToCapsules(caves);
  tempGen = new ColumnGen(plan);
  mark('deep');

  progress('Growing the inverted forest', 0.46);
  const avoidPts = [];
  for (const c of caves) if (c.kind === 'deep') for (const nd of [...c.nodes.slice(0, 10), ...c.nodes.slice(-10)]) avoidPts.push(nd);
  for (const w of galleryWindows) { const [x, z] = field.fromPolar(eyeR(w.th) + 10, w.th); avoidPts.push({ x, z }); }
  const l2 = generateL2Features({ field, params, names, floorIn, waterDist, avoidPts });
  mark('ruins2');

  // ---- pools: eye-fall plunge pools, springs in galleries and on the plain
  const rng = RNG.derive(seed, 'plan');
  const pools = [...city.pools];
  const waterfalls = [];
  const FPq = {};
  for (const ef of eyeFalls) {
    const th = Math.atan2(field.warpZ(ef.x, ef.z), field.warpX(ef.x, ef.z));
    const [fx, fz] = field.fromPolar(eyeR(th) - 4.5, th);
    field.faultPolar(fx, fz, FPq);
    const overFault = FPq.fr < FPq.Rf + 3;
    const [px, pz] = field.fromPolar(eyeR(th) - 14, th);
    const bottom = overFault ? params.fault.bottomY : (plainFloorAt(px, pz) ?? params.plainY);
    waterfalls.push({ x: fx, z: fz, topY: ef.topY, bottomY: bottom, width: ef.width * 1.3, dirX: -Math.cos(th), dirZ: -Math.sin(th), kind: 'eye', name: `${names.name('falls', waterfalls.length)} Falls` });
    if (!overFault) pools.push({ x: px, z: pz, r: 9 + ef.width, depth: 1.6, kind: 'plunge' });
  }
  // gallery springs with streams falling into the shaft
  const galleryStreams = [];
  params.galleries.forEach((g, k) => {
    const n = rng.int(2, 4);
    for (let i = 0, tries = 0; i < n && tries < 60; tries++) {
      const th = rng.range(-Math.PI, Math.PI);
      const D = tempGen.galleryDepth(k, th);
      if (D < 45) continue;
      const u = rng.range(0.45, 0.7);
      const [x, z] = field.fromPolar(eyeR(th) + D * u, th);
      const y = floorIn(x, z, g.yTop, g.yTop - g.height - 10);
      if (y === null) continue;
      pools.push({ x, z, r: rng.range(3.5, 7), depth: 1.2, kind: 'spring', tier: k });
      galleryStreams.push({ k, th, D, u, x, z });
      i++;
    }
  });
  // plain springs
  for (let i = 0, tries = 0; i < 3 && tries < 40; tries++) {
    const th = rng.range(-Math.PI, Math.PI);
    const [x, z] = field.fromPolar(rng.range(0.3, 0.8) * (field.tab(field.bellTab, th)), th);
    field.faultPolar(x, z, FPq);
    if (FPq.fr < FPq.Rf + 20) continue;
    if (plainFloorAt(x, z) === null) continue;
    pools.push({ x, z, r: rng.range(5, 11), depth: 1.4, kind: 'spring' });
    i++;
  }
  // compute pool levels so every rim point stands above the water
  for (const p of pools) {
    if (p.fixed) continue;
    const ref = floorIn(p.x, p.z, 200, -1200);
    if (ref === null) { p.level = NaN; continue; }
    let mn = Infinity;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * TAU;
      for (const rr of [p.r, p.r + 1.5]) {
        const fy = floorIn(p.x + Math.cos(ang) * rr, p.z + Math.sin(ang) * rr, ref + 6, ref - 6);
        if (fy !== null) mn = Math.min(mn, fy);
      }
    }
    if (!Number.isFinite(mn)) mn = ref;
    p.level = Math.floor((Math.min(mn, ref + 0.5) - 0.35) * 2) / 2 + 0.2;
    if (p.level > Math.min(mn, ref + 0.5) - 0.3) p.level -= 0.5;
  }
  const validPools = pools.filter((p) => Number.isFinite(p.level));
  // gallery streams: from the spring toward the opening, then a waterfall into the shaft
  for (const s of galleryStreams) {
    const pool = validPools.find((p) => p.x === s.x && p.z === s.z);
    if (!pool) continue;
    const xs = [], zs = [], levels = [], widths = [], falls = [];
    let level = pool.level;
    for (let uu = s.u; uu >= -0.005; uu -= 0.02) {
      const [x, z] = field.fromPolar(eyeR(s.th) + s.D * Math.max(0, uu) + 0.5, s.th);
      const g = params.galleries[s.k];
      const fy = floorIn(x, z, g.yTop, g.yTop - g.height - 12);
      if (fy === null) break;
      const target = fy - 0.7;
      let fall = 0;
      if (target < level - 0.05) { if (level - target > 1.0) fall = level - target; level = target; }
      xs.push(x); zs.push(z); levels.push(level); widths.push(2.4); falls.push(fall);
    }
    if (xs.length < 4) continue;
    rivers.push({ id: rivers.length, x: Float32Array.from(xs), z: Float32Array.from(zs), level: Float32Array.from(levels), width: Float32Array.from(widths), fall: Float32Array.from(falls), end: 'shaft', gallery: s.k, length: xs.length * 2 });
    const [fx, fz] = field.fromPolar(eyeR(s.th) - 2.5, s.th);
    const [px, pz] = field.fromPolar(eyeR(s.th) - 12, s.th);
    field.faultPolar(fx, fz, FPq);
    waterfalls.push({ x: fx, z: fz, topY: levels[levels.length - 1], bottomY: FPq.fr < FPq.Rf ? params.fault.bottomY : (plainFloorAt(px, pz) ?? params.plainY), width: 2.6, dirX: -Math.cos(s.th), dirZ: -Math.sin(s.th), kind: 'gallery', name: `${names.name('gfall', waterfalls.length)} Veil` });
  }
  plan.pools = validPools;
  mark('pools');

  // ---- extra structures: Lip Station camp and the Threshold
  const extraPrims = [];
  const landmarks = [...city.landmarks, ...l1.landmarks, ...l2.landmarks];
  const th0 = spiral.th0;
  const dirS = spiral.dir;
  // approach: tangential descent from the station to the spiral start
  const station = (() => {
    const P = {}, S = {};
    const off = 16;
    const yStart = spiral.yStart;
    let best = null;
    for (const back of [0.06, 0.1, 0.14, 0.2, 0.28]) {
      const th = th0 - dirS * back;
      const [x, z] = field.fromPolar(eyeR(th) + off, th);
      field.polar(x, z, P);
      field.surface(x, z, P, S);
      const arc = back * eyeR(th0) + off;
      best = { x, z, th, y: Math.round(S.h * 2) / 2, arc };
      if ((S.h - yStart) / arc < 0.4) break;
    }
    return best;
  })();
  extraPrims.push(flat(station.x, station.z, { r: 11, y0: station.y, feather: 4, top: M.PATH }));
  {
    const c = Math.cos(station.th), s = Math.sin(station.th);
    const hx = station.x + c * 9, hz = station.z + s * 9;
    const b = building(hx, hz, { angle: station.th + Math.PI / 2, w: 7, d: 5.5, base: station.y, floors: 1, wall: M.WOOD, roof: M.ROOF_B, pitch: 0.8, doorSide: 3, chimney: true, foundation: 4 });
    extraPrims.push(...b.prims);
  }
  landmarks.push({ type: 'station', name: 'Lip Station', x: station.x, z: station.z, y: station.y, layer: 1 });
  landmarks.push({ type: 'eye', name: 'The Abyss Eye', x: 0, z: 0, y: params.lipY, layer: 1 });

  progress('Charting routes', 0.55);
  // Long stair needs floors; fault spiral needs the plain
  const longStair = planLongStair(field, params, spiral, bellRibs, plainFloorAt);
  const lastStair = longStair.pts[longStair.pts.length - 1];
  const fault = planFaultSpiral(field, params, lastStair[0], lastStair[1], (x, z) => floorIn(x, z, params.plainY + 30, params.plainY - 30));
  {
    const t = fault.threshold;
    extraPrims.push(cyl(OP_ADD, t.x, t.z, { r: 7.5, y0: t.y - 3, y1: t.y, top: M.RUIN2, side: M.BASALT }));
    const desc = {
      prims: [
        { k: 'box', u: -3.5, v: 0, ang: 0, hw: 0.8, hd: 0.9, y0: -1, y1: 8, mat: M.RUIN2 },
        { k: 'box', u: 3.5, v: 0, ang: 0, hw: 0.8, hd: 0.9, y0: -1, y1: 8, mat: M.RUIN2 },
        { k: 'arch', u: -3.5, v: 0, bu: 3.5, bv: 0, y0: 7.2, yb: 7.2, bulge: 1.6, thick: 1.2, width: 1.0, mat: M.RUIN2 },
      ],
      spots: [], radius: 6,
    };
    const ang = t.th + Math.PI / 2;
    for (const p of compileRuin(desc, t.x, t.y, t.z, ang)) if (p.kind !== 7) extraPrims.push(p);
    landmarks.push({ type: 'threshold', name: 'The Threshold', x: t.x, z: t.z, y: t.y, layer: 3 });
  }
  landmarks.push({ type: 'fault', name: 'The Great Fault', x: params.fault.x, z: params.fault.z, y: params.plainY, layer: 2 });
  landmarks.push({ type: 'plain', name: `Stone Plain of ${names.name('plain')}`, x: lastStair[0], z: lastStair[1], y: lastStair[2], layer: 2 });
  landmarks.push({ type: 'stair', name: 'The Long Stair', x: lastStair[0], z: lastStair[1], y: (longStair.yTop + longStair.yBottom) / 2, layer: 2 });
  for (const w of galleryWindows) {
    const g = params.galleries[w.tier];
    const [x, z] = field.fromPolar(eyeR(w.th) + 40, w.th);
    landmarks.push({ type: 'gallery', name: `${w.tier === 0 ? 'The Inverted Forest' : w.tier === 1 ? 'The Lower Canopy' : 'The Deep Grove'} of ${names.name('gallery', w.tier)}`, x, z, y: g.yTop - g.height, layer: 2 });
  }
  for (const wf of waterfalls) if (wf.kind === 'eye') landmarks.push({ type: 'waterfall', name: wf.name, x: wf.x, z: wf.z, y: wf.topY, layer: 1 });
  for (const lk of lakes) if (lk.cells >= 12) landmarks.push({ type: 'lake', name: lk.name, x: lk.x, z: lk.z, y: lk.level, layer: lk.level > -40 ? 0 : 1 });
  for (const c of caves) if (c.name && c.entrance) landmarks.push({ type: 'cave', name: c.name, x: c.entrance.x, z: c.entrance.z, y: c.entrance.y, layer: c.entrance.y < LAYER_BOUNDARIES.layer2Top ? 2 : 1, kind: c.kind });

  plan.prims = [...city.prims, ...l1.prims, ...l2.prims, ...extraPrims];
  tempGen = new ColumnGen(plan);
  mark('structures');

  // ---- routes
  const routes = [];
  const rindex = new RouteIndex(new SpatialGrid(8));
  const addRoute = (style, pts3, meta, pin = true) => {
    const r = makeRoute(routes.length, style, pts3, meta);
    routes.push(r);
    if (pin) rindex.add(r, !!meta.validate);
    return r;
  };
  const prof = (pts, style, opts) => rindex.profile(tempGen, pts, STYLES[style], opts);
  // city streets
  for (const st of city.streets) {
    const style = st.kind === 'promenade' ? 'promenade' : st.kind === 'ring' ? 'ring' : st.kind === 'avenue' ? 'avenue' : 'lane';
    const pts = smoothPath(st.pts, 2);
    const ys = prof(pts, style, { window: 4 });
    addRoute(style, pts.map((p, i) => [p[0], ys[i], p[1]]), { name: st.kind === 'promenade' ? 'Rim Promenade' : null, kind: 'street' });
  }
  mark('streets');
  // country roads to hamlets
  const costRoad = trailCost(coarse, hydro, { waterDistGrid });
  for (const hm of city.hamlets) {
    let best = null, bd = Infinity;
    for (const rd of city.radials) { const d = Math.hypot(rd.end[0] - hm.x, rd.end[1] - hm.z); if (d < bd) { bd = d; best = rd; } }
    if (!best) continue;
    const path = astar(coarse, best.end[0], best.end[1], hm.x, hm.z, costRoad, 60000);
    if (!path) continue;
    const pts = smoothPath([best.end, ...path.slice(1, -1), [hm.x, hm.z]], 2);
    const ys = prof(pts, 'country', { window: 3 });
    addRoute('country', pts.map((p, i) => [p[0], ys[i], p[1]]), { name: `Road to ${hm.name}`, kind: 'road' });
  }
  // A* avoidance mask around cave mouths so trails do not fill them in
  const caveMouthMask = new Uint8Array(coarse.nx * coarse.nz);
  for (const c of caves) {
    const ends = [c.entrance, c.exit, ...c.nodes.slice(0, 8), ...c.nodes.slice(-8)];
    for (const m of ends) {
      if (!m) continue;
      const ci = Math.floor((m.x - coarse.ox) / coarse.cs), cj = Math.floor((m.z - coarse.oz) / coarse.cs);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = ci + di, jj = cj + dj;
        if (ii >= 0 && jj >= 0 && ii < coarse.nx && jj < coarse.nz) caveMouthMask[jj * coarse.nx + ii] = 1;
      }
    }
  }
  // gate stairways down the rim cliff
  const P = {}, S = {};
  const surfaceY = (x, z) => { field.polar(x, z, P); field.surface(x, z, P, S); return S.h; };
  const rimAt = (th) => field.tab(field.rimTab, th);
  const journeys = [];
  const stairEnds = [];
  for (const gate of city.gates) {
    const dir = RNG.derive(seed, 'gatedir', gate.id).sign();
    const R = rimAt(gate.th);
    const W = (o, th) => field.fromPolar(rimAt(th) + o, th);
    const yTop = Math.round(surfaceY(...W(16, gate.th)) * 2) / 2;
    const estEnd = W(-16, gate.th + dir * 0.12);
    const yBotEst = surfaceY(...estEnd);
    const L = Math.max(60, (yTop - yBotEst) / 0.5 + 12);
    const pts2 = [W(16, gate.th), W(10, gate.th)];
    const n = Math.ceil(L / 2);
    for (let i = 1; i <= n; i++) {
      const s = i / n;
      pts2.push(W(8 - 18 * s, gate.th + (dir * L * s) / R));
    }
    const endTh = gate.th + (dir * L) / R + (dir * 8) / R;
    pts2.push(W(-18, endTh));
    const pts = smoothPath(pts2, 2);
    const yEnd = Math.round(surfaceY(...pts[pts.length - 1]) * 2) / 2;
    const ys = prof(pts, 'stair', { startY: yTop, endY: yEnd, window: 1 });
    const r = addRoute('stair', pts.map((p, i) => [p[0], ys[i], p[1]]), { name: `${gate.name} Stairway`, kind: 'stair', validate: true, gate: gate.id });
    journeys.push(r);
    stairEnds.push({ gate, x: pts[pts.length - 1][0], z: pts[pts.length - 1][1], y: yEnd });
  }
  // L1 journey trails: each gate to Lip Station with different characters
  const throughCaves = caves.filter((c) => c.kind === 'through');
  // coarse cells already used by journey routes; later journeys avoid crossing them
  const occupied = new Uint8Array(coarse.nx * coarse.nz);
  const occupy = (route) => {
    const p = route.pts;
    for (let i = 0; i < p.length; i += 3) {
      const ci = Math.floor((p[i] - coarse.ox) / coarse.cs), cj = Math.floor((p[i + 2] - coarse.oz) / coarse.cs);
      if (ci >= 0 && cj >= 0 && ci < coarse.nx && cj < coarse.nz) occupied[cj * coarse.nx + ci] = 1;
    }
  };
  const goalFree = (n) => {
    const x = coarse.ox + ((n % coarse.nx) + 0.5) * coarse.cs, z = coarse.oz + (((n / coarse.nx) | 0) + 0.5) * coarse.cs;
    return Math.hypot(x - station.x, z - station.z) < 70;
  };
  const trailNames = ["Delvers' Road", 'River Trail', 'Cavern Way', 'Ridge Trail'];
  stairEnds.forEach((se, i) => {
    const kind = i === 0 ? 'road' : i === 1 ? 'river' : i === 2 && throughCaves.length ? 'cave' : 'ridge';
    const legs = [];
    // end a trail where it first joins an earlier route (after leaving its own start)
    const joinNetwork = (pts, hw, skip = 25) => {
      let travelled = 0;
      for (let k = 1; k < pts.length; k++) {
        travelled += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        if (travelled < skip) continue;
        const nb = rindex.nearest(pts[k][0], pts[k][1], hw + 1.0);
        if (nb && nb.journey) return { pts: pts.slice(0, k).concat([[nb.x, nb.z]]), y: nb.y };
      }
      return null;
    };
    const plan2 = (ax, az, bx, bz, opts) => {
      const cost = trailCost(coarse, hydro, { waterDistGrid, avoid: caveMouthMask, occupied, goalFree, ...opts });
      const path = astar(coarse, ax, az, bx, bz, cost, 150000);
      if (!path) return null;
      return smoothPath([[ax, az], ...path.slice(1, -1), [bx, bz]], 2);
    };
    if (kind === 'cave') {
      // pick the through cave closest to the straight line toward the eye
      let best = throughCaves[0], bd = Infinity;
      for (const c of throughCaves) { const d = Math.hypot(c.entrance.x - se.x, c.entrance.z - se.z); if (d < bd) { bd = d; best = c; } }
      const n0 = best.nodes[0], n1 = best.nodes[1];
      const nl = best.nodes[best.nodes.length - 1], nl1 = best.nodes[best.nodes.length - 2];
      const d0 = Math.hypot(n1.x - n0.x, n1.z - n0.z) || 1, d1 = Math.hypot(nl.x - nl1.x, nl.z - nl1.z) || 1;
      const ap = [n0.x - (n1.x - n0.x) / d0 * 7, n0.z - (n1.z - n0.z) / d0 * 7];
      const dp = [nl.x + (nl.x - nl1.x) / d1 * 7, nl.z + (nl.z - nl1.z) / d1 * 7];
      const a = plan2(se.x, se.z, ap[0], ap[1], {});
      const b = plan2(dp[0], dp[1], station.x, station.z, {});
      if (a && b) {
        a.push([n0.x - (n1.x - n0.x) / d0 * 3.5, n0.z - (n1.z - n0.z) / d0 * 3.5]);
        b.unshift([nl.x + (nl.x - nl1.x) / d1 * 3.5, nl.z + (nl.z - nl1.z) / d1 * 3.5]);
        const entryFloor = n0.y - n0.r * 0.55;
        const ya = prof(a, 'trail', { startY: se.y, endY: entryFloor + 0.2 });
        legs.push(addRoute('trail', a.map((p, k) => [p[0], ya[k], p[1]]), { name: `${trailNames[2]} (upper)`, kind: 'trail', validate: true }));
        best.onRoute = true;
        const exitFloor = nl.y - nl.r * 0.55;
        let endB = station.y;
        const jb = joinNetwork(b, STYLES.trail.hw, 12);
        if (jb) { b.length = 0; b.push(...jb.pts); endB = jb.y; }
        const yb = prof(b, 'trail', { startY: exitFloor + 0.2, endY: endB });
        legs.push(addRoute('trail', b.map((p, k) => [p[0], yb[k], p[1]]), { name: `${trailNames[2]} (lower)`, kind: 'trail', validate: true }));
      }
    }
    if (!legs.length) {
      const opts = kind === 'river' ? { riverBias: 0.45 } : {};
      let a = plan2(se.x, se.z, station.x, station.z, opts);
      if (a) {
        const style = kind === 'road' ? 'country' : 'trail';
        let endY = station.y;
        if (i > 0) { const j = joinNetwork(a, STYLES[style].hw); if (j) { a = j.pts; endY = j.y; } }
        const ya = prof(a, style, { startY: se.y, endY });
        legs.push(addRoute(style, a.map((p, k) => [p[0], ya[k], p[1]]), { name: trailNames[i] || 'Old Trail', kind: kind === 'road' ? 'road' : 'trail', validate: true }));
      }
    }
    for (const l of legs) occupy(l);
    journeys.push(...legs);
  });
  // approach to the spiral start from Lip Station
  const approach = (() => {
    const pts2 = [];
    const n = Math.ceil(station.arc / 2);
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const th = station.th + (th0 - station.th) * s;
      const off = 16 + (-0.6 - 16) * s;
      pts2.push(field.fromPolar(eyeR(th) + off, th));
    }
    const ys = prof(pts2, 'trail', { startY: station.y, endY: spiral.yStart, window: 1 });
    return addRoute('trail', pts2.map((p, i) => [p[0], ys[i], p[1]]), { name: 'Lip Approach', kind: 'trail', validate: true });
  })();
  journeys.push(approach);
  // Throat entrance connects to the nearest journey route by a short trail
  const throat = caves.find((c) => c.name === 'The Throat');
  let throatStartY = 0;
  if (throat) {
    const a = (() => {
      const cost = trailCost(coarse, hydro, { waterDistGrid, avoid: caveMouthMask, occupied });
      const n0 = throat.nodes[0], n1 = throat.nodes[1];
      const d0 = Math.hypot(n1.x - n0.x, n1.z - n0.z) || 1;
      const ap = [n0.x - (n1.x - n0.x) / d0 * 7, n0.z - (n1.z - n0.z) / d0 * 7];
      // start from the closest point of the journey network
      let best = null, bd = Infinity;
      for (const r of journeys) {
        if (r.type === 5 || r.style === 'ledge') continue;
        for (let k = 0; k < r.pts.length; k += 3) {
          const d = Math.hypot(r.pts[k] - ap[0], r.pts[k + 2] - ap[1]);
          if (d < bd) { bd = d; best = { x: r.pts[k], y: r.pts[k + 1], z: r.pts[k + 2] }; }
        }
      }
      if (!best) return null;
      throatStartY = best.y;
      const path = astar(coarse, best.x, best.z, ap[0], ap[1], cost, 150000);
      return path ? smoothPath([[best.x, best.z], ...path.slice(1, -1), ap, [n0.x - (n1.x - n0.x) / d0 * 3.5, n0.z - (n1.z - n0.z) / d0 * 3.5]], 2) : null;
    })();
    if (a) {
      const ya = prof(a, 'trail', { startY: throatStartY, endY: throat.nodes[0].y - throat.nodes[0].r * 0.55 + 0.2 });
      journeys.push(addRoute('trail', a.map((p, k) => [p[0], ya[k], p[1]]), { name: 'Throat Trail', kind: 'trail', validate: true }));
    }
  }
  mark('l1routes');
  // The Great Spiral, the Long Stair, the plain trail and the fault descent
  const spiralRoute = addRoute('ledge', spiral.pts.map((p) => [p[0], p[2], p[1]]), { name: 'The Great Spiral', kind: 'ledge', validate: true }, false);
  journeys.push(spiralRoute);
  const stairRoute = addRoute('ledge', longStair.pts.map((p) => [p[0], p[2], p[1]]), { name: 'The Long Stair', kind: 'ledge', validate: true, stairMat: M.RUIN2 }, false);
  journeys.push(stairRoute);
  {
    const a = [lastStair[0], lastStair[1]];
    const b = [fault.pts[0][0], fault.pts[0][1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(2, Math.ceil(len / 2));
    const pts2 = [];
    const bend = RNG.derive(seed, 'plaintrail').range(-0.15, 0.15) * len;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const nxp = -(b[1] - a[1]) / len, nzp = (b[0] - a[0]) / len;
      const off = Math.sin(Math.PI * t) * bend;
      pts2.push([a[0] + (b[0] - a[0]) * t + nxp * off, a[1] + (b[1] - a[1]) * t + nzp * off]);
    }
    const ys = prof(pts2, 'plainTrail', { startY: lastStair[2], endY: fault.pts[0][2], refY: () => params.plainY + 20 });
    journeys.push(addRoute('plainTrail', pts2.map((p, i) => [p[0], ys[i], p[1]]), { name: 'Plain Trail', kind: 'trail', validate: true }));
  }
  journeys.push(addRoute('faultLedge', fault.pts.map((p) => [p[0], p[2], p[1]]), { name: 'Threshold Descent', kind: 'ledge', validate: true }, false));
  // gallery trails: connect each spiral window to the deep tunnel mouths in that tier
  for (const w of galleryWindows) {
    const g = params.galleries[w.tier];
    const mouths = [];
    const tunnelTail = (c, fromEnd) => {
      const list = fromEnd ? c.nodes.slice().reverse() : c.nodes.slice();
      const out = [];
      let tr = 0;
      for (let k = 1; k < list.length && tr < 45; k++) {
        tr += Math.hypot(list[k].x - list[k - 1].x, list[k].z - list[k - 1].z);
        out.push([list[k].x, list[k].y - list[k].r * 0.55 + 0.05, list[k].z]);
      }
      return out;
    };
    for (const c of caves) {
      if (c.kind !== 'deep') continue;
      if (c.to === `gallery${w.tier}`) mouths.push({ m: c.exit, tail: tunnelTail(c, true) });
      if (c.from === `gallery${w.tier}`) mouths.push({ m: c.entrance, tail: tunnelTail(c, false) });
    }
    const resampleTail = (tail) => {
      const out = [];
      for (let k = 0; k < tail.length; k++) {
        const prev = k ? tail[k - 1] : null;
        if (prev) {
          const d = Math.hypot(tail[k][0] - prev[0], tail[k][2] - prev[2]);
          const n = Math.max(1, Math.round(d / 2));
          for (let q = 1; q < n; q++) out.push([prev[0] + (tail[k][0] - prev[0]) * q / n, prev[2] + (tail[k][2] - prev[2]) * q / n]);
        }
        out.push([tail[k][0], tail[k][2]]);
      }
      return out;
    };
    for (const { m, tail } of mouths) {
      const mth = Math.atan2(field.warpZ(m.x, m.z), field.warpX(m.x, m.z));
      const pts2 = [];
      const wTh = w.th;
      let dth = wrapAngle(mth - wTh);
      const UA = 0.78;
      const steps = Math.max(4, Math.ceil(Math.abs(dth) * (eyeR(wTh) + 100) / 2.5));
      const D0 = Math.max(30, tempGen.galleryDepth(w.tier, wTh));
      pts2.push(field.fromPolar(eyeR(wTh) + 1.5, wTh));
      for (let rr = 6; rr < D0 * UA; rr += 3) pts2.push(field.fromPolar(eyeR(wTh) + rr, wTh));
      for (let i = 0; i <= steps; i++) {
        const th = wTh + dth * (i / steps);
        const D = Math.max(30, tempGen.galleryDepth(w.tier, th));
        pts2.push(field.fromPolar(eyeR(th) + D * UA, th));
      }
      const mD = Math.hypot(m.x - pts2[pts2.length - 1][0], m.z - pts2[pts2.length - 1][1]);
      const nm = Math.ceil(mD / 2.5);
      const last = pts2[pts2.length - 1];
      for (let i = 1; i <= nm; i++) pts2.push([last[0] + (m.x - last[0]) * (i / nm), last[1] + (m.z - last[1]) * (i / nm)]);
      const pts = smoothPath(pts2, 2);
      const endFloor = m.y - m.r * 0.55 + 0.05;
      const ys = prof(pts, 'galleryTrail', { startY: w.y, endY: endFloor, band: [g.yTop - 4, g.yTop - g.height - 12] });
      const pts3 = pts.map((p, i) => [p[0], ys[i], p[1]]);
      void tail; void resampleTail;
      journeys.push(addRoute('galleryTrail', pts3, { name: `Gallery Path ${w.tier + 1}`, kind: 'trail', validate: true }));
    }
  }
  for (const c of caves) {
    if (c.kind !== 'deep' || c.to !== 'plain') continue;
    const inside = c.nodes.slice(-7).map((nd) => [nd.x, nd.y - nd.r * 0.55 + 0.05, nd.z]);
    const last = c.nodes[c.nodes.length - 1], prev = c.nodes[c.nodes.length - 2];
    const d = Math.hypot(last.x - prev.x, last.z - prev.z) || 1;
    const out = [];
    for (let k = 1; k <= 6; k++) {
      const x = last.x + (last.x - prev.x) / d * k * 2, z = last.z + (last.z - prev.z) / d * k * 2;
      out.push([x, z]);
    }
    const ys = prof(out, 'plainTrail', { startY: inside[inside.length - 1][1], band: [params.plainY + 40, params.plainY - 20] });
    journeys.push(addRoute('plainTrail', inside.concat(out.map((p, k) => [p[0], ys[k], p[1]])), { name: 'Root Chute Mouth', kind: 'trail', validate: true }));
  }
  plan.routes = routes;
  mark('l2routes');

  // ---- final column generator and validation
  progress('Validating routes', 0.72);
  const gen = new ColumnGen(plan);
  const validation = { routes: [], caves: [], ok: true };
  for (const r of journeys) {
    const res = validatePath(gen, densify(routeTo3(r), 0.5), { tol: 0.9 });
    validation.routes.push({ id: r.id, name: r.name, ok: res.ok, samples: res.samples, failures: res.failures.length, first: res.failures.slice(0, 3), jumps: res.jumps, length: Math.round(r.length) });
    if (!res.ok) validation.ok = false;
  }
  for (const c of caves) {
    if (!c.walkable) continue;
    const samples = [];
    for (const [i, j] of c.links) {
      const a = c.nodes[i], b = c.nodes[j];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const r = a.r + (b.r - a.r) * t;
        samples.push([a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t - r * 0.55 + 0.4, a.z + (b.z - a.z) * t]);
      }
    }
    const res = validatePath(gen, samples, { tol: 1.0, drop: 4.5 });
    validation.caves.push({ id: c.id, name: c.name, kind: c.kind, ok: res.ok, samples: res.samples, failures: res.failures.length, first: res.failures.slice(0, 3) });
    if (!res.ok) validation.ok = false;
  }
  mark('validate');

  // ---- resolve heights of decor and landmarks against the final world
  const top = (x, z) => { gen.column(x, z, 0, col); return col.n ? col.y1[col.n - 1] : 0; };
  const floorNear = (x, z, y) => { gen.column(x, z, 0, col); const f = col.floorBelow(y + 1.5); return f >= 0 ? col.y1[f] : y; };
  for (const d of city.decor) if (!d.y) d.y = top(d.x, d.z);
  for (const lm of landmarks) lm.y = lm.y ?? top(lm.x, lm.z);
  const spawnY = top(city.spawn.x, city.spawn.z);

  // ---- artifact sites (contextual): ruins, cave chambers, spires, crystals, the threshold
  progress('Hiding artifacts', 0.82);
  const sites = [];
  for (const r of [...l1.ruins, ...l2.ruins]) for (const s of r.spots) sites.push({ x: s.x, z: s.z, y: floorNear(s.x, s.z, s.y), layer: r.layer, context: s.context, place: r.name, kind: 'ruin' });
  for (const c of caves) {
    if (c.kind !== 'cave') continue;
    for (const ci of c.chambers) {
      const nd = c.nodes[ci];
      sites.push({ x: nd.x, z: nd.z, y: floorNear(nd.x, nd.z, nd.y), layer: nd.y < LAYER_BOUNDARIES.layer2Top ? 2 : 1, context: 'deep inside a cave chamber', place: c.name, kind: 'cave' });
    }
  }
  for (const sp of l1.spires) sites.push({ x: sp.x, z: sp.z, y: floorNear(sp.x, sp.z, sp.y + 1), layer: 1, context: 'atop a sheer rock spire', place: 'a rock spire near the Eye', kind: 'spire' });
  for (const cr of l2.crystals) sites.push({ x: cr.x + 2.5, z: cr.z, y: floorNear(cr.x + 2.5, cr.z, cr.y + 1), layer: 2, context: 'among glowing crystal growths', place: 'a crystal geode', kind: 'crystal' });
  {
    const t = fault.threshold;
    sites.push({ x: t.x, z: t.z, y: t.y, layer: 3, context: 'beneath the arch of the Threshold', place: 'The Threshold', kind: 'threshold' });
  }
  for (const wf of waterfalls.filter((w) => w.kind === 'eye').slice(0, 3)) {
    const p = pools.find((pp) => Math.hypot(pp.x - wf.x, pp.z - wf.z) < 30 && pp.kind === 'plunge');
    if (p && Number.isFinite(p.level)) sites.push({ x: p.x + p.r + 2, z: p.z, y: floorNear(p.x + p.r + 2, p.z, p.level + 1), layer: 2, context: 'in the spray of a great waterfall', place: wf.name, kind: 'falls' });
  }
  // city: a couple of curios
  if (city.guild) sites.push({ x: city.guild.x, z: city.guild.z, y: top(city.guild.x, city.guild.z), layer: 0, context: "on the roof of the Delvers' Guild", place: 'the Guild', kind: 'city' });
  const artifacts = generateArtifacts(seed, sites, names);
  mark('artifacts');

  progress('Generating species', 0.9);
  const species = generateSpecies(seed, names);
  mark('species');

  Object.assign(plan, {
    names: { city: city.name },
    caves: caves.map((c) => ({ id: c.id, kind: c.kind, name: c.name, entrance: c.entrance, exit: c.exit, walkable: !!c.walkable, from: c.from, to: c.to, nodes: c.nodes.length > 400 ? undefined : c.nodes })),
    city: {
      name: city.name, gates: city.gates, platforms: city.platforms, windmills: city.windmills, decor: city.decor,
      parks: city.parks, hamlets: city.hamlets, districts: city.districts, rings: city.rings, guild: city.guild, buildings: city.buildings,
    },
    spawn: { x: city.spawn.x, y: spawnY + 0.05, z: city.spawn.z, yaw: Math.atan2(-city.spawn.lookX, -city.spawn.lookZ) },
    landmarks: landmarks.map((l, i) => ({ id: i, ...l })),
    waterfalls,
    spiral: { th0: spiral.th0, thEnd: spiral.thEnd, yStart: spiral.yStart, yEnd: spiral.yEnd, dir: spiral.dir, length: spiral.length },
    station,
    threshold: fault.threshold,
    journeys: journeys.map((r) => r.id),
    validation,
    artifacts,
    species,
    eyeFalls,
    l1: { ruins: l1.ruins.length, arches: l1.arches.length, spires: l1.spires.length },
    l2: { ruins: l2.ruins.length, crystals: l2.crystals.length, monoliths: l2.monoliths.length },
    stats: {},
  });
  plan.stats = {
    prims: plan.prims.length, routes: routes.length, rivers: rivers.length, lakes: lakes.length, caves: caves.length,
    pools: plan.pools.length, landmarks: plan.landmarks.length, artifacts: artifacts.length, species: species.length,
    buildings: city.buildings, timings, totalMs: Math.round(now() - T0),
  };
  progress('World ready', 1);
  void Z_EYE; void Z_BOWL; void box;
  return plan;
}
