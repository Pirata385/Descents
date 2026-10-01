// Column generator. Every hex column of the world is a sorted list of solid
// spans [y0, y1] with materials, plus water entries. Columns are produced by a
// deterministic CSG pipeline over the world plan:
//   natural surface -> deep carving (galleries, bell chamber, fault) -> caves
//   -> water (rivers, lakes, pools) -> structures -> routes -> quantize.
// Used by chunk workers (meshing), the main thread (collision queries) and
// the plan validator.
import { TerrainField, Z_EYE, Z_BOWL, Z_CITY, Z_COUNTRY, Z_SEA } from './field.js';
import { SpatialGrid } from './spatial.js';
import { M } from './materials.js';
import { PK, OP_ADD, OP_CARVE } from './structures.js';
import { lakeSample } from './hydrology.js';
import { fbm2, ridged2, worley2 } from '../core/noise.js';
import { hash32 } from '../core/rng.js';
import { clamp, clamp01, smoothstep, wrapAngle } from '../core/mathutil.js';

export const MAX_SPANS = 24;
export const BOTTOM = -1120;
export const RT = { ROAD: 1, STREET: 2, TRAIL: 3, LEDGE: 4, TUNNEL: 5, STAIR: 6 };

// column flags
export const CF = {
  GALLERY0: 1, GALLERY1: 2, GALLERY2: 4, BELL: 8, FAULT: 16, CAVE: 32, ROUTE: 64, RIVER: 128,
  LAKE: 256, BUILDING: 512, PARK: 1024, FIELD: 2048, SHORE: 4096, SEA: 8192, POOL: 16384,
};

export class ColumnData {
  constructor() {
    this.y0 = new Float32Array(MAX_SPANS);
    this.y1 = new Float32Array(MAX_SPANS);
    this.top = new Uint8Array(MAX_SPANS);
    this.side = new Uint8Array(MAX_SPANS);
    this.bot = new Uint8Array(MAX_SPANS);
    this.exp = new Float32Array(MAX_SPANS);
    this.ty0 = new Float32Array(MAX_SPANS);
    this.ty1 = new Float32Array(MAX_SPANS);
    this.ttop = new Uint8Array(MAX_SPANS);
    this.tside = new Uint8Array(MAX_SPANS);
    this.tbot = new Uint8Array(MAX_SPANS);
    this.texp = new Float32Array(MAX_SPANS);
    this.n = 0;
    this.wl = new Float32Array(4);
    this.wsp = new Int8Array(4);
    this.wkind = new Uint8Array(4);
    this.wfx = new Float32Array(4);
    this.wfz = new Float32Array(4);
    this.nw = 0;
    this.zone = 0;
    this.flags = 0;
    this.galU = 0;
    this.biome = 0;
    this.surfaceY = 0;
    this.routeType = 0;
  }

  reset() { this.n = 0; this.nw = 0; this.flags = 0; this.galU = 0; this.routeType = 0; }

  setBase(y0, y1, top, side, bot) {
    this.n = 1;
    this.y0[0] = y0; this.y1[0] = y1;
    this.top[0] = top; this.side[0] = side; this.bot[0] = bot;
    this.exp[0] = 1;
  }

  /** Remove solid in [a, b]. floorMat/ceilMat 0 keeps existing materials. */
  carve(a, b, floorMat, ceilMat, exp) {
    if (b <= a) return;
    let m = 0;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const s0 = this.y0[i], s1 = this.y1[i];
      if (s1 <= a || s0 >= b) {
        this.ty0[m] = s0; this.ty1[m] = s1; this.ttop[m] = this.top[i]; this.tside[m] = this.side[i]; this.tbot[m] = this.bot[i]; this.texp[m] = this.exp[i];
        m++;
        continue;
      }
      if (s0 < a && m < MAX_SPANS) {
        this.ty0[m] = s0; this.ty1[m] = a; this.ttop[m] = floorMat || this.top[i]; this.tside[m] = this.side[i]; this.tbot[m] = this.bot[i];
        this.texp[m] = exp >= 0 ? exp : this.exp[i];
        m++;
      }
      if (s1 > b && m < MAX_SPANS) {
        this.ty0[m] = b; this.ty1[m] = s1; this.ttop[m] = this.top[i]; this.tside[m] = this.side[i]; this.tbot[m] = ceilMat || this.bot[i]; this.texp[m] = this.exp[i];
        m++;
      }
    }
    this.swap(m);
  }

  swap(m) {
    let t;
    t = this.y0; this.y0 = this.ty0; this.ty0 = t;
    t = this.y1; this.y1 = this.ty1; this.ty1 = t;
    t = this.top; this.top = this.ttop; this.ttop = t;
    t = this.side; this.side = this.tside; this.tside = t;
    t = this.bot; this.bot = this.tbot; this.tbot = t;
    t = this.exp; this.exp = this.texp; this.texp = t;
    this.n = m;
  }

  /** Insert a solid span [a, b], overriding anything in that range. */
  add(a, b, top, side, bot, shadeBelow = 1) {
    if (b <= a) return;
    // exposure of the air the new span is placed in
    let gapExp = 1;
    for (let i = this.n - 1; i >= 0; i--) {
      if (this.y1[i] <= a + 1e-4) { gapExp = this.exp[i]; break; }
    }
    this.carve(a, b, 0, 0, -1);
    if (this.n >= MAX_SPANS) return;
    let k = this.n;
    while (k > 0 && this.y0[k - 1] > a) {
      this.y0[k] = this.y0[k - 1]; this.y1[k] = this.y1[k - 1]; this.top[k] = this.top[k - 1];
      this.side[k] = this.side[k - 1]; this.bot[k] = this.bot[k - 1]; this.exp[k] = this.exp[k - 1];
      k--;
    }
    this.y0[k] = a; this.y1[k] = b; this.top[k] = top; this.side[k] = side; this.bot[k] = bot; this.exp[k] = gapExp;
    this.n++;
    if (k > 0 && this.y1[k - 1] <= a + 1e-4 && this.y1[k - 1] < a - 0.01) this.exp[k - 1] = Math.min(this.exp[k - 1], shadeBelow);
  }

  /** Index of the span containing y (y0 < y <= y1), or -1. */
  spanAt(y) {
    for (let i = 0; i < this.n; i++) if (this.y0[i] < y && this.y1[i] >= y) return i;
    return -1;
  }

  /** Highest span whose top is <= y (+eps). */
  floorBelow(y) {
    for (let i = this.n - 1; i >= 0; i--) if (this.y1[i] <= y + 1e-3) return i;
    return -1;
  }

  topY() { return this.n ? this.y1[this.n - 1] : -Infinity; }

  addWater(level, kind, fx, fz) {
    if (this.nw >= 4) return;
    this.wl[this.nw] = level; this.wkind[this.nw] = kind; this.wfx[this.nw] = fx; this.wfz[this.nw] = fz; this.wsp[this.nw] = -1;
    this.nw++;
  }

  /** Quantize span bounds, drop empty spans, validate water. */
  finalize() {
    let m = 0;
    let prevTop = -Infinity;
    for (let i = 0; i < this.n; i++) {
      let a = Math.round(this.y0[i] * 2) / 2;
      const b = Math.round(this.y1[i] * 2) / 2;
      if (a < prevTop) a = prevTop;
      if (b - a < 0.25) {
        // keep thin slabs (decks, roofs) instead of letting them vanish
        if (this.y1[i] - this.y0[i] >= 0.15 && b - 0.5 >= prevTop) a = b - 0.5;
        else continue;
      }
      this.ty0[m] = a; this.ty1[m] = b; this.ttop[m] = this.top[i]; this.tside[m] = this.side[i]; this.tbot[m] = this.bot[i]; this.texp[m] = this.exp[i];
      prevTop = b;
      m++;
    }
    this.swap(m);
    if (m > 0) this.exp[m - 1] = 1;
    // water must rest on a floor slightly below the level, inside an open gap
    let w = 0;
    for (let k = 0; k < this.nw; k++) {
      const L = this.wl[k];
      const f = this.floorBelow(L - 0.12);
      if (f < 0) continue;
      const above = f + 1 < this.n ? this.y0[f + 1] : Infinity;
      if (above < L + 0.05) continue;
      if (L - this.y1[f] > 40) continue;
      this.wl[w] = L; this.wkind[w] = this.wkind[k]; this.wfx[w] = this.wfx[k]; this.wfz[w] = this.wfz[k]; this.wsp[w] = f;
      w++;
    }
    this.nw = w;
  }
}

const RIVER_REC = 0;

export class ColumnGen {
  constructor(plan) {
    this.plan = plan;
    this.p = plan.params;
    this.field = new TerrainField(plan.params);
    this.P = {}; this.S = {}; this.FP = {}; this.LK = {}; this.W = {};
    this.buildIndexes();
  }

  buildIndexes() {
    const plan = this.plan;
    this.prims = plan.prims || [];
    this.primGrid = new SpatialGrid(16);
    for (let i = 0; i < this.prims.length; i++) {
      const p = this.prims[i];
      const cx = p.kind === PK.ARCH ? p.cx2 : p.x, cz = p.kind === PK.ARCH ? p.cz2 : p.z;
      this.primGrid.insertCircle(cx, cz, p.br, i);
    }
    this.caps = plan.capsules || new Float32Array(0);
    this.capGrid = new SpatialGrid(24);
    for (let i = 0; i < this.caps.length; i += 9) {
      const c = this.caps;
      const r = Math.max(c[i + 6], c[i + 7]);
      this.capGrid.insertSegment(c[i], c[i + 2], c[i + 3], c[i + 5], r + 0.5, i);
    }
    this.rivers = plan.rivers || [];
    this.riverGrid = new SpatialGrid(24);
    for (let ri = 0; ri < this.rivers.length; ri++) {
      const r = this.rivers[ri];
      for (let i = 0; i < r.x.length - 1; i++) {
        const w = Math.max(r.width[i], r.width[i + 1]) / 2 + 3;
        this.riverGrid.insertSegment(r.x[i], r.z[i], r.x[i + 1], r.z[i + 1], w, ri * 65536 + i);
      }
    }
    this.routes = plan.routes || [];
    this.routeGrid = new SpatialGrid(16);
    for (let ri = 0; ri < this.routes.length; ri++) {
      const rt = this.routes[ri];
      const pts = rt.pts;
      for (let i = 0; i < pts.length / 3 - 1; i++) {
        const ax = pts[i * 3], az = pts[i * 3 + 2], bx = pts[i * 3 + 3], bz = pts[i * 3 + 5];
        this.routeGrid.insertSegment(ax, az, bx, bz, rt.hw + 1, ri * 65536 + i);
      }
    }
    this.pools = plan.pools || [];
    this.poolGrid = new SpatialGrid(32);
    for (let i = 0; i < this.pools.length; i++) {
      const p = this.pools[i];
      this.poolGrid.insertCircle(p.x, p.z, p.r + 4, i);
    }
    this.ribs = plan.bellRibs || [];
    this.galleryWindows = plan.galleryWindows || [];
    this.pads = plan.pads || [];
    this.lakes = plan.lakes || [];
    this.lakeLevels = new Map(this.lakes.map((l) => [l.id, l.level]));
  }

  galleryDepth(k, th) {
    let D = this.field.galleryDepth(k, th);
    for (const w of this.galleryWindows) {
      if (w.tier !== k) continue;
      const da = Math.abs(wrapAngle(th - w.th));
      if (da < w.hw) D = Math.max(D, w.depth * (1 - smoothstep(w.hw * 0.6, w.hw, da)) + 8);
    }
    return D;
  }

  galleryFloor(k, x, z, u, th) {
    const g = this.p.galleries[k];
    const f = this.field;
    let fl = g.yTop - g.height + g.height * 0.28 * u * u + fbm2(f.nGal, x / 42, z / 42, 3) * 3.2;
    fl += Math.max(0, ridged2(f.nGal, x / 26 + 9, z / 26, 2) - 0.75) * 10;
    for (const w of this.galleryWindows) {
      if (w.tier !== k) continue;
      const da = Math.abs(wrapAngle(th - w.th));
      if (da < w.hw && u < 0.45) {
        const b = (1 - smoothstep(w.hw * 0.5, w.hw, da)) * (1 - smoothstep(0.2, 0.45, u));
        fl = fl + (w.y - 0.6 - fl) * b;
      }
    }
    if (this.pads.length) fl = this.padFloor(fl, x, z, k, false);
    return fl;
  }

  galleryCeiling(k, x, z, u) {
    const g = this.p.galleries[k];
    const f = this.field;
    let ce = g.yTop - g.height * 0.45 * Math.pow(u, 2.2) + fbm2(f.nGal, x / 55 + 20, z / 55, 3) * 6;
    // root masses: downward bulges of the ceiling where inverted trees hang
    const rm = ridged2(f.nGal, x / 48 - 7, z / 48 + 3, 2);
    ce -= Math.max(0, rm - 0.6) * 22;
    for (const pd of this.pads) {
      if (pd.tier !== k) continue;
      const d = Math.hypot(x - pd.x, z - pd.z);
      if (d < pd.r) ce = Math.max(ce, pd.y + 7);
    }
    return ce;
  }

  /** Blend a floor height toward any landing pad covering (x, z). */
  padFloor(fl, x, z, tier, plain) {
    for (const pd of this.pads) {
      if (plain ? !pd.plain : pd.tier !== tier) continue;
      const d = Math.hypot(x - pd.x, z - pd.z);
      if (d >= pd.r) continue;
      const w = smoothstep(pd.r, pd.r * 0.55, d);
      fl = fl + (pd.y - fl) * w;
    }
    return fl;
  }

  inRib(th, r) {
    for (const rb of this.ribs) {
      const da = Math.abs(wrapAngle(th - rb.th));
      if (da < rb.hw) return true;
    }
    return false;
  }

  /** Evaluate a column at world position (x, z). lod = 0 is full detail. */
  column(x, z, lod, col) {
    col.reset();
    const f = this.field, p = this.p;
    const P = f.polar(x, z, this.P);
    col.zone = P.zone;
    col.biome = f.biome(x, z);
    let S = NaN, smat = M.AIR;
    const prims = this.primGrid.query(x, z);

    if (P.zone !== Z_EYE) {
      f.surface(x, z, P, this.S);
      S = this.S.h;
      smat = this.S.mat;
      col.surfaceY = S;
      // terrain pads / material patches
      for (let i = 0; i < prims.length; i++) {
        const pr = this.prims[prims[i]];
        if (pr.kind !== PK.FLAT && pr.kind !== PK.MATPATCH) continue;
        const w = this.shapeWeight(pr, x, z);
        if (w <= 0) continue;
        if (pr.kind === PK.FLAT) {
          if (Math.abs(S - pr.y0) > 14) continue; // pads only level nearby ground
          S = S + (pr.y0 - S) * w;
          if (w > 0.6 && pr.top) smat = pr.top;
        } else if (w > 0.5) {
          smat = pr.top;
          if (pr.top === M.FIELD) col.flags |= CF.FIELD;
          else if (pr.side === 1) col.flags |= CF.PARK;
        }
      }
      if (P.zone === Z_SEA && S < p.seaY) col.flags |= CF.SEA;
      col.setBase(BOTTOM, S, smat, M.ROCK, M.ROCK);
    } else {
      const fl = f.plainFloor(x, z, P);
      col.surfaceY = fl;
      col.setBase(BOTTOM, fl, M.STONEPLAIN, M.ROCK, M.ROCK);
    }

    this.deepCarve(x, z, P, lod, col);
    this.caveCarve(x, z, lod, col);
    this.water(x, z, P, lod, col);
    if (prims.length) this.applyPrims(prims, x, z, lod, col);
    this.applyRoutes(x, z, lod, col);
    col.finalize();
    return col;
  }

  deepCarve(x, z, P, lod, col) {
    const f = this.field, p = this.p;
    const r = P.r;
    // Fault (Layer 3 entrance) - a deep hole in the stone plain
    if (r < P.Re + 40) {
      const FP = f.faultPolar(x, z, this.FP);
      if (FP.fr < FP.Rf) {
        const ff = p.fault.bottomY + fbm2(f.nPlain, x / 30, z / 30, 2) * 4;
        col.carve(ff, p.plainY + (r < P.Re ? 30 : 6), M.BASALT, M.BASALT, r < P.Re ? 0.9 : 0.4);
        col.side[0] = M.BASALT;
        col.flags |= CF.FAULT;
        // threshold ledges ring the fault walls
      } else if (FP.fr < FP.Rf + 14) {
        // basalt rim
        if (col.n) { col.top[col.n - 1] = r < P.Re ? M.BASALT : col.top[col.n - 1]; }
      }
    }
    if (r < P.Re) return;
    // Bell chamber with the Stone Plain
    if (r < P.Rb && !this.inRib(P.th, r)) {
      let fl = f.plainFloor(x, z, P);
      if (this.pads.length) fl = this.padFloor(fl, x, z, -1, true);
      const ce = f.bellCeiling(P);
      if (ce - fl > 1.5) {
        const u = (r - P.Re) / (P.Rb - P.Re);
        col.carve(fl, ce, M.STONEPLAIN, M.SHAFTROCK, 0.85 - 0.7 * u);
        col.flags |= CF.BELL;
      }
    }
    // Galleries (inverted forest)
    const gs = p.galleries;
    for (let k = 0; k < gs.length; k++) {
      const D = this.galleryDepth(k, P.th);
      if (D < 8) continue;
      const u = (r - P.Re) / D;
      if (u >= 1) continue;
      const fl = this.galleryFloor(k, x, z, u, P.th);
      const ce = this.galleryCeiling(k, x, z, u);
      if (ce - fl < 3) continue;
      // natural stone pillars joining floor and ceiling
      const wv = worley2(gs[k].seed, x / 38, z / 38, this.W);
      const pillarR = 2.5 + (wv.id & 7) * 0.55;
      if ((wv.id & 0x30) === 0 && wv.f1 * 38 < pillarR && u > 0.12) continue;
      const mat = col.biome > 0.2 ? M.LITTER : M.MOSS;
      col.carve(fl, ce, mat, M.DARKROCK, Math.max(0.12, 0.95 - 0.9 * Math.pow(u, 0.7)));
      col.flags |= (1 << k);
      col.galU = u;
    }
    // Walls of the shaft and deep rock get darker rock
    if (r < P.Re + 6 && col.n) col.side[0] = M.SHAFTROCK;
  }

  caveCarve(x, z, lod, col) {
    const list = this.capGrid.query(x, z);
    if (!list.length) return;
    const c = this.caps;
    const minR = lod > 0 ? 1.4 * (1 << lod) : 0;
    for (let q = 0; q < list.length; q++) {
      const i = list[q];
      const ra = c[i + 6], rb = c[i + 7];
      if (Math.max(ra, rb) < minR) continue;
      const ax = c[i], ay = c[i + 1], az = c[i + 2], bx = c[i + 3], by = c[i + 4], bz = c[i + 5];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-6 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + dx * t, cz = az + dz * t;
      const rr = ra + (rb - ra) * t;
      const ex = x - cx, ez = z - cz;
      const d2 = ex * ex + ez * ez;
      if (d2 >= rr * rr) continue;
      const cy = ay + (by - ay) * t;
      const half = Math.sqrt(rr * rr - d2);
      col.carve(cy - half * 0.55, cy + half, (c[i + 8] & 1) ? M.GRAVEL : M.DIRT, M.ROCK, 0.07);
      col.flags |= CF.CAVE;
    }
  }

  water(x, z, P, lod, col) {
    // Rivers
    const list = this.riverGrid.query(x, z);
    if (list.length) {
      let best = -1, bestD = 1e9, bt = 0, bseg = 0;
      for (let q = 0; q < list.length; q++) {
        const code = list[q];
        const ri = Math.floor(code / 65536), si = code % 65536;
        const rv = this.rivers[ri];
        const ax = rv.x[si], az = rv.z[si], bx = rv.x[si + 1], bz = rv.z[si + 1];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 1e-6 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x - (ax + dx * t), ez = z - (az + dz * t);
        const d = Math.sqrt(ex * ex + ez * ez);
        if (d < bestD) { bestD = d; best = ri; bt = t; bseg = si; }
      }
      if (best >= 0) {
        const rv = this.rivers[best];
        const hw = (rv.width[bseg] + (rv.width[bseg + 1] - rv.width[bseg]) * bt) / 2;
        // falls happen at vertices: a segment carries its start level, sloping to the end level only without a fall
        const la = rv.level[bseg];
        const lb = rv.fall[bseg + 1] > 0 ? la : rv.level[bseg + 1];
        const L = la + (lb - la) * bt;
        if (bestD < hw + 3) {
          let fi = col.spanAt(L - 0.05);
          if (fi < 0) { fi = col.floorBelow(L); if (fi >= 0 && L - col.y1[fi] > 6) fi = -1; }
          if (fi >= 0 && col.y1[fi] - L > 14) fi = -1;
          // surface rivers only shape the open ground, never cave or tunnel floors
          if (fi >= 0 && rv.gallery === undefined && fi !== col.n - 1) fi = -1;
          if (fi >= 0) {
            const top = col.y1[fi];
            if (bestD < hw) {
              const depth = 0.6 + hw * 0.18;
              const prof = Math.sqrt(1 - (bestD / hw) * (bestD / hw));
              const bed = L - 0.35 - depth * prof;
              if (top > bed) col.carve(bed, Math.max(top, L + 0.6), M.GRAVEL, 0, -1);
              else col.top[fi] = M.GRAVEL;
              const dxs = rv.x[bseg + 1] - rv.x[bseg], dzs = rv.z[bseg + 1] - rv.z[bseg];
              const ln = Math.hypot(dxs, dzs) || 1;
              col.addWater(L, 1, dxs / ln, dzs / ln);
              col.flags |= CF.RIVER;
            } else {
              // banks: keep water contained
              const need = Math.ceil((L + 0.32) * 2) / 2;
              if (top < need) col.add(top, need, M.CLAY, M.DIRT, M.DIRT);
              else if (top < L + 1.5 && bestD < hw + 1.5) col.top[fi] = M.SAND;
              col.flags |= CF.SHORE;
            }
          }
        }
      }
    }
    // Lakes
    if (P.zone === Z_BOWL || P.zone === Z_CITY || P.zone === Z_COUNTRY) {
      const ls = lakeSample(this.plan.coarse, this.plan.lakeGrid, x, z, this.LK);
      const id = ls.id || ls.near;
      if (id) {
        const L = this.lakeLevels.get(id);
        if (L !== undefined) {
          const fi = col.n - 1;
          const top = col.y1[fi];
          if (ls.w >= 0.45) {
            if (top < L + 1.5) {
              const bed = L - 0.45 - (ls.w - 0.45) * 5;
              if (top > bed) col.carve(bed, top + 0.01, M.CLAY, 0, -1);
              else col.top[fi] = M.CLAY;
              col.addWater(L, 0, 0, 0);
              col.flags |= CF.LAKE;
            }
          } else {
            const need = Math.ceil((L + 0.32) * 2) / 2;
            if (top < need) col.add(top, need, M.SAND, M.DIRT, M.DIRT);
            else if (top < L + 1.2) col.top[col.n - 1] = M.SAND;
            col.flags |= CF.SHORE;
          }
        }
      }
    }
    // Pools (springs, waterfall plunge pools)
    const pl = this.poolGrid.query(x, z);
    for (let q = 0; q < pl.length; q++) {
      const pool = this.pools[pl[q]];
      const dx = x - pool.x, dz = z - pool.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > pool.r + 3) continue;
      const L = pool.level;
      let fi = col.spanAt(L - 0.05);
      if (fi < 0) { fi = col.floorBelow(L); if (fi >= 0 && L - col.y1[fi] > 6) fi = -1; }
      if (fi < 0 || col.y1[fi] - L > 6) continue;
      const top = col.y1[fi];
      if (d < pool.r) {
        const bed = L - 0.4 - (1 - d / pool.r) * pool.depth;
        if (top > bed) col.carve(bed, Math.max(top, L + 0.5), pool.bed || M.GRAVEL, 0, -1);
        col.addWater(L, 2, 0, 0);
        col.flags |= CF.POOL;
      } else {
        const need = Math.ceil((L + 0.32) * 2) / 2;
        if (top < need && top > L - 6) col.add(top, need, pool.rim || M.STONEPLAIN, M.ROCK, M.ROCK);
      }
    }
  }

  shapeWeight(pr, x, z) {
    const dx = x - pr.x, dz = z - pr.z;
    let out;
    if (pr.r > 0 && pr.hw === 0) {
      out = Math.sqrt(dx * dx + dz * dz) - pr.r;
    } else {
      const u = dx * pr.ca + dz * pr.sa, v = -dx * pr.sa + dz * pr.ca;
      const ou = Math.abs(u) - pr.hw, ov = Math.abs(v) - pr.hd;
      out = Math.max(ou, ov);
      if (ou > 0 && ov > 0) out = Math.sqrt(ou * ou + ov * ov);
    }
    if (out <= 0) return 1;
    if (pr.feather <= 0 || out >= pr.feather) return 0;
    const t = 1 - out / pr.feather;
    return t * t * (3 - 2 * t);
  }

  applyPrims(list, x, z, lod, col) {
    for (let q = 0; q < list.length; q++) {
      const pr = this.prims[list[q]];
      if (pr.kind === PK.FLAT || pr.kind === PK.MATPATCH) continue;
      if (lod > pr.maxLod) continue;
      const dx = x - pr.x, dz = z - pr.z;
      switch (pr.kind) {
        case PK.BOX: {
          const u = dx * pr.ca + dz * pr.sa, v = -dx * pr.sa + dz * pr.ca;
          if (Math.abs(u) > pr.hw || Math.abs(v) > pr.hd) break;
          if (pr.op === OP_ADD) col.add(pr.y0, pr.y1, pr.top, pr.side, pr.bot, pr.exp);
          else col.carve(pr.y0, pr.y1, pr.top, pr.bot, pr.exp);
          col.flags |= CF.BUILDING;
          break;
        }
        case PK.CYL: {
          if (dx * dx + dz * dz > pr.r * pr.r) break;
          if (pr.op === OP_ADD) col.add(pr.y0, pr.y1, pr.top, pr.side, pr.bot, pr.exp);
          else col.carve(pr.y0, pr.y1, pr.top, pr.bot, pr.exp);
          break;
        }
        case PK.RING: {
          const d2 = dx * dx + dz * dz;
          if (d2 > pr.r * pr.r || d2 < pr.ri * pr.ri) break;
          col.add(pr.y0, pr.y1, pr.top, pr.side, pr.bot, pr.exp);
          break;
        }
        case PK.GABLE: {
          const u = dx * pr.ca + dz * pr.sa, v = -dx * pr.sa + dz * pr.ca;
          const hwE = pr.hw + pr.eave, hdE = pr.hd + pr.eave;
          if (Math.abs(u) > hwE || Math.abs(v) > hdE) break;
          const top = pr.y0 + pr.h * (1 - Math.abs(v) / hdE);
          const inner = Math.abs(u) <= pr.hw && Math.abs(v) <= pr.hd;
          const endWall = inner && Math.abs(u) > pr.hw - 0.9;
          if (inner) col.add(pr.y0, Math.max(pr.y0 + 0.5, top), pr.top, endWall ? pr.bot : pr.side, pr.bot, 0.3);
          else col.add(Math.max(pr.y0 - 0.6, top - 0.55), Math.max(pr.y0, top), pr.top, pr.side, pr.side, 0.5);
          break;
        }
        case PK.HIP: {
          const u = dx * pr.ca + dz * pr.sa, v = -dx * pr.sa + dz * pr.ca;
          const hwE = pr.hw + pr.eave, hdE = pr.hd + pr.eave;
          const du = hwE - Math.abs(u), dv = hdE - Math.abs(v);
          if (du < 0 || dv < 0) break;
          const slope = pr.h / Math.min(hwE, hdE);
          const top = pr.y0 + slope * Math.min(du, dv);
          const inner = Math.abs(u) <= pr.hw && Math.abs(v) <= pr.hd;
          if (inner) col.add(pr.y0, Math.max(pr.y0 + 0.5, top), pr.top, pr.side, pr.side, 0.3);
          else col.add(Math.max(pr.y0 - 0.6, top - 0.55), Math.max(pr.y0, top), pr.top, pr.side, pr.side, 0.5);
          break;
        }
        case PK.CONE: case PK.SPIRE: {
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > pr.r) break;
          const top = pr.y0 + pr.h * (1 - d / pr.r);
          if (pr.kind === PK.CONE) col.add(Math.max(pr.y0, top - 0.6 - (pr.r - d) * 2), Math.max(pr.y0 + 0.5, top), pr.top, pr.side, pr.side, 0.4);
          else {
            const fi = col.floorBelow(pr.y0 + 2);
            const from = fi >= 0 && pr.y0 - col.y1[fi] < 6 ? Math.min(col.y1[fi], pr.y0) : pr.y0 - 1;
            col.add(from - 1, Math.max(pr.y0 + 0.5, top), pr.top, pr.side, pr.side, 0.6);
          }
          break;
        }
        case PK.DOME: {
          const d2 = dx * dx + dz * dz;
          if (d2 > pr.r * pr.r) break;
          const top = pr.y0 + pr.h * Math.sqrt(1 - d2 / (pr.r * pr.r));
          col.add(pr.y0, Math.max(pr.y0 + 0.5, top), pr.top, pr.side, pr.side, 0.3);
          break;
        }
        case PK.WINDOWS: {
          if (lod > 0) break;
          let along, edge, front = false;
          if (pr.r > 0 && pr.hw === pr.r) {
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d > pr.r || d < pr.r - 1.0) break;
            along = Math.atan2(dz, dx) * pr.r;
            edge = true;
            front = pr.door === -2 && Math.abs(along - Math.PI * 0.5 * pr.r) < 0.8;
          } else {
            const u = dx * pr.ca + dz * pr.sa, v = -dx * pr.sa + dz * pr.ca;
            if (Math.abs(u) > pr.hw || Math.abs(v) > pr.hd) break;
            const eu = pr.hw - Math.abs(u) < 0.95, ev = pr.hd - Math.abs(v) < 0.95;
            if (eu === ev) break; // interior or corner
            along = eu ? v : u;
            edge = true;
            if (pr.door === 2 && ev && v < 0 && Math.abs(u) < 0.75) front = true;
            if (pr.door === 3 && ev && v > 0 && Math.abs(u) < 0.75) front = true;
            if (pr.door === 0 && eu && u > 0 && Math.abs(v) < 0.75) front = true;
            if (pr.door === 1 && eu && u < 0 && Math.abs(v) < 0.75) front = true;
          }
          if (!edge) break;
          if (front) { col.add(pr.y0 + 0.5, pr.y0 + 2.5, M.DOOR, M.DOOR, M.DOOR); }
          const m = (((along / pr.spacing) % 1) + 1) % 1;
          if (m < 0.36) {
            for (let fl = 0; fl < pr.floors; fl++) {
              if (fl === 0 && front) continue;
              const ya = pr.y0 + 0.5 + fl * pr.floorH + 1.0;
              col.add(ya, ya + 1.5, M.WINDOW, M.WINDOW, M.WINDOW);
            }
          }
          break;
        }
        case PK.ARCH: {
          const ax = pr.x, az = pr.z, bx = pr.bx, bz = pr.bz;
          const ddx = bx - ax, ddz = bz - az;
          const l2 = ddx * ddx + ddz * ddz;
          let t = ((x - ax) * ddx + (z - az) * ddz) / l2;
          if (t < 0 || t > 1) break;
          const ex = x - (ax + ddx * t), ez = z - (az + ddz * t);
          const d = Math.sqrt(ex * ex + ez * ez);
          const w = pr.width * (1 + 0.6 * Math.pow(Math.abs(t - 0.5) * 2, 3));
          if (d > w) break;
          const yc = pr.y0 + (pr.yb - pr.y0) * t + pr.bulge * Math.sin(Math.PI * t);
          const thick = pr.thick * (1 + 2.5 * Math.pow(Math.abs(t - 0.5) * 2, 4)) * (1 - 0.35 * (d / w) * (d / w));
          col.add(yc - thick, yc - (d / w) * (d / w) * 0.8, pr.top, pr.side, pr.side, 0.5);
          break;
        }
        default: break;
      }
    }
  }

  applyRoutes(x, z, lod, col) {
    const list = this.routeGrid.query(x, z);
    if (!list.length) return;
    // gather candidate route segments within their half width
    const cand = this._cand || (this._cand = []);
    cand.length = 0;
    for (let q = 0; q < list.length; q++) {
      const code = list[q];
      const ri = Math.floor(code / 65536), si = code % 65536;
      const rt = this.routes[ri];
      if (lod > (rt.maxLod ?? 3)) continue;
      const pts = rt.pts;
      const ax = pts[si * 3], az = pts[si * 3 + 2], bx = pts[si * 3 + 3], bz = pts[si * 3 + 5];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-6 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (ax + dx * t), ez = z - (az + dz * t);
      const d = Math.sqrt(ex * ex + ez * ez);
      if (d > rt.hw) continue;
      const y = pts[si * 3 + 1] + (pts[si * 3 + 4] - pts[si * 3 + 1]) * t;
      const slope = Math.abs(pts[si * 3 + 4] - pts[si * 3 + 1]) / Math.max(0.5, Math.sqrt(l2));
      cand.push({ rt, d, y, slope, score: d - (rt.priority || 0) * 0.05 });
    }
    if (!cand.length) return;
    cand.sort((a, b) => a.score - b.score);
    // keep one stamp per distinct height level (stacked ledges, switchbacks)
    const sel = this._sel || (this._sel = []);
    sel.length = 0;
    for (const c of cand) {
      let ok = true;
      for (const s of sel) if (Math.abs(s.y - c.y) < 5.5) { ok = false; break; }
      if (ok) sel.push(c);
      if (sel.length >= 4) break;
    }
    col.flags |= CF.ROUTE;
    col.routeType = sel[0].rt.type;
    // phase 1: clearances
    for (const c of sel) {
      const rt = c.rt, y = c.y;
      const si = col.spanAt(y + 0.3);
      let cutTop = y + rt.clear;
      if (si >= 0) {
        const cutDepth = col.y1[si] - y;
        if (cutDepth <= rt.cutLimit) cutTop = Math.max(cutTop, col.y1[si] + 0.01);
      }
      col.carve(y, cutTop, 0, rt.ceil || M.ROCK, rt.type === RT.TUNNEL ? 0.15 : -1);
    }
    // phase 2: floors (lowest first so upper routes bridge over lower ones)
    if (sel.length > 1) sel.sort((a, b) => a.y - b.y);
    for (let si2 = 0; si2 < sel.length; si2++) {
      const c = sel[si2];
      const rt = c.rt, y = c.y;
      const fi = col.floorBelow(y);
      const below = fi >= 0 ? col.y1[fi] : -Infinity;
      let overRoute = false;
      for (let k = 0; k < si2; k++) if (Math.abs(sel[k].y - below) < 0.6 || (below < sel[k].y + sel[k].rt.clear && below >= sel[k].y - 0.6)) overRoute = true;
      // never fill down into a cave: bridge over it instead
      if ((col.flags & CF.CAVE) && y - below > 0.6) overRoute = true;
      let wet = overRoute;
      for (let k = 0; k < col.nw; k++) if (col.wl[k] > below - 0.1 && col.wl[k] < y + 0.5) wet = true;
      const topMat = rt.stairMat && c.slope > 0.3 ? rt.stairMat : rt.mat;
      if (!wet && y - below <= rt.fillLimit) {
        if (y - below < 0.3 && fi >= 0) {
          col.top[fi] = topMat;
          if (col.y1[fi] - col.y0[fi] < 1.0) col.add(col.y1[fi] - 1.0, col.y1[fi], topMat, rt.fillSide || M.DIRT, rt.fillSide || M.DIRT);
        } else col.add(below, y, topMat, rt.fillSide || M.DIRT, rt.fillSide || M.DIRT);
      } else {
        let th = rt.deck;
        if (rt.type === RT.LEDGE) th = rt.deck * (0.6 + 0.8 * (1 - c.d / rt.hw));
        const deckTop = wet && rt.type !== RT.LEDGE ? (rt.bridgeMat || M.WOOD) : topMat;
        col.add(y - th, y, deckTop, rt.deckSide || rt.bridgeMat || M.WOOD, rt.deckSide || rt.bridgeMat || M.WOOD, 0.6);
      }
    }
  }
}

void RIVER_REC; void Z_SEA; void clamp; void clamp01; void hash32;
