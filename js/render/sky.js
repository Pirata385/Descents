// Sky dome with sun, moon, clouds and stars, plus the ocean ring around the island.
import * as THREE from 'three';
import { shared } from './materials.js';

export class Sky {
  constructor(scene, params) {
    this.uniforms = {
      uSunDir: shared.uSunDir,
      uTime: shared.uTime,
      uNight: shared.uNight,
      uZenith: { value: new THREE.Color(0.25, 0.45, 0.8) },
      uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
      uDepthDim: { value: 1 },
    };
    const geo = new THREE.SphereGeometry(5000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`,
      fragmentShader: /* glsl */`
uniform vec3 uSunDir;
uniform float uTime;
uniform float uNight;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uDepthDim;
varying vec3 vDir;
float sh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float sn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sh(i), sh(i + vec2(1, 0)), f.x), mix(sh(i + vec2(0, 1)), sh(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * sn(p); p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.55));
  if (h < 0.0) sky = mix(uHorizon, uHorizon * 0.55, min(1.0, -h * 3.0));
  vec3 sd = normalize(uSunDir);
  float sunDot = max(dot(d, sd), 0.0);
  sky += uSunColor * pow(sunDot, 8.0) * 0.25 * (1.0 - uNight);
  sky += uSunColor * smoothstep(0.9993, 0.9997, sunDot) * 4.0 * (1.0 - uNight);
  // moon opposite the sun
  float moonDot = max(dot(d, -sd), 0.0);
  sky += vec3(0.8, 0.85, 1.0) * smoothstep(0.9994, 0.9997, moonDot) * 1.6 * uNight;
  // stars
  if (h > 0.0) {
    vec2 sp = d.xz / (d.y + 0.2) * 220.0;
    float st = step(0.9975, sh(floor(sp))) * (0.6 + 0.4 * sin(uTime * 2.0 + sh(floor(sp) + 3.0) * 30.0));
    sky += vec3(st) * uNight * smoothstep(0.0, 0.25, h);
  }
  // clouds on a plane
  if (h > 0.02) {
    vec2 cp = d.xz / (d.y + 0.08) * 1.6 + vec2(uTime * 0.004, uTime * 0.0025);
    float c = fbm(cp);
    float cov = smoothstep(0.52, 0.78, c);
    vec3 cc = mix(vec3(1.0), uHorizon * 0.9, 0.3) * (1.0 - uNight * 0.85);
    cc += uSunColor * pow(sunDot, 4.0) * 0.4 * (1.0 - uNight);
    sky = mix(sky, cc, cov * smoothstep(0.02, 0.2, h) * 0.85);
  }
  gl_FragColor = vec4(sky * uDepthDim, 1.0);
  #include <colorspace_fragment>
}`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // ocean ring around the island
    const inner = params.coastR - 180, outer = 9000;
    const og = new THREE.RingGeometry(inner, outer, 96, 4);
    og.rotateX(-Math.PI / 2);
    const om = new THREE.ShaderMaterial({
      uniforms: { ...shared, uDeep: { value: new THREE.Color(0.05, 0.2, 0.3) }, uShallow: { value: new THREE.Color(0.12, 0.38, 0.45) } },
      transparent: false,
      vertexShader: /* glsl */`
varying vec3 vWPos;
void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vWPos = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */`
uniform float uTime; uniform float uNight; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSkyColor; uniform vec3 uCamPos;
uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFogColor; uniform float uFogDensity;
varying vec3 vWPos;
float oh(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
float on(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(oh(i), oh(i + vec2(1, 0)), f.x), mix(oh(i + vec2(0, 1)), oh(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 p = vWPos.xz * 0.05;
  float n1 = on(p + vec2(uTime * 0.05, uTime * 0.03)), n2 = on(p * 2.3 - vec2(uTime * 0.04, -uTime * 0.06));
  vec3 n = normalize(vec3(n1 - 0.5, 2.5, n2 - 0.5));
  vec3 V = normalize(uCamPos - vWPos);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  float r = length(vWPos.xz);
  vec3 col = mix(uShallow, uDeep, smoothstep(${(params.coastR - 100).toFixed(1)}, ${(params.coastR + 200).toFixed(1)}, r));
  col = mix(col, uSkyColor, fres * 0.6);
  vec3 H = normalize(normalize(uSunDir) + V);
  col += uSunColor * pow(max(dot(n, H), 0.0), 200.0) * (1.0 - uNight);
  col *= 1.0 - uNight * 0.8;
  float dist = length(vWPos - uCamPos);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist * 0.35);
  gl_FragColor = vec4(mix(col, uFogColor, clamp(f, 0.0, 1.0)), 1.0);
  #include <colorspace_fragment>
}`,
    });
    this.ocean = new THREE.Mesh(og, om);
    this.ocean.position.y = params.seaY;
    this.ocean.frustumCulled = false;
    scene.add(this.ocean);
  }

  update(camPos, palette) {
    this.mesh.position.copy(camPos);
    this.uniforms.uZenith.value.copy(palette.zenith);
    this.uniforms.uHorizon.value.copy(palette.horizon);
    this.uniforms.uSunColor.value.copy(palette.sun);
    this.uniforms.uDepthDim.value = palette.skyDim;
  }
}
