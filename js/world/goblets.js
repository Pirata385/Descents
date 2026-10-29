// Layer 4, the Goblets of Giants. Beyond the Fourth Gate a stair winds down to
// a vast cavern (about 700 m across and 330 m high). Colossal goblets rise
// from its floor on twisted, root-flared trunks; each cup holds a shallow lake
// that spills through a notch in its rim as a waterfall, into a lower cup or
// down to the mere on the cavern floor. A chain of goblets descends in a
// spiral, rim linked to rim by walkable root bridges, from the gate to the
// floor; side goblets, cascades of small cups and the Throne Cup (the lair of
// the layer's warden) branch off it. Hanging roots and vines drip from the
// ceiling and from under the cups.
//
// planLayer4() lays the layer out (pure data in the plan); Layer4 evaluates
// columns for the column generator: it carves the cavern, then adds goblet
// trunks, cups, rims, root bridges and the water of the lakes.
import { RNG } from '../core/rng.js';
import { clamp, smoothstep, TAU, wrapAngle } from '../core/mathutil.js';
import { M } from './materials.js';
import { cyl, OP_ADD } from './structures.js';

/** Terrain below this height is meshed apart (see the mesher) and drawn only near Layer 4. */
export const SPLIT_Y = -1995;
export const L4_BOTTOM = -2400;

const WOBN = 64;
const MAX_GRADE = 0.34;

/** Deterministic smooth noise from a few seeded sines (identical in the plan and the workers). */
function sines(ph, x, z) {
  return (Math.sin(x * 0.021 + ph[0]) * Math.cos(z * 0.017 + ph[1]) + Math.sin((x + z) * 0.043 + ph[2]) * 0.5 + Math.sin((x - z) * 0.09 + ph[3]) * 0.25) / 1.75;
}

// ------------------------------------------------------------------ shape functions (shared by plan and columns)
export function wallR(d4, th) {
  const f = ((th + Math.PI) / TAU) * WOBN;
  const i = Math.floor(f), t = f - i;
  const a = d4.wob[((i % WOBN) + WOBN) % WOBN], b = d4.wob[(((i + 1) % WOBN) + WOBN) % WOBN];
  return d4.R * (a + (b - a) * t);
}

export function ceilAt(d4, x, z, dist, Rw) {
  const u = dist / Rw;
  return d4.ceilC - 12 * u * u + sines(d4.ph, x, z) * 3;
}

export function floorAt(d4, x, z, dist, Rw) {
  const u = dist / Rw;
  return d4.floorC + 42 * u * u * u + sines(d4.ph, z * 1.3, x * 1.3) * 2.5;
}

/** Trunk radius of goblet g at height y and angle th (root flare, bulges, twisted ridges). */
function trunkR(g, y, th) {
  const h = y - g.yBase;
  const base = g.rt * (1 + 0.16 * Math.sin(h * 0.035 + g.ph));
  const flare = 1 + 1.7 * Math.exp(-h / 9);
  const amp = g.ridgeAmp * (1 + 1.4 * Math.exp(-h / 12));
  const c = Math.cos(g.nR * (th - g.twist * h - g.ph2));
  const ridge = c > 0 ? c * c : 0;
  // the trunk swells into the cup
  const top = smoothstep(g.yCB - 14, g.yCB + 2, y);
  return (base * flare * (1 + amp * ridge)) * (1 - top) + g.rTop * 1.05 * top;
}
function trunkRmax(g, h) { return g.rt * 1.16 * (1 + 1.7 * Math.exp(-h / 9)) * (1 + g.ridgeAmp * (1 + 1.4 * Math.exp(-h / 12))); }

/** Underside of the cup at distance d from the axis (the bowl widens toward the rim). */
function cupUnder(g, d) {
  if (d <= g.rTop) return g.yCB;
  const k = Math.min(1, (d - g.rTop) / (g.Rc - g.rTop));
  const s = (2 / Math.PI) * Math.asin(Math.pow(k, 1 / 0.85));
  return g.yCB + s * g.cupH;
}

/** Top surface of the cup: lake bed, a sloping beach, the flat mossy rim (lowered at the notch). */
function cupTop(g, d, th, x, z) {
  const rimIn = g.Rc - g.rimW;
  const beach = Math.min(7, rimIn * 0.35);
  let y;
  if (d >= rimIn) y = g.yRim + 0.25 * Math.sin(th * 7 + g.ph) * smoothstep(rimIn, g.Rc, d);
  else if (d > rimIn - beach) y = g.bed + (g.yRim - g.bed) * smoothstep(rimIn - beach, rimIn, d);
  else {
    // mossy islands rise out of the shallow lake here and there
    const v = Math.sin(x * 0.19 + g.ph) * Math.cos(z * 0.23 - g.ph) + Math.sin((x + z) * 0.11 + g.ph2) * 0.6;
    y = g.bed + Math.max(0, v - 0.9) * 2.6;
  }
  if (g.notch && d > rimIn - beach - 1) {
    const da = Math.abs(wrapAngle(th - g.notch.ang));
    if (da < g.notch.hw) {
      const w = smoothstep(g.notch.hw, g.notch.hw * 0.45, da);
      y = Math.min(y, y + (g.water - 0.3 - y) * w);
    }
  }
  return y;
}

// ------------------------------------------------------------------ layout
/**
 * exit: where the Gate Stair opens into the cavern wall { x, z, y (floor), ux, uz (into the cavern) }.
 * Returns the layer's data: cavern, goblets, bridges, cascades, falls, prims, landmarks and sites.
 */
export function planLayer4(seed, exit, names) {
  const rng = RNG.derive(seed, 'layer4');
  const R = rng.range(325, 355);
  const C = { x: exit.x + exit.ux * (R - 1.5), z: exit.z + exit.uz * (R - 1.5) };
  const exitAng = Math.atan2(exit.z - C.z, exit.x - C.x);
  const a1 = rng.range(0, TAU), a2 = rng.range(0, TAU), a3 = rng.range(0, TAU);
  const wob = [];
  for (let i = 0; i < WOBN; i++) {
    const th = (i / WOBN) * TAU - Math.PI;
    let v = 1 + 0.07 * Math.sin(3 * th + a1) + 0.04 * Math.sin(7 * th + a2) + 0.025 * Math.sin(13 * th + a3);
    // the wall around the gate stays where the stair comes out
    v = 1 + (v - 1) * smoothstep(0.12, 0.45, Math.abs(wrapAngle(th - exitAng)));
    wob.push(v);
  }
  const d4 = {
    C, R, wob, ceilC: Math.min(-2000, exit.y + rng.range(29, 33)), floorC: rng.range(-2334, -2326), ph: [rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU)],
    exit: { ...exit }, goblets: [], bridges: [], prims: [], falls: [], landmarks: [], sites: [], cascades: [],
  };
  d4.lakeY = d4.floorC + 4.5;
  const G = d4.goblets;
  const floorXZ = (x, z) => { const dx = x - C.x, dz = z - C.z, dist = Math.hypot(dx, dz); return floorAt(d4, x, z, dist, wallR(d4, Math.atan2(dz, dx))); };
  const ceilXZ = (x, z) => { const dx = x - C.x, dz = z - C.z, dist = Math.hypot(dx, dz); return ceilAt(d4, x, z, dist, wallR(d4, Math.atan2(dz, dx))); };
  const make = (x, z, yRim, Rc, lr, extra = {}) => {
    const rt = clamp(Rc * lr.range(0.17, 0.23), 6, 15);
    const cupH = Rc * lr.range(0.72, 0.95);
    const g = {
      id: G.length, x, z, yRim, Rc, rt, cupH, rimW: lr.range(3.4, 5.2), yCB: yRim - cupH, rTop: rt * 0.92,
      water: yRim - 0.7, bed: yRim - 2.5, yBase: floorXZ(x, z) - 4, nR: lr.int(3, 6), twist: lr.range(0.008, 0.02) * lr.sign(),
      ridgeAmp: lr.range(0.12, 0.24), ph: lr.range(0, TAU), ph2: lr.range(0, TAU), notch: null, ...extra,
    };
    return g;
  };
  // a goblet placed after the bridges must keep clear of them (cups, trunks and root flares)
  const clearOfBridges = (g) => {
    for (const br of d4.bridges) {
      const L = Math.hypot(br.bx - br.ax, br.bz - br.az);
      const n = Math.max(2, Math.ceil(L / 3));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const x = br.ax + (br.bx - br.ax) * t, z = br.az + (br.bz - br.az) * t, y = br.ay + (br.by - br.ay) * t;
        const D = Math.hypot(x - g.x, z - g.z);
        if (D < g.Rc + br.w + 4 && y > g.yCB - 10 && y < g.yRim + 6) return false;
        if (y < g.yRim && D < trunkRmax(g, Math.max(0, y - g.yBase)) + br.w + 3) return false;
      }
    }
    return true;
  };
  // does goblet g fit among the others (cups, trunks and root flares kept apart)?
  const fits = (g, except = null) => {
    if (!clearOfBridges(g)) return false;
    const dx = g.x - C.x, dz = g.z - C.z, dist = Math.hypot(dx, dz);
    const Rw = wallR(d4, Math.atan2(dz, dx));
    if (!g.atWall && dist + g.Rc > Rw - 8) return false;
    if (ceilXZ(g.x, g.z) < g.yRim + 14) return false;
    if (g.yCB < floorXZ(g.x, g.z) + 25) return false;
    for (const o of G) {
      if (o === except) continue;
      const D = Math.hypot(g.x - o.x, g.z - o.z);
      const cupsOverlap = g.yRim > o.yCB - 4 && o.yRim > g.yCB - 4;
      if (cupsOverlap && D < g.Rc + o.Rc + 6) return false;
      if (g.yRim < o.yCB && D < g.Rc + o.rt * 1.7 + 4) return false;     // g's cup under o's trunk
      if (o.yRim < g.yCB && D < o.Rc + g.rt * 1.7 + 4) return false;
      if (D < (g.rt + o.rt) * 2.7) return false;                         // root flares on the floor
    }
    return true;
  };
  // a bridge corridor is clear of every goblet but its two ends
  const bridgeClear = (A, B, ga, gb) => {
    const n = Math.ceil(Math.hypot(B.x - A.x, B.z - A.z) / 3);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = A.x + (B.x - A.x) * t, z = A.z + (B.z - A.z) * t, y = A.y + (B.y - A.y) * t;
      if (y > ceilXZ(x, z) - 5) return false;
      for (const o of G) {
        if (o === ga || o === gb) continue;
        const D = Math.hypot(x - o.x, z - o.z);
        if (D < o.Rc + 4 && y > o.yCB - 6 && y < o.yRim + 6) return false;
        if (D < trunkRmax(o, y - o.yBase) + 3 && y < o.yRim) return false;
      }
    }
    return true;
  };
  const rimPoint = (g, tx, tz) => {
    const dx = tx - g.x, dz = tz - g.z, l = Math.hypot(dx, dz) || 1;
    const r = g.Rc - g.rimW * 0.5;
    return { x: g.x + (dx / l) * r, z: g.z + (dz / l) * r, y: g.yRim };
  };
  const addBridge = (ga, gb, kind = 'bridge', B = null) => {
    const A = rimPoint(ga, gb ? gb.x : B.x, gb ? gb.z : B.z);
    const Bp = B || rimPoint(gb, ga.x, ga.z);
    const L = Math.hypot(Bp.x - A.x, Bp.z - A.z);
    const br = { ax: A.x, az: A.z, ay: A.y, bx: Bp.x, bz: Bp.z, by: Bp.y, w: rng.range(2.3, 3.0), thick: rng.range(2.4, 3.4), sag: Math.min(1.5, L * 0.012), from: ga.id, to: gb ? gb.id : -1, kind };
    d4.bridges.push(br);
    return br;
  };

  // ---------------------------------------------------------- the chain down from the gate
  const lr0 = RNG.derive(seed, 'goblet', 0);
  const Rc0 = lr0.range(32, 40);
  const g0 = make(exit.x + exit.ux * (Rc0 - 2.6), exit.z + exit.uz * (Rc0 - 2.6), exit.y, Rc0, lr0, { chain: 0, atWall: true });
  g0.rimW = 5.2;
  G.push(g0);
  const chain = [g0];
  const dir = rng.sign();
  let ang = Math.atan2(g0.z - C.z, g0.x - C.x), rho = Math.hypot(g0.x - C.x, g0.z - C.z);
  for (let i = 1; i < 12; i++) {
    const prev = chain[i - 1];
    if (prev.yRim < -2236) break;
    let placed = null;
    for (let tries = 0; tries < 60 && !placed; tries++) {
      const lr = RNG.derive(seed, 'goblet', i, tries);
      const Rc = lr.range(26, 48);
      const drop = lr.range(29, 38);
      const yRim = prev.yRim - drop;
      const gap = drop / MAX_GRADE + 6 + tries * 0.8;
      const need = prev.Rc + Rc + gap;
      const rhoN = clamp(rho - lr.range(0, 26) + (tries > 30 ? lr.range(-40, 40) : 0), 105, R - Rc - 22);
      const cosd = (rho * rho + rhoN * rhoN - need * need) / (2 * rho * rhoN);
      if (cosd < -1 || cosd > 1) continue;
      const a = ang + dir * (Math.acos(cosd) + lr.range(0, 0.08));
      const g = make(C.x + Math.cos(a) * rhoN, C.z + Math.sin(a) * rhoN, yRim, Rc, lr, { chain: i });
      if (!fits(g)) continue;
      const A = rimPoint(prev, g.x, g.z), B = rimPoint(g, prev.x, prev.z);
      if (Math.abs(A.y - B.y) / Math.hypot(B.x - A.x, B.z - A.z) > MAX_GRADE + 0.02) continue;
      G.push(g);
      if (!bridgeClear(A, B, prev, g)) { G.pop(); continue; }
      placed = g; ang = a; rho = rhoN;
    }
    if (!placed) break;
    chain.push(placed);
    addBridge(chain[i - 1], placed);
  }
  // the last cup: a long root ramp down to the cavern floor
  {
    const last = chain[chain.length - 1];
    let best = null;
    for (let k = 0; k < 24 && !best; k++) {
      const a = (k / 24) * TAU + rng.range(0, 0.2);
      for (let L = 40; L < 280; L += 6) {
        const A = { x: last.x + Math.cos(a) * (last.Rc - last.rimW * 0.5), z: last.z + Math.sin(a) * (last.Rc - last.rimW * 0.5) };
        const B = { x: A.x + Math.cos(a) * L, z: A.z + Math.sin(a) * L };
        const dist = Math.hypot(B.x - C.x, B.z - C.z);
        if (dist > wallR(d4, Math.atan2(B.z - C.z, B.x - C.x)) - 10) break;
        const fy = floorXZ(B.x, B.z);
        if (fy < d4.lakeY + 0.6) continue;
        if ((last.yRim - fy) / L <= MAX_GRADE) {
          if (bridgeClear({ ...A, y: last.yRim }, { ...B, y: fy }, last, null)) best = { x: B.x, z: B.z, y: fy + 0.2 };
          break;
        }
      }
    }
    if (best) { addBridge(last, null, 'ramp', best); d4.foot = best; }
  }
  d4.chain = chain.map((g) => g.id);

  // ---------------------------------------------------------- the Throne Cup (the warden's lair), off the chain
  {
    const host = chain[Math.min(chain.length - 1, Math.max(1, Math.floor(chain.length / 2)))];
    for (let tries = 0; tries < 80 && !d4.boss && chain.length > 1; tries++) {
      const lr = RNG.derive(seed, 'throne', tries);
      const Rc = lr.range(56, 66);
      const drop = lr.range(6, 14);
      const gap = drop / MAX_GRADE + lr.range(10, 40);
      const a = lr.range(0, TAU);
      const D = host.Rc + Rc + gap;
      const g = make(host.x + Math.cos(a) * D, host.z + Math.sin(a) * D, host.yRim - drop, Rc, lr, { throne: true });
      g.rimW = 6;
      // the warden's lake is shallow: the explorer wades in it rather than swims
      g.bed = g.yRim - 1.45;
      if (!fits(g)) continue;
      const A = rimPoint(host, g.x, g.z), B = rimPoint(g, host.x, host.z);
      G.push(g);
      if (!bridgeClear(A, B, host, g)) { G.pop(); continue; }
      addBridge(host, g, 'branch');
      d4.boss = { goblet: g.id, x: g.x, z: g.z, y: g.water, r: g.Rc - g.rimW - 4 };
    }
  }

  // ---------------------------------------------------------- cascades: small cups stepping down under a notch
  const cascadeFrom = (top, ci) => {
    const cups = [];
    let cur = top;
    for (let step = 0; step < 4; step++) {
      let placed = null;
      for (let tries = 0; tries < 30 && !placed; tries++) {
        const lr = RNG.derive(seed, 'cascade', ci, step, tries);
        const Rc = lr.range(16, 24);
        const drop = Math.max(cur.cupH * 0.9, lr.range(24, 34));
        const a = (step === 0 ? lr.range(0, TAU) : Math.atan2(cur.z - (cups[step - 2] || top).z, cur.x - (cups[step - 2] || top).x) + lr.range(-0.7, 0.7));
        // the lower lake lies right under the notch of the cup above
        const D = cur.Rc + 1.5 + (Rc - lr.range(6, 10));
        const g = make(cur.x + Math.cos(a) * D, cur.z + Math.sin(a) * D, cur.yRim - drop, Rc, lr, { cascade: ci });
        if (g.yCB < floorXZ(g.x, g.z) + 25) break;
        if (!fits(g, cur)) continue;
        // keep clear of the bridges
        let clear = true;
        for (const br of d4.bridges) {
          const t = clamp(((g.x - br.ax) * (br.bx - br.ax) + (g.z - br.az) * (br.bz - br.az)) / ((br.bx - br.ax) ** 2 + (br.bz - br.az) ** 2), 0, 1);
          const px = br.ax + (br.bx - br.ax) * t, pz = br.az + (br.bz - br.az) * t, py = br.ay + (br.by - br.ay) * t;
          if (Math.hypot(g.x - px, g.z - pz) < g.Rc + br.w + 4 && py > g.yCB - 6 && py < g.yRim + 8) clear = false;
        }
        if (!clear) continue;
        cur.notch = { ang: a, hw: Math.min(0.35, 4.5 / cur.Rc) };
        G.push(g);
        placed = g;
      }
      if (!placed) break;
      cups.push(placed);
      cur = placed;
    }
    return cups;
  };
  {
    const tops = chain.slice(0, Math.max(2, chain.length - 3)).filter((g) => !g.notch);
    const order = rng.shuffle(tops.slice());
    let made = 0;
    for (const top of order) {
      if (made >= 2) break;
      const cups = cascadeFrom(top, made);
      if (cups.length >= 2) { d4.cascades.push({ top: top.id, cups: cups.map((g) => g.id) }); made++; }
      else { for (const g of cups) G.splice(G.indexOf(g), 1); top.notch = null; }
    }
  }

  // ---------------------------------------------------------- side goblets for the eye (some reachable by branch roots)
  for (let k = 0, tries = 0; k < 7 && tries < 300; tries++) {
    const lr = RNG.derive(seed, 'side', tries);
    const Rc = lr.range(20, 54);
    const rho2 = lr.range(60, R - Rc - 14);
    const a = lr.range(0, TAU);
    const g = make(C.x + Math.cos(a) * rho2, C.z + Math.sin(a) * rho2, lr.range(-2262, -2045), Rc, lr, { side: true });
    if (!fits(g)) continue;
    G.push(g);
    k++;
    // a branch root from the nearest chain goblet, when one can be walked
    let best = null, bl = Infinity;
    for (const ci of chain) {
      const A = rimPoint(ci, g.x, g.z), B = rimPoint(g, ci.x, ci.z);
      const L = Math.hypot(B.x - A.x, B.z - A.z);
      if (L > 150 || Math.abs(A.y - B.y) / L > MAX_GRADE) continue;
      if (L < bl && bridgeClear(A, B, ci, g)) { bl = L; best = ci; }
    }
    if (best) addBridge(best, g, 'branch');
  }

  // ---------------------------------------------------------- notches and their falls
  const below = (x, z, yFrom, self) => {
    let y = floorXZ(x, z), hit = null;
    if (y < d4.lakeY) y = d4.lakeY;
    for (const o of G) {
      if (o === self) continue;
      const D = Math.hypot(x - o.x, z - o.z);
      if (D < o.Rc && o.yRim < yFrom - 3 && o.yRim > y) {
        const inLake = D < o.Rc - o.rimW - 1;
        y = inLake ? o.water : o.yRim; hit = inLake ? o : null;
      } else if (D < trunkRmax(o, 0) && o.yCB < yFrom - 3 && o.yCB > y) { y = o.yCB; hit = null; }
    }
    return { y, lake: hit };
  };
  for (const g of G) {
    if (!g.notch) {
      // the overflow faces open air, away from the bridges, and preferably over a lower lake
      let best = null, bs = -Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU + g.ph * 0.1;
        let s = 0;
        for (const br of d4.bridges) {
          if (br.from !== g.id && br.to !== g.id) continue;
          const ba = br.from === g.id ? Math.atan2(br.bz - g.z, br.bx - g.x) : Math.atan2(br.az - g.z, br.ax - g.x);
          if (Math.abs(wrapAngle(a - ba)) < 0.6) s -= 10;
        }
        if (g.atWall && Math.abs(wrapAngle(a - Math.atan2(exit.z - g.z, exit.x - g.x))) < 1.2) s -= 10;
        const fx = g.x + Math.cos(a) * (g.Rc + 2), fz = g.z + Math.sin(a) * (g.Rc + 2);
        const dist = Math.hypot(fx - C.x, fz - C.z);
        if (dist > wallR(d4, Math.atan2(fz - C.z, fx - C.x)) - 4) s -= 20;
        const b = below(fx, fz, g.water, g);
        if (b.lake) s += 6;
        s += (1 - dist / R) * 2 + Math.sin(a * 3 + g.ph) * 0.3;
        if (s > bs) { bs = s; best = a; }
      }
      g.notch = { ang: best, hw: Math.min(0.35, 4.5 / g.Rc) };
    }
    const a = g.notch.ang;
    const fx = g.x + Math.cos(a) * (g.Rc + 0.3), fz = g.z + Math.sin(a) * (g.Rc + 0.3);
    const b = below(fx + Math.cos(a) * 3, fz + Math.sin(a) * 3, g.water, g);
    d4.falls.push({ x: fx, z: fz, topY: g.water + 0.15, bottomY: b.y, width: Math.max(3, g.notch.hw * g.Rc * 1.4), dirX: Math.cos(a), dirZ: Math.sin(a), kind: 'goblet', goblet: g.id, into: b.lake ? b.lake.id : -1 });
  }

  // ---------------------------------------------------------- hanging roots and vines
  {
    const lr = RNG.derive(seed, 'roots4');
    // roots hanging from the cavern ceiling, ending well above anything walked on
    for (let k = 0, tries = 0; k < 46 && tries < 400; tries++) {
      const a = lr.range(0, TAU), dist = Math.sqrt(lr.next()) * (R - 10);
      const x = C.x + Math.cos(a) * dist, z = C.z + Math.sin(a) * dist;
      const top = ceilXZ(x, z) + 6;
      let low = floorXZ(x, z);
      let clear = true;
      for (const o of G) {
        const D = Math.hypot(x - o.x, z - o.z);
        if (D < o.Rc + 5) { if (o.yRim > low) low = o.yRim; if (D < o.Rc + 2) clear = false; }
      }
      for (const br of d4.bridges) {
        const t = clamp(((x - br.ax) * (br.bx - br.ax) + (z - br.az) * (br.bz - br.az)) / ((br.bx - br.ax) ** 2 + (br.bz - br.az) ** 2), 0, 1);
        if (Math.hypot(x - (br.ax + (br.bx - br.ax) * t), z - (br.az + (br.bz - br.az) * t)) < br.w + 4) clear = false;
      }
      if (!clear) continue;
      const len = Math.min(top - low - 14, lr.range(18, 90));
      if (len < 10) continue;
      const r = lr.range(0.45, 1.3);
      d4.prims.push(cyl(OP_ADD, x, z, { r, y0: top - len, y1: top, top: M.GOBLET, side: M.GOBLET, bot: M.GOBLET, maxLod: 3 }));
      d4.prims.push(cyl(OP_ADD, x, z, { r: r * 0.7, y0: top - len - 1.6, y1: top - len + 0.2, top: M.CRYSTAL, side: M.CRYSTAL, bot: M.CRYSTAL, maxLod: 2 }));
      k++;
    }
    // vines trailing from under the lips of the cups
    for (const g of G) {
      const n = Math.round(g.Rc / 4);
      for (let k = 0; k < n; k++) {
        const a = lr.range(0, TAU);
        if (g.notch && Math.abs(wrapAngle(a - g.notch.ang)) < g.notch.hw + 0.3) continue;
        const rr = g.Rc - lr.range(1.2, 3.5);
        const x = g.x + Math.cos(a) * rr, z = g.z + Math.sin(a) * rr;
        const top = cupUnder(g, rr) + 0.5;
        const len = lr.range(6, 24);
        let overBridge = false;
        for (const br of d4.bridges) {
          const t = clamp(((x - br.ax) * (br.bx - br.ax) + (z - br.az) * (br.bz - br.az)) / ((br.bx - br.ax) ** 2 + (br.bz - br.az) ** 2), 0, 1);
          const py = br.ay + (br.by - br.ay) * t;
          if (Math.hypot(x - (br.ax + (br.bx - br.ax) * t), z - (br.az + (br.bz - br.az) * t)) < br.w + 3 && py < top + 2 && py > top - len - 6) overBridge = true;
        }
        if (overBridge) continue;
        d4.prims.push(cyl(OP_ADD, x, z, { r: lr.range(0.16, 0.32), y0: top - len, y1: top, top: M.GOBMOSS, side: M.GOBMOSS, bot: M.GOBMOSS, maxLod: 1 }));
      }
    }
  }

  // ---------------------------------------------------------- names, landmarks, sites
  const kinds = ['Goblet', 'Chalice', 'Cup', 'Grail', 'Bowl'];
  for (const g of G) {
    if (g.throne) g.name = `The Throne of ${names.name('throne4')}`;
    else if (g.cascade !== undefined) g.name = `${names.name('cascade4', g.id)} Cup`;
    else g.name = `${names.name('goblet4', g.id)} ${kinds[g.id % kinds.length]}`;
  }
  d4.name = `The ${names.name('cavern4')} Deep`;
  d4.mere = { x: C.x, z: C.z, y: d4.lakeY, name: `The Mere of ${names.name('mere4')}` };
  for (const g of G) {
    if (g.cascade !== undefined && g !== G.find((o) => o.cascade === g.cascade)) continue;
    d4.landmarks.push({ type: g.throne ? 'throne' : 'goblet', name: g.name, x: g.x, z: g.z, y: g.yRim, layer: 4, minor: !!g.side });
  }
  d4.cascades.forEach((cs, i) => {
    const top = G[cs.top];
    cs.name = `${names.name('falls4', i)} Cascade`;
    d4.landmarks.push({ type: 'cascade', name: cs.name, x: top.x, z: top.z, y: top.water, layer: 4 });
  });
  d4.landmarks.push({ type: 'mere', name: d4.mere.name, x: C.x, z: C.z, y: d4.lakeY, layer: 4 });
  d4.landmarks.push({ type: 'gatestair', name: 'The Gate Stair', x: exit.x, z: exit.z, y: exit.y, layer: 4 });
  for (const g of G) {
    const lr = RNG.derive(seed, 'site4', g.id);
    const a = lr.range(0, TAU), rr = g.Rc - g.rimW * 0.5;
    if (g.chain === 0) continue;
    const place = g.throne ? 'at the heart of the Throne Cup' : g.cascade !== undefined ? 'on the rim of a cascade cup' : g.side ? 'on the rim of a lonely goblet' : 'on a goblet rim above the falls';
    if (g.throne) d4.sites.push({ x: g.x, z: g.z, y: g.bed + 0.2, layer: 4, context: place, place: g.name, kind: 'throne', reward: true });
    else if (g.side || g.cascade !== undefined || lr.chance(0.5)) d4.sites.push({ x: g.x + Math.cos(a) * rr, z: g.z + Math.sin(a) * rr, y: g.yRim, layer: 4, context: place, place: g.name, kind: 'goblet' });
  }
  if (d4.foot) d4.sites.push({ x: d4.foot.x, z: d4.foot.z, y: d4.foot.y, layer: 4, context: 'where the roots meet the floor of the deep', place: d4.mere.name, kind: 'mere' });
  return d4;
}

// ------------------------------------------------------------------ column evaluation
export class Layer4 {
  constructor(d4) {
    this.d = d4;
    this.on = !!d4;
    if (!d4) return;
    this.C = d4.C;
    this.Rmax = d4.R * 1.2 + 6;
    // goblets and bridges by 32 m cells
    this.cells = new Map();
    const add = (minX, minZ, maxX, maxZ, item) => {
      for (let j = Math.floor(minZ / 32); j <= Math.floor(maxZ / 32); j++) for (let i = Math.floor(minX / 32); i <= Math.floor(maxX / 32); i++) {
        const k = i * 65536 + j;
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(item);
      }
    };
    for (const g of d4.goblets) {
      const r = Math.max(g.Rc, trunkRmax(g, 0)) + 2;
      add(g.x - r, g.z - r, g.x + r, g.z + r, { g });
    }
    for (const b of d4.bridges) {
      const r = b.w * 1.6 + 1;
      add(Math.min(b.ax, b.bx) - r, Math.min(b.az, b.bz) - r, Math.max(b.ax, b.bx) + r, Math.max(b.az, b.bz) + r, { b });
    }
  }

  /** Is (x, z) under the cavern (a cheap test before apply). */
  near(x, z) { return this.on && Math.abs(x - this.C.x) < this.Rmax && Math.abs(z - this.C.z) < this.Rmax; }

  /** Carve the cavern and add the goblets, bridges and lakes of column (x, z). */
  apply(x, z, col, flagL4) {
    const d4 = this.d;
    const dx = x - d4.C.x, dz = z - d4.C.z, dist = Math.hypot(dx, dz);
    const Rw = wallR(d4, Math.atan2(dz, dx));
    let inside = false;
    if (dist < Rw) {
      let fl = floorAt(d4, x, z, dist, Rw), ce = ceilAt(d4, x, z, dist, Rw);
      // the wall curves in at the floor and the ceiling
      const e = smoothstep(Rw - 30, Rw, dist);
      fl += e * e * 34; ce -= e * e * 12;
      if (ce - fl > 1) {
        const v = Math.sin(x * 0.13 + z * 0.07) + Math.sin(z * 0.17 - x * 0.05);
        const fm = fl < d4.lakeY - 0.2 ? M.CLAY : v > 0.9 ? M.GOBMOSS : v > -0.6 ? M.DEEPSTONE : M.GRAVEL;
        col.carve(fl, ce, fm, M.DEEPSTONE, 0.12);
        col.flags |= flagL4;
        inside = true;
        if (fl < d4.lakeY - 0.15) col.addWater(d4.lakeY, 0, 0, 0);
      }
    }
    const list = this.cells.get(Math.floor(x / 32) * 65536 + Math.floor(z / 32));
    if (!list) return inside;
    for (const it of list) {
      if (it.g) this.goblet(it.g, x, z, col);
      else this.bridge(it.b, x, z, col);
    }
    return inside;
  }

  goblet(g, x, z, col) {
    const dx = x - g.x, dz = z - g.z, d = Math.hypot(dx, dz);
    if (d > g.Rc && d > trunkRmax(g, 0)) return;
    const th = Math.atan2(dz, dx);
    // trunk: a core, then the shell of twisted ridges and the flared roots sampled in 2 m rows
    const core = g.rt * 0.82;
    if (d < core) col.add(g.yBase, g.yCB + 2, M.GOBLET, M.GOBLET, M.GOBLET, 0.6);
    else {
      let prevIn = false, start = 0, prevV = 0;
      const y0 = g.yBase, y1 = g.yCB + 2;
      for (let y = y0; y <= y1 + 1e-6; y += 2) {
        const h = y - g.yBase;
        if (trunkRmax(g, h) < d && h > 30 && !prevIn) break;
        const v = trunkR(g, y, th) - d;
        const isIn = v > 0;
        if (isIn !== prevIn) {
          const yy = y === y0 ? y : y - 2 + 2 * (prevV / (prevV - v));
          if (isIn) start = yy;
          else col.add(start, yy, M.GOBLET, M.GOBLET, M.GOBLET, 0.6);
          prevIn = isIn;
        }
        prevV = v;
      }
      if (prevIn) col.add(start, y1, M.GOBLET, M.GOBLET, M.GOBLET, 0.6);
    }
    // the cup
    if (d < g.Rc) {
      const top = cupTop(g, d, th, x, z);
      const under = cupUnder(g, d);
      const rimIn = g.Rc - g.rimW;
      const topMat = d > rimIn - 1 ? M.GOBMOSS : top < g.water - 0.2 ? M.CLAY : M.GOBMOSS;
      col.add(Math.min(under, top - 0.5), top, topMat, M.GOBLET, M.GOBLET, 0.6);
      if (top < g.water - 0.1) col.addWater(g.water, 0, 0, 0);
      // the overflow: water spills across the lowered lip of the notch
      else if (g.notch && d > rimIn - 2 && Math.abs(wrapAngle(th - g.notch.ang)) < g.notch.hw * 0.8 && top < g.water + 0.05) {
        col.addWater(g.water, 1, Math.cos(g.notch.ang), Math.sin(g.notch.ang));
      }
    }
  }

  bridge(b, x, z, col) {
    const ddx = b.bx - b.ax, ddz = b.bz - b.az;
    const l2 = ddx * ddx + ddz * ddz;
    const t = ((x - b.ax) * ddx + (z - b.az) * ddz) / l2;
    if (t < -0.02 || t > 1.02) return;
    const tc = clamp(t, 0, 1);
    const ex = x - (b.ax + ddx * tc), ez = z - (b.az + ddz * tc);
    const d = Math.hypot(ex, ez);
    // roots splay where they meet a rim
    const w = b.w * (1 + 0.6 * Math.pow(Math.abs(tc - 0.5) * 2, 4));
    if (d > w) return;
    const yc = b.ay + (b.by - b.ay) * tc - b.sag * Math.sin(Math.PI * tc);
    const q = d / w;
    const top = yc - q * q * 0.55;
    const thick = b.thick * (1 + 1.2 * Math.pow(Math.abs(tc - 0.5) * 2, 4)) * (1 - 0.4 * q * q);
    col.add(top - thick, top, q < 0.75 ? M.GOBMOSS : M.GOBLET, M.GOBLET, M.GOBLET, 0.6);
  }
}
