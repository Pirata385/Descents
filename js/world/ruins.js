// Ancient ruins and natural formations. Ruins are assembled from structure
// primitives with seeded "decay" so each one is unique. Natural formations
// (arches, spires, monoliths, crystal clusters) follow terrain rules of
// their layer. Each ruin exposes artifact spots in contextually sensible places.
import { RNG } from '../core/rng.js';
import { TAU, clamp } from '../core/mathutil.js';
import { M } from './materials.js';
import { box, cyl, cone, dome, ring, arch, matPatch, spire, flat, OP_ADD, OP_CARVE } from './structures.js';

/** Ruin builders. Each returns { prims, spots: [{u, v, dy, context}], name, type } in local coords. */
function ruinPillarCircle(rng, y, mat) {
  const prims = [], spots = [];
  const n = rng.int(6, 12);
  const R = rng.range(6, 11);
  for (let i = 0; i < n; i++) {
    if (rng.chance(0.18)) continue;
    const a = (i / n) * TAU;
    const h = rng.chance(0.3) ? rng.range(1, 3) : rng.range(4, 9);
    prims.push({ k: 'cyl', u: Math.cos(a) * R, v: Math.sin(a) * R, r: rng.range(0.7, 1.2), y0: -2, y1: h, mat });
    if (h > 6 && rng.chance(0.4) && i + 1 < n) {
      const a2 = ((i + 1) / n) * TAU;
      prims.push({ k: 'lintel', u: (Math.cos(a) + Math.cos(a2)) * R / 2, v: (Math.sin(a) + Math.sin(a2)) * R / 2, ang: (a + a2) / 2 + Math.PI / 2, hw: R * Math.sin(Math.PI / n) + 0.8, hd: 0.7, y0: h - 0.8, y1: h + 0.2, mat });
    }
  }
  prims.push({ k: 'box', u: 0, v: 0, ang: 0, hw: 1.6, hd: 1.0, y0: -1, y1: 1.0, mat });
  spots.push({ u: 0, v: 0, dy: 1.0, context: 'on an altar in a ring of standing stones' });
  return { prims, spots, type: 'circle', radius: R + 2, label: rng.pick(['Stone Circle', 'Ring of Pillars', 'Henge']) };
}

function ruinCompound(rng, y, mat) {
  const prims = [], spots = [];
  const hw = rng.range(7, 14), hd = rng.range(6, 11);
  const nu = rng.int(1, 3), nv = rng.int(1, 2);
  const wallH = rng.range(2.5, 6);
  prims.push({ k: 'patch', u: 0, v: 0, ang: 0, hw, hd, mat: M.RUIN });
  const seg = (u0, v0, u1, v1) => {
    const len = Math.hypot(u1 - u0, v1 - v0);
    const n = Math.ceil(len / 2);
    for (let i = 0; i < n; i++) {
      if (rng.chance(0.18)) continue; // collapsed section / doorway
      const t0 = i / n, t1 = (i + 1) / n;
      const h = wallH * rng.range(0.25, 1.0);
      prims.push({ k: 'box', u: u0 + (u1 - u0) * (t0 + t1) / 2, v: v0 + (v1 - v0) * (t0 + t1) / 2, ang: Math.atan2(v1 - v0, u1 - u0), hw: len / n / 2 + 0.3, hd: 0.55, y0: -2, y1: h, mat });
    }
  };
  seg(-hw, -hd, hw, -hd); seg(-hw, hd, hw, hd); seg(-hw, -hd, -hw, hd); seg(hw, -hd, hw, hd);
  for (let i = 1; i < nu; i++) { const u = -hw + (2 * hw * i) / nu; seg(u, -hd, u, hd); }
  for (let j = 1; j < nv; j++) { const v = -hd + (2 * hd * j) / nv; seg(-hw, v, hw, v); }
  const su = rng.range(-hw + 2, hw - 2), sv = rng.range(-hd + 2, hd - 2);
  prims.push({ k: 'box', u: su, v: sv, ang: 0, hw: 0.8, hd: 0.8, y0: -1, y1: 0.5, mat });
  spots.push({ u: su, v: sv, dy: 0.5, context: 'in a collapsed chamber of an ancient compound' });
  return { prims, spots, type: 'compound', radius: Math.hypot(hw, hd) + 1, label: rng.pick(['Ruined Compound', 'Old Halls', 'Broken Walls', 'Sunken Court']) };
}

function ruinTower(rng, y, mat) {
  const prims = [], spots = [];
  const R = rng.range(3.5, 6);
  const H = rng.range(7, 18);
  prims.push({ k: 'ring', u: 0, v: 0, r: R, ri: R - 1.1, y0: -2, y1: H * rng.range(0.5, 0.75), mat });
  // broken upper part: partial ring segments
  for (let i = 0; i < 6; i++) {
    if (rng.chance(0.45)) continue;
    const a = (i / 6) * TAU;
    prims.push({ k: 'box', u: Math.cos(a) * (R - 0.55), v: Math.sin(a) * (R - 0.55), ang: a + Math.PI / 2, hw: R * 0.55, hd: 0.55, y0: H * 0.5, y1: H * rng.range(0.75, 1.0), mat });
  }
  const da = rng.range(0, TAU);
  prims.push({ k: 'carve', u: Math.cos(da) * R, v: Math.sin(da) * R, ang: da, hw: 1.4, hd: 1.0, y0: 0, y1: 2.8 });
  prims.push({ k: 'box', u: 0, v: 0, ang: 0, hw: 0.9, hd: 0.9, y0: -1, y1: 0.4, mat });
  spots.push({ u: 0, v: 0, dy: 0.4, context: 'inside the shell of a fallen tower' });
  return { prims, spots, type: 'tower', radius: R + 2, label: rng.pick(['Fallen Tower', 'Broken Spire', 'Watchtower Ruin']) };
}

function ruinPyramid(rng, y, mat) {
  const prims = [], spots = [];
  const tiers = rng.int(3, 5);
  let hw = rng.range(8, 13), hd = hw * rng.range(0.8, 1.0);
  let top = 0;
  for (let t = 0; t < tiers; t++) {
    const h = rng.range(1.5, 2.5);
    prims.push({ k: 'box', u: 0, v: 0, ang: 0, hw, hd, y0: -2, y1: top + h, mat });
    top += h;
    hw -= rng.range(1.5, 2.4); hd -= rng.range(1.5, 2.4);
    if (hw < 2 || hd < 2) break;
  }
  // stair cut up one side
  prims.push({ k: 'stairs', u: 0, v: 0, hw: 1.3, top, mat });
  // decay: bites out of the corners
  for (let i = 0; i < 3; i++) prims.push({ k: 'carve', u: rng.range(-8, 8), v: rng.range(-8, 8), ang: rng.range(0, TAU), hw: rng.range(1, 2.5), hd: rng.range(1, 2.5), y0: rng.range(0, top), y1: top + 3 });
  spots.push({ u: 0, v: 0, dy: top, context: 'atop a stepped ziggurat' });
  return { prims, spots, type: 'pyramid', radius: 14, label: rng.pick(['Step Pyramid', 'Ziggurat', 'Terraced Shrine']) };
}

function ruinGate(rng, y, mat) {
  const prims = [], spots = [];
  const span = rng.range(5, 9);
  const h = rng.range(6, 11);
  prims.push({ k: 'box', u: -span / 2 - 0.9, v: 0, ang: 0, hw: 0.9, hd: 1.1, y0: -2, y1: h, mat });
  prims.push({ k: 'box', u: span / 2 + 0.9, v: 0, ang: 0, hw: 0.9, hd: 1.1, y0: -2, y1: h, mat });
  prims.push({ k: 'arch', u: -span / 2 - 0.9, v: 0, bu: span / 2 + 0.9, bv: 0, y0: h - 1, yb: h - 1, bulge: rng.range(1, 2.5), thick: 1.2, width: 1.1, mat });
  prims.push({ k: 'box', u: 0, v: rng.range(3, 5), ang: 0, hw: 1, hd: 0.7, y0: -1, y1: 0.6, mat });
  spots.push({ u: 0, v: 4, dy: 0.6, context: 'at the foot of an ancient gateway' });
  return { prims, spots, type: 'gate', radius: span + 4, label: rng.pick(['Lonely Gate', 'Ancient Arch', 'Threshold Arch']) };
}

function ruinShrine(rng, y, mat) {
  // domed shrine (layer 2 style)
  const prims = [], spots = [];
  const R = rng.range(4, 7);
  prims.push({ k: 'ring', u: 0, v: 0, r: R, ri: R - 1, y0: -2, y1: R * 0.7, mat });
  prims.push({ k: 'dome', u: 0, v: 0, r: R + 0.3, y0: R * 0.7, h: R * 0.8, mat });
  const da = rng.range(0, TAU);
  prims.push({ k: 'carve', u: Math.cos(da) * R, v: Math.sin(da) * R, ang: da, hw: 1.3, hd: 1.2, y0: 0, y1: 2.9 });
  if (rng.chance(0.5)) prims.push({ k: 'carve', u: Math.cos(da + 2) * R, v: Math.sin(da + 2) * R, ang: da + 2, hw: 2, hd: 1.3, y0: 1, y1: R });
  prims.push({ k: 'box', u: 0, v: 0, ang: 0, hw: 0.9, hd: 0.9, y0: -1, y1: 0.5, mat });
  spots.push({ u: 0, v: 0, dy: 0.5, context: 'in a domed shrine of abyssal masonry' });
  return { prims, spots, type: 'shrine', radius: R + 2, label: rng.pick(['Domed Shrine', 'Hollow Sanctum', 'Silent Chapel']) };
}

function ruinObelisks(rng, y, mat) {
  const prims = [], spots = [];
  const n = rng.int(3, 7);
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, TAU), r = rng.range(2, 12);
    const h = rng.range(6, 18);
    const w = rng.range(0.7, 1.3);
    prims.push({ k: 'box', u: Math.cos(a) * r, v: Math.sin(a) * r, ang: rng.range(0, TAU), hw: w, hd: w, y0: -2, y1: h, mat });
    prims.push({ k: 'cone', u: Math.cos(a) * r, v: Math.sin(a) * r, r: w * 1.3, y0: h, h: w * 2, mat });
  }
  prims.push({ k: 'box', u: 0, v: 0, ang: 0, hw: 1.2, hd: 1.2, y0: -1, y1: 0.7, mat });
  spots.push({ u: 0, v: 0, dy: 0.7, context: 'among a field of obelisks' });
  return { prims, spots, type: 'obelisks', radius: 14, label: rng.pick(['Obelisk Field', 'Needle Garden', 'Standing Needles']) };
}

const L1_TYPES = [[ruinPillarCircle, 3], [ruinCompound, 4], [ruinTower, 3], [ruinPyramid, 1.5], [ruinGate, 2]];
const L2_TYPES = [[ruinShrine, 3], [ruinObelisks, 3], [ruinCompound, 2], [ruinTower, 1.5], [ruinGate, 1.5], [ruinPillarCircle, 1.5]];

/** Convert a local ruin description to world primitives. */
export function compileRuin(desc, x, y, z, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const W = (u, v) => [x + c * u - s * v, z + s * u + c * v];
  const out = [];
  out.push(flat(x, z, { r: desc.radius * 0.8, y0: y, feather: 4, top: M.GRAVEL }));
  for (const p of desc.prims) {
    const [px, pz] = W(p.u, p.v);
    const mat = p.mat;
    switch (p.k) {
      case 'cyl': out.push(cyl(OP_ADD, px, pz, { r: p.r, y0: y + p.y0, y1: y + p.y1, top: mat, side: mat })); break;
      case 'box': case 'lintel': out.push(box(OP_ADD, px, pz, { angle: ang + (p.ang || 0), hw: p.hw, hd: p.hd, y0: y + p.y0, y1: y + p.y1, top: mat, side: mat })); break;
      case 'ring': out.push(ring(px, pz, { r: p.r, ri: p.ri, y0: y + p.y0, y1: y + p.y1, top: mat, side: mat })); break;
      case 'dome': out.push(dome(px, pz, { r: p.r, y0: y + p.y0, h: p.h, top: mat, side: mat })); break;
      case 'cone': out.push(cone(px, pz, { r: p.r, y0: y + p.y0, h: p.h, top: mat, side: mat })); break;
      case 'carve': out.push(box(OP_CARVE, px, pz, { angle: ang + (p.ang || 0), hw: p.hw, hd: p.hd, y0: y + p.y0, y1: y + p.y1, top: M.GRAVEL, bot: M.RUIN })); break;
      case 'patch': out.push(matPatch(px, pz, { angle: ang, hw: p.hw, hd: p.hd, top: p.mat })); break;
      case 'arch': {
        const [bx, bz] = W(p.bu, p.bv);
        out.push(arch(px, pz, { bx, bz, y0: y + p.y0, yb: y + p.yb, bulge: p.bulge, thick: p.thick, width: p.width, top: mat, side: mat }));
        break;
      }
      case 'stairs': {
        // a straight stair up the side of a pyramid along local +v
        const steps = Math.ceil(p.top / 0.5);
        for (let i = 0; i < steps; i++) {
          const [sx, sz] = W(0, -12 + i * 1.0);
          out.push(box(OP_ADD, sx, sz, { angle: ang, hw: p.hw, hd: 0.55, y0: y - 2, y1: y + Math.min(p.top, (i + 1) * 0.5), top: mat, side: mat }));
        }
        break;
      }
      default: break;
    }
  }
  return out;
}

/**
 * Place Layer 1 ruins on the bowl surface and natural formations.
 * ctx.surface(x, z) -> {h, zone, t}, ctx.waterDist(x, z)
 */
export function generateL1Features(ctx) {
  const { field, params, names, waterDist } = ctx;
  const rng = RNG.derive(params.seed, 'ruins1');
  const out = { ruins: [], prims: [], landmarks: [], spires: [], arches: [] };
  const P = {}, S = {};
  const surf = (x, z) => { field.polar(x, z, P); if (!field.surface(x, z, P, S)) return null; return { h: S.h, P: { ...P } }; };
  const slopeAt = (x, z) => {
    const a = surf(x + 3, z), b = surf(x - 3, z), c = surf(x, z + 3), d = surf(x, z - 3);
    if (!a || !b || !c || !d) return 99;
    return Math.hypot(a.h - b.h, c.h - d.h) / 6;
  };
  const target = rng.int(15, 22);
  for (let tries = 0; out.ruins.length < target && tries < 1500; tries++) {
    const th = rng.range(-Math.PI, Math.PI);
    field.polar(Math.cos(th) * 500, Math.sin(th) * 500, P);
    const t = rng.range(0.1, 0.92);
    const [x, z] = field.fromPolar(P.Re + (P.Rr - P.Re) * t, th);
    const s = surf(x, z);
    if (!s || s.P.zone !== 1) continue;
    if (waterDist(x, z) < 16) continue;
    if (slopeAt(x, z) > 0.35) continue;
    if (out.ruins.some((r) => Math.hypot(r.x - x, r.z - z) < 70)) continue;
    const builder = rng.weighted(L1_TYPES);
    const lrng = RNG.derive(params.seed, 'ruin1', out.ruins.length);
    const desc = builder(lrng, s.h, M.RUIN);
    const y = Math.round(s.h * 2) / 2;
    const ang = rng.range(0, TAU);
    out.prims.push(...compileRuin(desc, x, y, z, ang));
    const name = `${desc.label} of ${names.name('ruin1', out.ruins.length)}`;
    const c = Math.cos(ang), sn = Math.sin(ang);
    const spots = desc.spots.map((sp) => ({ x: x + c * sp.u - sn * sp.v, z: z + sn * sp.u + c * sp.v, y: y + sp.dy, context: sp.context }));
    out.ruins.push({ x, z, y, name, type: desc.type, layer: 1, spots, radius: desc.radius });
    out.landmarks.push({ type: 'ruin', name, x, z, y, layer: 1 });
  }
  // Natural arches
  const nArch = rng.int(4, 8);
  for (let tries = 0; out.arches.length < nArch && tries < 600; tries++) {
    const th = rng.range(-Math.PI, Math.PI);
    field.polar(Math.cos(th) * 500, Math.sin(th) * 500, P);
    const t = rng.range(0.18, 0.88);
    const [x, z] = field.fromPolar(P.Re + (P.Rr - P.Re) * t, th);
    const a = rng.range(0, TAU);
    const len = rng.range(16, 34);
    const ax = x - Math.cos(a) * len / 2, az = z - Math.sin(a) * len / 2, bx = x + Math.cos(a) * len / 2, bz = z + Math.sin(a) * len / 2;
    const sa = surf(ax, az), sb = surf(bx, bz), sm = surf(x, z);
    if (!sa || !sb || !sm || sa.P.zone !== 1 || sb.P.zone !== 1) continue;
    if (waterDist(x, z) < 8) continue;
    const bulge = rng.range(6, 14) + Math.max(0, Math.max(sa.h, sb.h) - sm.h) * 0.5;
    out.prims.push(arch(ax, az, { bx, bz, y0: sa.h + 1, yb: sb.h + 1, bulge, thick: rng.range(2.4, 3.8), width: rng.range(2.2, 3.6), top: M.ROCK, side: M.ROCK }));
    out.arches.push({ x, z, y: (sa.h + sb.h) / 2 + bulge });
    if (out.arches.length <= 3) out.landmarks.push({ type: 'arch', name: `${names.name('arch', out.arches.length)} Arch`, x, z, y: (sa.h + sb.h) / 2 + bulge, layer: 1 });
  }
  // Rock spires near the eye (hard to reach; often crowned with an artifact)
  const nSp = rng.int(5, 8);
  for (let tries = 0; out.spires.length < nSp && tries < 600; tries++) {
    const th = rng.range(-Math.PI, Math.PI);
    field.polar(Math.cos(th) * 500, Math.sin(th) * 500, P);
    const t = rng.range(0.04, 0.3);
    const [x, z] = field.fromPolar(P.Re + (P.Rr - P.Re) * t, th);
    const s = surf(x, z);
    if (!s || s.P.zone !== 1) continue;
    if (out.spires.some((sp) => Math.hypot(sp.x - x, sp.z - z) < 40)) continue;
    const h = rng.range(18, 42), r = rng.range(3.5, 7);
    out.prims.push(spire(x, z, { r, y0: s.h, h, top: M.ROCK, side: M.ROCK }));
    // flat crown so something can rest on top
    out.prims.push(cyl(OP_ADD, x, z, { r: 1.6, y0: s.h, y1: s.h + h * (1 - 1.6 / r) + 0.5, top: M.ROCK, side: M.ROCK }));
    out.spires.push({ x, z, y: s.h + h * (1 - 1.6 / r) + 0.5, base: s.h });
    if (out.spires.length <= 2) out.landmarks.push({ type: 'spire', name: `The ${rng.pick(['Needle', 'Thorn', 'Fang', 'Finger'])} of ${names.name('spire', out.spires.length)}`, x, z, y: s.h + h, layer: 1 });
  }
  return out;
}

/**
 * Place Layer 2 ruins in galleries and on the Stone Plain, plus monoliths and
 * crystal clusters. ctx.floorIn(x, z, yTop, yBottom) returns the floor height in a band.
 */
export function generateL2Features(ctx) {
  const { field, params, names, floorIn, waterDist } = ctx;
  const avoidPts = ctx.avoidPts || [];
  const blocked = (x, z, r) => avoidPts.some((p) => Math.hypot(p.x - x, p.z - z) < r);
  const rng = RNG.derive(params.seed, 'ruins2');
  const out = { ruins: [], prims: [], landmarks: [], crystals: [], monoliths: [] };
  const P = {};
  // gallery ruins
  params.galleries.forEach((g, k) => {
    const n = rng.int(3, 6);
    for (let tries = 0, made = 0; made < n && tries < 300; tries++) {
      const th = rng.range(-Math.PI, Math.PI);
      const D = field.galleryDepth(k, th);
      if (D < 35) continue;
      field.polar(Math.cos(th) * 300, Math.sin(th) * 300, P);
      const [x, z] = field.fromPolar(P.Re + D * rng.range(0.25, 0.6), th);
      const y = floorIn(x, z, g.yTop, g.yTop - g.height - 15);
      if (y === null) continue;
      if (blocked(x, z, 30)) continue;
      if (out.ruins.some((r) => Math.hypot(r.x - x, r.z - z) < 50)) continue;
      const builder = rng.weighted(L2_TYPES);
      const desc = builder(RNG.derive(params.seed, 'ruin2', out.ruins.length), y, M.RUIN2);
      const yy = Math.round(y * 2) / 2;
      const ang = rng.range(0, TAU);
      out.prims.push(...compileRuin(desc, x, yy, z, ang));
      const name = `${desc.label} of ${names.name('ruin2', out.ruins.length)}`;
      const c = Math.cos(ang), sn = Math.sin(ang);
      out.ruins.push({ x, z, y: yy, name, type: desc.type, layer: 2, spots: desc.spots.map((sp) => ({ x: x + c * sp.u - sn * sp.v, z: z + sn * sp.u + c * sp.v, y: yy + sp.dy, context: sp.context })), radius: desc.radius });
      out.landmarks.push({ type: 'ruin', name, x, z, y: yy, layer: 2 });
      made++;
    }
  });
  // stone plain ruins, monoliths and rock formations
  const nPlain = rng.int(6, 10);
  for (let tries = 0, made = 0; made < nPlain && tries < 500; tries++) {
    const th = rng.range(-Math.PI, Math.PI);
    field.polar(Math.cos(th) * 300, Math.sin(th) * 300, P);
    const rr = rng.range(0.05, 0.75) * (P.Rb - 15);
    const [x, z] = field.fromPolar(rr, th);
    const fp = field.faultPolar(x, z, {});
    if (fp.fr < fp.Rf + 25) continue;
    if (waterDist(x, z) < 12) continue;
    const y = floorIn(x, z, params.plainY + 40, params.plainY - 20);
    if (y === null) continue;
    if (blocked(x, z, 30)) continue;
    if (out.ruins.some((r) => Math.hypot(r.x - x, r.z - z) < 60)) continue;
    const builder = rng.weighted(L2_TYPES);
    const desc = builder(RNG.derive(params.seed, 'ruinP', made), y, M.RUIN2);
    const yy = Math.round(y * 2) / 2;
    const ang = rng.range(0, TAU);
    out.prims.push(...compileRuin(desc, x, yy, z, ang));
    const name = `${desc.label} of ${names.name('ruinP', made)}`;
    const c = Math.cos(ang), sn = Math.sin(ang);
    out.ruins.push({ x, z, y: yy, name, type: desc.type, layer: 2, plain: true, spots: desc.spots.map((sp) => ({ x: x + c * sp.u - sn * sp.v, z: z + sn * sp.u + c * sp.v, y: yy + sp.dy, context: sp.context })), radius: desc.radius });
    out.landmarks.push({ type: 'ruin', name, x, z, y: yy, layer: 2 });
    made++;
  }
  const nMono = rng.int(10, 18);
  for (let tries = 0; out.monoliths.length < nMono && tries < 500; tries++) {
    const th = rng.range(-Math.PI, Math.PI);
    field.polar(Math.cos(th) * 300, Math.sin(th) * 300, P);
    const [x, z] = field.fromPolar(rng.range(0.1, 0.85) * (P.Rb - 10), th);
    const fp = field.faultPolar(x, z, {});
    if (fp.fr < fp.Rf + 12) continue;
    if (blocked(x, z, 25)) continue;
    const y = floorIn(x, z, params.plainY + 40, params.plainY - 20);
    if (y === null) continue;
    if (rng.chance(0.5)) {
      const h = rng.range(8, 26), r = rng.range(2.5, 6);
      out.prims.push(spire(x, z, { r, y0: y, h, top: M.STONEPLAIN, side: M.ROCK }));
    } else {
      out.prims.push(dome(x, z, { r: rng.range(3, 8), y0: y - 1, h: rng.range(2, 6), top: M.ROCK, side: M.ROCK }));
    }
    out.monoliths.push({ x, z, y });
  }
  // crystal clusters: gallery backs and plain edges ("unusual geological formations")
  const nCry = rng.int(8, 14);
  for (let tries = 0; out.crystals.length < nCry && tries < 800; tries++) {
    const th = rng.range(-Math.PI, Math.PI);
    const k = rng.int(0, params.galleries.length - 1);
    const g = params.galleries[k];
    const onPlain = rng.chance(0.35);
    let x, z, y;
    field.polar(Math.cos(th) * 300, Math.sin(th) * 300, P);
    if (onPlain) {
      [x, z] = field.fromPolar(P.Re + (P.Rb - P.Re) * rng.range(0.55, 0.85), th);
      y = floorIn(x, z, params.plainY + 60, params.plainY - 10);
    } else {
      const D = field.galleryDepth(k, th);
      if (D < 30) continue;
      [x, z] = field.fromPolar(P.Re + D * rng.range(0.7, 0.9), th);
      y = floorIn(x, z, g.yTop, g.yTop - g.height - 10);
    }
    if (y === null) continue;
    if (blocked(x, z, 22)) continue;
    const n = rng.int(4, 9);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, TAU), rr = rng.range(0, 3.5);
      const h = rng.range(1.5, 5.5);
      out.prims.push(spire(x + Math.cos(a) * rr, z + Math.sin(a) * rr, { r: rng.range(0.6, 1.4), y0: y, h, top: M.CRYSTAL, side: M.CRYSTAL }));
    }
    out.crystals.push({ x, z, y, layer: 2 });
    if (out.crystals.length <= 2) out.landmarks.push({ type: 'crystal', name: `${names.name('crystal', out.crystals.length)} Geode`, x, z, y, layer: 2 });
  }
  void clamp;
  return out;
}
