// Main-thread world access: column spans for collision, raycasts for the
// grappling arm, water and material queries, layer/zone information.
// Columns come from loaded LOD-0 chunks (built by workers) or are evaluated
// on demand with the same deterministic generator and cached.
import { ColumnGen, ColumnData, CF } from './column.js';
import { worldToAxial, axialX, axialZ, HEX_R } from '../core/hex.js';
import { CHUNK } from './mesher.js';
import { layerIndexAt, LAYERS, LAYER_BOUNDARIES } from './layers.js';
import { Z_EYE, Z_BOWL, Z_CITY, Z_COUNTRY, Z_SEA } from './field.js';
import { M, MATERIALS } from './materials.js';

class Col {
  constructor() { this.n = 0; this.y = null; this.mat = null; this.water = NaN; this.flags = 0; this.off = 0; }
}

export class World {
  constructor(plan) {
    this.plan = plan;
    this.params = plan.params;
    this.gen = new ColumnGen(plan);
    this.field = this.gen.field;
    this.cache = new Map();
    this.l0 = new Map();     // "cq:cr" -> spans data
    this.colliders = new Map(); // "cq:cr" -> colliders array
    this._col = new ColumnData();
    this._ax = { q: 0, r: 0 };
    this._P = {};
    this.evals = 0;
  }

  addChunkData(cq, cr, spans, colliders) {
    const k = cq + ':' + cr;
    spans.views = new Array(CHUNK * CHUNK);
    this.l0.set(k, spans);
    this.colliders.set(k, colliders || []);
  }

  removeChunkData(cq, cr) {
    const k = cq + ':' + cr;
    this.l0.delete(k);
    this.colliders.delete(k);
  }

  /** Column at axial cell (q, r) at full detail. */
  cell(q, r) {
    const cq = Math.floor(q / CHUNK), cr = Math.floor(r / CHUNK);
    const ch = this.l0.get(cq + ':' + cr);
    if (ch) {
      const i = q - ch.q0, j = r - ch.r0;
      const k = j * CHUNK + i;
      let v = ch.views[k];
      if (!v) {
        v = new Col();
        v.n = ch.start[k + 1] - ch.start[k];
        v.off = ch.start[k];
        v.y = ch.y; v.mat = ch.mat;
        v.water = ch.water[k];
        v.flags = ch.flags[k];
        ch.views[k] = v;
      }
      return v;
    }
    const key = (q + 40000) * 100000 + (r + 40000);
    let v = this.cache.get(key);
    if (v) return v;
    if (this.cache.size > 40000) this.cache.clear();
    const c = this._col;
    this.gen.column(axialX(q, r), axialZ(r), 0, c);
    this.evals++;
    v = new Col();
    v.n = c.n;
    v.off = 0;
    v.y = new Float32Array(c.n * 2);
    v.mat = new Uint8Array(c.n * 2);
    for (let s = 0; s < c.n; s++) { v.y[s * 2] = c.y0[s]; v.y[s * 2 + 1] = c.y1[s]; v.mat[s * 2] = c.top[s]; v.mat[s * 2 + 1] = c.side[s]; }
    v.water = c.nw ? c.wl[c.nw - 1] : NaN;
    v.flags = c.flags;
    this.cache.set(key, v);
    return v;
  }

  columnAt(x, z) {
    worldToAxial(x, z, this._ax);
    return this.cell(this._ax.q, this._ax.r);
  }

  /** Highest floor top at or below y (+tol). Returns -Infinity if none. */
  floorBelow(x, y, z, tol = 0.01) {
    const c = this.columnAt(x, z);
    for (let s = c.n - 1; s >= 0; s--) {
      const top = c.y[(c.off + s) * 2 + 1];
      if (top <= y + tol) return top;
    }
    return -Infinity;
  }

  /** Lowest ceiling (span bottom) at or above y. Returns Infinity if open. */
  ceilingAbove(x, y, z) {
    const c = this.columnAt(x, z);
    for (let s = 0; s < c.n; s++) {
      const b = c.y[(c.off + s) * 2];
      if (b >= y) return b;
    }
    return Infinity;
  }

  isSolid(x, y, z) {
    const c = this.columnAt(x, z);
    for (let s = 0; s < c.n; s++) {
      const o = (c.off + s) * 2;
      if (y > c.y[o] && y < c.y[o + 1]) return true;
    }
    return false;
  }

  /** Material of the floor the given point stands on. */
  floorMaterial(x, y, z) {
    const c = this.columnAt(x, z);
    for (let s = c.n - 1; s >= 0; s--) {
      const o = (c.off + s) * 2;
      if (c.y[o + 1] <= y + 0.05) return c.mat[o];
    }
    return M.AIR;
  }

  /** Material of the solid at a point (side material) or AIR. */
  materialAt(x, y, z) {
    const c = this.columnAt(x, z);
    for (let s = 0; s < c.n; s++) {
      const o = (c.off + s) * 2;
      if (y >= c.y[o] && y <= c.y[o + 1]) return y > c.y[o + 1] - 0.3 ? c.mat[o] : c.mat[o + 1];
    }
    return M.AIR;
  }

  /** Water level at the point's column if the point is in that water's gap, else NaN. */
  waterAt(x, y, z) {
    const c = this.columnAt(x, z);
    if (Number.isNaN(c.water)) {
      // sea outside the island
      if (y < this.params.seaY + 0.2) {
        const P = this.field.polar(x, z, this._P);
        if (P.r > P.Rc - 20) return this.params.seaY;
      }
      return NaN;
    }
    // the stored level belongs to the gap directly above some floor; accept if y is within that gap region
    const fl = this.floorBelow(x, c.water, z);
    if (y >= fl - 0.5 && y <= c.water + 3) return c.water;
    return NaN;
  }

  flagsAt(x, z) { return this.columnAt(x, z).flags; }

  /**
   * Raycast against terrain columns and tree colliders. Returns null or
   * {x, y, z, dist, nx, ny, nz, mat, kind}.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, opts = {}) {
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const step = opts.step || 0.25;
    let px = ox, py = oy, pz = oz;
    let prevSolid = this.isSolid(px, py, pz);
    let hit = null;
    for (let t = step; t <= maxDist; t += step) {
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      if (this.isSolid(x, y, z) && !prevSolid) {
        // refine
        let a = t - step, b = t;
        for (let i = 0; i < 8; i++) {
          const m = (a + b) / 2;
          if (this.isSolid(ox + dx * m, oy + dy * m, oz + dz * m)) b = m; else a = m;
        }
        const hx = ox + dx * b, hy = oy + dy * b, hz = oz + dz * b;
        // normal: top/bottom face if the previous point was above/below the span, else side
        const ax = ox + dx * a, ay = oy + dy * a, az = oz + dz * a;
        let nx = 0, ny = 0, nz = 0;
        const c = this.columnAt(hx, hz);
        const ca = this.columnAt(ax, az);
        if (c === ca) { ny = dy < 0 ? 1 : -1; } else {
          worldToAxial(hx, hz, this._ax);
          const cxw = axialX(this._ax.q, this._ax.r), czw = axialZ(this._ax.r);
          nx = ax - cxw; nz = az - czw;
          const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
        }
        hit = { x: hx, y: hy, z: hz, dist: b, nx, ny, nz, mat: this.materialAt(hx, hy, hz), kind: 'terrain' };
        break;
      }
      prevSolid = false;
      px = x; py = y; pz = z;
    }
    // tree colliders
    const tHit = this.raycastColliders(ox, oy, oz, dx, dy, dz, hit ? hit.dist : maxDist);
    if (tHit) hit = tHit;
    void px; void py; void pz;
    return hit;
  }

  collidersNear(x, z, r) {
    const out = [];
    const span = CHUNK;
    const rq = z / 0.8660254, qq = x - rq / 2;
    const cq0 = Math.floor((qq - r * 1.2) / span), cq1 = Math.floor((qq + r * 1.2) / span);
    const cr0 = Math.floor((rq - r * 1.2) / span), cr1 = Math.floor((rq + r * 1.2) / span);
    for (let cr = cr0; cr <= cr1; cr++) for (let cq = cq0; cq <= cq1; cq++) {
      const list = this.colliders.get(cq + ':' + cr);
      if (list) for (const c of list) out.push(c);
    }
    return out;
  }

  raycastColliders(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    const mx = ox + dx * maxDist * 0.5, mz = oz + dz * maxDist * 0.5;
    for (const c of this.collidersNear(mx, mz, maxDist * 0.6 + 5)) {
      let t = null, nx = 0, ny = 0, nz = 0;
      if (c.t === 'cyl') {
        // infinite vertical cylinder intersection, clipped to [y0, y1]
        const fx = ox - c.x, fz = oz - c.z;
        const a = dx * dx + dz * dz;
        if (a < 1e-6) continue;
        const b = 2 * (fx * dx + fz * dz), cc = fx * fx + fz * fz - c.r * c.r;
        const disc = b * b - 4 * a * cc;
        if (disc < 0) continue;
        const t0 = (-b - Math.sqrt(disc)) / (2 * a);
        if (t0 < 0 || t0 > maxDist) continue;
        const y = oy + dy * t0;
        if (y < c.y0 || y > c.y1) continue;
        t = t0;
        nx = (ox + dx * t - c.x) / c.r; nz = (oz + dz * t - c.z) / c.r;
      } else if (c.t === 'cap') {
        // approximate capsule by sampling segment distance along the ray
        for (let s = 0; s <= maxDist; s += 0.3) {
          const px = ox + dx * s, py = oy + dy * s, pz = oz + dz * s;
          const ex = c.bx - c.ax, ey = c.by - c.ay, ez = c.bz - c.az;
          const l2 = ex * ex + ey * ey + ez * ez;
          let u = ((px - c.ax) * ex + (py - c.ay) * ey + (pz - c.az) * ez) / l2;
          u = Math.max(0, Math.min(1, u));
          const qx = c.ax + ex * u - px, qy = c.ay + ey * u - py, qz = c.az + ez * u - pz;
          if (qx * qx + qy * qy + qz * qz < c.r * c.r) { t = s; nx = -qx; ny = -qy; nz = -qz; break; }
        }
      }
      if (t !== null && (!best || t < best.dist)) {
        const l = Math.hypot(nx, ny, nz) || 1;
        best = { x: ox + dx * t, y: oy + dy * t, z: oz + dz * t, dist: t, nx: nx / l, ny: ny / l, nz: nz / l, mat: M.WOOD, kind: 'tree' };
      }
    }
    return best;
  }

  /** Zone and layer at a position. */
  info(x, y, z) {
    const P = this.field.polar(x, z, this._P);
    const surface = P.zone === Z_CITY || P.zone === Z_COUNTRY || P.zone === Z_SEA;
    const layer = layerIndexAt(y, surface);
    return { zone: P.zone, layer, r: P.r, Re: P.Re, Rr: P.Rr, th: P.th, depth: -y };
  }

  layerDef(i) { return LAYERS[Math.max(0, Math.min(LAYERS.length - 1, i))]; }
}

export { CF, Z_EYE, Z_BOWL, Z_CITY, Z_COUNTRY, Z_SEA, LAYER_BOUNDARIES, MATERIALS, HEX_R };
