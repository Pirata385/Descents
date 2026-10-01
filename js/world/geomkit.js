// Geometry kit for chunk meshing in workers (no three.js dependency).
// MeshBuffer accumulates vertices with: position (f32x3), normal (i8x3),
// colour (u8x3 sRGB), light (u8x4: sky exposure, ambient occlusion,
// emissive, flag) and sway (u8, foliage wind weight), plus u32 indices.

export class MeshBuffer {
  constructor(cap = 4096, withSway = false) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.nrm = new Int8Array(cap * 3);
    this.col = new Uint8Array(cap * 3);
    this.lit = new Uint8Array(cap * 4);
    this.withSway = withSway;
    this.sway = withSway ? new Uint8Array(cap) : null;
    this.icap = cap * 2;
    this.ni = 0;
    this.idx = new Uint32Array(this.icap);
  }

  grow(minV, minI) {
    if (this.n + minV > this.cap) {
      let c = this.cap * 2;
      while (c < this.n + minV) c *= 2;
      const g = (a, k, T) => { const b = new T(c * k); b.set(a.subarray(0, this.n * k)); return b; };
      this.pos = g(this.pos, 3, Float32Array);
      this.nrm = g(this.nrm, 3, Int8Array);
      this.col = g(this.col, 3, Uint8Array);
      this.lit = g(this.lit, 4, Uint8Array);
      if (this.withSway) this.sway = g(this.sway, 1, Uint8Array);
      this.cap = c;
    }
    if (this.ni + minI > this.icap) {
      let c = this.icap * 2;
      while (c < this.ni + minI) c *= 2;
      const b = new Uint32Array(c);
      b.set(this.idx.subarray(0, this.ni));
      this.idx = b;
      this.icap = c;
    }
  }

  /** Add a vertex; colours in 0..1 sRGB, light values 0..1. */
  v(x, y, z, nx, ny, nz, r, g, b, exp, ao, emi, flag, sway = 0) {
    const i = this.n++;
    const p = i * 3;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.nrm[p] = nx * 127; this.nrm[p + 1] = ny * 127; this.nrm[p + 2] = nz * 127;
    this.col[p] = r < 0 ? 0 : r > 1 ? 255 : r * 255;
    this.col[p + 1] = g < 0 ? 0 : g > 1 ? 255 : g * 255;
    this.col[p + 2] = b < 0 ? 0 : b > 1 ? 255 : b * 255;
    const l = i * 4;
    this.lit[l] = exp * 255; this.lit[l + 1] = ao * 255; this.lit[l + 2] = emi * 255; this.lit[l + 3] = flag;
    if (this.withSway) this.sway[i] = sway * 255;
    return i;
  }

  tri(a, b, c) {
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
  }

  quad(a, b, c, d) {
    this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
    this.idx[this.ni++] = a; this.idx[this.ni++] = c; this.idx[this.ni++] = d;
  }

  /** Export trimmed typed arrays (transferable). */
  export() {
    if (this.n === 0) return null;
    return {
      count: this.n,
      pos: this.pos.slice(0, this.n * 3),
      nrm: this.nrm.slice(0, this.n * 3),
      col: this.col.slice(0, this.n * 3),
      lit: this.lit.slice(0, this.n * 4),
      sway: this.withSway ? this.sway.slice(0, this.n) : null,
      idx: this.ni < 65536 * 3 && this.n < 65536 ? Uint16Array.from(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni),
    };
  }

  transferables(out) {
    if (!out) return [];
    const t = [out.pos.buffer, out.nrm.buffer, out.col.buffer, out.lit.buffer, out.idx.buffer];
    if (out.sway) t.push(out.sway.buffer);
    return t;
  }
}

/** A transform: position, yaw, uniform/non-uniform scale and optional tilt. */
export class Xform {
  constructor() { this.set(0, 0, 0, 0, 1, 1, 1); }
  set(x, y, z, yaw, sx, sy, sz, tiltX = 0, tiltZ = 0) {
    this.x = x; this.y = y; this.z = z;
    this.c = Math.cos(yaw); this.s = Math.sin(yaw);
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.tx = tiltX; this.tz = tiltZ;
    return this;
  }
  // transform local point (lx, ly, lz) -> out
  p(lx, ly, lz, out) {
    lx *= this.sx; ly *= this.sy; lz *= this.sz;
    // tilt (small shear-like rotation around x then z)
    if (this.tx) { const c = Math.cos(this.tx), s = Math.sin(this.tx); const y2 = ly * c - lz * s; lz = ly * s + lz * c; ly = y2; }
    if (this.tz) { const c = Math.cos(this.tz), s = Math.sin(this.tz); const x2 = lx * c - ly * s; ly = lx * s + ly * c; lx = x2; }
    out[0] = this.x + lx * this.c - lz * this.s;
    out[1] = this.y + ly;
    out[2] = this.z + lx * this.s + lz * this.c;
    return out;
  }
  n(nx, ny, nz, out) {
    // approximate normal transform (ignores non-uniform scale skew)
    if (this.tx) { const c = Math.cos(this.tx), s = Math.sin(this.tx); const y2 = ny * c - nz * s; nz = ny * s + nz * c; ny = y2; }
    if (this.tz) { const c = Math.cos(this.tz), s = Math.sin(this.tz); const x2 = nx * c - ny * s; ny = nx * s + ny * c; nx = x2; }
    out[0] = nx * this.c - nz * this.s;
    out[1] = ny;
    out[2] = nx * this.s + nz * this.c;
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  }
}

const _p = [0, 0, 0], _n = [0, 0, 0];

/** Emit a template mesh (array-based) through a transform with a colour tint. */
export function emitTemplate(buf, tpl, xf, tint, exp, ao, swayMul = 1, emiMul = 1) {
  const nv = tpl.n;
  buf.grow(nv, tpl.idx.length);
  const base = buf.n;
  for (let i = 0; i < nv; i++) {
    xf.p(tpl.pos[i * 3], tpl.pos[i * 3 + 1], tpl.pos[i * 3 + 2], _p);
    xf.n(tpl.nrm[i * 3], tpl.nrm[i * 3 + 1], tpl.nrm[i * 3 + 2], _n);
    const r = tpl.col[i * 3] * tint[0], g = tpl.col[i * 3 + 1] * tint[1], b = tpl.col[i * 3 + 2] * tint[2];
    buf.v(_p[0], _p[1], _p[2], _n[0], _n[1], _n[2], r, g, b, exp, ao * tpl.ao[i], tpl.emi[i] * emiMul, tpl.flag, tpl.sway[i] * swayMul);
  }
  for (let i = 0; i < tpl.idx.length; i++) buf.idx[buf.ni++] = base + tpl.idx[i];
}

/** Template builder: collects simple primitives in local space. */
export class Template {
  constructor() { this.P = []; this.N = []; this.C = []; this.A = []; this.E = []; this.S = []; this.I = []; this.flag = 0; }
  get n() { return this.P.length / 3; }
  vert(x, y, z, nx, ny, nz, c, ao = 1, emi = 0, sway = 0) {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.P.push(x, y, z); this.N.push(nx / l, ny / l, nz / l); this.C.push(c[0], c[1], c[2]); this.A.push(ao); this.E.push(emi); this.S.push(sway);
    return this.P.length / 3 - 1;
  }
  tri(a, b, c) { this.I.push(a, b, c); }
  finish() {
    return {
      n: this.P.length / 3, pos: Float32Array.from(this.P), nrm: Float32Array.from(this.N), col: Float32Array.from(this.C),
      ao: Float32Array.from(this.A), emi: Float32Array.from(this.E), sway: Float32Array.from(this.S), idx: Uint32Array.from(this.I), flag: this.flag,
    };
  }

  /** Tapered cylinder (or cone when r1 = 0) from p0 to p1 with nSides. */
  tube(p0, p1, r0, r1, nSides, c0, c1, opts = {}) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / len, ay = dy / len, az = dz / len;
    // basis perpendicular to axis
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(ay) > 0.9) { ux = 1; uy = 0; uz = 0; }
    let bx = ay * uz - az * uy, by = az * ux - ax * uz, bz = ax * uy - ay * ux;
    const bl = Math.hypot(bx, by, bz); bx /= bl; by /= bl; bz /= bl;
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const base = this.n;
    for (let i = 0; i < nSides; i++) {
      const a = (i / nSides) * Math.PI * 2 + (opts.twist || 0);
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = bx * ca + cx * sa, ny = by * ca + cy * sa, nz = bz * ca + cz * sa;
      this.vert(p0[0] + nx * r0, p0[1] + ny * r0, p0[2] + nz * r0, nx, ny, nz, c0, opts.ao0 ?? 0.85, opts.emi0 ?? 0, opts.sway0 ?? 0);
      this.vert(p1[0] + nx * r1, p1[1] + ny * r1, p1[2] + nz * r1, nx, ny, nz, c1, opts.ao1 ?? 1, opts.emi1 ?? 0, opts.sway1 ?? 0);
    }
    for (let i = 0; i < nSides; i++) {
      const a = base + i * 2, b = base + ((i + 1) % nSides) * 2;
      this.tri(a, b + 1, b); this.tri(a, a + 1, b + 1);
    }
    if (opts.cap1 && r1 > 0) {
      const ci = this.vert(p1[0], p1[1], p1[2], ax, ay, az, c1, 1, opts.emi1 ?? 0, opts.sway1 ?? 0);
      for (let i = 0; i < nSides; i++) this.tri(ci, base + i * 2 + 1, base + ((i + 1) % nSides) * 2 + 1);
    }
  }

  /** Low-poly blob (icosahedron, optionally subdivided once) with noise displacement. */
  blob(cx, cy, cz, rx, ry, rz, c, rng, opts = {}) {
    const t = (1 + Math.sqrt(5)) / 2;
    let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    if (opts.subdiv) {
      const mid = new Map();
      const m = (a, b) => {
        const k = a < b ? a * 100 + b : b * 100 + a;
        if (mid.has(k)) return mid.get(k);
        const v = [(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2, (verts[a][2] + verts[b][2]) / 2];
        verts.push(v);
        mid.set(k, verts.length - 1);
        return verts.length - 1;
      };
      const nf = [];
      for (const [a, b, d] of faces) { const ab = m(a, b), bd = m(b, d), da = m(d, a); nf.push([a, ab, da], [b, bd, ab], [d, da, bd], [ab, bd, da]); }
      faces = nf;
    }
    const jitter = opts.jitter ?? 0.18;
    const pts = verts.map((v) => {
      const l = Math.hypot(v[0], v[1], v[2]);
      const k = 1 + (rng ? (rng.next() - 0.5) * 2 * jitter : 0);
      return [v[0] / l * k, v[1] / l * k, v[2] / l * k];
    });
    // flat shaded: each face its own vertices
    for (const [a, b, d] of faces) {
      const A = pts[a], B = pts[b], D = pts[d];
      const P = (q) => [cx + q[0] * rx, cy + q[1] * ry, cz + q[2] * rz];
      const pa = P(A), pb = P(B), pd = P(D);
      const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
      const vx = pd[0] - pa[0], vy = pd[1] - pa[1], vz = pd[2] - pa[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      // orient outward
      const mx = (pa[0] + pb[0] + pd[0]) / 3 - cx, my = (pa[1] + pb[1] + pd[1]) / 3 - cy, mz = (pa[2] + pb[2] + pd[2]) / 3 - cz;
      let flip = nx * mx + ny * my + nz * mz < 0;
      if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      const shade = opts.shadeTop ? 0.75 + 0.25 * (ny / (Math.hypot(nx, ny, nz) || 1)) : 1;
      const cc = [c[0] * shade, c[1] * shade, c[2] * shade];
      const ao = opts.aoBottom ? 0.6 + 0.4 * Math.max(0, my / (ry || 1) + 0.5) : 1;
      const sw = opts.sway ?? 0;
      const ia = this.vert(...pa, nx, ny, nz, cc, ao, opts.emi ?? 0, sw);
      const ib = this.vert(...pb, nx, ny, nz, cc, ao, opts.emi ?? 0, sw);
      const id = this.vert(...pd, nx, ny, nz, cc, ao, opts.emi ?? 0, sw);
      if (flip) this.tri(ia, id, ib); else this.tri(ia, ib, id);
    }
  }

  /** Simple axis-aligned box. */
  box(x0, y0, z0, x1, y1, z1, c, opts = {}) {
    const faces = [
      [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]],
      [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0]],
      [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]],
      [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0]],
      [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [0, 0, 1]],
      [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1]],
    ];
    for (const [a, b, d, e, n] of faces) {
      const sh = n[1] > 0 ? 1 : n[1] < 0 ? 0.6 : 0.85;
      const cc = [c[0] * sh, c[1] * sh, c[2] * sh];
      const i0 = this.vert(...a, ...n, cc, 1, opts.emi ?? 0, opts.sway ?? 0);
      const i1 = this.vert(...b, ...n, cc, 1, opts.emi ?? 0, opts.sway ?? 0);
      const i2 = this.vert(...d, ...n, cc, 1, opts.emi ?? 0, opts.sway ?? 0);
      const i3 = this.vert(...e, ...n, cc, 1, opts.emi ?? 0, opts.sway ?? 0);
      this.tri(i0, i2, i1); this.tri(i0, i3, i2);
    }
  }

  /** Double-sided flat quad (for leaves, blades, banners). */
  card(p0, p1, p2, p3, c, opts = {}) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const s0 = opts.sway0 ?? 0, s1 = opts.sway1 ?? 0;
    const a = this.vert(...p0, nx, ny, nz, opts.c0 || c, opts.ao0 ?? 0.8, opts.emi ?? 0, s0);
    const b = this.vert(...p1, nx, ny, nz, opts.c0 || c, opts.ao0 ?? 0.8, opts.emi ?? 0, s0);
    const d = this.vert(...p2, nx, ny, nz, c, 1, opts.emi ?? 0, s1);
    const e = this.vert(...p3, nx, ny, nz, c, 1, opts.emi ?? 0, s1);
    this.tri(a, b, d); this.tri(a, d, e);
  }
}
