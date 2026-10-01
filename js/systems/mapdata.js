// Exploration record for the maps. The world is rasterised at 4 m resolution
// into three depth bands (surface + Layer 1, Layer 2, Layer 3); a cell is only
// stored once the explorer has been near it or has seen it. Nothing is
// revealed automatically. Also records the travelled trail.
import { WORLD_HALF_X, WORLD_HALF_Z } from '../world/params.js';
import { CF } from '../world/column.js';

export const RES = 4;
export const MAP_W = Math.ceil((WORLD_HALF_X * 2) / RES);
export const MAP_H = Math.ceil((WORLD_HALF_Z * 2) / RES);
export const X0 = -WORLD_HALF_X, Z0 = -WORLD_HALF_Z;
export const BANDS = [
  { id: 0, name: 'Surface & First Layer', top: 400, bottom: -345 },
  { id: 1, name: 'Second Layer', top: -345, bottom: -895 },
  { id: 2, name: 'Third Layer', top: -895, bottom: -3000 },
];
// cell flags
export const F_EXPLORED = 1, F_WATER = 2, F_VOID = 4, F_ROUTE = 8, F_BUILDING = 16, F_CAVE = 32;

export function bandOf(y) { return y > -345 ? 0 : y > -895 ? 1 : 2; }

export class MapData {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    const n = MAP_W * MAP_H;
    this.bands = BANDS.map(() => ({ h: new Int16Array(n), mat: new Uint8Array(n), flags: new Uint8Array(n), count: 0, version: 0 }));
    this.queue = [];
    this.queued = new Set();
    this.trail = [];        // [x, y, z, ...]
    this.trailLast = null;
    this.revealTimer = 0;
    this.rayTimer = 0;
    this.rayIndex = 0;
  }

  cellIndex(x, z) {
    const i = Math.floor((x - X0) / RES), j = Math.floor((z - Z0) / RES);
    if (i < 0 || j < 0 || i >= MAP_W || j >= MAP_H) return -1;
    return j * MAP_W + i;
  }

  explored(band, x, z) {
    const k = this.cellIndex(x, z);
    return k >= 0 && (this.bands[band].flags[k] & F_EXPLORED) !== 0;
  }

  /** Queue every cell within radius r (metres) of (x, z) in a band. */
  reveal(x, y, z, r, band = bandOf(y)) {
    const B = this.bands[band];
    const i0 = Math.max(0, Math.floor((x - r - X0) / RES)), i1 = Math.min(MAP_W - 1, Math.floor((x + r - X0) / RES));
    const j0 = Math.max(0, Math.floor((z - r - Z0) / RES)), j1 = Math.min(MAP_H - 1, Math.floor((z + r - Z0) / RES));
    const r2 = r * r;
    const list = [];
    for (let j = j0; j <= j1; j++) {
      const cz = Z0 + (j + 0.5) * RES;
      for (let i = i0; i <= i1; i++) {
        const k = j * MAP_W + i;
        if (B.flags[k] & F_EXPLORED) continue;
        const cx = X0 + (i + 0.5) * RES;
        const d2 = (cx - x) ** 2 + (cz - z) ** 2;
        if (d2 > r2) continue;
        const key = band * 1e7 + k;
        if (this.queued.has(key)) continue;
        list.push([d2, band, k, y]);
      }
    }
    list.sort((a, b) => a[0] - b[0]);
    for (const it of list) { this.queued.add(it[1] * 1e7 + it[2]); this.queue.push(it); }
  }

  /** Pick the floor for a cell in a band, near the reference height. */
  sampleCell(band, k, refY) {
    const B = this.bands[band];
    const i = k % MAP_W, j = (k / MAP_W) | 0;
    const x = X0 + (i + 0.5) * RES, z = Z0 + (j + 0.5) * RES;
    const c = this.world.columnAt(x, z);
    const BD = BANDS[band];
    let best = -1, bestD = Infinity;
    for (let s = c.n - 1; s >= 0; s--) {
      const top = c.y[(c.off + s) * 2 + 1];
      const above = s + 1 < c.n ? c.y[(c.off + s + 1) * 2] : Infinity;
      if (above - top < 1.8) continue;
      if (top > BD.top || top < BD.bottom - 20) continue;
      if (band === 0) { best = s; break; }  // the topmost surface
      const d = Math.abs(top - refY) + (top > refY + 6 ? 40 : 0);
      if (d < bestD) { bestD = d; best = s; }
    }
    let flags = F_EXPLORED;
    if (best < 0) {
      flags |= F_VOID;
      B.h[k] = Math.max(-8000, Math.min(8000, Math.round(BD.bottom * 4)));
      B.mat[k] = 0;
    } else {
      const top = c.y[(c.off + best) * 2 + 1];
      B.h[k] = Math.round(top * 4);
      B.mat[k] = c.mat[(c.off + best) * 2];
      if (!Number.isNaN(c.water) && c.water >= top - 0.2 && c.water < top + 8) flags |= F_WATER;
      if (c.flags & CF.ROUTE) flags |= F_ROUTE;
      if (c.flags & CF.BUILDING) flags |= F_BUILDING;
      const above = best + 1 < c.n ? c.y[(c.off + best + 1) * 2] : Infinity;
      if (above < top + 40) flags |= F_CAVE;
    }
    if (!(B.flags[k] & F_EXPLORED)) B.count++;
    B.flags[k] = flags;
    B.version++;
  }

  update(dt) {
    const g = this.game, p = g.player;
    if (!p) return;
    const pos = p.pos;
    // trail
    if (!this.trailLast || Math.hypot(pos.x - this.trailLast[0], pos.y - this.trailLast[1], pos.z - this.trailLast[2]) > 6) {
      if (p.mode !== 'dead') {
        this.trail.push(Math.round(pos.x * 10) / 10, Math.round(pos.y * 10) / 10, Math.round(pos.z * 10) / 10);
        if (this.trail.length > 90000) this.trail.splice(0, 3);
        this.trailLast = [pos.x, pos.y, pos.z];
      }
    }
    // reveal around the explorer
    this.revealTimer -= dt;
    if (this.revealTimer <= 0) {
      this.revealTimer = 0.4;
      const enclosed = g.envEnclosed > 0.5;
      const bonus = 1 + (g.artifacts?.mods?.cartographer || 0);
      this.reveal(pos.x, pos.y, pos.z, (enclosed ? 26 : 56) * bonus);
    }
    // what the explorer sees in the distance (sparse view rays outdoors)
    this.rayTimer -= dt;
    if (this.rayTimer <= 0 && g.envEnclosed < 0.5 && p.mode !== 'dead') {
      this.rayTimer = 0.3;
      const cam = g.camera;
      const k = this.rayIndex++ % 5;
      const yawOff = [0, -0.35, 0.35, -0.18, 0.18][k];
      const pitchOff = [-0.05, -0.12, -0.12, 0.05, 0.05][k];
      const yaw = p.yaw + yawOff, pitch = Math.max(-1.4, Math.min(0.3, p.pitch + pitchOff));
      const dx = -Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = -Math.cos(yaw) * Math.cos(pitch);
      const hit = this.world.raycast(cam.position.x, cam.position.y, cam.position.z, dx, dy, dz, 200, { step: 2 });
      if (hit && hit.dist > 30) this.reveal(hit.x, hit.y, hit.z, 10 + hit.dist * 0.06);
    }
    // process the queue within a time budget
    const t0 = performance.now();
    let n = 0;
    while (this.queue.length && (n < 40 || performance.now() - t0 < 1.5)) {
      const it = this.queue.shift();
      this.queued.delete(it[1] * 1e7 + it[2]);
      if (!(this.bands[it[1]].flags[it[2]] & F_EXPLORED)) this.sampleCell(it[1], it[2], it[3]);
      n++;
      if (n > 4000) break;
    }
  }

  /** Fraction of a band explored (for statistics). */
  coverage(band) { return this.bands[band].count; }

  // ------------------------------------------------------------------ persistence
  serialize() {
    const out = { trail: Array.from(this.trail, (v) => Math.round(v)), bands: [] };
    for (const B of this.bands) {
      // explored cells: run lengths of the explored mask, then packed data
      const runs = [];
      let cur = 0, len = 0;
      const n = B.flags.length;
      const cells = [];
      for (let k = 0; k < n; k++) {
        const e = (B.flags[k] & F_EXPLORED) ? 1 : 0;
        if (e !== cur) { runs.push(len); len = 0; cur = e; }
        len++;
        if (e) cells.push(k);
      }
      runs.push(len);
      const bytes = new Uint8Array(cells.length * 4);
      let prev = 0;
      cells.forEach((k, i) => {
        const h = B.h[k];
        const d = Math.max(-32768, Math.min(32767, h - prev));
        prev = h;
        bytes[i * 4] = d & 255; bytes[i * 4 + 1] = (d >> 8) & 255;
        bytes[i * 4 + 2] = B.mat[k]; bytes[i * 4 + 3] = B.flags[k];
      });
      out.bands.push({ runs, data: toBase64(bytes) });
    }
    return out;
  }

  restore(s) {
    if (!s) return;
    this.trail = (s.trail || []).slice();
    const n = this.trail.length;
    this.trailLast = n >= 3 ? [this.trail[n - 3], this.trail[n - 2], this.trail[n - 1]] : null;
    (s.bands || []).forEach((b, bi) => {
      const B = this.bands[bi];
      if (!B) return;
      const bytes = fromBase64(b.data || '');
      let k = 0, e = 0, c = 0, prev = 0;
      for (const run of b.runs || []) {
        if (e) {
          for (let q = 0; q < run; q++, k++, c++) {
            let d = bytes[c * 4] | (bytes[c * 4 + 1] << 8);
            if (d & 0x8000) d -= 0x10000;
            prev += d;
            B.h[k] = prev; B.mat[k] = bytes[c * 4 + 2]; B.flags[k] = bytes[c * 4 + 3] | F_EXPLORED;
            B.count++;
          }
        } else k += run;
        e ^= 1;
      }
      B.version++;
    });
  }
}

export function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

export function fromBase64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
