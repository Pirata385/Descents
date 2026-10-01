// TerrainField: continuous macro-scale shape functions of the world.
// The world is an island with a central Abyss: rim city on a plateau, the
// Layer 1 bowl curving down to the Abyss Eye, the vertical shaft with Layer 2
// galleries, the bell chamber with the Stone Plain and the Layer 3 fault.
// All shapes are evaluated in a domain-warped polar frame so outlines are organic.
import { Simplex, fbm2, ridged2, angularNoise } from '../core/noise.js';
import { hash32 } from '../core/rng.js';
import { clamp, clamp01, smoothstep, terrace, TAU } from '../core/mathutil.js';
import { M } from './materials.js';

export const Z_EYE = 0;
export const Z_BOWL = 1;
export const Z_CITY = 2;
export const Z_COUNTRY = 3;
export const Z_SEA = 4;
export const ZONE_NAMES = ['Abyss Eye', 'Bowl', 'City', 'Countryside', 'Coast'];

const TAB = 1024;

export class TerrainField {
  constructor(params) {
    this.p = params;
    const s = params.seed;
    this.nWarp = new Simplex(hash32(s, 11));
    this.nShape = new Simplex(hash32(s, 12));
    this.nHill = new Simplex(hash32(s, 13));
    this.nDetail = new Simplex(hash32(s, 14));
    this.nRidge = new Simplex(hash32(s, 15));
    this.nTerr = new Simplex(hash32(s, 16));
    this.nRav = new Simplex(hash32(s, 17));
    this.nBiome = new Simplex(hash32(s, 18));
    this.nGal = new Simplex(hash32(s, 19));
    this.nPlain = new Simplex(hash32(s, 20));

    // Angular lookup tables for radii
    this.eyeTab = new Float32Array(TAB + 1);
    this.rimTab = new Float32Array(TAB + 1);
    this.coastTab = new Float32Array(TAB + 1);
    this.cityTab = new Float32Array(TAB + 1);
    this.cliffTab = new Float32Array(TAB + 1);
    this.bellTab = new Float32Array(TAB + 1);
    this.faultTab = new Float32Array(TAB + 1);
    this.galTabs = params.galleries.map(() => new Float32Array(TAB + 1));
    const n = this.nShape;
    for (let i = 0; i <= TAB; i++) {
      const th = (i / TAB) * TAU - Math.PI;
      this.eyeTab[i] = params.eyeR * (1 + 0.065 * angularNoise(n, th, 1.3, 0) + 0.03 * angularNoise(n, th, 4.1, 3));
      this.rimTab[i] = params.rimR * (1 + 0.06 * angularNoise(n, th, 1.6, 7) + 0.03 * angularNoise(n, th, 3.7, 11) + 0.012 * angularNoise(n, th, 9.5, 53));
      let coast = params.coastR * (1 + 0.045 * angularNoise(n, th, 2.1, 13) + 0.03 * angularNoise(n, th, 4.6, 17) + 0.014 * angularNoise(n, th, 11.0, 59) + 0.006 * angularNoise(n, th, 27.0, 61));
      // keep the island inside the world rectangle
      const maxZ = (params.worldHalfZ - 70) / Math.max(0.2, Math.abs(Math.sin(th)));
      const maxX = (params.worldHalfX - 70) / Math.max(0.2, Math.abs(Math.cos(th)));
      coast = Math.min(coast, maxZ, maxX);
      this.coastTab[i] = coast;
      this.cityTab[i] = params.cityDepth * (1 + 0.18 * angularNoise(n, th, 2.4, 19));
      this.cliffTab[i] = 7 + 5 * (0.5 + 0.5 * angularNoise(n, th, 7.0, 23));
      this.bellTab[i] = params.bellR * (1 + 0.08 * angularNoise(n, th, 2.2, 29) + 0.04 * angularNoise(n, th, 6.5, 31));
      this.faultTab[i] = params.fault.r * (1 + 0.12 * angularNoise(n, th, 1.9, 37) + 0.06 * angularNoise(n, th, 5.7, 41));
      params.galleries.forEach((g, k) => {
        const v = angularNoise(this.nGal, th, 2.6, 43 + k * 7) * 0.75 + angularNoise(this.nGal, th, 9.0, 47 + k * 5) * 0.35;
        const open = v + g.open;
        // negative => no gallery (solid wall pillar) at this angle
        this.galTabs[k][i] = open <= 0 ? -1 : g.depthMin + (g.depthMax - g.depthMin) * clamp01(open * 1.6);
      });
    }
  }

  tab(t, th) {
    const f = ((th + Math.PI) / TAU) * TAB;
    const i = Math.floor(f);
    const a = f - i;
    const i0 = ((i % TAB) + TAB) % TAB;
    return t[i0] + (t[i0 + 1] - t[i0]) * a;
  }

  warpX(x, z) { return x + this.nWarp.noise2(x / 380, z / 380) * this.p.warpAmp + this.nWarp.noise2(x / 95 + 7, z / 95) * this.p.warpAmp * 0.18; }
  warpZ(x, z) { return z + this.nWarp.noise2(x / 380 + 31.4, z / 380 - 17.7) * this.p.warpAmp + this.nWarp.noise2(x / 95, z / 95 - 7) * this.p.warpAmp * 0.18; }

  /** Inverse of the warp by fixed-point iteration: world position whose warped position is (wx, wz). */
  unwarp(wx, wz) {
    let x = wx, z = wz;
    for (let i = 0; i < 8; i++) {
      x = wx - (this.warpX(x, z) - x);
      z = wz - (this.warpZ(x, z) - z);
    }
    return [x, z];
  }

  /** World position from warped polar coordinates. */
  fromPolar(r, th) { return this.unwarp(Math.cos(th) * r, Math.sin(th) * r); }

  /** Compute warped polar coordinates and the angular radii. */
  polar(x, z, P) {
    const wx = this.warpX(x, z), wz = this.warpZ(x, z);
    const r = Math.sqrt(wx * wx + wz * wz);
    const th = Math.atan2(wz, wx);
    P.x = x; P.z = z; P.wx = wx; P.wz = wz; P.r = r; P.th = th;
    P.Re = this.tab(this.eyeTab, th);
    P.Rr = this.tab(this.rimTab, th);
    P.Rc = this.tab(this.coastTab, th);
    P.Rcity = P.Rr + this.tab(this.cityTab, th);
    P.Rb = this.tab(this.bellTab, th);
    if (r < P.Re) P.zone = Z_EYE;
    else if (r < P.Rr) P.zone = Z_BOWL;
    else if (r < P.Rcity) P.zone = Z_CITY;
    else if (r < P.Rc - 12) P.zone = Z_COUNTRY;
    else P.zone = Z_SEA;
    return P;
  }

  /** Bowl (Layer 1) height. */
  bowlHeight(x, z, P, tOverride) {
    const p = this.p;
    const t = tOverride !== undefined ? tOverride : clamp((P.r - P.Re) / (P.Rr - P.Re), 0, 1);
    const prof = 1 - Math.pow(1 - t, 1.7);
    let h = p.lipY + (p.bowlTopY - p.lipY) * prof;
    const away = smoothstep(0.02, 0.3, t);
    const nearRim = 1 - smoothstep(0.88, 0.99, t);
    h += fbm2(this.nHill, x / 330, z / 330, 4) * p.hillAmp * away * (0.4 + 0.6 * nearRim);
    // terraces form large plains separated by cliffs
    const tmask = smoothstep(-0.3, 0.25, this.nTerr.noise2(x / 520, z / 520)) * smoothstep(0.1, 0.22, t) * nearRim;
    if (tmask > 0.001) {
      const st = p.terraceStep;
      const phase = this.nTerr.noise2(x / 140 + 5.3, z / 140 - 2.1) * 0.3 * st;
      const ht = terrace(h + phase, st, p.terraceSharp) - phase;
      h += (ht - h) * tmask;
    }
    // winding ravines
    const ravMask = smoothstep(0.05, 0.35, this.nRav.noise2(x / 650 + 20, z / 650 - 13));
    if (ravMask > 0) {
      const rv = this.nRav.noise2(P.wx / 330, P.wz / 330);
      const rav = 1 - smoothstep(0.0, 0.06, Math.abs(rv));
      if (rav > 0) h -= rav * ravMask * p.ravineDepth * smoothstep(0.14, 0.32, t) * (1 - smoothstep(0.8, 0.94, t));
    }
    // rock outcrops
    const om = smoothstep(0.05, 0.45, this.nBiome.noise2(x / 380 + 9.1, z / 380 - 4.4));
    if (om > 0) {
      const rg = ridged2(this.nRidge, x / 105, z / 105, 3);
      const o = Math.max(0, rg - 0.68) / 0.32;
      h += o * o * p.outcropAmp * om * away;
    }
    // near the eye the terrain breaks into spires and steepens
    if (t < 0.16) {
      const e = 1 - t / 0.16;
      const sp = Math.max(0, ridged2(this.nRidge, x / 34 + 3, z / 34 - 7, 2) - 0.58) / 0.42;
      h += sp * sp * 32 * e;
      h -= e * e * 10;
    }
    h += this.nDetail.noise2(x / 21, z / 21) * 1.4 * away + this.nDetail.noise2(x / 6.5, z / 6.5) * 0.45;
    return h;
  }

  /** Plateau (city, countryside, coast) height at distance d outside the rim. */
  plateauHeight(x, z, P, d) {
    const p = this.p;
    const dc = P.Rc - P.Rr;
    const ridgeD = Math.max(80, Math.min(p.ridgeOffset, dc - 60));
    let h;
    if (d < ridgeD) h = p.cityY + (p.ridgeY - p.cityY) * smoothstep(0.2, 1.0, d / ridgeD);
    else h = p.ridgeY + (p.seaY + 8 - p.ridgeY) * smoothstep(ridgeD, dc + 5, d);
    const cityD = P.Rcity - P.Rr;
    const cityness = 1 - smoothstep(cityD * 0.75, cityD + 40, d);
    const amp = 2.5 + 15 * (1 - cityness);
    h += fbm2(this.nHill, x / 260 + 11, z / 260, 4) * amp;
    h += this.nDetail.noise2(x / 19, z / 19) * (0.5 + 1.0 * (1 - cityness));
    // shallow vales that gather rain into streams crossing the plateau
    const vm = smoothstep(-0.1, 0.3, this.nRav.noise2(x / 520 - 40, z / 520 + 22));
    if (vm > 0) {
      const vn = this.nRav.noise2(P.wx / 420 + 70, P.wz / 420 - 30);
      const vale = 1 - smoothstep(0.0, 0.14, Math.abs(vn));
      h -= vale * vm * (4 + 6 * (1 - cityness)) * smoothstep(8, 40, d);
    }
    // coast
    const dco = P.r - P.Rc;
    if (dco > -60) {
      const cliffy = this.nBiome.noise2(x / 210, z / 210);
      const w = cliffy > 0.15 ? 7 : 42;
      const seabed = p.seaY - 3 - Math.max(0, dco) * 0.3;
      const f = smoothstep(-w, w * 0.15, dco);
      h = h + (Math.max(seabed, p.seaY - 30) - h) * f;
    }
    return h;
  }

  /**
   * Natural surface (before rivers, lakes and structures). Writes out.h, out.mat.
   * Returns false inside the Abyss Eye (no surface).
   */
  surface(x, z, P, out) {
    const p = this.p;
    if (P.zone === Z_EYE) { out.h = NaN; out.mat = M.AIR; return false; }
    const d = P.r - P.Rr;
    const cliffW = this.tab(this.cliffTab, P.th);
    let h;
    if (d < 0) {
      h = this.bowlHeight(x, z, P);
    } else {
      const dr = d + this.nDetail.noise2(x / 9, z / 9) * 2.2;
      if (dr < cliffW) {
        const hb = this.bowlHeight(x, z, P, 1);
        const hp = this.plateauHeight(x, z, P, cliffW);
        const s = clamp01(dr / cliffW);
        h = hb + (hp - hb) * (s * s * (3 - 2 * s));
      } else {
        h = this.plateauHeight(x, z, P, d);
      }
    }
    out.h = h;
    out.mat = this.surfaceMaterial(x, z, P, h, d);
    return true;
  }

  surfaceMaterial(x, z, P, h, d) {
    const p = this.p;
    const b = this.nBiome.noise2(x / 160 - 3, z / 160 + 8);
    if (P.zone === Z_BOWL) {
      const t = (P.r - P.Re) / (P.Rr - P.Re);
      if (t < 0.07) return M.ROCK;
      if (t < 0.13) return b > 0.1 ? M.GRAVEL : M.ROCK;
      const om = this.nBiome.noise2(x / 380 + 9.1, z / 380 - 4.4);
      if (om > 0.35 && ridged2(this.nRidge, x / 105, z / 105, 2) > 0.74) return M.ROCK;
      return b > 0.18 ? M.MEADOW : M.GRASS;
    }
    if (P.zone === Z_SEA || P.r > P.Rc - 30) {
      if (h < p.seaY + 2.5) return M.SAND;
      return b > 0.4 ? M.MEADOW : M.GRASS;
    }
    if (P.zone === Z_COUNTRY) return b > 0.25 ? M.MEADOW : M.GRASS;
    return M.GRASS;
  }

  /** Stone plain floor (bottom of Layer 2) */
  plainFloor(x, z, P) {
    const p = this.p;
    let h = p.plainY + fbm2(this.nPlain, x / 140, z / 140, 3) * 2.2 + this.nPlain.noise2(x / 13, z / 13) * 0.35;
    // rocky bands
    const rg = ridged2(this.nPlain, x / 60 + 4, z / 60 - 2, 2);
    h += Math.max(0, rg - 0.82) * 14;
    // rises toward the edge of the bell chamber
    if (P.r > P.Re) {
      const u = clamp01((P.r - P.Re) / (P.Rb - P.Re));
      h += smoothstep(0.65, 1.0, u) * 18;
    }
    return h;
  }

  /** Ceiling of the bell chamber at radius r (only valid for Re < r < Rb). */
  bellCeiling(P) {
    const u = clamp01((P.r - P.Re) / (P.Rb - P.Re));
    return this.p.plainY + this.p.bellH * Math.sqrt(Math.max(0, 1 - u * u)) * (1 - 0.15 * u);
  }

  /** Fault polar: distance from fault centre (warped). */
  faultPolar(x, z, out) {
    const f = this.p.fault;
    const dx = x - f.x + this.nWarp.noise2(x / 70 + 50, z / 70) * 9;
    const dz = z - f.z + this.nWarp.noise2(x / 70, z / 70 + 50) * 9;
    out.fr = Math.sqrt(dx * dx + dz * dz);
    out.fth = Math.atan2(dz, dx);
    out.Rf = this.tab(this.faultTab, out.fth);
    return out;
  }

  /** Gallery depth into the wall for tier k at angle th, or -1 if closed. */
  galleryDepth(k, th) { return this.tab(this.galTabs[k], th); }

  /** Moisture-ish biome value used by vegetation. */
  biome(x, z) { return this.nBiome.noise2(x / 160 - 3, z / 160 + 8); }
}
