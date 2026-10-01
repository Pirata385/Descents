// Seeded vegetation and decoration templates (built inside chunk workers).
// Templates are small local-space meshes that the mesher stamps into chunk
// foliage/detail buffers with per-instance transforms and colour tints.
import { RNG } from '../core/rng.js';
import { Template } from './geomkit.js';
import { mixRGB } from '../core/mathutil.js';

const C = (r, g, b) => [r, g, b];

function grassTuft(rng, color, h = 0.6, blades = 5) {
  const t = new Template();
  for (let i = 0; i < blades; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0, 0.22);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const hh = h * rng.range(0.6, 1.2);
    const lean = rng.range(-0.25, 0.25);
    const w = rng.range(0.05, 0.09);
    const ba = rng.range(0, Math.PI);
    const dx = Math.cos(ba) * w, dz = Math.sin(ba) * w;
    const c0 = mixRGB(color, [0.1, 0.12, 0.05], 0.35);
    const tip = mixRGB(color, [0.95, 0.95, 0.6], rng.range(0, 0.25));
    const ia = t.vert(x - dx, 0, z - dz, 0, 1, 0, c0, 0.7, 0, 0);
    const ib = t.vert(x + dx, 0, z + dz, 0, 1, 0, c0, 0.7, 0, 0);
    const ic = t.vert(x + lean * Math.cos(a) * hh, hh, z + lean * Math.sin(a) * hh, 0, 1, 0, tip, 1, 0, 1);
    t.tri(ia, ib, ic);
  }
  return t.finish();
}

function flower(rng, petal) {
  const t = new Template();
  const h = rng.range(0.25, 0.55);
  const stem = [0.25, 0.45, 0.18];
  t.tube([0, 0, 0], [0, h, 0], 0.012, 0.01, 3, stem, stem, { sway1: 0.8 });
  const n = rng.int(4, 6);
  const pr = rng.range(0.05, 0.1);
  const center = t.vert(0, h + 0.02, 0, 0, 1, 0, [0.95, 0.85, 0.3], 1, 0.1, 0.8);
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push(t.vert(Math.cos(a) * pr, h - 0.01, Math.sin(a) * pr, 0, 1, 0, petal, 1, 0.05, 0.8));
  }
  for (let i = 0; i < n; i++) { t.tri(center, ring[i + 1], ring[i]); t.tri(center, ring[i], ring[i + 1]); }
  return t.finish();
}

function shrub(rng, color, berries = null, size = 1) {
  const t = new Template();
  const lobes = rng.int(2, 4);
  for (let i = 0; i < lobes; i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(0, 0.35) * size;
    const s = rng.range(0.45, 0.7) * size;
    const c = mixRGB(color, [0.9, 0.95, 0.5], rng.range(0, 0.15));
    t.blob(Math.cos(a) * r, s * 0.85, Math.sin(a) * r, s, s * 0.85, s, c, rng, { shadeTop: true, aoBottom: true, sway: 0.15 });
  }
  if (berries) {
    for (let i = 0; i < 7; i++) {
      const a = rng.range(0, Math.PI * 2), r = rng.range(0.3, 0.6) * size;
      t.blob(Math.cos(a) * r, rng.range(0.4, 1.0) * size, Math.sin(a) * r, 0.06, 0.06, 0.06, berries, null, { emi: 0.05, sway: 0.15 });
    }
  }
  return t.finish();
}

function broadTree(rng, bark, leaf, scale = 1) {
  const t = new Template();
  const h = rng.range(3.5, 6.5) * scale;
  const lean = rng.range(-0.15, 0.15);
  const top = [lean * h, h, rng.range(-0.15, 0.15) * h];
  t.tube([0, -0.4, 0], top, 0.22 * scale, 0.12 * scale, 6, mixRGB(bark, [0, 0, 0], 0.2), bark, { sway1: 0.1 });
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(0.4, 1.3) * scale;
    const s = rng.range(1.1, 1.8) * scale;
    const c = mixRGB(leaf, [0.85, 0.9, 0.4], rng.range(0, 0.18));
    t.blob(top[0] + Math.cos(a) * r, top[1] + rng.range(-0.6, 0.8) * scale, top[2] + Math.sin(a) * r, s, s * 0.8, s, c, rng, { shadeTop: true, aoBottom: true, sway: 0.25, subdiv: false });
  }
  return t.finish();
}

function conifer(rng, bark, leaf, scale = 1) {
  const t = new Template();
  const h = rng.range(6, 10) * scale;
  t.tube([0, -0.4, 0], [0, h * 0.35, 0], 0.2 * scale, 0.15 * scale, 5, bark, bark);
  const tiers = rng.int(3, 5);
  for (let i = 0; i < tiers; i++) {
    const y0 = h * (0.25 + (i / tiers) * 0.6);
    const r = (1 - i / tiers) * 1.8 * scale + 0.4;
    const c = mixRGB(leaf, [0.1, 0.2, 0.1], i * 0.05);
    t.tube([0, y0, 0], [0, y0 + h * 0.32, 0], r, 0, 7, c, mixRGB(c, [0.8, 0.9, 0.6], 0.15), { ao0: 0.6, sway1: 0.2 });
  }
  return t.finish();
}

function paleTree(rng, bark, leaf, scale = 1) {
  // tall white-barked tree of the Stone Plain with a sparse, wide crown
  const t = new Template();
  const h = rng.range(7, 13) * scale;
  const pts = [[0, -0.5, 0]];
  let x = 0, z = 0;
  for (let i = 1; i <= 4; i++) { x += rng.range(-0.5, 0.5); z += rng.range(-0.5, 0.5); pts.push([x, (h * i) / 4, z]); }
  for (let i = 0; i < 4; i++) t.tube(pts[i], pts[i + 1], (0.35 - i * 0.06) * scale, (0.3 - i * 0.06) * scale, 6, bark, bark, { sway1: i * 0.03 });
  const n = rng.int(4, 7);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const r = rng.range(1.5, 3.2) * scale;
    const end = [x + Math.cos(a) * r, h + rng.range(-1, 1.5), z + Math.sin(a) * r];
    t.tube(pts[3], end, 0.12 * scale, 0.05 * scale, 4, bark, bark, { sway1: 0.15 });
    t.blob(end[0], end[1] + 0.3, end[2], 1.3 * scale, 0.7 * scale, 1.3 * scale, mixRGB(leaf, [0.7, 0.9, 0.9], rng.range(0, 0.2)), rng, { shadeTop: true, sway: 0.3 });
  }
  return t.finish();
}

function fern(rng, color) {
  const t = new Template();
  const n = rng.int(5, 8);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const len = rng.range(0.6, 1.1);
    const ca = Math.cos(a), sa = Math.sin(a);
    const w = 0.12;
    const c = mixRGB(color, [0.7, 0.9, 0.3], rng.range(0, 0.2));
    t.card([-sa * w * 0.3, 0, ca * w * 0.3], [sa * w * 0.3, 0, -ca * w * 0.3], [ca * len + sa * w, len * 0.55, sa * len - ca * w], [ca * len - sa * w, len * 0.55, sa * len + ca * w], c, { sway0: 0, sway1: 0.7 });
    t.card([ca * len - sa * w, len * 0.55, sa * len + ca * w], [ca * len + sa * w, len * 0.55, sa * len - ca * w], [ca * len * 1.5, len * 0.35, sa * len * 1.5], [ca * len * 1.5, len * 0.35, sa * len * 1.5], c, { sway0: 0.7, sway1: 1 });
  }
  return t.finish();
}

function reed(rng, color) {
  const t = new Template();
  for (let i = 0; i < 6; i++) {
    const x = rng.range(-0.3, 0.3), z = rng.range(-0.3, 0.3), h = rng.range(0.9, 1.7);
    t.tube([x, -0.2, z], [x + rng.range(-0.1, 0.1), h, z + rng.range(-0.1, 0.1)], 0.02, 0.01, 3, color, mixRGB(color, [0.8, 0.7, 0.4], 0.4), { sway1: 1 });
    if (rng.chance(0.5)) t.tube([x, h * 0.85, z], [x, h * 1.02, z], 0.045, 0.03, 4, [0.4, 0.28, 0.16], [0.35, 0.24, 0.14], { sway0: 0.9, sway1: 1 });
  }
  return t.finish();
}

function crop(rng, color) {
  const t = new Template();
  for (let i = 0; i < 6; i++) {
    const x = rng.range(-0.35, 0.35), z = rng.range(-0.35, 0.35), h = rng.range(0.6, 0.9);
    t.tube([x, 0, z], [x, h, z], 0.02, 0.015, 3, mixRGB(color, [0.3, 0.4, 0.1], 0.4), color, { sway1: 0.9 });
    t.blob(x, h + 0.06, z, 0.04, 0.1, 0.04, mixRGB(color, [1, 0.9, 0.5], 0.3), null, { sway: 1 });
  }
  return t.finish();
}

function mushroom(rng, cap, glow) {
  const t = new Template();
  const n = rng.int(1, 4);
  for (let i = 0; i < n; i++) {
    const x = rng.range(-0.3, 0.3), z = rng.range(-0.3, 0.3), h = rng.range(0.15, 0.55);
    t.tube([x, 0, z], [x, h, z], 0.04, 0.035, 5, [0.85, 0.82, 0.75], [0.9, 0.88, 0.8], { emi1: glow * 0.4 });
    t.tube([x, h - 0.02, z], [x, h + 0.12, z], h * 0.45 + 0.05, 0.02, 7, cap, mixRGB(cap, [1, 1, 1], 0.2), { emi0: glow, emi1: glow, cap1: false, ao0: 0.7 });
  }
  return t.finish();
}

function rockLump(rng, color, size = 1) {
  const t = new Template();
  t.blob(0, size * 0.25, 0, size * rng.range(0.5, 0.9), size * rng.range(0.3, 0.55), size * rng.range(0.5, 0.9), color, rng, { jitter: 0.3, shadeTop: true, aoBottom: true });
  return t.finish();
}

function vine(rng, color, len) {
  const t = new Template();
  const n = 4;
  let x = 0, z = 0;
  for (let i = 0; i < n; i++) {
    const y0 = -(i / n) * len, y1 = -((i + 1) / n) * len;
    const nx = x + rng.range(-0.15, 0.15), nz = z + rng.range(-0.15, 0.15);
    const w = 0.18 * (1 - i / n * 0.5);
    const c0 = mixRGB(color, [0.05, 0.1, 0.05], 0.2 + i * 0.05);
    t.card([x - w, y0, z], [x + w, y0, z], [nx + w * 0.8, y1, nz], [nx - w * 0.8, y1, nz], c0, { sway0: i / n, sway1: (i + 1) / n, c0 });
    t.card([x, y0, z - w], [x, y0, z + w], [nx, y1, nz + w * 0.8], [nx, y1, nz - w * 0.8], c0, { sway0: i / n, sway1: (i + 1) / n, c0 });
    x = nx; z = nz;
  }
  // glowing bulb at the tip sometimes
  if (rng.chance(0.3)) t.blob(x, -len - 0.1, z, 0.12, 0.16, 0.12, [0.7, 1, 0.9], null, { emi: 0.9, sway: 1 });
  return t.finish();
}

/** Upside-down tree hanging from a ceiling. Local origin at the root; grows toward -y. */
function invertedTree(rng, bark, leaf, glow, detail) {
  const t = new Template();
  const L = 1; // unit length; scaled per instance
  const sides = detail ? 6 : 4;
  // root flare at the ceiling
  t.blob(0, 0.02, 0, 0.14, 0.05, 0.14, mixRGB(bark, [0, 0, 0], 0.2), rng, { jitter: 0.25 });
  const trunk = [[0, 0, 0]];
  let x = 0, z = 0;
  const segs = detail ? 5 : 3;
  for (let i = 1; i <= segs; i++) {
    x += rng.range(-0.03, 0.03); z += rng.range(-0.03, 0.03);
    trunk.push([x, -L * 0.75 * (i / segs), z]);
  }
  for (let i = 0; i < segs; i++) {
    const r0 = 0.06 * (1 - i / segs * 0.6), r1 = 0.06 * (1 - (i + 1) / segs * 0.6);
    t.tube(trunk[i], trunk[i + 1], r0, r1, sides, bark, mixRGB(bark, [1, 1, 1], 0.08), { sway1: (i + 1) / segs * 0.2 });
  }
  // branches spreading downward and outward, foliage clusters at their tips
  const nb = detail ? rng.int(5, 8) : 4;
  for (let i = 0; i < nb; i++) {
    const at = trunk[Math.min(segs, 1 + Math.floor(rng.range(0.3, 1) * segs))];
    const a = (i / nb) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const r = rng.range(0.18, 0.38);
    const end = [at[0] + Math.cos(a) * r, at[1] - rng.range(0.1, 0.3), at[2] + Math.sin(a) * r];
    t.tube(at, end, 0.025, 0.012, Math.max(3, sides - 2), bark, bark, { sway0: 0.15, sway1: 0.5 });
    const fc = mixRGB(leaf, [0.6, 0.9, 0.9], rng.range(0, 0.2));
    t.blob(end[0], end[1] - 0.06, end[2], rng.range(0.1, 0.16), rng.range(0.12, 0.2), rng.range(0.1, 0.16), fc, detail ? rng : null, { shadeTop: false, sway: 0.6, subdiv: false });
    if (detail && rng.chance(0.6)) {
      // hanging glow pods
      t.blob(end[0], end[1] - 0.2, end[2], 0.025, 0.04, 0.025, glow, null, { emi: 1, sway: 0.9 });
    }
  }
  // crown at the bottom
  t.blob(trunk[segs][0], trunk[segs][1] - 0.08, trunk[segs][2], 0.24, 0.2, 0.24, leaf, detail ? rng : null, { sway: 0.5, subdiv: !!detail });
  return t.finish();
}

/** Tree growing sideways out of a cliff face, tips drooping. Local +x is away from the wall. */
function cliffTree(rng, bark, leaf, detail) {
  const t = new Template();
  const pts = [[-0.5, 0, 0], [0.8, 0.2, 0], [2.0, 0.1, rng.range(-0.3, 0.3)], [3.0, -0.4, rng.range(-0.4, 0.4)]];
  for (let i = 0; i < 3; i++) t.tube(pts[i], pts[i + 1], 0.32 - i * 0.07, 0.25 - i * 0.07, detail ? 6 : 4, bark, bark, { sway1: 0.1 * i });
  const n = detail ? 5 : 3;
  for (let i = 0; i < n; i++) {
    const p = pts[1 + (i % 3)];
    t.blob(p[0] + rng.range(-0.3, 0.6), p[1] - rng.range(0.3, 1.0), p[2] + rng.range(-0.8, 0.8), rng.range(0.6, 1.0), rng.range(0.7, 1.3), rng.range(0.6, 1.0), mixRGB(leaf, [0.5, 0.8, 0.7], rng.range(0, 0.2)), rng, { sway: 0.5 });
  }
  return t.finish();
}

// ---------- decor ----------
function lantern() {
  const t = new Template();
  const wood = [0.3, 0.22, 0.15];
  t.box(-0.08, -0.5, -0.08, 0.08, 3.0, 0.08, wood);
  t.box(-0.08, 2.9, -0.08, 0.6, 3.0, 0.08, wood);
  t.box(0.38, 2.3, -0.13, 0.62, 2.75, 0.13, [1.0, 0.8, 0.45], { emi: 1 });
  t.flag = 1; // night glow
  return t.finish();
}
function crates(rng) {
  const t = new Template();
  const wood = [0.55, 0.42, 0.26];
  const n = rng.int(2, 5);
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.6, 1.0);
    const x = rng.range(-1, 1), z = rng.range(-0.8, 0.8), y = i > 2 ? s : 0;
    t.box(x - s / 2, y, z - s / 2, x + s / 2, y + s, z + s / 2, mixRGB(wood, [0.3, 0.2, 0.1], rng.range(0, 0.4)));
  }
  return t.finish();
}
function barrels(rng) {
  const t = new Template();
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const x = rng.range(-0.8, 0.8), z = rng.range(-0.6, 0.6);
    t.tube([x, 0, z], [x, 0.5, z], 0.32, 0.36, 8, [0.45, 0.3, 0.18], [0.5, 0.34, 0.2]);
    t.tube([x, 0.5, z], [x, 1.0, z], 0.36, 0.32, 8, [0.5, 0.34, 0.2], [0.45, 0.3, 0.18], { cap1: true });
  }
  return t.finish();
}
function stall(rng, awning) {
  const t = new Template();
  const wood = [0.45, 0.32, 0.2];
  for (const [x, z] of [[-1.3, -0.9], [1.3, -0.9], [-1.3, 0.9], [1.3, 0.9]]) t.box(x - 0.06, 0, z - 0.06, x + 0.06, 2.4, z + 0.06, wood);
  t.box(-1.35, 0.8, -0.9, 1.35, 0.95, 0.4, [0.55, 0.42, 0.28]);
  // striped awning
  for (let i = 0; i < 6; i++) {
    const x0 = -1.5 + i * 0.5, x1 = x0 + 0.5;
    const c = i % 2 ? [0.95, 0.92, 0.85] : awning;
    t.card([x0, 2.4, 1.1], [x1, 2.4, 1.1], [x1, 2.7, -1.1], [x0, 2.7, -1.1], c, { ao0: 0.9, sway0: 0.05, sway1: 0.05 });
  }
  // goods
  for (let i = 0; i < 5; i++) t.blob(rng.range(-1.1, 1.1), 1.05, rng.range(-0.7, 0.2), 0.15, 0.12, 0.15, [rng.range(0.4, 1), rng.range(0.3, 0.9), rng.range(0.1, 0.5)], null, {});
  return t.finish();
}
function railing(len) {
  const t = new Template();
  const wood = [0.42, 0.3, 0.2];
  const n = Math.max(1, Math.round(len / 2));
  for (let i = 0; i <= n; i++) {
    const x = -len / 2 + (i / n) * len;
    t.box(x - 0.06, 0, -0.06, x + 0.06, 1.1, 0.06, wood);
  }
  t.box(-len / 2, 1.0, -0.05, len / 2, 1.12, 0.05, wood);
  t.box(-len / 2, 0.55, -0.04, len / 2, 0.63, 0.04, wood);
  return t.finish();
}
function banner(color) {
  const t = new Template();
  t.box(-0.05, 0, -0.05, 0.05, 3.5, 0.05, [0.3, 0.25, 0.2]);
  t.card([0.05, 3.4, 0], [1.2, 3.4, 0], [1.1, 1.6, 0], [0.05, 1.6, 0], color, { sway0: 0.3, sway1: 1, c0: color });
  return t.finish();
}
function flag(color) {
  const t = new Template();
  t.box(-0.06, 0, -0.06, 0.06, 6, 0.06, [0.35, 0.3, 0.25]);
  t.card([0.06, 5.9, 0], [2.0, 5.7, 0], [2.0, 4.7, 0], [0.06, 4.6, 0], color, { sway0: 0.4, sway1: 1, c0: color });
  return t.finish();
}
function crane() {
  const t = new Template();
  const wood = [0.4, 0.3, 0.2];
  t.box(-0.2, 0, -0.2, 0.2, 7, 0.2, wood);
  t.tube([0, 6.6, 0], [0, 7.4, 6.5], 0.12, 0.08, 4, wood, wood);
  t.tube([0, 7.4, 6.5], [0, -14, 6.6], 0.02, 0.02, 3, [0.6, 0.55, 0.45], [0.6, 0.55, 0.45], { sway1: 0.3 });
  t.box(-0.5, -14.6, 6.1, 0.5, -13.8, 7.1, [0.5, 0.36, 0.22], { sway: 0.3 });
  return t.finish();
}
function telescope() {
  const t = new Template();
  t.tube([0, 0, 0], [-0.4, 1.0, 0], 0.03, 0.03, 4, [0.3, 0.25, 0.2], [0.3, 0.25, 0.2]);
  t.tube([0, 0, 0], [0.3, 1.0, 0.3], 0.03, 0.03, 4, [0.3, 0.25, 0.2], [0.3, 0.25, 0.2]);
  t.tube([0, 0, 0], [0.3, 1.0, -0.3], 0.03, 0.03, 4, [0.3, 0.25, 0.2], [0.3, 0.25, 0.2]);
  t.tube([-0.2, 1.0, -0.5], [0.3, 1.25, 0.9], 0.07, 0.1, 8, [0.72, 0.55, 0.3], [0.8, 0.62, 0.35], { cap1: true });
  return t.finish();
}
function tent(color) {
  const t = new Template();
  t.tube([0, 0, 0], [0, 2.4, 0], 1.7, 0.05, 6, color, mixRGB(color, [1, 1, 1], 0.2), { ao0: 0.6 });
  return t.finish();
}
function fountainStatue(rng) {
  const t = new Template();
  t.blob(0, 2.6, 0, 0.35, 0.5, 0.35, [0.7, 0.7, 0.66], rng, {});
  t.blob(0, 3.2, 0, 0.22, 0.25, 0.22, [0.72, 0.72, 0.68], rng, {});
  return t.finish();
}
function anchorPost() {
  const t = new Template();
  t.box(-0.15, 0, -0.15, 0.15, 1.6, 0.15, [0.45, 0.42, 0.4]);
  t.tube([0, 1.6, 0], [0, 1.9, 0], 0.25, 0.25, 8, [0.75, 0.6, 0.3], [0.75, 0.6, 0.3]);
  t.box(-0.06, 1.95, -0.06, 0.06, 2.6, 0.06, [0.9, 0.3, 0.2]);
  return t.finish();
}

/** Build all templates for a world. */
export function buildFlora(params) {
  const rng = RNG.derive(params.seed, 'flora');
  const pal = params.palette, fol = params.foliage;
  const T = { grass: [], meadow: [], moss: [], flowers: [], shrubs: [], berry: [], trees: [], conifers: [], pale: [], ferns: [], reeds: [], crops: [], mush: [], glowMush: [], rocks: [], vines: [], inv: [], invLow: [], cliff: [], cliffLow: [], treesLow: [] };
  for (let i = 0; i < 4; i++) T.grass.push(grassTuft(rng, pal[1], 0.55, 5));
  for (let i = 0; i < 4; i++) T.meadow.push(grassTuft(rng, pal[28], 0.75, 6));
  for (let i = 0; i < 3; i++) T.moss.push(grassTuft(rng, mixRGB(pal[6], [0.4, 0.7, 0.5], 0.2), 0.35, 6));
  for (const c of fol.flowers) T.flowers.push(flower(rng, c));
  for (let i = 0; i < 3; i++) T.shrubs.push(shrub(rng, fol.l1, null, rng.range(0.8, 1.2)));
  for (let i = 0; i < 2; i++) T.berry.push(shrub(rng, mixRGB(fol.inverted, fol.l1, 0.4), [0.8, 0.12, 0.15], rng.range(0.8, 1.1)));
  for (let i = 0; i < 3; i++) T.trees.push(broadTree(rng, fol.bark, i % 2 ? fol.l1 : fol.l1b, rng.range(0.9, 1.2)));
  for (let i = 0; i < 2; i++) T.conifers.push(conifer(rng, fol.bark, mixRGB(fol.l1b, [0.1, 0.25, 0.15], 0.4), rng.range(0.9, 1.2)));
  for (let i = 0; i < 2; i++) T.pale.push(paleTree(rng, fol.paleBark, fol.plainTree, rng.range(0.9, 1.2)));
  for (let i = 0; i < 3; i++) T.ferns.push(fern(rng, mixRGB(fol.inverted, [0.2, 0.5, 0.2], 0.4)));
  for (let i = 0; i < 2; i++) T.reeds.push(reed(rng, [0.45, 0.55, 0.25]));
  for (let i = 0; i < 2; i++) T.crops.push(crop(rng, pal[17]));
  for (let i = 0; i < 2; i++) T.mush.push(mushroom(rng, [0.6, 0.3, 0.2], 0));
  for (let i = 0; i < 2; i++) T.glowMush.push(mushroom(rng, fol.invertedGlow, 0.9));
  for (let i = 0; i < 3; i++) T.rocks.push(rockLump(rng, pal[3], rng.range(0.7, 1.4)));
  for (let i = 0; i < 3; i++) T.vines.push(vine(rng, mixRGB(fol.inverted, [0.15, 0.35, 0.2], 0.4), 1));
  for (let i = 0; i < 4; i++) T.inv.push(invertedTree(rng, fol.paleBark, fol.inverted, fol.invertedGlow, true));
  for (let i = 0; i < 2; i++) T.invLow.push(invertedTree(rng, fol.paleBark, fol.inverted, fol.invertedGlow, false));
  for (let i = 0; i < 3; i++) T.cliff.push(cliffTree(rng, fol.bark, fol.inverted, true));
  T.cliffLow.push(cliffTree(rng, fol.bark, fol.inverted, false));
  for (let i = 0; i < 2; i++) T.treesLow.push(broadTree(rng, fol.bark, fol.l1, 1));
  const awnings = [[0.8, 0.25, 0.2], [0.25, 0.45, 0.75], [0.85, 0.65, 0.2], [0.3, 0.6, 0.35], [0.6, 0.3, 0.6], [0.9, 0.5, 0.3]];
  T.decor = {
    lantern: lantern(), crates: [crates(rng), crates(rng)], barrels: [barrels(rng), barrels(rng)],
    stall: awnings.map((a) => stall(rng, a)), telescope: telescope(), crane: crane(),
    tent: [tent([0.85, 0.8, 0.68]), tent([0.6, 0.35, 0.25])], banner: banner(pal[10]), flag: flag(pal[24]),
    fountain: fountainStatue(rng), anchor: anchorPost(),
  };
  T.railing = (len) => railing(len);
  return T;
}

void C;
