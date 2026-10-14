// Layer 3 cave network. Sinkholes in the Stone Plain open into caves that wind
// down inside the walls of the Great Fault: halls (large chambers) linked by
// passages that sweep along the wall, double back in switchbacks or drop in
// corkscrews, with parallel passages that form loops, dead-end dens, windows
// onto the chasm with balconies, and an exit onto the flooded basin where the
// Fourth Gate leads on toward Layer 4. Every passage between halls is
// generated at a walkable grade and validated by the plan like other routes.
//
// Placement works in wall-relative coordinates: (phi, off, fy) is the point at
// angle phi around the chasm axis, `off` metres behind the chasm wall, with
// its floor at height fy. Nodes are capsule spheres (centre at fy + 0.55 r).
import { RNG } from '../core/rng.js';
import { clamp, smoothstep, TAU, wrapAngle } from '../core/mathutil.js';
import { CAVE_MAT } from './caves.js';
import { M } from './materials.js';
import { shelf, box, cyl, spire, dome, arch, OP_ADD } from './structures.js';
import { ColumnData } from './column.js';

const SLOPE = 0.31;        // design grade of descending passages
const MAX_SLOPE = 0.4;     // steepest stretch accepted
const STEP = 4;            // metres between passage nodes
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV'];

export function planFaultCaves(ctx) {
  const { field, params, chasm, names, caves, plainFloorAt, stairEnd } = ctx;
  const rng = RNG.derive(params.seed, 'faultcaves');
  const c = params.chasm;
  const res = {
    caves: [], hubs: [], windows: [], sinkholes: [], dens: [], prims: [], shelves: [],
    landmarks: [], sites: [], pools: [], basin: null, gate: null, exit: null, network: '',
  };
  const P = {};
  res.network = `The ${names.name('warrens')} Warrens`;

  // ------------------------------------------------------------ geometry helpers
  const wallR = (phi, cy, r) => {
    let R = 0;
    for (let dy = -r - 8; dy <= r + 6; dy += 4.5) R = Math.max(R, chasm.wallDist(phi, cy + dy));
    return R;
  };
  const centre = (cy) => chasm.centreAt(cy);
  // plain floor above a point (Infinity where solid rock reaches far higher)
  const roofAt = (x, z) => {
    field.polar(x, z, P);
    if (P.r > P.Rb - 4) return Infinity;
    for (const rb of ctx.ribs || []) if (Math.abs(wrapAngle(P.th - rb.th)) < rb.hw) return Infinity;
    return field.plainFloor(x, z, P);
  };
  const clearNode = (nd, margin = 4) => {
    for (const dy of [-nd.r - 6, -nd.r * 0.4, 0, nd.r * 0.6, nd.r + 4]) {
      if (chasm.clearance(nd.x, nd.y + dy, nd.z) < nd.r + margin) return false;
    }
    return true;
  };
  const roofOK = (nd, minRock = 4) => {
    if (nd.y > c.yThroat + 40 || nd.y > params.plainY - 60) {
      const roof = roofAt(nd.x, nd.z);
      if (nd.y + nd.r + minRock > roof) return false;
      // keep out from under waterfall plunge pools and other places on the plain the plan reserves
      if (nd.y > params.plainY - 30) for (const a of ctx.avoid || []) if (Math.hypot(nd.x - a.x, nd.z - a.z) < a.r) return false;
    }
    return true;
  };
  // spatial index of cave capsules (existing caves and the ones added here)
  const CELL = 16;
  const segGrid = new Map();
  const indexCave = (cv) => {
    const add = (a, b) => {
      const pad = Math.max(a.r, b.r) + 14;
      const i0 = Math.floor((Math.min(a.x, b.x) - pad) / CELL), i1 = Math.floor((Math.max(a.x, b.x) + pad) / CELL);
      const j0 = Math.floor((Math.min(a.z, b.z) - pad) / CELL), j1 = Math.floor((Math.max(a.z, b.z) + pad) / CELL);
      const seg = { a, b, cave: cv };
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = i * 100003 + j;
        let l = segGrid.get(k);
        if (!l) segGrid.set(k, (l = []));
        l.push(seg);
      }
    };
    for (const [i, j] of cv.links) add(cv.nodes[i], cv.nodes[j]);
    for (const i of cv.chambers) add(cv.nodes[i], cv.nodes[i]);
    for (const b of cv.blobs || []) add(b, b);
  };
  for (const cv of caves) indexCave(cv);
  /** True when no node comes within margin of an indexed capsule (or of an accepted hall). */
  const clearAll = (nodes, margin, opts = {}) => {
    for (const n of nodes) {
      const l = segGrid.get(Math.floor(n.x / CELL) * 100003 + Math.floor(n.z / CELL));
      if (l) {
        for (const sg of l) {
          if (sg.cave === opts.exceptCave) continue;
          const a = sg.a, b = sg.b;
          const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          const l2 = dx * dx + dy * dy + dz * dz;
          let t = l2 > 1e-6 ? ((n.x - a.x) * dx + (n.y - a.y) * dy + (n.z - a.z) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = n.x - (a.x + dx * t), ey = n.y - (a.y + dy * t), ez = n.z - (a.z + dz * t);
          const sr = a.r + (b.r - a.r) * t;
          const rr = sr + n.r + margin;
          if (ex * ex + ey * ey + ez * ez < rr * rr) {
            // overlapping at the same floor level right next to a hall both passages join is harmless
            if (opts.levelHalls) {
              const nf = n.y - 0.55 * n.r, sf = a.y + dy * t - 0.55 * sr;
              if (Math.abs(nf - sf) < 0.75 && opts.levelHalls.some((h) => h && Math.abs(nf - h.fy) < 0.75 && Math.hypot(n.x - h.x, n.z - h.z) < h.r + 24)) continue;
            }
            if (globalThis.DEBUG_FAULT) console.log('    hits', sg.cave.kind, sg.cave.name, 'fy', (n.fy ?? n.y).toFixed(1));
            return false;
          }
        }
      }
      // accepted halls are obstacles too (their chamber caves are only built later)
      for (const h of res.hubs) {
        if (h.x === undefined || (opts.exceptHalls && opts.exceptHalls.includes(h))) continue;
        const rr = h.r + 1 + n.r + margin;
        const ex = n.x - h.x, ey = n.y - h.y, ez = n.z - h.z;
        if (ex * ex + ey * ey + ez * ez < rr * rr) return false;
      }
    }
    return true;
  };

  /**
   * Place samples [{s, off, r}] (s = arc distance along the wall from phiA,
   * unrolled at radius Rm) given a floor profile; returns nodes {x, y, z, r, fy}.
   * Positions depend on the wall distance at each depth and depth depends on
   * arc length, so this iterates.
   */
  const realize = (samples, phiA, Rm, fyA, fyB, profile = (u) => u, flatA = 0, flatB = 0) => {
    const n = samples.length;
    let fys = samples.map((_, i) => fyA + (fyB - fyA) * profile(i / Math.max(1, n - 1)));
    let nodes = null;
    for (let it = 0; it < 2; it++) {
      const Rs = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const sm = samples[i];
        Rs[i] = sm.fixedR ?? wallR(phiA + sm.s / Rm, fys[i] + 0.55 * sm.r, sm.r);
      }
      // smooth the wall distance along the passage (moving max, then average) so tier steps do not kink it
      const mx = new Float32Array(n), sm2 = new Float32Array(n);
      for (let i = 0; i < n; i++) { let m = 0; for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) m = Math.max(m, Rs[k]); mx[i] = m; }
      for (let i = 0; i < n; i++) { let a = 0, w = 0; for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) { a += mx[k]; w++; } sm2[i] = Math.max(Rs[i], a / w); }
      nodes = samples.map((smp, i) => {
        const phi = phiA + smp.s / Rm;
        const cy = fys[i] + 0.55 * smp.r;
        if (smp.fix) return { x: smp.fix.x, y: cy, z: smp.fix.z, r: smp.r, fy: fys[i], phi, off: smp.off };
        const [cx, cz] = centre(cy);
        const R = (smp.fixedR ?? sm2[i]) + smp.off;
        return { x: cx + Math.cos(phi) * R, y: cy, z: cz + Math.sin(phi) * R, r: smp.r, fy: fys[i], phi, off: smp.off };
      });
      // ease the first and last few nodes toward the pinned end points
      for (const [e, dirn] of [[0, 1], [n - 1, -1]]) {
        if (!samples[e].fix) continue;
        for (let k = 1; k <= 3; k++) {
          const i = e + dirn * k;
          if (i <= 0 || i >= n - 1) break;
          const w = 1 - k / 4;
          const ref = nodes[e], nd = nodes[i];
          const along = k * STEP;
          // position on the straight line from the pinned end toward the unpinned node 4 steps away
          const far = nodes[Math.max(0, Math.min(n - 1, e + dirn * 4))];
          const L = Math.hypot(far.x - ref.x, far.z - ref.z) || 1;
          const tx = ref.x + ((far.x - ref.x) / L) * Math.min(along, L), tz = ref.z + ((far.z - ref.z) / L) * Math.min(along, L);
          nd.x += (tx - nd.x) * w; nd.z += (tz - nd.z) * w;
        }
      }
      const L = [0];
      for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z));
      const tot = L[n - 1] || 1;
      // level floors next to the halls so passages meeting there share one floor
      const a = Math.min(flatA, tot * 0.3), b = Math.min(flatB, tot * 0.3);
      fys = L.map((l) => fyA + (fyB - fyA) * profile(clamp((l - a) / Math.max(1, tot - a - b), 0, 1)));
    }
    // final heights follow the final positions
    for (let i = 0; i < n; i++) { nodes[i].fy = fys[i]; nodes[i].y = fys[i] + 0.55 * nodes[i].r; }
    return nodes;
  };

  const legLength = (nodes) => { let L = 0; for (let i = 1; i < nodes.length; i++) L += Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z); return L; };
  const maxGrade = (nodes) => {
    let g = 0;
    for (let i = 1; i < nodes.length; i++) {
      const d = Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
      g = Math.max(g, Math.abs(nodes[i].fy - nodes[i - 1].fy) / Math.max(0.5, d));
    }
    return g;
  };

  /** Resample an (s, off) polyline every STEP metres, with radii from rFn(t). */
  const sampleLine = (pts, rFn) => {
    const out = [];
    let acc = 0;
    const seg = [];
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(l); acc += l; }
    const n = Math.max(2, Math.round(acc / STEP));
    let si = 0, sAcc = 0;
    for (let k = 0; k <= n; k++) {
      const target = (k / n) * acc;
      while (si < seg.length - 1 && sAcc + seg[si] < target) { sAcc += seg[si]; si++; }
      const t = seg[si] > 0 ? (target - sAcc) / seg[si] : 0;
      const a = pts[si], b = pts[si + 1];
      out.push({ s: a[0] + (b[0] - a[0]) * t, off: a[1] + (b[1] - a[1]) * t, r: rFn(k / n) });
    }
    return out;
  };

  /**
   * Build the (s, off) polyline of a passage from (0, offA) to (S, offB) whose
   * length is at least `need`: a meandering traverse, hairpin switchbacks into
   * the rock, or a corkscrew.
   */
  const passageShape = (S, offA, offB, need, style, lr) => {
    const pts = [];
    const dirS = Math.sign(S) || 1;
    const base = (t) => [S * t, offA + (offB - offA) * t];
    const straight = Math.hypot(S, offB - offA);
    const extra = Math.max(0, need - straight);
    if (style === 'traverse' || extra < 12) {
      // meander in depth: sinusoidal swings whose amplitude absorbs the extra length
      const waves = lr.int(1, 3);
      let amp = 0;
      if (extra > 0) {
        // arc length of a sine of amplitude a over length L ~ L * (1 + (pi a waves / L)^2)
        const Lb = Math.max(20, straight);
        amp = Math.min(60, (Lb / (Math.PI * waves)) * Math.sqrt(Math.max(0, (need / Lb) ** 2 - 1)));
      }
      amp = Math.max(amp, lr.range(3, 9));
      const ph = lr.chance(0.5) ? 1 : -1;
      for (let i = 0; i <= 64; i++) {
        const t = i / 64;
        const [s, o] = base(t);
        const sw = Math.sin(Math.PI * waves * t) * amp * ph;
        pts.push([s, Math.max(Math.min(offA, offB, 18), o + Math.abs(sw) * (sw > 0 ? 1 : 0.35))]);
      }
      return pts;
    }
    if (style === 'corkscrew') {
      // whole loops only, so the passage leaves the spiral where it entered it
      const loops = Math.max(1, Math.round(extra / (TAU * lr.range(11, 15))));
      const rho = clamp(extra / (TAU * loops), 9, 18);
      const tc = lr.range(0.35, 0.65);
      for (let i = 0; i <= 20; i++) pts.push(base((i / 20) * tc));
      const [s0, o0] = base(tc);
      const nA = Math.ceil(loops * 40);
      for (let i = 1; i <= nA; i++) {
        const a = (i / nA) * loops * TAU;
        pts.push([s0 + dirS * rho * Math.sin(a), o0 + rho - rho * Math.cos(a)]);
      }
      for (let i = 1; i <= 20; i++) pts.push(base(tc + (i / 20) * (1 - tc)));
      return pts;
    }
    // switchbacks: hairpin excursions into the rock
    const turnR = lr.range(6.5, 8.5);
    let nh = Math.max(1, Math.ceil(extra / 150));
    let D = (extra - nh * (Math.PI * turnR - 2 * turnR)) / (2 * nh);
    while (D > 75 && nh < 6) { nh++; D = (extra - nh * (Math.PI * turnR - 2 * turnR)) / (2 * nh); }
    D = clamp(D, 10, 80);
    pts.push(base(0));
    for (let h = 0; h < nh; h++) {
      const tc = (h + 0.5) / nh;
      const [s0, o0] = base(tc);
      const sa = s0 - dirS * turnR;
      pts.push([sa, o0]);
      pts.push([sa, o0 + D]);
      for (let i = 1; i < 12; i++) {
        const a = Math.PI * (i / 12);
        pts.push([s0 - dirS * turnR * Math.cos(a), o0 + D + turnR * Math.sin(a)]);
      }
      pts.push([s0 + dirS * turnR, o0 + D]);
      pts.push([s0 + dirS * turnR, o0]);
    }
    pts.push(base(1));
    return pts;
  };

  const radiusFn = (lr, wideChance = 0.5) => {
    const r0 = lr.range(2.7, 3.3);
    const bumps = [];
    if (lr.chance(wideChance)) bumps.push([lr.range(0.25, 0.75), lr.range(0.04, 0.08), lr.range(1.6, 2.6)]);
    if (lr.chance(0.35)) bumps.push([lr.range(0.15, 0.85), lr.range(0.02, 0.04), -lr.range(0.3, 0.6)]);
    const ph = lr.range(0, TAU);
    return (t) => {
      let r = r0 + 0.35 * Math.sin(t * 17 + ph) + 0.2 * Math.sin(t * 41 + ph * 2);
      for (const [c0, w, a] of bumps) r += a * Math.exp(-(((t - c0) / w) ** 2));
      // narrow down to the hubs at both ends
      return clamp(r, 2.3, 6);
    };
  };

  /**
   * Passage between two wall points A and B ({phi, off, fy}). Returns nodes or
   * null. `ends` excludes nodes near the end points from the cave clearance test.
   */
  const passage = (A, B, style, lr, opts = {}) => {
    const R0 = opts.Rm ?? (wallR(A.phi, A.fy + 2, 3) + wallR(B.phi, B.fy + 2, 3)) / 2;
    const Rm = Math.max(40, R0 + (A.off + B.off) / 2);
    let dphi = wrapAngle(B.phi - A.phi);
    if (opts.longWay) dphi = dphi > 0 ? dphi - TAU : dphi + TAU;
    const S = dphi * Rm;
    const drop = Math.abs(A.fy - B.fy);
    const need = drop / (opts.slope ?? SLOPE);
    let shapeNeed = need;
    let nodes = null;
    for (let tries = 0; tries < 3; tries++) {
      const pts = passageShape(S, A.off, B.off, shapeNeed, style, lr);
      const samples = sampleLine(pts, opts.rFn || radiusFn(lr));
      if (A.fixX !== undefined) samples[0].fix = { x: A.fixX, z: A.fixZ };
      if (B.fixX !== undefined) samples[samples.length - 1].fix = { x: B.fixX, z: B.fixZ };
      nodes = realize(samples, A.phi, Rm, A.fy, B.fy, opts.profile, opts.flatA ?? (opts.skipA ?? 0) + 3, opts.flatB ?? (opts.skipB ?? 0) + 3);
      const L = legLength(nodes);
      if (L >= need * 0.93 || style === 'traverse' && tries === 2) break;
      shapeNeed *= (need / Math.max(10, L)) * 1.05;
    }
    if (maxGrade(nodes) > (opts.maxGrade ?? MAX_SLOPE)) return { fail: 'grade', nodes };
    // only the stretches right at the two ends (inside the halls they join) are exempt
    const skipA = opts.skipA ?? 14, skipB = opts.skipB ?? 14;
    const arc = [0];
    for (let i = 1; i < nodes.length; i++) arc.push(arc[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z));
    const tot = arc[arc.length - 1];
    const test = [];
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      if (i >= (opts.surfaceNodes || 0) && (!clearNode(nd) || !roofOK(nd))) return { fail: 'chasm', nodes, at: i };
      if (nd.fy < c.floorY - 60) return { fail: 'deep', nodes };
      if (arc[i] > skipA && tot - arc[i] > skipB) test.push(nd);
      // never loop back into the halls being joined
      for (const [h, sk, d] of [[opts.hallA, skipA, arc[i]], [opts.hallB, skipB, tot - arc[i]]]) {
        if (h && d > sk + 12 && Math.hypot(nd.x - h.x, nd.y - h.y, nd.z - h.z) < h.r + nd.r + 2) return { fail: 'caves', why: 'loopback', nodes };
      }
    }
    if (!clearAll(test, 2.5, { exceptHalls: [opts.hallA, opts.hallB], levelHalls: [opts.hallA, opts.hallB] })) return { fail: 'caves', nodes };
    // the passage must not cross itself too closely (switchbacks and corkscrews)
    for (let i = 0; i < nodes.length; i += 2) {
      for (let j = i + 6; j < nodes.length; j += 2) {
        const a = nodes[i], b = nodes[j];
        if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r + 3 && Math.abs(a.y - b.y) < a.r + b.r + 3) return { fail: 'self', nodes };
      }
    }
    return { nodes };
  };

  const makeCave = (kind, name, nodes, meta = {}) => {
    const links = [];
    for (let i = 0; i < nodes.length - 1; i++) links.push([i, i + 1]);
    const cave = {
      id: 0, kind, name, nodes: nodes.map((n) => ({ x: n.x, y: n.y, z: n.z, r: n.r })), links, chambers: [], blobs: meta.blobs || [],
      walkable: meta.walkable ?? true, mat: meta.mat ?? CAVE_MAT.FAULT, layer: 3, from: meta.from, to: meta.to,
    };
    cave.entrance = cave.nodes[0];
    cave.exit = cave.nodes[cave.nodes.length - 1];
    res.caves.push(cave);
    indexCave(cave);
    return cave;
  };

  // ------------------------------------------------------------ sinkhole candidates on the plain
  const fc = centre(params.plainY);
  const mouthR = (phi) => chasm.wallDist(phi, params.plainY - 4);
  const phiToStair = stairEnd ? Math.atan2(stairEnd[1] - fc[1], stairEnd[0] - fc[0]) : rng.range(-Math.PI, Math.PI);
  const candidates = [];
  const sinkAt = (phi, off) => {
    const R = mouthR(phi) + off;
    const x = fc[0] + Math.cos(phi) * R, z = fc[1] + Math.sin(phi) * R;
    field.polar(x, z, P);
    if (P.r > P.Re + (P.Rb - P.Re) * 0.55) return null;
    const roof = roofAt(x, z);
    if (!Number.isFinite(roof)) return null;
    const fy = plainFloorAt(x, z);
    if (fy === null || Math.abs(fy - params.plainY) > 9) return null;
    // keep clear of the plain hole and of other sinkholes
    if (chasm.clearanceMouth(x, z) < 35) return null;
    if (candidates.some((s) => Math.hypot(s.x - x, s.z - z) < 80)) return null;
    for (const a of ctx.avoid || []) if (Math.hypot(x - a.x, z - a.z) < a.r + 10) return null;
    return { x, z, y: fy, phi, off };
  };
  {
    // the main sinkhole lies toward the Long Stair; the others around the plain hole
    const dist = stairEnd ? Math.hypot(stairEnd[0] - fc[0], stairEnd[1] - fc[1]) : 200;
    for (let tries = 0; tries < 80 && candidates.length < 3; tries++) {
      const phi = phiToStair + rng.range(-1, 1) * (0.25 + tries / 50);
      const off = clamp(rng.range(42, 75), 38, Math.max(38, dist - mouthR(phi) - 20));
      const sk = sinkAt(phi, off);
      if (sk) candidates.push(sk);
    }
    for (let tries = 0; tries < 400 && candidates.length < 14; tries++) {
      const sk = sinkAt(rng.range(-Math.PI, Math.PI), rng.range(38, 95));
      if (sk) candidates.push(sk);
    }
  }

  // ------------------------------------------------------------ passage helpers
  const STYLES = ['traverse', 'switchback', 'corkscrew'];
  const legStyle = (lr, drop, S) => {
    const need = drop / SLOPE;
    if (Math.abs(S) > need * 0.85) return 'traverse';
    return lr.weighted([['switchback', 3], ['corkscrew', 2], ['traverse', 1]]);
  };
  /**
   * Ports: where a passage meets a hall. Angles are in the (along-wall, into-rock)
   * plane: 0 = straight into the rock, +-90 = along the wall. The first passage
   * on a side meets the hall directly; later ones get a port 18 m out at an
   * angle away from the ports already in use, so passages never overlap there.
   */
  const portChoices = (hall, natural) => {
    const used = hall.portAngles || [];
    const far = (a) => used.reduce((m, u) => Math.min(m, Math.abs(a - u)), 360);
    const out = [];
    if (far(natural) >= 50) out.push({ ang: natural, dist: 0 });
    const cands = [natural, natural - 35, natural + 35, natural - 70, natural + 70, 0, -45, 45, -80, 80]
      .filter((a) => a >= -95 && a <= 95);
    cands.sort((a, b) => far(b) - far(a) || Math.abs(a - natural) - Math.abs(b - natural));
    for (const a of cands) if (far(a) >= 30 && !out.some((o) => o.ang === a)) out.push({ ang: a, dist: 18 });
    if (!out.length) out.push({ ang: 0, dist: 30 });
    return out.slice(0, 4);
  };
  const usePort = (hall, port) => { (hall.portAngles || (hall.portAngles = [])).push(port.ang); };

  /**
   * Passage between halls A and B through the given port choices. Returns the
   * inner nodes (without the hall nodes) and the ports used, or null.
   */
  const tryPassage = (A, B, label, lr, opts = {}) => {
    const Rm = (wallR(A.phi, A.fy + 2, 3) + wallR(B.phi, B.fy + 2, 3)) / 2 + (A.off + B.off) / 2;
    const S = wrapAngle(B.phi - A.phi) * Rm;
    let style = opts.style || legStyle(lr, Math.abs(A.fy - B.fy), S);
    let extraOff = 0;
    const pA = opts.portsA || [{ ang: 0, dist: 0 }], pB = opts.portsB || [{ ang: 0, dist: 0 }];
    let ia = 0, ib = 0;
    const at = (h, port) => {
      const o = { ...h, phi: h.phi + (port.dist * Math.sin((port.ang * Math.PI) / 180)) / Math.max(40, Rm), off: h.off + port.dist * Math.cos((port.ang * Math.PI) / 180) };
      if (h.x !== undefined) {
        // pin the passage end to the port: n points into the rock, t along the wall (+phi)
        const a = (port.ang * Math.PI) / 180, nx = Math.cos(h.phi), nz = Math.sin(h.phi), tx = -nz, tz = nx;
        o.fixX = h.x + port.dist * (Math.cos(a) * nx + Math.sin(a) * tx);
        o.fixZ = h.z + port.dist * (Math.cos(a) * nz + Math.sin(a) * tz);
      }
      return o;
    };
    // the straight link from a hall to its port runs at hall level: test it too
    const linkClear = (h, port, nodes) => {
      if (!port.dist || h.x === undefined) return true;
      const pts = [];
      const end = nodes[0];
      for (let d = h.r + 1; d < port.dist; d += 3) {
        const t = d / port.dist;
        pts.push({ x: h.x + (end.x - h.x) * t, y: h.fy + 0.55 * 3, z: h.z + (end.z - h.z) * t, r: 3 });
      }
      return clearAll(pts, 2, { exceptHalls: [h.hall], levelHalls: [h.hall] });
    };
    for (let attempt = 0; attempt < (opts.attempts || 12); attempt++) {
      const portA = pA[ia % pA.length], portB = pB[ib % pB.length];
      const a = at(A, portA), b = at(B, portB);
      if (extraOff) { a.off += extraOff * 0.5; b.off += extraOff * 0.5; delete a.fixX; delete b.fixX; }
      const r = passage(a, b, style, lr, {
        ...opts, skipA: portA.dist ? 0 : (A.r || 4) + 3, skipB: portB.dist ? 0 : (B.r || 4) + 3,
        hallA: opts.hallA || (A.x !== undefined ? A.hall : null), hallB: opts.hallB || (B.x !== undefined ? B.hall : null),
        flatA: Math.max(3, (A.r || 4) + 6 - portA.dist), flatB: Math.max(3, (B.r || 4) + 6 - portB.dist),
      });
      if (!r.fail && (!linkClear(A, portA, r.nodes) || !linkClear(B, portB, r.nodes.slice().reverse()))) { r.fail = 'caves'; r.why = 'portlink'; }
      if (!r.fail) {
        // drop realized nodes that fall inside the halls themselves
        const inner = r.nodes.filter((nd) => Math.hypot(nd.x - (A.x ?? Infinity), nd.z - (A.z ?? Infinity)) > (A.r || 0) * 0.8 && Math.hypot(nd.x - (B.x ?? Infinity), nd.z - (B.z ?? Infinity)) > (B.r || 0) * 0.8);
        return { nodes: inner, style, portA, portB };
      }
      if (globalThis.DEBUG_FAULT) console.log('  passage', label, style, attempt, r.fail, r.why || '');
      if (r.fail === 'chasm') extraOff += 10;
      else if (r.fail === 'caves') { if (attempt % 2) ib++; else ia++; }
      else style = STYLES[(STYLES.indexOf(style) + 1 + lr.int(0, 1)) % 3];
      if (attempt === 7) extraOff += 20;
    }
    return null;
  };
  // join a passage to a hall: first/last node at the hall's floor so the floors meet
  const hubNode = (h) => ({ x: h.x, y: h.fy + 0.55 * h.r, z: h.z, r: h.r, fy: h.fy });
  const hallRef = (h) => ({ phi: h.phi, off: h.off, fy: h.fy, r: h.r, x: h.x, z: h.z, hall: h });
  const legRng = (i, k) => RNG.derive(params.seed, 'faultleg', i, k);
  const placeHub = (h) => {
    const cy = h.fy + 0.55 * h.r;
    const R = wallR(h.phi, cy, h.r + 4);
    const [cx, cz] = centre(cy);
    h.R = R;
    h.x = cx + Math.cos(h.phi) * (R + h.off);
    h.z = cz + Math.sin(h.phi) * (R + h.off);
    h.y = cy;
  };
  const hubOK = (h) => {
    if (!clearNode({ x: h.x, y: h.y, z: h.z, r: h.r }, 6)) return false;
    return clearAll([{ x: h.x, y: h.y, z: h.z, r: h.r }], 5, { exceptHalls: [h] });
  };
  const fitHub = (h) => {
    placeHub(h);
    for (let q = 0; q < 5 && !hubOK(h); q++) { h.off += 12; placeHub(h); }
    return hubOK(h);
  };

  // sinkhole: a crater in the plain, then a passage diving under the floor to a hall
  const sinkPassage = (sk, target, lr, styles) => {
    const A = { phi: sk.phi, off: sk.off, fy: sk.y - 3.2, r: 3.2 };
    // steeper first stretch so the passage gets under the plain quickly
    const profile = (u) => (u < 0.12 ? (u / 0.12) * 0.155 : 0.155 + ((u - 0.12) / 0.88) * 0.845);
    const side = Math.sign(wrapAngle(target.phi - sk.phi)) || 1;
    const ports = portChoices(target, -side * 90);
    for (let k = 0; k < styles.length; k++) {
      const style = styles[k];
      const port = ports[k % ports.length];
      const B = {
        phi: target.phi + (port.dist * Math.sin((port.ang * Math.PI) / 180)) / Math.max(40, target.R + target.off),
        off: target.off + port.dist * Math.cos((port.ang * Math.PI) / 180), fy: target.fy, r: target.r,
      };
      const r = passage(A, B, style, lr, { profile, surfaceNodes: 8, maxGrade: 0.48, skipA: 30, skipB: Math.max(2, target.r + 3 - port.dist), hallB: target, flatA: 0, flatB: Math.max(3, target.r + 6 - port.dist) });
      if (globalThis.DEBUG_FAULT) console.log('sink', style, port.ang, r.fail || 'ok', r.at);
      if (!r.fail) { usePort(target, port); return r.nodes.filter((nd) => Math.hypot(nd.x - target.x, nd.z - target.z) > target.r * 0.8); }
    }
    return null;
  };
  const SINK_STYLES = ['traverse', 'switchback', 'corkscrew', 'traverse', 'switchback', 'corkscrew'];
  const addSink = (sk, nodes, hubIndex) => {
    const target = hubs[hubIndex];
    const crater = { x: sk.x, y: sk.y - 2.6 + 0.55 * 9, z: sk.z, r: 9, fy: sk.y - 2.6 };
    // the first nodes may lie above the plain floor: that is the open trench of the sinkhole
    sk.cave = makeCave('sinkhole', '', [crater, ...nodes.slice(1), hubNode(target)], { from: 'plain', to: `hall${hubIndex}` });
    sk.cave.sinkhole = true;
    sk.hall = hubIndex;
    res.sinkholes.push(sk);
  };

  // ------------------------------------------------------------ halls linked by passages
  const hubs = res.hubs;
  const hallIndex = (h) => hubs.indexOf(h);
  let legCount = 0;
  /** Passage between two halls (plus, sometimes, a parallel one that forms a loop). */
  const linkHalls = (A, B, lr, opts = {}) => {
    const side = Math.sign(wrapAngle(B.phi - A.phi)) || 1;
    const got = tryPassage(hallRef(A), hallRef(B), 'leg', lr, { portsA: portChoices(A, side * 90), portsB: portChoices(B, -side * 90), attempts: opts.attempts || 8, style: opts.style });
    if (!got) return false;
    usePort(A, got.portA); usePort(B, got.portB);
    const style = got.style;
    const nm = opts.name || `${names.name('way', legCount)} ${style === 'corkscrew' ? 'Corkscrew' : style === 'switchback' ? 'Switchbacks' : 'Way'}`;
    makeCave('fault', nm, [hubNode(A), ...got.nodes, hubNode(B)], { from: `hall${hallIndex(A)}`, to: `hall${hallIndex(B)}` });
    legCount++;
    if (opts.loop && lr.chance(0.55)) {
      // a parallel passage through other ports turns the leg into a loop
      const alt = tryPassage(hallRef(A), hallRef(B), 'alt', RNG.derive(params.seed, 'altleg', legCount), {
        style: style === 'traverse' ? 'switchback' : 'traverse', rFn: radiusFn(RNG.derive(params.seed, 'altr', legCount), 0.15),
        portsA: portChoices(A, side * 90).filter((pp) => pp.dist > 0), portsB: portChoices(B, -side * 90).filter((pp) => pp.dist > 0), attempts: 6,
      });
      if (alt) {
        usePort(A, alt.portA); usePort(B, alt.portB);
        makeCave('fault', `${names.name('loop', legCount)} Crawl`, [hubNode(A), ...alt.nodes, hubNode(B)], { from: `hall${hallIndex(A)}`, to: `hall${hallIndex(B)}` });
        legCount++;
      }
    }
    return true;
  };

  /** First hall of a trunk under a sinkhole. */
  const startTrunk = (trunk, avoidPhi) => {
    for (let ci = 0; ci < candidates.length; ci++) {
      const sk = candidates[ci];
      if (sk.cave) continue;
      if (avoidPhi !== null && Math.abs(wrapAngle(sk.phi - avoidPhi)) < 1.3) continue;
      for (let k = 0; k < 5; k++) {
        const lr = RNG.derive(params.seed, 'sinkleg', trunk, ci, k);
        const d = k % 2 ? -1 : 1;
        const h = { phi: sk.phi + d * lr.range(0.35, 0.9), fy: c.yThroat - lr.range(8, 16) - trunk * lr.range(20, 40), off: lr.range(26, 36) + (k > 2 ? 20 : 0), r: lr.range(9, 12), trunk };
        if (!fitHub(h)) continue;
        const nodes = sinkPassage(sk, h, lr, SINK_STYLES);
        if (!nodes) continue;
        hubs.push(h);
        addSink(sk, nodes, hubs.length - 1);
        return h;
      }
    }
    return null;
  };

  /**
   * Descend from hall `from`, adding halls until stopFy (or the basin) is
   * reached. When no passage can leave a hall it becomes a dead end and the
   * descent branches again from the hall before it.
   */
  const descend = (from, trunk, stopFy) => {
    const path = [from];
    let dir = rng.sign();
    let backtracks = 0;
    for (let i = 0; i < 40 && path.length; i++) {
      const A = path[path.length - 1];
      const remaining = A.fy - c.floorY;
      if (A.fy <= stopFy || remaining < 100) break;
      const lastOne = remaining < 165;
      let B = null;
      for (let k = 0; k < 12 && !B; k++) {
        const lr = RNG.derive(params.seed, 'faultleg', trunk, i, k);
        const drop = lastOne ? A.fy - (c.floorY + lr.range(30, 42)) : lr.range(70, 105);
        // zig-zag: change direction often so the network does not wind round the chasm like a stair
        if (k === 0 && lr.chance(0.45)) dir = -dir;
        const d = k % 2 ? -dir : dir;
        const cand = { phi: A.phi + d * lr.range(0.35, 1.0) * (k > 5 ? 1.5 : 1), fy: A.fy - drop, off: lr.range(22, 42) + (k > 6 ? 25 : 0), r: lr.range(8, 13), trunk, last: lastOne };
        if (!fitHub(cand)) continue;
        hubs.push(cand);
        if (linkHalls(A, cand, lr, { loop: path.length > 1, attempts: k > 8 ? 10 : 6 })) { B = cand; dir = d; } else hubs.pop();
      }
      if (B) { path.push(B); if (lastOne) break; continue; }
      // stuck: this hall stays a dead end; branch from the one above
      if (++backtracks > 4 || path.length < 2) break;
      path.pop();
    }
    return path[path.length - 1] || from;
  };

  // main trunk: from the sinkhole toward the Long Stair down to the basin
  const first = startTrunk(0, null);
  if (first) descend(first, 0, -Infinity);
  const trunkA = hubs.filter((h) => h.trunk === 0);
  // second trunk from another sinkhole: down most of the fault, then it merges into the first
  const first2 = trunkA.length > 3 ? startTrunk(1, first.phi) : null;
  if (first2) {
    const mergeAt = trunkA[trunkA.length - 2];
    const endB = descend(first2, 1, mergeAt.fy + 85);
    // merge into the nearest hall of the main trunk below
    const below = trunkA.filter((h) => h.fy < endB.fy - 30 && !h.last).sort((a, b) => (b.fy - a.fy));
    for (const t of below.slice(0, 3)) {
      if (linkHalls(endB, t, RNG.derive(params.seed, 'merge', hallIndex(t)), { attempts: 12, name: `${names.name('merge')} Descent` })) break;
    }
    // cross passages between the trunks at intermediate depths
    const trunkB = hubs.filter((h) => h.trunk === 1);
    let cross = 0;
    for (const b of trunkB.slice(1)) {
      if (cross >= 2) break;
      const a = trunkA.filter((h) => !h.last && Math.abs(h.fy - b.fy) < 70).sort((p, q) => Math.abs(wrapAngle(p.phi - b.phi)) - Math.abs(wrapAngle(q.phi - b.phi)))[0];
      if (!a || Math.abs(wrapAngle(a.phi - b.phi)) > 2.2) continue;
      const [hi, lo] = a.fy > b.fy ? [a, b] : [b, a];
      if (linkHalls(hi, lo, RNG.derive(params.seed, 'cross', cross), { attempts: 8, name: `${names.name('cross', cross)} Traverse` })) cross++;
    }
  }

  // ------------------------------------------------------------ more sinkholes into the upper halls
  {
    // plenty of ways in, spread around the tube, so whichever way the explorer
    // crosses the plain one of them is close
    const want = rng.int(5, 7);
    const upper = hubs.filter((h) => h.fy > c.yThroat - 160);
    for (let ci = 0; ci < candidates.length && res.sinkholes.length < want && upper.length; ci++) {
      const sk = candidates[ci];
      if (sk.cave) continue;
      if (res.sinkholes.some((o) => Math.abs(wrapAngle(o.phi - sk.phi)) < 0.62)) continue;
      // nearest upper hall by angle
      const target = upper.slice().sort((a, b) => Math.abs(wrapAngle(a.phi - sk.phi)) - Math.abs(wrapAngle(b.phi - sk.phi)))[0];
      const nodes = sinkPassage(sk, target, RNG.derive(params.seed, 'sinkleg2', ci), SINK_STYLES);
      if (nodes) addSink(sk, nodes, hallIndex(target));
    }
  }
  const hallNames = ['Hall', 'Vault', 'Chamber', 'Cathedral', 'Gallery', 'Hollow', 'Nave'];
  hubs.forEach((h, i) => { h.name = `${names.name('hall', i)} ${hallNames[(i * 3 + 1) % hallNames.length]}`; });
  res.sinkholes.forEach((sk, i) => {
    sk.name = i === 0 ? `The ${names.name('sink', i)} Swallet` : `${names.name('sink', i)} ${['Sink', 'Hollow', 'Doline'][i % 3]}`;
    sk.cave.name = sk.name;
    // delvers mark every way down: a pale stone arch over the mouth and a ring of
    // standing stones, tall enough to be seen from across the plain
    const nd = sk.cave.nodes;
    const nx = nd.length > 2 ? nd[2] : nd[1];
    let dx = nx.x - sk.x, dz = nx.z - sk.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    const px = -dz, pz = dx, rr = 9 + 3.5;
    const mr = RNG.derive(params.seed, 'sinkmark', i);
    const top = mr.range(8.5, 11);
    res.prims.push(arch(sk.x + px * rr, sk.z + pz * rr, { bx: sk.x - px * rr, bz: sk.z - pz * rr, y0: sk.y - 1.5, yb: sk.y - 1.5, bulge: top, thick: mr.range(1.8, 2.4), width: mr.range(2.0, 2.6), top: M.RUIN, side: M.RUIN }));
    const nStones = mr.int(6, 9);
    for (let k = 0; k < nStones; k++) {
      const a = Math.atan2(dz, dx) + (k + 0.5) / nStones * TAU;
      // leave the way into the passage and the feet of the arch clear
      const rel = Math.abs(wrapAngle(a - Math.atan2(dz, dx)));
      if (rel < 0.65 || Math.abs(rel - Math.PI / 2) < 0.35) continue;
      const sr = 9 + mr.range(5.5, 8);
      const sx = sk.x + Math.cos(a) * sr, sz = sk.z + Math.sin(a) * sr;
      res.prims.push(cyl(OP_ADD, sx, sz, { r: mr.range(0.6, 0.95), y0: sk.y - 1, y1: sk.y + mr.range(2.4, 4.6), top: M.RUIN, side: M.RUIN }));
    }
  });

  // ------------------------------------------------------------ the basin, its exit and the Fourth Gate
  const basinY = c.floorY;
  const [bcx, bcz] = centre(basinY + 3);
  res.basin = { x: bcx, z: bcz, y: basinY, r: c.basinR, name: `The ${names.name('basin')} Basin` };
  res.pools.push({ x: bcx + rng.range(-0.15, 0.15) * c.basinR, z: bcz + rng.range(-0.15, 0.15) * c.basinR, r: c.basinR * rng.range(0.32, 0.4), depth: 2.4, kind: 'lake', bed: M.CLAY, rim: M.DEEPSTONE, layer: 4 });
  const basinFloor = (x, z) => ctx.floorIn(x, z, basinY + 30, basinY - 15) ?? basinY;
  // the exit leaves from the deepest hall
  const last = hubs.reduce((m, h) => (!m || h.fy < m.fy ? h : m), null);
  for (const h of hubs) h.last = h === last;
  {
    // exit: from the last hall out through the funnel wall onto the basin floor
    const lr = RNG.derive(params.seed, 'exit');
    let done = false;
    for (let attempt = 0; attempt < 16 && !done; attempt++) {
      const phiE = last.phi + (attempt % 2 ? 1 : -1) * (0.45 + attempt * 0.08) * lr.range(0.75, 1.1);
      const Rf = chasm.wallDist(phiE, basinY + 5);
      if (Rf <= 0) continue;
      const [cx, cz] = centre(basinY + 5);
      const ux = Math.cos(phiE), uz = Math.sin(phiE);
      const out = { x: cx + ux * (Rf - 10), z: cz + uz * (Rf - 10) };
      const fyE = basinFloor(out.x, out.z) + 0.1;
      // a short approach behind the wall at basin-floor height, then straight out
      const B = { phi: phiE, off: 16, fy: fyE + 1.5, r: 3 };
      const got = tryPassage(hallRef(last), B, 'exit', lr, { portsA: portChoices(last, (Math.sign(wrapAngle(phiE - last.phi)) || 1) * 90) });
      if (!got || !got.nodes.length) continue;
      usePort(last, got.portA);
      const tail = [];
      const st = got.nodes[got.nodes.length - 1];
      const n = 6;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const x = st.x + (out.x - st.x) * t, z = st.z + (out.z - st.z) * t;
        const fy = st.fy + (fyE - st.fy) * t;
        tail.push({ x, y: fy + 0.55 * 3.4, z, r: 3.4, fy });
      }
      const name = 'The Basin Mouth';
      makeCave('fault', name, [hubNode(last), ...got.nodes, ...tail], { from: `hall${hubs.indexOf(last)}`, to: 'basin' });
      res.exit = { x: out.x, y: fyE, z: out.z, phi: phiE, name };
      done = true;
    }
  }
  {
    // the Fourth Gate: a monumental doorway in the far wall of the basin
    const lr = RNG.derive(params.seed, 'gate');
    const phiG = (res.exit ? res.exit.phi : last.phi) + Math.PI + lr.range(-0.5, 0.5);
    const Rg = chasm.wallDist(phiG, basinY + 6);
    const [cx, cz] = centre(basinY + 6);
    const ux = Math.cos(phiG), uz = Math.sin(phiG), px = -uz, pz = ux;
    const front = { x: cx + ux * (Rg - 12), z: cz + uz * (Rg - 12) };
    const fy0 = basinFloor(front.x, front.z) + 0.1;
    const nodes = [];
    const len = 66;
    for (let k = 0; k <= Math.round(len / STEP); k++) {
      const d = -12 + k * STEP;
      const t = clamp((d + 2) / (len - 14), 0, 1);
      const fy = fy0 - 16 * smoothstep(0, 1, t);
      const r = d < 4 ? 4.6 : 3.6;
      nodes.push({ x: cx + ux * (Rg + d), y: fy + 0.55 * r, z: cz + uz * (Rg + d), r, fy });
    }
    const end = nodes[nodes.length - 1];
    const hallR = 12;
    const hall = { x: end.x + ux * 8, z: end.z + uz * 8, r: hallR, fy: end.fy, y: end.fy + 0.55 * hallR };
    nodes.push(hall);
    const cave = makeCave('gate', 'The Fourth Gate', nodes, { mat: CAVE_MAT.DEEP, from: 'basin', to: 'layer4' });
    cave.chambers.push(nodes.length - 1);
    // pillars and lintel framing the doorway, a sealed door at the back of the hall
    const gx = cx + ux * (Rg - 1.2), gz = cz + uz * (Rg - 1.2);
    const ang = Math.atan2(uz, ux);
    for (const sd of [-1, 1]) {
      res.prims.push(box(OP_ADD, gx + px * sd * 6.4, gz + pz * sd * 6.4, { angle: ang, hw: 1.6, hd: 1.6, y0: fy0 - 2, y1: fy0 + 17, top: M.RUIN2, side: M.RUIN2, maxLod: 3 }));
      res.prims.push(box(OP_ADD, gx + px * sd * 6.4, gz + pz * sd * 6.4, { angle: ang, hw: 2.1, hd: 2.1, y0: fy0 - 2, y1: fy0 + 1, top: M.RUIN2, side: M.RUIN2, maxLod: 3 }));
      res.prims.push(spire(gx + px * sd * 9.5 - ux * 3, gz + pz * sd * 9.5 - uz * 3, { r: 1.4, y0: fy0, h: 6.5, top: M.CRYSTAL, side: M.CRYSTAL }));
    }
    res.prims.push(box(OP_ADD, gx, gz, { angle: ang + Math.PI / 2, hw: 8.2, hd: 1.8, y0: fy0 + 14.5, y1: fy0 + 18, top: M.RUIN2, side: M.RUIN2, maxLod: 3 }));
    const dx = hall.x + ux * (hallR - 3), dz = hall.z + uz * (hallR - 3);
    res.prims.push(box(OP_ADD, dx, dz, { angle: ang + Math.PI / 2, hw: 6, hd: 1.2, y0: hall.fy - 1, y1: hall.fy + 11, top: M.RUIN2, side: M.RUIN2, maxLod: 3 }));
    res.prims.push(cyl(OP_ADD, dx - ux * 1.3, dz - uz * 1.3, { r: 3.2, y0: hall.fy + 1.5, y1: hall.fy + 8, top: M.CRYSTAL, side: M.CRYSTAL, maxLod: 2 }));
    res.prims.push(dome(hall.x - ux * 4, hall.z - uz * 4, { r: 2.6, y0: hall.fy - 0.2, h: 0.9, top: M.RUIN2, side: M.RUIN2 }));
    res.gate = { x: hall.x - ux * 2, y: hall.fy, z: hall.z - uz * 2, mouth: { x: front.x, y: fy0, z: front.z }, phi: phiG, name: 'The Fourth Gate' };
  }

  // ------------------------------------------------------------ hall chambers
  hubs.forEach((h, i) => {
    const lr = RNG.derive(params.seed, 'hall', i);
    const blobs = [{ x: h.x, y: h.fy + 0.55 * h.r, z: h.z, r: h.r }];
    const nb = lr.int(1, 3);
    for (let k = 0; k < nb; k++) {
      const a = lr.range(0, TAU), d = lr.range(0.45, 0.8) * h.r;
      const r = h.r * lr.range(0.55, 0.8);
      const b = { x: h.x + Math.cos(a) * d, z: h.z + Math.sin(a) * d, r, y: 0 };
      b.y = h.fy + 0.55 * r + lr.range(-0.2, 0.6);
      if (clearNode(b, 3)) blobs.push(b);
    }
    makeCave('hall', h.name, [blobs[0]], { blobs: blobs.slice(1), walkable: false });
    res.caves[res.caves.length - 1].chambers.push(0);
    h.cave = res.caves[res.caves.length - 1];
  });

  // ------------------------------------------------------------ windows onto the chasm with balconies
  const windowHubs = hubs.filter((h, i) => i > 0 && !h.last && (i % 2 === 1 || rng.chance(0.3)));
  windowHubs.forEach((h, wi) => {
    const lr = RNG.derive(params.seed, 'window', wi);
    for (let attempt = 0; attempt < 8; attempt++) {
      const phi = h.phi + lr.range(-0.12, 0.12) * (attempt + 1);
      const fy = h.fy + lr.range(-0.3, 0.3);
      const Rw = chasm.wallDist(phi, fy + 1.5);
      if (Rw <= 0) continue;
      // open where the wall below the sill is not undercut, so the floor reaches the balcony
      if (chasm.wallDist(phi, fy - 3) > Rw + 1.5 || chasm.wallDist(phi, fy - 7) > Rw + 4) continue;
      const [cx, cz] = centre(fy + 2);
      const ux = Math.cos(phi), uz = Math.sin(phi);
      const nodes = [hubNode(h)];
      const r = lr.range(2.6, 3.2);
      // from the hall straight toward the wall, then out onto the balcony
      const hx = h.x, hz = h.z;
      const ex = cx + ux * (Rw - 4), ez = cz + uz * (Rw - 4);
      const len = Math.hypot(ex - hx, ez - hz);
      // the line must stay in rock (with rock under its floor) until it breaks out right at the wall
      let breakout = len;
      for (let d = 0; d <= len; d += 1) {
        const x = hx + (ex - hx) * (d / len), z = hz + (ez - hz) * (d / len);
        if (chasm.clearance(x, fy + 1, z) < 0 || chasm.clearance(x, fy - 1.5, z) < 0.5) { breakout = d; break; }
      }
      if (len - breakout > 7) continue;
      const n = Math.max(3, Math.round(len / STEP));
      let ok = true;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const nd = { x: hx + (ex - hx) * t, z: hz + (ez - hz) * t, r, fy: h.fy + (fy - h.fy) * t, y: 0 };
        nd.y = nd.fy + 0.55 * r;
        nodes.push(nd);
        // inside the rock it must not hit other caves
        const along = t * len;
        if (along > h.r + 3 && along < breakout - 4 && !clearAll([nd], 2, { exceptCave: h.cave, exceptHalls: [h] })) ok = false;
      }
      if (!ok) continue;
      const shelfR = lr.range(7, 11);
      const sx = cx + ux * (Rw - 1.5), sz = cz + uz * (Rw - 1.5);
      const shelfP = shelf(sx, sz, { r: shelfR, y1: fy, h: lr.range(4, 8), top: lr.chance(0.5) ? M.LICHEN : M.FAULTROCK, side: M.FAULTROCK, maxLod: 3 });
      res.prims.push(shelfP);
      const name = `${names.name('window', wi)} Window`;
      makeCave('window', name, nodes, { from: `hall${hubs.indexOf(h)}`, to: 'chasm' });
      const bx = cx + ux * (Rw - shelfR * 0.5), bz = cz + uz * (Rw - shelfR * 0.5);
      res.windows.push({ x: bx, y: fy, z: bz, phi, hub: hubs.indexOf(h), name, shelfR });
      res.shelves.push({ x: sx, z: sz, y: fy, r: shelfR, phi, window: true });
      break;
    }
  });

  // ------------------------------------------------------------ dens: dead-end burrows for cave fauna
  const denNames = ['Den', 'Burrow', 'Warren', 'Lair', 'Nook'];
  hubs.forEach((h, i) => {
    const lr = RNG.derive(params.seed, 'den', i);
    const nd = lr.int(1, 2) + (lr.chance(0.3) ? 1 : 0);
    for (let k = 0; k < nd; k++) {
      const crawl = lr.chance(0.3);
      const r0 = crawl ? lr.range(1.6, 1.9) : lr.range(2.1, 2.7);
      // heading: around the wall and away from the chasm, in (phi, off) terms
      let hd = lr.range(-Math.PI, Math.PI);
      let off = h.off, phi = h.phi, fy = h.fy;
      const R = h.R + h.off;
      const nodes = [hubNode(h)];
      const length = lr.range(28, 75);
      let L = 0;
      while (L < length) {
        hd += lr.gauss(0, 0.35);
        // bias away from the chasm wall
        if (off < 22) hd = Math.atan2(Math.abs(Math.sin(hd)) + 0.3, Math.cos(hd));
        const ds = Math.cos(hd) * STEP, doff = Math.sin(hd) * STEP;
        phi += ds / R; off += doff;
        fy += lr.range(-1.1, 0.7);
        const cy = fy + 0.55 * r0;
        const Rw = wallR(phi, cy, r0);
        const [cx, cz] = centre(cy);
        const n = { x: cx + Math.cos(phi) * (Rw + off), y: cy, z: cz + Math.sin(phi) * (Rw + off), r: r0, fy };
        if (L > h.r && (!clearNode(n, 3) || !roofOK(n) || !clearAll([n], 2, { exceptCave: h.cave, exceptHalls: [h] }))) break;
        nodes.push(n);
        L += STEP;
      }
      if (nodes.length < 6) continue;
      const end = nodes[nodes.length - 1];
      const er = lr.range(4.2, 6.5);
      const chamber = { x: end.x, y: end.fy + 0.55 * er, z: end.z, r: er, fy: end.fy };
      if (!clearNode(chamber, 2) || !clearAll([chamber], 1.5, { exceptCave: h.cave, exceptHalls: [h] })) { nodes.pop(); if (nodes.length < 5) continue; }
      else nodes[nodes.length - 1] = chamber;
      const name = `${names.name('den', i, k)} ${crawl ? 'Crawl' : denNames[(i + k) % denNames.length]}`;
      const cave = makeCave('den', name, nodes, { mat: CAVE_MAT.DEN, walkable: false, from: `hall${i}` });
      cave.chambers.push(nodes.length - 1);
      const last = nodes[nodes.length - 1];
      res.dens.push({ x: last.x, y: last.fy, z: last.z, r: last.r, hub: i, crawl, name, cave: cave });
    }
  });

  // ------------------------------------------------------------ natural shelves on the chasm wall (nesting ledges)
  {
    const lr = RNG.derive(params.seed, 'shelves');
    const n = lr.int(34, 48);
    for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) {
      const y = lr.range(c.floorY + 40, c.yWide - 10);
      const phi = lr.range(-Math.PI, Math.PI);
      const Rw = chasm.wallDist(phi, y + 1);
      if (Rw <= 0) continue;
      const [cx, cz] = centre(y);
      const r = lr.range(4, 11);
      const x = cx + Math.cos(phi) * (Rw - 1), z = cz + Math.sin(phi) * (Rw - 1);
      if (res.shelves.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + r + 4 && Math.abs(s.y - y) < 12)) continue;
      res.prims.push(shelf(x, z, { r, y1: y, h: lr.range(3, 9), top: lr.chance(0.45) ? M.LICHEN : M.FAULTROCK, side: M.FAULTROCK, maxLod: 3 }));
      res.shelves.push({ x, z, y, r, phi, rookery: r > 8.5 });
      k++;
    }
  }

  // ------------------------------------------------------------ names, landmarks and artifact sites
  for (const s of res.sinkholes) res.landmarks.push({ type: 'sinkhole', name: s.name, x: s.x, z: s.z, y: s.y, layer: 2 });
  hubs.forEach((h, i) => { if (i % 2 === 0 || h.last) res.landmarks.push({ type: 'hall', name: h.name, x: h.x, z: h.z, y: h.fy, layer: h.fy < -1900 ? 4 : 3 }); });
  for (const w of res.windows) res.landmarks.push({ type: 'window', name: w.name, x: w.x, z: w.z, y: w.y, layer: 3 });
  const rook = res.shelves.filter((s) => s.rookery).slice(0, 3);
  rook.forEach((s, i) => { s.name = `${names.name('rookery', i)} Rookery`; res.landmarks.push({ type: 'rookery', name: s.name, x: s.x, z: s.z, y: s.y, layer: 3 }); });
  res.landmarks.push({ type: 'basin', name: res.basin.name, x: res.basin.x, z: res.basin.z, y: res.basin.y, layer: 4 });
  if (res.gate) res.landmarks.push({ type: 'fourthgate', name: res.gate.name, x: res.gate.x, z: res.gate.z, y: res.gate.y, layer: 4 });

  hubs.forEach((h, i) => { if (i % 3 === 1) res.sites.push({ x: h.x, z: h.z, y: h.fy, layer: 3, context: 'in the dark of a great cave hall', place: h.name, kind: 'cave' }); });
  for (const d of res.dens) res.sites.push({ x: d.x, z: d.z, y: d.y, layer: 3, context: d.crawl ? 'at the end of a tight crawlway' : 'in a burrow strewn with bones', place: d.name, kind: 'den' });
  for (const w of res.windows) res.sites.push({ x: w.x, z: w.z, y: w.y, layer: 3, context: 'on a balcony above the void', place: w.name, kind: 'window' });
  for (const s of rook) res.sites.push({ x: s.x, z: s.z, y: s.y, layer: 3, context: 'among the nests of a rookery ledge', place: s.name, kind: 'nest' });
  if (res.gate) res.sites.push({ x: res.gate.x, z: res.gate.z, y: res.gate.y, layer: 4, context: 'before the sealed Fourth Gate', place: res.gate.name, kind: 'gate' });
  return res;
}

/**
 * Nesting sites, roosts and wall perches around the chasm, found on the final
 * terrain: ledge floors next to the wall (and on the shelves), bare wall faces,
 * and overhang ceilings. Used by the ecosystem for chasm fauna.
 */
export function findChasmSites(gen, params, shelves = []) {
  const rng = RNG.derive(params.seed, 'chasmsites');
  const ch = gen.chasm, c = params.chasm;
  const col = new ColumnData();
  const nests = [], roosts = [], perches = [];
  const r1 = (v) => Math.round(v * 10) / 10;
  for (let tries = 0; tries < 2400 && nests.length < 110; tries++) {
    const y = rng.range(c.floorY + 25, c.yWide);
    const phi = rng.range(-Math.PI, Math.PI);
    const Rw = ch.wallDist(phi, y);
    if (Rw <= 0) continue;
    const [cx, cz] = ch.centreAt(y);
    const d = Rw - rng.range(1.5, 6);
    const x = cx + Math.cos(phi) * d, z = cz + Math.sin(phi) * d;
    gen.column(x, z, 0, col);
    const f = col.floorBelow(y + 0.5);
    if (f < 0) continue;
    const fy = col.y1[f];
    if (y - fy > 10 || fy < c.floorY + 15) continue;
    const ceil = f + 1 < col.n ? col.y0[f + 1] : Infinity;
    if (ceil - fy < 2.5) continue;
    nests.push({ x: r1(x), y: r1(fy), z: r1(z), nx: r1(-Math.cos(phi)), nz: r1(-Math.sin(phi)), kind: 'ledge' });
  }
  for (const s of shelves) {
    const n = Math.max(1, Math.round(s.r / 2.5));
    for (let k = 0; k < n; k++) {
      const a = s.phi + Math.PI + rng.range(-1.2, 1.2), d = rng.range(0.25, 0.8) * s.r;
      const x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d;
      gen.column(x, z, 0, col);
      const f = col.floorBelow(s.y + 0.6);
      if (f < 0 || Math.abs(col.y1[f] - s.y) > 1.5) continue;
      nests.push({ x: r1(x), y: r1(col.y1[f]), z: r1(z), nx: r1(-Math.cos(s.phi)), nz: r1(-Math.sin(s.phi)), kind: 'ledge', shelf: true });
    }
  }
  for (let tries = 0; tries < 1600 && perches.length < 90; tries++) {
    const y = rng.range(c.floorY + 20, c.yThroat - 10);
    const phi = rng.range(-Math.PI, Math.PI);
    const Rw = ch.wallDist(phi, y);
    if (Rw <= 0) continue;
    const [cx, cz] = ch.centreAt(y);
    const ux = Math.cos(phi), uz = Math.sin(phi);
    gen.column(cx + ux * (Rw - 0.7), cz + uz * (Rw - 0.7), 0, col);
    if (col.spanAt(y) >= 0) continue;
    gen.column(cx + ux * (Rw + 1.2), cz + uz * (Rw + 1.2), 0, col);
    if (col.spanAt(y) < 0) continue;
    perches.push({ x: r1(cx + ux * (Rw - 0.4)), y: r1(y), z: r1(cz + uz * (Rw - 0.4)), nx: r1(-ux), nz: r1(-uz), kind: 'wall' });
  }
  for (let tries = 0; tries < 1600 && roosts.length < 70; tries++) {
    const y = rng.range(c.floorY + 30, c.yThroat - 4);
    const phi = rng.range(-Math.PI, Math.PI);
    const Rw = ch.wallDist(phi, y);
    if (Rw <= 0) continue;
    const [cx, cz] = ch.centreAt(y);
    const d = Rw - rng.range(1, 8);
    const x = cx + Math.cos(phi) * d, z = cz + Math.sin(phi) * d;
    gen.column(x, z, 0, col);
    if (col.spanAt(y) >= 0) continue;
    let ceil = Infinity;
    for (let i = 0; i < col.n; i++) if (col.y0[i] > y) { ceil = col.y0[i]; break; }
    if (ceil - y > 9 || ceil === Infinity) continue;
    roosts.push({ x: r1(x), y: r1(ceil), z: r1(z) });
  }
  return { nests, roosts, perches };
}
