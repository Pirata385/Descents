// Hydrology on a coarse 8 m grid: priority-flood depression filling, lake
// detection with consistent water levels, flow accumulation and river
// extraction. Rivers get a fine water-level profile that only descends
// downstream, with waterfalls where the terrain drops sharply.
import { Z_EYE, Z_SEA, Z_BOWL, Z_CITY, Z_COUNTRY } from './field.js';
import { chaikin, resamplePolyline, clamp, smoothstep } from '../core/mathutil.js';

export const COARSE = { cs: 8, ox: -1500, oz: -1300, nx: 375, nz: 325 };

class MinHeap {
  constructor(cap) { this.idx = new Int32Array(cap); this.key = new Float64Array(cap); this.n = 0; }
  push(i, k) {
    let p = this.n++;
    this.idx[p] = i; this.key[p] = k;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (this.key[q] <= this.key[p]) break;
      this.swap(p, q); p = q;
    }
  }
  pop() {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n]; this.key[0] = this.key[this.n];
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < this.n && this.key[l] < this.key[m]) m = l;
        if (r < this.n && this.key[r] < this.key[m]) m = r;
        if (m === p) break;
        this.swap(p, m); p = m;
      }
    }
    return top;
  }
  swap(a, b) {
    const ti = this.idx[a]; this.idx[a] = this.idx[b]; this.idx[b] = ti;
    const tk = this.key[a]; this.key[a] = this.key[b]; this.key[b] = tk;
  }
}

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

/** Sample the macro surface on the coarse grid. */
export function buildCoarseGrid(field) {
  const { cs, ox, oz, nx, nz } = COARSE;
  const h = new Float32Array(nx * nz);
  const zone = new Uint8Array(nx * nz);
  const eyeDist = new Float32Array(nx * nz);
  const P = {}, S = {};
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = ox + (i + 0.5) * cs, z = oz + (j + 0.5) * cs;
      field.polar(x, z, P);
      const k = j * nx + i;
      zone[k] = P.zone;
      eyeDist[k] = P.r - P.Re;
      if (P.zone === Z_EYE) { h[k] = -9999; continue; }
      field.surface(x, z, P, S);
      h[k] = S.h;
      if (P.zone === Z_SEA && S.h < field.p.seaY + 0.5) zone[k] = Z_SEA;
      else if (P.zone === Z_SEA) zone[k] = Z_COUNTRY;
    }
  }
  return { ...COARSE, h, zone, eyeDist };
}

export function computeHydrology(field, coarse, rng) {
  const { cs, ox, oz, nx, nz, h, zone } = coarse;
  const N = nx * nz;
  const F = new Float32Array(N);
  const dir = new Int32Array(N).fill(-1);
  const visited = new Uint8Array(N);
  const order = new Int32Array(N);
  let on = 0;
  const heap = new MinHeap(N);
  const seaY = field.p.seaY;
  for (let k = 0; k < N; k++) {
    const i = k % nx, j = (k / nx) | 0;
    const edge = i === 0 || j === 0 || i === nx - 1 || j === nz - 1;
    if (zone[k] === Z_EYE || zone[k] === Z_SEA || edge) {
      visited[k] = 1;
      F[k] = zone[k] === Z_EYE ? -9999 : Math.min(h[k], seaY);
      heap.push(k, F[k]);
      order[on++] = k;
    }
  }
  while (heap.n > 0) {
    const c = heap.pop();
    const ci = c % nx, cj = (c / nx) | 0;
    for (const [di, dj] of N8) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const n = nj * nx + ni;
      if (visited[n]) continue;
      visited[n] = 1;
      F[n] = Math.max(h[n], F[c]);
      dir[n] = c;
      heap.push(n, F[n]);
      order[on++] = n;
    }
  }

  // Flow accumulation (rain weighted: the highlands catch more rain)
  const acc = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    if (zone[k] === Z_EYE || zone[k] === Z_SEA) continue;
    acc[k] = zone[k] === Z_BOWL ? 1 : 1.5;
  }
  for (let o = on - 1; o >= 0; o--) {
    const k = order[o];
    if (dir[k] >= 0) acc[dir[k]] += acc[k];
  }

  // Lakes: connected depression cells.
  const lakeId = new Int16Array(N);
  const lakes = [];
  const depthOf = (k) => F[k] - h[k];
  const comp = new Int32Array(N).fill(-1);
  let compCount = 0;
  const comps = [];
  for (let k = 0; k < N; k++) {
    if (comp[k] >= 0 || depthOf(k) < 0.35 || zone[k] === Z_EYE || zone[k] === Z_SEA) continue;
    const stack = [k];
    comp[k] = compCount;
    const cells = [];
    let maxD = 0, level = F[k], maxAcc = 0;
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      maxD = Math.max(maxD, depthOf(c));
      level = Math.max(level, F[c]);
      maxAcc = Math.max(maxAcc, acc[c]);
      const ci = c % nx, cj = (c / nx) | 0;
      for (let q = 0; q < 4; q++) {
        const ni = ci + N8[q][0], nj = cj + N8[q][1];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const n = nj * nx + ni;
        if (comp[n] >= 0 || depthOf(n) < 0.35 || zone[n] === Z_EYE || zone[n] === Z_SEA) continue;
        comp[n] = compCount;
        stack.push(n);
      }
    }
    comps.push({ cells, maxD, level, maxAcc });
    compCount++;
  }
  for (const c of comps) {
    const big = c.cells.length >= 6 && c.maxD >= 1.0;
    const fed = c.maxAcc > 600 && c.maxD >= 0.6 && c.cells.length >= 2;
    if (!(big || fed) || c.cells.length > 4000) continue;
    const id = lakes.length + 1;
    const level = Math.floor(c.level * 2) / 2 - 0.3;
    let sx = 0, sz = 0;
    for (const k of c.cells) {
      lakeId[k] = id;
      sx += ox + ((k % nx) + 0.5) * cs;
      sz += oz + (((k / nx) | 0) + 0.5) * cs;
    }
    lakes.push({ id, level, cells: c.cells.length, depth: c.maxD, x: sx / c.cells.length, z: sz / c.cells.length });
  }

  // Rivers
  const threshold = 1100;
  const isRiver = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const thr = zone[k] === Z_BOWL ? threshold : threshold * 0.55;
    if (acc[k] >= thr && !lakeId[k] && zone[k] !== Z_EYE && zone[k] !== Z_SEA) isRiver[k] = 1;
  }
  const upRiver = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (isRiver[k] && dir[k] >= 0 && isRiver[dir[k]]) upRiver[dir[k]]++;
  const owner = new Int32Array(N).fill(-1);
  const rawRivers = [];
  // process sources in descending accumulation order of their outlet so main stems are traced first
  const sources = [];
  for (let k = 0; k < N; k++) if (isRiver[k] && !upRiver[k]) sources.push(k);
  // A cell after a lake outlet whose upstream is a lake cell is also a source
  sources.sort((a, b) => acc[b] - acc[a]);
  for (const s of sources) {
    const pts = [];
    let k = s;
    // prepend lake outlet cell if fed by a lake
    let fromLake = 0;
    for (const [di, dj] of N8) {
      const ni = (s % nx) + di, nj = ((s / nx) | 0) + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const n = nj * nx + ni;
      if (lakeId[n] && dir[n] === s) { fromLake = lakeId[n]; pts.push(cellPt(n)); break; }
    }
    let end = 'none';
    let joinsRiver = -1;
    let guard = 0;
    while (k >= 0 && guard++ < 4000) {
      if (zone[k] === Z_EYE) { end = 'eye'; pts.push(cellPt(k)); break; }
      if (zone[k] === Z_SEA) { end = 'sea'; pts.push(cellPt(k)); break; }
      if (lakeId[k]) { end = 'lake'; pts.push(cellPt(k)); break; }
      if (owner[k] >= 0) { end = 'join'; joinsRiver = owner[k]; pts.push(cellPt(k)); break; }
      owner[k] = rawRivers.length;
      pts.push(cellPt(k));
      k = dir[k];
    }
    if (pts.length >= 4) rawRivers.push({ pts, end, joinsRiver, fromLake, endLake: end === 'lake' ? lakeId[k] : 0 });
  }

  function cellPt(k) {
    return [ox + ((k % nx) + 0.5) * cs, oz + (((k / nx) | 0) + 0.5) * cs, acc[k]];
  }

  return { F, dir, acc, lakeId, lakes, rawRivers };
}

/**
 * Turn raw coarse rivers into smooth polylines with water levels. Levels come
 * from the fine natural surface and never rise downstream.
 * Falls are recorded where the level drops abruptly.
 */
export function buildRivers(field, hydro, coarse) {
  const rivers = [];
  const eyeFalls = [];
  const P = {}, S = {};
  const lakesById = new Map(hydro.lakes.map((l) => [l.id, l]));
  for (const raw of hydro.rawRivers) {
    let pts = chaikin(raw.pts, 2);
    pts = resamplePolyline(pts, 3);
    if (pts.length < 3) continue;
    const xs = [], zs = [], levels = [], widths = [], falls = [];
    let level = Infinity;
    let endEye = false;
    for (let i = 0; i < pts.length; i++) {
      const [x, z, a] = pts[i];
      field.polar(x, z, P);
      if (P.zone === Z_EYE || P.r < P.Re + 1.5) { endEye = true; break; }
      field.surface(x, z, P, S);
      const w = clamp(2.2 + Math.sqrt(a) * 0.065, 2.6, 8);
      const depth = 0.7 + w * 0.12;
      const target = S.h - depth;
      if (i === 0) level = target;
      let fall = 0;
      if (target < level - 0.05) {
        if (level - target <= 1.0) level = target;
        else { fall = level - target; level = target; }
      }
      if (raw.endLake && i === pts.length - 1) {
        const lk = lakesById.get(raw.endLake);
        if (lk) level = Math.max(lk.level, Math.min(level, lk.level + 0.4));
      }
      xs.push(x); zs.push(z); levels.push(level); widths.push(w); falls.push(fall);
      if (raw.end === 'sea' && S.h < field.p.seaY + 0.5) break;
    }
    if (xs.length < 3) continue;
    // Upstream lake: river starts at lake level
    if (raw.fromLake) {
      const lk = lakesById.get(raw.fromLake);
      if (lk) for (let i = 0; i < Math.min(3, levels.length); i++) levels[i] = Math.min(levels[i], lk.level);
    }
    // Enforce monotonic non-increasing levels
    for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1]) levels[i] = levels[i - 1];
    const river = {
      id: rivers.length,
      x: Float32Array.from(xs), z: Float32Array.from(zs), level: Float32Array.from(levels),
      width: Float32Array.from(widths), fall: Float32Array.from(falls),
      end: endEye ? 'eye' : raw.end, joins: raw.joinsRiver, fromLake: raw.fromLake, toLake: raw.endLake,
      length: xs.length * 3,
    };
    rivers.push(river);
    if (endEye) {
      const n = xs.length - 1;
      const dx = xs[n] - xs[n - 1], dz = zs[n] - zs[n - 1];
      const len = Math.hypot(dx, dz) || 1;
      eyeFalls.push({ river: river.id, x: xs[n] + dx / len * 2, z: zs[n] + dz / len * 2, topY: levels[n], width: widths[n], dirX: dx / len, dirZ: dz / len });
    }
  }
  return { rivers, eyeFalls };
}

/** Lake membership weight at a fine position (bilinear over the coarse lake grid). */
export function lakeSample(coarse, lakeIdGrid, x, z, out) {
  const { cs, ox, oz, nx, nz } = coarse;
  const fx = (x - ox) / cs - 0.5, fz = (z - oz) / cs - 0.5;
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  let id = 0;
  let w = 0;
  const ids = [0, 0, 0, 0];
  const ws = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
  for (let q = 0; q < 4; q++) {
    const ii = i + (q & 1), jj = j + (q >> 1);
    if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
    ids[q] = lakeIdGrid[jj * nx + ii];
    if (ids[q] && !id) id = ids[q];
  }
  if (id) for (let q = 0; q < 4; q++) if (ids[q] === id) w += ws[q];
  // dilated check (1 cell ring) for shore lips
  let near = id;
  if (!near) {
    const ci = Math.round(fx), cj = Math.round(fz);
    for (let dj = -1; dj <= 1 && !near; dj++) for (let di = -1; di <= 1; di++) {
      const ii = ci + di, jj = cj + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const l = lakeIdGrid[jj * nx + ii];
      if (l) { near = l; break; }
    }
  }
  out.id = id;
  out.w = w;
  out.near = near;
  return out;
}
