// Materials for chunk geometry. Terrain and foliage extend MeshLambertMaterial
// through onBeforeCompile: sRGB vertex colours, baked sky exposure and ambient
// occlusion, depth-dependent abyss lighting, shader strata, hex tile edges,
// night-lit windows, glowing crystals/fungus/lava veins, and foliage wind sway.
// Water and waterfalls use custom shaders with matching fog.
import * as THREE from 'three';

export const shared = {
  uTime: { value: 0 },
  uNight: { value: 0 },          // 0 day .. 1 night
  uWind: { value: 1 },
  uDeepLight: { value: 0.18 },   // direct light multiplier at the bottom of the abyss
  uAbyssGlow: { value: new THREE.Color(0.06, 0.12, 0.11) },
  uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
  uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
  uSkyColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
  uFogColor: { value: new THREE.Color(0.6, 0.7, 0.8) },
  uFogDensity: { value: 0.0015 },
  uCamPos: { value: new THREE.Vector3() },
  uLampPos: { value: new THREE.Vector3() },
  uLampColor: { value: new THREE.Color(0, 0, 0) },
  uLampRange: { value: 12 },
};

const COMMON_PARS = /* glsl */`
uniform float uTime;
uniform float uNight;
uniform float uDeepLight;
uniform vec3 uAbyssGlow;
uniform float uHexScale;
uniform vec3 uCamPos;
uniform vec3 uLampPos;
uniform vec3 uLampColor;
uniform float uLampRange;
varying vec4 vLight;
varying vec3 vWPos;
varying float vNy;
float dHash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
float dHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float dNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float n = i.x + i.y * 57.0 + i.z * 113.0;
  return mix(mix(mix(dHash(n), dHash(n + 1.0), f.x), mix(dHash(n + 57.0), dHash(n + 58.0), f.x), f.y),
             mix(mix(dHash(n + 113.0), dHash(n + 114.0), f.x), mix(dHash(n + 170.0), dHash(n + 171.0), f.x), f.y), f.z);
}
`;

function patchCommonVertex(shader, sway) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
attribute vec4 aLight;
${sway ? 'attribute float aSway;' : ''}
uniform float uTime;
uniform float uWind;
varying vec4 vLight;
varying vec3 vWPos;
varying float vNy;`)
    .replace('#include <color_vertex>', `#include <color_vertex>
#ifdef USE_COLOR
  vColor.rgb = pow(vColor.rgb, vec3(2.2));
#endif
  vLight = aLight;
  vNy = normal.y;`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
${sway ? `{
    vec3 wp0 = (modelMatrix * vec4(position, 1.0)).xyz;
    float ph = wp0.x * 0.21 + wp0.z * 0.17;
    float gust = 0.6 + 0.4 * sin(uTime * 0.37 + wp0.x * 0.01);
    float amp = aSway * aSway * 0.22 * uWind * gust;
    transformed.x += sin(uTime * 1.9 + ph) * amp;
    transformed.z += cos(uTime * 1.5 + ph * 1.3) * amp * 0.7;
    transformed.y -= amp * 0.15;
  }` : ''}`)
    .replace('#include <project_vertex>', `#include <project_vertex>
  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
}

function patchCommonFragment(shader, opts) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
${COMMON_PARS}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
  float flag = floor(vLight.w * 255.0 + 0.5);
  ${opts.terrain ? `
  if (abs(flag - 5.0) < 0.5) {
    float band = floor(vWPos.y / 2.6);
    float hb = dHash(band * 1.37);
    diffuseColor.rgb *= 0.84 + 0.3 * hb;
    diffuseColor.rgb += vec3(0.035, 0.015, -0.012) * (dHash(band + 17.0) - 0.5);
    diffuseColor.rgb *= 0.92 + 0.16 * dNoise(vWPos * vec3(0.35, 1.6, 0.35));
  }
  float camDist = length(vWPos - uCamPos);
  if (vNy > 0.5) {
    vec2 p = vWPos.xz / uHexScale;
    float rr = p.y / 0.8660254; float qq = p.x - rr * 0.5;
    vec3 cube = vec3(qq, -qq - rr, rr);
    vec3 rc = floor(cube + 0.5);
    vec3 df = abs(rc - cube);
    if (df.x > df.y && df.x > df.z) rc.x = -rc.y - rc.z; else if (df.y > df.z) rc.y = -rc.x - rc.z; else rc.z = -rc.x - rc.y;
    vec2 cen = vec2(rc.x + rc.z * 0.5, rc.z * 0.8660254) * uHexScale;
    vec2 dd = abs(vWPos.xz - cen);
    float hd = max(dd.x, dd.x * 0.5 + dd.y * 0.8660254) - 0.5 * uHexScale;
    float edge = smoothstep(-0.07 * uHexScale, 0.0, hd) * (1.0 - smoothstep(30.0 * uHexScale, 90.0 * uHexScale, camDist));
    diffuseColor.rgb *= 1.0 - edge * 0.16;
    float grain = dNoise(vWPos * 1.7) * 0.5 + dNoise(vWPos * 0.37) * 0.5;
    diffuseColor.rgb *= 0.9 + 0.2 * grain;
  } else {
    diffuseColor.rgb *= 0.94 + 0.12 * dNoise(vWPos * vec3(1.3, 2.0, 1.3));
  }` : ''}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
  {
    float sky = vLight.x;
    float ao = vLight.y;
    float depthK = smoothstep(-920.0, -220.0, vWPos.y);
    float deep = mix(uDeepLight, 1.0, depthK);
    reflectedLight.directDiffuse *= sky * sky * deep * ao;
    reflectedLight.indirectDiffuse *= (0.22 + 0.78 * sky) * ao * mix(0.35, 1.0, depthK);
    // the faint ambient glow of the abyss grows with depth
    float glowK = 1.0 - smoothstep(-700.0, -150.0, vWPos.y);
    reflectedLight.indirectDiffuse += diffuseColor.rgb * uAbyssGlow * (0.35 + glowK) * ao * (0.45 + 0.55 * sky);
    // explorer's lamp
    vec3 lv = uLampPos - vWPos;
    float ld = length(lv);
    float lf = clamp(1.0 - ld / uLampRange, 0.0, 1.0);
    reflectedLight.directDiffuse += diffuseColor.rgb * uLampColor * lf * lf * max(0.2, dot(normal, mat3(viewMatrix) * normalize(lv)));
  }`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    float emi = vLight.z;
    if (abs(flag - 1.0) < 0.5) totalEmissiveRadiance += vec3(1.0, 0.72, 0.4) * uNight * (0.55 + emi * 1.6);
    else if (abs(flag - 2.0) < 0.5) {
      float v = dNoise(vWPos * 0.21) * 0.6 + dNoise(vWPos * 0.6) * 0.4;
      float vein = smoothstep(0.62, 0.7, v) * (1.0 - smoothstep(0.7, 0.78, v));
      totalEmissiveRadiance += vec3(1.0, 0.32, 0.08) * vein * (1.6 + 0.6 * sin(uTime * 0.8 + vWPos.y * 0.2));
    } else if (abs(flag - 3.0) < 0.5) totalEmissiveRadiance += diffuseColor.rgb * (0.5 + 0.25 * sin(uTime * 1.3 + vWPos.x)) * (0.4 + emi);
    else if (abs(flag - 4.0) < 0.5) totalEmissiveRadiance += vec3(0.25, 0.9, 0.8) * 0.35 * smoothstep(0.6, 0.9, dNoise(vWPos * 2.0));
    else if (emi > 0.01) totalEmissiveRadiance += diffuseColor.rgb * emi * 1.4;
  }`);
}

export function makeTerrainMaterial(hexScale) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.userData.hexScale = { value: hexScale };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, { uHexScale: m.userData.hexScale });
    patchCommonVertex(shader, false);
    patchCommonFragment(shader, { terrain: true });
  };
  m.customProgramCacheKey = () => 'terrain';
  return m;
}

export function makeFoliageMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, { uHexScale: { value: 1 } });
    patchCommonVertex(shader, true);
    patchCommonFragment(shader, { terrain: false });
    // thin leaves and blades: light both sides as if facing their stored normal
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
#ifdef DOUBLE_SIDED
  normal *= faceDirection;
#endif`);
  };
  m.customProgramCacheKey = () => 'foliage';
  return m;
}

const FOG_GLSL = /* glsl */`
uniform vec3 uFogColor;
uniform float uFogDensity;
vec3 applyFog(vec3 c, float dist) {
  float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  return mix(c, uFogColor, clamp(f, 0.0, 1.0));
}`;

export function makeWaterMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: shared,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */`
attribute vec3 color;
attribute vec4 aLight;
varying vec3 vWPos;
varying vec2 vFlow;
varying float vDepth;
varying float vKind;
varying float vEdge;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vFlow = color.rg * 2.0 - 1.0;
  vDepth = color.b;
  vKind = aLight.y * 3.0;
  vEdge = aLight.z;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    fragmentShader: /* glsl */`
uniform float uTime;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uCamPos;
uniform float uDeepLight;
varying vec3 vWPos;
varying vec2 vFlow;
varying float vDepth;
varying float vKind;
varying float vEdge;
${FOG_GLSL}
float wHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
float wNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  bool river = vKind > 0.5 && vKind < 1.5;
  vec2 flow = river ? vFlow * 1.6 : vec2(0.08, 0.05);
  vec2 p = vWPos.xz * 0.45;
  float t = uTime;
  float n1 = wNoise(p * 1.3 - flow * t * 1.2);
  float n2 = wNoise(p * 2.7 + vec2(t * 0.11, -t * 0.07) - flow * t * 2.0);
  vec3 nrm = normalize(vec3((n1 - 0.5) * 0.5 + (n2 - 0.5) * 0.3, 1.0, (n2 - 0.5) * 0.5 - (n1 - 0.5) * 0.3));
  vec3 V = normalize(uCamPos - vWPos);
  float fres = pow(1.0 - max(dot(nrm, V), 0.0), 4.0);
  float depthK = smoothstep(-920.0, -220.0, vWPos.y);
  vec3 shallow = mix(vec3(0.16, 0.42, 0.42), vec3(0.12, 0.35, 0.38), depthK);
  vec3 deepC = vec3(0.02, 0.1, 0.16);
  vec3 col = mix(shallow, deepC, clamp(vDepth * 1.4, 0.0, 1.0));
  float light = mix(uDeepLight + 0.15, 1.0, depthK) * (1.0 - uNight * 0.75);
  col *= light;
  vec3 skyRef = uSkyColor * mix(0.25, 1.0, depthK);
  col = mix(col, skyRef, fres * 0.65);
  vec3 H = normalize(normalize(uSunDir) + V);
  float spec = pow(max(dot(nrm, H), 0.0), 120.0) * depthK * (1.0 - uNight);
  col += uSunColor * spec * 1.4;
  float foam = 0.0;
  if (river) foam = smoothstep(0.62, 0.8, wNoise(p * 3.0 - flow * t * 3.0)) * 0.35;
  foam += vEdge * smoothstep(0.5, 0.9, wNoise(p * 4.0 + t * 0.3)) * 0.35;
  col += vec3(foam) * light;
  float alpha = clamp(0.62 + vDepth * 0.35 + fres * 0.2 + foam, 0.0, 0.95);
  float dist = length(vWPos - uCamPos);
  gl_FragColor = vec4(applyFog(col, dist), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
}

export function makeFallMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: shared,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
attribute vec3 color;
attribute vec4 aLight;
varying vec3 vWPos;
varying vec2 vUv2;
varying float vH;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vUv2 = vec2(color.r, aLight.y);
  vH = color.g;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    fragmentShader: /* glsl */`
uniform float uTime;
uniform float uNight;
uniform vec3 uCamPos;
uniform float uDeepLight;
varying vec3 vWPos;
varying vec2 vUv2;
varying float vH;
${FOG_GLSL}
float fh(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float x = vWPos.x * 1.7 + vWPos.z * 1.3;
  float streak = fh(floor(x * 3.0));
  float v = vWPos.y * 0.35 + uTime * (2.5 + streak * 2.0);
  float s = smoothstep(0.3, 0.9, fract(v * 0.5 + streak)) * 0.6 + 0.4;
  float depthK = smoothstep(-920.0, -220.0, vWPos.y);
  vec3 col = mix(vec3(0.55, 0.7, 0.75), vec3(0.92, 0.97, 1.0), s);
  col *= mix(uDeepLight + 0.25, 1.0, depthK) * (1.0 - uNight * 0.7);
  float a = (0.45 + 0.4 * s) * (1.0 - smoothstep(0.85, 1.0, vUv2.y) * 0.5);
  gl_FragColor = vec4(applyFog(col, length(vWPos - uCamPos)), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
}

/** Material for the large plunge waterfalls into the Eye (uv-mapped ribbons). */
export function makeBigFallMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: shared,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
varying vec3 vWPos;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    fragmentShader: /* glsl */`
uniform float uTime;
uniform float uNight;
uniform vec3 uCamPos;
uniform float uDeepLight;
varying vec3 vWPos;
varying vec2 vUv;
${FOG_GLSL}
float fh(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float col0 = floor(vUv.x * 24.0);
  float sp = fh(col0 * 7.1);
  float v = vUv.y * 40.0 - uTime * (3.0 + sp * 2.5);
  float s = smoothstep(0.2, 0.9, fract(v * 0.3 + sp)) * 0.7 + 0.3;
  float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
  float spread = smoothstep(0.0, 0.08, vUv.y);
  float depthK = smoothstep(-920.0, -220.0, vWPos.y);
  vec3 col = mix(vec3(0.6, 0.72, 0.78), vec3(0.95, 0.98, 1.0), s);
  col *= mix(uDeepLight + 0.3, 1.0, depthK) * (1.0 - uNight * 0.65);
  float fade = 1.0 - smoothstep(0.75, 1.0, vUv.y);
  float a = edge * (0.35 + 0.45 * s) * fade * (0.6 + 0.4 * spread);
  gl_FragColor = vec4(applyFog(col, length(vWPos - uCamPos) * 0.8), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
}
