// Procedural creature bodies. Every individual gets its own skeleton and a
// single skinned, flat-shaded mesh built from its phenotype: a lofted torso,
// neck, head and tail, tapered limbs with feet and claws, wings (feathered,
// membrane, gliding patagium or insect), and ornaments (horns, crests, sails,
// spikes, frills, ears, whiskers, tail tips, plates). Colours and pattern
// (stripes, spots, bands, mottling, saddles, eye-spots) are baked per vertex;
// bioluminescent markings and glowing eyes go to a glow attribute.
// One draw call per creature; one shared material for all of them.
import * as THREE from 'three';
import { shared } from '../render/materials.js';

const TAU = Math.PI * 2;

// ------------------------------------------------------------------ material
let MATERIAL = null;
export function creatureMaterial() {
  if (MATERIAL) return MATERIAL;
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aGlow;
varying float vGlow;
varying vec3 vWPosC;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_COLOR
  vColor.rgb = pow(vColor.rgb, vec3(2.2));
#endif
  vGlow = aGlow;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vWPosC = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uDeepLight;
uniform vec3 uAbyssGlow;
uniform vec3 uLampPos;
uniform vec3 uLampColor;
uniform float uLampRange;
varying float vGlow;
varying vec3 vWPosC;`)
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
  // bioluminescence: subtle in daylight, vivid in the dark of the deep layers
  totalEmissiveRadiance += diffuseColor.rgb * vGlow * (0.9 + 0.35 * sin(uTime * 2.2 + vWPosC.x * 3.0 + vWPosC.z * 2.0)) * mix(1.6, 0.35, smoothstep(-700.0, -150.0, vWPosC.y));`);
  };
  m.customProgramCacheKey = () => 'creature-v2';
  MATERIAL = m;
  return m;
}

// ------------------------------------------------------------------ geometry builder
class Builder {
  constructor() { this.pos = []; this.col = []; this.glow = []; this.si = []; this.sw = []; this.idx = []; this.n = 0; }
  v(x, y, z, c, g, b0, b1 = b0, w1 = 0) {
    this.pos.push(x, y, z); this.col.push(c[0], c[1], c[2]); this.glow.push(g);
    this.si.push(b0, b1, 0, 0); this.sw.push(1 - w1, w1, 0, 0);
    return this.n++;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  /** Double-sided triangle fan / strip helpers for flat parts. */
  tri2(a, b, c) { this.idx.push(a, b, c, a, c, b); }
  quad2(a, b, c, d) { this.quad(a, b, c, d); this.quad(a, d, c, b); }

  /**
   * Loft through a path of rings. pts: [{x,y,z, rx, ry, b0, b1, w, dx,dy,dz (optional up hint)}]
   * colorFn(i, j, px, py, pz, ang) -> [color, glow]
   */
  loft(pts, sides, colorFn, capStart = true, capEnd = true) {
    const rings = [];
    const tmp = new THREE.Vector3(), t = new THREE.Vector3(), up = new THREE.Vector3(), side = new THREE.Vector3(), nup = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      t.set(b.x - a.x, b.y - a.y, b.z - a.z);
      if (t.lengthSq() < 1e-10) t.set(0, 0, 1);
      t.normalize();
      up.set(0, 1, 0);
      if (Math.abs(t.dot(up)) > 0.92) up.set(0, 0, -Math.sign(t.y) || 1);
      side.crossVectors(up, t).normalize();
      nup.crossVectors(t, side).normalize();
      const ring = [];
      for (let j = 0; j < sides; j++) {
        const ang = (j / sides) * TAU;
        const cx = Math.cos(ang), cy = Math.sin(ang);
        // flatter belly: squash the lower half a little
        const ry = cy < 0 ? p.ry * (p.flat ?? 0.85) : p.ry;
        tmp.set(p.x, p.y, p.z).addScaledVector(side, cx * p.rx).addScaledVector(nup, cy * ry);
        const [col, g] = colorFn(i, j, tmp.x, tmp.y, tmp.z, ang, cy);
        ring.push(this.v(tmp.x, tmp.y, tmp.z, col, g, p.b0, p.b1 ?? p.b0, p.w ?? 0));
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++) {
      const A = rings[i], B = rings[i + 1];
      for (let j = 0; j < sides; j++) { const k = (j + 1) % sides; this.quad(A[j], A[k], B[k], B[j]); }
    }
    const capRing = (ring, p, flip) => {
      const [col, g] = colorFn(flip ? pts.length - 1 : 0, 0, p.x, p.y, p.z, 0, 0);
      const c = this.v(p.x, p.y, p.z, col, g, p.b0, p.b1 ?? p.b0, p.w ?? 0);
      for (let j = 0; j < sides; j++) { const k = (j + 1) % sides; if (flip) this.tri(ring[j], ring[k], c); else this.tri(ring[k], ring[j], c); }
    };
    if (capStart) capRing(rings[0], pts[0], false);
    if (capEnd) capRing(rings[rings.length - 1], pts[pts.length - 1], true);
    return rings;
  }

  /** Tapered tube between two points (6 sides), skinned to b0 at the start, b1 at the end. */
  tube(ax, ay, az, bx, by, bz, r0, r1, c, b0, b1, sides = 6, g = 0) {
    this.loft([{ x: ax, y: ay, z: az, rx: r0, ry: r0, b0, flat: 1 }, { x: bx, y: by, z: bz, rx: r1, ry: r1, b0: b1, flat: 1 }], sides, () => [c, g], true, true);
  }

  /** Cone from base centre to tip. */
  cone(bx, by, bz, tx, ty, tz, r, c, bone, sides = 5, g = 0) {
    this.loft([{ x: bx, y: by, z: bz, rx: r, ry: r, b0: bone, flat: 1 }, { x: tx, y: ty, z: tz, rx: 0.0001, ry: 0.0001, b0: bone, flat: 1 }], sides, () => [c, g], true, false);
  }

  /** Low-poly ellipsoid. */
  blob(x, y, z, rx, ry, rz, c, bone, g = 0, segs = 6) {
    const pts = [];
    const rings = 4;
    for (let i = 0; i <= rings; i++) {
      const a = (i / rings) * Math.PI;
      const s = Math.max(0.0001, Math.sin(a));
      pts.push({ x, y, z: z - Math.cos(a) * rz, rx: rx * s, ry: ry * s, b0: bone, flat: 1 });
    }
    this.loft(pts, segs, () => [c, g], false, false);
  }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    geo.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

// ------------------------------------------------------------------ patterns
function hash3(x, y, z) { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const L = (a, b, t) => a + (b - a) * t;
  return L(L(L(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), u), L(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), u), v),
    L(L(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), u), L(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), u), v), w);
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Body colour at a point: pattern between primary and secondary, belly below,
 * and the glow mask for bioluminescent markings. u: 0 tail .. 1 head along the
 * body, side: -1..1 across, up: -1 belly .. 1 back.
 */
function makePainter(ph, seed) {
  const C = ph.colors, P = ph.pattern;
  const sc = P.scale, k = P.contrast;
  const o = (seed % 997) * 0.37;
  return (u, side, up, x, y, z) => {
    let m = 0;
    switch (P.type) {
      case 'stripes': m = Math.sin(u * 22 * sc + Math.sin(side * 3) * 0.6) > 0.25 ? 1 : 0; break;
      case 'bands': m = Math.sin(u * 9 * sc + o) > 0.45 ? 1 : 0; break;
      case 'spots': m = vnoise(x * 9 * sc + o, y * 9 * sc, z * 9 * sc) > 0.66 ? 1 : 0; break;
      case 'mottled': m = vnoise(x * 5 * sc + o, y * 5 * sc, z * 5 * sc) * 0.7 + vnoise(x * 13 * sc, y * 13 * sc + o, z * 13 * sc) * 0.3 > 0.52 ? 1 : 0; break;
      case 'gradient': m = Math.max(0, Math.min(1, 0.5 + up * 0.8 - (1 - u) * 0.3)); break;
      case 'saddle': m = up > 0.3 && u > 0.3 && u < 0.72 ? 1 : 0; break;
      case 'ocelli': { const r = vnoise(x * 5 * sc + o, y * 5 * sc, z * 5 * sc); m = r > 0.7 ? 1 : r > 0.63 ? 0.5 : 0; break; }
      default: m = 0;
    }
    let col = mix3(C.primary, C.secondary, m * k);
    // countershading: lighter belly
    if (up < -0.25) col = mix3(col, C.belly, Math.min(1, (-up - 0.25) * 2.2));
    // bioluminescent markings: rows of spots along the flanks and the back line
    let g = 0;
    if (C.glowAmt > 0) {
      const flank = Math.abs(side) > 0.55 && Math.abs(up) < 0.45 && Math.sin(u * 40 + o) > 0.55;
      const dorsal = up > 0.85 && Math.sin(u * 30 + o * 2) > 0.3;
      if (flank || dorsal) { g = C.glowAmt; col = mix3(col, C.glow, 0.85); }
    }
    return [col, g];
  };
}

// ------------------------------------------------------------------ skeleton + body
/**
 * Build the skinned mesh of an individual. Returns
 * { mesh, bones, rig, height, length, radius }.
 */
export function buildCreature(ph, seed = 1) {
  const S = ph.scale;
  const B = new Builder();
  const bones = [];
  const named = {};
  const rest = [];   // bind-pose world (root-space) positions per bone
  const bone = (name, parent, x, y, z) => {
    const b = new THREE.Bone();
    b.name = name;
    const i = bones.length;
    bones.push(b);
    rest.push(new THREE.Vector3(x, y, z));
    if (parent >= 0) { bones[parent].add(b); b.position.set(x - rest[parent].x, y - rest[parent].y, z - rest[parent].z); } else b.position.set(x, y, z);
    named[name] = i;
    return i;
  };
  const paint = makePainter(ph, seed);
  const C = ph.colors;
  const plan = ph.plan;
  const L = ph.legs;
  const body = ph.body;
  // --- proportions in metres
  // body (pelvis to chest) length: birds, bats and insects are compact around their wings
  const len = S * (plan === 'avian' ? 0.55 : plan === 'bat' ? 0.5 : plan === 'insect' ? 0.8 : 1);
  const gir = body.girth * S, hgt = body.height * S;
  const legLen = L.len * S;
  const sprawl = L.posture === 'sprawl' || L.posture === 'arthropod';
  const flier = ph.wings.type === 'feather' || ph.wings.type === 'membrane';
  // standing height of the belly's centre line
  let hipY;
  if (plan === 'serpent' || plan === 'roller') hipY = hgt;
  else if (sprawl) hipY = hgt + legLen * 0.35;
  else if (L.biped) hipY = legLen * 0.92 + hgt * 0.15;
  else hipY = legLen * 0.95 + hgt * 0.5;
  if (plan === 'golem') hipY = legLen * 0.9 + hgt * 0.7;
  const zHip = -len * 0.42, zChest = len * 0.42;
  const chestY = L.biped ? hipY + len * 0.45 : hipY + (plan === 'golem' ? hgt * 0.15 : len * 0.05);
  // biped torsos lean forward; the chest sits higher
  const root = bone('root', -1, 0, 0, 0);
  const hips = bone('hips', root, 0, hipY, zHip);
  const nSpine = Math.max(2, plan === 'centipede' ? body.segs : 2);
  const spine = [];
  for (let i = 1; i <= nSpine; i++) {
    const t = i / (nSpine + 1);
    spine.push(bone('spine' + i, i === 1 ? hips : spine[i - 2], 0, hipY + (chestY - hipY) * t, zHip + (zChest - zHip) * t));
  }
  const chest = bone('chest', spine[spine.length - 1], 0, chestY, zChest);
  // --- neck and head
  const neckLen = ph.neck.len * S;
  const upright = plan === 'avian' || plan === 'biped' ? 0.75 : plan === 'quadruped' || plan === 'golem' ? 0.45 : plan === 'bat' ? 0.3 : 0.15;
  const nx0 = zChest + gir * 0.4, ny0 = chestY + hgt * 0.25;
  const n1 = bone('neck1', chest, 0, ny0 + neckLen * 0.5 * upright, nx0 + neckLen * 0.5 * Math.sqrt(1 - upright * upright));
  const n2 = bone('neck2', n1, 0, ny0 + neckLen * upright, nx0 + neckLen * Math.sqrt(1 - upright * upright));
  const headR = ph.head.size * S * 0.5;
  const hx = rest[n2].z + headR * 0.4, hy = rest[n2].y + headR * 0.25;
  const head = bone('head', n2, 0, hy, hx);
  const snoutL = ph.head.snout * ph.head.size * S;
  const jaw = bone('jaw', head, 0, hy - headR * 0.35, hx + headR * 0.2);
  // --- tail
  const tailLen = ph.tail.len * S;
  const tail = [];
  const nT = tailLen > 0.01 ? ph.tail.segs : 0;
  for (let i = 1; i <= nT; i++) {
    const t = i / nT;
    const droop = plan === 'avian' ? 0.15 : plan === 'biped' ? 0.05 : sprawl || plan === 'serpent' ? 0.0 : 0.45;
    tail.push(bone('tail' + i, i === 1 ? hips : tail[i - 2], 0, hipY + hgt * 0.15 - tailLen * t * droop * (plan === 'serpent' ? 0 : 1) - (sprawl ? (hipY - hgt) * t * 0.9 : 0), zHip - gir * 0.5 - tailLen * t * 0.98));
  }

  // --- torso loft (tail base -> hips -> spine -> chest -> neck base)
  const sides = plan === 'golem' ? 6 : 8;
  const torso = [];
  const bodyPts = [{ z: zHip - gir * 0.7, y: hipY + (plan === 'serpent' ? 0 : hgt * 0.05), r: 0.55, b: hips }];
  bodyPts.push({ z: zHip, y: hipY, r: 0.95, b: hips });
  spine.forEach((sb, i) => { const t = (i + 1) / (spine.length + 1); bodyPts.push({ z: rest[sb].z, y: rest[sb].y + body.hump * S * Math.sin(Math.PI * t), r: 1.0 + (plan === 'golem' ? 0.1 : 0) - (plan === 'avian' ? 0.1 * t : 0), b: sb }); });
  bodyPts.push({ z: zChest, y: chestY, r: plan === 'bat' || plan === 'avian' ? 1.0 : 0.9, b: chest });
  bodyPts.push({ z: zChest + gir * 0.55, y: chestY + hgt * 0.15, r: 0.6, b: chest });
  const zMin = bodyPts[0].z, zMax = bodyPts[bodyPts.length - 1].z;
  for (const p of bodyPts) torso.push({ x: 0, y: p.y, z: p.z, rx: gir * p.r, ry: hgt * p.r, b0: p.b });
  B.loft(torso, sides, (i, j, x, y, z, ang, cy) => paint((z - zMin) / (zMax - zMin) * 0.7 + 0.15, Math.cos(ang), cy, x / S, y / S, z / S));
  // shaggy fur: a second, rougher shell of tufts along the back
  if (ph.shag > 0.65) {
    for (let i = 1; i < torso.length - 1; i++) {
      const p = torso[i];
      B.cone(p.x, p.y + p.ry * 0.7, p.z, p.x, p.y + p.ry * (1.15 + ph.shag * 0.35), p.z - gir * 0.25, gir * 0.35, C.secondary, p.b0, 4);
    }
  }
  // stone plates on golems and armoured reptiles
  if (ph.plates > 0.3) {
    const n = Math.round(3 + ph.plates * 4);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const z = zHip + (zChest - zHip) * t, y = hipY + (chestY - hipY) * t + hgt * 0.85;
      const bi = spine[Math.min(spine.length - 1, Math.floor(t * spine.length))];
      B.blob(0, y, z, gir * (0.55 + 0.25 * Math.sin(i * 1.7)), hgt * 0.22, len / n * 0.55, C.secondary, bi, 0, 5);
    }
  }

  // --- neck loft
  const nThick = ph.neck.thick;
  if (neckLen > 0.01) {
    B.loft([
      { x: 0, y: ny0, z: nx0 - gir * 0.2, rx: gir * nThick, ry: hgt * nThick, b0: chest },
      { x: 0, y: rest[n1].y, z: rest[n1].z, rx: gir * nThick * 0.85, ry: hgt * nThick * 0.85, b0: n1 },
      { x: 0, y: rest[n2].y, z: rest[n2].z, rx: gir * nThick * 0.75, ry: hgt * nThick * 0.75, b0: n2 },
    ], 7, (i, j, x, y, z, ang, cy) => paint(0.85, Math.cos(ang), cy, x / S, y / S, z / S), false, false);
  }

  // --- head: cranium and snout, beak or mandibles; lower jaw on its own bone
  const hc = rest[head];
  const fam = ph.family;
  const snoutR = headR * (fam === 'bird' ? 0.55 : 0.6);
  B.loft([
    { x: 0, y: hc.y - headR * 0.05, z: hc.z - headR * 0.85, rx: headR * 0.6, ry: headR * 0.55, b0: head },
    { x: 0, y: hc.y + headR * 0.1, z: hc.z - headR * 0.2, rx: headR * 0.95, ry: headR * 0.9, b0: head },
    { x: 0, y: hc.y + headR * 0.05, z: hc.z + headR * 0.45, rx: headR * 0.85, ry: headR * 0.75, b0: head },
    { x: 0, y: hc.y - headR * 0.05, z: hc.z + headR * 0.45 + snoutL * 0.55, rx: snoutR * 0.85, ry: snoutR * 0.7, b0: head },
    { x: 0, y: hc.y - headR * 0.12, z: hc.z + headR * 0.45 + snoutL, rx: snoutR * 0.45, ry: snoutR * 0.4, b0: head },
  ], 7, (i, j, x, y, z, ang, cy) => paint(0.95 + i * 0.01, Math.cos(ang), cy, x / S, y / S, z / S));
  const jc = rest[jaw];
  const mouthZ = hc.z + headR * 0.45 + snoutL;
  if (fam === 'bird') {
    // beak: upper and lower cones in the accent/horn colour
    const beakCol = mix3(C.accent, [0.85, 0.75, 0.35], 0.5);
    const bl = Math.max(snoutL, headR * 0.7) * 1.1;
    B.cone(0, hc.y, mouthZ - headR * 0.25, 0, hc.y - bl * 0.18 * (ph.head.jaw > 0.6 ? 1 : 0.3), mouthZ + bl * 0.6, snoutR * 0.55, beakCol, head, 5);
    B.cone(0, jc.y, mouthZ - headR * 0.3, 0, jc.y - bl * 0.05, mouthZ + bl * 0.45, snoutR * 0.4, beakCol, jaw, 5);
  } else if (fam === 'arthropod') {
    for (const sd of [-1, 1]) B.cone(sd * snoutR * 0.4, jc.y, mouthZ - snoutR * 0.3, sd * snoutR * 0.15, jc.y - snoutR * 0.2, mouthZ + snoutR * 1.1, snoutR * 0.25, C.secondary, jaw, 4);
  } else {
    B.loft([
      { x: 0, y: jc.y, z: jc.z - headR * 0.2, rx: headR * 0.55, ry: headR * 0.25, b0: jaw },
      { x: 0, y: jc.y - headR * 0.05, z: mouthZ - snoutL * 0.1, rx: snoutR * 0.55, ry: snoutR * 0.25, b0: jaw },
    ], 6, () => [C.belly, 0], true, true);
    // teeth for hunters
    if (ph.head.jaw > 0.65) for (const sd of [-1, 1]) B.cone(sd * snoutR * 0.35, jc.y + snoutR * 0.05, mouthZ - snoutL * 0.2, sd * snoutR * 0.33, jc.y + snoutR * 0.35, mouthZ - snoutL * 0.18, snoutR * 0.08, [0.95, 0.92, 0.85], jaw, 3);
  }
  // eyes
  const nEyes = ph.eyes.count;
  const eR = Math.max(0.006, ph.eyes.size * headR * 1.1);
  const eyeGlow = ph.eyes.glow > 0 ? 0.6 + ph.eyes.glow : 0;
  for (let e = 0; e < nEyes; e++) {
    const row = Math.floor(e / 2), sd = e % 2 ? 1 : -1;
    const ex = sd * headR * (0.62 - row * 0.12), ey = hc.y + headR * (0.32 + row * 0.18), ez = hc.z + headR * (0.42 - row * 0.28);
    B.blob(ex, ey, ez, eR, eR, eR, C.eye, head, eyeGlow, 5);
  }
  // ears
  const ear = ph.ears;
  if (ear.shape !== 'none' && ear.size > 0.05) {
    const eh = ear.size * S * (ear.shape === 'long' ? 1.4 : ear.shape === 'fan' ? 1.0 : ear.shape === 'round' ? 0.7 : 1.0);
    const ew = eh * (ear.shape === 'fan' ? 0.85 : ear.shape === 'round' ? 0.75 : 0.42);
    for (const sd of [-1, 1]) {
      const eb = bone(sd < 0 ? 'earR' : 'earL', head, sd * headR * 0.55, hc.y + headR * 0.7, hc.z - headR * 0.15);
      const p = rest[eb];
      const tipX = p.x + sd * eh * (ear.shape === 'fan' ? 0.55 : 0.3), tipY = p.y + eh, tipZ = p.z - eh * 0.25;
      const a = B.v(p.x - ew * 0.5 * 0.2, p.y, p.z - ew * 0.5, C.primary, 0, eb);
      const b = B.v(p.x + ew * 0.5 * 0.2, p.y, p.z + ew * 0.5, C.primary, 0, eb);
      const m = B.v((p.x + tipX) / 2 + sd * ew * 0.25, (p.y + tipY) / 2, (p.z + tipZ) / 2 + ew * 0.3, mix3(C.primary, C.accent, 0.35), 0, eb);
      const t = B.v(tipX, tipY, tipZ, C.secondary, 0, eb);
      B.tri2(a, b, m); B.tri2(a, m, t); B.tri2(b, t, m);
      if (ear.shape === 'tufted') B.cone(tipX, tipY, tipZ, tipX, tipY + eh * 0.35, tipZ - eh * 0.1, ew * 0.12, C.secondary, eb, 3);
    }
  }
  // horns
  const H = ph.horns;
  if (H.type !== 'none') {
    const hl = H.len * S;
    const hornCol = mix3([0.86, 0.8, 0.66], C.accent, 0.25);
    const pairs = H.type === 'crown' ? [[-0.5, 0.2], [0.5, 0.2], [-0.25, 0.5], [0.25, 0.5], [0, 0.65]] : H.type === 'nose' ? [[0, 1.25]] : [[-0.45, 0.25], [0.45, 0.25]];
    for (const [hxk, hzk] of pairs) {
      const bx = hxk * headR, by = hc.y + headR * (H.type === 'nose' ? 0.2 : H.type === 'tusk' ? -0.4 : 0.75), bz = hc.z + headR * hzk + (H.type === 'nose' ? snoutL * 0.5 : 0);
      let tx = bx + hxk * hl * (H.type === 'curved' || H.type === 'antler' ? 0.6 : 0.25), ty = by + hl * (H.type === 'tusk' ? -0.2 : 0.9), tz = bz + hl * (0.15 + H.curve * 0.45);
      if (H.type === 'tusk') { tz = bz + hl * 0.9; ty = by + hl * 0.25; }
      const segs = H.type === 'spiral' || H.type === 'curved' ? 3 : 1;
      let px = bx, py = by, pz = bz, r = headR * (H.type === 'crown' ? 0.12 : 0.18) * (H.type === 'antler' ? 0.7 : 1);
      for (let s = 1; s <= segs; s++) {
        const t = s / segs;
        const wob = H.type === 'spiral' ? Math.sin(t * Math.PI * 2) * hl * 0.15 : 0;
        const qx = bx + (tx - bx) * t + wob * hxk, qy = by + (ty - by) * t - (H.type === 'curved' ? Math.sin(Math.PI * t) * hl * 0.15 * H.curve : 0), qz = bz + (tz - bz) * t + wob;
        if (s < segs) B.tube(px, py, pz, qx, qy, qz, r, r * 0.75, hornCol, head, head, 5);
        else B.cone(px, py, pz, qx, qy, qz, r, hornCol, head, 5);
        px = qx; py = qy; pz = qz; r *= 0.75;
      }
      if (H.type === 'antler') for (let k = 1; k <= 2; k++) {
        const t = k / 3;
        const qx = bx + (tx - bx) * t, qy = by + (ty - by) * t, qz = bz + (tz - bz) * t;
        B.cone(qx, qy, qz, qx + hxk * hl * 0.25, qy + hl * 0.25, qz + hl * 0.2, r * 0.6, hornCol, head, 4);
      }
    }
  }
  // cheeks: spikes, whiskers or a dewlap
  if (ph.cheek === 'spikes') for (const sd of [-1, 1]) for (let k = 0; k < 3; k++) B.cone(sd * headR * 0.7, hc.y - headR * 0.1 * k, hc.z - headR * 0.3 * k, sd * headR * 1.25, hc.y - headR * (0.1 * k + 0.1), hc.z - headR * (0.3 * k + 0.5), headR * 0.08, C.accent, head, 3);
  if (ph.cheek === 'dewlap') {
    const a = B.v(0, jc.y - headR * 0.1, jc.z, C.accent, 0, jaw), b = B.v(0, jc.y - headR * 0.15, jc.z - headR * 1.2, C.accent, 0, n2), c = B.v(0, jc.y - headR * 1.1, jc.z - headR * 0.6, mix3(C.accent, C.belly, 0.3), C.glowAmt * 0.6, jaw);
    B.tri2(a, b, c);
  }
  if (ph.whisker > 0.55 || ph.cheek === 'whiskers') {
    const wl = headR * (0.9 + ph.whisker * 1.4);
    for (const sd of [-1, 1]) for (let k = -1; k <= 1; k++) {
      const ax = sd * snoutR * 0.4, ay = hc.y - headR * 0.05, az = mouthZ - snoutL * 0.15;
      const a = B.v(ax, ay, az, [0.9, 0.88, 0.8], 0, head), b = B.v(ax, ay + 0.004 * S, az, [0.9, 0.88, 0.8], 0, head), c = B.v(ax + sd * wl, ay + k * wl * 0.15, az - wl * 0.25, [0.9, 0.88, 0.8], 0, head);
      B.tri2(a, b, c);
    }
  }

  // --- crest / sail / spikes / frill along the back and head
  const CR = ph.crest;
  const crestCol = mix3(C.accent, C.secondary, 0.35);
  if (CR.type !== 'none' && CR.size > 0.04) {
    const ch = CR.size * S;
    if (CR.type === 'sail' || CR.type === 'ridge' || CR.type === 'fin') {
      // membrane along the spine (fin: one tall peak; ridge: low; sail: tall and long)
      const pts = [];
      const nS = 6;
      for (let i = 0; i <= nS; i++) {
        const t = i / nS;
        const z = zHip + (zChest - zHip) * (CR.type === 'fin' ? 0.25 + 0.5 * t : t);
        const y = hipY + (chestY - hipY) * (CR.type === 'fin' ? 0.25 + 0.5 * t : t) + hgt * 0.85;
        const h = ch * (CR.type === 'ridge' ? 0.3 : 1) * Math.sin(Math.PI * t) * (CR.type === 'sail' ? 0.75 + 0.25 * Math.sin(t * 9) : 1);
        const bi = spine[Math.min(spine.length - 1, Math.floor(t * spine.length))];
        pts.push([B.v(0, y, z, crestCol, 0, bi), B.v(0, y + h, z, mix3(crestCol, C.accent, 0.6), C.glowAmt * 0.8 * (i % 2), bi)]);
      }
      for (let i = 0; i < nS; i++) B.quad2(pts[i][0], pts[i + 1][0], pts[i + 1][1], pts[i][1]);
    } else if (CR.type === 'spikes') {
      const n = 7;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const z = zHip - gir * 0.4 + (zChest + gir * 0.2 - zHip) * t, y = hipY + (chestY - hipY) * t + hgt * 0.9;
        const bi = spine[Math.min(spine.length - 1, Math.floor(t * spine.length))];
        B.cone(0, y, z, 0, y + ch * (0.5 + 0.5 * Math.sin(Math.PI * t)), z - ch * 0.3, gir * 0.12, crestCol, bi, 4);
      }
    } else if (CR.type === 'plume' || CR.type === 'fan') {
      const n = CR.type === 'fan' ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const a = (i / (n - 1) - 0.5) * (CR.type === 'fan' ? 1.6 : 0.8);
        const bx = 0, by = hc.y + headR * 0.85, bz = hc.z - headR * 0.1;
        const tx = Math.sin(a) * ch * 0.6, ty = by + Math.cos(a) * ch, tz = bz - ch * (CR.type === 'plume' ? 0.7 : 0.15);
        const p0 = B.v(bx - headR * 0.08, by, bz, crestCol, 0, head), p1 = B.v(bx + headR * 0.08, by, bz, crestCol, 0, head), p2 = B.v(tx, ty, tz, C.accent, C.glowAmt * 0.5, head);
        B.tri2(p0, p1, p2);
      }
    } else if (CR.type === 'casque') {
      B.blob(0, hc.y + headR * 0.8, hc.z + headR * 0.1, headR * 0.45, ch * 0.5, headR * 0.7, crestCol, head, 0, 5);
    } else if (CR.type === 'frills') {
      // frilled skin flaps around the neck that can flare
      const fb = bone('frill', n2, 0, rest[n2].y, rest[n2].z - headR * 0.3);
      const fr = ch * 1.1;
      const c0 = rest[fb];
      const ring = [];
      for (let k = 0; k <= 8; k++) {
        const a = Math.PI * (0.05 + 0.9 * (k / 8));
        ring.push(B.v(Math.cos(a) * fr * 1.1, c0.y + Math.sin(a) * fr, c0.z - fr * 0.35, k % 2 ? crestCol : C.accent, C.glowAmt * 0.7 * (k % 2), fb));
      }
      const ctr = B.v(0, c0.y, c0.z + headR * 0.2, crestCol, 0, fb);
      for (let k = 0; k < 8; k++) B.tri2(ctr, ring[k], ring[k + 1]);
    }
  }
  // dorsal spike rows (independent of the crest)
  if (ph.spikes.rows > 0 && ph.spikes.len > 0.04) {
    const sl = ph.spikes.len * S;
    for (let r = 0; r < ph.spikes.rows; r++) {
      const sx = ph.spikes.rows === 2 ? (r ? 1 : -1) * gir * 0.45 : 0;
      for (let i = 0; i < ph.spikes.count; i++) {
        const t = i / Math.max(1, ph.spikes.count - 1);
        // along the back, continuing onto the tail
        const onTail = t < 0.35 && tail.length;
        let x, y, z, bi;
        if (onTail) {
          const tt = t / 0.35, ti = Math.min(tail.length - 1, Math.floor((1 - tt) * tail.length));
          const p = rest[tail[ti]];
          x = sx * 0.6; y = p.y + ph.tail.thick * S * 0.8; z = p.z; bi = tail[ti];
        } else {
          const tt = (t - 0.35) / 0.65;
          x = sx; y = hipY + (chestY - hipY) * tt + hgt * 0.85; z = zHip + (zChest - zHip) * tt;
          bi = spine[Math.min(spine.length - 1, Math.floor(tt * spine.length))];
        }
        B.cone(x, y, z, x * 1.3, y + sl, z - sl * 0.35, Math.max(0.004, sl * 0.25), mix3(C.secondary, C.accent, 0.3), bi, 4);
      }
    }
  }

  // --- tail loft and tip
  if (nT) {
    const tt = ph.tail.thick * S;
    const pts = [{ x: 0, y: hipY + hgt * 0.1, z: zHip - gir * 0.3, rx: tt * 1.3, ry: tt * 1.2, b0: hips }];
    tail.forEach((tb, i) => {
      const t = (i + 1) / tail.length;
      const r = tt * (1.1 - 0.85 * t);
      pts.push({ x: 0, y: rest[tb].y, z: rest[tb].z, rx: Math.max(0.003, r), ry: Math.max(0.003, r), b0: tb });
    });
    B.loft(pts, 6, (i, j, x, y, z, ang, cy) => paint(0.15 - i * 0.03, Math.cos(ang), cy, x / S, y / S, z / S), false, true);
    const tipB = tail[tail.length - 1], tp = rest[tipB];
    const ts = Math.max(tt, 0.04 * S);
    switch (ph.tail.tip) {
      case 'tuft': B.blob(0, tp.y, tp.z - ts * 0.5, ts * 0.9, ts * 0.9, ts * 1.4, C.secondary, tipB, 0, 5); break;
      case 'club': B.blob(0, tp.y, tp.z - ts * 0.3, ts * 1.5, ts * 1.2, ts * 1.6, mix3(C.secondary, [0.6, 0.55, 0.5], 0.4), tipB, 0, 6); break;
      case 'spike': for (const sd of [-1, 1]) B.cone(0, tp.y, tp.z, sd * ts * 2.2, tp.y + ts * 1.2, tp.z - ts * 2, ts * 0.4, C.accent, tipB, 4); break;
      case 'stinger': B.cone(0, tp.y, tp.z, 0, tp.y + ts * 2.5, tp.z - ts * 1.5, ts * 0.6, C.accent, tipB, 4); break;
      case 'fan': case 'plume': case 'fork': {
        const n = ph.tail.tip === 'fork' ? 2 : 5;
        const spread = ph.tail.tip === 'fork' ? 0.55 : ph.tail.tip === 'fan' ? 1.1 : 0.5;
        const fl = Math.max(ts * 3, tailLen * (fam === 'bird' ? 0.9 : 0.45));
        for (let k = 0; k < n; k++) {
          const a = (n === 1 ? 0 : k / (n - 1) - 0.5) * spread;
          const p0 = B.v(-ts * 0.6, tp.y, tp.z + ts, C.secondary, 0, tipB), p1 = B.v(ts * 0.6, tp.y, tp.z + ts, C.secondary, 0, tipB);
          const p2 = B.v(Math.sin(a) * fl, tp.y + (ph.tail.tip === 'plume' ? fl * 0.25 : 0), tp.z - Math.cos(a) * fl, k % 2 ? C.accent : C.secondary, C.glowAmt * 0.4, tipB);
          B.tri2(p0, p1, p2);
        }
        break;
      }
      default: break;
    }
  }

  // --- legs
  const legs = [];
  const pairs = L.pairs;
  const legR = Math.max(0.006, L.thick * S);
  const footL = legR * 2.6 * L.foot;
  for (let pi = 0; pi < pairs; pi++) {
    // attachment along the body: hind pair at the hips, front pair at the chest, others between
    let az, ay, parent;
    if (pairs === 1) { az = plan === 'avian' ? (zHip + zChest) * 0.5 - len * 0.1 : L.biped ? zHip + len * 0.05 : zHip; ay = hipY; parent = hips; }
    else if (plan === 'insect' || plan === 'spider' || plan === 'centipede') {
      const t = pairs === 1 ? 0.5 : pi / (pairs - 1);
      az = zHip + (zChest - zHip) * (0.1 + 0.8 * t); ay = hipY;
      parent = spine.length ? spine[Math.min(spine.length - 1, Math.round(t * (spine.length - 1)))] : hips;
      if (pi === pairs - 1) parent = chest;
    } else { const front = pi === pairs - 1; az = front ? zChest : zHip; ay = front ? chestY : hipY; parent = front ? chest : hips; }
    for (const sd of [-1, 1]) {
      const sideOut = sprawl ? 1 : 0;
      const hx = sd * gir * (sprawl ? 0.85 : 0.65), hy = ay - hgt * (sprawl ? 0.1 : 0.35);
      // foot rest position
      const spreadX = sd * (gir * 0.75 + (sprawl ? legLen * (L.posture === 'arthropod' ? 0.85 : 0.6) : 0));
      const fx = spreadX, fy = 0, fz = az + (plan === 'spider' ? (pi - 1.5) * legLen * 0.25 : 0);
      // knee: up and out for sprawlers, below and forward/back for upright legs
      const front = pi === pairs - 1 && pairs > 1;
      const kneeDir = L.biped ? 1 : front ? -1 : 1;
      let kx, ky, kz;
      if (sprawl) { kx = hx + (fx - hx) * 0.55; ky = hy + legLen * (L.posture === 'arthropod' ? 0.35 : 0.12); kz = (az + fz) / 2; }
      else { kx = hx + (fx - hx) * 0.5; ky = hy * 0.5; kz = az + kneeDir * legLen * (L.posture === 'digitigrade' ? 0.22 : 0.08); }
      const up = bone(`leg${pi}${sd < 0 ? 'R' : 'L'}0`, parent, hx, hy, az);
      const kn = bone(`leg${pi}${sd < 0 ? 'R' : 'L'}1`, up, kx, ky, kz);
      const ft = bone(`leg${pi}${sd < 0 ? 'R' : 'L'}2`, kn, fx, fy + legR * 0.5, fz);
      const legCol = mix3(C.primary, C.secondary, 0.25);
      B.tube(hx, hy, az, kx, ky, kz, legR * (sprawl ? 1.2 : 1.5), legR, legCol, up, kn, 6);
      B.tube(kx, ky, kz, fx, legR * 0.5, fz, legR, legR * 0.7, legCol, kn, ft, 5);
      if (L.posture !== 'arthropod') {
        // foot and claws
        B.blob(fx, legR * 0.45, fz + footL * 0.25, legR * 1.3 * L.foot, legR * 0.55, footL * 0.6, mix3(legCol, [0.2, 0.18, 0.16], 0.25), ft, 0, 5);
        const nc = fam === 'bird' ? 3 : 2;
        for (let k = 0; k < nc; k++) {
          const cxk = fx + (k - (nc - 1) / 2) * legR * 0.9;
          B.cone(cxk, legR * 0.3, fz + footL * 0.7, cxk, legR * 0.05, fz + footL * 1.1, legR * 0.25, [0.88, 0.84, 0.75], ft, 3);
        }
      }
      legs.push({ pair: pi, side: sd, upper: up, knee: kn, foot: ft, parent, front, hip: new THREE.Vector3(hx, hy, az), footRest: new THREE.Vector3(fx, fy, fz) });
      void sideOut;
    }
  }
  // arms of bipeds
  const arms = [];
  if (ph.arms.len > 0.05 && L.biped && plan !== 'avian') {
    const al = ph.arms.len * S;
    for (const sd of [-1, 1]) {
      const sx = sd * gir * 0.7, sy = chestY - hgt * 0.2, sz = zChest;
      const a0 = bone(`arm${sd < 0 ? 'R' : 'L'}0`, chest, sx, sy, sz);
      const a1 = bone(`arm${sd < 0 ? 'R' : 'L'}1`, a0, sx + sd * al * 0.1, sy - al * 0.5, sz + al * 0.15);
      const a2 = bone(`arm${sd < 0 ? 'R' : 'L'}2`, a1, sx + sd * al * 0.1, sy - al * 0.65, sz + al * 0.55);
      const col = mix3(C.primary, C.secondary, 0.25);
      B.tube(sx, sy, sz, rest[a1].x, rest[a1].y, rest[a1].z, legR * 0.9, legR * 0.7, col, a0, a1, 5);
      B.tube(rest[a1].x, rest[a1].y, rest[a1].z, rest[a2].x, rest[a2].y, rest[a2].z, legR * 0.7, legR * 0.55, col, a1, a2, 5);
      for (let k = 0; k < 3; k++) B.cone(rest[a2].x + (k - 1) * legR * 0.4, rest[a2].y, rest[a2].z, rest[a2].x + (k - 1) * legR * 0.5, rest[a2].y - legR * 0.6, rest[a2].z + legR * 1.4, legR * 0.2, [0.88, 0.84, 0.75], a2, 3);
      arms.push({ side: sd, b0: a0, b1: a1, b2: a2 });
    }
  }

  // --- wings
  const wings = [];
  const W = ph.wings;
  if (W.type !== 'none') {
    const span = W.span * S * 0.5;    // one wing
    const chord = W.chord * S;
    for (const sd of [-1, 1]) {
      const sx = sd * gir * 0.6, sy = chestY + hgt * 0.45, sz = zChest - gir * 0.15;
      const nm = sd < 0 ? 'R' : 'L';
      if (W.type === 'patagium') {
        // gliding membrane between front and hind limbs (spread by the legs)
        const fl = legs.find((l) => l.side === sd && l.front), hl = legs.find((l) => l.side === sd && !l.front);
        if (!fl || !hl) continue;
        const wf = bone(`wing${nm}0`, chest, sd * gir * 0.9, chestY, zChest);
        const wh = bone(`wing${nm}1`, hips, sd * gir * 0.9, hipY, zHip);
        const outF = bone(`wing${nm}2`, wf, sd * (gir + span * 0.8), chestY - hgt * 0.1, zChest + gir * 0.2);
        const outH = bone(`wing${nm}3`, wh, sd * (gir + span * 0.7), hipY - hgt * 0.1, zHip - gir * 0.2);
        const mc = mix3(C.secondary, C.accent, 0.3);
        const a = B.v(rest[wf].x, rest[wf].y, rest[wf].z, mc, 0, wf), b = B.v(rest[outF].x, rest[outF].y, rest[outF].z, C.accent, C.glowAmt * 0.6, outF);
        const c = B.v(rest[outH].x, rest[outH].y, rest[outH].z, C.accent, C.glowAmt * 0.6, outH), d = B.v(rest[wh].x, rest[wh].y, rest[wh].z, mc, 0, wh);
        B.quad2(a, b, c, d);
        wings.push({ side: sd, type: 'patagium', b0: wf, b1: outF, b2: wh, b3: outH });
        continue;
      }
      const w0 = bone(`wing${nm}0`, chest, sx, sy, sz);
      const w1 = bone(`wing${nm}1`, w0, sx + sd * span * 0.36, sy + span * 0.04, sz + chord * 0.05);
      const w2 = bone(`wing${nm}2`, w1, sx + sd * span * 0.66, sy + span * 0.02, sz - chord * 0.05);
      const w3 = bone(`wing${nm}3`, w2, sx + sd * span, sy - span * 0.02, sz - chord * 0.35);
      const P0 = rest[w0], P1 = rest[w1], P2 = rest[w2], P3 = rest[w3];
      const wcol = mix3(C.primary, C.secondary, 0.5);
      if (W.type === 'feather') {
        // leading edge bones, trailing edge of feathers (primaries at the tip)
        B.tube(P0.x, P0.y, P0.z, P1.x, P1.y, P1.z, legR * 0.8, legR * 0.6, wcol, w0, w1, 4);
        B.tube(P1.x, P1.y, P1.z, P2.x, P2.y, P2.z, legR * 0.6, legR * 0.45, wcol, w1, w2, 4);
        const lead = [[P0, w0], [P1, w1], [P2, w2], [P3, w3]];
        const trail = [
          [P0.x, P0.y, P0.z - chord * 0.9, w0],
          [P1.x, P1.y, P1.z - chord * 1.0, w1],
          [P2.x + sd * span * 0.05, P2.y, P2.z - chord * 0.95, w2],
          [P3.x + sd * span * 0.08, P3.y, P3.z - chord * 0.4, w3],
        ];
        for (let k = 0; k < 3; k++) {
          const [a, ab] = lead[k], [b, bb] = lead[k + 1];
          const ta = trail[k], tb = trail[k + 1];
          const va = B.v(a.x, a.y, a.z, wcol, 0, ab), vb = B.v(b.x, b.y, b.z, wcol, 0, bb);
          const vtb = B.v(tb[0], tb[1], tb[2], k === 2 ? C.secondary : mix3(wcol, C.accent, 0.25), k === 2 ? C.glowAmt * 0.5 : 0, tb[3]);
          const vta = B.v(ta[0], ta[1], ta[2], mix3(wcol, C.accent, k === 0 ? 0 : 0.25), 0, ta[3]);
          B.quad2(va, vb, vtb, vta);
        }
        // separated primary feather tips
        for (let k = 0; k < 4; k++) {
          const t = k / 3;
          const bx = P2.x + (P3.x - P2.x) * t, bz = P2.z + (P3.z - P2.z) * t;
          const a = B.v(bx, P2.y, bz, C.secondary, 0, w3), b = B.v(bx + sd * chord * 0.05, P2.y, bz - chord * 0.1, C.secondary, 0, w3);
          const c = B.v(bx + sd * chord * (0.25 + 0.15 * t), P2.y - chord * 0.05, bz - chord * (0.6 - 0.25 * t), C.secondary, 0, w3);
          B.tri2(a, b, c);
        }
      } else if (W.type === 'membrane') {
        // bat wing: arm and fingers with membrane to the hind leg
        const fingerCol = mix3(C.primary, [0.15, 0.12, 0.12], 0.4);
        const memCol = mix3(C.secondary, C.primary, 0.3);
        B.tube(P0.x, P0.y, P0.z, P1.x, P1.y, P1.z, legR * 0.9, legR * 0.7, fingerCol, w0, w1, 4);
        B.tube(P1.x, P1.y, P1.z, P2.x, P2.y, P2.z, legR * 0.7, legR * 0.5, fingerCol, w1, w2, 4);
        const tips = [
          [P3.x, P3.y, P3.z],
          [P2.x + sd * span * 0.18, P2.y - span * 0.05, P2.z - chord * 0.75],
          [P2.x + sd * span * 0.02, P2.y - span * 0.04, P2.z - chord * 1.05],
        ];
        const hl = legs.find((l) => l.side === sd);
        const legPt = hl ? rest[hl.knee] : new THREE.Vector3(sx, hipY, zHip);
        const vP2 = B.v(P2.x, P2.y, P2.z, fingerCol, 0, w2);
        const vTips = tips.map((t) => B.v(t[0], t[1], t[2], memCol, C.glowAmt * 0.4, w3));
        for (const t of tips) B.tube(P2.x, P2.y, P2.z, t[0], t[1], t[2], legR * 0.4, legR * 0.2, fingerCol, w2, w3, 3);
        B.tri2(vP2, vTips[0], vTips[1]);
        B.tri2(vP2, vTips[1], vTips[2]);
        const vP1 = B.v(P1.x, P1.y, P1.z, memCol, 0, w1), vP0 = B.v(P0.x, P0.y, P0.z, memCol, 0, w0);
        const vLeg = B.v(legPt.x, legPt.y, legPt.z, memCol, 0, hl ? hl.knee : hips);
        const vHip = B.v(sd * gir * 0.6, hipY, zHip, memCol, 0, hips);
        B.quad2(vP2, vTips[2], vLeg, vP1);
        B.quad2(vP1, vLeg, vHip, vP0);
      } else if (W.type === 'insect') {
        const wc = [0.85, 0.9, 0.95];
        for (const off of [0, 1]) {
          const z0 = sz - off * chord * 0.6;
          const a = B.v(P0.x, P0.y, z0, wc, 0, w0), b = B.v(P3.x, P3.y + span * 0.05, z0 + chord * 0.1, mix3(wc, C.accent, 0.4), C.glowAmt * 0.3, w3);
          const c = B.v(P2.x, P2.y, z0 - chord * 0.7, wc, 0, w2);
          B.tri2(a, b, c);
        }
      }
      wings.push({ side: sd, type: W.type, b0: w0, b1: w1, b2: w2, b3: w3 });
    }
  }
  // antennae for insects
  if (fam === 'arthropod' && plan !== 'spider') {
    for (const sd of [-1, 1]) B.tube(sd * headR * 0.3, hc.y + headR * 0.5, hc.z + headR * 0.3, sd * headR * 1.2, hc.y + headR * 2.5, hc.z + headR * 2.2, headR * 0.06, headR * 0.03, C.secondary, head, head, 3);
  }

  // --- assemble
  const geo = B.build();
  const mesh = new THREE.SkinnedMesh(geo, creatureMaterial());
  const skeleton = new THREE.Skeleton(bones);
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  mesh.bind(skeleton);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  // skinned meshes need a generous bounding sphere (poses move vertices)
  const bs = geo.boundingSphere;
  bs.radius *= 1.6;
  const height = Math.max(chestY + hgt, rest[head].y + headR) + (ph.horns.type !== 'none' ? ph.horns.len * S : 0);
  const rig = {
    bones, named, rest, hips, chest, spine, neck: [n1, n2], head, jaw, tail, legs, arms, wings,
    ears: [named.earL, named.earR].filter((v) => v !== undefined), frill: named.frill,
    hipY, chestY, zHip, zChest, legLen, len, gir, hgt, headR,
    restQ: bones.map((b) => b.quaternion.clone()), restP: bones.map((b) => b.position.clone()),
  };
  return { mesh, rig, height, length: zMax - Math.min(zMin, rest[tail[tail.length - 1] ?? hips].z) + headR * 2 + snoutL, radius: bs.radius, vertices: B.n };
}
