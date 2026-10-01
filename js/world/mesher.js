// Chunk mesher: turns hex columns into renderable geometry.
// A chunk at LOD level L covers 32x32 lattice cells with spacing 2^L.
// Produces: terrain (hex tops, ceilings, exposed side faces), water surfaces,
// river waterfall curtains, foliage/decor (vegetation rules per layer and
// biome, plan decor), and for LOD 0 the column spans used for collision.
import { ColumnData, BOTTOM, CF } from './column.js';
import { MeshBuffer, Xform, emitTemplate } from './geomkit.js';
import { HEX_W, HEX_R, ROW_H, DIRS, CORNERS, DIR_NORMALS } from '../core/hex.js';
import { M, MATERIALS, isGrassy } from './materials.js';
import { hash32 } from '../core/rng.js';
import { clamp, smoothstep, mixRGB } from '../core/mathutil.js';
import { Z_EYE, Z_BOWL, Z_CITY, Z_COUNTRY, Z_SEA } from './field.js';
import { LAYER_BOUNDARIES } from './layers.js';
import { SpatialGrid } from './spatial.js';

export const CHUNK = 32;
const MARGIN = 1;

const h01 = (a, b, c, d = 0) => hash32(a, b, c, d) / 4294967296;

export class ChunkMesher {
  constructor(gen, flora, plan) {
    this.gen = gen;
    this.flora = flora;
    this.plan = plan;
    this.p = plan.params;
    this.pal = plan.params.palette;
    this.seed = plan.params.seed;
    this.col = new ColumnData();
    const W = CHUNK + MARGIN * 2;
    this.W = W;
    this.cols = new Array(W * W);
    for (let i = 0; i < W * W; i++) this.cols[i] = { n: 0, y0: new Float32Array(24), y1: new Float32Array(24), top: new Uint8Array(24), side: new Uint8Array(24), bot: new Uint8Array(24), exp: new Float32Array(24), nw: 0, wl: new Float32Array(4), wsp: new Int8Array(4), wkind: new Uint8Array(4), wfx: new Float32Array(4), wfz: new Float32Array(4), zone: 0, flags: 0, biome: 0, galU: 0, x: 0, z: 0 };
    // decor index
    this.decorGrid = new SpatialGrid(32);
    const decor = plan.city?.decor || [];
    decor.forEach((d, i) => this.decorGrid.insertCircle(d.x, d.z, 1, i));
    this.decor = decor;
    this._xf = new Xform();
  }

  /** Copy a column result into chunk storage (coarser vertical steps at far LODs). */
  store(slot, c, x, z, L = 0) {
    const s = this.cols[slot];
    const qv = L >= 2 ? 0.5 * (1 << (L - 1)) : 0;
    let n = 0;
    for (let k = 0; k < c.n; k++) {
      let a = c.y0[k], b = c.y1[k];
      if (qv) {
        a = Math.round(a / qv) * qv; b = Math.round(b / qv) * qv;
        if (n > 0 && a < s.y1[n - 1]) a = s.y1[n - 1];
        if (b - a < qv * 0.5) continue;
      }
      s.y0[n] = a; s.y1[n] = b; s.top[n] = c.top[k]; s.side[n] = c.side[k]; s.bot[n] = c.bot[k]; s.exp[n] = c.exp[k];
      n++;
    }
    s.n = n;
    s.nw = c.nw;
    for (let k = 0; k < c.nw; k++) { s.wl[k] = c.wl[k]; s.wsp[k] = c.wsp[k]; s.wkind[k] = c.wkind[k]; s.wfx[k] = c.wfx[k]; s.wfz[k] = c.wfz[k]; }
    s.zone = c.zone; s.flags = c.flags; s.biome = c.biome; s.galU = c.galU; s.x = x; s.z = z;
  }

  build(L, cq, cr) {
    const step = 1 << L;
    const N = CHUNK, W = this.W;
    const q0 = cq * N * step, r0 = cr * N * step;
    const gen = this.gen, col = this.col;
    let anyTop = -Infinity, anyBot = Infinity;
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        const q = q0 + (i - MARGIN) * step, r = r0 + (j - MARGIN) * step;
        const x = (q + r * 0.5) * HEX_W, z = r * ROW_H;
        gen.column(x, z, L, col);
        this.store(j * W + i, col, x, z, L);
        if (col.n) { anyTop = Math.max(anyTop, col.y1[col.n - 1]); anyBot = Math.min(anyBot, col.y0[0]); }
      }
    }
    const terrain = new MeshBuffer(16384);
    const water = new MeshBuffer(2048);
    const falls = new MeshBuffer(256);
    const foliage = new MeshBuffer(L === 0 ? 16384 : 2048, true);
    const colliders = [];
    this.meshTerrain(L, step, terrain);
    this.meshWater(L, step, water, falls);
    if (L <= 1) this.vegetateColumns(L, step, foliage);
    if (L <= 3) this.placeFeatures(L, step, q0, r0, foliage, colliders);
    if (L <= 1) this.placeDecor(L, step, q0, r0, foliage);
    const out = {
      L, cq, cr,
      terrain: terrain.export(), water: water.export(), falls: falls.export(), foliage: foliage.export(),
      colliders,
    };
    if (L === 0) out.spans = this.exportSpans(q0, r0);
    return out;
  }

  exportSpans(q0, r0) {
    const N = CHUNK, W = this.W;
    let total = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) total += this.cols[(j + MARGIN) * W + i + MARGIN].n;
    const start = new Uint32Array(N * N + 1);
    const y = new Float32Array(total * 2);
    const mat = new Uint8Array(total * 2);
    const water = new Float32Array(N * N).fill(NaN);
    const flags = new Uint16Array(N * N);
    let o = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = this.cols[(j + MARGIN) * W + i + MARGIN];
        const k = j * N + i;
        start[k] = o;
        for (let s = 0; s < c.n; s++) { y[o * 2] = c.y0[s]; y[o * 2 + 1] = c.y1[s]; mat[o * 2] = c.top[s]; mat[o * 2 + 1] = c.side[s]; o++; }
        if (c.nw) water[k] = c.wl[c.nw - 1];
        flags[k] = c.flags;
      }
    }
    start[N * N] = o;
    return { q0, r0, start, y, mat, water, flags };
  }

  // ---------------------------------------------------------------- colours
  rockColor(y, h, out) {
    const pal = this.pal;
    let base;
    if (y > -60) base = pal[M.ROCK];
    else if (y > LAYER_BOUNDARIES.layer2Top) base = mixRGB(pal[M.ROCK], pal[M.SHAFTROCK], smoothstep(-60, LAYER_BOUNDARIES.layer2Top, y));
    else if (y > -870) base = mixRGB(pal[M.SHAFTROCK], pal[M.DARKROCK], smoothstep(-350, -700, y) * 0.6);
    else base = mixRGB(pal[M.SHAFTROCK], pal[M.BASALT], smoothstep(-870, -940, y));
    const l = 0.97 + (h - 0.5) * 0.06;
    out[0] = base[0] * l; out[1] = base[1] * l; out[2] = base[2] * l;
    return out;
  }

  topColor(mat, c, y, h, steep, out) {
    const pal = this.pal;
    let m = mat;
    if (steep >= 2 && isGrassy(m) && m !== M.FIELD) m = steep >= 4 ? M.ROCK : M.DIRT;
    if (MATERIALS[m] && MATERIALS[m].natural && (m === M.ROCK || m === M.SHAFTROCK || m === M.DARKROCK)) {
      this.rockColor(y, h, out);
      out[0] *= 1.08; out[1] *= 1.08; out[2] *= 1.08;
      return m;
    }
    const base = pal[m] || [1, 0, 1];
    const v = 0.93 + h * 0.14;
    out[0] = base[0] * v; out[1] = base[1] * v; out[2] = base[2] * v;
    if (m === M.GRASS || m === M.MEADOW) {
      // subtle biome tint and sun bleaching on higher ground
      const b = c.biome;
      out[0] += b * 0.04 + 0.02; out[1] += b * 0.02; out[2] -= b * 0.03;
      if (c.zone === Z_BOWL && y < -150) { out[0] *= 0.94; out[2] *= 1.04; }
    }
    if (m === M.FIELD) {
      const stripe = Math.floor((c.x * 0.7 + c.z * 0.3) / 2) & 1;
      if (stripe) { out[0] *= 0.88; out[1] *= 0.95; }
    }
    return m;
  }

  // ---------------------------------------------------------------- terrain
  meshTerrain(L, step, buf) {
    const N = CHUNK, W = this.W;
    const R = HEX_R * step;
    const seed = this.seed;
    const tmp = [0, 0, 0], tmp2 = [0, 0, 0];
    const skirt = L > 0 ? step * 3 : 0;
    const cornerAO = new Float32Array(6);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = this.cols[(j + MARGIN) * W + i + MARGIN];
        if (!c.n) continue;
        const cx = c.x, cz = c.z;
        const h = h01(seed, Math.round(cx * 2), Math.round(cz * 2), 5);
        const nbs = [];
        for (let d = 0; d < 6; d++) nbs.push(this.cols[(j + MARGIN + DIRS[d][1]) * W + i + MARGIN + DIRS[d][0]]);
        const border = i === 0 || j === 0 || i === N - 1 || j === N - 1;
        for (let k = 0; k < c.n; k++) {
          const y0 = c.y0[k], y1 = c.y1[k];
          const topExposed = k === c.n - 1 || c.y0[k + 1] > y1 + 0.01;
          const botExposed = k > 0 ? c.y1[k - 1] < y0 - 0.01 : y0 > BOTTOM + 2;
          const flag = MATERIALS[c.top[k]] ? MATERIALS[c.top[k]].flag : 0;
          // ---- top face
          if (topExposed) {
            // steepness: how much neighbours drop around this top
            let steep = 0;
            for (let d = 0; d < 6; d++) {
              const nb = nbs[d];
              const nt = this.nearestTop(nb, y1);
              if (nt < y1 - 1.6 * step) steep++;
            }
            // ambient occlusion at corners: neighbours rising above this top
            for (let kk = 0; kk < 6; kk++) {
              let occ = 0;
              for (const d of [(kk + 5) % 6, kk]) if (this.solidAt(nbs[d], y1 + 0.3 * step, y1 + 1.2 * step)) occ++;
              cornerAO[kk] = 1 - occ * 0.2;
            }
            const m = this.topColor(c.top[k], c, y1, h, steep, tmp);
            const emi = flag === 3 ? 0.6 : flag === 4 ? 0.35 : 0;
            const ex = c.exp[k];
            buf.grow(6, 12);
            const ci = buf.n;
            for (let kk = 0; kk < 6; kk++) {
              buf.v(cx + CORNERS[kk][0] * step, y1, cz + CORNERS[kk][1] * step, 0, 1, 0, tmp[0], tmp[1], tmp[2], ex, cornerAO[kk], emi, flag);
            }
            buf.tri(ci, ci + 2, ci + 1); buf.tri(ci, ci + 3, ci + 2); buf.tri(ci, ci + 5, ci + 3); buf.tri(ci + 3, ci + 5, ci + 4);
            void m;
          }
          // ---- bottom face (ceiling)
          if (botExposed) {
            const bm = c.bot[k];
            if (MATERIALS[bm] && MATERIALS[bm].natural) this.rockColor(y0, h, tmp); else { const b = this.pal[bm] || this.pal[M.ROCK]; tmp[0] = b[0]; tmp[1] = b[1]; tmp[2] = b[2]; }
            const ex = k > 0 ? c.exp[k - 1] : 0.3;
            buf.grow(6, 12);
            const ci = buf.n;
            const bflag = MATERIALS[bm] && MATERIALS[bm].natural ? 5 : 0;
            for (let kk = 0; kk < 6; kk++) buf.v(cx + CORNERS[kk][0] * step, y0, cz + CORNERS[kk][1] * step, 0, -1, 0, tmp[0] * 0.78, tmp[1] * 0.78, tmp[2] * 0.78, ex * 0.6, 0.85, 0, bflag);
            buf.tri(ci, ci + 1, ci + 2); buf.tri(ci, ci + 2, ci + 3); buf.tri(ci, ci + 3, ci + 5); buf.tri(ci + 3, ci + 4, ci + 5);
          }
          // ---- side faces
          for (let d = 0; d < 6; d++) {
            const nb = nbs[d];
            const outside = border && (i + DIRS[d][0] < 0 || j + DIRS[d][1] < 0 || i + DIRS[d][0] >= N || j + DIRS[d][1] >= N);
            this.emitSides(buf, c, k, nb, d, cx, cz, step, h, outside ? skirt : 0, tmp, tmp2);
          }
        }
      }
    }
  }

  nearestTop(c, y) {
    // the top of the neighbour floor closest to y (for steepness)
    let best = -Infinity;
    for (let k = 0; k < c.n; k++) if (c.y1[k] <= y + 0.6 && c.y1[k] > best) best = c.y1[k];
    return best;
  }

  solidAt(c, a, b) {
    for (let k = 0; k < c.n; k++) if (c.y0[k] < b && c.y1[k] > a) return true;
    return false;
  }

  emitSides(buf, c, k, nb, d, cx, cz, step, h, skirt, col, col2) {
    const a = c.y0[k];
    const b = c.y1[k];
    // exposed intervals = [a, b] minus neighbour spans (shrunk by skirt at their tops)
    let cur = a;
    const segs = this._segs || (this._segs = []);
    segs.length = 0;
    for (let m = 0; m < nb.n && cur < b; m++) {
      const n0 = nb.y0[m], n1 = nb.y1[m] - skirt;
      if (n1 <= cur) continue;
      if (n0 >= b) break;
      if (n0 > cur) segs.push(cur, Math.min(n0, b));
      cur = Math.max(cur, n1);
    }
    if (cur < b) segs.push(cur, b);
    if (!segs.length) return;
    const k0 = d, k1 = (d + 1) % 6;
    const x0 = cx + CORNERS[k0][0] * step, z0 = cz + CORNERS[k0][1] * step;
    const x1 = cx + CORNERS[k1][0] * step, z1 = cz + CORNERS[k1][1] * step;
    const nx = DIR_NORMALS[d][0], nz = DIR_NORMALS[d][1];
    const sideMat = c.side[k];
    const natural = MATERIALS[sideMat] ? MATERIALS[sideMat].natural : false;
    const topMat = c.top[k];
    const grassy = isGrassy(topMat) && topMat !== M.FIELD;
    let flag = MATERIALS[sideMat] ? MATERIALS[sideMat].flag : 0;
    if (natural && !flag && sideMat !== M.STONEPLAIN) flag = 5; // shader strata
    const emi = flag === 3 ? 0.5 : 0;
    // light exposure of the neighbouring air
    for (let s = 0; s < segs.length; s += 2) {
      const sa = segs[s], sb = segs[s + 1];
      const mid = (sa + sb) / 2;
      let ex = 1;
      for (let m = nb.n - 1; m >= 0; m--) if (nb.y1[m] <= mid) { ex = nb.exp[m]; break; }
      if (nb.n && mid < nb.y0[0]) ex = 0.2;
      // split into bands so colours/lighting vary with height
      const cuts = [sa];
      if (natural && grassy) { if (b - 0.35 > sa && b - 0.35 < sb) cuts.push(b - 0.35); if (b - 1.6 > sa && b - 1.6 < sb) cuts.push(b - 1.6); }
      // strata are coloured in the shader; only split very tall faces for depth tint
      const maxSeg = natural ? 60 : 12;
      let t = cuts[cuts.length - 1];
      while (t + maxSeg < sb) { t += maxSeg; cuts.push(t); }
      cuts.push(sb);
      cuts.sort((p, q) => p - q);
      for (let ci = 0; ci < cuts.length - 1; ci++) {
        const ya = cuts[ci], yb = cuts[ci + 1];
        if (yb - ya < 0.01) continue;
        this.sideColor(sideMat, natural, grassy, b, ya + 0.01, h, col);
        this.sideColor(sideMat, natural, grassy, b, yb - 0.01, h, col2);
        const aoB = ya <= sa + 0.01 && sa > a ? 0.7 : 0.95;
        buf.grow(4, 6);
        const v0 = buf.v(x0, ya, z0, nx, 0, nz, col[0], col[1], col[2], ex, aoB, emi, flag);
        buf.v(x1, ya, z1, nx, 0, nz, col[0], col[1], col[2], ex, aoB, emi, flag);
        buf.v(x1, yb, z1, nx, 0, nz, col2[0], col2[1], col2[2], ex, 1, emi, flag);
        buf.v(x0, yb, z0, nx, 0, nz, col2[0], col2[1], col2[2], ex, 1, emi, flag);
        buf.tri(v0, v0 + 2, v0 + 1);
        buf.tri(v0, v0 + 3, v0 + 2);
      }
    }
  }

  sideColor(mat, natural, grassy, top, y, h, out) {
    const pal = this.pal;
    if (natural) {
      if (grassy && y > top - 0.35) { const g = pal[M.GRASS]; out[0] = g[0] * 0.8; out[1] = g[1] * 0.8; out[2] = g[2] * 0.8; return; }
      if (grassy && y > top - 1.6) { const g = pal[M.DIRT]; out[0] = g[0]; out[1] = g[1]; out[2] = g[2]; return; }
      if (mat === M.STONEPLAIN) { const g = pal[M.STONEPLAIN]; out[0] = g[0] * 0.85; out[1] = g[1] * 0.85; out[2] = g[2] * 0.85; return; }
      if (mat === M.BASALT) { const g = pal[M.BASALT]; out[0] = g[0]; out[1] = g[1]; out[2] = g[2]; return; }
      this.rockColor(y, h, out);
      return;
    }
    const b = pal[mat] || pal[M.ROCK];
    const v = 0.88 + h * 0.08;
    out[0] = b[0] * v; out[1] = b[1] * v; out[2] = b[2] * v;
  }

  // ---------------------------------------------------------------- water
  meshWater(L, step, buf, falls) {
    const N = CHUNK, W = this.W;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = this.cols[(j + MARGIN) * W + i + MARGIN];
        if (!c.nw) continue;
        for (let w = 0; w < c.nw; w++) {
          const Lw = c.wl[w];
          const floorY = c.y1[c.wsp[w]];
          const depth = clamp((Lw - floorY) / 4, 0, 1);
          // corner heights averaged with neighbouring water at a similar level
          const nbL = [];
          for (let d = 0; d < 6; d++) {
            const nb = this.cols[(j + MARGIN + DIRS[d][1]) * W + i + MARGIN + DIRS[d][0]];
            let lv = NaN;
            for (let q = 0; q < nb.nw; q++) if (Math.abs(nb.wl[q] - Lw) < 0.9) { lv = nb.wl[q]; break; }
            nbL.push(lv);
            // waterfall curtain toward a lower water neighbour
            if (Number.isNaN(lv)) {
              for (let q = 0; q < nb.nw; q++) {
                const drop = Lw - nb.wl[q];
                if (drop > 0.9 && drop < 60 && c.wkind[w] === 1) this.emitFall(falls, c, d, step, Lw, nb.wl[q]);
              }
            }
          }
          const fx = c.wfx[w], fz = c.wfz[w];
          const kind = c.wkind[w];
          buf.grow(7, 18);
          const ci = buf.v(c.x, Lw, c.z, 0, 1, 0, fx * 0.5 + 0.5, fz * 0.5 + 0.5, depth, depth, kind / 3, 0, 0);
          for (let k = 0; k < 6; k++) {
            const a = nbL[(k + 5) % 6], b = nbL[k];
            let s = Lw, n = 1;
            if (!Number.isNaN(a)) { s += a; n++; }
            if (!Number.isNaN(b)) { s += b; n++; }
            const edge = Number.isNaN(a) || Number.isNaN(b) ? 1 : 0;
            buf.v(c.x + CORNERS[k][0] * step * 1.02, s / n, c.z + CORNERS[k][1] * step * 1.02, 0, 1, 0, fx * 0.5 + 0.5, fz * 0.5 + 0.5, depth * (edge ? 0.5 : 1), depth, kind / 3, edge, 0);
          }
          for (let k = 0; k < 6; k++) buf.tri(ci, ci + 1 + ((k + 1) % 6), ci + 1 + k);
        }
      }
    }
  }

  emitFall(falls, c, d, step, top, bottom) {
    const k0 = d, k1 = (d + 1) % 6;
    const x0 = c.x + CORNERS[k0][0] * step, z0 = c.z + CORNERS[k0][1] * step;
    const x1 = c.x + CORNERS[k1][0] * step, z1 = c.z + CORNERS[k1][1] * step;
    const nx = DIR_NORMALS[d][0], nz = DIR_NORMALS[d][1];
    const off = 0.05;
    falls.grow(4, 6);
    // colour channels carry: r = u along edge, g = fall height (scaled), b = unused
    const hgt = clamp((top - bottom) / 64, 0, 1);
    const v0 = falls.v(x0 + nx * off, top + 0.02, z0 + nz * off, nx, 0, nz, 0, hgt, 0, 1, 0, 0, 0);
    falls.v(x1 + nx * off, top + 0.02, z1 + nz * off, nx, 0, nz, 1, hgt, 0, 1, 0, 0, 0);
    falls.v(x1 + nx * off, bottom, z1 + nz * off, nx, 0, nz, 1, hgt, 0, 1, 1, 0, 0);
    falls.v(x0 + nx * off, bottom, z0 + nz * off, nx, 0, nz, 0, hgt, 0, 1, 1, 0, 0);
    falls.tri(v0, v0 + 2, v0 + 1);
    falls.tri(v0, v0 + 3, v0 + 2);
  }

  // ---------------------------------------------------------------- vegetation
  vegetateColumns(L, step, buf) {
    const N = CHUNK, W = this.W, F = this.flora, seed = this.seed;
    const xf = this._xf;
    const pal = this.pal;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = this.cols[(j + MARGIN) * W + i + MARGIN];
        if (!c.n) continue;
        const qx = Math.round(c.x * 4), qz = Math.round(c.z * 4);
        for (let k = 0; k < c.n; k++) {
          const top = c.y1[k];
          const above = k + 1 < c.n ? c.y0[k + 1] : Infinity;
          const gap = above - top;
          if (gap < 1.5) continue;
          // skip if water covers this floor
          let wet = false;
          for (let w = 0; w < c.nw; w++) if (c.wsp[w] === k) wet = true;
          const mat = c.top[k];
          const ex = c.exp[k];
          const r1 = h01(seed, qx, qz, k * 7 + 1), r2 = h01(seed, qx, qz, k * 7 + 2), r3 = h01(seed, qx, qz, k * 7 + 3);
          const ox = (r2 - 0.5) * 0.7 * step, oz = (r3 - 0.5) * 0.7 * step;
          const yaw = r1 * 6.283;
          const gallery = (c.flags & (CF.GALLERY0 | CF.GALLERY1 | CF.GALLERY2)) !== 0 && k < c.n - 1;
          const deep = top < LAYER_BOUNDARIES.layer2Top;
          // ceiling vegetation (vines) hanging from the span above
          if (above < Infinity && gap > 4 && (gallery || (c.flags & CF.CAVE) || deep) && r1 < (gallery ? 0.05 : 0.012) * step) {
            const len = Math.min(gap - 1.5, 2 + r2 * (gallery ? 12 : 5));
            xf.set(c.x + ox, above, c.z + oz, yaw, 1, len, 1);
            emitTemplate(buf, F.vines[Math.floor(r3 * F.vines.length)], xf, [1, 1, 1], Math.max(0.2, ex), 1, 1);
          }
          if (wet) {
            if ((c.flags & CF.LAKE) === 0 && (c.flags & CF.RIVER) === 0) continue;
            continue;
          }
          const steepSkip = false;
          void steepSkip;
          if (c.flags & CF.ROUTE) {
            if (r1 < 0.02 && (mat === M.PATH || mat === M.GRAVEL)) { xf.set(c.x + ox, top, c.z + oz, yaw, 0.4, 0.4, 0.4); emitTemplate(buf, F.rocks[0], xf, [1, 1, 1], ex, 1); }
            continue;
          }
          if (c.flags & CF.BUILDING) continue;
          const lod1 = L === 1;
          if (mat === M.GRASS || mat === M.MEADOW) {
            const meadow = mat === M.MEADOW;
            const dens = (meadow ? 0.85 : 0.6) * (lod1 ? 0.12 : 1);
            if (r1 < dens) {
              const T = meadow ? F.meadow : F.grass;
              const s = (0.8 + r2 * 0.6) * (lod1 ? 2 : 1);
              xf.set(c.x + ox, top, c.z + oz, yaw, s, s * (0.8 + r3 * 0.5), s);
              emitTemplate(buf, T[Math.floor(r2 * T.length)], xf, [1, 1, 1], ex, 1, 1);
            }
            if (!lod1 && r2 < (meadow ? 0.07 : 0.025)) {
              xf.set(c.x - ox, top, c.z - oz, yaw, 1, 1, 1);
              emitTemplate(buf, F.flowers[Math.floor(r3 * F.flowers.length)], xf, [1, 1, 1], ex, 1, 1);
            }
            const shrubP = c.zone === Z_BOWL ? 0.012 : (c.flags & CF.PARK) ? 0.03 : c.zone === Z_COUNTRY ? 0.012 : 0.006;
            if (r3 < shrubP * (lod1 ? 2 : 1)) {
              const s = 0.8 + r1 * 0.9;
              xf.set(c.x, top - 0.1, c.z, yaw, s, s, s);
              emitTemplate(buf, F.shrubs[Math.floor(r2 * F.shrubs.length)], xf, [1, 1, 1], ex, 1, 1);
            }
          } else if (mat === M.MOSS || mat === M.LITTER) {
            const dim = ex < 0.45;
            if (r1 < 0.45 * (lod1 ? 0.15 : 1)) {
              xf.set(c.x + ox, top, c.z + oz, yaw, 1, 1, 1);
              emitTemplate(buf, F.moss[Math.floor(r2 * F.moss.length)], xf, [1, 1, 1], ex, 1, 1);
            }
            if (r2 < 0.07 * (lod1 ? 0.5 : 1)) {
              const s = 0.9 + r3 * 0.9;
              xf.set(c.x - ox, top, c.z - oz, yaw, s, s, s);
              emitTemplate(buf, F.ferns[Math.floor(r1 * F.ferns.length)], xf, [1, 1, 1], ex, 1, 1);
            } else if (r2 < 0.095) {
              const s = 0.7 + r3 * 0.8;
              xf.set(c.x, top - 0.1, c.z, yaw, s, s, s);
              emitTemplate(buf, F.berry[Math.floor(r1 * F.berry.length)], xf, [1, 1, 1], ex, 1, 1);
            } else if (r2 < (dim ? 0.14 : 0.11)) {
              xf.set(c.x + oz, top, c.z + ox, yaw, 1, 1, 1);
              const T = dim ? F.glowMush : F.mush;
              emitTemplate(buf, T[Math.floor(r1 * T.length)], xf, [1, 1, 1], ex, 1, 1);
            }
          } else if (mat === M.FIELD) {
            if (r1 < 0.9 * (lod1 ? 0.2 : 1)) {
              xf.set(c.x + ox * 0.3, top, c.z + oz * 0.3, 0.3, 1, 1, 1);
              emitTemplate(buf, F.crops[Math.floor(r2 * F.crops.length)], xf, [1, 1, 1], ex, 1, 1);
            }
          } else if (mat === M.SAND || mat === M.CLAY) {
            if ((c.flags & CF.SHORE) && r1 < 0.22) {
              xf.set(c.x + ox, top, c.z + oz, yaw, 1, 1, 1);
              emitTemplate(buf, F.reeds[Math.floor(r2 * F.reeds.length)], xf, [1, 1, 1], ex, 1, 1);
            }
          } else if (mat === M.STONEPLAIN) {
            if (r1 < 0.04) {
              xf.set(c.x + ox, top, c.z + oz, yaw, 0.8, 0.6, 0.8);
              emitTemplate(buf, F.moss[Math.floor(r2 * F.moss.length)], xf, [1.1, 1.05, 0.95], ex, 1, 1);
            } else if (r1 < 0.05) {
              const s = 0.5 + r2;
              xf.set(c.x, top - 0.2, c.z, yaw, s, s, s);
              emitTemplate(buf, F.rocks[Math.floor(r3 * F.rocks.length)], xf, [1.25, 1.2, 1.1], ex, 1, 0);
            } else if (r1 < 0.056) {
              xf.set(c.x, top - 0.1, c.z, yaw, 1, 1, 1);
              emitTemplate(buf, F.shrubs[Math.floor(r3 * F.shrubs.length)], xf, [0.9, 1.05, 1.1], ex, 1, 1);
            }
          } else if (mat === M.ROCK || mat === M.GRAVEL || mat === M.SHAFTROCK || mat === M.DARKROCK) {
            if (r1 < 0.02) {
              const s = 0.4 + r2 * 0.9;
              xf.set(c.x + ox, top - 0.15, c.z + oz, yaw, s, s, s);
              emitTemplate(buf, F.rocks[Math.floor(r3 * F.rocks.length)], xf, [1, 1, 1], ex, 1, 0);
            } else if (r1 < 0.05 && top > LAYER_BOUNDARIES.layer2Top) {
              xf.set(c.x + ox, top, c.z + oz, yaw, 0.8, 0.6, 0.8);
              emitTemplate(buf, F.grass[Math.floor(r2 * F.grass.length)], xf, [0.9, 0.95, 0.8], ex, 1, 1);
            }
          } else if (mat === M.CRYSTAL || mat === M.FUNGUS) {
            // nothing extra
          }
        }
      }
    }
    void pal; void Z_CITY; void Z_SEA; void Z_EYE;
  }

  /**
   * World-space jittered-grid features (trees, inverted trees, cliff trees).
   * Independent of LOD so the same trees appear at every distance.
   */
  placeFeatures(L, step, q0, r0, buf, colliders) {
    const F = this.flora, seed = this.seed, gen = this.gen, col = this.col;
    const xf = this._xf;
    const x0 = (q0 + r0 * 0.5) * HEX_W, z0 = r0 * ROW_H;
    const span = CHUNK * step;
    // chunk parallelogram corners -> bounding box
    const xs = [x0, x0 + span, x0 + span * 0.5, x0 + span * 1.5];
    const zs = [z0, z0, z0 + span * ROW_H, z0 + span * ROW_H];
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const inChunk = (x, z) => {
      const rf = z / ROW_H, qf = x / HEX_W - rf * 0.5;
      return qf >= q0 - 0.5 * step && qf < q0 + span - 0.5 * step && rf >= r0 - 0.5 * step && rf < r0 + span - 0.5 * step;
    };
    const G = 14;
    const gi0 = Math.floor(minX / G), gi1 = Math.floor(maxX / G), gj0 = Math.floor(minZ / G), gj1 = Math.floor(maxZ / G);
    const P = {};
    for (let gj = gj0; gj <= gj1; gj++) {
      for (let gi = gi0; gi <= gi1; gi++) {
        const a = h01(seed, gi, gj, 901), b = h01(seed, gi, gj, 902), cc = h01(seed, gi, gj, 903);
        const x = (gi + 0.1 + a * 0.8) * G, z = (gj + 0.1 + b * 0.8) * G;
        if (!inChunk(x, z)) continue;
        gen.field.polar(x, z, P);
        // quick reject: features only exist in certain zones
        const nearShaft = P.r < P.Rb + 20;
        const bowlTrees = P.zone === Z_BOWL;
        const countryTrees = P.zone === Z_COUNTRY || P.zone === Z_CITY;
        if (!nearShaft && !bowlTrees && !countryTrees) continue;
        gen.column(x, z, 0, col);
        // inverted trees in galleries
        if (col.flags & (CF.GALLERY0 | CF.GALLERY1 | CF.GALLERY2)) {
          const g = this.p.galleries;
          for (let k = 0; k < col.n - 1; k++) {
            const fl = col.y1[k], ce = col.y0[k + 1];
            const gap = ce - fl;
            if (gap < 22 || ce > LAYER_BOUNDARIES.layer2Top + 10) continue;
            const tier = g.findIndex((gg) => ce <= gg.yTop + 15 && fl >= gg.yTop - gg.height - 25);
            if (tier < 0) continue;
            const dens = g[tier].forest * (col.galU < 0.85 ? 0.75 : 0.3);
            if (cc > dens) continue;
            const len = gap * (0.35 + h01(seed, gi, gj, 904) * 0.35);
            const T = L <= 1 ? F.inv : F.invLow;
            const tpl = T[Math.floor(h01(seed, gi, gj, 905) * T.length)];
            const yaw = a * 6.283;
            xf.set(x, ce + 0.5, z, yaw, len * 0.9, len, len * 0.9);
            emitTemplate(buf, tpl, xf, [1, 1, 1], Math.max(0.25, col.exp[k]), 1, 0.6);
            if (L === 0) colliders.push({ t: 'cyl', x, z, r: Math.max(0.4, len * 0.05), y0: ce - len * 0.75, y1: ce + 1 });
            break;
          }
          continue;
        }
        // cliff trees on the shaft walls (Layer 2 band)
        if (nearShaft && P.r > P.Re - 3 && P.r < P.Re + 6) {
          if (cc < 0.32) {
            // find a wall face height in layer 2 where the column is solid and the eye side is open
            const y = LAYER_BOUNDARIES.layer2Top - 20 - h01(seed, gi, gj, 906) * 480;
            const si = col.spanAt(y);
            if (si >= 0) {
              const ang = Math.atan2(-P.wz, -P.wx);
              const s = 1.5 + h01(seed, gi, gj, 907) * 2.5;
              const T = L <= 1 ? F.cliff : F.cliffLow;
              const tpl = T[Math.floor(a * T.length)];
              // place at the wall surface: step inward until outside the rock
              let px = x, pz = z;
              for (let t = 0; t < 12; t++) {
                gen.column(px, pz, 0, col);
                if (col.spanAt(y) < 0) break;
                px += Math.cos(ang) * 1; pz += Math.sin(ang) * 1;
              }
              xf.set(px - Math.cos(ang) * 0.8, y, pz - Math.sin(ang) * 0.8, -ang, s, s, s);
              emitTemplate(buf, tpl, xf, [1, 1, 1], 0.7, 1, 0.5);
              if (L === 0) colliders.push({ t: 'cap', ax: px - Math.cos(ang) * 0.5, ay: y, az: pz - Math.sin(ang) * 0.5, bx: px + Math.cos(ang) * 2.5 * s, by: y, bz: pz + Math.sin(ang) * 2.5 * s, r: 0.4 * s });
            }
          }
          continue;
        }
        // upright trees: stone plain, parks/countryside forests, sparse in the bowl
        const top = col.y1[col.n - 1];
        const tmat = col.top[col.n - 1];
        let floorY = top, floorMat = tmat, floorExp = 1;
        if (nearShaft && P.r < P.Rb && top < -700) { floorY = top; }
        if ((col.flags & (CF.ROUTE | CF.BUILDING | CF.RIVER | CF.LAKE | CF.POOL)) || col.nw) continue;
        let tpl = null, s = 1, tint = [1, 1, 1];
        const r4 = h01(seed, gi, gj, 908);
        if (floorMat === M.STONEPLAIN && floorY < -700) {
          if (cc < 0.08) { tpl = (L <= 1 ? F.pale : F.pale)[Math.floor(r4 * F.pale.length)]; s = 0.9 + a * 0.6; }
        } else if (floorMat === M.GRASS || floorMat === M.MEADOW) {
          let dens = 0;
          if (P.zone === Z_COUNTRY) dens = smoothstep(0.1, 0.5, col.biome) * 0.55 + 0.04;
          else if (P.zone === Z_CITY) dens = (col.flags & CF.PARK) ? 0.5 : 0.02;
          else if (P.zone === Z_BOWL) dens = 0.035 + smoothstep(0.3, 0.6, col.biome) * 0.12;
          if (cc < dens) {
            const conif = P.zone === Z_COUNTRY && r4 < 0.4;
            const T = L >= 2 ? F.treesLow : conif ? F.conifers : F.trees;
            tpl = T[Math.floor(r4 * T.length)];
            s = 0.8 + a * 0.5;
          }
        } else if ((floorMat === M.MOSS || floorMat === M.LITTER) && cc < 0.1) {
          tpl = F.trees[Math.floor(r4 * F.trees.length)];
          tint = [0.8, 1.05, 1.1];
          s = 0.9 + a * 0.6;
        }
        if (!tpl) continue;
        xf.set(x, floorY, z, a * 6.283, s, s, s);
        emitTemplate(buf, tpl, xf, tint, floorExp, 1, 1);
        if (L === 0) colliders.push({ t: 'cyl', x, z, r: 0.3 * s, y0: floorY - 0.5, y1: floorY + 5 * s });
      }
    }
  }

  placeDecor(L, step, q0, r0, buf) {
    const F = this.flora;
    const xf = this._xf;
    const x0 = (q0 + r0 * 0.5) * HEX_W, z0 = r0 * ROW_H;
    const span = CHUNK * step;
    const seen = new Set();
    const inChunk = (x, z) => {
      const rf = z / ROW_H, qf = x / HEX_W - rf * 0.5;
      return qf >= q0 - 0.5 * step && qf < q0 + span - 0.5 * step && rf >= r0 - 0.5 * step && rf < r0 + span - 0.5 * step;
    };
    for (let zz = z0 - 32; zz <= z0 + span * ROW_H + 32; zz += 32) {
      for (let xx = x0 - 32; xx <= x0 + span * 1.5 + 32; xx += 32) {
        for (const id of this.decorGrid.query(xx, zz)) {
          if (seen.has(id)) continue;
          seen.add(id);
          const d = this.decor[id];
          if (!inChunk(d.x, d.z)) continue;
          if (L > 0 && d.type !== 'crane' && d.type !== 'flag' && d.type !== 'tent') continue;
          const D = F.decor;
          const yaw = d.rot || 0;
          let tpl = null;
          switch (d.type) {
            case 'lantern': tpl = D.lantern; break;
            case 'crates': tpl = D.crates[id % 2]; break;
            case 'barrels': tpl = D.barrels[id % 2]; break;
            case 'stall': tpl = D.stall[(d.variant || 0) % D.stall.length]; break;
            case 'telescope': tpl = D.telescope; break;
            case 'crane': tpl = D.crane; break;
            case 'tent': tpl = D.tent[id % 2]; break;
            case 'banner': tpl = D.banner; break;
            case 'flag': tpl = D.flag; break;
            case 'fountain': tpl = D.fountain; break;
            case 'anchor': tpl = D.anchor; break;
            case 'railing': {
              const t = F.railing(d.len || 4);
              const ox = d.off || 0;
              xf.set(d.x - Math.sin(yaw) * 0 + Math.cos(yaw) * 0, d.y, d.z, yaw, 1, 1, 1);
              emitTemplate(buf, t, xf, [1, 1, 1], 1, 1, 0);
              void ox;
              continue;
            }
            default: break;
          }
          if (!tpl) continue;
          xf.set(d.x, d.y, d.z, yaw, 1, 1, 1);
          emitTemplate(buf, tpl, xf, [1, 1, 1], 1, 1, 0.5);
        }
      }
    }
  }
}
