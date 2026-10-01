// Macro planning for the shaft of the Abyss (end of Layer 1, Layer 2 and the
// start of Layer 3): the Great Spiral ledge, gallery openings where the
// spiral meets each inverted-forest tier, the buttress rib carrying the Long
// Stair down to the Stone Plain, deep tunnels between tiers, and the fault
// descent that leads to the Layer 3 threshold.
import { RNG } from '../core/rng.js';
import { TAU, wrapAngle, angle01 } from '../core/mathutil.js';
import { helixTunnel, clearOfCaves } from './caves.js';

export function planSpiral(field, params) {
  const sp = params.spiral;
  const dir = sp.dir;
  const P = {}, S = {};
  const th0 = sp.startAngle - Math.PI;
  const eyeR = (th) => field.tab(field.eyeTab, th);
  // start height: lip surface just outside the eye
  const [lx, lz] = field.fromPolar(eyeR(th0) + 3, th0);
  field.polar(lx, lz, P);
  field.surface(lx, lz, P, S);
  const yStart = Math.min(S.h, params.lipY + 4) - 0.5;
  const yEnd = params.plainY + params.bellH + 5;
  const pts = [];
  let th = th0, y = yStart, arc = 0;
  pts.push([...field.fromPolar(eyeR(th) - 0.6, th), y, th]);
  const step = 2;
  let guard = 0;
  while (y > yEnd && guard++ < 20000) {
    const R = eyeR(th) - 0.6;
    th += (dir * step) / R;
    y -= sp.slope * step;
    arc += step;
    const [x, z] = field.fromPolar(eyeR(th) - 0.6, th);
    pts.push([x, z, Math.max(y, yEnd), th]);
  }
  return { pts, th0, thEnd: th, yStart, yEnd, dir, length: arc };
}

/** Where the spiral crosses each gallery floor: force openings there. */
export function planGalleryWindows(params, spiral) {
  const windows = [];
  params.galleries.forEach((g, k) => {
    const floorY = g.yTop - g.height + 1.0;
    for (let i = 1; i < spiral.pts.length; i++) {
      if (spiral.pts[i][2] <= floorY) {
        windows.push({ tier: k, th: spiral.pts[i][3], hw: 0.2, depth: Math.max(70, g.depthMax * 0.85), y: spiral.pts[i][2], idx: i });
        break;
      }
    }
  });
  return windows;
}

export function planRibs(params, spiral) {
  const rng = RNG.derive(params.seed, 'ribs');
  const ribs = [];
  const mainTh = spiral.thEnd + spiral.dir * 0.12;
  ribs.push({ th: wrapAngle(mainTh), hw: 0.165, main: true });
  const n = rng.int(2, 4);
  for (let i = 0; i < n * 4 && ribs.length < n + 1; i++) {
    const th = rng.range(-Math.PI, Math.PI);
    if (ribs.some((r) => Math.abs(wrapAngle(r.th - th)) < 0.7)) continue;
    ribs.push({ th, hw: rng.range(0.035, 0.09) });
  }
  return ribs;
}

/**
 * Zig-zag stair down the main rib face from the end of the spiral to the plain.
 * Alternate legs are offset radially (one protruding, one cut into the rib) so
 * stacked legs never share columns near the landings.
 */
export function planLongStair(field, params, spiral, ribs, floorAt) {
  const rib = ribs[0];
  const dir = spiral.dir;
  const eyeR = (th) => field.tab(field.eyeTab, th);
  const thA = rib.th - dir * 0.11, thB = rib.th + dir * 0.11;
  const OFF = [-0.6, 3.8];
  const pts = [];
  let y = spiral.yEnd;
  const last = spiral.pts[spiral.pts.length - 1];
  pts.push([last[0], last[1], y, last[3]]);
  const legSlope = 0.48;
  let from = last[3], to = thB;
  const bottom = floorAt(...field.fromPolar(eyeR(rib.th) - 4, rib.th));
  const yBottom = (bottom ?? params.plainY) + 0.5;
  let guard = 0;
  let leg = 0;
  let off = OFF[0];
  while (y > yBottom + 0.01 && guard++ < 40) {
    const span = Math.abs(wrapAngle(to - from));
    const sgn = Math.sign(wrapAngle(to - from)) || 1;
    const Rm = eyeR(from) + off;
    const n = Math.max(2, Math.ceil((span * Rm) / 2));
    for (let i = 1; i <= n; i++) {
      const th = from + sgn * span * (i / n);
      const ds = (span * Rm) / n;
      y = Math.max(yBottom, y - legSlope * ds);
      const [x, z] = field.fromPolar(eyeR(th) + off, th);
      pts.push([x, z, y, th]);
    }
    if (y <= yBottom + 0.01) break;
    // landing: shift radially to the other offset at the same height
    leg++;
    const nextOff = OFF[leg % 2];
    const thL = from + sgn * span;
    for (let k = 1; k <= 3; k++) {
      const o = off + (nextOff - off) * (k / 3);
      const [x, z] = field.fromPolar(eyeR(thL) + o, thL);
      pts.push([x, z, y, thL]);
    }
    off = nextOff;
    from = to;
    to = to === thB ? thA : thB;
  }
  // step out onto the plain
  const endTh = pts[pts.length - 1][3];
  for (let o = off - 3; o >= -10; o -= 3) {
    const [ex, ez] = field.fromPolar(eyeR(endTh) + o, endTh);
    pts.push([ex, ez, yBottom, endTh]);
  }
  return { pts, yTop: spiral.yEnd, yBottom };
}

/** Fault descent: ledge spiralling down the fault wall to the Layer 3 threshold. */
export function planFaultSpiral(field, params, entryX, entryZ, floorAt) {
  const f = params.fault;
  const FP = {};
  const toWorld = (fr, fth) => {
    // invert the fault warp by fixed-point iteration
    let x = f.x + Math.cos(fth) * fr, z = f.z + Math.sin(fth) * fr;
    for (let i = 0; i < 10; i++) {
      const wx = field.nWarp.noise2(x / 70 + 50, z / 70) * 9;
      const wz = field.nWarp.noise2(x / 70, z / 70 + 50) * 9;
      x = f.x + Math.cos(fth) * fr - wx;
      z = f.z + Math.sin(fth) * fr - wz;
    }
    return [x, z];
  };
  const startTh = Math.atan2(entryZ - f.z, entryX - f.x);
  const RfAt = (th) => field.tab(field.faultTab, th);
  const [sx, sz] = toWorld(RfAt(startTh) + 6, startTh);
  const rimY = floorAt(sx, sz) ?? params.plainY;
  const pts = [];
  let th = startTh;
  let y = rimY;
  pts.push([sx, sz, y, th]);
  const dir = RNG.derive(params.seed, 'fault').chance(0.5) ? 1 : -1;
  const slope = 0.3;
  const yEnd = f.thresholdY;
  let guard = 0;
  while (y > yEnd && guard++ < 5000) {
    const R = RfAt(th) - 0.6;
    th += (dir * 2) / R;
    y = Math.max(yEnd, y - slope * 2);
    const [x, z] = toWorld(RfAt(th) - 0.6, th);
    pts.push([x, z, y, th]);
  }
  // threshold platform position: protruding into the fault
  const [tx, tz] = toWorld(RfAt(th) - 6, th);
  void FP;
  return { pts, threshold: { x: tx, z: tz, y: yEnd, th }, dir, toWorld };
}

/**
 * Deep tunnels between tiers. Each tunnel runs behind the galleries inside
 * the rock as a helix and enters the target space from its back wall.
 * galleryFloorAt(k, th, u) -> floor height of gallery k at angle th and depth fraction u (or null).
 * plainFloorAt(x, z) -> floor height of the stone plain (or null).
 */
export function planDeepTunnels(field, params, names, galleryFloorAt, plainFloorAt, existingCaves = [], floorIn = null, gDepth = null, waterDist = null) {
  const galleryDepth = gDepth || ((k, th) => field.galleryDepth(k, th));
  const rng = RNG.derive(params.seed, 'deeptunnels');
  const tunnels = [];
  const P = {}, S = {};
  const eyeR = (th) => field.tab(field.eyeTab, th);
  const g = params.galleries;
  const slope = 0.38;
  const R = 2.8;

  // radial run of nodes at angle th from radius offset a to b with y from ya to yb
  const radial = (th, a, b, ya, yb) => {
    const out = [];
    const len = Math.abs(b - a);
    const n = Math.max(1, Math.ceil(len / 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const [x, z] = field.fromPolar(eyeR(th) + a + (b - a) * t, th);
      out.push({ x, y: ya + (yb - ya) * t, z, r: R });
    }
    return out;
  };

  // Snap tunnel nodes that open into a gallery/chamber onto its real floor and
  // keep the rest of the tunnel within a walkable slope.
  const fitToFloors = (nodes, fixedFirst, fixedLast) => {
    if (!floorIn) return nodes;
    const n = nodes.length;
    const fixed = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      const fy = floorIn(nd.x, nd.z, nd.y + 6, nd.y - 14, 0.6);
      if (fy !== null) { nd.y = fy + 1.2; fixed[i] = 1; }
    }
    if (fixedFirst) fixed[0] = 1;
    if (fixedLast) fixed[n - 1] = 1;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < n; i++) {
        if (fixed[i]) continue;
        const d = Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
        nodes[i].y = Math.min(Math.max(nodes[i].y, nodes[i - 1].y - 0.42 * d), nodes[i - 1].y + 0.42 * d);
      }
      for (let i = n - 2; i >= 0; i--) {
        if (fixed[i]) continue;
        const d = Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].z - nodes[i].z);
        nodes[i].y = Math.min(Math.max(nodes[i].y, nodes[i + 1].y - 0.42 * d), nodes[i + 1].y + 0.42 * d);
      }
    }
    return nodes;
  };

  const assemble = (parts, meta) => {
    const nodes = [];
    for (const part of parts) for (const nd of part) {
      const last = nodes[nodes.length - 1];
      if (last && Math.hypot(last.x - nd.x, last.z - nd.z) < 0.5 && Math.abs(last.y - nd.y) < 0.5) continue;
      nodes.push(nd);
    }
    const links = [];
    for (let i = 0; i < nodes.length - 1; i++) links.push([i, i + 1]);
    return { id: 0, kind: 'deep', nodes, links, chambers: [], walkable: true, entrance: nodes[0], exit: nodes[nodes.length - 1], layer: 2, ...meta };
  };

  // Generic: from (thA, yA) at radius offset Roff descend helically to yB, then
  // run radially to the target that endFn(thEnd) describes: { u0: start offset, uEnd: end offset, y: floor }
  const helixTo = (thA, dir, Roff, yA, yB, endFn) => {
    const helix = helixTunnel(field, { id: 0, thetaStart: thA, dir, rOffset: Roff, yStart: yA, yEnd: yB, slope, radius: R, name: '', kind: 'deep' });
    // keep the mouth away from rivers and lakes
    if (waterDist) for (let i = 0; i < Math.min(8, helix.nodes.length); i++) if (waterDist(helix.nodes[i].x, helix.nodes[i].z) < 16) return null;
    // keep a rock roof over the tunnel (except its mouth)
    for (let i = 4; i < helix.nodes.length; i++) {
      const nd = helix.nodes[i];
      field.polar(nd.x, nd.z, P);
      if (field.surface(nd.x, nd.z, P, S) && S.h - (nd.y + R) < 5) return null;
    }
    if (!clearOfCaves(helix.nodes, existingCaves, 2.5)) return null;
    const thE = wrapAngle(helix.thetaEnd);
    const end = endFn(thE);
    if (!end) return null;
    const conLen = Math.abs(Roff - end.off);
    const yFinal = end.y + 1.2;
    if (Math.abs(yFinal - yB) > 0.4 * conLen + 0.5) return null;
    const con = radial(thE, Roff, end.off, yB, yFinal);
    // extend a little into the open space so the tunnel clearly opens onto the floor
    const ext = radial(thE, end.off, end.off - 6, yFinal, yFinal);
    return { helix: helix.nodes, connector: fitToFloors([...con, ...ext.slice(1)], true, false), thE };
  };

  // 1) The Throat: bowl surface -> back of gallery 0
  for (let attempt = 0; attempt < 80; attempt++) {
    const th = rng.range(-Math.PI, Math.PI);
    const dir = rng.sign();
    const Roff = g[0].depthMax + 22;
    const [x, z] = field.fromPolar(eyeR(th) + Roff, th);
    field.polar(x, z, P);
    if (!field.surface(x, z, P, S)) continue;
    const yTop = S.h + R * 0.55 - 0.3;
    const approxEnd = g[0].yTop - g[0].height + 0.2 * g[0].height + 1.2;
    if (yTop - approxEnd < 40) continue;
    const res = helixTo(th, dir, Roff, yTop, approxEnd, (thE) => {
      const D = galleryDepth(0, thE);
      if (D < 70) return null;
      const y = galleryFloorAt(0, thE, 0.94);
      return y === null ? null : { off: D * 0.94, y };
    });
    if (!res) continue;
    tunnels.push(assemble([res.helix, res.connector], { name: 'The Throat', from: 'bowl', to: 'gallery0' }));
    break;
  }

  // 2) Between gallery tiers
  for (let k = 0; k + 1 < g.length; k++) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const th = rng.range(-Math.PI, Math.PI);
      const dir = rng.sign();
      const D0 = galleryDepth(k, th);
      if (D0 < 60) continue;
      const yA = galleryFloorAt(k, th, 0.94);
      if (yA === null) continue;
      const Roff = Math.max(g[k].depthMax, g[k + 1].depthMax) + 20;
      const approxEnd = g[k + 1].yTop - g[k + 1].height + 0.2 * g[k + 1].height + 1.2;
      if (yA - approxEnd < 20) continue;
      const out = fitToFloors(radial(th, D0 * 0.94 - 6, Roff, yA + 1.2, yA + 1.2), false, true);
      const res = helixTo(th, dir, Roff, yA + 1.2, approxEnd, (thE) => {
        const D = galleryDepth(k + 1, thE);
        if (D < 55) return null;
        const y = galleryFloorAt(k + 1, thE, 0.94);
        return y === null ? null : { off: D * 0.94, y };
      });
      if (!res) continue;
      tunnels.push(assemble([out, res.helix, res.connector], { name: `${names.name('chute', k)} Chute`, from: `gallery${k}`, to: `gallery${k + 1}` }));
      break;
    }
  }

  // 3) Last gallery -> back of the bell chamber (the Stone Plain)
  const kL = g.length - 1;
  let maxBell = 0;
  for (let i = 0; i < 256; i++) {
    const th = -Math.PI + (i / 256) * TAU;
    maxBell = Math.max(maxBell, field.tab(field.bellTab, th) - eyeR(th));
  }
  for (let attempt = 0; attempt < 80; attempt++) {
    const th = rng.range(-Math.PI, Math.PI);
    const dir = rng.sign();
    const D0 = galleryDepth(kL, th);
    if (D0 < 55) continue;
    const yA = galleryFloorAt(kL, th, 0.94);
    if (yA === null) continue;
    const Roff = Math.max(maxBell + 24, D0 + 20);
    const approxEnd = params.plainY + 15;
    const out = fitToFloors(radial(th, D0 * 0.94 - 6, Roff, yA + 1.2, yA + 1.2), false, true);
    const res = helixTo(th, dir, Roff, yA + 1.2, approxEnd, (thE) => {
      const off = field.tab(field.bellTab, thE) - eyeR(thE) - 16;
      const [px, pz] = field.fromPolar(eyeR(thE) + off, thE);
      const y = plainFloorAt(px, pz);
      return y === null ? null : { off, y };
    });
    if (!res) continue;
    tunnels.push(assemble([out, res.helix, res.connector], { name: 'The Root Chute', from: `gallery${kL}`, to: 'plain' }));
    break;
  }
  return tunnels;
}

void TAU; void angle01;
