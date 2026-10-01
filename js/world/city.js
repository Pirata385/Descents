// Procedural rim city. The settlement rings the rim of the bowl: a promenade
// along the cliff edge with observation platforms, ring roads and radial
// avenues dividing it into blocks, districts (guild, market, residential,
// workshops, storage, temple), descent gates with stairways into Layer 1,
// windmills, and outlying hamlets with farm fields.
import { RNG } from '../core/rng.js';
import { TAU, clamp, wrapAngle, angle01 } from '../core/mathutil.js';
import { M } from './materials.js';
import { box, cyl, cone, dome, flat, matPatch, building, tower, OP_ADD, OP_CARVE } from './structures.js';
import { Z_CITY, Z_COUNTRY } from './field.js';

const DISTRICTS = ['residential', 'residential', 'residential', 'workshops', 'storage', 'market', 'temple', 'gardens'];

export function generateCity(ctx) {
  const { field, params, names, waterDist } = ctx;
  const rng = RNG.derive(params.seed, 'city');
  const out = {
    name: names.name('city'),
    prims: [], streets: [], decor: [], landmarks: [], gates: [], platforms: [], windmills: [], parks: [],
    hamlets: [], radials: [], rings: [], spawn: null, districts: [], pools: [],
  };
  const P = {}, S = {};
  const rimAt = (th) => field.tab(field.rimTab, th);
  const depthAt = (th) => field.tab(field.cityTab, th);
  const W = (o, th) => field.fromPolar(rimAt(th) + o, th);
  const groundAt = (x, z) => { field.polar(x, z, P); field.surface(x, z, P, S); return S.h; };
  const tangentAngle = (o, th) => {
    const R = rimAt(th) + o;
    const d = 2 / R;
    const [ax, az] = W(o, th - d), [bx, bz] = W(o, th + d);
    return Math.atan2(bz - az, bx - ax);
  };
  const addPrims = (list) => { for (const p of list) out.prims.push(p); };

  // --- radial avenues
  const N = params.city.radials;
  const theta0 = rng.range(0, TAU);
  const radials = [];
  for (let i = 0; i < N; i++) {
    radials.push(angle01(theta0 + (i * TAU) / N + rng.range(-0.22, 0.22) * TAU / N));
  }
  radials.sort((a, b) => a - b);
  // main gate is on the first radial after theta0
  const mainIdx = radials.reduce((best, th, i) => (Math.abs(wrapAngle(th - theta0)) < Math.abs(wrapAngle(radials[best] - theta0)) ? i : best), 0);
  const mainTh = radials[mainIdx];

  // --- ring roads (offsets from the rim)
  const ringOffsets = [16];
  let o = 16;
  while (true) {
    o += rng.range(82, 96);
    if (o > params.cityDepth * 1.15) break;
    ringOffsets.push(o);
  }
  const ringW = ringOffsets.map((_, i) => (i === 0 ? 7 : 5));
  out.rings = ringOffsets;

  // districts per sector between radials
  const sectorDistrict = [];
  for (let i = 0; i < N; i++) {
    if (i === mainIdx) sectorDistrict.push('guild');
    else sectorDistrict.push(DISTRICTS[(i * 7 + rng.int(0, 7)) % DISTRICTS.length]);
  }
  // ensure a market exists
  if (!sectorDistrict.includes('market')) sectorDistrict[(mainIdx + 1) % N] = 'market';
  if (!sectorDistrict.includes('storage')) sectorDistrict[(mainIdx + N - 1) % N] = 'storage';
  const sectorOf = (th) => {
    const a = angle01(th);
    for (let i = N - 1; i >= 0; i--) if (a >= radials[i]) return i;
    return N - 1;
  };
  out.districts = radials.map((th, i) => ({ th0: th, th1: radials[(i + 1) % N], kind: sectorDistrict[i] }));

  // --- streets as polylines (positions only; profiles are computed by the route system)
  const ringExists = (k, th) => k === 0 || ringOffsets[k] < depthAt(th) - 12;
  for (let k = 0; k < ringOffsets.length; k++) {
    const off = ringOffsets[k];
    let cur = null;
    const R = rimAt(0) + off;
    const steps = Math.ceil((TAU * R) / 4);
    for (let s = 0; s <= steps; s++) {
      const th = -Math.PI + (s / steps) * TAU;
      if (ringExists(k, th)) {
        if (!cur) cur = [];
        const [x, z] = W(off, th);
        cur.push([x, z]);
      } else if (cur) {
        if (cur.length > 4) out.streets.push({ pts: cur, kind: k === 0 ? 'promenade' : 'ring', hw: ringW[k] / 2 });
        cur = null;
      }
    }
    if (cur && cur.length > 4) out.streets.push({ pts: cur, kind: k === 0 ? 'promenade' : 'ring', hw: ringW[k] / 2, closed: k === 0 });
  }
  // radial avenues and lanes
  const streetAngles = [];
  for (let i = 0; i < N; i++) {
    streetAngles.push({ th: radials[i], hw: 2.6, avenue: true });
    const next = i === N - 1 ? radials[0] + TAU : radials[i + 1];
    const span = next - radials[i];
    const midR = rimAt(radials[i]) + 100;
    const lanes = Math.max(0, Math.floor((span * midR) / 58) - 1);
    for (let l = 1; l <= lanes; l++) streetAngles.push({ th: angle01(radials[i] + (span * l) / (lanes + 1)), hw: 1.6, avenue: false });
  }
  streetAngles.sort((a, b) => a.th - b.th);
  for (const sa of streetAngles) {
    const maxO = Math.min(depthAt(sa.th) - 6, ringOffsets[ringOffsets.length - 1]);
    const lastRing = ringOffsets.filter((ro, k) => ringExists(k, sa.th)).pop();
    const endO = sa.avenue ? Math.max(lastRing, Math.min(maxO + 30, depthAt(sa.th) + 25)) : lastRing;
    if (endO <= 20) continue;
    const pts = [];
    for (let oo = 16; oo <= endO; oo += 4) pts.push(W(oo, sa.th));
    out.streets.push({ pts, kind: sa.avenue ? 'avenue' : 'lane', hw: sa.hw, th: sa.th });
    if (sa.avenue) out.radials.push({ th: sa.th, end: W(endO, sa.th), endO });
  }

  // --- gates (descent stairways start at the promenade)
  const gateCount = rng.int(3, 4);
  const gateAngles = [mainTh + 0.012];
  for (let g = 1; g < gateCount; g++) gateAngles.push(angle01(mainTh + (g * TAU) / gateCount + rng.range(-0.3, 0.3)));
  gateAngles.forEach((th, gi) => {
    const [x, z] = W(11, th);
    const y = Math.round(groundAt(...W(16, th)) * 2) / 2;
    const ang = tangentAngle(11, th);
    // gate pillars + lintel across the stair head
    const c = Math.cos(ang), s = Math.sin(ang);
    for (const sgn of [-1, 1]) {
      const px = x + c * 3.2 * sgn, pz = z + s * 3.2 * sgn;
      out.prims.push(box(OP_ADD, px, pz, { angle: ang, hw: 0.9, hd: 0.9, y0: y - 2, y1: y + 7.5, top: M.BRICK, side: M.BRICK }));
    }
    out.prims.push(box(OP_ADD, x, z, { angle: ang, hw: 4.2, hd: 0.9, y0: y + 6.0, y1: y + 7.5, top: M.ROOF_A, side: M.BRICK, maxLod: 1 }));
    out.gates.push({ id: gi, th, x, z, y, main: gi === 0, name: gi === 0 ? 'The Great Descent Gate' : `${names.name('gate', gi)} Gate` });
    out.landmarks.push({ type: 'gate', name: gi === 0 ? 'The Great Descent Gate' : `${names.name('gate', gi)} Gate`, x, z, y, layer: 0 });
    out.decor.push({ type: 'banner', x: x + c * 3.2, z: z + s * 3.2, y: y + 7.5, rot: ang });
    out.decor.push({ type: 'banner', x: x - c * 3.2, z: z - s * 3.2, y: y + 7.5, rot: ang });
  });
  const nearGate = (th, tol) => gateAngles.some((g) => Math.abs(wrapAngle(g - th)) < tol);

  // --- observation platforms on the rim
  {
    const R = rimAt(0);
    const count = Math.floor((TAU * R) / rng.range(95, 140));
    for (let i = 0; i < count; i++) {
      const th = -Math.PI + ((i + rng.range(0.2, 0.8)) / count) * TAU;
      if (nearGate(th, 0.06)) continue;
      const [x, z] = W(1, th);
      const y = Math.round(groundAt(...W(18, th)) * 2) / 2;
      const ang = tangentAngle(1, th);
      const hw = rng.range(3.5, 5), hd = rng.range(9, 13);
      const wood = rng.chance(0.6);
      out.prims.push(box(OP_ADD, x, z, { angle: ang, hw, hd, y0: y - 1.2, y1: y, top: wood ? M.WOOD : M.COBBLE, side: wood ? M.WOOD : M.BRICK, exp: 0.6 }));
      out.platforms.push({ x, z, y, ang, hw, hd, wood });
      // railings around the outer three sides
      const vx = -Math.sin(ang), vz = Math.cos(ang); // inward (toward the abyss)
      const ux = Math.cos(ang), uz = Math.sin(ang);
      out.decor.push({ type: 'railing', x: x + vx * hd, z: z + vz * hd, y, rot: ang, len: hw * 2 });
      out.decor.push({ type: 'railing', x: x + ux * hw, z: z + uz * hw, y, rot: ang + Math.PI / 2, len: hd * 2 - 6, off: 3 });
      out.decor.push({ type: 'railing', x: x - ux * hw, z: z - uz * hw, y, rot: ang + Math.PI / 2, len: hd * 2 - 6, off: 3 });
      if (rng.chance(0.35)) out.decor.push({ type: 'crane', x: x + vx * (hd - 1.5), z: z + vz * (hd - 1.5), y, rot: ang });
      else out.decor.push({ type: 'telescope', x: x + vx * (hd - 2), z: z + vz * (hd - 2), y, rot: ang });
      if (i % 3 === 0) out.landmarks.push({ type: 'platform', name: `${names.name('deck', i)} Overlook`, x, z, y, layer: 0, minor: true });
    }
  }

  // --- blocks and buildings
  const sortedStreets = streetAngles.slice();
  let guildPlaced = false, marketPlaced = 0, templePlaced = false, observatoryPlaced = false;
  const buildingsMeta = [];
  for (let si = 0; si < sortedStreets.length; si++) {
    const A = sortedStreets[si], B = sortedStreets[(si + 1) % sortedStreets.length];
    let thA = A.th, thB = B.th;
    if (thB <= thA) thB += TAU;
    const thMid = (thA + thB) / 2;
    const district = sectorDistrict[sectorOf(thMid)];
    for (let k = 0; k < ringOffsets.length; k++) {
      if (!ringExists(k, thMid)) continue;
      const innerO = ringOffsets[k] + ringW[k] / 2 + 1.2;
      const hasOuter = k + 1 < ringOffsets.length && ringExists(k + 1, thMid);
      const outerO = hasOuter ? ringOffsets[k + 1] - ringW[k + 1] / 2 - 1.2 : Math.min(depthAt(thMid) - 4, innerO + 40);
      const depth = outerO - innerO;
      if (depth < 12) continue;
      const Rmid = rimAt(thMid) + (innerO + outerO) / 2;
      const marginA = (A.hw + 1.4) / Rmid, marginB = (B.hw + 1.4) / Rmid;
      const a0 = thA + marginA, a1 = thB - marginB;
      if (a1 - a0 < 10 / Rmid) continue;
      const blockMidO = (innerO + outerO) / 2;
      const [bx, bz] = W(blockMidO, thMid);
      if (waterDist(bx, bz) < 6) continue;

      // special blocks
      if (district === 'guild' && !guildPlaced && k === 0) {
        guildPlaced = true;
        placeGuild(thMid, innerO, outerO, a0, a1);
        continue;
      }
      if (district === 'market' && marketPlaced < 2 && depth > 18) {
        marketPlaced++;
        placeMarket(thMid, innerO, outerO, a0, a1);
        continue;
      }
      if (district === 'temple' && !templePlaced && depth > 22) {
        templePlaced = true;
        placeTemple(thMid, innerO, outerO);
        continue;
      }
      if (district === 'gardens' || rng.chance(0.05)) {
        const ang = tangentAngle(blockMidO, thMid);
        const arc = (a1 - a0) * Rmid;
        out.prims.push(matPatch(bx, bz, { angle: ang, hw: arc / 2, hd: depth / 2, top: M.MEADOW, side: 1 }));
        out.parks.push({ x: bx, z: bz, r: Math.min(arc, depth) / 2 });
        if (rng.chance(0.5)) out.decor.push({ type: 'fountain', x: bx, z: bz, y: 0 });
        continue;
      }
      // two rows of plots
      const rows = depth > 26 ? [[innerO, Math.min(15, depth / 2 - 1), 3], [outerO, -Math.min(15, depth / 2 - 1), 2]] : [[innerO, depth, 3]];
      for (const [edgeO, rowDepthSigned, doorSide] of rows) {
        const rowDepth = Math.abs(rowDepthSigned);
        const centerO = edgeO + rowDepthSigned / 2;
        const R = rimAt(thMid) + centerO;
        let th = a0;
        while (th < a1) {
          const wPlot = district === 'storage' ? rng.range(14, 20) : district === 'workshops' ? rng.range(9, 14) : rng.range(7, 11.5);
          const dTh = wPlot / R;
          if (th + dTh > a1) break;
          const thc = th + dTh / 2;
          th += dTh;
          if (rng.chance(1 - params.city.density * 0.95)) continue;
          const [x, z] = W(centerO, thc);
          const ang = tangentAngle(centerO, thc);
          const w = wPlot - rng.range(0.8, 2.2);
          const d = rowDepth - rng.range(1, 3.5);
          if (d < 5) continue;
          const halfDiag = Math.hypot(w, d) / 2;
          if (waterDist(x, z) < halfDiag + 4) continue;
          field.polar(x, z, P);
          if (P.zone !== Z_CITY) continue;
          // slope check
          const c = Math.cos(ang), s = Math.sin(ang);
          let hmin = 1e9, hmax = -1e9;
          for (const [cu, cv] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
            const h = groundAt(x + c * cu * w / 2 - s * cv * d / 2, z + s * cu * w / 2 + c * cv * d / 2);
            hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
          }
          if (hmax - hmin > 4) continue;
          const by = Math.round(groundAt(x, z) * 2) / 2;
          const nearRim = clamp(1 - (centerO - 16) / 200, 0, 1);
          let floors = 1 + Math.round(rng.range(0, 1.4) + nearRim * 1.6 + params.city.floorsBias);
          if (district === 'storage') floors = rng.int(1, 2);
          floors = clamp(floors, 1, 4);
          const roofType = district === 'storage' ? 'gable' : rng.chance(params.city.hipRoofs) ? 'hip' : rng.chance(0.05) ? 'flat' : 'gable';
          const roofMat = rng.chance(0.75) ? M.ROOF_A : rng.chance(0.6) ? M.ROOF_B : M.ROOF_C;
          const wall = district === 'storage' || district === 'workshops' ? (rng.chance(0.5) ? M.BRICK : M.WOOD) : rng.chance(0.85) ? M.PLASTER : M.BRICK;
          if (rng.chance(params.city.towerChance) && district !== 'storage') {
            const t = tower(x, z, { r: Math.min(w, d) / 2 - 0.5, base: by, height: floors * 3.6 + rng.range(6, 12), wall: M.BRICK, roof: roofMat });
            addPrims(t.prims);
            buildingsMeta.push({ x, z, y: by, kind: 'tower' });
            continue;
          }
          const b = building(x, z, {
            angle: ang, w, d, base: by, floors, wall, roof: roofMat, roofType,
            pitch: rng.range(0.55, 0.95), doorSide, chimney: district === 'workshops' ? true : rng.chance(0.3),
            foundation: 2 + (by - hmin),
          });
          addPrims(b.prims);
          buildingsMeta.push({ x, z, y: by, kind: district, top: b.roofTop });
          if (district === 'storage' && rng.chance(0.7)) {
            const vx = -s, vz = c;
            const side = doorSide === 3 ? 1 : -1;
            out.decor.push({ type: 'crates', x: x + vx * side * (d / 2 + 1.6), z: z + vz * side * (d / 2 + 1.6), y: 0, rot: ang });
          }
          if (district === 'workshops' && rng.chance(0.4)) {
            out.decor.push({ type: 'barrels', x: x + c * (w / 2 + 1.0), z: z + s * (w / 2 + 1.0), y: 0, rot: ang });
          }
        }
      }
    }
  }

  function placeGuild(thMid, innerO, outerO, a0, a1) {
    const o = Math.min(innerO + 14, (innerO + outerO) / 2);
    const [x, z] = W(o, thMid);
    const ang = tangentAngle(o, thMid);
    const by = Math.round(groundAt(x, z) * 2) / 2;
    const b = building(x, z, { angle: ang, w: 26, d: 16, base: by, floors: 3, wall: M.BRICK, roof: M.ROOF_C, roofType: 'hip', pitch: 0.55, doorSide: 3, chimney: true, foundation: 4 });
    addPrims(b.prims);
    const c = Math.cos(ang), s = Math.sin(ang);
    const t = tower(x + c * 15, z + s * 15, { r: 4.5, base: by, height: 24, wall: M.BRICK, roof: M.ROOF_C, roofH: 11 });
    addPrims(t.prims);
    out.landmarks.push({ type: 'guild', name: `Delvers' Guild of ${out.name}`, x, z, y: b.roofTop, layer: 0 });
    out.decor.push({ type: 'flag', x: x + c * 15, z: z + s * 15, y: t.top, rot: ang });
    // yard with tents and supplies on the far side
    const vx = -s, vz = c;
    for (let i = 0; i < 4; i++) {
      out.decor.push({ type: i % 2 ? 'tent' : 'crates', x: x - c * (8 - i * 6) - vx * 12, z: z - s * (8 - i * 6) - vz * 12, y: 0, rot: ang });
    }
    out.guild = { x, z, y: by, ang };
  }

  function placeMarket(thMid, innerO, outerO, a0, a1) {
    const o = (innerO + outerO) / 2;
    const [x, z] = W(o, thMid);
    const ang = tangentAngle(o, thMid);
    const R = rimAt(thMid) + o;
    const hw = ((a1 - a0) * R) / 2 - 1, hd = (outerO - innerO) / 2 - 0.5;
    const by = Math.round(groundAt(x, z) * 2) / 2;
    out.prims.push(flat(x, z, { angle: ang, hw, hd, y0: by, feather: 3, top: M.COBBLE }));
    const c = Math.cos(ang), s = Math.sin(ang);
    const nStalls = Math.floor((hw * 2) / 6);
    for (let i = 0; i < nStalls; i++) {
      for (const row of [-1, 1]) {
        if (rng.chance(0.25)) continue;
        const u = -hw + 3 + i * 6, v = row * (hd * 0.55);
        out.decor.push({ type: 'stall', x: x + c * u - s * v, z: z + s * u + c * v, y: 0, rot: ang + (row > 0 ? Math.PI : 0), variant: rng.int(0, 5) });
      }
    }
    // fountain basin in the middle
    out.prims.push(cyl(OP_ADD, x, z, { r: 3.4, y0: by - 1, y1: by + 0.5, top: M.BRICK, side: M.BRICK }));
    out.prims.push(cyl(OP_CARVE, x, z, { r: 2.6, y0: by - 0.5, y1: by + 0.6, top: M.BRICK, bot: M.BRICK }));
    out.prims.push(cyl(OP_ADD, x, z, { r: 0.6, y0: by - 0.5, y1: by + 2.5, top: M.RUIN, side: M.RUIN }));
    out.pools.push({ x, z, r: 2.4, level: by - 0.05, depth: 0.2, fixed: true, bed: M.BRICK, rim: M.BRICK, kind: 'fountain' });
    out.landmarks.push({ type: 'market', name: `${names.name('market', marketPlaced)} Market`, x, z, y: by, layer: 0 });
  }

  function placeTemple(thMid, innerO, outerO) {
    const o = (innerO + outerO) / 2;
    const [x, z] = W(o, thMid);
    const ang = tangentAngle(o, thMid);
    const by = Math.round(groundAt(x, z) * 2) / 2;
    const r = Math.min(10, (outerO - innerO) / 2 - 2);
    out.prims.push(flat(x, z, { r: r + 3, y0: by, feather: 2.5, top: M.COBBLE }));
    out.prims.push(cyl(OP_ADD, x, z, { r, y0: by - 3, y1: by + 7, top: M.PLASTER, side: M.PLASTER }));
    out.prims.push(dome(x, z, { r: r + 0.5, y0: by + 7, h: r * 0.9, top: M.ROOF_C, side: M.ROOF_C }));
    out.prims.push(cone(x, z, { r: 1.2, y0: by + 7 + r * 0.9 - 0.5, h: 4, top: M.METAL, side: M.METAL }));
    out.landmarks.push({ type: 'temple', name: `Temple of ${names.name('temple')}`, x, z, y: by + 7 + r, layer: 0 });
    void ang;
  }

  // --- observatory tower near the rim
  if (!observatoryPlaced) {
    for (let tries = 0; tries < 30 && !observatoryPlaced; tries++) {
      const th = rng.range(-Math.PI, Math.PI);
      if (nearGate(th, 0.08)) continue;
      const [x, z] = W(26, th);
      if (waterDist(x, z) < 15) continue;
      const by = Math.round(groundAt(x, z) * 2) / 2;
      const t = tower(x, z, { r: 4, base: by, height: 30, wall: M.PLASTER, roof: M.METAL, roofH: 5 });
      addPrims(t.prims);
      out.landmarks.push({ type: 'observatory', name: 'Abyss Observatory', x, z, y: t.top, layer: 0 });
      observatoryPlaced = true;
    }
  }

  // --- windmills on the outer edge and the ridge
  for (let i = 0; i < params.city.windmills * 3 && out.windmills.length < params.city.windmills; i++) {
    const th = rng.range(-Math.PI, Math.PI);
    const oo = depthAt(th) + rng.range(15, 140);
    const [x, z] = W(oo, th);
    field.polar(x, z, P);
    if (P.zone !== Z_COUNTRY && P.zone !== Z_CITY) continue;
    if (waterDist(x, z) < 14) continue;
    if (out.windmills.some((w) => Math.hypot(w.x - x, w.z - z) < 60)) continue;
    const by = Math.round(groundAt(x, z) * 2) / 2;
    out.prims.push(flat(x, z, { r: 5, y0: by, feather: 3, top: M.DIRT }));
    out.prims.push(cyl(OP_ADD, x, z, { r: 3.2, y0: by - 3, y1: by + 4, top: M.PLASTER, side: M.PLASTER }));
    out.prims.push(cyl(OP_ADD, x, z, { r: 2.7, y0: by + 4, y1: by + 8, top: M.PLASTER, side: M.PLASTER }));
    out.prims.push(cyl(OP_ADD, x, z, { r: 2.2, y0: by + 8, y1: by + 11, top: M.PLASTER, side: M.PLASTER }));
    out.prims.push(cone(x, z, { r: 2.9, y0: by + 11, h: 3.2, top: M.ROOF_A, side: M.ROOF_A }));
    const face = Math.atan2(-z, -x) + rng.range(-0.4, 0.4);
    out.windmills.push({ x, z, y: by + 10.5, face, speed: rng.range(0.4, 0.9) });
  }

  // --- hamlets in the countryside
  const nH = params.city.hamlets;
  for (let h = 0, tries = 0; out.hamlets.length < nH && tries < 200; tries++, h++) {
    const th = rng.range(-Math.PI, Math.PI);
    const Rc = field.tab(field.coastTab, th);
    const rCity = rimAt(th) + depthAt(th);
    const lo = rCity + 55, hi = Rc - 60;
    if (hi - lo < 20) continue;
    const r = rng.range(lo, hi);
    const [x, z] = field.fromPolar(r, th);
    if (waterDist(x, z) < 20) continue;
    if (out.hamlets.some((hm) => Math.hypot(hm.x - x, hm.z - z) < 180)) continue;
    const hamlet = { x, z, name: names.name('hamlet', h), th };
    out.hamlets.push(hamlet);
    out.landmarks.push({ type: 'hamlet', name: hamlet.name, x, z, y: groundAt(x, z), layer: 0 });
    const nHouses = rng.int(4, 9);
    for (let i = 0; i < nHouses; i++) {
      const a = (i / nHouses) * TAU + rng.range(-0.3, 0.3);
      const rr = rng.range(13, 28);
      const hx = x + Math.cos(a) * rr, hz = z + Math.sin(a) * rr;
      if (waterDist(hx, hz) < 9) continue;
      const by = Math.round(groundAt(hx, hz) * 2) / 2;
      const b = building(hx, hz, { angle: a + Math.PI / 2, w: rng.range(6, 9), d: rng.range(6, 8), base: by, floors: rng.int(1, 2), wall: rng.chance(0.5) ? M.WOOD : M.PLASTER, roof: rng.chance(0.7) ? M.ROOF_A : M.ROOF_B, pitch: rng.range(0.7, 1.0), doorSide: 3, chimney: rng.chance(0.5), foundation: 3 });
      addPrims(b.prims);
    }
    const nFields = rng.int(3, 6);
    for (let i = 0; i < nFields; i++) {
      const a = rng.range(0, TAU);
      const rr = rng.range(40, 75);
      const fx = x + Math.cos(a) * rr, fz = z + Math.sin(a) * rr;
      field.polar(fx, fz, P);
      if (P.zone !== Z_COUNTRY || waterDist(fx, fz) < 10) continue;
      out.prims.push(matPatch(fx, fz, { angle: rng.range(0, Math.PI), hw: rng.range(10, 20), hd: rng.range(7, 13), top: rng.chance(0.75) ? M.FIELD : M.DIRT }));
    }
  }

  // --- spawn point on the promenade in front of the guild
  const sth = mainTh + 0.03;
  const [sx, sz] = W(18, sth);
  out.spawn = { x: sx, z: sz, th: sth, lookX: -Math.cos(sth), lookZ: -Math.sin(sth) };
  out.mainGateTh = mainTh;
  out.buildings = buildingsMeta.length;
  return out;
}
