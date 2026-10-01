// Cave generation: meandering cave systems with chambers and branches,
// "through caves" that connect an upper terrace to the terrace below (a
// walkable route), and helical tunnels inside the shaft walls. Caves are
// stored as chains of capsules which the column generator subtracts.
import { RNG } from '../core/rng.js';
import { clamp, smoothstep, TAU } from '../core/mathutil.js';
import { Z_BOWL, Z_EYE } from './field.js';

export function coarseHeight(coarse, x, z) {
  const { cs, ox, oz, nx, nz, h } = coarse;
  const fx = clamp((x - ox) / cs - 0.5, 0, nx - 1.001), fz = clamp((z - oz) / cs - 0.5, 0, nz - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const a = h[j * nx + i], b = h[j * nx + i + 1], c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function surfaceAt(field, x, z) {
  const P = {}, S = {};
  field.polar(x, z, P);
  if (!field.surface(x, z, P, S)) return { h: NaN, P };
  return { h: S.h, P };
}

/** Meandering cave from a start point heading into the terrain. */
function wanderCave(rng, field, start, heading, length, baseR, cave, depthDepth = 0) {
  let { x, y, z } = start;
  let hd = heading;
  let pitch = -0.12;
  let r = baseR;
  let prev = cave.nodes.length;
  cave.nodes.push({ x, y, z, r: r * 0.85 });
  let travelled = 0;
  let step = 0;
  while (travelled < length) {
    const segLen = rng.range(5.5, 8.5);
    hd += rng.gauss(0, 0.32);
    pitch = clamp(pitch + rng.gauss(0, 0.12), -0.4, 0.12);
    r = clamp(r + rng.gauss(0, 0.35), 2.3, baseR + 1.4);
    const nx = x + Math.cos(hd) * segLen * Math.cos(pitch);
    const nz = z + Math.sin(hd) * segLen * Math.cos(pitch);
    let ny = y + Math.sin(pitch) * segLen;
    const s = surfaceAt(field, nx, nz);
    if (Number.isNaN(s.h) || s.P.zone === Z_EYE || s.P.r < s.P.Re + 12) break;
    // keep a rock roof after the mouth
    if (step > 1 && ny + r > s.h - 3.5) { ny = s.h - 3.5 - r; pitch = -0.2; }
    const ci = cave.nodes.length;
    cave.nodes.push({ x: nx, y: ny, z: nz, r });
    cave.links.push([prev, ci]);
    prev = ci;
    x = nx; y = ny; z = nz;
    travelled += segLen;
    step++;
    if (step > 3 && rng.chance(0.07)) {
      // chamber
      const cr = rng.range(6, 10.5);
      cave.nodes[ci].r = cr;
      cave.nodes[ci].chamber = true;
      cave.chambers.push(ci);
    }
    if (depthDepth < 1 && step > 2 && rng.chance(0.06)) {
      const branch = { x, y, z };
      const before = cave.nodes.length;
      wanderCave(rng, field, branch, hd + rng.sign() * rng.range(0.7, 1.6), rng.range(25, 70), baseR * 0.85, cave, depthDepth + 1);
      if (cave.nodes.length > before) cave.links.push([ci, before]);
    }
  }
  if (cave.nodes.length - 1 > 0) {
    const last = cave.nodes.length - 1;
    if (!cave.nodes[last].chamber && rng.chance(0.6)) {
      cave.nodes[last].r = rng.range(5.5, 9);
      cave.nodes[last].chamber = true;
      cave.chambers.push(last);
    }
  }
}

function gradient(coarse, x, z) {
  const e = 8;
  const gx = (coarseHeight(coarse, x + e, z) - coarseHeight(coarse, x - e, z)) / (2 * e);
  const gz = (coarseHeight(coarse, x, z + e) - coarseHeight(coarse, x, z - e)) / (2 * e);
  return [gx, gz];
}

export function generateCaves(field, coarse, params, names, hydroQuery) {
  const rng = RNG.derive(params.seed, 'caves');
  const caves = [];
  const P = {};
  // --- Layer 1 meandering caves, started on cliffs and hillsides
  const target = rng.int(22, 32);
  let attempts = 0;
  while (caves.filter((c) => c.kind === 'cave').length < target && attempts++ < 3000) {
    const a = rng.range(0, TAU);
    const rr = rng.range(0.15, 0.93);
    field.polar(Math.cos(a) * 500, Math.sin(a) * 500, P);
    const rad = P.Re + (P.Rr - P.Re) * rr;
    const [x, z] = field.fromPolar(rad, a);
    field.polar(x, z, P);
    if (P.zone !== Z_BOWL) continue;
    const [gx, gz] = gradient(coarse, x, z);
    const slope = Math.hypot(gx, gz);
    if (slope < 0.55 && !rng.chance(0.08)) continue;
    if (hydroQuery(x, z) < 14) continue;
    const s = surfaceAt(field, x, z);
    const heading = Math.atan2(gz, gx); // uphill: into the slope
    const cave = { id: caves.length, kind: 'cave', nodes: [], links: [], chambers: [], layer: 1 };
    wanderCave(rng, field, { x: x - Math.cos(heading) * 1.5, y: s.h - 1.2, z: z - Math.sin(heading) * 1.5 }, heading, rng.range(60, 220), rng.range(2.6, 3.9), cave);
    if (cave.nodes.length < 5) continue;
    cave.entrance = { x: cave.nodes[0].x, y: cave.nodes[0].y, z: cave.nodes[0].z };
    cave.name = names.name('cave', caves.length) + ' ' + rng.pick(['Caverns', 'Grotto', 'Hollows', 'Cave', 'Tunnels', 'Burrows']);
    caves.push(cave);
  }

  // --- Through caves: connect an upper terrace to the lower terrace (walkable, validated)
  const throughTarget = rng.int(3, 5);
  attempts = 0;
  let throughCount = 0;
  while (throughCount < throughTarget && attempts++ < 4000) {
    const a = rng.range(0, TAU);
    const rr = rng.range(0.22, 0.85);
    field.polar(Math.cos(a) * 500, Math.sin(a) * 500, P);
    const rad = P.Re + (P.Rr - P.Re) * rr;
    const [x, z] = field.fromPolar(rad, a);
    const [gx, gz] = gradient(coarse, x, z);
    const slope = Math.hypot(gx, gz);
    if (slope < 0.9) continue;
    const ux = gx / slope, uz = gz / slope; // uphill unit
    const top = surfaceAt(field, x + ux * 14, z + uz * 14);
    const bot = surfaceAt(field, x - ux * 12, z - uz * 12);
    if (Number.isNaN(top.h) || Number.isNaN(bot.h)) continue;
    const drop = top.h - bot.h;
    if (drop < 14 || drop > 55) continue;
    if (hydroQuery(x + ux * 14, z + uz * 14) < 12 || hydroQuery(x - ux * 12, z - uz * 12) < 10) continue;
    // Build a hairpin tunnel: leg 1 goes away from the cliff descending, turns, leg 2 comes back to the base.
    const slopeT = 0.32;
    const length = drop / slopeT;
    const legLen = length / 2 - 12;
    if (legLen < 15) continue;
    const side = rng.sign();
    const px = -uz * side, pz = ux * side; // perpendicular
    const nodes = [];
    const r0 = 2.7;
    const A = { x: x + ux * 14, z: z + uz * 14, y: top.h + r0 * 0.55 - 0.3 };
    const B = { x: x - ux * 10, z: z - uz * 10, y: bot.h + 1.4 };
    // leg 1: from A, heading uphill (away from cliff), descending
    const nLeg = Math.max(3, Math.round(legLen / 6));
    let y = A.y;
    const dy = slopeT * (legLen / nLeg);
    for (let i = 0; i <= nLeg; i++) {
      nodes.push({ x: A.x + ux * (i * legLen / nLeg), z: A.z + uz * (i * legLen / nLeg), y, r: r0 });
      y -= dy;
    }
    // hairpin: half circle of radius 7 to the side
    const hx = A.x + ux * legLen, hz = A.z + uz * legLen;
    const turnR = 7.5;
    for (let i = 1; i <= 5; i++) {
      const ang = (i / 5) * Math.PI;
      const cx = hx + px * turnR + (ux * Math.sin(ang) - px * Math.cos(ang)) * turnR;
      const cz = hz + pz * turnR + (uz * Math.sin(ang) - pz * Math.cos(ang)) * turnR;
      y -= slopeT * (Math.PI * turnR / 5);
      nodes.push({ x: cx, z: cz, y, r: r0 + 0.4 });
    }
    // leg 2: back toward the cliff base offset by 2*turnR to the side
    const sx = hx + px * 2 * turnR, sz = hz + pz * 2 * turnR;
    const ex = B.x + px * 2 * turnR, ez = B.z + pz * 2 * turnR;
    const bot2 = surfaceAt(field, ex, ez);
    if (Number.isNaN(bot2.h) || Math.abs(bot2.h - bot.h) > 4) continue;
    B.y = bot2.h + 1.4;
    const l2 = Math.hypot(ex - sx, ez - sz);
    const n2 = Math.max(3, Math.round(l2 / 6));
    const yStart = y;
    for (let i = 1; i <= n2; i++) {
      const t = i / n2;
      const yy = yStart + (B.y - yStart) * t;
      nodes.push({ x: sx + (ex - sx) * t, z: sz + (ez - sz) * t, y: yy, r: r0 });
    }
    // check slope of leg 2 is acceptable
    if ((yStart - B.y) / Math.max(1, l2) > 0.48 || yStart < B.y - 2) continue;
    // never float above the ground: floors stay at or below the terrain, descending monotonically
    let floatOk = true;
    for (let i = 0; i < nodes.length; i++) {
      const sfc = surfaceAt(field, nodes[i].x, nodes[i].z);
      if (Number.isNaN(sfc.h)) { floatOk = false; break; }
      nodes[i].y = Math.min(nodes[i].y, sfc.h + nodes[i].r * 0.55 - 0.3);
      if (i > 0) {
        nodes[i].y = Math.min(nodes[i].y, nodes[i - 1].y);
        const d = Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
        if ((nodes[i - 1].y - nodes[i].y) / Math.max(0.5, d) > 0.5) { floatOk = false; break; }
      }
    }
    if (!floatOk) continue;
    // verify nodes stay under the surface (except the two mouths)
    let ok = true;
    for (let i = 4; i < nodes.length - 3; i++) {
      const s = surfaceAt(field, nodes[i].x, nodes[i].z);
      if (Number.isNaN(s.h) || nodes[i].y + nodes[i].r > s.h - 2.5) { ok = false; break; }
      if (hydroQuery(nodes[i].x, nodes[i].z) < 8) { ok = false; break; }
    }
    if (!ok) continue;
    if (!clearOfCaves(nodes, caves, 3)) continue;
    const cave = { id: caves.length, kind: 'through', nodes, links: [], chambers: [], layer: 1 };
    for (let i = 0; i < nodes.length - 1; i++) cave.links.push([i, i + 1]);
    cave.entrance = { x: nodes[0].x, y: nodes[0].y, z: nodes[0].z };
    cave.exit = { x: nodes[nodes.length - 1].x, y: nodes[nodes.length - 1].y, z: nodes[nodes.length - 1].z };
    cave.name = names.name('through', throughCount) + ' ' + rng.pick(['Passage', 'Underway', 'Gullet', 'Winding']);
    cave.walkable = true;
    caves.push(cave);
    throughCount++;
  }
  return caves;
}

/**
 * Helical tunnel inside the shaft wall: from (thetaStart, yStart) descending to yEnd
 * at a constant radius offset behind the wall surface. Returns a cave record.
 */
export function helixTunnel(field, { id, thetaStart, dir, rOffset, yStart, yEnd, slope, radius, name, kind = 'wall' }) {
  const nodes = [];
  const P = {};
  // approximate radius of the wall at start
  let th = thetaStart;
  let y = yStart;
  const stepArc = 6;
  let guard = 0;
  while (y > yEnd && guard++ < 2000) {
    const [x0, z0] = field.fromPolar(500, th);
    field.polar(x0, z0, P);
    const R = P.Re + rOffset;
    const [x, z] = field.fromPolar(R, th);
    nodes.push({ x, y, z, r: radius });
    th += (dir * stepArc) / R;
    y -= slope * stepArc;
  }
  const [x0, z0] = field.fromPolar(500, th);
  field.polar(x0, z0, P);
  const [x, z] = field.fromPolar(P.Re + rOffset, th);
  nodes.push({ x, y: yEnd, z, r: radius });
  const links = [];
  for (let i = 0; i < nodes.length - 1; i++) links.push([i, i + 1]);
  return { id, kind, name, nodes, links, chambers: [], walkable: true, thetaEnd: th, entrance: nodes[0], exit: nodes[nodes.length - 1], layer: yStart > -350 ? 1 : 2 };
}

/** Flatten caves into a capsule array: [ax, ay, az, bx, by, bz, ra, rb, caveId] */
export function cavesToCapsules(caves) {
  const caps = [];
  for (const c of caves) {
    for (const [i, j] of c.links) {
      const a = c.nodes[i], b = c.nodes[j];
      caps.push(a.x, a.y, a.z, b.x, b.y, b.z, a.r, b.r, c.id);
    }
    for (const i of c.chambers) {
      const a = c.nodes[i];
      caps.push(a.x, a.y, a.z, a.x, a.y, a.z, a.r, a.r, c.id);
    }
  }
  return Float32Array.from(caps);
}

/** True when no node comes within (r1 + r2 + margin) of an existing cave capsule. */
export function clearOfCaves(nodes, caves, margin) {
  for (const c of caves) {
    for (const [i, j] of c.links) {
      const a = c.nodes[i], b = c.nodes[j];
      const minx = Math.min(a.x, b.x) - 20, maxx = Math.max(a.x, b.x) + 20, minz = Math.min(a.z, b.z) - 20, maxz = Math.max(a.z, b.z) + 20;
      for (const n of nodes) {
        if (n.x < minx || n.x > maxx || n.z < minz || n.z > maxz) continue;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const l2 = dx * dx + dy * dy + dz * dz;
        let t = l2 > 1e-6 ? ((n.x - a.x) * dx + (n.y - a.y) * dy + (n.z - a.z) * dz) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = n.x - (a.x + dx * t), ey = n.y - (a.y + dy * t), ez = n.z - (a.z + dz * t);
        const rr = a.r + (b.r - a.r) * t + n.r + margin;
        if (ex * ex + ey * ey + ez * ez < rr * rr) return false;
      }
    }
  }
  return true;
}
