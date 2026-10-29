// Creature bodies, built like the creatures of Spore: a skeleton from the
// phenotype, then a skin of soft parts (round cones along the bones, ellipsoids
// for heads, bellies, cheeks, ears, shells, bells and tail clubs) blended into
// one smooth surface (see sdfmesh.js), with big expressive eyes on their own
// bones (they look around and blink), mouths that open, horns, crests, spikes,
// and the thin or flat pieces (insect legs, claws, whiskers, antennae, tentacles,
// wing membranes, feathers) added as explicit geometry. One skinned mesh and one
// draw call per creature; one shared material.
//
// Body plans: quadruped, hexapod, strider, biped, hopper, sprawler, serpent,
// avian, bat, glider, insect, spider, centipede, crab, slug, floater, golem and
// roller. Within a plan the genes set the build (where the mass sits, how round
// and young the face looks, mouth, eyes, feet and ornaments).
//
// The skin can be built on the main thread (buildCreature) or in a worker
// (buildCreatureAsync); both return the same { mesh, rig, ... }.
import * as THREE from 'three';
import { shared } from '../render/materials.js';
import { REG, RC, EL, meshParts, Shapes, mergeMeshes } from './sdfmesh.js';

const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Orthonormal basis [side, up, forward] with forward along f. */
function basis(f, upHint = [0, 1, 0]) {
  const w = norm(f);
  let u = cross(upHint, w);
  if (Math.hypot(...u) < 1e-4) u = cross([1, 0, 0], w);
  u = norm(u);
  const v = cross(w, u);
  return [u, v, w];
}

// ------------------------------------------------------------------ material
let MATERIAL = null;
/** Smooth-shaded, vertex-coloured; deep-layer light, the lamp, a soft rim and glowing markings. */
export function creatureMaterial() {
  if (MATERIAL) return MATERIAL;
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aGlow;
varying float vGlow;
varying vec3 vWPosC;
varying vec3 vNW;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_COLOR
  vColor.rgb = pow(vColor.rgb, vec3(2.2));
#endif
  vGlow = aGlow;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vWPosC = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vNW = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uDeepLight;
uniform vec3 uAbyssGlow;
uniform vec3 uLampPos;
uniform vec3 uLampColor;
uniform float uLampRange;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
varying float vGlow;
varying vec3 vWPosC;
varying vec3 vNW;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  {
    float depthK = smoothstep(-920.0, -220.0, vWPosC.y);
    reflectedLight.directDiffuse *= mix(uDeepLight * 1.4, 1.0, depthK);
    reflectedLight.indirectDiffuse *= mix(0.5, 1.0, depthK);
    float glowK = 1.0 - smoothstep(-700.0, -150.0, vWPosC.y);
    reflectedLight.indirectDiffuse += diffuseColor.rgb * uAbyssGlow * (0.6 + glowK * 1.2);
    vec3 lv = uLampPos - vWPosC;
    float lf = clamp(1.0 - length(lv) / uLampRange, 0.0, 1.0);
    reflectedLight.directDiffuse += diffuseColor.rgb * uLampColor * lf * lf * max(0.25, dot(normal, mat3(viewMatrix) * normalize(lv)));
  }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // a soft rim of the surrounding light keeps silhouettes readable (the Spore look)
  {
    vec3 V = normalize(uCamPos - vWPosC);
    float rim = pow(1.0 - max(dot(normalize(vNW), V), 0.0), 3.0);
    totalEmissiveRadiance += (uFogColor * 0.5 + uAbyssGlow) * rim * 0.35;
  }
  // bioluminescence: subtle in daylight, vivid in the dark of the deep layers
  totalEmissiveRadiance += diffuseColor.rgb * vGlow * (0.9 + 0.35 * sin(uTime * 2.2 + vWPosC.x * 3.0 + vWPosC.z * 2.0)) * mix(1.6, 0.35, smoothstep(-700.0, -150.0, vWPosC.y));`);
  };
  m.customProgramCacheKey = () => 'creature-v3';
  MATERIAL = m;
  return m;
}

// ------------------------------------------------------------------ worker
let WORKER = null, JOB = 0;
const JOBS = new Map();
function worker() {
  if (WORKER !== null) return WORKER;
  if (typeof Worker === 'undefined') { WORKER = false; return WORKER; }
  try {
    WORKER = new Worker(new URL('./creatureWorker.js', import.meta.url), { type: 'module' });
    WORKER.onmessage = (e) => { const j = JOBS.get(e.data.id); if (j) { JOBS.delete(e.data.id); j(e.data.mesh); } };
    WORKER.onerror = () => { WORKER = false; for (const j of JOBS.values()) j(null); JOBS.clear(); };
  } catch { WORKER = false; }
  return WORKER;
}

// ------------------------------------------------------------------ builder
/** Collects bones, soft parts and explicit shapes in the bind pose (metres, +z forward). */
class Builder {
  constructor() {
    this.bones = []; this.named = {}; this.rest = [];
    this.P = []; this.X = new Shapes(); this.thin = [];
  }
  bone(name, parent, p) {
    const b = new THREE.Bone();
    b.name = name;
    const i = this.bones.length;
    this.bones.push(b);
    this.rest.push(new THREE.Vector3(p[0], p[1], p[2]));
    if (parent >= 0) { this.bones[parent].add(b); b.position.set(p[0] - this.rest[parent].x, p[1] - this.rest[parent].y, p[2] - this.rest[parent].z); } else b.position.set(p[0], p[1], p[2]);
    this.named[name] = i;
    return i;
  }
  R(i) { const r = this.rest[i]; return [r.x, r.y, r.z]; }
  rc(a, b, ra, rb, reg, b0, b1 = b0, k = null, grow = 0.6, sx = 1) {
    const p = { t: RC, ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], ra, rb, reg, b0, b1, k: k ?? Math.min(ra, rb) * 0.9, grow };
    if (sx !== 1) p.sx = sx;
    this.P.push(p);
    return p;
  }
  el(c, rx, ry, rz, reg, b0, k = null, bs = null) {
    const p = { t: EL, cx: c[0], cy: c[1], cz: c[2], rx, ry, rz, reg, b0, b1: b0, k: k ?? Math.min(rx, ry, rz) * 0.7 };
    if (bs) { p.u = bs[0]; p.v = bs[1]; p.w = bs[2]; }
    this.P.push(p);
    return p;
  }
  /** A thin tapered piece: a soft part when thick enough for the grid, else an explicit tube. */
  tube(a, b, ra, rb, reg, b0, b1 = b0) { this.thin.push({ a, b, ra, rb, reg, b0, b1 }); }
}

// how upright the neck stands, per plan
const NECK_UP = { quadruped: 0.55, hexapod: 0.5, strider: 0.85, biped: 0.62, avian: 0.75, hopper: 0.25, sprawler: 0.15, glider: 0.2, bat: 0.3, golem: 0.25, serpent: 0.1, slug: 0.85 };
// half the torso length (body lengths) per plan
const HALF = { quadruped: 0.27, hexapod: 0.33, strider: 0.21, biped: 0.15, avian: 0.16, hopper: 0.17, sprawler: 0.29, glider: 0.25, bat: 0.13, golem: 0.27 };

/**
 * Skeleton and shape description of an individual. Returns the rig (bones in
 * their bind pose), the soft parts and the explicit shapes.
 */
export function designCreature(ph, seed = 1, opts = {}) {
  const K = new Builder();
  const plan = ph.plan;
  const ctx = { ph, K, seed, S: ph.scale, C: ph.colors, fam: ph.family, plan, springs: [] };
  ctx.root = K.bone('root', -1, [0, 0, 0]);
  if (plan === 'floater') designFloater(ctx);
  else if (plan === 'slug') designSlug(ctx);
  else if (plan === 'insect' || plan === 'spider' || plan === 'centipede' || plan === 'crab') designArthropod(ctx);
  else if (plan === 'roller') designRoller(ctx);
  else designVertebrate(ctx);
  return finish(ctx, opts);
}

// ------------------------------------------------------------------ vertebrates
function designVertebrate(ctx) {
  const { ph, K, S, plan, fam } = ctx;
  const B = ph.body, L = ph.legs, sh = ph.shape;
  const rocky = fam === 'lithosere';
  const serpent = plan === 'serpent';
  const T = ((B.girth + B.height) / 2) * S * (serpent ? 0.55 : 0.62) * (rocky ? 1.12 : 1) * (plan === 'hopper' ? 0.95 : 1);
  const aspect = clamp(B.girth / B.height, 0.78, 1.32);
  const chest = rocky ? Math.max(sh.chest, 0.45) : sh.chest;
  const rH = T * (0.94 - 0.2 * chest), rC = T * (0.94 + 0.22 * chest), rM = T * (0.86 + 0.36 * sh.belly);
  const legLen = L.len * S;
  const half = (HALF[plan] ?? 0.25) * S;
  const sprawl = L.posture === 'sprawl';
  // torso axis: bipeds and hoppers lean up toward the chest
  const lean = plan === 'biped' ? 0.55 : plan === 'hopper' ? 0.42 : plan === 'avian' ? 0.22 : plan === 'golem' ? 0.12 : 0;
  let hipY;
  if (serpent) hipY = T * 0.95;
  else if (sprawl) hipY = rH * 0.85 + legLen * 0.2;
  else if (plan === 'hopper') hipY = rH * 0.9 + legLen * 0.1;
  else if (plan === 'bat') hipY = rH * 0.9 + legLen * 0.45;
  else if (L.biped) hipY = legLen * 0.92 + rH * 0.25;
  else hipY = legLen + rH * 0.3;
  const zHip = -half * Math.cos(lean), zChest = half * Math.cos(lean);
  const chestY = hipY + 2 * half * Math.sin(lean) + (L.biped || plan === 'hopper' ? 0 : T * 0.12 * chest);
  ctx.hipY = hipY; ctx.chestY = chestY; ctx.zHip = zHip; ctx.zChest = zChest; ctx.T = T; ctx.legLen = legLen;
  const root = ctx.root;
  const hips = K.bone('hips', root, [0, hipY, zHip]);
  const spine = [];
  for (let i = 1; i <= 2; i++) {
    const t = i / 3;
    spine.push(K.bone('spine' + i, i === 1 ? hips : spine[0], [0, hipY + (chestY - hipY) * t, zHip + (zChest - zHip) * t]));
  }
  const chestB = K.bone('chest', spine[1], [0, chestY, zChest]);
  Object.assign(ctx, { hips, spine, chest: chestB });
  const ax = norm([0, chestY - hipY, zChest - zHip]);

  // ---------------------------------------------------------- torso: a soft chain of vertebrae
  if (!serpent) {
    const sag = T * 0.1 * sh.belly;
    const pts = [
      { p: add([0, hipY + T * 0.05, zHip], ax, -rH * 0.6), r: rH * 0.68, b: hips },
      { p: [0, hipY, zHip], r: rH, b: hips },
      { p: [0, (hipY * 2 + chestY) / 3 - sag, zHip + (zChest - zHip) / 3], r: rM, b: spine[0] },
      { p: [0, (hipY + chestY * 2) / 3 - sag * 0.6, zHip + (zChest - zHip) * 2 / 3], r: (rM + rC) / 2, b: spine[1] },
      { p: [0, chestY, zChest], r: rC, b: chestB },
      { p: add([0, chestY + rC * 0.22, zChest], ax, rC * 0.42), r: rC * 0.74, b: chestB },
    ];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      K.rc(a.p, b.p, a.r, b.r, REG.BODY, a.b, b.b, T * 0.55, 0.5, aspect);
    }
    // a round belly
    if (sh.belly > 0.3 && plan !== 'avian') K.el([0, (hipY + chestY) / 2 - T * (0.3 + 0.25 * sh.belly), (zHip + zChest) / 2], T * 0.8 * aspect, T * (0.5 + 0.35 * sh.belly), half * 0.85, REG.BODY, spine[0], T * 0.5);
    // birds: a plump egg of a body and a breast
    if (plan === 'avian') K.el([0, chestY - T * 0.25, zChest - T * 0.1], T * 0.9 * aspect, T * 1.0, T * 1.05, REG.BODY, chestB, T * 0.5);
    // golems: craggy boulders fused to the back and shoulders
    if (rocky) {
      for (let i = 0; i < 6; i++) {
        const t = (i + 0.5) / 6, sd = i % 2 ? 1 : -1;
        const bi = t < 0.4 ? spine[0] : t < 0.75 ? spine[1] : chestB;
        K.el([sd * T * 0.45, hipY + (chestY - hipY) * t + T * (0.75 + 0.15 * (i % 3)), zHip + (zChest - zHip) * t], T * (0.42 + 0.1 * (i % 2)), T * 0.36, half * 0.3, REG.SHELL, bi, T * 0.06);
      }
    }
    // a shell or armour dome over the back
    if (ph.plates > 0.55 && !rocky) K.el([0, (hipY + chestY) / 2 + T * 0.4, (zHip + zChest) / 2], T * 1.2 * aspect, T * (0.55 + ph.plates * 0.3), half * 1.15, REG.SHELL, spine[0], T * 0.15);
    // shaggy fur: soft tufts along the back
    if (ph.shag > 0.65) {
      for (let i = 0; i < 4; i++) {
        const t = (i + 0.5) / 4;
        K.el([0, hipY + (chestY - hipY) * t + T * 0.85, zHip + (zChest - zHip) * t], T * 0.55, T * 0.3, half * 0.32, REG.BODY, t < 0.5 ? spine[0] : spine[1], T * 0.3);
      }
    }
    // a hump
    if (B.hump > 0.02) K.el([0, chestY + rC * 0.75, zChest - half * 0.25], rC * 0.7, rC * (0.5 + B.hump), half * 0.45, REG.BODY, chestB, T * 0.4);
  }
  if (serpent) K.rc([0, hipY, zHip], [0, hipY, zChest], T, T * 0.92, REG.BODY, hips, chestB, T * 0.6, 0.5);
  // ---------------------------------------------------------- tail (and the serpent's long body)
  buildTail(ctx, hips, [0, hipY, zHip], ax, rH);
  // ---------------------------------------------------------- neck and head
  const up = NECK_UP[plan] ?? 0.4;
  const neckLen = ph.neck.len * S;
  const nBase = serpent ? [0, hipY, zChest] : add([0, chestY + rC * 0.3, zChest], ax, rC * 0.5);
  const ndir = norm([0, up, Math.sqrt(1 - up * up)]);
  const nThick = ph.neck.thick * T * (serpent ? 1.1 : 0.72);
  const n1 = K.bone('neck1', chestB, add(nBase, ndir, neckLen * 0.5));
  const n2 = K.bone('neck2', n1, add(nBase, ndir, neckLen));
  if (neckLen > T * 0.15) {
    K.rc(nBase, K.R(n1), nThick, nThick * 0.88, REG.NECK, chestB, n1, nThick * 0.8, 0.5);
    K.rc(K.R(n1), K.R(n2), nThick * 0.88, nThick * 0.78, REG.NECK, n1, n2, nThick * 0.6, 0.5);
  }
  ctx.neck = [n1, n2];
  const headR = ph.head.size * S * 0.62 * (rocky ? 0.85 : 1) * (plan === 'hopper' ? 0.85 : 1);
  const n2p = K.R(n2);
  const hc = neckLen > headR * 0.6 ? [0, n2p[1] + headR * 0.3, n2p[2] + headR * 0.4] : [0, n2p[1] + headR * 0.15, n2p[2] + headR * 0.55];
  buildHead(ctx, hc, headR, n2);
  // ---------------------------------------------------------- legs, arms, wings
  buildLegs(ctx);
  if (L.biped && ph.arms.len > 0.05 && plan !== 'avian') buildArms(ctx);
  buildWings(ctx);
  buildBackOrnaments(ctx);
}

/** The tail: a tapering chain, or the serpent's whole body. */
function buildTail(ctx, hips, base, ax, rH) {
  const { ph, K, S, plan } = ctx;
  const tailLen = ph.tail.len * S;
  ctx.tail = [];
  if (tailLen < 0.01) return;
  const nT = ph.tail.segs;
  const serpent = plan === 'serpent';
  const sprawl = ph.legs.posture === 'sprawl';
  const droop = plan === 'avian' ? 0.1 : plan === 'biped' ? 0.05 : sprawl || serpent ? 0 : plan === 'hopper' ? 0.3 : 0.5;
  const start = serpent ? base : add(base, ax, -rH * 0.55);
  const tt = ph.tail.thick * S * 1.15;
  let prev = start, prevR = serpent ? ctx.T * 1.0 : Math.max(tt * 1.3, rH * 0.45), prevB = hips;
  for (let i = 1; i <= nT; i++) {
    const t = i / nT;
    // serpents and sprawlers lie on the ground; the rest carry their tails
    const y = serpent ? ctx.T * 0.95 - t * ctx.T * 0.2 : start[1] - tailLen * droop * t * t - (sprawl ? (start[1] - tt) * t * 0.8 : 0) + (plan === 'avian' ? tailLen * 0.15 * t : 0);
    const z = start[2] - tailLen * t * (serpent ? 1 : 0.97);
    const p = [0, Math.max(serpent ? ctx.T * 0.6 : tt * 0.8, y), z];
    const tb = K.bone('tail' + i, i === 1 ? hips : ctx.tail[i - 2], p);
    const r = serpent ? Math.max(ctx.S * 0.006, ctx.T * (1.0 - 0.85 * t)) : Math.max(ctx.S * 0.006, tt * (1.15 - 0.9 * t));
    K.rc(prev, p, prevR, r, REG.TAIL, prevB, tb, Math.min(prevR, r) * (serpent ? 0.9 : 0.8), 0.55);
    ctx.tail.push(tb);
    prev = p; prevR = r; prevB = tb;
  }
  ctx.springs.push(ctx.tail.slice(-2));
  const tipB = ctx.tail[ctx.tail.length - 1], tp = K.R(tipB);
  const ts = Math.max(tt, 0.04 * S);
  const C = ctx.C;
  switch (ph.tail.tip) {
    case 'tuft': K.el([0, tp[1], tp[2] - ts * 0.6], ts * 1.05, ts * 1.05, ts * 1.7, REG.TIP, tipB, ts * 0.5); break;
    case 'club': K.el([0, tp[1], tp[2] - ts * 0.4], ts * 1.7, ts * 1.35, ts * 1.8, REG.TIP, tipB, ts * 0.5); break;
    case 'spike': for (const sd of [-1, 1]) K.tube(tp, [sd * ts * 2.2, tp[1] + ts * 1.2, tp[2] - ts * 2], ts * 0.45, ts * 0.05, REG.HORN, tipB); break;
    case 'stinger': K.tube(tp, [0, tp[1] + ts * 2.6, tp[2] - ts * 1.5], ts * 0.65, ts * 0.05, REG.HORN, tipB); break;
    case 'fan': case 'plume': case 'fork': {
      const n = ph.tail.tip === 'fork' ? 2 : 5;
      const spread = ph.tail.tip === 'fork' ? 0.55 : ph.tail.tip === 'fan' ? 1.1 : 0.5;
      const fl = Math.max(ts * 3, tailLen * (ctx.fam === 'bird' ? 0.9 : 0.45));
      for (let k = 0; k < n; k++) {
        const a = (n === 1 ? 0 : k / (n - 1) - 0.5) * spread;
        K.X.tri2([-ts * 0.6, tp[1], tp[2] + ts], [ts * 0.6, tp[1], tp[2] + ts], [Math.sin(a) * fl, tp[1] + (ph.tail.tip === 'plume' ? fl * 0.25 : 0), tp[2] - Math.cos(a) * fl], C.secondary, C.secondary, k % 2 ? C.accent : C.secondary, [0, 0, C.glowAmt * 0.4], [tipB, tipB, tipB]);
      }
      break;
    }
    default: break;
  }
}

// ------------------------------------------------------------------ heads
/** Head at centre hc (radius headR) on bone parent: skull, mouth, eyes, ears, horns, cheeks. */
function buildHead(ctx, hc, headR, parent, opts = {}) {
  const { ph, K, fam, C } = ctx;
  const sh = ph.shape;
  const head = K.bone('head', parent, hc);
  ctx.head = head; ctx.headR = headR; ctx.hc = hc;
  const mouth = ph.mouth.type;
  const wide = mouth === 'grin' ? 1.12 + 0.22 * ph.mouth.width : 1;
  const rx = headR * (0.92 + 0.14 * sh.cute) * wide * (opts.flat ? 1.15 : 1);
  const ry = headR * (0.86 + 0.1 * sh.cute) * (mouth === 'grin' ? 0.9 : 1) * (opts.flat ? 0.75 : 1);
  const rz = headR * (0.9 + 0.5 * sh.headLong - 0.15 * sh.cute) * (mouth === 'grin' ? 0.92 : 1);
  ctx.hrx = rx; ctx.hry = ry; ctx.hrz = rz;
  K.el(hc, rx, ry, rz, REG.HEAD, head, headR * 0.3);
  // round cheeks for a friendly face
  if ((fam === 'mammal' || fam === 'amphibian' || fam === 'lithosere') && sh.cute > 0.35 && mouth !== 'grin') {
    for (const sd of [-1, 1]) K.el([sd * rx * 0.5, hc[1] - ry * 0.3, hc[2] + rz * 0.25], headR * 0.42, headR * 0.36, headR * 0.42, REG.HEAD, head, headR * 0.35);
  }
  // the brow: predators frown
  if (ph.head.jaw > 0.7 && fam !== 'bird' && !opts.noBrow) for (const sd of [-1, 1]) K.el([sd * rx * 0.42, hc[1] + ry * 0.55, hc[2] + rz * 0.45], headR * 0.32, headR * 0.14, headR * 0.3, REG.HEAD, head, headR * 0.2);
  buildMouth(ctx, hc, headR, head);
  buildEyes(ctx, hc, headR, head);
  buildEars(ctx, hc, headR, head);
  buildHorns(ctx, hc, headR, head);
  // cheeks: spikes, whiskers or a dewlap
  const jaw = ctx.jaw;
  if (ph.cheek === 'spikes') for (const sd of [-1, 1]) for (let k = 0; k < 3; k++) K.X.cone([sd * rx * 0.75, hc[1] - headR * 0.1 * k, hc[2] - headR * 0.3 * k], [sd * rx * 1.4, hc[1] - headR * (0.1 * k + 0.1), hc[2] - headR * (0.3 * k + 0.55)], headR * 0.09, C.accent, head, 4);
  if (ph.cheek === 'dewlap' && fam !== 'arthropod') K.el([0, hc[1] - ry * 1.05, hc[2] - rz * 0.1], headR * 0.25, headR * 0.45, headR * 0.5, REG.CREST, jaw, headR * 0.3);
  if ((ph.whisker > 0.55 || ph.cheek === 'whiskers') && ctx.snoutTip) {
    const wl = headR * (0.9 + ph.whisker * 1.4);
    const a0 = ctx.snoutTip;
    for (const sd of [-1, 1]) for (let k = -1; k <= 1; k++) {
      const a = [sd * ctx.snoutR * 0.55, a0[1] + k * ctx.snoutR * 0.12, a0[2] - ctx.snoutR * 0.45];
      K.X.tube(a, [a[0] + sd * wl, a[1] + k * wl * 0.15, a[2] - wl * 0.25], wl * 0.012, wl * 0.004, [0.93, 0.91, 0.86], head, head, 3);
    }
  }
  return head;
}

function buildMouth(ctx, hc, headR, head) {
  const { ph, K, fam, C } = ctx;
  const type = ph.mouth.type, mw = ph.mouth.width;
  const rx = ctx.hrx, ry = ctx.hry, rz = ctx.hrz;
  const snoutL = ph.head.snout * headR * 2.0 * (type === 'trunk' ? 0.6 : 1);
  const snoutR = headR * 0.46 * Math.sqrt(mw);
  ctx.snoutR = snoutR;
  const jaw = K.bone('jaw', head, [0, hc[1] - ry * 0.35, hc[2] + rz * 0.15]);
  ctx.jaw = jaw;
  const jc = K.R(jaw);
  if (type === 'beak') {
    const bl = Math.max(snoutL, headR * 0.8) * 1.05;
    const hook = ph.head.jaw > 0.6 ? 1 : 0.3;
    K.rc([0, hc[1] + headR * 0.02, hc[2] + rz * 0.65], [0, hc[1] - bl * 0.12 * hook, hc[2] + rz * 0.65 + bl], snoutR * 0.95, snoutR * 0.08, REG.HORN, head, head, snoutR * 0.25);
    K.rc([0, jc[1], hc[2] + rz * 0.5], [0, jc[1] - bl * 0.05, hc[2] + rz * 0.5 + bl * 0.8], snoutR * 0.65, snoutR * 0.06, REG.HORN, jaw, jaw, snoutR * 0.2);
    ctx.snoutTip = [0, hc[1], hc[2] + rz * 0.65 + bl];
    return;
  }
  if (type === 'mandibles') {
    for (const sd of [-1, 1]) {
      const a = [sd * snoutR * 0.45, jc[1], hc[2] + rz * 0.6];
      K.tube(a, [sd * snoutR * 0.35, jc[1] - snoutR * 0.15, hc[2] + rz * 0.6 + snoutR * 1.1], snoutR * 0.26, snoutR * 0.16, REG.HORN, jaw);
      K.X.cone([sd * snoutR * 0.35, jc[1] - snoutR * 0.15, hc[2] + rz * 0.6 + snoutR * 1.1], [sd * snoutR * 0.05, jc[1] - snoutR * 0.2, hc[2] + rz * 0.6 + snoutR * 1.6], snoutR * 0.16, mix3(C.secondary, [0.1, 0.08, 0.06], 0.5), jaw, 4);
    }
    return;
  }
  if (type === 'grin' || type === 'sucker') {
    // a wide frog mouth: the lower jaw is the bottom of the head, the lips run around the front
    K.el([0, hc[1] - ry * 0.42, hc[2] + rz * 0.12], rx * 0.92, ry * 0.5, rz * 0.88, REG.SNOUT, jaw, headR * 0.3);
    if (type === 'grin') {
      const th = 0.75 + 0.45 * mw, n = 7;
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const a = -th + (2 * th * i) / n;
        const p = [Math.sin(a) * rx * 0.97, hc[1] - ry * 0.22 - Math.cos(a) * ry * 0.06, hc[2] + Math.cos(a) * rz * 0.93];
        if (prev) K.rc(prev, p, headR * 0.06, headR * 0.06, REG.MOUTH, head, head, headR * 0.03);
        prev = p;
      }
    } else {
      // round sucking lips under the front
      const mc = [0, hc[1] - ry * 0.55, hc[2] + rz * 0.75];
      for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; K.el([mc[0] + Math.cos(a) * headR * 0.2, mc[1] + Math.sin(a) * headR * 0.12, mc[2] + 0.02 * headR], headR * 0.11, headR * 0.11, headR * 0.11, REG.SNOUT, jaw, headR * 0.06); }
      K.el(mc, headR * 0.16, headR * 0.1, headR * 0.12, REG.MOUTH, jaw, headR * 0.04);
    }
    ctx.snoutTip = [0, hc[1] - ry * 0.1, hc[2] + rz];
    return;
  }
  // muzzle (also trunk and tusked): snout, nose, lower jaw, dark lips along the seam
  const tip = [0, hc[1] - headR * 0.12, hc[2] + rz * 0.55 + snoutL];
  K.rc([0, hc[1] - headR * 0.02, hc[2] + rz * 0.3], tip, snoutR, snoutR * 0.7, REG.SNOUT, head, head, snoutR * 0.8);
  K.el([0, tip[1] + snoutR * 0.32, tip[2] + snoutR * 0.48], snoutR * 0.42, snoutR * 0.3, snoutR * 0.26, REG.NOSE, head, snoutR * 0.25);
  K.rc([0, jc[1], jc[2] - headR * 0.1], [0, tip[1] - snoutR * 0.55, tip[2] - snoutR * 0.2], snoutR * 0.78, snoutR * 0.52, REG.SNOUT, jaw, jaw, snoutR * 0.35);
  const seamY = (hc[1] - headR * 0.12 + jc[1]) / 2 - headR * 0.05;
  K.rc([0, seamY, hc[2] + rz * 0.35], [0, tip[1] - snoutR * 0.5, tip[2] - snoutR * 0.15], snoutR * 0.62 * mw, snoutR * 0.46, REG.MOUTH, jaw, head, snoutR * 0.1);
  ctx.snoutTip = tip;
  if (ph.head.jaw > 0.62 || type === 'tusked') {
    const big = type === 'tusked' ? 2.6 : 1;
    for (const sd of [-1, 1]) K.X.cone([sd * snoutR * 0.38, jc[1] + snoutR * 0.05, tip[2] - snoutL * 0.25], [sd * snoutR * (0.38 + 0.2 * (big - 1)), jc[1] + snoutR * 0.55 * big, tip[2] - snoutL * 0.2 + snoutR * 0.3 * (big - 1)], snoutR * 0.12 * Math.sqrt(big), [0.95, 0.93, 0.86], jaw, 4);
  }
  if (type === 'trunk') {
    // a soft trunk hanging from the snout, on a springy chain of bones
    const tl = ph.head.size * ctx.S * (1.2 + ph.head.snout);
    const chain = [];
    let prevP = tip, prevB = head, r = snoutR * 0.62;
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      const p = [0, tip[1] - tl * (0.2 + 0.75 * t * t), tip[2] + tl * 0.3 * Math.sin(Math.PI * t * 0.8)];
      const b = K.bone('trunk' + i, prevB, p);
      const r2 = snoutR * (0.62 - 0.36 * t);
      K.rc(prevP, p, r, r2, REG.SNOUT, prevB, b, r2 * 0.8, 0.5);
      chain.push(b); prevP = p; prevB = b; r = r2;
    }
    K.el(prevP, r * 1.25, r * 0.9, r * 1.25, REG.NOSE, prevB, r * 0.4);
    ctx.springs.push(chain);
    ctx.trunk = chain;
  }
}

function eyeDir(yaw, pitch) { return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]; }

function buildEyes(ctx, hc, headR, head) {
  const { ph, K, fam, C } = ctx;
  const E = ph.eyes;
  const rx = ctx.hrx, ry = ctx.hry, rz = ctx.hrz;
  const style = E.style;
  const n = fam === 'arthropod' ? E.count : Math.min(E.count, style === 'stalk' ? 2 : 4);
  const eR = Math.max(ctx.S * 0.012, headR * Math.max(0.16, E.size * (fam === 'arthropod' ? 1.2 : 1.75)));
  const predator = ph.head.jaw > 0.65 || fam === 'bird' && ph.head.jaw > 0.5;
  const pupilK = predator ? 0.8 : 1.05 + 0.25 * ph.shape.cute;
  const slit = (fam === 'reptile' || fam === 'amphibian' || fam === 'lithosere') && predator;
  const glow = E.glow > 0 ? 0.6 + E.glow : 0;
  const iris = C.eye;
  ctx.eyes = [];
  const place = (e, yaw, pitch, r, out, look = 0.45) => {
    const d = eyeDir(yaw, pitch);
    const s = [hc[0] + d[0] * rx, hc[1] + d[1] * ry, hc[2] + d[2] * rz];
    const nrm = norm([d[0] / rx, d[1] / ry, d[2] / rz]);
    const c = add(s, nrm, r * out);
    const eb = K.bone('eye' + e, head, c);
    const f = norm([nrm[0] * (1 - look), nrm[1] * (1 - look) + 0.05, nrm[2] * (1 - look) + look]);
    if (style === 'bulge' || style === 'top') K.el(add(s, nrm, r * 0.15), r * 1.25, r * 1.2, r * 1.15, REG.EYELID, head, r * 0.6);
    else K.el(add(s, nrm, -r * 0.05), r * 1.18, r * 1.08, r * 0.95, REG.EYELID, head, r * 0.55);
    K.X.eye(c, r, iris, pupilK, eb, glow, slit, f);
    ctx.eyes.push({ bone: eb, side: Math.sign(yaw) || 0, r, row: 0, dir: f });
  };
  if (style === 'stalk') {
    // eyes on stalks, Spore style: they sway and peer about
    ctx.stalks = [];
    const sl = headR * (0.9 + 0.9 * ph.tentacles.len) * (fam === 'arthropod' ? 0.7 : 1);
    for (const sd of n === 1 ? [0] : [-1, 1]) {
      const base = [sd * rx * 0.35, hc[1] + ry * 0.75, hc[2] + rz * 0.25];
      const s0 = K.bone(`stalk${sd < 0 ? 'R' : sd > 0 ? 'L' : 'C'}`, head, base);
      const tipP = [sd * (rx * 0.35 + sl * 0.3), base[1] + sl * 0.9, base[2] + sl * 0.3];
      const s1 = K.bone(`stalk${sd < 0 ? 'R' : sd > 0 ? 'L' : 'C'}1`, s0, tipP);
      K.tube(base, tipP, Math.max(eR * 0.32, headR * 0.09), eR * 0.28, REG.LIMB, s0, s1);
      const c = add(tipP, [0, eR * 0.6, eR * 0.1]);
      const eb = K.bone('eye' + ctx.eyes.length, s1, c);
      K.el(c, eR * 0.75, eR * 0.75, eR * 0.75, REG.EYELID, s1, eR * 0.3);
      K.X.eye(add(c, [0, 0, eR * 0.3]), eR * 0.95, iris, pupilK, eb, glow, false, [sd * 0.15, 0.1, 1]);
      ctx.eyes.push({ bone: eb, side: sd, r: eR, row: 0 });
      ctx.stalks.push(s0);
      ctx.springs.push([s0, s1]);
    }
    return;
  }
  if (style === 'cyclops' || n === 1) { place(0, 0, 0.22 + 0.3 * E.pos, eR * 1.55, 0.25, 0.7); return; }
  if (fam === 'arthropod' && n > 2) {
    // clusters of small glossy eyes
    for (let e = 0; e < n; e++) {
      const row = Math.floor(e / 2), sd = e % 2 ? 1 : -1;
      place(e, sd * (0.42 + row * 0.22), 0.25 + row * 0.24, eR * (row ? 0.65 : 1), 0.3);
    }
    return;
  }
  const top = style === 'top';
  const yaw0 = predator ? 0.38 : 0.62 - 0.12 * ph.shape.cute;
  const pitch0 = top ? 0.78 + 0.15 * E.pos : 0.12 + 0.55 * E.pos;
  const out = style === 'bulge' ? 0.55 : top ? 0.45 : 0.18;
  for (let e = 0; e < n; e++) {
    const row = Math.floor(e / 2), sd = e % 2 ? 1 : -1;
    place(e, sd * (yaw0 + row * 0.3), pitch0 + row * 0.28, eR * (row ? 0.72 : 1), out, top ? 0.35 : 0.45);
    ctx.eyes[e].row = row;
  }
}

function buildEars(ctx, hc, headR, head) {
  const { ph, K, C } = ctx;
  const ear = ph.ears;
  ctx.ears = [];
  if (ear.shape === 'none' || ear.size < 0.05) return;
  const S = ctx.S;
  const eh = ear.size * S * 1.2 * (ear.shape === 'long' ? 1.45 : ear.shape === 'fan' ? 1.0 : ear.shape === 'round' ? 0.72 : 1.0) * (1 + 0.2 * ph.shape.cute);
  const ew = eh * (ear.shape === 'fan' ? 0.85 : ear.shape === 'round' ? 0.8 : 0.45);
  const rx = ctx.hrx, ry = ctx.hry;
  for (const sd of [-1, 1]) {
    const p = [sd * rx * 0.55, hc[1] + ry * 0.68, hc[2] - ctx.hrz * 0.15];
    const eb = K.bone(sd < 0 ? 'earR' : 'earL', head, p);
    const tilt = ear.shape === 'fan' ? 0.95 : ear.shape === 'long' ? 0.3 : ear.shape === 'round' ? 0.6 : 0.42;
    const up = norm([sd * Math.sin(tilt), Math.cos(tilt), -0.18]);
    const side = norm(cross(up, [0, 0, 1]));
    const thick = Math.max(eh * 0.09, 0.01);
    K.el(add(p, up, eh * 0.5), thick, eh * 0.55, ew * 0.5, REG.EAR, eb, thick * 0.8, [side, up, norm(cross(side, up))]);
    if (ear.shape === 'tufted') K.X.cone(add(p, up, eh * 0.98), add(add(p, up, eh * 1.4), [0, 0, -eh * 0.1]), ew * 0.12, C.secondary, eb, 3);
    ctx.ears.push(eb);
  }
  ctx.springs.push(...ctx.ears.map((e) => [e]));
}

function buildHorns(ctx, hc, headR, head) {
  const { ph, K, S } = ctx;
  const H = ph.horns;
  if (H.type === 'none') return;
  const hl = H.len * S * 1.05;
  const rx = ctx.hrx, ry = ctx.hry, rz = ctx.hrz;
  const pairs = H.type === 'crown' ? [[-0.5, 0.2], [0.5, 0.2], [-0.25, 0.45], [0.25, 0.45], [0, 0.6]] : H.type === 'nose' ? [[0, 1.25]] : [[-0.45, 0.25], [0.45, 0.25]];
  for (const [hxk, hzk] of pairs) {
    const bx = hxk * rx, by = hc[1] + (H.type === 'nose' ? ry * 0.25 : H.type === 'tusk' ? -ry * 0.4 : ry * 0.75), bz = hc[2] + rz * hzk * (H.type === 'nose' ? 1 : 0.8) + (H.type === 'nose' && ctx.snoutTip ? (ctx.snoutTip[2] - hc[2] - rz) * 0.6 : 0);
    let tx = bx + hxk * hl * (H.type === 'curved' || H.type === 'antler' ? 0.6 : 0.25), ty = by + hl * (H.type === 'tusk' ? -0.2 : 0.9), tz = bz + hl * (0.15 + H.curve * 0.45);
    if (H.type === 'tusk') { tz = bz + hl * 0.9; ty = by + hl * 0.25; }
    const segs = H.type === 'spiral' || H.type === 'curved' || H.type === 'antler' ? 3 : 1;
    let p = [bx, by, bz], r = headR * (H.type === 'crown' ? 0.13 : 0.2);
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const wob = H.type === 'spiral' ? Math.sin(t * Math.PI * 2) * hl * 0.15 : 0;
      const q = [bx + (tx - bx) * t + wob * hxk, by + (ty - by) * t - (H.type === 'curved' ? Math.sin(Math.PI * t) * hl * 0.15 * H.curve : 0), bz + (tz - bz) * t + wob];
      const r2 = s === segs ? r * 0.15 : r * 0.72;
      K.tube(p, q, r, r2, REG.HORN, head);
      if (H.type === 'antler' && s < segs) K.tube(q, [q[0] + hxk * hl * 0.25, q[1] + hl * 0.25, q[2] + hl * 0.15], r * 0.5, r * 0.08, REG.HORN, head);
      p = q; r = r2 > r * 0.2 ? r2 : r * 0.72;
    }
  }
}

// ------------------------------------------------------------------ limbs
function buildLegs(ctx) {
  const { ph, K, plan, fam } = ctx;
  const L = ph.legs, S = ctx.S;
  ctx.legs = [];
  const pairs = L.pairs;
  if (!pairs) return;
  const sprawl = L.posture === 'sprawl';
  const legR = Math.max(S * 0.008, L.thick * S * 0.9);
  const chunk = ph.shape.limbChunk;
  const T = ctx.T;
  for (let pi = 0; pi < pairs; pi++) {
    // where along the torso the pair sits (0 hips .. 1 chest)
    let t, parent;
    if (pairs === 1) { t = plan === 'avian' ? 0.35 : 0.0; parent = ctx.hips; }
    else { t = pi / (pairs - 1); parent = t < 0.25 ? ctx.hips : t > 0.75 ? ctx.chest : ctx.spine[t < 0.5 ? 0 : 1]; }
    const front = pairs > 1 && pi === pairs - 1;
    const hopHind = plan === 'hopper' && pi === 0, hopFront = plan === 'hopper' && pi === 1;
    const az = ctx.zHip + (ctx.zChest - ctx.zHip) * t;
    const ay = ctx.hipY + (ctx.chestY - ctx.hipY) * t;
    const len = ctx.legLen * (hopFront ? 0.55 : 1);
    for (const sd of [-1, 1]) {
      const w = T * (sprawl ? 0.85 : 0.62) * (hopHind ? 1.1 : 1);
      const J = [sd * w, ay - T * (sprawl ? 0.15 : 0.42), az];
      let F, Kp;
      if (hopHind) {
        F = [sd * w * 1.05, legR * 0.6, az - len * 0.05];
        Kp = [sd * w * 1.25, J[1] * 0.45, az + len * 0.42];
      } else if (sprawl) {
        F = [sd * (w + len * 0.6), 0, az + (front ? len * 0.15 : -len * 0.05)];
        Kp = [sd * (w + len * 0.55), J[1] + len * 0.12, az];
      } else {
        F = [sd * (w + legR * 0.3), 0, az + (hopFront ? len * 0.25 : 0)];
        const kneeDir = L.biped ? 1 : front ? -1 : 1;
        Kp = [sd * (w + legR * 0.2), J[1] * 0.5, az + kneeDir * len * (L.posture === 'digitigrade' ? 0.2 : 0.08)];
      }
      const nm = `leg${pi}${sd < 0 ? 'R' : 'L'}`;
      const up = K.bone(nm + '0', parent, J);
      const kn = K.bone(nm + '1', up, Kp);
      const ft = K.bone(nm + '2', kn, [F[0], F[1] + legR * 0.5, F[2]]);
      const thigh = legR * (L.biped ? 1.9 : 1.7) * chunk * (hopHind ? 1.35 : 1) * (fam === 'lithosere' ? 1.25 : 1) * (fam === 'bird' ? 0.8 : 1);
      const kneeR = legR * (hopHind ? 1.25 : 1.0) * (fam === 'bird' ? 0.55 : 1);
      const ankle = legR * 0.82 * (fam === 'bird' ? 0.55 : 1);
      K.rc([J[0] * 0.75, J[1] + T * 0.25, J[2]], Kp, thigh, kneeR, REG.LIMB, up, kn, thigh * 0.75, 0.75);
      K.rc(Kp, [F[0], legR * 0.7, F[2]], kneeR, ankle, REG.LIMB, kn, ft, kneeR * 0.6, 0.8);
      buildFoot(ctx, F, ft, legR, sd, hopHind ? 2.2 : 1);
      ctx.legs.push({ pair: pi, side: sd, upper: up, knee: kn, foot: ft, parent, front, hip: new THREE.Vector3(...J), footRest: new THREE.Vector3(F[0], 0, F[2]) });
    }
  }
}

function buildFoot(ctx, F, ft, legR, sd, long = 1) {
  const { ph, K } = ctx;
  const type = ph.legs.feet;
  const fs = ph.legs.foot;
  const fl = legR * 2.2 * fs * long;
  switch (type) {
    case 'hoof':
      K.rc([F[0], legR * 0.9, F[2]], [F[0], legR * 0.25, F[2] + legR * 0.15], legR * 0.95, legR * 1.1, REG.HOOF, ft, ft, legR * 0.25);
      break;
    case 'talon':
      for (let k = -1; k <= 1; k++) K.tube([F[0], legR * 0.4, F[2]], [F[0] + k * fl * 0.45, legR * 0.2, F[2] + fl * (k === 0 ? 1.1 : 0.85)], legR * 0.5, legR * 0.25, REG.FOOT, ft);
      K.tube([F[0], legR * 0.4, F[2]], [F[0], legR * 0.2, F[2] - fl * 0.6], legR * 0.45, legR * 0.2, REG.FOOT, ft);
      break;
    case 'pad': {
      // splayed toes with round sticky tips (frogs, geckos)
      K.el([F[0], legR * 0.45, F[2] + fl * 0.2], legR * 1.05, legR * 0.45, fl * 0.45, REG.FOOT, ft, legR * 0.5);
      for (let k = -1.5; k <= 1.5; k += 1) {
        const a = k * 0.38;
        const tip = [F[0] + Math.sin(a) * fl * 1.05 + sd * legR * 0.1, legR * 0.25, F[2] + Math.cos(a) * fl * 1.05];
        K.tube([F[0], legR * 0.35, F[2] + fl * 0.3], tip, legR * 0.32, legR * 0.24, REG.FOOT, ft);
        K.el(tip, legR * 0.42, legR * 0.28, legR * 0.42, REG.TIP, ft, legR * 0.15);
      }
      break;
    }
    default: {
      // a soft round paw with toe bumps (and claws)
      K.el([F[0], legR * 0.6, F[2] + fl * 0.25], legR * 1.3 * fs, legR * 0.7, fl * 0.7, REG.FOOT, ft, legR * 0.6);
      for (let k = -1; k <= 1; k++) K.el([F[0] + k * legR * 0.7 * fs, legR * 0.42, F[2] + fl * 0.8], legR * 0.45, legR * 0.4, legR * 0.45, REG.FOOT, ft, legR * 0.25);
      if (type === 'claw' || ctx.fam === 'lithosere') for (let k = -1; k <= 1; k++) K.tube([F[0] + k * legR * 0.7 * fs, legR * 0.45, F[2] + fl * 0.95], [F[0] + k * legR * 0.75 * fs, legR * 0.05, F[2] + fl * 1.35], legR * 0.24, legR * 0.04, REG.CLAW, ft);
    }
  }
}

function buildArms(ctx) {
  const { ph, K } = ctx;
  const al = ph.arms.len * ctx.S;
  const legR = Math.max(ctx.S * 0.008, ph.legs.thick * ctx.S * 0.9);
  ctx.arms = [];
  for (const sd of [-1, 1]) {
    const sx = sd * ctx.T * 0.75, sy = ctx.chestY - ctx.T * 0.15, sz = ctx.zChest;
    const nm = `arm${sd < 0 ? 'R' : 'L'}`;
    const a0 = K.bone(nm + '0', ctx.chest, [sx, sy, sz]);
    const a1 = K.bone(nm + '1', a0, [sx + sd * al * 0.12, sy - al * 0.5, sz + al * 0.12]);
    const a2 = K.bone(nm + '2', a1, [sx + sd * al * 0.1, sy - al * 0.62, sz + al * 0.55]);
    const ch = ph.shape.limbChunk;
    K.rc([sx * 0.8, sy + ctx.T * 0.1, sz], K.R(a1), legR * 1.45 * ch, legR * 0.85, REG.LIMB, a0, a1, legR * 0.8, 0.75);
    K.rc(K.R(a1), K.R(a2), legR * 0.85, legR * 0.7, REG.LIMB, a1, a2, legR * 0.5, 0.8);
    const h = K.R(a2);
    K.el(h, legR * 1.0, legR * 0.7, legR * 1.1, REG.FOOT, a2, legR * 0.5);
    for (let k = 0; k < 3; k++) K.tube([h[0] + (k - 1) * legR * 0.45, h[1], h[2] + legR * 0.5], [h[0] + (k - 1) * legR * 0.6, h[1] - legR * 0.5, h[2] + legR * 1.5], legR * 0.26, legR * 0.08, REG.CLAW, a2);
    ctx.arms.push({ side: sd, b0: a0, b1: a1, b2: a2 });
  }
}

function buildWings(ctx) {
  const { ph, K, C } = ctx;
  const W = ph.wings;
  ctx.wings = [];
  if (W.type === 'none') return;
  const span = W.span * ctx.S * 0.5, chord = W.chord * ctx.S;
  const legR = Math.max(ctx.S * 0.008, ph.legs.thick * ctx.S * 0.9);
  const T = ctx.T;
  for (const sd of [-1, 1]) {
    const sx = sd * T * 0.65, sy = ctx.chestY + T * 0.45, sz = ctx.zChest - T * 0.15;
    const nm = sd < 0 ? 'R' : 'L';
    if (W.type === 'patagium') {
      const fl = ctx.legs.find((l) => l.side === sd && l.front), hl = ctx.legs.find((l) => l.side === sd && !l.front);
      if (!fl || !hl) continue;
      const wf = K.bone(`wing${nm}0`, ctx.chest, [sd * T * 0.9, ctx.chestY, ctx.zChest]);
      const wh = K.bone(`wing${nm}1`, ctx.hips, [sd * T * 0.9, ctx.hipY, ctx.zHip]);
      const outF = K.bone(`wing${nm}2`, wf, [sd * (T + span * 0.8), ctx.chestY - T * 0.1, ctx.zChest + T * 0.2]);
      const outH = K.bone(`wing${nm}3`, wh, [sd * (T + span * 0.7), ctx.hipY - T * 0.1, ctx.zHip - T * 0.2]);
      const mc = mix3(C.secondary, C.accent, 0.3);
      K.X.tri2(K.R(wf), K.R(outF), K.R(outH), mc, C.accent, C.accent, [0, C.glowAmt * 0.6, C.glowAmt * 0.6], [wf, outF, outH]);
      K.X.tri2(K.R(wf), K.R(outH), K.R(wh), mc, C.accent, mc, [0, C.glowAmt * 0.6, 0], [wf, outH, wh]);
      ctx.wings.push({ side: sd, type: 'patagium', b0: wf, b1: outF, b2: wh, b3: outH });
      continue;
    }
    const w0 = K.bone(`wing${nm}0`, ctx.chest, [sx, sy, sz]);
    const w1 = K.bone(`wing${nm}1`, w0, [sx + sd * span * 0.36, sy + span * 0.04, sz + chord * 0.05]);
    const w2 = K.bone(`wing${nm}2`, w1, [sx + sd * span * 0.66, sy + span * 0.02, sz - chord * 0.05]);
    const w3 = K.bone(`wing${nm}3`, w2, [sx + sd * span, sy - span * 0.02, sz - chord * 0.35]);
    const P0 = K.R(w0), P1 = K.R(w1), P2 = K.R(w2), P3 = K.R(w3);
    const wcol = mix3(C.primary, C.secondary, 0.5);
    if (W.type === 'feather') {
      K.rc([sx * 0.7, sy - T * 0.1, sz], P1, legR * 1.7, legR * 0.9, REG.LIMB, w0, w1, legR, 0.7);
      K.tube(P1, P2, legR * 0.85, legR * 0.6, REG.LIMB, w1, w2);
      const lead = [[P0, w0], [P1, w1], [P2, w2], [P3, w3]];
      const trail = [[P0[0], P0[1], P0[2] - chord * 0.9, w0], [P1[0], P1[1], P1[2] - chord * 1.0, w1], [P2[0] + sd * span * 0.05, P2[1], P2[2] - chord * 0.95, w2], [P3[0] + sd * span * 0.08, P3[1], P3[2] - chord * 0.4, w3]];
      for (let k = 0; k < 3; k++) {
        const [a, ab] = lead[k], [b, bb] = lead[k + 1];
        const ta = trail[k], tb = trail[k + 1];
        const ct = k === 2 ? C.secondary : mix3(wcol, C.accent, 0.25);
        K.X.tri2(a, b, tb.slice(0, 3), wcol, wcol, ct, [0, 0, k === 2 ? C.glowAmt * 0.5 : 0], [ab, bb, tb[3]]);
        K.X.tri2(a, tb.slice(0, 3), ta.slice(0, 3), wcol, ct, mix3(wcol, C.accent, k === 0 ? 0 : 0.25), [0, 0, 0], [ab, tb[3], ta[3]]);
      }
      for (let k = 0; k < 4; k++) {
        const t = k / 3;
        const bx = P2[0] + (P3[0] - P2[0]) * t, bz = P2[2] + (P3[2] - P2[2]) * t;
        K.X.tri2([bx, P2[1], bz], [bx + sd * chord * 0.05, P2[1], bz - chord * 0.1], [bx + sd * chord * (0.25 + 0.15 * t), P2[1] - chord * 0.05, bz - chord * (0.6 - 0.25 * t)], C.secondary, C.secondary, C.secondary, [0, 0, 0], [w3, w3, w3]);
      }
    } else if (W.type === 'membrane') {
      const fingerCol = mix3(C.primary, [0.15, 0.12, 0.12], 0.4);
      const memCol = mix3(C.secondary, C.primary, 0.3);
      K.rc([sx * 0.7, sy - T * 0.1, sz], P1, legR * 1.5, legR * 0.8, REG.LIMB, w0, w1, legR, 0.7);
      K.tube(P1, P2, legR * 0.7, legR * 0.5, REG.LIMB, w1, w2);
      const tips = [P3, [P2[0] + sd * span * 0.18, P2[1] - span * 0.05, P2[2] - chord * 0.75], [P2[0] + sd * span * 0.02, P2[1] - span * 0.04, P2[2] - chord * 1.05]];
      for (const t of tips) K.X.tube(P2, t, legR * 0.4, legR * 0.18, fingerCol, w2, w3, 3);
      const hl = ctx.legs.find((l) => l.side === sd);
      const legPt = hl ? K.R(hl.knee) : [sx, ctx.hipY, ctx.zHip];
      const lb = hl ? hl.knee : ctx.hips;
      const g = C.glowAmt * 0.4;
      K.X.tri2(P2, tips[0], tips[1], memCol, memCol, memCol, [0, g, g], [w2, w3, w3]);
      K.X.tri2(P2, tips[1], tips[2], memCol, memCol, memCol, [0, g, g], [w2, w3, w3]);
      K.X.tri2(P2, tips[2], legPt, memCol, memCol, memCol, [0, 0, 0], [w2, w3, lb]);
      K.X.tri2(P2, legPt, P1, memCol, memCol, memCol, [0, 0, 0], [w2, lb, w1]);
      K.X.tri2(P1, legPt, [sd * T * 0.6, ctx.hipY, ctx.zHip], memCol, memCol, memCol, [0, 0, 0], [w1, lb, ctx.hips]);
      K.X.tri2(P1, [sd * T * 0.6, ctx.hipY, ctx.zHip], P0, memCol, memCol, memCol, [0, 0, 0], [w1, ctx.hips, w0]);
    } else if (W.type === 'insect') {
      const wc = [0.85, 0.9, 0.95];
      for (const off of [0, 1]) {
        const z0 = sz - off * chord * 0.6;
        K.X.tri2([P0[0], P0[1], z0], [P3[0], P3[1] + span * 0.05, z0 + chord * 0.1], [P2[0], P2[1], z0 - chord * 0.7], wc, mix3(wc, C.accent, 0.4), wc, [0, C.glowAmt * 0.3, 0], [w0, w3, w2]);
      }
    }
    ctx.wings.push({ side: sd, type: W.type, b0: w0, b1: w1, b2: w2, b3: w3 });
  }
}

/** Crests, sails, frills and spike rows along the back. */
function buildBackOrnaments(ctx) {
  const { ph, K, C } = ctx;
  const CR = ph.crest, T = ctx.T, S = ctx.S;
  const zHip = ctx.zHip, zChest = ctx.zChest, hipY = ctx.hipY, chestY = ctx.chestY;
  const spineBone = (t) => (t < 0.33 ? ctx.hips : t < 0.66 ? ctx.spine[0] : ctx.spine[1]);
  if (CR.type !== 'none' && CR.size > 0.04) {
    const ch = CR.size * S * 1.1;
    if (CR.type === 'sail' || CR.type === 'ridge' || CR.type === 'fin') {
      const n = CR.type === 'ridge' ? 7 : 5;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const tt = CR.type === 'fin' ? 0.3 + 0.4 * t : t;
        const z = zHip + (zChest - zHip) * tt, y = hipY + (chestY - hipY) * tt + T * 0.8;
        const hh = ch * (CR.type === 'ridge' ? 0.32 : 1) * (0.55 + 0.45 * Math.sin(Math.PI * t));
        K.el([0, y + hh * 0.5, z], Math.max(T * 0.08, 0.012), hh * 0.6, (zChest - zHip + T) / n * 0.75, REG.CREST, spineBone(tt), T * 0.1);
      }
    } else if (CR.type === 'spikes') {
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        const z = zHip - T * 0.4 + (zChest + T * 0.2 - zHip) * t, y = hipY + (chestY - hipY) * t + T * 0.9;
        K.tube([0, y, z], [0, y + ch * (0.5 + 0.5 * Math.sin(Math.PI * t)), z - ch * 0.3], T * 0.14, T * 0.015, REG.CREST, spineBone(t));
      }
    } else if (CR.type === 'plume' || CR.type === 'fan') {
      const hc = ctx.hc;
      const cb = K.bone('crest', ctx.head, [0, hc[1] + ctx.hry * 0.9, hc[2] - ctx.hrz * 0.15]);
      ctx.springs.push([cb]);
      const n = CR.type === 'fan' ? 6 : 4;
      const base = K.R(cb);
      for (let i = 0; i < n; i++) {
        const a = (i / (n - 1) - 0.5) * (CR.type === 'fan' ? 1.6 : 0.8);
        const tip = [Math.sin(a) * ch * 0.6, base[1] + Math.cos(a) * ch, base[2] - ch * (CR.type === 'plume' ? 0.7 : 0.15)];
        K.X.tri2([base[0] - ctx.headR * 0.08, base[1], base[2]], [base[0] + ctx.headR * 0.08, base[1], base[2]], tip, mix3(C.secondary, C.accent, 0.4), mix3(C.secondary, C.accent, 0.4), C.accent, [0, 0, C.glowAmt * 0.5], [cb, cb, cb]);
      }
    } else if (CR.type === 'casque') {
      const hc = ctx.hc;
      K.el([0, hc[1] + ctx.hry * 0.85, hc[2] + ctx.hrz * 0.05], ctx.headR * 0.4, ch * 0.5, ctx.headR * 0.75, REG.CREST, ctx.head, ctx.headR * 0.3);
    } else if (CR.type === 'frills') {
      const n2 = ctx.neck[1];
      const fb = K.bone('frill', n2, [0, K.R(n2)[1], K.R(n2)[2] - ctx.headR * 0.3]);
      ctx.frill = fb;
      const fr = ch * 1.1, c0 = K.R(fb);
      const ring = [];
      for (let k = 0; k <= 8; k++) { const a = Math.PI * (0.05 + 0.9 * (k / 8)); ring.push([Math.cos(a) * fr * 1.1, c0[1] + Math.sin(a) * fr, c0[2] - fr * 0.35]); }
      const ctr = [0, c0[1], c0[2] + ctx.headR * 0.2];
      for (let k = 0; k < 8; k++) K.X.tri2(ctr, ring[k], ring[k + 1], mix3(C.secondary, C.accent, 0.3), k % 2 ? C.accent : C.secondary, k % 2 ? C.secondary : C.accent, [0, C.glowAmt * 0.6 * (k % 2), 0], [fb, fb, fb]);
    }
  }
  if (ph.spikes.rows > 0 && ph.spikes.len > 0.04) {
    const sl = ph.spikes.len * S;
    for (let r = 0; r < ph.spikes.rows; r++) {
      const sx = ph.spikes.rows === 2 ? (r ? 1 : -1) * T * 0.45 : 0;
      for (let i = 0; i < ph.spikes.count; i++) {
        const t = i / Math.max(1, ph.spikes.count - 1);
        const onTail = t < 0.35 && ctx.tail.length;
        let x, y, z, bi;
        if (onTail) {
          const ti = Math.min(ctx.tail.length - 1, Math.floor((1 - t / 0.35) * ctx.tail.length));
          const q = K.rest[ctx.tail[ti]];
          x = sx * 0.6; y = q.y + ph.tail.thick * S * 0.9; z = q.z; bi = ctx.tail[ti];
        } else {
          const tt = (t - 0.35) / 0.65;
          x = sx; y = hipY + (chestY - hipY) * tt + T * 0.95; z = zHip + (zChest - zHip) * tt;
          bi = spineBone(tt);
        }
        K.tube([x, y, z], [x * 1.3, y + sl, z - sl * 0.35], Math.max(S * 0.006, sl * 0.28), sl * 0.03, REG.CREST, bi);
      }
    }
  }
}

// ------------------------------------------------------------------ arthropods
function designArthropod(ctx) {
  const { ph, K, S, plan, C } = ctx;
  const B = ph.body, L = ph.legs;
  const T = ((B.girth + B.height) / 2) * S * 0.6;
  const crab = plan === 'crab';
  const legLen = L.len * S;
  const hipY = crab ? T * 0.9 + legLen * 0.25 : T * 0.8 + legLen * 0.32;
  const half = S * (plan === 'centipede' ? 0.45 : crab ? 0.12 : 0.22);
  const zHip = -half, zChest = half;
  Object.assign(ctx, { hipY, chestY: hipY, zHip, zChest, T, legLen });
  const hips = K.bone('hips', ctx.root, [0, hipY, zHip]);
  const spine = [];
  const nS = plan === 'centipede' ? Math.max(2, ph.body.segs) : 2;
  for (let i = 1; i <= nS; i++) { const t = i / (nS + 1); spine.push(K.bone('spine' + i, i === 1 ? hips : spine[i - 2], [0, hipY, zHip + (zChest - zHip) * t])); }
  const chest = K.bone('chest', spine[spine.length - 1], [0, hipY, zChest]);
  Object.assign(ctx, { hips, spine, chest });
  if (crab) {
    // a wide carapace with a scalloped rim
    K.el([0, hipY + T * 0.1, 0], T * 1.55, T * 0.75, T * 1.15, REG.SHELL, spine[0], T * 0.2);
    for (let i = 0; i < 6; i++) { const a = -1.1 + (2.2 * i) / 5; K.el([Math.sin(a) * T * 1.45, hipY + T * 0.05, Math.cos(a) * T * 0.95], T * 0.32, T * 0.25, T * 0.3, REG.SHELL, spine[0], T * 0.1); }
    K.el([0, hipY - T * 0.35, -T * 0.1], T * 1.1, T * 0.4, T * 0.8, REG.BODY, spine[0], T * 0.3);
  } else if (plan === 'centipede') {
    const segs = [hips, ...spine, chest];
    for (let i = 0; i < segs.length; i++) K.el(K.R(segs[i]), T * 0.7, T * 0.55, (2 * half / segs.length) * 0.7, REG.SHELL, segs[i], T * 0.15);
  } else {
    const abdR = plan === 'spider' ? T * 1.25 : T * 0.95;
    K.el([0, hipY + T * 0.2, zHip - abdR * 0.4], abdR, abdR * 0.9, abdR * (plan === 'spider' ? 1.15 : 1.45), REG.BODY, hips, T * 0.12);
    K.el([0, hipY, (zHip + zChest) / 2 + T * 0.2], T * 0.62, T * 0.55, half * 0.6, REG.SHELL, spine[0], T * 0.15);
  }
  // head: chunky, with mandibles, eyes and antennae
  ctx.neck = [K.bone('neck1', chest, [0, hipY, zChest + T * 0.2]), 0];
  ctx.neck[1] = K.bone('neck2', ctx.neck[0], [0, hipY + T * 0.05, zChest + T * 0.35]);
  const headR = ph.head.size * S * 0.5;
  const hc = crab ? [0, hipY + T * 0.2, T * 1.05] : [0, hipY + T * 0.1, zChest + T * 0.3 + headR * 0.6];
  buildHead(ctx, hc, headR, ctx.neck[1], { noBrow: true, flat: crab });
  // antennae
  ctx.antennae = [];
  if (plan !== 'spider') {
    for (const sd of [-1, 1]) {
      const a0 = K.bone(sd < 0 ? 'antR' : 'antL', ctx.head, [sd * headR * 0.3, hc[1] + ctx.hry * 0.6, hc[2] + ctx.hrz * 0.4]);
      const tip = [sd * headR * 1.1, hc[1] + headR * (crab ? 1.0 : 2.4), hc[2] + headR * 2.0];
      K.X.tube(K.R(a0), tip, headR * 0.07, headR * 0.035, C.secondary, a0, a0, 4);
      K.X.eye(tip, headR * 0.12, C.accent, 0.01, a0, C.glowAmt, false, [0, 0, 1]);
      ctx.antennae.push(a0);
      ctx.springs.push([a0]);
    }
  }
  // legs
  ctx.legs = [];
  const pairs = L.pairs;
  const legR = Math.max(S * 0.008, L.thick * S * (crab ? 0.75 : 1.0));
  for (let pi = 0; pi < pairs; pi++) {
    const t = pairs === 1 ? 0.5 : pi / (pairs - 1);
    const az = crab ? -T * 0.6 + T * 1.0 * t : zHip + (zChest - zHip) * (0.1 + 0.8 * t);
    const parent = plan === 'centipede' ? [hips, ...spine, chest][Math.min(spine.length + 1, Math.round(t * (spine.length + 1)))] : spine[Math.min(spine.length - 1, Math.round(t * (spine.length - 1)))];
    for (const sd of [-1, 1]) {
      const J = [sd * T * (crab ? 1.25 : 0.55), hipY - T * 0.1, az];
      const reach = legLen * (crab ? 0.75 : plan === 'spider' ? 0.9 : 0.8);
      const F = [sd * (T * (crab ? 1.3 : 0.6) + reach), 0, az + (plan === 'spider' ? (pi - 1.5) * legLen * 0.25 : crab ? (t - 0.5) * T * 0.8 : 0)];
      const Kp = [sd * (T * 0.6 + reach * 0.55), hipY + legLen * 0.3, (az + F[2]) / 2];
      const nm = `leg${pi}${sd < 0 ? 'R' : 'L'}`;
      const up = K.bone(nm + '0', parent, J), kn = K.bone(nm + '1', up, Kp), ft = K.bone(nm + '2', kn, [F[0], legR * 0.3, F[2]]);
      K.tube(J, Kp, legR * 1.35, legR, REG.LIMB, up, kn);
      K.tube(Kp, [F[0], legR * 0.3, F[2]], legR, legR * 0.4, REG.FOOT, kn, ft);
      K.el(Kp, legR * 1.15, legR * 1.15, legR * 1.15, REG.LIMB, kn, legR * 0.3);
      ctx.legs.push({ pair: pi, side: sd, upper: up, knee: kn, foot: ft, parent, front: pi === pairs - 1, hip: new THREE.Vector3(...J), footRest: new THREE.Vector3(F[0], 0, F[2]) });
    }
  }
  // crabs: a pair of big pincers on arms
  ctx.arms = [];
  if (crab) {
    const chunk = ph.shape.limbChunk;
    for (const sd of [-1, 1]) {
      const nm = `arm${sd < 0 ? 'R' : 'L'}`;
      const a0 = K.bone(nm + '0', chest, [sd * T * 0.9, hipY, T * 0.7]);
      const a1 = K.bone(nm + '1', a0, [sd * T * 1.6, hipY + T * 0.2, T * 1.3]);
      const a2 = K.bone(nm + '2', a1, [sd * T * 1.15, hipY + T * 0.15, T * 2.0]);
      K.rc(K.R(a0), K.R(a1), legR * 1.5 * chunk, legR * 1.3 * chunk, REG.LIMB, a0, a1, legR, 0.8);
      K.rc(K.R(a1), K.R(a2), legR * 1.3 * chunk, legR * 1.2 * chunk, REG.LIMB, a1, a2, legR, 0.8);
      const cs = T * 0.55 * chunk;
      K.el(add(K.R(a2), [0, 0, cs * 0.5]), cs * 0.75, cs * 0.6, cs * 1.1, REG.SHELL, a2, cs * 0.3);
      const fing = K.bone(nm + 'F', a2, add(K.R(a2), [0, cs * 0.2, cs * 1.3]));
      const fp = K.R(fing);
      K.X.cone(add(K.R(a2), [0, cs * 0.25, cs * 1.4]), add(fp, [sd * cs * 0.1, cs * 0.05, cs * 1.0]), cs * 0.32, mix3(C.secondary, C.accent, 0.3), a2, 5);
      K.X.cone(add(K.R(a2), [0, -cs * 0.2, cs * 1.2]), add(fp, [0, -cs * 0.35, cs * 0.75]), cs * 0.28, mix3(C.secondary, C.accent, 0.3), fing, 5);
      ctx.arms.push({ side: sd, b0: a0, b1: a1, b2: a2, pincer: fing });
    }
  }
  if (ph.wings.type !== 'none') buildWings(ctx);
  else ctx.wings = [];
  ctx.tail = [];
  if (ph.tail.tip === 'stinger' && plan !== 'crab') {
    const tb = K.bone('tail1', hips, [0, hipY + T * 0.8, zHip - T * 1.6]);
    K.tube([0, hipY + T * 0.3, zHip - T * 1.2], K.R(tb), T * 0.3, T * 0.15, REG.BODY, hips, tb);
    K.tube(K.R(tb), [0, hipY + T * 1.2, zHip - T * 1.1], T * 0.18, T * 0.02, REG.HORN, tb);
    ctx.tail.push(tb);
  }
}

// ------------------------------------------------------------------ molluscs
function designSlug(ctx) {
  const { ph, K, S, C } = ctx;
  const B = ph.body;
  const T = ((B.girth + B.height) / 2) * S * 0.75;
  const hipY = T * 0.6;
  const zHip = -S * 0.15, zChest = S * 0.18;
  Object.assign(ctx, { hipY, chestY: hipY, zHip, zChest, T, legLen: 0 });
  const hips = K.bone('hips', ctx.root, [0, hipY, zHip]);
  const s1 = K.bone('spine1', hips, [0, hipY, zHip * 0.4 + zChest * 0.6 - S * 0.05]);
  const s2 = K.bone('spine2', s1, [0, hipY, (zHip + zChest * 2) / 3]);
  const chest = K.bone('chest', s2, [0, hipY, zChest]);
  Object.assign(ctx, { hips, spine: [s1, s2], chest });
  // a soft body on a broad creeping foot
  const pts = [[0, hipY * 0.75, -S * 0.5], [0, hipY, zHip], [0, hipY * 1.05, (zHip + zChest) / 2], [0, hipY, zChest]];
  const rads = [T * 0.32, T * 0.85, T, T * 0.85];
  const bs = [hips, hips, s1, chest];
  for (let i = 0; i < 3; i++) K.rc(pts[i], pts[i + 1], rads[i], rads[i + 1], REG.BODY, bs[i], bs[i + 1], T * 0.5, 0.5, 1.2);
  K.rc([0, T * 0.22, -S * 0.45], [0, T * 0.22, zChest + T * 0.3], T * 0.4, T * 0.6, REG.FOOT, hips, chest, T * 0.4, 0.5, 2.0);
  // tail chain (for the creeping wave)
  ctx.tail = [K.bone('tail1', hips, [0, hipY * 0.85, -S * 0.32]), 0];
  ctx.tail[1] = K.bone('tail2', ctx.tail[0], [0, hipY * 0.7, -S * 0.5]);
  // a coiled shell on the back: a log spiral of shrinking balls (metaballs make the whorl)
  if (ph.shell.size > 0) {
    const sr = ph.shell.size * S * 0.55;
    const c = [0, hipY + T * 0.55 + sr * 0.75, (zHip + zChest) / 2 - S * 0.05];
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = i * 0.62 * (ph.shell.whorl / 3);
      const k = Math.exp(-0.17 * i);
      const rr = sr * 0.62 * k;
      K.el([sr * 0.12 * (1 - k), c[1] + Math.sin(a) * sr * 0.55 * k, c[2] - Math.cos(a) * sr * 0.55 * k], rr * 0.85, rr, rr, REG.SHELL, s1, rr * 0.35);
    }
    ctx.shell = s1;
  }
  // a raised head on a short neck
  const n1 = K.bone('neck1', chest, [0, hipY * 1.25, zChest + T * 0.35]);
  const n2 = K.bone('neck2', n1, [0, hipY * 1.55, zChest + T * 0.6]);
  K.rc([0, hipY, zChest], K.R(n2), T * 0.8, T * 0.6, REG.NECK, chest, n2, T * 0.5, 0.5);
  ctx.neck = [n1, n2];
  const headR = ph.head.size * S * 0.45;
  const hc = [0, K.R(n2)[1] + headR * 0.2, K.R(n2)[2] + headR * 0.45];
  buildHead(ctx, hc, headR, n2, { noBrow: true });
  // lower feelers
  for (const sd of [-1, 1]) {
    const a = [sd * ctx.hrx * 0.5, hc[1] - ctx.hry * 0.3, hc[2] + ctx.hrz * 0.7];
    K.tube(a, [sd * ctx.hrx * 0.9, hc[1] - ctx.hry * 0.55, hc[2] + ctx.hrz * 1.4], headR * 0.16, headR * 0.1, REG.LIMB, ctx.head);
  }
  ctx.legs = []; ctx.wings = []; ctx.arms = [];
  void C;
}

// ------------------------------------------------------------------ medusoids
function designFloater(ctx) {
  const { ph, K, S, C } = ctx;
  const B = ph.body;
  const R = B.girth * S * 0.75, H = B.height * S * 0.85;
  const tl = ph.tentacles.len * S * 0.9;
  const cy = tl + H * 0.5;
  Object.assign(ctx, { hipY: cy, chestY: cy, zHip: 0, zChest: 0, T: R, legLen: 0 });
  const bell = K.bone('hips', ctx.root, [0, cy, 0]);
  const top = K.bone('chest', bell, [0, cy + H * 0.5, 0]);
  Object.assign(ctx, { hips: bell, spine: [], chest: top, bell });
  // the bell: a dome with a scalloped, glowing rim
  K.el([0, cy + H * 0.15, 0], R, H * 0.85, R, REG.BODY, bell, R * 0.3);
  K.el([0, cy + H * 0.65, 0], R * 0.6, H * 0.45, R * 0.6, REG.BODY, top, R * 0.4);
  const nr = 10;
  for (let i = 0; i < nr; i++) {
    const a = (i / nr) * Math.PI * 2;
    K.el([Math.cos(a) * R * 0.9, cy - H * 0.38, Math.sin(a) * R * 0.9], R * 0.26, H * 0.18, R * 0.26, REG.RIM, bell, R * 0.12);
  }
  ctx.neck = [bell, bell];
  // a face on the front of the bell
  const headR = R * 0.85;
  ctx.head = K.bone('head', bell, [0, cy + H * 0.1, R * 0.15]);
  ctx.headR = headR; ctx.hc = [0, cy + H * 0.1, 0]; ctx.hrx = R; ctx.hry = H * 0.85; ctx.hrz = R;
  ctx.jaw = K.bone('jaw', ctx.head, [0, cy - H * 0.3, R * 0.5]);
  ctx.ears = [];
  buildEyes(ctx, ctx.hc, headR, ctx.head);
  const mc = [0, cy - H * 0.45, 0];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; K.el([Math.cos(a) * R * 0.22, mc[1], Math.sin(a) * R * 0.22], R * 0.12, R * 0.1, R * 0.12, REG.SNOUT, ctx.jaw, R * 0.06); }
  // tentacles: springy chains hanging from under the rim, and frilled oral arms
  ctx.tentacles = [];
  const n = ph.tentacles.n;
  const thin = Math.max(S * 0.006, R * 0.06);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.3;
    const base = [Math.cos(a) * R * 0.75, cy - H * 0.42, Math.sin(a) * R * 0.75];
    const chain = [];
    let prev = base, prevB = bell;
    for (let j = 1; j <= 3; j++) {
      const t = j / 3;
      const p = [base[0] * (1 - 0.15 * t), base[1] - tl * t, base[2] * (1 - 0.15 * t)];
      const b = K.bone(`ten${i}_${j}`, prevB, p);
      K.X.tube(prev, p, thin * (1.3 - 0.4 * t), thin * (1 - 0.4 * t), mix3(C.secondary, C.accent, 0.3 + 0.2 * t), prevB, b, 4, C.glowAmt * 0.6 * t, j === 3);
      chain.push(b); prev = p; prevB = b;
    }
    ctx.tentacles.push(chain);
    ctx.springs.push(chain);
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const b0 = K.bone(`arm${i}`, bell, [Math.cos(a) * R * 0.15, cy - H * 0.45, Math.sin(a) * R * 0.15]);
    const b1 = K.bone(`arm${i}_1`, b0, [Math.cos(a) * R * 0.3, cy - H * 0.45 - tl * 0.55, Math.sin(a) * R * 0.3]);
    const w = R * 0.18;
    const col = mix3(C.primary, C.accent, 0.4);
    const p0 = K.R(b0), p1 = K.R(b1);
    K.X.tri2([p0[0] - w, p0[1], p0[2]], [p0[0] + w, p0[1], p0[2]], [p1[0] + w * 0.5, p1[1], p1[2]], col, col, C.accent, [C.glowAmt * 0.3, C.glowAmt * 0.3, C.glowAmt], [b0, b0, b1]);
    K.X.tri2([p0[0] - w, p0[1], p0[2]], [p1[0] + w * 0.5, p1[1], p1[2]], [p1[0] - w * 0.5, p1[1], p1[2]], col, C.accent, C.accent, [C.glowAmt * 0.3, C.glowAmt, C.glowAmt], [b0, b1, b1]);
    ctx.springs.push([b0, b1]);
  }
  ctx.legs = []; ctx.wings = []; ctx.arms = []; ctx.tail = [];
}

// ------------------------------------------------------------------ rollers
function designRoller(ctx) {
  const { ph, K, S } = ctx;
  const R = ph.body.height * S;
  const hipY = R * 1.02;
  Object.assign(ctx, { hipY, chestY: hipY, zHip: 0, zChest: 0, T: R, legLen: 0 });
  const hips = K.bone('hips', ctx.root, [0, hipY, 0]);
  const s1 = K.bone('spine1', hips, [0, hipY, 0]);
  const chest = K.bone('chest', s1, [0, hipY, 0]);
  Object.assign(ctx, { hips, spine: [s1], chest });
  K.el([0, hipY, 0], R, R, R * 1.05, REG.SHELL, s1, R * 0.2);
  for (let i = 0; i < 8; i++) {
    const a = i * 2.39996, y = 1 - (i + 0.5) / 4;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    K.el([Math.cos(a) * rr * R * 0.85, hipY + y * R * 0.85, Math.sin(a) * rr * R * 0.85], R * 0.35, R * 0.3, R * 0.35, REG.SHELL, s1, R * 0.08);
  }
  ctx.neck = [K.bone('neck1', chest, [0, hipY, R * 0.5]), 0];
  ctx.neck[1] = K.bone('neck2', ctx.neck[0], [0, hipY, R * 0.7]);
  // a face peeking out of the stone
  const headR = R * 0.5;
  buildHead(ctx, [0, hipY + R * 0.05, R * 0.62], headR, ctx.neck[1], { noBrow: true });
  ctx.legs = []; ctx.wings = []; ctx.arms = []; ctx.tail = [];
}

// ------------------------------------------------------------------ finish
function finish(ctx, opts) {
  const { K, ph } = ctx;
  const P = K.P;
  // grid size from the extent and the thickness of the main parts
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, minMain = Infinity;
  for (const p of P) {
    const r = p.t === EL ? Math.max(p.rx, p.ry, p.rz) : Math.max(p.ra, p.rb) * Math.max(1, p.sx || 1);
    const cx = p.t === EL ? [p.cx, p.cx] : [p.ax, p.bx], cy = p.t === EL ? [p.cy, p.cy] : [p.ay, p.by], cz = p.t === EL ? [p.cz, p.cz] : [p.az, p.bz];
    x0 = Math.min(x0, cx[0] - r, cx[1] - r); x1 = Math.max(x1, cx[0] + r, cx[1] + r);
    y0 = Math.min(y0, cy[0] - r, cy[1] - r); y1 = Math.max(y1, cy[0] + r, cy[1] + r);
    z0 = Math.min(z0, cz[0] - r, cz[1] - r); z1 = Math.max(z1, cz[0] + r, cz[1] + r);
    if (p.reg === REG.BODY || p.reg === REG.HEAD || p.reg === REG.NECK) minMain = Math.min(minMain, p.t === EL ? Math.min(p.rx, p.ry, p.rz) : Math.min(p.ra, p.rb));
  }
  const ext = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-3);
  const res = opts.res || 30;
  const h = Math.max(ext / (res * 1.6), Math.min(ext / res, minMain / 1.5));
  // flat parts stay thick enough to be sampled; parts thinner than the grid become tubes
  for (const p of P) {
    if (p.t === EL && (p.reg === REG.CREST || p.reg === REG.EAR)) { p.rx = Math.max(p.rx, h * 0.75); p.ry = Math.max(p.ry, h * 0.75); p.rz = Math.max(p.rz, h * 0.75); }
  }
  const keep = [];
  for (const p of P) {
    const r = p.t === EL ? Math.min(p.rx, p.ry, p.rz) : Math.max(p.ra, p.rb);
    if (p.t === RC && r < h * 0.9 && p.reg !== REG.BODY) K.thin.push({ a: [p.ax, p.ay, p.az], b: [p.bx, p.by, p.bz], ra: p.ra, rb: p.rb, reg: p.reg, b0: p.b0, b1: p.b1 });
    else if (p.t === EL && Math.max(p.rx, p.ry, p.rz) < h * 0.7) continue;    // too small to see at this size
    else keep.push(p);
  }
  const C = ph.colors, fam = ph.family;
  const pal = {
    primary: C.primary, secondary: C.secondary, belly: C.belly, accent: C.accent, glow: C.glow, glowAmt: C.glowAmt,
    horn: fam === 'bird' ? mix3(C.accent, [0.95, 0.78, 0.3], 0.55) : mix3([0.88, 0.82, 0.68], C.accent, 0.2),
    mouth: [0.3, 0.07, 0.09], pattern: ph.pattern.type, pscale: ph.pattern.scale, contrast: ph.pattern.contrast,
    seed: ctx.seed, S: ctx.S, saddleZ: ((ctx.zHip || 0) + (ctx.zChest || 0)) / 2,
  };
  // thin parts as explicit tubes, coloured like the skin region they belong to
  for (const tp of K.thin) {
    const len = Math.hypot(tp.b[0] - tp.a[0], tp.b[1] - tp.a[1], tp.b[2] - tp.a[2]);
    if (len < 1e-5) continue;
    const sides = Math.max(tp.ra, tp.rb) > h * 0.35 ? 7 : 5;
    K.X.tube(tp.a, tp.b, Math.max(tp.ra, 0.0015), Math.max(tp.rb, 0.001), regionColor(pal, tp.reg), tp.b0, tp.b1 ?? tp.b0, sides, tp.reg === REG.RIM ? C.glowAmt : 0, true);
  }
  const hc = ctx.hc || [0, ctx.hipY, 0];
  let top = 0;
  for (const r of K.rest) top = Math.max(top, r.y);
  const height = Math.max(top, hc[1] + (ctx.headR || 0)) + (ph.horns.type !== 'none' ? ph.horns.len * ctx.S * 0.6 : 0);
  const rig = {
    bones: K.bones, named: K.named, rest: K.rest, root: ctx.root, hips: ctx.hips, chest: ctx.chest, spine: ctx.spine || [],
    neck: ctx.neck || [], head: ctx.head, jaw: ctx.jaw, tail: (ctx.tail || []).filter((b) => b > 0), legs: ctx.legs || [], arms: ctx.arms || [], wings: ctx.wings || [],
    ears: ctx.ears || [], frill: ctx.frill, eyes: ctx.eyes || [], antennae: ctx.antennae || [], springs: ctx.springs,
    stalks: ctx.stalks || [], trunk: ctx.trunk || null, tentacles: ctx.tentacles || [], bell: ctx.bell ?? null, shell: ctx.shell ?? null,
    hipY: ctx.hipY, chestY: ctx.chestY, zHip: ctx.zHip, zChest: ctx.zChest, legLen: ctx.legLen || 0, len: ctx.S, gir: ctx.T, hgt: ctx.T, headR: ctx.headR || ctx.T,
  };
  const front = Math.max(...K.rest.map((r) => r.z)) + (ctx.headR || 0) * 0.6;
  const back = Math.min(...K.rest.map((r) => r.z));
  return { rig, height, length: front - back, desc: { parts: keep, pal, res, h }, shapes: K.X.out() };
}

function regionColor(pal, reg) {
  switch (reg) {
    case REG.HORN: return pal.horn;
    case REG.CLAW: return mix3(pal.horn, [0.1, 0.09, 0.08], 0.5);
    case REG.HOOF: return mix3(pal.horn, [0.08, 0.07, 0.07], 0.65);
    case REG.FOOT: return mix3(pal.secondary, [0.12, 0.1, 0.1], 0.35);
    case REG.CREST: return mix3(pal.secondary, pal.accent, 0.5);
    case REG.RIM: case REG.TIP: return mix3(pal.secondary, pal.accent, 0.55);
    case REG.LIMB: return mix3(pal.primary, pal.secondary, 0.3);
    case REG.MOUTH: return pal.mouth;
    default: return pal.primary;
  }
}

// ------------------------------------------------------------------ assembly
function assemble(design, skin) {
  const m = skin ? mergeMeshes([skin, design.shapes]) : design.shapes;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(m.glow, 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(m.skin, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(m.wts, 4));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  g.computeBoundingSphere();
  const rig = design.rig;
  const mesh = new THREE.SkinnedMesh(g, creatureMaterial());
  const skeleton = new THREE.Skeleton(rig.bones);
  mesh.add(rig.bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(skeleton);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  g.boundingSphere.radius *= 1.6;
  rig.restQ = rig.bones.map((b) => b.quaternion.clone());
  rig.restP = rig.bones.map((b) => b.position.clone());
  rig.restS = rig.bones.map((b) => b.scale.clone());
  return { mesh, rig, height: design.height, length: design.length, radius: g.boundingSphere.radius, vertices: m.pos.length / 3 };
}

/** Build a creature now, on this thread. */
export function buildCreature(ph, seed = 1, opts = {}) {
  const d = designCreature(ph, seed, opts);
  return assemble(d, meshParts(d.desc));
}

/** Build a creature with its skin computed in a worker (falls back to this thread). */
export function buildCreatureAsync(ph, seed = 1, opts = {}) {
  const d = designCreature(ph, seed, opts);
  const w = worker();
  if (!w) return Promise.resolve(assemble(d, meshParts(d.desc)));
  return new Promise((resolve) => {
    const id = ++JOB;
    JOBS.set(id, (skin) => resolve(assemble(d, skin || meshParts(d.desc))));
    w.postMessage({ id, desc: d.desc });
  });
}
