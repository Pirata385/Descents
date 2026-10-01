// Route system: city streets, country roads, journey trails, stairways,
// ledges and tunnels. Routes are planned as polylines (A* over the coarse
// terrain grid where needed), given a smooth height profile with a maximum
// slope, then stamped into columns (cut, fill, bridge or ledge) by the
// column generator. Journey routes are validated for walkability.
import { M } from './materials.js';
import { RT, ColumnData } from './column.js';
import { chaikin, resamplePolyline, clamp } from '../core/mathutil.js';
import { Z_EYE, Z_SEA } from './field.js';

export const STYLES = {
  promenade: { type: RT.ROAD, hw: 3.6, clear: 4.6, cutLimit: 6, fillLimit: 6, deck: 1.2, mat: M.COBBLE, stairMat: M.COBBLE, bridgeMat: M.BRICK, fillSide: M.BRICK, maxSlope: 0.16, priority: 4, maxLod: 3 },
  ring: { type: RT.ROAD, hw: 2.6, clear: 4.6, cutLimit: 6, fillLimit: 6, deck: 1.2, mat: M.COBBLE, stairMat: M.COBBLE, bridgeMat: M.BRICK, fillSide: M.BRICK, maxSlope: 0.18, priority: 3, maxLod: 2 },
  avenue: { type: RT.ROAD, hw: 2.7, clear: 4.6, cutLimit: 6, fillLimit: 6, deck: 1.2, mat: M.COBBLE, stairMat: M.COBBLE, bridgeMat: M.BRICK, fillSide: M.BRICK, maxSlope: 0.2, priority: 3, maxLod: 2 },
  lane: { type: RT.STREET, hw: 1.7, clear: 4.2, cutLimit: 5, fillLimit: 5, deck: 1.0, mat: M.COBBLE, stairMat: M.COBBLE, bridgeMat: M.WOOD, fillSide: M.BRICK, maxSlope: 0.3, priority: 2, maxLod: 1 },
  country: { type: RT.ROAD, hw: 1.9, clear: 4.2, cutLimit: 5, fillLimit: 5, deck: 1.0, mat: M.PATH, stairMat: M.PATH, bridgeMat: M.WOOD, fillSide: M.DIRT, maxSlope: 0.24, priority: 1, maxLod: 2 },
  stair: { type: RT.STAIR, hw: 1.8, clear: 4.2, cutLimit: 8, fillLimit: 9, deck: 1.6, mat: M.BRICK, stairMat: M.BRICK, bridgeMat: M.BRICK, fillSide: M.BRICK, maxSlope: 0.58, priority: 5, maxLod: 2 },
  trail: { type: RT.TRAIL, hw: 1.7, clear: 3.8, cutLimit: 4.5, fillLimit: 5, deck: 1.0, mat: M.PATH, stairMat: M.RUIN, bridgeMat: M.WOOD, fillSide: M.DIRT, maxSlope: 0.5, priority: 2, maxLod: 1 },
  ledge: { type: RT.LEDGE, hw: 2.1, clear: 4.2, cutLimit: 0.6, fillLimit: 1.2, deck: 3.0, mat: M.GRAVEL, stairMat: M.GRAVEL, bridgeMat: M.SHAFTROCK, deckSide: M.SHAFTROCK, fillSide: M.SHAFTROCK, ceil: M.SHAFTROCK, maxSlope: 0.5, priority: 6, maxLod: 3 },
  plainTrail: { type: RT.TRAIL, hw: 1.7, clear: 3.8, cutLimit: 4, fillLimit: 5, deck: 1.2, mat: M.GRAVEL, stairMat: M.RUIN2, bridgeMat: M.RUIN2, fillSide: M.STONEPLAIN, maxSlope: 0.45, priority: 2, maxLod: 1 },
  faultLedge: { type: RT.LEDGE, hw: 2.0, clear: 4.0, cutLimit: 0.6, fillLimit: 1.2, deck: 2.6, mat: M.BASALT, stairMat: M.BASALT, bridgeMat: M.BASALT, deckSide: M.BASALT, fillSide: M.BASALT, ceil: M.BASALT, maxSlope: 0.5, priority: 6, maxLod: 3 },
  galleryTrail: { type: RT.TRAIL, hw: 1.6, clear: 3.8, cutLimit: 4, fillLimit: 4, deck: 1.4, mat: M.LITTER, stairMat: M.RUIN2, bridgeMat: M.WOOD, fillSide: M.DARKROCK, maxSlope: 0.45, priority: 2, maxLod: 1 },
};

/** A* over the coarse grid. cost(i, j, ni, nj) returns extra multiplier or Infinity. */
export function astar(coarse, sx, sz, gx, gz, costFn, maxNodes = 200000) {
  const { cs, ox, oz, nx, nz } = coarse;
  const toCell = (x, z) => [clamp(Math.floor((x - ox) / cs), 0, nx - 1), clamp(Math.floor((z - oz) / cs), 0, nz - 1)];
  const [si, sj] = toCell(sx, sz), [gi, gj] = toCell(gx, gz);
  const N = nx * nz;
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heapI = [], heapF = [];
  const push = (i, f) => {
    heapI.push(i); heapF.push(f);
    let p = heapI.length - 1;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (heapF[q] <= heapF[p]) break;
      [heapI[p], heapI[q]] = [heapI[q], heapI[p]]; [heapF[p], heapF[q]] = [heapF[q], heapF[p]];
      p = q;
    }
  };
  const pop = () => {
    const top = heapI[0];
    const li = heapI.pop(), lf = heapF.pop();
    if (heapI.length) {
      heapI[0] = li; heapF[0] = lf;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < heapI.length && heapF[l] < heapF[m]) m = l;
        if (r < heapI.length && heapF[r] < heapF[m]) m = r;
        if (m === p) break;
        [heapI[p], heapI[m]] = [heapI[m], heapI[p]]; [heapF[p], heapF[m]] = [heapF[m], heapF[p]];
        p = m;
      }
    }
    return top;
  };
  const start = sj * nx + si, goal = gj * nx + gi;
  g[start] = 0;
  push(start, 0);
  let expanded = 0;
  const D8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [-1, -1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142]];
  while (heapI.length && expanded < maxNodes) {
    const c = pop();
    if (closed[c]) continue;
    closed[c] = 1;
    expanded++;
    if (c === goal) break;
    const ci = c % nx, cj = (c / nx) | 0;
    for (const [di, dj, dl] of D8) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const n = nj * nx + ni;
      if (closed[n]) continue;
      const mult = costFn(c, n, dl * cs);
      if (!Number.isFinite(mult)) continue;
      const ng = g[c] + dl * cs * mult;
      if (ng < g[n]) {
        g[n] = ng;
        came[n] = c;
        const hx = (ni - gi) * cs, hz = (nj - gj) * cs;
        push(n, ng + Math.sqrt(hx * hx + hz * hz));
      }
    }
  }
  if (came[goal] < 0 && goal !== start) return null;
  const path = [];
  for (let c = goal; c >= 0; c = came[c]) {
    path.push([ox + ((c % nx) + 0.5) * cs, oz + (((c / nx) | 0) + 0.5) * cs]);
    if (c === start) break;
  }
  path.reverse();
  return path;
}

/** Standard terrain cost for overland trails. */
export function trailCost(coarse, hydro, opts = {}) {
  const { h, zone, nx } = coarse;
  const riverBias = opts.riverBias || 0;
  return (c, n, dist) => {
    if (zone[n] === Z_EYE || zone[n] === Z_SEA) return Infinity;
    if (hydro.lakeId[n]) return 25;
    const dh = Math.abs(h[n] - h[c]);
    const s = dh / dist;
    let m = 1;
    if (s > 0.25) m += (s - 0.25) * 6;
    if (s > 0.6) m += 4 + (s - 0.6) * 25;
    if (opts.waterDistGrid) {
      const wd = opts.waterDistGrid[n];
      if (wd < 1) m += 2.5; // crossing needs a bridge
      if (riverBias && wd < 4) m *= 1 - riverBias;
    }
    if (coarse.eyeDist && coarse.eyeDist[n] < 18) m += 10;
    if (opts.avoid && opts.avoid[n]) m += 12;
    if (opts.occupied && opts.occupied[n] && !(opts.goalFree && opts.goalFree(n))) m += 6;
    void nx;
    return m;
  };
}

/** Smooth a 2D path and resample. Returns [[x, z], ...]. */
export function smoothPath(pts, spacing = 2) {
  let p = chaikin(pts.map((q) => [q[0], q[1]]), 3);
  p = resamplePolyline(p, spacing);
  return p;
}

/**
 * Height profile for a terrain-following route. gen is a ColumnGen without routes.
 * opts.refY: function(i) -> reference height to look for a floor near (deep routes)
 * Returns array of y.
 */
export function profileRoute(gen, pts, style, opts = {}) {
  const col = new ColumnData();
  const n = pts.length;
  const ys = new Float32Array(n);
  const water = new Float32Array(n).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const [x, z] = pts[i];
    gen.column(x, z, 0, col);
    let y;
    if (opts.band) {
      const [bt, bb] = opts.band;
      y = null;
      for (let k = col.n - 1; k >= 0; k--) {
        const t = col.y1[k];
        if (t > bt || t < bb) continue;
        const above = k + 1 < col.n ? col.y0[k + 1] : Infinity;
        if (above - t >= 3) { y = t; break; }
      }
      if (y === null) y = i > 0 ? ys[i - 1] : (opts.startY ?? bb);
    } else if (opts.refY) {
      const ref = opts.refY(i);
      const f = col.floorBelow(ref + 3);
      y = f >= 0 ? col.y1[f] : ref;
      if (y < ref - 12) y = ref;
    } else {
      y = col.n ? col.y1[col.n - 1] : 0;
    }
    for (let k = 0; k < col.nw; k++) water[i] = Math.max(water[i], col.wl[k]);
    ys[i] = y;
  }
  // light smoothing
  const sm = new Float32Array(n);
  const win = opts.window ?? 3;
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -win; k <= win; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      s += ys[j]; c++;
    }
    sm[i] = s / c;
  }
  for (let i = 0; i < n; i++) if (water[i] > -Infinity) sm[i] = Math.max(sm[i], water[i] + 1.3);
  const fixed = new Uint8Array(n);
  if (opts.pins) for (const [i, y] of opts.pins) { sm[i] = y; fixed[i] = 1; }
  if (opts.startY !== undefined) { sm[0] = opts.startY; fixed[0] = 1; }
  if (opts.endY !== undefined) { sm[n - 1] = opts.endY; fixed[n - 1] = 1; }
  // slope clamp (forward/backward passes) keeps pinned points fixed
  const maxS = style.maxSlope;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < n; i++) {
      if (fixed[i]) continue;
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const m = maxS * d;
      sm[i] = clamp(sm[i], sm[i - 1] - m, sm[i - 1] + m);
    }
    for (let i = n - 2; i >= 0; i--) {
      if (fixed[i]) continue;
      const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      const m = maxS * d;
      sm[i] = clamp(sm[i], sm[i + 1] - m, sm[i + 1] + m);
    }
  }
  return sm;
}

export function makeRoute(id, styleName, pts3, meta = {}) {
  const style = STYLES[styleName];
  const arr = new Float32Array(pts3.length * 3);
  let len = 0;
  for (let i = 0; i < pts3.length; i++) {
    arr[i * 3] = pts3[i][0]; arr[i * 3 + 1] = pts3[i][1]; arr[i * 3 + 2] = pts3[i][2];
    if (i) len += Math.hypot(pts3[i][0] - pts3[i - 1][0], pts3[i][2] - pts3[i - 1][2]);
  }
  return { id, style: styleName, ...style, ...meta, pts: arr, length: len };
}

/**
 * Validate that a route (or cave) is walkable: at every sample the floor exists
 * near the expected height, there is headroom, and steps are climbable.
 */
export function validatePath(gen, samples, opts = {}) {
  const col = new ColumnData();
  const maxStep = opts.maxStep ?? 1.55;
  const headroom = opts.headroom ?? 1.9;
  const tol = opts.tol ?? 0.9;
  const failures = [];
  let prevFloor = null;
  let jumps = 0;
  for (let i = 0; i < samples.length; i++) {
    const [x, y, z] = samples[i];
    gen.column(x, z, 0, col);
    let f = col.floorBelow(y + tol);
    // a surface a little above the path (a deck or step it runs onto) is walkable too
    const fUp = col.floorBelow(y + tol + 0.7);
    if (fUp > f && (fUp + 1 < col.n ? col.y0[fUp + 1] : Infinity) - col.y1[fUp] >= headroom) f = fUp;
    if (f < 0) { failures.push({ i, x, y, z, why: 'no floor' }); prevFloor = null; continue; }
    // spans that touch form one solid stack: its top is the real floor (a step)
    while (f + 1 < col.n && col.y0[f + 1] - col.y1[f] < 0.05 && col.y1[f + 1] - y < maxStep + tol) f++;
    const fy = col.y1[f];
    if (fy < y - (opts.drop ?? 2.2)) { failures.push({ i, x, y, z, fy, why: 'floor too low' }); prevFloor = null; continue; }
    const ceil = f + 1 < col.n ? col.y0[f + 1] : Infinity;
    if (ceil - fy < headroom) { failures.push({ i, x, y, z, fy, ceil, why: 'no headroom' }); }
    if (prevFloor !== null) {
      const step = fy - prevFloor;
      if (step > maxStep) failures.push({ i, x, y, z, fy, step, why: 'step too high' });
      else if (step > 0.6) jumps++;
    }
    prevFloor = fy;
  }
  return { ok: failures.length === 0, failures, samples: samples.length, jumps };
}

/** Densify a 3D polyline into samples every `step` metres. */
export function densify(pts3, step = 0.5) {
  const out = [];
  for (let i = 0; i < pts3.length - 1; i++) {
    const a = pts3[i], b = pts3[i + 1];
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  out.push(pts3[pts3.length - 1].slice());
  return out;
}

export function routeTo3(route) {
  const out = [];
  for (let i = 0; i < route.pts.length; i += 3) out.push([route.pts[i], route.pts[i + 1], route.pts[i + 2]]);
  return out;
}

/**
 * Index of profiled route samples so that later routes merge smoothly into
 * earlier ones (junctions share one height instead of overlapping at two).
 */
export class RouteIndex {
  constructor(grid) { this.grid = grid; }
  add(route, journey = false) {
    const p = route.pts;
    for (let i = 0; i < p.length; i += 3) this.grid.insertCircle(p[i], p[i + 2], 0.1, { x: p[i], y: p[i + 1], z: p[i + 2], hw: route.hw, id: route.id, journey });
  }
  nearest(x, z, r) {
    let best = null, bd = r;
    for (const s of this.grid.queryRadius(x, z, r)) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd && d < s.hw + r) { bd = d; best = s; }
    }
    return best;
  }
  /**
   * Profile pts, then merge with earlier routes wherever they overlap at a
   * similar height: overlapping samples take the earlier route's height and
   * nearby samples blend toward it, so junctions and crossings share one surface.
   */
  profile(gen, pts, style, opts = {}) {
    const ys = profileRoute(gen, pts, style, opts);
    const n = pts.length;
    const target = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const nb = this.nearest(pts[i][0], pts[i][1], style.hw + 1.5);
      if (nb && Math.abs(nb.y - ys[i]) < 8) target[i] = nb.y;
    }
    const K = 16;
    // distance (in samples) to the nearest overlapping sample, and its height
    const dist = new Float32Array(n).fill(1e9);
    const ty = new Float32Array(n);
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(target[i])) last = i;
      if (last >= 0 && i - last < dist[i]) { dist[i] = i - last; ty[i] = target[last]; }
    }
    last = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (!Number.isNaN(target[i])) last = i;
      if (last >= 0 && last - i < dist[i]) { dist[i] = last - i; ty[i] = target[last]; }
    }
    for (let i = 0; i < n; i++) {
      if (dist[i] >= K) continue;
      if ((i === 0 && opts.startY !== undefined) || (i === n - 1 && opts.endY !== undefined)) continue;
      const w = 1 - dist[i] / K;
      const ww = w * w * (3 - 2 * w);
      ys[i] = ys[i] + (ty[i] - ys[i]) * ww;
    }
    // physical walkability guard: never steeper than 0.9 (0.45 m per half metre)
    const MAXP = 0.9;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < n; i++) {
        if (i === n - 1 && opts.endY !== undefined) continue;
        const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        ys[i] = clamp(ys[i], ys[i - 1] - MAXP * d, ys[i - 1] + MAXP * d);
      }
      for (let i = n - 2; i >= 0; i--) {
        if (i === 0 && opts.startY !== undefined) continue;
        const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        ys[i] = clamp(ys[i], ys[i + 1] - MAXP * d, ys[i + 1] + MAXP * d);
      }
    }
    return ys;
  }
}
