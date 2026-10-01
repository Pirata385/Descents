// Atmospheric particles, animated entirely on the GPU:
// - a field of motes that wraps around the camera (pollen and seed fluff on
//   the surface, cave dust, drifting spores in the Inverted Forest, ash in the
//   Great Fault) and a second additive field of glowing particles (fireflies
//   at night, bioluminescent spores, rising embers),
// - billowing mist at the foot of the great waterfalls.
// Each environment preset is blended smoothly as the explorer descends.
import * as THREE from 'three';
import { shared, FOG_GLSL } from './materials.js';
import { RNG } from '../core/rng.js';

const BOX = 56;

const PRESETS = {
  surfaceDay: { motes: [0.32, [1.0, 0.96, 0.85], [0.95, 0.9, 0.7], 0.07, 0.05, 0.4], glows: [0, [1, 1, 0.6], [0.8, 1, 0.4], 0.12, 0, 0] },
  surfaceNight: { motes: [0.08, [0.8, 0.85, 1], [0.7, 0.75, 0.9], 0.06, 0.03, 0.3], glows: [0.3, [0.85, 1.0, 0.35], [1.0, 0.85, 0.3], 0.14, 0.05, 1] },
  bowlDay: { motes: [0.5, [1.0, 0.95, 0.7], [0.9, 1.0, 0.75], 0.07, 0.08, 0.5], glows: [0, [1, 1, 0.6], [0.8, 1, 0.4], 0.12, 0, 0] },
  cave: { motes: [0.45, [0.75, 0.72, 0.65], [0.6, 0.58, 0.55], 0.05, -0.02, 0.1], glows: [0.04, [0.4, 0.9, 0.9], [0.5, 0.7, 1.0], 0.08, 0.02, 0.5] },
  forest: { motes: [0.55, [0.7, 0.95, 0.85], [0.85, 0.8, 1.0], 0.06, 0.12, 0.25], glows: [0.45, [0.3, 1.0, 0.85], [0.75, 0.45, 1.0], 0.1, 0.1, 0.6] },
  plain: { motes: [0.35, [0.95, 0.92, 0.85], [0.8, 0.85, 0.8], 0.06, 0.04, 0.35], glows: [0.18, [0.5, 1.0, 0.9], [1.0, 0.95, 0.6], 0.1, 0.06, 0.6] },
  fault: { motes: [0.55, [0.45, 0.42, 0.42], [0.3, 0.28, 0.3], 0.07, -0.25, 0.3], glows: [0.6, [1.0, 0.45, 0.15], [1.0, 0.25, 0.08], 0.09, 0.9, 0.2] },
};

function makeField(n, additive, seed) {
  const rng = new RNG(seed);
  const pos = new Float32Array(n * 3), rnd = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = rng.next(); pos[i * 3 + 1] = rng.next(); pos[i * 3 + 2] = rng.next();
    rnd[i * 4] = rng.next(); rnd[i * 4 + 1] = rng.next(); rnd[i * 4 + 2] = rng.next(); rnd[i * 4 + 3] = rng.next();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
  const u = {
    uDensity: { value: 0 }, uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() },
    uSize: { value: 0.08 }, uRise: { value: 0 }, uWindXZ: { value: new THREE.Vector2(0.4, 0.1) }, uTwinkle: { value: 0 },
    uBright: { value: 1 }, uScale: { value: 600 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, ...u },
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: /* glsl */`
uniform float uTime; uniform vec3 uCamPos; uniform float uDensity; uniform float uSize; uniform float uRise;
uniform vec2 uWindXZ; uniform float uScale; uniform float uTwinkle;
attribute vec4 aRand;
varying float vA; varying float vMix; varying vec3 vW;
void main() {
  float box = ${BOX.toFixed(1)};
  float speed = 0.6 + aRand.x * 0.8;
  vec3 p = position * box;
  p += vec3(uWindXZ.x, uRise, uWindXZ.y) * uTime * speed * 4.0;
  p += vec3(sin(uTime * (0.3 + aRand.y) + aRand.z * 6.28), sin(uTime * (0.2 + aRand.z * 0.5) + aRand.x * 6.28) * 0.6, cos(uTime * (0.25 + aRand.x * 0.4) + aRand.y * 6.28)) * (0.6 + aRand.w);
  vec3 rel = mod(p - uCamPos + box * 0.5, box) - box * 0.5;
  vec3 w = uCamPos + rel;
  vW = w;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  float d = length(rel);
  float edge = 1.0 - smoothstep(box * 0.32, box * 0.5, d);
  float on = step(aRand.w, uDensity);
  float tw = mix(1.0, 0.5 + 0.5 * sin(uTime * (1.5 + aRand.x * 3.0) + aRand.y * 40.0), uTwinkle);
  tw = mix(tw, smoothstep(0.2, 1.0, tw), uTwinkle);
  vA = edge * on * tw * smoothstep(0.2, 1.2, d);
  vMix = aRand.z;
  gl_PointSize = on > 0.5 ? uSize * (0.6 + aRand.y * 0.8) * uScale / max(0.5, -mv.z) : 0.0;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
uniform vec3 uColA; uniform vec3 uColB; uniform float uBright; uniform vec3 uCamPos;
varying float vA; varying float vMix; varying vec3 vW;
${FOG_GLSL}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r);
  vec3 col = mix(uColA, uColB, vMix) * uBright;
  col = applyFog(col, length(vW - uCamPos));
  gl_FragColor = vec4(col, a * vA * ${additive ? '0.9' : '0.55'});
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 5;
  return { pts, u };
}

function makeMist(maxFalls, per, seed) {
  const n = maxFalls * per;
  const rng = new RNG(seed);
  const pos = new Float32Array(n * 3), rnd = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { rnd[i * 4] = rng.next(); rnd[i * 4 + 1] = rng.next(); rnd[i * 4 + 2] = rng.next(); rnd[i * 4 + 3] = rng.next(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
  g.setAttribute('aWidth', new THREE.BufferAttribute(new Float32Array(n), 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uScale: { value: 600 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */`
uniform float uTime; uniform float uScale;
attribute vec4 aRand; attribute float aWidth;
varying float vA; varying vec3 vW;
void main() {
  float life = fract(uTime * (0.05 + aRand.x * 0.05) + aRand.y);
  float ang = aRand.z * 6.2832;
  float rad = (0.3 + life * 1.4) * (aWidth * 0.8 + 4.0) * (0.4 + aRand.w * 0.6);
  vec3 w = position + vec3(cos(ang) * rad, life * (6.0 + aWidth * 0.8) - 1.0, sin(ang) * rad);
  vW = w;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  vA = smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.55, 1.0, life)) * step(0.01, aWidth);
  gl_PointSize = (3.0 + life * 7.0 + aWidth * 0.4) * uScale / max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: /* glsl */`
uniform float uNight; uniform float uDeepLight; uniform vec3 uCamPos;
varying float vA; varying vec3 vW;
${FOG_GLSL}
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.05, r) * vA * 0.32;
  float depthK = smoothstep(-920.0, -220.0, vW.y);
  vec3 col = vec3(0.86, 0.92, 0.95) * mix(uDeepLight + 0.3, 1.0, depthK) * (1.0 - uNight * 0.65);
  gl_FragColor = vec4(applyFog(col, length(vW - uCamPos)), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  return { pts, per, maxFalls, mat };
}

export class Particles {
  constructor(scene, plan, quality = 1) {
    this.scene = scene;
    this.plan = plan;
    const n = Math.round(2600 * quality);
    this.motes = makeField(n, false, 101);
    this.glows = makeField(Math.round(n * 0.5), true, 202);
    scene.add(this.motes.pts, this.glows.pts);
    this.mist = makeMist(8, 70, 303);
    scene.add(this.mist.pts);
    this.cur = { motes: PRESETS.surfaceDay.motes.map(copyVal), glows: PRESETS.surfaceDay.glows.map(copyVal) };
    this.mistTimer = 0;
    this.mistKey = '';
    // the big waterfalls (and the plunge points of the river falls)
    this.falls = (plan.waterfalls || []).map((w) => ({ x: w.x, y: w.bottomY, z: w.z, width: w.width || 3 }));
    for (const w of plan.waterfalls || []) if (w.kind === 'eye') this.falls.push({ x: w.x, y: w.topY - 6, z: w.z, width: (w.width || 3) * 0.5 });
  }

  pickPreset(ctx) {
    const { layer, enclosed, night, zone } = ctx;
    if (layer >= 3) return 'fault';
    if (layer === 2) return ctx.y < this.plan.params.plainY + 60 ? 'plain' : enclosed > 0.5 ? 'forest' : 'forest';
    if (enclosed > 0.5) return 'cave';
    if (night > 0.5) return 'surfaceNight';
    return zone === 1 ? 'bowlDay' : 'surfaceDay';
  }

  update(dt, ctx) {
    const P = PRESETS[this.pickPreset(ctx)];
    const k = Math.min(1, dt * 0.5);
    for (const which of ['motes', 'glows']) {
      const c = this.cur[which], t = P[which];
      c[0] += (t[0] - c[0]) * k;
      for (let i = 0; i < 3; i++) { c[1][i] += (t[1][i] - c[1][i]) * k; c[2][i] += (t[2][i] - c[2][i]) * k; }
      c[3] += (t[3] - c[3]) * k; c[4] += (t[4] - c[4]) * k; c[5] += (t[5] - c[5]) * k;
      const u = this[which].u;
      u.uDensity.value = c[0] * (ctx.quality ?? 1);
      u.uColA.value.setRGB(c[1][0], c[1][1], c[1][2]);
      u.uColB.value.setRGB(c[2][0], c[2][1], c[2][2]);
      u.uSize.value = c[3];
      u.uRise.value = c[4];
      u.uTwinkle.value = c[5];
      u.uWindXZ.value.set(0.25 * (ctx.wind ?? 1), 0.08);
      u.uBright.value = which === 'motes' ? (ctx.light ?? 1) : 1.0;
      u.uScale.value = ctx.pxScale;
    }
    this.mist.mat.uniforms.uScale.value = ctx.pxScale;
    // mist at the nearest waterfalls
    this.mistTimer -= dt;
    if (this.mistTimer <= 0) {
      this.mistTimer = 1;
      const p = ctx.pos;
      const near = this.falls.map((f) => [Math.hypot(f.x - p.x, (f.y - p.y) * 0.5, f.z - p.z), f]).filter((a) => a[0] < 420).sort((a, b) => a[0] - b[0]).slice(0, this.mist.maxFalls);
      const key = near.map((a) => `${a[1].x | 0},${a[1].z | 0}`).join('|');
      if (key !== this.mistKey) {
        this.mistKey = key;
        const pos = this.mist.pts.geometry.attributes.position.array;
        const wid = this.mist.pts.geometry.attributes.aWidth.array;
        const per = this.mist.per;
        for (let s = 0; s < this.mist.maxFalls; s++) {
          const f = near[s] ? near[s][1] : null;
          for (let i = 0; i < per; i++) {
            const k2 = s * per + i;
            if (f) { pos[k2 * 3] = f.x; pos[k2 * 3 + 1] = f.y; pos[k2 * 3 + 2] = f.z; wid[k2] = f.width; } else wid[k2] = 0;
          }
        }
        this.mist.pts.geometry.attributes.position.needsUpdate = true;
        this.mist.pts.geometry.attributes.aWidth.needsUpdate = true;
      }
    }
  }
}

function copyVal(v) { return Array.isArray(v) ? v.slice() : v; }
