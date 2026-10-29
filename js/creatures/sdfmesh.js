// Metaball skin for creatures, in the spirit of Spore: the body is a set of
// soft primitives (round cones along bones, ellipsoids for heads, bellies,
// ears and crests) blended with a smooth minimum of their signed distance
// fields, so torso, neck, head and limbs melt into one another. The field is
// sampled on a grid sized to the creature and polygonised with surface nets;
// normals come from the field's gradient (smooth shading), colours from the
// body region, the coat pattern and the belly, and skin weights from the
// bones of the nearest parts, blended across joints.
//
// Pure JavaScript with no three.js: it runs in a worker (creatureWorker.js)
// as well as on the main thread.

export const REG = {
  BODY: 0, NECK: 1, HEAD: 2, SNOUT: 3, LIMB: 4, FOOT: 5, TAIL: 6, TIP: 7,
  HORN: 8, CREST: 9, EAR: 10, SHELL: 11, CLAW: 12, MOUTH: 13, EYELID: 14, NOSE: 15, HOOF: 16, RIM: 17,
};

// part kinds
export const RC = 0;   // round cone from a (radius ra) to b (radius rb)
export const EL = 1;   // ellipsoid at c with radii r, optional basis (u, v, w)

// ------------------------------------------------------------------ distance functions
function sdRoundCone(px, py, pz, P) {
  const bax = P.bx - P.ax, bay = P.by - P.ay, baz = P.bz - P.az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const r1 = P.ra, r2 = P.rb;
  const pax = px - P.ax, pay = py - P.ay, paz = pz - P.az;
  if (l2 < 1e-10) return Math.sqrt(pax * pax + pay * pay + paz * paz) - Math.max(r1, r2);
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  if (a2 <= 1e-9) {
    // one end sphere swallows the other
    const d1 = Math.sqrt(pax * pax + pay * pay + paz * paz) - r1;
    const qx = px - P.bx, qy = py - P.by, qz = pz - P.bz;
    return Math.min(d1, Math.sqrt(qx * qx + qy * qy + qz * qz) - r2);
  }
  const il2 = 1 / l2;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xvx = pax * l2 - bax * y, xvy = pay * l2 - bay * y, xvz = paz * l2 - baz * y;
  const x2 = xvx * xvx + xvy * xvy + xvz * xvz;
  const y2 = y * y * l2, z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

function sdEllipsoid(px, py, pz, P) {
  let x = px - P.cx, y = py - P.cy, z = pz - P.cz;
  if (P.u) {
    const lx = x * P.u[0] + y * P.u[1] + z * P.u[2];
    const ly = x * P.v[0] + y * P.v[1] + z * P.v[2];
    const lz = x * P.w[0] + y * P.w[1] + z * P.w[2];
    x = lx; y = ly; z = lz;
  }
  const qx = x / P.rx, qy = y / P.ry, qz = z / P.rz;
  const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  const ux = x / (P.rx * P.rx), uy = y / (P.ry * P.ry), uz = z / (P.rz * P.rz);
  const k1 = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (k1 < 1e-9) return -Math.min(P.rx, P.ry, P.rz);
  return k0 * (k0 - 1) / k1;
}

export function partDist(px, py, pz, P) {
  if (P.t === EL) return sdEllipsoid(px, py, pz, P);
  // round cones can be widened across x (torsos wider than deep, or the reverse)
  if (P.sx && P.sx !== 1) return sdRoundCone(P.ax + (px - P.ax) / P.sx, py, pz, P) * Math.min(1, P.sx);
  return sdRoundCone(px, py, pz, P);
}

/** Position along a part, 0 at its start and 1 at its end (0 for ellipsoids). */
function partT(px, py, pz, P) {
  if (P.t === EL) return 0;
  const bax = P.bx - P.ax, bay = P.by - P.ay, baz = P.bz - P.az;
  const l2 = bax * bax + bay * bay + baz * baz;
  if (l2 < 1e-10) return 0;
  const t = ((px - P.ax) * bax + (py - P.ay) * bay + (pz - P.az) * baz) / l2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function partBox(P, pad) {
  if (P.t === EL) {
    const r = Math.max(P.rx, P.ry, P.rz) + pad;
    return [P.cx - r, P.cy - r, P.cz - r, P.cx + r, P.cy + r, P.cz + r];
  }
  const r = Math.max(P.ra, P.rb) + pad;
  const rx = Math.max(P.ra, P.rb) * Math.max(1, P.sx || 1) + pad;
  return [Math.min(P.ax, P.bx) - rx, Math.min(P.ay, P.by) - r, Math.min(P.az, P.bz) - r, Math.max(P.ax, P.bx) + rx, Math.max(P.ay, P.by) + r, Math.max(P.az, P.bz) + r];
}

// ------------------------------------------------------------------ colour
function hash3(x, y, z) { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const n = (a, b, c) => hash3(ix + a, iy + b, iz + c);
  const x00 = n(0, 0, 0) + (n(1, 0, 0) - n(0, 0, 0)) * sx, x10 = n(0, 1, 0) + (n(1, 1, 0) - n(0, 1, 0)) * sx;
  const x01 = n(0, 0, 1) + (n(1, 0, 1) - n(0, 0, 1)) * sx, x11 = n(0, 1, 1) + (n(1, 1, 1) - n(0, 1, 1)) * sx;
  const y0 = x00 + (x10 - x00) * sy, y1 = x01 + (x11 - x01) * sy;
  return y0 + (y1 - y0) * sz;
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/**
 * Colour of a point of the skin. pal: { primary, secondary, belly, accent, horn,
 * mouth, glow, glowAmt, pattern, pscale, contrast, seed, S (body length) }.
 * Returns [r, g, b, glow].
 */
export function paintPoint(pal, reg, x, y, z, nx, ny, nz, t) {
  const S = pal.S || 1;
  const ux = x / S, uy = y / S, uz = z / S;          // body units
  const sd = pal.seed % 97;
  let c = pal.primary, glow = 0;
  const patterned = reg === REG.BODY || reg === REG.NECK || reg === REG.TAIL || reg === REG.HEAD || reg === REG.SHELL || reg === REG.LIMB;
  if (patterned) {
    const f = pal.pscale, k = pal.contrast;
    let m = 0;
    switch (pal.pattern) {
      case 'stripes': m = smooth(0.15, 0.45, Math.sin(uz * 9 * f + vnoise(ux * 3, uy * 3, uz * 3 + sd) * 2.2)) * smooth(-0.1, 0.35, ny); break;
      case 'bands': m = smooth(0.2, 0.5, Math.sin(uz * 6 * f + sd)); break;
      case 'spots': m = smooth(0.62, 0.7, vnoise(ux * 7 * f + sd, uy * 7 * f, uz * 7 * f)) * smooth(-0.3, 0.2, ny); break;
      case 'mottled': m = smooth(0.4, 0.75, vnoise(ux * 4 * f, uy * 4 * f + sd, uz * 4 * f) * 0.7 + vnoise(ux * 11, uy * 11, uz * 11) * 0.3); break;
      case 'gradient': m = smooth(-0.2, 0.9, ny); break;
      case 'saddle': m = smooth(0.25, 0.6, ny) * smooth(0.45, 0.2, Math.abs(uz - (pal.saddleZ || 0) / S)); break;
      case 'ocelli': { const v = vnoise(ux * 5 * f + sd, uy * 5 * f, uz * 5 * f); m = smooth(0.66, 0.7, v) * (1 - smooth(0.73, 0.76, v)) + smooth(0.78, 0.8, v) * 0.6; break; }
      default: m = smooth(0.0, 1.0, ny) * 0.25; break;
    }
    c = mix(pal.primary, pal.secondary, Math.min(1, m * k));
    // countershading: a lighter belly
    if (reg !== REG.LIMB && reg !== REG.SHELL) c = mix(c, pal.belly, smooth(-0.15, -0.75, ny) * 0.9);
  }
  switch (reg) {
    case REG.SNOUT: c = mix(pal.primary, pal.belly, 0.25 + 0.4 * smooth(0, -0.6, ny)); break;
    case REG.NOSE: c = mix(pal.primary, [0.08, 0.06, 0.06], 0.75); break;
    case REG.LIMB: c = mix(c, pal.secondary, 0.15 + 0.35 * t); break;
    case REG.FOOT: c = mix(pal.secondary, [0.12, 0.1, 0.1], 0.35); break;
    case REG.TIP: c = mix(pal.secondary, pal.accent, 0.35); break;
    case REG.HORN: c = mix(pal.horn, mix(pal.horn, [0.1, 0.08, 0.07], 0.7), t * 0.6); break;
    case REG.CLAW: c = mix(pal.horn, [0.1, 0.09, 0.08], 0.5); break;
    case REG.CREST: c = mix(pal.secondary, pal.accent, 0.35 + 0.45 * t); break;
    case REG.EAR: c = nz > 0.2 ? mix(pal.belly, [0.85, 0.55, 0.55], 0.35) : mix(pal.primary, pal.secondary, 0.3); break;
    case REG.SHELL: c = mix(c, mix(pal.secondary, [0.1, 0.1, 0.1], 0.3), smooth(0.55, 0.62, vnoise(ux * 9, uy * 9, uz * 9)) * 0.5); break;
    case REG.MOUTH: c = pal.mouth; break;
    case REG.EYELID: c = mix(pal.primary, pal.belly, 0.2); break;
    case REG.HOOF: c = mix(pal.horn, [0.08, 0.07, 0.07], 0.65); break;
    case REG.RIM: c = mix(pal.secondary, pal.accent, 0.55); glow = pal.glowAmt * 0.9; break;
    default: break;
  }
  // bioluminescent markings: dots and lines along the back and flanks
  if (pal.glowAmt > 0 && (reg === REG.BODY || reg === REG.TAIL || reg === REG.CREST || reg === REG.TIP || reg === REG.NECK)) {
    const dots = smooth(0.72, 0.8, vnoise(ux * 13 + sd, uy * 13, uz * 13)) * smooth(-0.2, 0.3, ny);
    const crestK = reg === REG.CREST || reg === REG.TIP ? 0.8 : 0;
    const g = Math.max(dots, crestK) * pal.glowAmt;
    if (g > 0.02) { c = mix(c, pal.glow, g * 0.8); glow = g; }
  }
  return [c[0], c[1], c[2], glow];
}

// ------------------------------------------------------------------ polygonisation
/**
 * Build the skin mesh of a set of parts.
 * desc: { parts: [part], pal: palette, res: cells along the longest side, maxDim: optional }
 * part: { t: RC|EL, (RC) ax..bz, ra, rb, (EL) cx, cy, cz, rx, ry, rz, u?, v?, w?,
 *         k: blend radius, b0, b1: bones at the start/end, reg, grow?: blend toward b1 from t }
 * Returns { pos, nrm, col, glow, skin, wts, idx } (typed arrays, 4 bone influences per vertex).
 */
export function meshParts(desc) {
  const parts = desc.parts;
  const res = desc.res || 32;
  // bounds
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, kmax = 0;
  for (const P of parts) {
    const b = partBox(P, P.k || 0);
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); z0 = Math.min(z0, b[2]);
    x1 = Math.max(x1, b[3]); y1 = Math.max(y1, b[4]); z1 = Math.max(z1, b[5]);
    kmax = Math.max(kmax, P.k || 0);
  }
  const ext = Math.max(x1 - x0, y1 - y0, z1 - z0);
  const h = Math.max(1e-4, desc.h || ext / res);
  x0 -= h * 2; y0 -= h * 2; z0 -= h * 2;
  const nx = Math.min(96, Math.ceil((x1 - x0) / h) + 3), ny = Math.min(96, Math.ceil((y1 - y0) / h) + 3), nz = Math.min(96, Math.ceil((z1 - z0) / h) + 3);
  const N = nx * ny * nz;
  const F = new Float32Array(N).fill(h * 3);
  const own = new Int16Array(N).fill(-1);
  const ownD = new Float32Array(N).fill(1e9);
  const sxy = nx * ny;
  // accumulate the smooth union, part by part, inside each part's influence box
  for (let pi = 0; pi < parts.length; pi++) {
    const P = parts[pi];
    const k = P.k || 0;
    const b = partBox(P, k + h * 1.5);
    const i0 = Math.max(0, Math.floor((b[0] - x0) / h)), i1 = Math.min(nx - 1, Math.ceil((b[3] - x0) / h));
    const j0 = Math.max(0, Math.floor((b[1] - y0) / h)), j1 = Math.min(ny - 1, Math.ceil((b[4] - y0) / h));
    const k0 = Math.max(0, Math.floor((b[2] - z0) / h)), k1 = Math.min(nz - 1, Math.ceil((b[5] - z0) / h));
    for (let kk = k0; kk <= k1; kk++) {
      const pz = z0 + kk * h;
      for (let jj = j0; jj <= j1; jj++) {
        const py = y0 + jj * h;
        let idx = kk * sxy + jj * nx + i0;
        for (let ii = i0; ii <= i1; ii++, idx++) {
          const px = x0 + ii * h;
          const d = partDist(px, py, pz, P);
          F[idx] = smin(F[idx], d, k);
          if (d < ownD[idx]) { ownD[idx] = d; own[idx] = pi; }
        }
      }
    }
  }
  // surface nets: one vertex per cell crossed by the surface
  const cellV = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const P3 = [], N3 = [], C3 = [], GL = [], SK = [], SW = [], IDX = [];
  const cidx = (i, j, k) => (k * (ny - 1) + j) * (nx - 1) + i;
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const fv = new Float32Array(8);
  const grad = (i, j, k, out) => {
    const im = Math.max(0, i - 1), ip = Math.min(nx - 1, i + 1), jm = Math.max(0, j - 1), jp = Math.min(ny - 1, j + 1), km = Math.max(0, k - 1), kp = Math.min(nz - 1, k + 1);
    out[0] = F[k * sxy + j * nx + ip] - F[k * sxy + j * nx + im];
    out[1] = F[k * sxy + jp * nx + i] - F[k * sxy + jm * nx + i];
    out[2] = F[kp * sxy + j * nx + i] - F[km * sxy + j * nx + i];
  };
  const g = [0, 0, 0];
  const pal = desc.pal;
  const cand = [], candD = [];
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = F[(k + corner[c][2]) * sxy + (j + corner[c][1]) * nx + (i + corner[c][0])];
          fv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        // vertex: mean of the edge crossings
        let vx = 0, vy = 0, vz = 0, ne = 0;
        for (const [a, b] of edges) {
          const fa = fv[a], fb = fv[b];
          if ((fa < 0) === (fb < 0)) continue;
          const t = fa / (fa - fb);
          vx += corner[a][0] + (corner[b][0] - corner[a][0]) * t;
          vy += corner[a][1] + (corner[b][1] - corner[a][1]) * t;
          vz += corner[a][2] + (corner[b][2] - corner[a][2]) * t;
          ne++;
        }
        vx /= ne; vy /= ne; vz /= ne;
        const px = x0 + (i + vx) * h, py = y0 + (j + vy) * h, pz = z0 + (k + vz) * h;
        // normal: trilinear blend of the field gradient at the cell corners
        let gx = 0, gy = 0, gz = 0;
        for (let c = 0; c < 8; c++) {
          const wx = corner[c][0] ? vx : 1 - vx, wy = corner[c][1] ? vy : 1 - vy, wz = corner[c][2] ? vz : 1 - vz;
          grad(i + corner[c][0], j + corner[c][1], k + corner[c][2], g);
          const w = wx * wy * wz;
          gx += g[0] * w; gy += g[1] * w; gz += g[2] * w;
        }
        const gl = Math.hypot(gx, gy, gz) || 1;
        gx /= gl; gy /= gl; gz /= gl;
        // the parts that shape this spot, with weights from their distances
        cand.length = 0; candD.length = 0;
        for (let c = 0; c < 8; c++) {
          const o = own[(k + corner[c][2]) * sxy + (j + corner[c][1]) * nx + (i + corner[c][0])];
          if (o >= 0 && !cand.includes(o)) cand.push(o);
        }
        let dmin = Infinity;
        for (const o of cand) { const d = partDist(px, py, pz, parts[o]); candD.push(d); if (d < dmin) dmin = d; }
        const bw = new Map();
        let r = 0, gg = 0, b2 = 0, glw = 0, wsum = 0;
        for (let q = 0; q < cand.length; q++) {
          const P = parts[cand[q]];
          const spread = Math.max(h * 0.75, (P.k || 0) * 0.35);
          const w = Math.exp(-(candD[q] - dmin) / spread);
          if (w < 0.02) continue;
          const t = partT(px, py, pz, P);
          // bones: the part's own bone, easing into the next one at its far end
          const toB1 = P.b1 !== undefined && P.b1 !== P.b0 ? smooth(P.grow ?? 0.6, 1.0, t) * 0.5 : 0;
          bw.set(P.b0, (bw.get(P.b0) || 0) + w * (1 - toB1));
          if (toB1 > 0) bw.set(P.b1, (bw.get(P.b1) || 0) + w * toB1);
          const pc = paintPoint(pal, P.reg, px, py, pz, gx, gy, gz, t);
          r += pc[0] * w; gg += pc[1] * w; b2 += pc[2] * w; glw += pc[3] * w; wsum += w;
        }
        if (wsum <= 0) { wsum = 1; r = pal.primary[0]; gg = pal.primary[1]; b2 = pal.primary[2]; bw.set(parts[cand[0]].b0, 1); }
        const vi = P3.length / 3;
        cellV[cidx(i, j, k)] = vi;
        P3.push(px, py, pz); N3.push(gx, gy, gz);
        C3.push(r / wsum, gg / wsum, b2 / wsum); GL.push(glw / wsum);
        const top = [...bw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
        const ts = top.reduce((s, e) => s + e[1], 0) || 1;
        for (let q = 0; q < 4; q++) { SK.push(top[q] ? top[q][0] : 0); SW.push(top[q] ? top[q][1] / ts : 0); }
      }
    }
  }
  // quads across every grid edge crossed by the surface
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const f0 = F[k * sxy + j * nx + i];
        const in0 = f0 < 0;
        // edge along x from (i,j,k): cells around it share j-1..j, k-1..k
        if (j > 0 && k > 0) {
          const f1 = F[k * sxy + j * nx + i + 1];
          if (in0 !== (f1 < 0)) quad(cellV[cidx(i, j - 1, k - 1)], cellV[cidx(i, j, k - 1)], cellV[cidx(i, j, k)], cellV[cidx(i, j - 1, k)], in0);
        }
        if (i > 0 && k > 0) {
          const f1 = F[k * sxy + (j + 1) * nx + i];
          if (in0 !== (f1 < 0)) quad(cellV[cidx(i - 1, j, k - 1)], cellV[cidx(i - 1, j, k)], cellV[cidx(i, j, k)], cellV[cidx(i, j, k - 1)], in0);
        }
        if (i > 0 && j > 0) {
          const f1 = F[(k + 1) * sxy + j * nx + i];
          if (in0 !== (f1 < 0)) quad(cellV[cidx(i - 1, j - 1, k)], cellV[cidx(i, j - 1, k)], cellV[cidx(i, j, k)], cellV[cidx(i - 1, j, k)], in0);
        }
      }
    }
  }
  function quad(a, b, c, d, flip) {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) IDX.push(a, b, c, a, c, d); else IDX.push(a, c, b, a, d, c);
  }
  return {
    pos: Float32Array.from(P3), nrm: Float32Array.from(N3), col: Float32Array.from(C3), glow: Float32Array.from(GL),
    skin: Uint16Array.from(SK), wts: Float32Array.from(SW), idx: Uint32Array.from(IDX), cell: h,
  };
}

// ------------------------------------------------------------------ explicit parts
/**
 * Thin or flat pieces that a field cannot carry at creature resolution (insect
 * legs, claws, wing membranes, feathers, whiskers, antennae) and the eyes.
 * Same vertex layout as the skin, so the two merge into one mesh.
 */
export class Shapes {
  constructor() { this.P = []; this.N = []; this.C = []; this.GL = []; this.SK = []; this.SW = []; this.I = []; }
  get n() { return this.P.length / 3; }
  v(x, y, z, nx, ny, nz, c, g, b0, b1 = b0, w1 = 0) {
    this.P.push(x, y, z); this.N.push(nx, ny, nz); this.C.push(c[0], c[1], c[2]); this.GL.push(g);
    this.SK.push(b0, b1, 0, 0); this.SW.push(1 - w1, w1, 0, 0);
    return this.n - 1;
  }
  tri(a, b, c) { this.I.push(a, b, c); }
  /** Double-sided flat triangle (membranes, feathers). */
  tri2(p0, p1, p2, c0, c1, c2, g, bones) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const a = this.v(...p0, nx, ny, nz, c0, g[0], bones[0]), b = this.v(...p1, nx, ny, nz, c1, g[1], bones[1]), c = this.v(...p2, nx, ny, nz, c2, g[2], bones[2]);
    this.tri(a, b, c);
    const a2 = this.v(...p0, -nx, -ny, -nz, c0, g[0], bones[0]), b2 = this.v(...p1, -nx, -ny, -nz, c1, g[1], bones[1]), c2b = this.v(...p2, -nx, -ny, -nz, c2, g[2], bones[2]);
    this.tri(a2, c2b, b2);
  }
  /** Tapered tube from a to b (radius ra -> rb), smooth normals. */
  tube(a, b, ra, rb, c, b0, b1 = b0, sides = 5, g = 0, cap = true) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1e-6;
    const ax = dx / L, ay = dy / L, az = dz / L;
    // a perpendicular basis: axis x helper (up, or x when the tube is vertical)
    const hx = Math.abs(ay) < 0.9 ? 0 : 1, hy = Math.abs(ay) < 0.9 ? 1 : 0, hz = 0;
    let px = ay * hz - az * hy, py = az * hx - ax * hz, pz = ax * hy - ay * hx;
    const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
    const qx = ay * pz - az * py, qy = az * px - ax * pz, qz = ax * py - ay * px;
    const start = this.n;
    for (let s = 0; s < sides; s++) {
      const an = (s / sides) * Math.PI * 2, cs = Math.cos(an), sn = Math.sin(an);
      const nx = px * cs + qx * sn, ny = py * cs + qy * sn, nz = pz * cs + qz * sn;
      this.v(a[0] + nx * ra, a[1] + ny * ra, a[2] + nz * ra, nx, ny, nz, c, g, b0, b1, 0);
      this.v(b[0] + nx * rb, b[1] + ny * rb, b[2] + nz * rb, nx, ny, nz, c, g, b0, b1, b1 !== b0 ? 1 : 0);
    }
    for (let s = 0; s < sides; s++) {
      const i0 = start + s * 2, i1 = start + ((s + 1) % sides) * 2;
      this.tri(i0, i1, i0 + 1); this.tri(i1, i1 + 1, i0 + 1);
    }
    if (cap) {
      const tip = this.v(b[0] + ax * rb, b[1] + ay * rb, b[2] + az * rb, ax, ay, az, c, g, b1, b1, 0);
      for (let s = 0; s < sides; s++) { const i0 = start + s * 2 + 1, i1 = start + ((s + 1) % sides) * 2 + 1; this.tri(i0, i1, tip); }
    }
  }
  /** Cone (claws, spines, antennae tips). */
  cone(base, tip, r, c, bone, sides = 4, g = 0) { this.tube(base, tip, r, r * 0.08, c, bone, bone, sides, g, true); }
  /**
   * A Spore-style eye: a glossy ball with a coloured iris and a black pupil
   * (round, or a slit for ambush hunters) facing dir, centred at pos. Built on
   * its own bone, so the eye can look around and blink.
   */
  eye(pos, r, iris, pupilK, bone, glow = 0, slit = false, dir = [0, 0, 1]) {
    // basis: f along dir, s and u across it
    let fx = dir[0], fy = dir[1], fz = dir[2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let sx = fz, sy = 0, sz = -fx;                 // up x f
    let sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-4) { sx = 1; sy = 0; sz = 0; sl = 1; }
    sx /= sl; sy /= sl; sz /= sl;
    const ux = fy * sz - fz * sy, uy = fz * sx - fx * sz, uz = fx * sy - fy * sx;
    const rings = 8, segs = 12, start = this.n;
    const ringC = mix(iris, [0.02, 0.02, 0.03], 0.55);
    for (let i = 0; i <= rings; i++) {
      const th = (i / rings) * Math.PI;          // 0 = front
      const ct = Math.cos(th), st = Math.sin(th);
      for (let s = 0; s <= segs; s++) {
        const ph = (s / segs) * Math.PI * 2;
        const lx = st * Math.cos(ph), ly = st * Math.sin(ph), lz = ct;
        // pupil (round or slit), iris with a dark rim, white
        let c, g = 0;
        const ax = Math.abs(lx) * (slit ? 3.2 : 1), ay = Math.abs(ly);
        const rr = Math.hypot(ax, ay);
        if (lz > 0 && rr < 0.34 * pupilK) c = [0.02, 0.02, 0.03];
        else if (lz > 0 && st < 0.56) { c = iris; g = glow; }
        else if (lz > 0 && st < 0.66) c = ringC;
        else c = [0.94, 0.93, 0.9];
        const nx = sx * lx + ux * ly + fx * lz, ny = sy * lx + uy * ly + fy * lz, nz = sz * lx + uz * ly + fz * lz;
        this.v(pos[0] + nx * r, pos[1] + ny * r, pos[2] + nz * r, nx, ny, nz, c, g, bone);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let s = 0; s < segs; s++) {
        const a = start + i * (segs + 1) + s, b = a + segs + 1;
        this.tri(a, b, a + 1); this.tri(a + 1, b, b + 1);
      }
    }
    // a white catch-light, the spark that makes an eye look alive
    const hx = pos[0] + (fx * 0.75 + ux * 0.45 - sx * 0.3) * r * 1.02, hy = pos[1] + (fy * 0.75 + uy * 0.45 - sy * 0.3) * r * 1.02, hz = pos[2] + (fz * 0.75 + uz * 0.45 - sz * 0.3) * r * 1.02;
    const hr = r * 0.16, W = [1, 1, 1];
    const c0 = this.v(hx + ux * hr, hy + uy * hr, hz + uz * hr, fx, fy, fz, W, 0.6, bone);
    const c1 = this.v(hx - sx * hr, hy - sy * hr, hz - sz * hr, fx, fy, fz, W, 0.6, bone);
    const c2 = this.v(hx - ux * hr, hy - uy * hr, hz - uz * hr, fx, fy, fz, W, 0.6, bone);
    const c3 = this.v(hx + sx * hr, hy + sy * hr, hz + sz * hr, fx, fy, fz, W, 0.6, bone);
    this.tri(c0, c1, c2); this.tri(c0, c2, c3);
  }
  out() {
    return { pos: Float32Array.from(this.P), nrm: Float32Array.from(this.N), col: Float32Array.from(this.C), glow: Float32Array.from(this.GL), skin: Uint16Array.from(this.SK), wts: Float32Array.from(this.SW), idx: Uint32Array.from(this.I) };
  }
}

/** Concatenate meshes with the same layout. */
export function mergeMeshes(list) {
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.pos.length / 3; ni += m.idx.length; }
  const out = { pos: new Float32Array(nv * 3), nrm: new Float32Array(nv * 3), col: new Float32Array(nv * 3), glow: new Float32Array(nv), skin: new Uint16Array(nv * 4), wts: new Float32Array(nv * 4), idx: new Uint32Array(ni) };
  let ov = 0, oi = 0;
  for (const m of list) {
    const n = m.pos.length / 3;
    out.pos.set(m.pos, ov * 3); out.nrm.set(m.nrm, ov * 3); out.col.set(m.col, ov * 3); out.glow.set(m.glow, ov);
    out.skin.set(m.skin, ov * 4); out.wts.set(m.wts, ov * 4);
    for (let i = 0; i < m.idx.length; i++) out.idx[oi + i] = m.idx[i] + ov;
    ov += n; oi += m.idx.length;
  }
  return out;
}
