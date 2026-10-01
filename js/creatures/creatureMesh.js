// Procedural creature models built from a species genome. Each species gets a
// skeleton (spine, neck, head, jaw, tail, legs, wings, antennae, arms) and a
// rigidly skinned mesh assembled from ellipsoids, tapered limbs, cones and
// membranes. Vertex colours store pattern masks; per-individual colours are
// applied in the shader so offspring can differ from their parents.
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { hsl2rgb, clamp } from '../core/mathutil.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

class Builder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.si = []; this.idx = []; this.n = 0; }
  vert(p, n, c, bone) {
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.col.push(c[0], c[1], c[2]);
    this.si.push(bone, 0, 0, 0);
    return this.n++;
  }
  /** Ellipsoid centred at c with radii r, oriented along axis (local z) */
  ellipsoid(c, r, bone, mask, segs = 8, rings = 6, basis = null, maskFn = null) {
    const base = this.n;
    for (let i = 0; i <= rings; i++) {
      const v = i / rings, phi = v * Math.PI;
      for (let j = 0; j <= segs; j++) {
        const u = j / segs, th = u * Math.PI * 2;
        const lx = Math.sin(phi) * Math.cos(th), ly = Math.cos(phi) * -1, lz = Math.sin(phi) * Math.sin(th);
        // local: x across, y up, z along
        let p = V3(lx * r.x, ly * r.y, lz * r.z), n = V3(lx / r.x, ly / r.y, lz / r.z).normalize();
        if (basis) { p = p.applyMatrix3(basis); n = n.applyMatrix3(basis).normalize(); }
        p.add(c);
        const m = maskFn ? maskFn(p, n) : mask;
        this.vert(p, n, m, bone);
      }
    }
    for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
      const a = base + i * (segs + 1) + j, b = a + segs + 1;
      this.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  /** Tapered tube from p0 to p1 */
  tube(p0, p1, r0, r1, bone, mask, sides = 6, bone1 = null, maskFn = null) {
    const ax = V3().subVectors(p1, p0);
    const len = ax.length() || 1e-4;
    ax.divideScalar(len);
    let up = Math.abs(ax.y) > 0.9 ? V3(1, 0, 0) : V3(0, 1, 0);
    const b1 = V3().crossVectors(ax, up).normalize();
    const b2 = V3().crossVectors(b1, ax).normalize();
    const base = this.n;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const n = V3().addScaledVector(b1, Math.cos(a)).addScaledVector(b2, Math.sin(a));
      const pa = V3().copy(p0).addScaledVector(n, r0), pb = V3().copy(p1).addScaledVector(n, r1);
      this.vert(pa, n, maskFn ? maskFn(pa, n) : mask, bone);
      this.vert(pb, n, maskFn ? maskFn(pb, n) : mask, bone1 ?? bone);
    }
    for (let i = 0; i < sides; i++) {
      const a = base + i * 2, b = base + ((i + 1) % sides) * 2;
      this.idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
    // end caps
    const n0 = V3().copy(ax).negate();
    const c0 = this.vert(p0, n0, maskFn ? maskFn(p0, n0) : mask, bone);
    const c1 = this.vert(p1, ax, maskFn ? maskFn(p1, ax) : mask, bone1 ?? bone);
    for (let i = 0; i < sides; i++) {
      const a = base + i * 2, b = base + ((i + 1) % sides) * 2;
      this.idx.push(c0, b, a, c1, a + 1, b + 1);
    }
  }
  cone(p0, p1, r0, bone, mask, sides = 5) { this.tube(p0, p1, r0, 0.0005, bone, mask, sides); }
  /** Flat polygon (double sided) from a fan of points */
  fan(pts, normal, bone, mask, bones = null) {
    const base = this.n;
    pts.forEach((p, i) => this.vert(p, normal, mask, bones ? bones[i] : bone));
    for (let i = 1; i < pts.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
    const nb = V3().copy(normal).negate();
    const base2 = this.n;
    pts.forEach((p, i) => this.vert(p, nb, mask, bones ? bones[i] : bone));
    for (let i = 1; i < pts.length - 1; i++) this.idx.push(base2, base2 + i + 1, base2 + i);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    const w = new Float32Array(this.n * 4);
    for (let i = 0; i < this.n; i++) w[i * 4] = 1;
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// mask colours: r = secondary pattern weight, g = belly weight, b = accent/glow
const MASK_BASE = [0, 0, 0];
const MASK_ACCENT = [0, 0, 1];
const MASK_DARK = [1, 0, 0];

/**
 * Build the species template: { geometry, bones: [{name, parent, pos}], rig }
 * All in unit scale where body length ~= 1.
 */
export function buildSpeciesModel(sp) {
  const m = sp.morph;
  const rng = RNG.derive(sp.id + 7919, 'model', sp.key);
  const b = new Builder();
  const bones = [];
  const addBone = (name, parent, pos) => { bones.push({ name, parent, pos: pos.clone() }); return bones.length - 1; };
  const fam = sp.family;
  const arth = fam === 'arthropod';
  const lith = fam === 'lithosere';
  // pattern mask from body-space position
  const pat = m.pattern;
  const patFn = (p, n) => {
    let s = 0;
    const sc = pat.scale * 6;
    switch (pat.type) {
      case 'stripes': s = Math.sin(p.z * sc * 3) > 0.35 ? 1 : 0; break;
      case 'bands': s = Math.sin(p.z * sc * 1.6) > 0.6 ? 1 : 0; break;
      case 'spots': { const h = Math.sin(p.x * sc * 7.1) * Math.sin(p.y * sc * 6.3) * Math.sin(p.z * sc * 5.7); s = h > 0.35 ? 1 : 0; break; }
      case 'mottled': { const h = Math.sin(p.x * 23 + p.z * 17) * Math.sin(p.y * 19 - p.z * 11) + Math.sin(p.z * 31 + p.x * 7) * 0.5; s = h > 0.4 ? 1 : 0; break; }
      case 'gradient': s = clamp(p.z * 1.5 + 0.5, 0, 1); break;
      default: s = 0;
    }
    if (n.y > 0.55) s = Math.max(s, pat.type === 'none' ? 0 : 0.3);
    const belly = n.y < -0.35 ? clamp(-n.y, 0, 1) : 0;
    return [s * pat.contrast, belly, 0];
  };

  // ---- body / spine ------------------------------------------------------
  const L = 1.0 * m.bodyLen;
  const girth = m.bodyGirth, height = m.bodyHeight;
  const legLen = m.legs.len * (m.legs.biped ? 1.1 : 1);
  const hipH = m.legs.pairs === 0 ? height * 0.9 : legLen * (m.legs.posture === 'sprawl' ? 0.55 : m.legs.posture === 'arthropod' ? 0.45 : 0.95) + height * 0.35;
  const nSpine = arth ? Math.max(2, Math.min(m.segments, 14)) : 3;
  const bodyTilt = m.legs.biped ? 0.25 : 0;
  const root = addBone('root', -1, V3(0, hipH, 0));
  const spine = [];
  let prev = root;
  const segLen = L / nSpine;
  for (let i = 0; i < nSpine; i++) {
    const z = -L / 2 + segLen * (i + 0.5);
    const y = hipH + z * Math.sin(bodyTilt);
    spine.push(addBone('spine' + i, prev, V3(0, y, z)));
    prev = spine[i];
  }
  // torso volumes
  for (let i = 0; i < nSpine; i++) {
    const t = nSpine === 1 ? 0.5 : i / (nSpine - 1);
    const bp = bones[spine[i]].pos;
    let gx = girth, gy = height * 0.5 + girth * 0.5;
    if (arth && m.kind !== 'centipede') { // head-thorax-abdomen proportions
      gx *= i === nSpine - 1 ? 0.75 : i === 0 ? 1.25 : 0.85; gy *= i === 0 ? 1.15 : 0.8;
    } else if (!arth) {
      gx *= 0.85 + 0.3 * Math.sin(Math.PI * t); gy *= 0.85 + 0.3 * Math.sin(Math.PI * t);
      if (m.legs.biped && fam === 'bird') { gx *= 1.1; gy *= 1.15; }
    }
    b.ellipsoid(bp, V3(gx * 0.55, gy * 0.55, segLen * (arth ? 0.62 : 0.85)), spine[i], null, 10, 7, null, patFn);
  }
  // lithosere plates / shell
  if (lith) {
    const nPl = Math.floor(10 + m.plates * 16);
    for (let i = 0; i < nPl; i++) {
      const si = spine[Math.floor(rng.range(0, nSpine))];
      const bp = bones[si].pos;
      const a = rng.range(-Math.PI * 0.95, Math.PI * 0.05) + Math.PI * 0.45;
      const off = V3(Math.cos(a) * girth * 0.5, Math.sin(a) * (height * 0.5 + girth * 0.45) * 0.85 + girth * 0.1, rng.range(-segLen * 0.6, segLen * 0.6));
      const s = rng.range(0.08, 0.16) * (1 + m.plates * 0.4);
      b.ellipsoid(V3().copy(bp).add(off), V3(s, s * rng.range(0.5, 0.9), s * rng.range(0.8, 1.3)), si, [rng.range(0, 0.6), 0, 0], 5, 3);
    }
  }
  // dorsal spines / crystals
  if (m.spines.count) {
    for (let i = 0; i < m.spines.count; i++) {
      const t = m.spines.count === 1 ? 0.5 : i / (m.spines.count - 1);
      const si = spine[Math.min(nSpine - 1, Math.floor(t * nSpine))];
      const bp = bones[si].pos;
      const top = V3(bp.x, bp.y + height * 0.5 + girth * 0.3, -L / 2 + t * L);
      const len = m.spines.len * (0.6 + Math.sin(Math.PI * t) * 0.6);
      b.cone(top, V3(top.x, top.y + len, top.z - len * 0.3), len * 0.25, si, lith ? MASK_ACCENT : MASK_DARK, 4);
    }
  }
  if (m.crest.type === 'sail' || m.crest.type === 'ridge' || m.crest.type === 'fin') {
    const pts = [];
    const hs = m.crest.size;
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const z = -L * 0.35 + t * L * 0.7;
      pts.push(V3(0, hipH + height * 0.5 + (i === 0 || i === 6 ? 0 : Math.sin(Math.PI * t) * hs), z));
    }
    pts.unshift(V3(0, hipH + height * 0.45, -L * 0.35));
    b.fan(pts, V3(1, 0, 0), spine[Math.floor(nSpine / 2)], MASK_DARK);
  }

  // ---- neck & head ---------------------------------------------------------
  const chest = bones[spine[nSpine - 1]].pos;
  const nNeck = m.neckLen > 0.05 ? Math.max(1, Math.round(m.neckLen * 3)) : 0;
  let neckTip = V3(chest.x, chest.y + height * 0.15, chest.z + segLen * 0.5);
  prev = spine[nSpine - 1];
  const neckBones = [];
  const neckUp = fam === 'bird' ? 0.85 : m.neckLen > 0.6 ? 0.7 : 0.35;
  for (let i = 0; i < nNeck; i++) {
    const seg = (m.neckLen / nNeck);
    const p = V3(neckTip.x, neckTip.y + seg * neckUp, neckTip.z + seg * (1 - neckUp * 0.5));
    const nb = addBone('neck' + i, prev, neckTip);
    b.tube(neckTip, p, girth * m.neckThick * (1 - i * 0.12) * 0.55, girth * m.neckThick * (1 - (i + 1) * 0.12) * 0.5, nb, null, 7, null, patFn);
    neckBones.push(nb);
    prev = nb;
    neckTip = p;
  }
  const hs = m.headSize;
  const head = addBone('head', prev, neckTip);
  const hc = V3(neckTip.x, neckTip.y + hs * 0.15, neckTip.z + hs * 0.35);
  b.ellipsoid(hc, V3(hs * 0.45, hs * 0.42, hs * 0.55), head, null, 9, 6, null, patFn);
  // snout / beak / mandibles
  let mouthTip = V3(hc.x, hc.y - hs * 0.08, hc.z + hs * 0.5);
  const jaw = addBone('jaw', head, V3(hc.x, hc.y - hs * 0.1, hc.z + hs * 0.2));
  if (m.jaw === 'beak') {
    const bl = m.beakLen * hs;
    const tip = V3(mouthTip.x, mouthTip.y - m.beakCurve * bl * 0.4, mouthTip.z + bl);
    b.cone(V3(mouthTip.x, mouthTip.y + hs * 0.05, mouthTip.z - hs * 0.05), tip, hs * 0.18, head, [0, 0, 0.6], 6);
    b.cone(V3(mouthTip.x, mouthTip.y - hs * 0.07, mouthTip.z - hs * 0.05), V3(tip.x, tip.y - hs * 0.04, tip.z - bl * 0.1), hs * 0.12, jaw, [0, 0, 0.6], 5);
    mouthTip = tip;
  } else if (m.jaw === 'mandible') {
    for (const sgn of [-1, 1]) {
      const p0 = V3(hc.x + sgn * hs * 0.18, hc.y - hs * 0.15, hc.z + hs * 0.4);
      b.cone(p0, V3(hc.x + sgn * hs * 0.05, hc.y - hs * 0.22, hc.z + hs * 0.8), hs * 0.07, jaw, MASK_DARK, 4);
    }
  } else {
    const sl = m.snoutLen * hs;
    const tip = V3(mouthTip.x, mouthTip.y - sl * 0.15, mouthTip.z + sl);
    b.tube(V3(hc.x, hc.y, hc.z + hs * 0.25), tip, hs * 0.3, hs * 0.16, head, null, 7, null, patFn);
    b.tube(V3(hc.x, hc.y - hs * 0.2, hc.z + hs * 0.2), V3(tip.x, tip.y - hs * 0.1, tip.z - sl * 0.05), hs * 0.2, hs * 0.1, jaw, [0, 0.8, 0], 6);
    b.ellipsoid(tip, V3(hs * 0.12, hs * 0.1, hs * 0.08), head, MASK_DARK, 5, 3);
    if (m.horns.type === 'tusks') for (const sgn of [-1, 1]) b.cone(V3(tip.x + sgn * hs * 0.1, tip.y - hs * 0.12, tip.z - sl * 0.2), V3(tip.x + sgn * hs * 0.2, tip.y + hs * 0.15, tip.z + sl * 0.15), hs * 0.06, jaw, [0, 0.9, 0], 5);
  }
  // eyes
  const ne = m.eyes.count;
  for (let i = 0; i < ne; i++) {
    const row = Math.floor(i / 2), sgn = i % 2 ? 1 : -1;
    const center = ne % 2 === 1 && i === ne - 1;
    const ex = center ? 0 : sgn * hs * (0.32 - row * 0.05);
    const ey = hc.y + hs * (0.16 + row * 0.12) + (center ? hs * 0.12 : 0);
    const ez = hc.z + hs * (0.32 - row * 0.12);
    const er = hs * m.eyes.size * 2.2 * (center ? 1.2 : 1);
    if (m.eyes.stalk) b.tube(V3(ex, ey, ez), V3(ex * 1.2, ey + hs * 0.3, ez), er * 0.4, er * 0.3, head, MASK_DARK, 4);
    b.ellipsoid(V3(ex, ey + (m.eyes.stalk ? hs * 0.3 : 0), ez), V3(er, er, er), head, MASK_ACCENT, 6, 4);
  }
  // ears
  if (m.ears.size > 0.02) {
    for (const sgn of [-1, 1]) {
      const base = V3(hc.x + sgn * hs * 0.28, hc.y + hs * 0.32, hc.z - hs * 0.15);
      const es = m.ears.size * hs * 1.6;
      const tip = m.ears.shape === 'long' ? V3(base.x + sgn * es * 0.3, base.y + es * 1.4, base.z - es * 0.4) : m.ears.shape === 'round' ? V3(base.x + sgn * es * 0.3, base.y + es * 0.6, base.z) : V3(base.x + sgn * es * 0.4, base.y + es, base.z - es * 0.1);
      b.cone(base, tip, es * (m.ears.shape === 'round' ? 0.6 : 0.35), head, MASK_DARK, 5);
    }
  }
  // horns / antlers / crown
  if (m.horns.type !== 'none' && m.horns.type !== 'tusks') {
    const hl = m.horns.len * hs * 2.2;
    const count = m.horns.count;
    for (let i = 0; i < count; i++) {
      let sgn = count === 1 ? 0 : i % 2 ? 1 : -1;
      const row = Math.floor(i / 2);
      let base = V3(hc.x + sgn * hs * 0.2, hc.y + hs * 0.38, hc.z + hs * (0.1 - row * 0.2));
      if (m.horns.type === 'nose') base = V3(hc.x, hc.y + hs * 0.15, hc.z + hs * (0.6 + m.snoutLen * 0.5));
      let p = base.clone();
      let dir = V3(sgn * 0.4, 1, m.horns.type === 'nose' ? 0.5 : -0.3).normalize();
      const segs = m.horns.type === 'antlers' ? 3 : 3;
      for (let s = 0; s < segs; s++) {
        const np = p.clone().addScaledVector(dir, hl / segs);
        b.tube(p, np, hs * 0.06 * (1 - s / segs) + 0.004, hs * 0.06 * (1 - (s + 1) / segs) + 0.002, head, [0, 0.95, 0], 5);
        if (m.horns.type === 'antlers' && s < 2) {
          const bd = V3(dir.x + sgn * 0.6, dir.y * 0.5, dir.z + 0.4).normalize();
          b.cone(np, np.clone().addScaledVector(bd, hl * 0.35), hs * 0.03, head, [0, 0.95, 0], 4);
        }
        dir.applyAxisAngle(V3(1, 0, 0), -m.horns.curve * 0.45).normalize();
        if (m.horns.type === 'spiral') dir.applyAxisAngle(V3(0, 1, 0), 0.6 * (sgn || 1));
        p = np;
      }
    }
  }
  if (m.frill) {
    const pts = [V3(hc.x, hc.y, hc.z - hs * 0.3)];
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * (0.05 + 0.9 * (i / 8));
      pts.push(V3(hc.x + Math.cos(a) * hs * (0.6 + m.frill), hc.y + Math.sin(a) * hs * (0.5 + m.frill) - hs * 0.1, hc.z - hs * 0.45));
    }
    b.fan(pts, V3(0, 0, -1), head, MASK_DARK);
  }
  if (m.crest.type !== 'none' && !['sail', 'ridge', 'fin'].includes(m.crest.type)) {
    const cs = m.crest.size * hs * 2;
    if (m.crest.type === 'casque') b.ellipsoid(V3(hc.x, hc.y + hs * 0.45, hc.z + hs * 0.1), V3(hs * 0.12, cs * 0.5, hs * 0.35), head, MASK_ACCENT, 6, 4);
    else for (let i = 0; i < 5; i++) {
      const a = -0.6 + i * 0.3;
      const base = V3(hc.x, hc.y + hs * 0.38, hc.z - hs * 0.05 * i);
      b.cone(base, V3(base.x, base.y + cs * Math.cos(a), base.z - cs * Math.sin(a + 0.8)), hs * 0.05, head, MASK_ACCENT, 3);
    }
  }
  if (m.antennae > 0.05) {
    for (const sgn of [-1, 1]) {
      const base = V3(hc.x + sgn * hs * 0.15, hc.y + hs * 0.3, hc.z + hs * 0.35);
      const ab = addBone('antenna' + (sgn > 0 ? 'R' : 'L'), head, base);
      const mid = V3(base.x + sgn * m.antennae * hs * 0.6, base.y + m.antennae * hs * 0.8, base.z + m.antennae * hs * 0.6);
      const tip = V3(mid.x + sgn * m.antennae * hs * 0.3, mid.y + m.antennae * hs * 0.2, mid.z + m.antennae * hs * 1.0);
      b.tube(base, mid, hs * 0.025, hs * 0.02, ab, MASK_DARK, 4);
      b.tube(mid, tip, hs * 0.02, hs * 0.012, ab, MASK_DARK, 4);
    }
  }

  // ---- tail ------------------------------------------------------------------
  const tailBones = [];
  if (m.tail.len > 0.05) {
    const nT = Math.max(2, Math.round(m.tail.len * 4));
    const hip = bones[spine[0]].pos;
    let p = V3(hip.x, hip.y + height * 0.1, hip.z - segLen * 0.5);
    prev = spine[0];
    const tl = m.tail.len * L;
    for (let i = 0; i < nT; i++) {
      const t0 = i / nT, t1 = (i + 1) / nT;
      const droop = m.tail.tip === 'stinger' ? -0.9 : 0.25;
      const np = V3(p.x, p.y - (tl / nT) * (droop * (m.tail.tip === 'stinger' ? -1.6 * (t0 - 0.3) : 1)) * 0.6, p.z - tl / nT);
      if (m.tail.tip === 'stinger') np.y = p.y + (tl / nT) * (t0 < 0.5 ? 0.4 : 1.2);
      const tb = addBone('tail' + i, prev, p);
      const r0 = girth * m.tail.thick * (1 - t0 * 0.85) * 0.55, r1 = girth * m.tail.thick * (1 - t1 * 0.85) * 0.55;
      b.tube(p, np, Math.max(0.01, r0), Math.max(0.006, r1), tb, null, 6, null, patFn);
      tailBones.push(tb);
      prev = tb; p = np;
    }
    const tipB = tailBones[tailBones.length - 1];
    if (m.tail.tip === 'club') b.ellipsoid(p, V3(girth * 0.25, girth * 0.22, girth * 0.3), tipB, lith ? MASK_ACCENT : MASK_DARK, 6, 4);
    if (m.tail.tip === 'spike' || m.tail.tip === 'stinger') b.cone(p, V3(p.x, p.y + (m.tail.tip === 'stinger' ? girth * 0.2 : 0), p.z - girth * 0.6), girth * 0.12, tipB, MASK_ACCENT, 4);
    if (m.tail.tip === 'fan' || m.tail.tip === 'fork' || m.tail.tip === 'plume' || m.tail.tip === 'tuft') {
      const w = girth * (m.tail.tip === 'tuft' ? 0.3 : 0.9), l = girth * (m.tail.tip === 'plume' ? 1.6 : 1.0);
      const pts = m.tail.tip === 'fork'
        ? [p.clone(), V3(p.x - w, p.y, p.z - l), V3(p.x, p.y, p.z - l * 0.5), V3(p.x + w, p.y, p.z - l)]
        : [p.clone(), V3(p.x - w, p.y + l * 0.1, p.z - l), V3(p.x, p.y + l * 0.15, p.z - l * 1.15), V3(p.x + w, p.y + l * 0.1, p.z - l)];
      b.fan(pts, V3(0, 1, 0), tipB, MASK_DARK);
    }
  }

  // ---- legs ------------------------------------------------------------------
  const legs = [];
  const pairs = m.legs.pairs;
  for (let i = 0; i < pairs; i++) {
    let attach;
    if (m.legs.biped) attach = bones[spine[0]].pos;
    else if (arth && m.kind !== 'centipede') attach = bones[spine[Math.min(nSpine - 1, Math.max(0, nSpine - 2))]].pos.clone().add(V3(0, 0, (i - (pairs - 1) / 2) * segLen * 0.55));
    else if (arth) attach = bones[spine[Math.min(nSpine - 1, i)]].pos;
    else {
      const t = pairs === 1 ? 0 : i / (pairs - 1);
      attach = V3(0, hipH, -L * 0.38 + t * L * 0.76);
    }
    const si = spine[Math.max(0, Math.min(nSpine - 1, Math.round(((attach.z + L / 2) / L) * nSpine - 0.5)))];
    for (const sgn of [-1, 1]) {
      const posture = m.legs.posture;
      const hipP = V3(sgn * girth * 0.42, attach.y - height * 0.15, attach.z);
      const upperLen = legLen * (posture === 'arthropod' ? 0.45 : 0.5), lowerLen = legLen * (posture === 'arthropod' ? 0.65 : 0.5);
      let knee, foot;
      if (posture === 'sprawl') { knee = V3(sgn * (girth * 0.42 + upperLen * 0.9), hipP.y - upperLen * 0.2, hipP.z); foot = V3(knee.x + sgn * lowerLen * 0.15, 0, knee.z + lowerLen * 0.1); }
      else if (posture === 'arthropod') { knee = V3(sgn * (girth * 0.42 + upperLen * 0.8), hipP.y + upperLen * 0.45, hipP.z + (i - (pairs - 1) / 2) * 0.05); foot = V3(knee.x + sgn * lowerLen * 0.45, 0, knee.z + (i - (pairs - 1) / 2) * lowerLen * 0.3); }
      else if (posture === 'digitigrade') { knee = V3(sgn * girth * 0.45, hipP.y - upperLen * 0.85, hipP.z + upperLen * 0.35); foot = V3(sgn * girth * 0.45, 0, hipP.z - lowerLen * 0.05); }
      else { knee = V3(sgn * girth * 0.4, hipP.y - upperLen, hipP.z); foot = V3(sgn * girth * 0.4, 0, hipP.z + 0.02); }
      if (foot.y !== 0) foot.y = 0;
      const ub = addBone(`leg${i}${sgn > 0 ? 'R' : 'L'}u`, si, hipP);
      const lb = addBone(`leg${i}${sgn > 0 ? 'R' : 'L'}l`, ub, knee);
      const th = m.legs.thick * (lith ? 1.3 : 1);
      b.tube(hipP, knee, th * 0.55, th * 0.42, ub, null, 6, null, patFn);
      b.tube(knee, foot, th * 0.42, th * 0.3, lb, MASK_BASE, 6, null, patFn);
      if (!arth) b.ellipsoid(V3(foot.x, foot.y + th * 0.15, foot.z + th * 0.25), V3(th * 0.45, th * 0.18, th * (fam === 'bird' ? 1.3 : 0.65)), lb, MASK_DARK, 5, 3);
      legs.push({ upper: ub, lower: lb, pair: i, side: sgn });
    }
  }
  // forelimbs (bipeds, mantis/scorpion/crab claws)
  const arms = [];
  if (m.arms.len > 0.05) {
    for (const sgn of [-1, 1]) {
      const sh = V3(sgn * girth * 0.4, chest.y - height * 0.1, chest.z + segLen * 0.2);
      const el = V3(sh.x + sgn * m.arms.len * 0.15, sh.y - m.arms.len * 0.5, sh.z + m.arms.len * 0.25);
      const hand = V3(el.x, el.y - m.arms.len * 0.15, el.z + m.arms.len * 0.5);
      const ab = addBone('arm' + (sgn > 0 ? 'R' : 'L'), spine[nSpine - 1], sh);
      b.tube(sh, el, m.legs.thick * 0.35, m.legs.thick * 0.28, ab, null, 5, null, patFn);
      b.tube(el, hand, m.legs.thick * 0.28, m.legs.thick * 0.18, ab, MASK_DARK, 5);
      if (arth) b.cone(hand, V3(hand.x, hand.y + m.arms.len * 0.1, hand.z + m.arms.len * 0.35), m.legs.thick * 0.3, ab, MASK_DARK, 4);
      arms.push(ab);
    }
  }
  // wings
  const wings = [];
  if (m.wings.type !== 'none') {
    const span = m.wings.span * L * 0.5;
    for (const sgn of [-1, 1]) {
      const base = V3(sgn * girth * 0.35, chest.y + height * 0.3, chest.z - segLen * 0.2);
      const wi = addBone('wing' + (sgn > 0 ? 'R' : 'L') + 'i', spine[nSpine - 1], base);
      const mid = V3(base.x + sgn * span * 0.5, base.y + span * 0.05, base.z - span * 0.05);
      const wo = addBone('wing' + (sgn > 0 ? 'R' : 'L') + 'o', wi, mid);
      const tip = V3(base.x + sgn * span, base.y, base.z - span * 0.25);
      const mask = m.wings.type === 'insect' ? [0.2, 0.5, 0.3] : MASK_DARK;
      if (m.wings.type === 'feather') {
        const chord = span * 0.45;
        b.fan([base.clone(), mid.clone(), V3(mid.x, mid.y, mid.z - chord), V3(base.x, base.y, base.z - chord * 0.8)], V3(0, 1, 0), wi, mask);
        b.fan([mid.clone(), tip.clone(), V3(tip.x - sgn * span * 0.1, tip.y, tip.z - chord * 0.6), V3(mid.x, mid.y, mid.z - chord)], V3(0, 1, 0), wo, mask);
      } else if (m.wings.type === 'membrane') {
        b.tube(base, mid, girth * 0.05, girth * 0.04, wi, MASK_DARK, 4);
        b.tube(mid, tip, girth * 0.04, girth * 0.02, wo, MASK_DARK, 4);
        b.fan([base.clone(), mid.clone(), tip.clone(), V3(tip.x - sgn * span * 0.25, base.y - span * 0.02, base.z - span * 0.55), V3(base.x, base.y - span * 0.05, base.z - L * 0.35)], V3(0, 1, 0), wi, [0.5, 0.2, 0], [wi, wo, wo, wo, wi]);
      } else {
        const ch = span * 0.5;
        b.fan([base.clone(), V3(base.x + sgn * span * 0.4, base.y, base.z + ch * 0.4), tip.clone(), V3(base.x + sgn * span * 0.6, base.y, base.z - ch * 0.7)], V3(0, 1, 0), wo, mask);
      }
      wings.push({ inner: wi, outer: wo, side: sgn });
    }
  }

  const geometry = b.geometry();
  return {
    geometry,
    bones,
    rig: { root, spine, neck: neckBones, head, jaw, tail: tailBones, legs, arms, wings, hipH, legLen, bodyLen: L },
  };
}

const sharedMats = new Map();

function colorFromHSL(c, genes, which) {
  const dh = genes ? genes.hue : 0, dl = genes ? genes.light : 0, ds = genes ? genes.sat : 0;
  return new THREE.Color().setRGB(...hsl2rgb(c.h + dh, clamp(c.s + ds, 0, 1), clamp(c.l + dl * (which === 'belly' ? 0.5 : 1), 0.04, 0.95)), THREE.SRGBColorSpace);
}

/** Material whose colours come from uniforms so each individual can differ. */
export function makeCreatureMaterial(sp, genes) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  const col = sp.morph.colors;
  m.userData.u = {
    uPrimary: { value: colorFromHSL(col.primary, genes, 'p') },
    uSecondary: { value: colorFromHSL(col.secondary, genes, 's') },
    uBelly: { value: colorFromHSL(col.belly, genes, 'belly') },
    uAccent: { value: colorFromHSL(col.accent, null, 'a') },
    uGlow: { value: sp.morph.eyes.glow || (sp.family === 'lithosere' ? 0.8 : 0) },
    uNightC: { value: 0 },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, m.userData.u);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uPrimary; uniform vec3 uSecondary; uniform vec3 uBelly; uniform vec3 uAccent; uniform float uGlow;`)
      .replace('#include <color_fragment>', `
#ifdef USE_COLOR
  vec3 cc = mix(uPrimary, uSecondary, clamp(vColor.r, 0.0, 1.0));
  cc = mix(cc, uBelly, clamp(vColor.g, 0.0, 1.0));
  cc = mix(cc, uAccent, clamp(vColor.b, 0.0, 1.0));
  diffuseColor.rgb *= cc;
#endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_COLOR
  totalEmissiveRadiance += uAccent * clamp(vColor.b, 0.0, 1.0) * uGlow * 1.6;
#endif`);
  };
  m.customProgramCacheKey = () => 'creature';
  void sharedMats;
  return m;
}

/** Instantiate a skinned mesh for one individual. */
export function createCreatureObject(template, sp, genes) {
  const bones = template.bones.map((bd) => { const b = new THREE.Bone(); b.name = bd.name; return b; });
  template.bones.forEach((bd, i) => {
    if (bd.parent >= 0) {
      bones[bd.parent].add(bones[i]);
      bones[i].position.subVectors(bd.pos, template.bones[bd.parent].pos);
    } else bones[i].position.copy(bd.pos);
  });
  const mesh = new THREE.SkinnedMesh(template.geometry, makeCreatureMaterial(sp, genes));
  mesh.add(bones[0]);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const rest = bones.map((b) => b.position.clone());
  return { mesh, bones, rest };
}
