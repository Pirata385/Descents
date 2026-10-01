// Scene, camera, lighting, atmosphere and large-scale effects. The atmosphere
// blends toward the identity of the layer the player is in (fog, ambient,
// sun tint, abyss glow) and follows a day/night cycle. Shadows follow the player.
import * as THREE from 'three';
import { shared, makeBigFallMaterial } from './materials.js';
import { Sky } from './sky.js';
import { LAYERS } from '../world/layers.js';
import { clamp, lerp, smoothstep } from '../core/mathutil.js';

const tmpC = new THREE.Color();

export class GameRenderer {
  constructor(canvas, plan, settings) {
    this.plan = plan;
    this.settings = settings;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.antialias !== false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio || 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = settings.shadows !== false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.fov || 75, 1, 0.08, 9000);
    this.scene.add(this.camera);
    this.scene.fog = new THREE.FogExp2(0x9ab0c0, 0.0015);

    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    this.sun.castShadow = settings.shadows !== false;
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 600;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6a5a40, 2.3);
    this.scene.add(this.hemi);

    this.sky = new Sky(this.scene, plan.params);
    this.env = this.defaultEnv();
    this.target = this.defaultEnv();
    this.time = 0;
    this.buildFalls();
    this.buildShafts();
    this.buildWindmills();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  defaultEnv() {
    return {
      fog: new THREE.Color(0.66, 0.78, 0.9), fogDensity: 0.0012,
      hemiSky: new THREE.Color(0.75, 0.82, 0.95), hemiGround: new THREE.Color(0.42, 0.36, 0.28), hemiI: 2.3,
      sunI: 2.4, sunColor: new THREE.Color(1, 0.95, 0.86),
      glow: new THREE.Color(0.05, 0.1, 0.1),
      zenith: new THREE.Color(0.25, 0.45, 0.8), horizon: new THREE.Color(0.7, 0.8, 0.9), sun: new THREE.Color(1, 0.9, 0.7), skyDim: 1,
      exposure: 1.05,
    };
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Large plunge waterfalls into the Eye and from gallery mouths. */
  buildFalls() {
    this.falls = new THREE.Group();
    const mat = makeBigFallMaterial();
    for (const wf of this.plan.waterfalls) {
      const H = wf.topY - wf.bottomY;
      if (!(H > 5)) continue;
      const segs = Math.max(8, Math.min(80, Math.ceil(H / 8)));
      const pos = [], uv = [], idx = [];
      const w = wf.width;
      const px = -wf.dirZ, pz = wf.dirX; // perpendicular
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const drop = t * H;
        // projectile arc for the first metres, then straight down with slight spreading
        const out = Math.min(6, Math.sqrt(drop) * 1.4);
        const spread = 1 + t * 0.8;
        const cx = wf.x + wf.dirX * out, cz = wf.z + wf.dirZ * out, cy = wf.topY - drop;
        pos.push(cx - px * w * 0.5 * spread, cy, cz - pz * w * 0.5 * spread);
        pos.push(cx + px * w * 0.5 * spread, cy, cz + pz * w * 0.5 * spread);
        uv.push(0, t, 1, t);
        if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = 4;
      m.userData.wf = wf;
      this.falls.add(m);
    }
    this.scene.add(this.falls);
  }

  /** Volumetric-looking light shafts falling into the Eye. */
  buildShafts() {
    this.shafts = new THREE.Group();
    const p = this.plan.params;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime, uI: { value: 0.5 }, uCol: { value: new THREE.Color(1, 0.95, 0.8) } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      vertexShader: /* glsl */`varying vec2 vUv; varying float vY; void main(){ vUv = uv; vec4 wp = modelMatrix * vec4(position,1.0); vY = wp.y; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */`uniform float uTime; uniform float uI; uniform vec3 uCol; varying vec2 vUv; varying float vY;
float h(float n){return fract(sin(n)*43758.5453);}
void main(){ float edge = smoothstep(0.0,0.35,vUv.x)*smoothstep(1.0,0.65,vUv.x);
  float fall = smoothstep(0.0,0.15,vUv.y)*(1.0-smoothstep(0.55,1.0,vUv.y));
  float flick = 0.75 + 0.25*sin(uTime*0.3 + vUv.x*6.0);
  float dust = 0.85 + 0.15*h(floor(vUv.y*80.0)+floor(vUv.x*20.0)*13.0);
  gl_FragColor = vec4(uCol * edge * fall * flick * dust * uI * 0.12, 1.0); }`,
    });
    this.shaftMat = mat;
    const rng = (i) => (Math.sin(i * 91.7 + p.seed % 1000) * 43758.5453) % 1;
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(rng(i)) * Math.PI * 2, r = Math.abs(rng(i + 30)) * p.eyeR * 0.75;
      const w = 30 + Math.abs(rng(i + 60)) * 60;
      const top = p.lipY + 120, bottom = p.plainY;
      const g = new THREE.PlaneGeometry(w, top - bottom, 1, 1);
      const m = new THREE.Mesh(g, mat);
      m.position.set(Math.cos(a) * r, (top + bottom) / 2, Math.sin(a) * r);
      m.userData.tilt = (Math.abs(rng(i + 90)) - 0.5) * 0.25;
      m.renderOrder = 5;
      this.shafts.add(m);
    }
    this.scene.add(this.shafts);
  }

  buildWindmills() {
    this.windmills = new THREE.Group();
    const bladeMat = new THREE.MeshLambertMaterial({ color: 0xe8e0d0, side: THREE.DoubleSide });
    const woodMat = new THREE.MeshLambertMaterial({ color: 0x6b5038 });
    for (const w of this.plan.city.windmills) {
      const hub = new THREE.Group();
      hub.position.set(w.x + Math.cos(w.face) * 2.6, w.y, w.z + Math.sin(w.face) * 2.6);
      hub.rotation.y = -w.face + Math.PI / 2;
      const rotor = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.25, 7.5, 0.15), woodMat);
        arm.position.y = 3.75;
        const sail = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 6), bladeMat);
        sail.position.set(0.9, 4.3, 0.05);
        const blade = new THREE.Group();
        blade.add(arm, sail);
        blade.rotation.z = (k * Math.PI) / 2;
        rotor.add(blade);
      }
      hub.add(rotor);
      hub.userData = { rotor, speed: w.speed };
      for (const m of rotor.children) m.children.forEach((c) => { c.castShadow = true; });
      this.windmills.add(hub);
    }
    this.scene.add(this.windmills);
  }

  /**
   * Compute the atmosphere target for the player's situation.
   * ctx: { layer, zone, y, enclosed (0..1), timeOfDay (0..24) }
   */
  computeTarget(ctx) {
    const t = this.target;
    const L = LAYERS[clamp(ctx.layer, 0, 3)];
    const v = L.visuals;
    // day/night factor
    const tod = ctx.timeOfDay;
    const sunElev = Math.sin(((tod - 6) / 12) * Math.PI);
    const day = smoothstep(-0.12, 0.25, sunElev);
    const night = 1 - day;
    const dusk = Math.max(0, 1 - Math.abs(sunElev) * 4) * 0.8;
    shared.uNight.value = night;
    // depth factor: deeper = less direct sunlight and denser fog
    const depthK = smoothstep(-40, -900, ctx.y);
    t.fog.setRGB(...v.fogColor);
    if (dusk > 0.05) t.fog.lerp(tmpC.setRGB(0.85, 0.55, 0.4), dusk * 0.35 * (1 - depthK));
    t.fog.multiplyScalar(lerp(1, 0.18, night * (1 - depthK * 0.6)));
    t.fogDensity = v.fogDensity * (1 + ctx.enclosed * 0.8);
    t.hemiSky.setRGB(...v.ambient).multiplyScalar(lerp(1, 0.22, night * (1 - depthK * 0.5)));
    t.hemiGround.setRGB(v.ambient[0] * 0.5, v.ambient[1] * 0.45, v.ambient[2] * 0.4).multiplyScalar(lerp(1, 0.25, night));
    t.hemiI = lerp(2.3, 2.0, depthK);
    t.sunColor.setRGB(...v.sun);
    if (dusk > 0.05) t.sunColor.lerp(tmpC.setRGB(1, 0.6, 0.35), dusk * 0.6);
    t.sunI = 3.1 * day * lerp(1, 0.55, depthK) + 0.35 * night;
    const glowBase = ctx.layer >= 3 ? [0.16, 0.05, 0.03] : ctx.layer === 2 ? [0.05, 0.14, 0.12] : [0.04, 0.07, 0.07];
    t.glow.setRGB(...glowBase);
    // sky palette
    t.zenith.setRGB(0.22, 0.42, 0.78).lerp(tmpC.setRGB(0.02, 0.03, 0.08), night);
    t.horizon.setRGB(0.7, 0.8, 0.9).lerp(tmpC.setRGB(0.95, 0.6, 0.45), dusk).lerp(tmpC.setRGB(0.05, 0.07, 0.12), night);
    t.sun.setRGB(1, 0.9, 0.7).lerp(tmpC.setRGB(1, 0.5, 0.3), dusk);
    t.skyDim = lerp(1, 0.75, depthK);
    t.exposure = lerp(1.05, 1.35, depthK) + night * 0.25;
    return { sunElev, day, night };
  }

  /** Per-frame update of lights, atmosphere and effects. */
  update(dt, playerPos, ctx) {
    this.time += dt;
    shared.uTime.value = this.time;
    const st = this.computeTarget(ctx);
    const k = 1 - Math.exp(-dt * 1.5);
    const e = this.env, t = this.target;
    e.fog.lerp(t.fog, k); e.fogDensity = lerp(e.fogDensity, t.fogDensity, k);
    e.hemiSky.lerp(t.hemiSky, k); e.hemiGround.lerp(t.hemiGround, k); e.hemiI = lerp(e.hemiI, t.hemiI, k);
    e.sunColor.lerp(t.sunColor, k); e.sunI = lerp(e.sunI, t.sunI, k);
    e.glow.lerp(t.glow, k);
    e.zenith.lerp(t.zenith, k); e.horizon.lerp(t.horizon, k); e.sun.lerp(t.sun, k); e.skyDim = lerp(e.skyDim, t.skyDim, k);
    e.exposure = lerp(e.exposure, t.exposure, k);
    // apply
    this.scene.fog.color.copy(e.fog);
    this.scene.fog.density = e.fogDensity;
    shared.uFogColor.value.copy(e.fog);
    shared.uFogDensity.value = e.fogDensity;
    this.hemi.color.copy(e.hemiSky); this.hemi.groundColor.copy(e.hemiGround); this.hemi.intensity = e.hemiI;
    this.sun.color.copy(e.sunColor); this.sun.intensity = e.sunI;
    shared.uAbyssGlow.value.copy(e.glow);
    shared.uSunColor.value.copy(e.sunColor);
    shared.uSkyColor.value.copy(e.horizon).lerp(e.zenith, 0.4);
    shared.uCamPos.value.copy(this.camera.position);
    this.renderer.toneMappingExposure = e.exposure;
    // sun direction from time of day
    const tod = ctx.timeOfDay;
    const ang = ((tod - 6) / 12) * Math.PI;
    const elev = Math.max(-0.35, Math.sin(ang)) ;
    const az = 0.6 + ang;
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(Math.asin(clamp(elev, -1, 1))), Math.max(0.08, elev), Math.sin(az) * 0.55);
    if (st.night > 0.5) dir.set(-dir.x, Math.max(0.3, -Math.sin(ang)), -dir.z); // moonlight
    dir.normalize();
    shared.uSunDir.value.copy(dir);
    this.sun.position.copy(playerPos).addScaledVector(dir, 250);
    this.sun.target.position.copy(playerPos);
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sky.update(this.camera.position, e);
    // light shafts face the camera around the vertical axis
    const shaftI = st.day * (1 - smoothstep(0.6, 1.0, ctx.enclosed));
    this.shaftMat.uniforms.uI.value = shaftI;
    for (const m of this.shafts.children) {
      m.rotation.y = Math.atan2(this.camera.position.x - m.position.x, this.camera.position.z - m.position.z);
      m.rotation.z = m.userData.tilt;
    }
    this.shafts.visible = shaftI > 0.02;
    for (const w of this.windmills.children) w.userData.rotor.rotation.z += dt * w.userData.speed;
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
