// Habitats: where each species can live and how positions are found and kept
// valid while moving.
// - ground: top surfaces of the band the species belongs to (city, bowl, galleries, plain)
// - shore: ground near water
// - ceiling: the underside of gallery ceilings (upside down)
// - cave: the Layer 3 cave network, walked as a graph of passage nodes
// - wall: the walls of the Great Fault, as (angle, height) coordinates on the rock face
// - air: open air (the chasm, the shaft of the Eye, the sky over the bowl and city)
import * as THREE from 'three';
import { Z_BOWL, Z_CITY, Z_COUNTRY, Z_EYE } from '../world/field.js';
import { CF } from '../world/column.js';
import { M, isGrassy } from '../world/materials.js';

export const BAND = { SURF: 0, G0: 1, G1: 2, G2: 3, PLAIN: 4, SHAFT: 5, CAVE3: 6, CHASM: 7, BASIN: 8 };

const MINERAL = new Set([M.ROCK, M.GRAVEL, M.STONEPLAIN, M.CRYSTAL, M.DARKROCK, M.SHAFTROCK, M.BASALT, M.RUIN, M.RUIN2, M.FAULTROCK, M.DEEPSTONE]);
const LICHEN = new Set([M.LICHEN, M.FUNGUS, M.MOSS]);

/** Cave graph of the Layer 3 network: passage nodes joined by links and at shared halls. */
export class CaveGraph {
  constructor(plan) {
    this.nodes = [];  // {x, y (floor), z, r, adj: [], cave}
    const key = (x, y, z) => `${Math.round(x)}:${Math.round(y)}:${Math.round(z)}`;
    const index = new Map();
    const add = (n, cave) => {
      const fy = n.y - n.r * 0.55;
      const k = key(n.x, fy, n.z);
      let id = index.get(k);
      if (id === undefined) { id = this.nodes.length; index.set(k, id); this.nodes.push({ x: n.x, y: fy, z: n.z, r: n.r, adj: [], cave: cave.id, kind: cave.kind }); }
      return id;
    };
    for (const c of plan.caves || []) {
      if (c.layer !== 3 || !c.nodes || c.kind === 'hall') continue;
      const ids = c.nodes.map((n) => add(n, c));
      for (let i = 0; i < ids.length - 1; i++) {
        const a = ids[i], b = ids[i + 1];
        if (a === b) continue;
        this.nodes[a].adj.push(b); this.nodes[b].adj.push(a);
      }
    }
    // spatial grid for nearest-node lookups
    this.cell = 24;
    this.grid = new Map();
    this.nodes.forEach((n, i) => {
      const k = `${Math.floor(n.x / this.cell)}:${Math.floor(n.z / this.cell)}`;
      let l = this.grid.get(k); if (!l) this.grid.set(k, (l = [])); l.push(i);
    });
  }

  near(x, y, z, r, dy = 40) {
    const out = [];
    const c = this.cell, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const l = this.grid.get(`${i}:${j}`);
      if (!l) continue;
      for (const id of l) { const n = this.nodes[id]; if (Math.abs(n.y - y) < dy && (n.x - x) ** 2 + (n.z - z) ** 2 < r * r) out.push(id); }
    }
    return out;
  }

  nearest(x, y, z, r = 30) {
    let best = -1, bd = Infinity;
    for (const id of this.near(x, y, z, r, 30)) {
      const n = this.nodes[id];
      const d = (n.x - x) ** 2 + ((n.y - y) * 2) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }
}

export class Habitats {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.plan = game.plan;
    this.p = game.plan.params;
    this.chasm = game.world.gen.chasm;
    this.caves = new CaveGraph(game.plan);
    this.fault = game.plan.fault || {};
    this._P = {};
  }

  /** Region band of a position (abstract populations live per band). */
  bandAt(x, y, z) {
    const p = this.p;
    if (y > -350) return BAND.SURF;
    if (y < p.chasm.floorY + 25) return BAND.BASIN;
    if (y < p.plainY - 8) {
      // inside the chasm or the rock around it
      return this.chasm.clearance(x, y, z) < 0 ? BAND.CHASM : BAND.CAVE3;
    }
    if (y < p.plainY + 70) return BAND.PLAIN;
    for (let k = 0; k < p.galleries.length; k++) {
      const g = p.galleries[k];
      if (y < g.yTop + 8 && y > g.yTop - g.height - 25) return BAND.G0 + k;
    }
    return BAND.SHAFT;
  }

  /** Which bands a species can live in. */
  bandsFor(sp) {
    const h = sp.behavior.habitat;
    switch (sp.layer) {
      case 'surface': case 'layer1': return [BAND.SURF];
      case 'layer2': {
        if (h === 'air') return [BAND.SHAFT, BAND.G0, BAND.G1, BAND.G2];
        if (h === 'ceiling') return [BAND.G0, BAND.G1, BAND.G2];
        if (sp.behavior.diet === 'lithophage') return [BAND.PLAIN, BAND.G2];
        return [BAND.G0, BAND.G1, BAND.G2, BAND.PLAIN];
      }
      case 'layer3': return h === 'cave' ? [BAND.CAVE3] : [BAND.CHASM, BAND.BASIN];
      default: return [];
    }
  }

  /** Food at a ground position for a diet. */
  foodAt(sp, mat) {
    const d = sp.behavior.diet;
    if (d === 'grazer' || d === 'browser') return isGrassy(mat);
    if (d === 'lithophage') return MINERAL.has(mat);
    if (d === 'lichen') return LICHEN.has(mat);
    return true;
  }

  /** A floor in the column near y with headroom h (or null). */
  floorNear(x, y, z, range, h = 2) {
    const c = this.world.columnAt(x, z);
    let best = null, bd = Infinity, mat = 0, ceil = Infinity;
    for (let s = 0; s < c.n; s++) {
      const top = c.y[(c.off + s) * 2 + 1];
      const above = s + 1 < c.n ? c.y[(c.off + s + 1) * 2] : Infinity;
      if (above - top < h) continue;
      const d = Math.abs(top - y);
      if (d < range && d < bd) { bd = d; best = top; mat = c.mat[(c.off + s) * 2]; ceil = above; }
    }
    return best === null ? null : { y: best, mat, ceil, water: c.water, flags: c.flags };
  }

  /**
   * A spawn position for species sp near (cx, cy, cz) within radius.
   * Returns {x, y, z, mode, node?, phi?, site?} or null.
   */
  sample(sp, rng, cx, cy, cz, radius) {
    const h = sp.behavior.habitat;
    for (let tries = 0; tries < 10; tries++) {
      const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * radius;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const r = this.sampleAt(sp, rng, h, x, cy, z, radius);
      if (r) return r;
    }
    return null;
  }

  sampleAt(sp, rng, h, x, cy, z, radius) {
    const W = this.world, p = this.p;
    const bands = this.bandsFor(sp);
    if (h === 'cave') {
      const ids = this.caves.near(x, cy, z, 40, radius * 0.6);
      if (!ids.length) return null;
      const id = rng.pick(ids), n = this.caves.nodes[id];
      const f = this.floorNear(n.x, n.y + 0.5, n.z, 3, 1);
      if (!f) return null;
      return { x: n.x, y: f.y, z: n.z, mode: 'cave', node: id };
    }
    if (h === 'wall') {
      const y = Math.min(p.chasm.yWide - 5, Math.max(p.chasm.floorY + 25, cy + rng.range(-radius, radius) * 0.6));
      const phi = rng.range(-Math.PI, Math.PI);
      const R = this.chasm.wallDist(phi, y);
      if (R <= 0) return null;
      const [ax, az] = this.chasm.centreAt(y);
      const x2 = ax + Math.cos(phi) * (R - 0.25), z2 = az + Math.sin(phi) * (R - 0.25);
      if ((x2 - x) ** 2 + (z2 - z) ** 2 > radius * radius * 4) return null;
      return { x: x2, y, z: z2, mode: 'wall', phi };
    }
    if (h === 'air') {
      if (sp.layer === 'layer3') {
        const y = Math.min(p.chasm.yThroat - 20, Math.max(p.chasm.floorY + 15, cy + rng.range(-radius, radius) * 0.5));
        const phi = rng.range(-Math.PI, Math.PI);
        const R = this.chasm.wallDist(phi, y);
        if (R < 20) return null;
        const [ax, az] = this.chasm.centreAt(y);
        const rr = rng.range(0.15, 0.85) * (R - 10);
        const x2 = ax + Math.cos(phi) * rr, z2 = az + Math.sin(phi) * rr;
        if (this.chasm.clearance(x2, y, z2) > -6) return null;
        return { x: x2, y, z: z2, mode: 'air' };
      }
      const P = W.field.polar(x, z, this._P);
      if (sp.layer === 'layer2') {
        // the air of the Eye's shaft and the galleries
        if (P.r > P.Re - 8) return null;
        const y = Math.max(p.plainY + 20, Math.min(-360, cy + rng.range(-60, 60)));
        if (W.isSolid(x, y, z)) return null;
        return { x, y, z, mode: 'air' };
      }
      if (sp.layer === 'surface' && P.zone !== Z_CITY && P.zone !== Z_COUNTRY) return null;
      if (sp.layer === 'layer1' && P.zone !== Z_BOWL && P.zone !== Z_EYE) return null;
      const f = this.floorNear(x, cy, z, 120, 3);
      if (!f) return null;
      return { x, y: f.y + rng.range(5, 28), z, mode: 'air' };
    }
    // ground-like habitats
    const f = this.floorNear(x, cy, z, 60, h === 'ceiling' ? 6 : Math.max(1.2, sp.size * 0.8));
    if (!f) return null;
    const band = this.bandAt(x, f.y + 0.5, z);
    if (!bands.includes(band)) return null;
    const P = W.field.polar(x, z, this._P);
    if (sp.layer === 'surface' && P.zone !== Z_CITY && P.zone !== Z_COUNTRY) return null;
    if (sp.layer === 'layer1' && P.zone !== Z_BOWL) return null;
    if (!Number.isNaN(f.water) && Math.abs(f.water - f.y) < 3) return null;
    if (f.flags & CF.CAVE && sp.layer !== 'layer3') { if (rng.chance(0.7)) return null; }
    if (h === 'ceiling') {
      if (!(f.ceil < Infinity) || f.ceil - f.y < 6) return null;
      return { x, y: f.ceil, z, mode: 'ceiling' };
    }
    if (h === 'shore') {
      let wet = false;
      for (let k = 0; k < 6 && !wet; k++) { const c = W.columnAt(x + Math.cos(k) * 7, z + Math.sin(k) * 7); if (!Number.isNaN(c.water)) wet = true; }
      if (!wet) return null;
    }
    if (!this.foodAt(sp, f.mat) && rng.chance(0.75)) return null;
    return { x, y: f.y, z, mode: 'ground' };
  }

  /** Nest, roost or den sites for a species near a point (Layer 3 uses the plan's sites). */
  homeSites(sp) {
    const F = this.fault;
    const nest = sp.behavior.nest;
    if (sp.layer !== 'layer3') return null;
    if (sp.behavior.habitat === 'cave') return (F.dens || []).map((d) => ({ x: d.x, y: d.y, z: d.z, kind: 'den' }));
    if (nest === 'roost') return (F.roosts || []).map((r) => ({ x: r.x, y: r.y, z: r.z, kind: 'roost' }));
    if (nest === 'wall') return (F.perches || []).map((r) => ({ x: r.x, y: r.y, z: r.z, kind: 'wall', nx: r.nx, nz: r.nz }));
    return (F.nests || []).map((r) => ({ x: r.x, y: r.y, z: r.z, kind: 'ledge', nx: r.nx, nz: r.nz }));
  }

  /** Point on the chasm wall at (phi, y), slightly in the void, and the wall's outward normal. */
  wallPoint(phi, y, out, nrm) {
    const R = this.chasm.wallDist(phi, y);
    const [ax, az] = this.chasm.centreAt(y);
    out.set(ax + Math.cos(phi) * (R - 0.2), y, az + Math.sin(phi) * (R - 0.2));
    if (nrm) nrm.set(-Math.cos(phi), 0, -Math.sin(phi));
    return R;
  }
}

export const _tmpV = new THREE.Vector3();
