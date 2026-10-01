// Procedural artifact models from archetype + shape parameters.
import * as THREE from 'three';
import { MATERIALS } from './artifactGen.js';

function mat(art, kind = 'main') {
  const base = new THREE.Color().setRGB(...art.color, THREE.SRGBColorSpace);
  const accent = new THREE.Color().setRGB(...art.accent, THREE.SRGBColorSpace);
  const m = MATERIALS[art.material];
  const params = {
    color: kind === 'accent' ? accent : base,
    metalness: Math.min(0.45, kind === 'accent' ? 0.4 : m.metal * 0.5),
    roughness: kind === 'accent' ? 0.3 : m.rough,
    emissive: kind === 'accent' || art.glow > 0.4 ? (kind === 'accent' ? accent : base) : new THREE.Color(0),
    emissiveIntensity: kind === 'accent' ? 0.6 + art.glow : art.glow * 0.6,
  };
  if (art.material === 'crystal' || art.material === 'amber') { params.transparent = true; params.opacity = 0.85; }
  return new THREE.MeshStandardMaterial(params);
}

function lathe(points, segs, material) {
  return new THREE.Mesh(new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segs), material);
}

/** Build a model about 1 unit tall; caller scales by artifact.size. */
export function buildArtifactModel(art) {
  const g = new THREE.Group();
  const S = art.shape;
  const main = mat(art), acc = mat(art, 'accent');
  const a = S.a, b = S.b, c = S.c, d = S.d;
  const sym = S.symmetry;
  const add = (m, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => { m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m; };
  switch (S.archetype) {
    case 'hammer': case 'pick': case 'chisel': {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.9, 8), main), 0, 0.45);
      if (S.archetype === 'chisel') add(new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.3 + a * 0.2, 4), acc), 0, 1.0);
      else if (S.archetype === 'pick') { add(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.45, 5), acc), 0.22, 0.9, 0, 0, 0, -Math.PI / 2); add(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.3 + b * 0.2, 5), acc), -0.18, 0.9, 0, 0, 0, Math.PI / 2); }
      else add(new THREE.Mesh(new THREE.BoxGeometry(0.4 + a * 0.2, 0.18, 0.18), acc), 0, 0.92);
      for (let i = 0; i < S.rings; i++) add(new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 12), acc), 0, 0.2 + i * 0.12, 0, Math.PI / 2);
      break;
    }
    case 'compass': case 'astrolabe': {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.08, 24), main), 0, 0.5, 0, Math.PI / 2);
      add(new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.03, 6, 24), acc), 0, 0.5);
      add(new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.6, 3), acc), 0, 0.5, 0.06, 0, 0, d * 6);
      if (S.archetype === 'astrolabe') for (let i = 0; i < 2; i++) add(new THREE.Mesh(new THREE.TorusGeometry(0.32 - i * 0.08, 0.015, 6, 20), main), 0, 0.5, 0, a * 3 + i, b * 3);
      break;
    }
    case 'key': {
      add(new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.04, 6, sym * 3), main), 0, 0.85);
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.65, 6), main), 0, 0.4);
      for (let i = 0; i < 3; i++) add(new THREE.Mesh(new THREE.BoxGeometry(0.12 + ((a * 10 + i) % 1) * 0.1, 0.05, 0.03), acc), 0.06, 0.12 + i * 0.08);
      break;
    }
    case 'orb': {
      add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 2), main), 0, 0.5);
      for (let i = 0; i < Math.max(1, S.rings); i++) add(new THREE.Mesh(new THREE.TorusGeometry(0.42 + i * 0.05, 0.015, 6, 32), acc), 0, 0.5, 0, a * 3 + i * 1.1, b * 3 + i);
      break;
    }
    case 'tablet': {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.8, 0.08), main), 0, 0.42);
      for (let i = 0; i < 4; i++) add(new THREE.Mesh(new THREE.BoxGeometry(0.4 * (0.5 + ((c * 7 + i) % 1) * 0.5), 0.04, 0.02), acc), 0, 0.2 + i * 0.15, 0.05);
      break;
    }
    case 'idolHead': case 'figurine': {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.25, 0.45, sym + 3), main), 0, 0.22);
      add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1), main), 0, 0.62);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), acc), -0.08, 0.66, 0.19);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), acc), 0.08, 0.66, 0.19);
      if (S.spikes) for (let i = 0; i < sym; i++) add(new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.22, 4), acc), Math.cos(i / sym * 6.28) * 0.15, 0.84, Math.sin(i / sym * 6.28) * 0.15);
      break;
    }
    case 'crown': case 'halo': {
      add(new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.06, 8, 32), main), 0, 0.3, 0, Math.PI / 2);
      for (let i = 0; i < sym * 2; i++) {
        const ang = i / (sym * 2) * Math.PI * 2;
        add(new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.25 + (i % 2) * 0.15 * a, 4), i % 2 ? acc : main), Math.cos(ang) * 0.38, 0.45, Math.sin(ang) * 0.38);
      }
      if (S.archetype === 'halo') g.rotation.x = 0.4;
      break;
    }
    case 'ring': case 'torc': {
      add(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.06 + a * 0.04, 8, 28, S.archetype === 'torc' ? Math.PI * 1.7 : Math.PI * 2), main), 0, 0.4);
      add(new THREE.Mesh(new THREE.OctahedronGeometry(0.1 + b * 0.05), acc), 0, 0.72);
      break;
    }
    case 'pendant': {
      add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.015, 6, 20), main), 0, 0.85);
      const shape = S.segments % 3;
      add(new THREE.Mesh(shape === 0 ? new THREE.OctahedronGeometry(0.22) : shape === 1 ? new THREE.TetrahedronGeometry(0.25) : new THREE.CylinderGeometry(0.2, 0.2, 0.05, sym + 3), acc), 0, 0.4, 0, Math.PI / 2 * (shape === 2 ? 1 : 0));
      break;
    }
    case 'gauntlet': case 'boot': {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.55, 10), main), 0, 0.4);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.42), main), 0, 0.08, 0.1);
      for (let i = 0; i < S.segments % 4 + 2; i++) add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.02, 6, 16), acc), 0, 0.2 + i * 0.12, 0, Math.PI / 2);
      break;
    }
    case 'buckle': case 'visor': {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.38, 0.06), main), 0, 0.4);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.12, 0.08), acc), 0, 0.42, 0.02);
      break;
    }
    case 'gears': case 'clockwork': case 'gyro': {
      const n = 2 + (S.segments % 3);
      for (let i = 0; i < n; i++) {
        const r = 0.15 + ((a * 13 + i * 0.37) % 1) * 0.2;
        const gear = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.06, 6 + sym * 2), i % 2 ? acc : main);
        add(gear, (i - n / 2) * 0.22, 0.35 + (i % 2) * 0.2, 0, Math.PI / 2);
        gear.userData.spin = (i % 2 ? 1 : -1) * (0.5 + b);
      }
      if (S.archetype === 'gyro') for (let i = 0; i < 3; i++) add(new THREE.Mesh(new THREE.TorusGeometry(0.4 - i * 0.06, 0.012, 6, 30), acc), 0, 0.5, 0, i, i * 0.7).userData.spin = 0.4 + i * 0.3;
      break;
    }
    case 'lens': case 'prism': {
      if (S.archetype === 'prism') add(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.7, 3), acc), 0, 0.45);
      else { add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 24), acc), 0, 0.55, 0, Math.PI / 2); add(new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.035, 6, 24), main), 0, 0.55); add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 6), main), 0, 0.15); }
      break;
    }
    case 'flask': case 'bowl': case 'bell': {
      const prof = S.archetype === 'flask' ? [[0, 0], [0.25, 0.02], [0.3, 0.25], [0.12, 0.6], [0.08, 0.85], [0.1, 0.9]]
        : S.archetype === 'bell' ? [[0, 0.95], [0.08, 0.9], [0.15, 0.7], [0.22, 0.35], [0.35, 0.05], [0.3, 0.0]]
          : [[0, 0], [0.2, 0.02], [0.38, 0.15], [0.45, 0.32], [0.42, 0.34]];
      add(lathe(prof, 16, main), 0, 0);
      if (S.inlay) add(new THREE.Mesh(new THREE.TorusGeometry(S.archetype === 'bowl' ? 0.43 : 0.25, 0.02, 6, 20), acc), 0, S.archetype === 'bowl' ? 0.3 : 0.4, 0, Math.PI / 2);
      break;
    }
    case 'blade': case 'spearhead': {
      add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.75, 0.025), main), 0, 0.6);
      add(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 4), main), 0, 1.07);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.05, 0.06), acc), 0, 0.22);
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 6), acc), 0, 0.08);
      break;
    }
    case 'aegis': {
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.06, sym + 3), main), 0, 0.5, 0, Math.PI / 2);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), acc), 0, 0.5, 0.05);
      break;
    }
    case 'seedpod': case 'heartstone': {
      const m = add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 2), main), 0, 0.42);
      m.scale.set(1, 1.3 + a * 0.4, 1);
      for (let i = 0; i < sym; i++) add(new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.02, 4, 16, Math.PI), acc), 0, 0.42, 0, 0, i / sym * Math.PI);
      m.userData.pulse = true;
      break;
    }
    case 'shell': {
      for (let i = 0; i < 9; i++) {
        const r = 0.05 + i * 0.03;
        add(new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.45, 6, 12, Math.PI), i % 2 ? main : acc), Math.cos(i * 0.9) * r * 0.5, 0.25 + i * 0.02, Math.sin(i * 0.9) * r * 0.5, Math.PI / 2, 0, i * 0.9);
      }
      break;
    }
    case 'coral': {
      const branch = (x, y, z, len, depth) => {
        if (depth > 3) return;
        add(new THREE.Mesh(new THREE.CylinderGeometry(0.02 * (4 - depth), 0.03 * (4 - depth), len, 5), depth % 2 ? acc : main), x, y + len / 2, z);
        for (let k = 0; k < 2; k++) branch(x + (k ? 1 : -1) * len * 0.3, y + len, z + (a - 0.5) * len * 0.3, len * 0.7, depth + 1);
      };
      branch(0, 0, 0, 0.35, 0);
      break;
    }
    case 'knot': {
      add(new THREE.Mesh(new THREE.TorusKnotGeometry(0.25, 0.06, 64, 8, 2 + (S.segments % 3), 3 + (S.segments % 2)), main), 0, 0.5);
      break;
    }
    case 'cubes': {
      for (let i = 0; i < 3; i++) {
        const s = 0.55 - i * 0.16;
        const m = add(new THREE.Mesh(new THREE.BoxGeometry(s, s, s), i % 2 ? acc : main), 0, 0.5, 0, i * 0.5, i * 0.7);
        if (i < 2) { m.material = m.material.clone(); m.material.wireframe = true; }
        m.userData.spin = 0.3 + i * 0.25;
      }
      break;
    }
    case 'tetra': {
      add(new THREE.Mesh(new THREE.TetrahedronGeometry(0.4), main), 0, 0.5).userData.spin = 0.6;
      add(new THREE.Mesh(new THREE.TetrahedronGeometry(0.25), acc), 0, 0.5, 0, Math.PI, 0.5).userData.spin = -0.9;
      break;
    }
    case 'mask': {
      const m = add(new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), main), 0, 0.45, 0, -Math.PI / 2);
      m.scale.set(1, 1, 0.5);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), acc), -0.14, 0.5, 0.18);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), acc), 0.14, 0.5, 0.18);
      break;
    }
    default: add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), main), 0, 0.4);
  }
  if (S.twist) g.rotation.z = S.twist * 0.2;
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

/** Soft glow sprite texture shared by all artifacts. */
let glowTex = null;
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const gr = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.3, 'rgba(255,240,200,0.5)');
  gr.addColorStop(1, 'rgba(255,220,150,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}
