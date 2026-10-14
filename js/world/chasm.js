// The Great Fault (Layer 3): a colossal tube sunk ~1000 m below the Stone Plain.
// The round mouth in the plain leans out a little below its lip, then the
// walls drop almost sheer. They step gently in tiers: where a tier is narrower
// than the one above, a ledge forms; where it is wider, a slight overhang. The
// tube wanders a little with depth and is nearly round, and below the tiers a
// funnel narrows to the flooded basin at the entrance of Layer 4. Caves riddle
// its walls (see faultcaves.js).
//
// The shape is a stack of 2 m rows. Each row stores a centre, a base radius,
// an elongation and a blend of angular tables. A column is inside the chasm
// at a row when its distance to the row centre is below the row radius times
// the angular factor; the air intervals of a column come from interpolating
// the sign changes between rows, so floors, ceilings and walls are smooth.
import { Simplex, angularNoise } from '../core/noise.js';
import { RNG, hash32 } from '../core/rng.js';
import { clamp, smoothstep, TAU } from '../core/mathutil.js';

const TABN = 512;
const wrapPhi = (a) => a - Math.floor((a + Math.PI) / TAU) * TAU;
const ROW = 2;
const NT = 5;           // wall tables (plus table 0 for the mouth)
const MAX_INT = 16;
const SEG = 6;           // rows per skip segment

/** Chasm parameters. Derived from their own stream so other params never shift. */
export function makeChasmParams(seed, plainY, mouthR = 125) {
  const rng = RNG.derive(seed, 'chasm');
  const floorY = rng.range(-1962, -1944);
  const yThroat = plainY - rng.range(14, 22);
  const yWide = yThroat - rng.range(30, 44);
  const Rw = mouthR * rng.range(1.08, 1.15);
  const yFunnel = floorY + rng.range(130, 160);
  const tiers = [];
  let y = yWide;
  let prevK = 1;
  while (y > yFunnel + 30) {
    const h = rng.range(60, 120);
    let k = rng.range(0.93, 1.05);
    // keep consecutive tiers a little apart so every transition makes a ledge or an overhang
    if (Math.abs(k - prevK) < 0.035) k = clamp(prevK + (rng.chance(0.5) ? 0.05 : -0.05), 0.93, 1.05);
    tiers.push({ yTop: y, yBot: Math.max(yFunnel, y - h), k, blend: rng.range(6, 12), table: 1 + (tiers.length % NT) });
    prevK = k;
    y -= h;
  }
  tiers[tiers.length - 1].yBot = yFunnel;
  return {
    floorY, yThroat, yWide, Rw, yFunnel, tiers,
    ax: rng.range(1.0, 1.07),
    axis: rng.range(0, Math.PI),
    basinR: rng.range(92, 112),
    drift: rng.range(6, 16),
    driftAngle: rng.range(0, TAU),
    sway: rng.range(0.4, 0.9),
    seed: rng.int(1, 1e9),
  };
}

export class Chasm {
  /** field: TerrainField (shares its warp noise and fault mouth table). */
  constructor(params, field) {
    const c = params.chasm, f = params.fault;
    this.cacheCap = 400000;   // wall distance cache entries (planning); the running game lowers it
    this.c = c;
    this.f = f;
    this.cx0 = f.x; this.cz0 = f.z;
    this.nWarp = field.nWarp;
    this.ca = Math.cos(c.axis); this.sa = Math.sin(c.axis);
    this.yTop = params.plainY + 30;
    this.yBot = c.floorY - 4;
    this.plainY = params.plainY;
    const rows = (this.rows = Math.ceil((this.yTop - this.yBot) / ROW) + 1);
    this.rowY = new Float32Array(rows);
    this.ox = new Float32Array(rows);
    this.oz = new Float32Array(rows);
    this.R = new Float32Array(rows);
    this.iax2 = new Float32Array(rows);
    this.ta = new Uint8Array(rows);
    this.tb = new Uint8Array(rows);
    this.tw = new Float32Array(rows);
    this.ph = new Float32Array(rows);
    this.wamp = new Float32Array(rows);
    this.tv = new Float32Array(NT + 1);
    this._iv = new Float32Array(MAX_INT * 2);

    // angular tables: 0 = the fault mouth (same outline as the plain hole), 1..NT walls, wobble
    const n = new Simplex(hash32(c.seed, 3));
    this.tabs = [];
    const t0 = new Float32Array(TABN + 1);
    for (let i = 0; i <= TABN; i++) t0[i] = field.tab(field.faultTab, (i / TABN) * TAU - Math.PI) / f.r;
    this.tabs.push(t0);
    let maxT = 0;
    for (let t = 1; t <= NT; t++) {
      const T = new Float32Array(TABN + 1);
      for (let i = 0; i <= TABN; i++) {
        const th = (i / TABN) * TAU - Math.PI;
        // nearly round, with buttresses and recesses rather than lobes
        T[i] = 1 + 0.035 * angularNoise(n, th, 1.6, t * 11) + 0.03 * angularNoise(n, th, 3.9, t * 13 + 5)
          + 0.022 * angularNoise(n, th, 9.5, t * 17 + 9) + 0.012 * angularNoise(n, th, 23, t * 19 + 3);
        maxT = Math.max(maxT, T[i]);
      }
      this.tabs.push(T);
    }
    for (let i = 0; i <= TABN; i++) maxT = Math.max(maxT, t0[i]);
    this.wob = new Float32Array(TABN + 1);
    for (let i = 0; i <= TABN; i++) this.wob[i] = angularNoise(n, (i / TABN) * TAU - Math.PI, 5.3, 71);

    const nS = new Simplex(hash32(c.seed, 5));
    const dA = c.driftAngle;
    const rT = f.r * 1.04;
    const tiers = c.tiers;
    const last = tiers[tiers.length - 1];
    let bound = 0;
    for (let k = 0; k < rows; k++) {
      const y = this.yTop - k * ROW;
      this.rowY[k] = y;
      let R, ax = 1, ta = 0, tb = 0, tw = 0, wamp = 0;
      if (y >= c.yThroat) {
        // mouth and throat: the plain hole, leaning outward a little below the lip
        R = f.r * (1 + 0.04 * smoothstep(params.plainY - 5, c.yThroat, y));
      } else if (y >= c.yWide) {
        const s = (c.yThroat - y) / (c.yThroat - c.yWide);
        const q = Math.sqrt(Math.max(0, 1 - (1 - s) * (1 - s)));
        R = rT + (c.Rw * tiers[0].k - rT) * q;
        ax = 1 + (c.ax - 1) * q;
        ta = 0; tb = tiers[0].table; tw = smoothstep(0, 0.8, s);
        wamp = 0.03 * q;
      } else if (y >= c.yFunnel) {
        let i = 0;
        while (i < tiers.length - 1 && y < tiers[i].yBot) i++;
        const T = tiers[i];
        const prev = i > 0 ? tiers[i - 1] : null;
        let kk = T.k;
        if (prev) kk = prev.k + (T.k - prev.k) * smoothstep(T.yTop + 1, T.yTop - T.blend, y);
        R = c.Rw * kk;
        ax = c.ax;
        ta = prev ? prev.table : T.table; tb = T.table;
        tw = prev ? smoothstep(T.yTop + 8, T.yTop - (T.yTop - T.yBot) * 0.6, y) : 1;
        wamp = 0.03;
      } else if (y >= c.floorY + 6) {
        const s = (c.yFunnel - y) / (c.yFunnel - c.floorY - 6);
        const e = 1 - Math.pow(1 - s, 1.6);
        R = c.Rw * last.k + (c.basinR - c.Rw * last.k) * e;
        ax = c.ax + (1.08 - c.ax) * s;
        ta = tb = last.table; tw = 0;
        wamp = 0.05 * (1 - s);
      } else {
        // basin floor: a shallow bowl with a raised rim
        R = c.basinR + (-25 - c.basinR) * ((c.floorY + 6 - y) / 8);
        ax = 1.08;
        ta = tb = last.table;
      }
      if (y < c.yThroat - 2) {
        // erosion bands: thin rings of ledges and overhangs
        const band = 0.014 * nS.noise2(y / 9, 0.5) + 0.003 * nS.noise2(y / 3.1, 7.5);
        R *= 1 + band * smoothstep(c.yThroat - 2, c.yThroat - 20, y);
      }
      // centre drift with depth (none at the mouth, which matches the plain hole)
      let ox = 0, oz = 0;
      if (y < c.yThroat) {
        const s = clamp((c.yThroat - y) / (c.yThroat - c.floorY), 0, 1);
        const along = c.drift * (0.5 - 0.5 * Math.cos(Math.PI * s));
        const side = c.drift * 0.4 * Math.sin(TAU * s * 1.3 + c.sway) * smoothstep(0, 0.15, s);
        ox = Math.cos(dA) * along - Math.sin(dA) * side;
        oz = Math.sin(dA) * along + Math.cos(dA) * side;
      }
      this.ox[k] = ox; this.oz[k] = oz;
      this.R[k] = R;
      this.iax2[k] = 1 / (ax * ax);
      this.ta[k] = ta; this.tb[k] = tb; this.tw[k] = tw;
      this.ph[k] = 1.1 * c.sway * nS.noise2(y / 70, 19.5);
      this.wamp[k] = wamp;
      if (R > 0) bound = Math.max(bound, Math.hypot(ox, oz) + R * (maxT + wamp) * ax);
    }
    this.bound = bound + 14;
    this.bound2 = this.bound * this.bound;
    // the warp is smooth (70 m features): cache it on a 4 m grid over the chasm and interpolate
    this.wG = 4;
    this.wN = Math.ceil((2 * this.bound + 16) / this.wG) + 2;
    this.wX0 = this.cx0 - this.bound - 8; this.wZ0 = this.cz0 - this.bound - 8;
    this.warpTab = new Float32Array(this.wN * this.wN * 2).fill(NaN);
    // per segment of SEG rows: how much f can change inside it (to skip rows with no crossing)
    let tdiff = 0;
    for (let i = 0; i <= TABN; i++) {
      let lo = Infinity, hi = -Infinity;
      for (let t = 0; t <= NT; t++) { lo = Math.min(lo, this.tabs[t][i]); hi = Math.max(hi, this.tabs[t][i]); }
      tdiff = Math.max(tdiff, hi - lo);
    }
    const nSeg = Math.ceil((rows - 1) / SEG);
    this.segVar = new Float32Array(nSeg);
    this.segDax = new Float32Array(nSeg);
    let maxO = 0;
    for (let k = 0; k < rows; k++) maxO = Math.max(maxO, Math.hypot(this.ox[k], this.oz[k]));
    this.maxO = maxO;
    for (let j = 0; j < nSeg; j++) {
      const a = j * SEG;
      let v = 0, dax = 0;
      for (let k = a + 1; k <= Math.min(rows - 1, a + SEG); k++) {
        const Rk = Math.max(Math.abs(this.R[k]), Math.abs(this.R[a]));
        const tabChange = this.ta[k] !== this.ta[a] || this.tb[k] !== this.tb[a] ? tdiff : tdiff * Math.abs(this.tw[k] - this.tw[a]);
        // |f_k - f_a| <= |d_k - d_a| + |R_k m_k - R_a m_a|; the elongation part of d depends on the column (segDax)
        v = Math.max(v, Math.abs(this.R[k] - this.R[a]) * (maxT + 0.1) + Rk * (tabChange + this.wamp[k] + this.wamp[a])
          + Math.hypot(this.ox[k] - this.ox[a], this.oz[k] - this.oz[a]));
        dax = Math.max(dax, Math.abs(Math.sqrt(this.iax2[k]) - Math.sqrt(this.iax2[a])));
      }
      this.segVar[j] = v + 0.25;
      this.segDax[j] = dax;
    }
  }

  _warpAt(i, j) {
    const k = (j * this.wN + i) * 2;
    const t = this.warpTab;
    if (t[k] !== t[k]) {
      const x = this.wX0 + i * this.wG, z = this.wZ0 + j * this.wG;
      t[k] = this.nWarp.noise2(x / 70 + 50, z / 70) * 9;
      t[k + 1] = this.nWarp.noise2(x / 70, z / 70 + 50) * 9;
    }
    return k;
  }

  /** Warped offset of (x, z) from the fault centre (same warp as the plain hole). */
  local(x, z, out) {
    const fx = (x - this.wX0) / this.wG, fz = (z - this.wZ0) / this.wG;
    const i = Math.floor(fx), j = Math.floor(fz);
    let wx, wz;
    if (i >= 0 && j >= 0 && i < this.wN - 1 && j < this.wN - 1) {
      const a = fx - i, b = fz - j, t = this.warpTab;
      const k00 = this._warpAt(i, j), k10 = this._warpAt(i + 1, j), k01 = this._warpAt(i, j + 1), k11 = this._warpAt(i + 1, j + 1);
      wx = (t[k00] * (1 - a) + t[k10] * a) * (1 - b) + (t[k01] * (1 - a) + t[k11] * a) * b;
      wz = (t[k00 + 1] * (1 - a) + t[k10 + 1] * a) * (1 - b) + (t[k01 + 1] * (1 - a) + t[k11 + 1] * a) * b;
    } else {
      wx = this.nWarp.noise2(x / 70 + 50, z / 70) * 9;
      wz = this.nWarp.noise2(x / 70, z / 70 + 50) * 9;
    }
    out.px = x - this.cx0 + wx;
    out.pz = z - this.cz0 + wz;
    out.th = Math.atan2(out.pz, out.px);
    return out;
  }

  _tables(th) {
    const fi = ((th + Math.PI) / TAU) * TABN;
    let i = Math.floor(fi);
    const a = fi - i;
    i = ((i % TABN) + TABN) % TABN;
    const tv = this.tv;
    for (let t = 0; t <= NT; t++) { const T = this.tabs[t]; tv[t] = T[i] + (T[i + 1] - T[i]) * a; }
  }

  _wob(th) {
    const fi = ((th + Math.PI) / TAU) * TABN;
    let i = Math.floor(fi);
    const a = fi - i;
    i = ((i % TABN) + TABN) % TABN;
    return this.wob[i] + (this.wob[i + 1] - this.wob[i]) * a;
  }

  /** Signed horizontal clearance at row k (negative inside the chasm). Requires _tables(th). */
  _f(k, px, pz, th) {
    const ddx = px - this.ox[k], ddz = pz - this.oz[k];
    const u = ddx * this.ca + ddz * this.sa, v = ddz * this.ca - ddx * this.sa;
    const d = Math.sqrt(u * u * this.iax2[k] + v * v);
    const tv = this.tv;
    let m = tv[this.ta[k]] + (tv[this.tb[k]] - tv[this.ta[k]]) * this.tw[k];
    if (this.wamp[k] > 0) m += this.wamp[k] * this._wob(th + this.ph[k]);
    return d - this.R[k] * m;
  }

  /**
   * Air intervals of the chasm in column (x, z), as [top, bottom] pairs
   * (top > bottom), highest first. Returns the count; pairs are in this._iv.
   */
  intervals(x, z) {
    const px0 = x - this.cx0, pz0 = z - this.cz0;
    if (px0 * px0 + pz0 * pz0 > this.bound2) return 0;
    const L = this.local(x, z, this._L || (this._L = {}));
    const px = L.px, pz = L.pz, th = L.th;
    this._tables(th);
    const out = this._iv;
    const rows = this.rows, rowY = this.rowY, segVar = this.segVar, segDax = this.segDax;
    const reach = Math.sqrt(px * px + pz * pz) + this.maxO;
    let n = 0, top = 0;
    let prevF = this._f(0, px, pz, th);
    if (prevF < 0) top = rowY[0];
    for (let a = 0; a < rows - 1; a += SEG) {
      const b = Math.min(rows - 1, a + SEG);
      const fb = this._f(b, px, pz, th);
      // no crossing possible inside this segment: skip its rows
      const sv = segVar[a / SEG] + segDax[a / SEG] * reach;
      if ((prevF > sv && fb > sv) || (prevF < -sv && fb < -sv)) { prevF = fb; continue; }
      for (let k = a + 1; k <= b; k++) {
        const fv = k === b ? fb : this._f(k, px, pz, th);
        if ((fv < 0) !== (prevF < 0)) {
          const yc = rowY[k - 1] - ROW * (prevF / (prevF - fv));
          if (fv < 0) top = yc;
          else if (n < MAX_INT) { out[n * 2] = top; out[n * 2 + 1] = yc; n++; }
        }
        prevF = fv;
      }
    }
    if (prevF < 0 && n < MAX_INT) { out[n * 2] = top; out[n * 2 + 1] = rowY[rows - 1]; n++; }
    // tidy the wall fringe: open rock slivers thinner than 1.5 m, fill air slivers under 2 m
    let m = 0;
    for (let i = 0; i < n; i++) {
      const t = out[i * 2], b = out[i * 2 + 1];
      if (m > 0 && out[(m - 1) * 2 + 1] - t < 1.5) { out[(m - 1) * 2 + 1] = b; continue; }
      out[m * 2] = t; out[m * 2 + 1] = b; m++;
    }
    n = 0;
    for (let i = 0; i < m; i++) {
      if (out[i * 2] - out[i * 2 + 1] < 2) continue;
      out[n * 2] = out[i * 2]; out[n * 2 + 1] = out[i * 2 + 1]; n++;
    }
    return n;
  }

  /** Signed horizontal clearance at height y (negative inside the chasm). */
  clearance(x, y, z) {
    if (y > this.yTop || y < this.yBot) return 1e3;
    const px0 = x - this.cx0, pz0 = z - this.cz0;
    if (px0 * px0 + pz0 * pz0 > this.bound2) return Math.sqrt(px0 * px0 + pz0 * pz0) - this.bound + 14;
    const L = this.local(x, z, this._L || (this._L = {}));
    this._tables(L.th);
    const fk = (this.yTop - y) / ROW;
    const k = Math.min(this.rows - 2, Math.floor(fk));
    const a = fk - k;
    const f0 = this._f(k, L.px, L.pz, L.th), f1 = this._f(k + 1, L.px, L.pz, L.th);
    return f0 + (f1 - f0) * a;
  }

  inside(x, y, z) { return this.clearance(x, y, z) < 0; }

  /** Horizontal distance outside the plain hole (negative inside it). */
  clearanceMouth(x, z) {
    const L = this.local(x, z, this._L2 || (this._L2 = {}));
    this._tables(L.th);
    return Math.hypot(L.px, L.pz) - this.f.r * this.tv[0];
  }

  /** World position of the chasm axis at height y. */
  centreAt(y) {
    const k = clamp(Math.round((this.yTop - y) / ROW), 0, this.rows - 1);
    return [this.cx0 + this.ox[k], this.cz0 + this.oz[k]];
  }

  /**
   * Distance from the axis to the wall along direction phi at height y
   * (radial march + bisection). Returns 0 where the chasm does not exist.
   * Results are cached on a 1 m x 0.0015 rad grid (planning makes many queries).
   */
  wallDist(phi, y) {
    const yi = Math.round(y), pi = Math.round((wrapPhi(phi) + Math.PI) * 650);
    const key = (yi + 4000) * 4100 + pi;
    const cache = this._wcache || (this._wcache = new Map());
    let v = cache.get(key);
    if (v === undefined) {
      v = this._wallDist((pi / 650) - Math.PI, yi);
      if (cache.size > this.cacheCap) cache.clear();
      cache.set(key, v);
    }
    return v;
  }

  _wallDist(phi, y) {
    const [cx, cz] = this.centreAt(y);
    const dx = Math.cos(phi), dz = Math.sin(phi);
    let f = this.clearance(cx, y, cz);
    if (f >= 0) return 0;
    // march outward using the clearance as a step bound, then bisect the crossing
    let a = 0, b = 0;
    for (let r = 0, guard = 0; guard < 80; guard++) {
      const step = Math.max(0.75, -f * 0.6);
      const nr = r + step;
      if (nr > this.bound + 20) return r;
      f = this.clearance(cx + dx * nr, y, cz + dz * nr);
      if (f >= 0) { a = r; b = nr; break; }
      r = nr;
    }
    if (!b) return a;
    for (let i = 0; i < 8 && b - a > 0.05; i++) {
      const m = (a + b) / 2;
      if (this.inside(cx + dx * m, y, cz + dz * m)) a = m; else b = m;
    }
    return a;
  }

  /** Point at offset `off` from the wall (positive = into the rock) along phi at height y. */
  wallPoint(phi, y, off) {
    const [cx, cz] = this.centreAt(y);
    const R = this.wallDist(phi, y);
    return [cx + Math.cos(phi) * (R + off), cz + Math.sin(phi) * (R + off), R];
  }
}
