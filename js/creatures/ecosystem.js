// Ecosystem simulation.
// - The world is divided into 64 m regions per vertical band (surface/Layer 1,
//   each Layer 2 gallery tier, the Stone Plain, the shaft air, Layer 3).
// - Every region the simulation has touched keeps abstract populations per
//   species that grow, compete, prey and migrate whether or not the player is near.
// - Regions near the player are materialised into individual agents with
//   genomes, needs and behaviours (forage, hunt, flee, mate, raise offspring,
//   defend territory, follow hosts, flock, rest by activity cycle, migrate).
// - Interactions are emitted as events so the discovery system can record
//   what the player actually witnessed.
import * as THREE from 'three';
import { RNG, hash32 } from '../core/rng.js';
import { clamp, lerp, wrapAngle } from '../core/mathutil.js';
import { M, isGrassy } from '../world/materials.js';
import { CF } from '../world/column.js';
import { Z_BOWL, Z_CITY, Z_COUNTRY, Z_SEA, Z_EYE } from '../world/field.js';
import { individualGenes, inheritGenes } from './genetics.js';
import { buildSpeciesModel, createCreatureObject } from './creatureMesh.js';
import { animateCreature } from './animation.js';

const RS = 64;              // region size (m)
const ACTIVE_R = 150;       // materialise radius
const DROP_R = 210;         // dematerialise radius
const MAX_AGENTS = 120;
const BANDS = { SURF: 0, G0: 1, G1: 2, G2: 3, PLAIN: 4, FAULT: 5, SHAFT: 6 };

const FOOD_MATS = {
  graze: new Set([M.GRASS, M.MEADOW, M.MOSS, M.LITTER, M.FIELD]),
  mineral: new Set([M.ROCK, M.GRAVEL, M.STONEPLAIN, M.CRYSTAL, M.DARKROCK, M.SHAFTROCK, M.BASALT, M.RUIN, M.RUIN2]),
};

export class Ecosystem {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.plan = game.plan;
    this.species = game.plan.species;
    this.scene = game.renderer.scene;
    this.regions = new Map();   // key -> {key, band, i, j, pops: Float32Array, K: Float32Array, active, init}
    this.agents = [];
    this.carcasses = [];
    this.templates = new Map();
    this.listeners = [];
    this.nextId = 1;
    this.tickTimer = 0;
    this.activationTimer = 0;
    this.thinkIndex = 0;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.stats = { births: 0, deaths: 0, kills: 0 };
    this.sp = this.species.map((s) => this.prepareSpecies(s));
    this._v = new THREE.Vector3();
  }

  on(fn) { this.listeners.push(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  prepareSpecies(s) {
    const size = s.morph.size;
    const social = s.behavior.social;
    let cap = 3 / Math.max(0.4, size);
    if (s.behavior.diet === 'carnivore') cap *= size > 2 ? 0.12 : 0.35;
    if (social === 'herd' || social === 'flock' || social === 'swarm' || social === 'colony') cap *= 2.2;
    if (s.behavior.playerAware) cap = 0.6;
    const bands = [];
    const hab = s.behavior.habitat;
    if (s.layer === 'surface' || s.layer === 'layer1') bands.push(BANDS.SURF);
    if (s.layer === 'layer2') {
      if (hab.includes('ceiling') || hab.includes('forest') || hab.includes('litter') || hab.includes('shrubs') || hab.includes('meadow') || hab.includes('plains')) bands.push(BANDS.G0, BANDS.G1, BANDS.G2);
      if (hab.includes('plain') || hab.includes('rocky') || hab.includes('plains') || hab.includes('caves')) bands.push(BANDS.PLAIN);
      if (hab.includes('cliffs') || hab.includes('air')) bands.push(BANDS.SHAFT, BANDS.PLAIN);
      if (!bands.length) bands.push(BANDS.G0, BANDS.PLAIN);
    }
    if (s.layer === 'layer3') bands.push(BANDS.FAULT);
    return { s, cap: clamp(cap, 0.3, 14), bands, rng: RNG.derive(this.plan.seed, 'eco', s.id) };
  }

  // ------------------------------------------------------------------ regions
  bandAt(y, zone) {
    const p = this.plan.params;
    if (y > -350) return BANDS.SURF;
    if (y < -905) return BANDS.FAULT;
    if (y < p.plainY + 70) return BANDS.PLAIN;
    for (let k = 0; k < p.galleries.length; k++) {
      const g = p.galleries[k];
      if (y < g.yTop + 8 && y > g.yTop - g.height - 25) return BANDS.G0 + k;
    }
    void zone;
    return BANDS.SHAFT;
  }

  regionKey(band, i, j) { return `${band}:${i}:${j}`; }

  getRegion(band, i, j) {
    const key = this.regionKey(band, i, j);
    let r = this.regions.get(key);
    if (!r) {
      r = { key, band, i, j, pops: new Float32Array(this.species.length), K: new Float32Array(this.species.length), active: false, init: false, agents: 0 };
      this.regions.set(key, r);
    }
    return r;
  }

  /** Determine carrying capacities by sampling habitat inside the region. */
  initRegion(r) {
    if (r.init) return;
    r.init = true;
    const rng = RNG.derive(this.plan.seed, 'region', r.band, r.i * 7919 + r.j);
    for (let si = 0; si < this.sp.length; si++) {
      const S = this.sp[si];
      if (!S.bands.includes(r.band)) continue;
      let ok = 0;
      const n = 6;
      for (let k = 0; k < n; k++) {
        const x = (r.i + rng.next()) * RS, z = (r.j + rng.next()) * RS;
        if (this.habitatPoint(S, x, z, r.band)) ok++;
      }
      const suit = ok / n;
      r.K[si] = suit * S.cap;
      r.pops[si] = r.K[si] * rng.range(0.5, 1.0);
    }
  }

  /**
   * Find a valid habitat position for species S at (x, z) in a band.
   * Returns {x, y, z, ceil} or null.
   */
  habitatPoint(S, x, z, band) {
    const s = S.s;
    const W = this.world;
    const info = W.field.polar(x, z, this._P || (this._P = {}));
    const zone = info.zone;
    const hab = s.behavior.habitat;
    const loco = s.behavior.locomotion;
    const c = W.columnAt(x, z);
    const fly = loco === 'fly' || loco === 'glide';
    const p = this.plan.params;
    // pick a floor in the band
    let floor = null, floorMat = 0, ceil = Infinity;
    for (let k = c.n - 1; k >= 0; k--) {
      const top = c.y[(c.off + k) * 2 + 1];
      const above = k + 1 < c.n ? c.y[(c.off + k + 1) * 2] : Infinity;
      if (above - top < 2.5) continue;
      if (this.bandAt(top + 1, zone) !== band && !(band === BANDS.SHAFT && fly)) continue;
      floor = top; floorMat = c.mat[(c.off + k) * 2]; ceil = above;
      break;
    }
    if (band === BANDS.SHAFT) {
      if (!fly) return null;
      if (info.r > info.Re + 5) return null;
      const y = p.lipY - 60 - ((hash32(x | 0, z | 0) % 1000) / 1000) * 400;
      return { x, y, z, air: true };
    }
    if (floor === null) return null;
    if (!Number.isNaN(c.water) && Math.abs(c.water - floor) < 3 && !hab.includes('water')) return null;
    if (s.layer === 'surface' && zone !== Z_CITY && zone !== Z_COUNTRY) return null;
    if (s.layer === 'layer1' && zone !== Z_BOWL) return null;
    if (zone === Z_SEA || zone === Z_EYE && band === BANDS.SURF) return null;
    if (hab.includes('ceiling')) {
      if (!(ceil < Infinity) || ceil - floor < 6) return null;
      return { x, y: ceil, z, ceil: true };
    }
    if (hab.includes('water')) {
      if (Number.isNaN(c.water) && !this.nearWater(x, z)) return null;
    }
    const diet = s.behavior.diet;
    if ((diet === 'grazer' || diet === 'browser') && !FOOD_MATS.graze.has(floorMat)) return null;
    if (diet === 'lithophage' && !FOOD_MATS.mineral.has(floorMat)) return null;
    if (hab.includes('city') && s.layer === 'surface' && (c.flags & (CF.BUILDING | CF.ROUTE | CF.PARK)) === 0 && zone !== Z_CITY) return null;
    if (fly) return { x, y: floor + 6 + ((hash32(x | 0, z | 0, 3) % 100) / 100) * 18, z, air: true, floor };
    return { x, y: floor, z };
  }

  nearWater(x, z) {
    for (let k = 0; k < 6; k++) {
      const a = k * 1.047;
      const c = this.world.columnAt(x + Math.cos(a) * 6, z + Math.sin(a) * 6);
      if (!Number.isNaN(c.water)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ update
  update(dt) {
    const player = this.game.player;
    if (!player) return;
    const t = this.game.gameTime;
    this.tickTimer -= dt;
    if (this.tickTimer <= 0) { this.tickTimer = 5; this.abstractTick(5); }
    this.activationTimer -= dt;
    if (this.activationTimer <= 0) { this.activationTimer = 1.0; this.updateActivation(player.pos); }
    // think a slice of agents each frame (~10 Hz each)
    const n = this.agents.length;
    const slice = Math.max(1, Math.ceil(n / 6));
    for (let k = 0; k < slice && n; k++) {
      this.thinkIndex = (this.thinkIndex + 1) % n;
      const a = this.agents[this.thinkIndex];
      if (a) this.think(a, t);
    }
    const cam = this.game.camera.position;
    for (const a of this.agents) {
      this.move(a, dt, t);
      const d2 = (a.pos.x - cam.x) ** 2 + (a.pos.z - cam.z) ** 2;
      a.obj.mesh.visible = d2 < 260 * 260 && !a.dead;
      if (a.obj.mesh.visible && (d2 < 90 * 90 || ((t * 10) | 0) % 3 === a.id % 3)) animateCreature(a, this.templates.get(a.sp.id), dt, t);
      a.calling = Math.max(0, a.calling - dt);
      a.strike = Math.max(0, (a.strike || 0) - dt);
    }
    // carcasses decay
    for (const c of this.carcasses) c.time -= dt;
    this.carcasses = this.carcasses.filter((c) => c.time > 0 && c.meat > 0);
    // remove dead agents
    if (this.agents.some((a) => a.dead)) {
      for (const a of this.agents) if (a.dead) this.disposeAgent(a);
      this.agents = this.agents.filter((a) => !a.dead);
    }
  }

  /** Abstract population dynamics for all touched regions. */
  abstractTick(dt) {
    const sps = this.species;
    for (const r of this.regions.values()) {
      if (!r.init || r.active) continue;
      for (let si = 0; si < sps.length; si++) {
        const K = r.K[si];
        if (K <= 0) continue;
        let p = r.pops[si];
        const rate = 0.004 / Math.max(0.4, sps[si].morph.size);
        p += rate * p * (1 - p / K) * dt + (p < 0.05 ? 0.002 * dt * K : 0);
        // predation: prey availability feeds predators
        const prey = sps[si].relations.prey;
        if (prey.length) {
          let food = 0;
          for (const q of prey) food += r.pops[q];
          const kill = Math.min(food * 0.4, p * 0.0015 * dt * food / (1 + food));
          for (const q of prey) if (food > 0) r.pops[q] = Math.max(0, r.pops[q] - kill * (r.pops[q] / food));
          p += kill * 0.25 - p * 0.0008 * dt * (food < 0.5 ? 1 : 0);
        }
        r.pops[si] = clamp(p, 0, K * 1.5);
      }
    }
  }

  updateActivation(ppos) {
    const band = this.bandAt(ppos.y, null);
    const bandsNear = new Set([band]);
    // nearby vertical bands are also simulated so creatures above/below stay alive
    for (const dy of [-60, 60, -120, 120]) bandsNear.add(this.bandAt(ppos.y + dy, null));
    if (band !== BANDS.SURF && band !== BANDS.FAULT) bandsNear.add(BANDS.SHAFT);
    const ci = Math.floor(ppos.x / RS), cj = Math.floor(ppos.z / RS);
    const rr = Math.ceil(DROP_R / RS) + 1;
    const want = new Set();
    for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
      const i = ci + di, j = cj + dj;
      const cx = (i + 0.5) * RS, cz = (j + 0.5) * RS;
      const d = Math.hypot(cx - ppos.x, cz - ppos.z);
      for (const b of bandsNear) {
        const key = this.regionKey(b, i, j);
        if (d < ACTIVE_R) want.add(key);
        else if (d < DROP_R) { const r = this.regions.get(key); if (r && r.active) want.add(key); }
      }
    }
    // deactivate regions no longer wanted, and free their agents right away
    for (const r of this.regions.values()) if (r.active && !want.has(r.key)) this.deactivate(r);
    if (this.agents.some((a) => a.dead)) {
      for (const a of this.agents) if (a.dead) this.disposeAgent(a);
      this.agents = this.agents.filter((a) => !a.dead);
    }
    // activate new ones (nearest first)
    const list = [...want].map((k) => { const [b, i, j] = k.split(':').map(Number); return { b, i, j, d: Math.hypot((i + 0.5) * RS - ppos.x, (j + 0.5) * RS - ppos.z) }; }).sort((a, b) => a.d - b.d);
    for (const it of list) {
      const r = this.getRegion(it.b, it.i, it.j);
      if (r.active) continue;
      if (this.agents.length >= MAX_AGENTS) break;
      this.activate(r);
    }
  }

  activate(r) {
    this.initRegion(r);
    r.active = true;
    const rng = RNG.derive(this.plan.seed, 'spawn', r.band, r.i * 7919 + r.j, Math.floor(this.game.gameTime / 600));
    for (let si = 0; si < this.sp.length; si++) {
      const S = this.sp[si];
      let count = Math.round(r.pops[si] + rng.range(-0.3, 0.3));
      // the lone hunters of the Fault: one per suitable region
      if (S.s.behavior.playerAware) count = r.pops[si] > 0.15 ? 1 : 0;
      if (count <= 0) continue;
      const room = MAX_AGENTS - this.agents.length;
      count = Math.min(count, room, 14);
      if (count <= 0) break;
      // groups spawn around a centre
      let cx = (r.i + rng.next()) * RS, cz = (r.j + rng.next()) * RS;
      const groupId = this.nextId++;
      let made = 0;
      for (let tries = 0; made < count && tries < count * 8; tries++) {
        const spread = S.s.behavior.groupSize[1] > 2 ? 10 : RS * 0.5;
        const x = cx + rng.range(-spread, spread), z = cz + rng.range(-spread, spread);
        const hp = this.habitatPoint(S, x, z, r.band);
        if (!hp) { if (tries % 4 === 3) { cx = (r.i + rng.next()) * RS; cz = (r.j + rng.next()) * RS; } continue; }
        const genes = individualGenes(S.s, rng);
        const a = this.spawnAgent(S, genes, hp, r, groupId, rng.range(0.6, 1.4));
        if (rng.chance(0.18) && made > 0) { a.age = rng.range(0.25, 0.7); a.juvenile = true; }
        made++;
      }
      r.agents += made;
    }
  }

  deactivate(r) {
    r.active = false;
    const counts = new Float32Array(this.species.length);
    for (const a of this.agents) {
      if (a.region !== r.key || a.dead) continue;
      counts[a.sp.id] += a.juvenile ? 0.5 : 1;
      a.dead = true;
      a.despawned = true;
    }
    for (let si = 0; si < counts.length; si++) if (r.K[si] > 0 || counts[si] > 0) r.pops[si] = counts[si];
  }

  template(sp) {
    let t = this.templates.get(sp.id);
    if (!t) { t = buildSpeciesModel(sp); this.templates.set(sp.id, t); }
    return t;
  }

  spawnAgent(S, genes, hp, region, groupId, ageFactor = 1) {
    const sp = S.s;
    const tpl = this.template(sp);
    const obj = createCreatureObject(tpl, sp, genes);
    const a = {
      id: this.nextId++, sp, S, genes, obj,
      pos: new THREE.Vector3(hp.x, hp.y, hp.z), vel: new THREE.Vector3(), heading: Math.random() * Math.PI * 2,
      state: 'wander', target: null, timer: 0, energy: 0.6 + Math.random() * 0.3, age: ageFactor, juvenile: false,
      sex: genes.sex, groupId, region: region.key, band: region.band, home: new THREE.Vector3(hp.x, hp.y, hp.z),
      repro: Math.random() * 60, airborne: !!hp.air, ceil: !!hp.ceil, seed: Math.random() * 10, calling: 0,
      animSpeed: 0, look: 0, flyAlt: hp.air ? hp.y - (hp.floor ?? hp.y - 10) : 0, lastCall: 0,
    };
    a.scale = sp.morph.size * genes.size;
    obj.mesh.scale.setScalar(a.scale * (a.juvenile ? 0.5 : 1));
    this.group.add(obj.mesh);
    this.agents.push(a);
    return a;
  }

  disposeAgent(a) {
    this.group.remove(a.obj.mesh);
    a.obj.mesh.material.dispose();
    a.obj.mesh.skeleton.dispose();
  }

  // ------------------------------------------------------------------ AI
  activeNow(sp) {
    const tod = this.game.timeOfDay;
    const deep = this.game.player.pos.y < -350;
    const day = tod > 6.5 && tod < 18.5;
    const twilight = (tod > 5 && tod < 8) || (tod > 17 && tod < 20);
    switch (sp.behavior.activity) {
      case 'nocturnal': return !day || (deep && Math.random() < 0.3);
      case 'crepuscular': return twilight || deep;
      case 'cathemeral': return true;
      default: return day || deep;
    }
  }

  nearest(a, filter, radius) {
    let best = null, bd = radius * radius;
    for (const b of this.agents) {
      if (b === a || b.dead || !filter(b)) continue;
      const d = (b.pos.x - a.pos.x) ** 2 + (b.pos.z - a.pos.z) ** 2 + ((b.pos.y - a.pos.y) * 0.5) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  think(a, t) {
    if (a.dead) return;
    const sp = a.sp, beh = sp.behavior, rel = sp.relations;
    const dtThink = Math.min(1, t - (a.lastThink || t));
    a.lastThink = t;
    // metabolism & growth
    a.energy = clamp(a.energy - dtThink * 0.004 * (a.state === 'flee' || a.state === 'hunt' ? 3 : 1), 0, 1);
    a.repro = Math.max(0, a.repro - dtThink);
    if (a.juvenile) {
      a.age += dtThink / beh.reproduction.maturity;
      a.obj.mesh.scale.setScalar(a.scale * (0.45 + 0.55 * Math.min(1, a.age)));
      if (a.age >= 1) { a.juvenile = false; a.obj.bones.forEach((b) => b.scale.set(1, 1, 1)); a.parent = null; }
    }
    if (a.energy <= 0.0 && Math.random() < 0.05) { this.killAgent(a, null, 'starved'); return; }
    a.timer -= dtThink;
    const perc = beh.perception;
    // the Layer 3 stalker hunts the explorer
    if (beh.playerAware) { this.thinkStalker(a, t); return; }
    // 1. danger
    if (rel.predators.length) {
      const th = this.nearest(a, (b) => rel.predators.includes(b.sp.id) && !b.juvenile, perc * (0.5 + beh.fearfulness * 0.6));
      if (th && (th.state === 'hunt' || Math.random() < beh.fearfulness)) {
        if (a.state !== 'flee') { this.call(a, 'alarm'); this.emit('flee', { a, from: th }); }
        a.state = 'flee'; a.target = th; a.timer = 4;
        // alarm spreads through the group
        for (const g of this.agents) if (g.groupId === a.groupId && g !== a && g.state !== 'flee' && g.pos.distanceTo(a.pos) < 25) { g.state = 'flee'; g.target = th; g.timer = 4; }
        return;
      }
    }
    if (a.state === 'flee' && a.timer > 0) return;
    // ongoing courtship displays and feeding are not interrupted by routine decisions
    if ((a.state === 'court' || a.state === 'eat') && a.timer > 0) return;
    // offspring follow a parent
    if (a.juvenile && a.parent && !a.parent.dead && beh.reproduction.care !== 'none') {
      a.state = 'follow'; a.target = a.parent;
      return;
    }
    const active = this.activeNow(sp);
    if (!active && a.state !== 'sleep' && !a.airborne) {
      a.state = 'sleep'; a.timer = 30 + Math.random() * 40;
      this.emit('sleep', { a });
      return;
    }
    if (a.state === 'sleep' && (a.timer > 0 || !active)) return;
    // 2. hunger
    if (a.energy < 0.55) {
      if (beh.diet === 'carnivore' && rel.prey.length) {
        const prey = this.nearest(a, (b) => rel.prey.includes(b.sp.id), perc);
        if (prey) {
          if (a.state !== 'hunt') { this.emit('hunt', { a, prey }); this.call(a, 'hunt'); }
          a.state = 'hunt'; a.target = prey; a.timer = 12;
          return;
        }
        const car = this.carcasses.find((c) => c.pos.distanceTo(a.pos) < perc * 1.5);
        if (car) { a.state = 'goto-carcass'; a.target = car; a.timer = 15; return; }
      } else if (beh.diet === 'scavenger') {
        const car = this.carcasses.find((c) => c.pos.distanceTo(a.pos) < 160);
        if (car) { a.state = 'goto-carcass'; a.target = car; a.timer = 25; return; }
      } else if (beh.diet === 'insectivore' || beh.diet === 'omnivore') {
        const prey = rel.prey.length ? this.nearest(a, (b) => rel.prey.includes(b.sp.id), perc * 0.6) : null;
        if (prey && Math.random() < 0.5) { a.state = 'hunt'; a.target = prey; a.timer = 6; this.emit('hunt', { a, prey }); return; }
      }
      if (a.state !== 'forage') {
        const spot = this.findFood(a);
        if (spot) { a.state = 'forage'; a.target = spot; a.timer = 14; return; }
      }
    }
    // 3. reproduction
    if (!a.juvenile && a.energy > 0.6 && a.repro <= 0) {
      const reg = this.regions.get(a.region);
      const crowd = this.agents.filter((b) => b.sp === sp && !b.dead).length;
      const K = reg ? Math.max(2, reg.K[sp.id] * 2.5) : 4;
      if (crowd < K + 2) {
        const mate = this.nearest(a, (b) => b.sp === sp && b.sex !== a.sex && !b.juvenile && b.repro <= 0 && b.energy > 0.5, perc * 1.5);
        if (mate) {
          a.state = 'court'; a.target = mate; a.timer = 10;
          mate.state = 'court'; mate.target = a; mate.timer = 10;
          this.emit('court', { a, b: mate });
          this.call(a, 'mate');
          return;
        }
      }
    }
    // 4. territory
    if (beh.territoriality > 0.5 && !a.juvenile && t - (a.lastTerritory || -99) > 20) {
      const rival = this.nearest(a, (b) => (b.sp === sp && b.groupId !== a.groupId && !b.juvenile) || rel.competitors.includes(b.sp.id), 14 + beh.territoriality * 16);
      if (rival && a.state !== 'chase') {
        a.state = 'chase'; a.target = rival; a.timer = 5; a.lastTerritory = t;
        if (rival.state !== 'flee') { rival.state = 'flee'; rival.target = a; rival.timer = 4; }
        this.emit('territorial', { a, b: rival });
        this.call(a, 'threat');
        return;
      }
    }
    if (a.state === 'chase' && a.timer > 0) return;
    // 5. symbiosis: stay near a host
    if (rel.symbiontOf !== null && rel.symbiontOf !== undefined) {
      const host = this.nearest(a, (b) => b.sp.id === rel.symbiontOf, 60);
      if (host) {
        if (a.state !== 'symbiosis' && t - (a.lastSym || -99) > 60) { a.lastSym = t; this.emit('symbiosis', { a, host }); }
        a.state = 'symbiosis'; a.target = host; a.timer = 8;
        a.energy = Math.min(1, a.energy + 0.02);
        return;
      }
    }
    // 6. drink now and then
    if (a.timer <= 0 && Math.random() < 0.08 && !a.airborne && !a.ceil) {
      const w = this.findWater(a);
      if (w) { a.state = 'drink'; a.target = w; a.timer = 10; return; }
    }
    // 7. social cohesion / wandering / migration
    if (a.timer <= 0) {
      const r = Math.random();
      if (beh.social !== 'solitary' && r < 0.5) {
        const mate = this.nearest(a, (b) => b.groupId === a.groupId, 60);
        if (mate) { a.state = 'flock'; a.target = mate; a.timer = 5 + Math.random() * 5; return; }
      }
      if (r < 0.12 && (a.airborne || beh.social === 'herd')) {
        // migration: shift the home range across the region grid
        const ang = Math.random() * Math.PI * 2;
        const dist = 60 + Math.random() * 80;
        const hp = this.habitatPoint(a.S, a.home.x + Math.cos(ang) * dist, a.home.z + Math.sin(ang) * dist, a.band);
        if (hp) {
          a.home.set(hp.x, hp.y, hp.z);
          for (const g of this.agents) if (g.groupId === a.groupId) g.home.copy(a.home);
          this.emit('migrate', { a });
        }
      }
      a.state = Math.random() < 0.25 ? 'idle' : 'wander';
      a.timer = 3 + Math.random() * 6;
      if (a.state === 'wander') {
        const ang = Math.random() * Math.PI * 2, d = 6 + Math.random() * 22;
        a.target = { pos: new THREE.Vector3(a.home.x + Math.cos(ang) * d, a.home.y, a.home.z + Math.sin(ang) * d) };
      }
      if (Math.random() < 0.15 && t - a.lastCall > sp.call.interval) this.call(a, 'idle');
    }
  }

  thinkStalker(a, t) {
    const p = this.game.player;
    const d = a.pos.distanceTo(p.pos);
    const inFault = p.pos.y < -880;
    const lamp = this.game.lamp && this.game.lamp.on && this.game.lamp.power > 0.6;
    if (a.state === 'retreat' && a.timer > 0) return;
    if (!inFault || d > 160 || p.mode === 'dead') { if (a.state !== 'wander') { a.state = 'wander'; a.timer = 4; } return; }
    if (lamp && d < 14 && a.state !== 'retreat') {
      a.state = 'retreat'; a.timer = 12; a.target = null; this.emit('flee', { a, from: { sp: { id: -1 }, pos: p.pos } }); this.call(a, 'alarm');
      return;
    }
    if (a.state !== 'stalk' && a.state !== 'charge') { a.state = 'stalk'; a.stalkTime = 0; this.emit('stalk-player', { a }); this.call(a, 'threat'); }
    if (a.state === 'stalk') {
      a.stalkTime += 0.1;
      if (d < 7 || a.stalkTime > 25 + (a.seed % 10)) { a.state = 'charge'; a.timer = 6; this.call(a, 'hunt'); this.emit('charge-player', { a }); }
    }
  }

  findFood(a) {
    const beh = a.sp.behavior;
    const W = this.world;
    for (let k = 0; k < 6; k++) {
      const ang = Math.random() * Math.PI * 2, d = 4 + Math.random() * 20;
      const x = a.pos.x + Math.cos(ang) * d, z = a.pos.z + Math.sin(ang) * d;
      if (a.airborne) {
        const fy = W.floorBelow(x, a.pos.y, z);
        if (fy === -Infinity) continue;
        const mat = W.floorMaterial(x, fy, z);
        if (beh.diet === 'piscivore') { const c = W.columnAt(x, z); if (!Number.isNaN(c.water)) return { pos: new THREE.Vector3(x, c.water, z), kind: 'fish' }; continue; }
        if (beh.diet === 'nectar' && !isGrassy(mat)) continue;
        return { pos: new THREE.Vector3(x, fy + 0.6, z), kind: beh.diet === 'nectar' ? 'flowers' : 'insects' };
      }
      if (a.ceil) return { pos: new THREE.Vector3(x, a.pos.y, z), kind: 'insects' };
      const fy = W.floorBelow(x, a.pos.y + 2, z);
      if (Math.abs(fy - a.pos.y) > 3) continue;
      const mat = W.floorMaterial(x, fy, z);
      if ((beh.diet === 'grazer' || beh.diet === 'browser' || beh.diet === 'omnivore' || beh.diet === 'detritivore') && FOOD_MATS.graze.has(mat)) return { pos: new THREE.Vector3(x, fy, z), kind: mat === M.LITTER || mat === M.MOSS ? 'moss' : 'grass' };
      if (beh.diet === 'lithophage' && FOOD_MATS.mineral.has(mat)) return { pos: new THREE.Vector3(x, fy, z), kind: mat === M.CRYSTAL ? 'crystal' : 'minerals' };
      if (beh.diet === 'piscivore') { const c = W.columnAt(x, z); if (!Number.isNaN(c.water)) return { pos: new THREE.Vector3(x, fy, z), kind: 'fish' }; }
    }
    return null;
  }

  findWater(a) {
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2, d = 10 + Math.random() * 25;
      const x = a.pos.x + Math.cos(ang) * d, z = a.pos.z + Math.sin(ang) * d;
      const c = this.world.columnAt(x, z);
      if (!Number.isNaN(c.water) && Math.abs(c.water - a.pos.y) < 4) return { pos: new THREE.Vector3(x, c.water, z), kind: 'water' };
    }
    return null;
  }

  call(a, kind) {
    a.calling = 0.6;
    a.lastCall = this.game.gameTime;
    this.emit('call', { a, kind });
  }

  killAgent(a, by, cause) {
    if (a.dead) return;
    a.dead = true;
    this.stats.deaths++;
    if (cause !== 'starved' || Math.random() < 0.5) this.carcasses.push({ pos: a.pos.clone(), sp: a.sp, meat: a.scale * 2, time: 240 });
    if (by) { this.stats.kills++; this.emit('kill', { a: by, prey: a }); }
    else this.emit('death', { a, cause });
  }

  birth(mother, father) {
    const sp = mother.sp;
    const n = sp.behavior.reproduction.litter;
    const rng = new RNG((Math.random() * 4294967296) >>> 0);
    for (let i = 0; i < n; i++) {
      if (this.agents.length >= MAX_AGENTS + 10) break;
      const genes = inheritGenes(sp, mother.genes, father.genes, rng);
      const hp = { x: mother.pos.x + rng.range(-1, 1), y: mother.pos.y, z: mother.pos.z + rng.range(-1, 1), air: mother.airborne, ceil: mother.ceil };
      const region = this.regions.get(mother.region) || { key: mother.region, band: mother.band };
      const baby = this.spawnAgent(mother.S, genes, hp, region, mother.groupId, 0.05);
      baby.juvenile = true;
      baby.age = 0.05;
      baby.parent = mother;
      baby.home.copy(mother.home);
      baby.obj.mesh.scale.setScalar(baby.scale * 0.45);
      this.stats.births++;
      this.emit('birth', { a: mother, baby, father });
    }
    mother.repro = sp.behavior.reproduction.cooldown;
    father.repro = sp.behavior.reproduction.cooldown * 0.5;
    mother.energy -= 0.25;
  }

  // ------------------------------------------------------------------ movement
  move(a, dt, t) {
    if (a.dead) return;
    const sp = a.sp, beh = sp.behavior;
    const W = this.world;
    let tx = null, tz = null, ty = null;
    let speed = 0;
    const tgt = a.target;
    const tpos = tgt ? (tgt.pos || tgt) : null;
    switch (a.state) {
      case 'flee': {
        if (tpos) { const dx = a.pos.x - tpos.x, dz = a.pos.z - tpos.z; const l = Math.hypot(dx, dz) || 1; tx = a.pos.x + dx / l * 10; tz = a.pos.z + dz / l * 10; }
        speed = beh.speed.run;
        a.timer -= dt;
        break;
      }
      case 'hunt': {
        if (!tgt || tgt.dead) { a.state = 'idle'; a.timer = 2; break; }
        tx = tpos.x; tz = tpos.z; ty = tpos.y;
        speed = beh.speed.run * 1.05;
        const d = a.pos.distanceTo(tpos);
        if (d < 0.6 + a.scale * 0.6) {
          a.strike = 0.4;
          const strength = a.scale * (1 + beh.aggression);
          if (Math.random() < 0.55 * strength / (strength + tgt.scale)) {
            this.killAgent(tgt, a, 'predation');
            a.state = 'eat'; a.timer = 8; a.energy = Math.min(1, a.energy + 0.5);
            a.target = this.carcasses[this.carcasses.length - 1];
          } else if (tgt.state !== 'flee') { tgt.state = 'flee'; tgt.target = a; tgt.timer = 4; }
        }
        a.timer -= dt;
        if (a.timer <= 0) { a.state = 'idle'; a.timer = 3; }
        break;
      }
      case 'goto-carcass': {
        if (!tgt || tgt.meat <= 0) { a.state = 'idle'; a.timer = 2; break; }
        tx = tpos.x; tz = tpos.z; ty = tpos.y;
        speed = a.airborne ? beh.speed.walk : beh.speed.walk * 1.3;
        if (Math.hypot(a.pos.x - tpos.x, a.pos.z - tpos.z) < 1.2 + a.scale * 0.5) { a.state = 'eat'; a.timer = 8; this.emit('scavenge', { a, carcass: tgt }); }
        break;
      }
      case 'eat': {
        if (tgt && tgt.meat !== undefined) { tgt.meat -= dt * 0.1 * a.scale; }
        a.energy = Math.min(1, a.energy + dt * 0.05);
        a.timer -= dt;
        if (a.timer <= 0) { a.state = 'idle'; a.timer = 2; }
        break;
      }
      case 'forage': {
        if (!tpos) { a.state = 'idle'; break; }
        tx = tpos.x; tz = tpos.z; ty = tpos.y;
        speed = beh.speed.walk * 0.7;
        const d = Math.hypot(a.pos.x - tpos.x, a.pos.z - tpos.z);
        if (d < 1.2 + a.scale * 0.3) {
          speed = 0;
          a.grazing = true;
          a.energy = Math.min(1, a.energy + dt * 0.04);
          if (!a.forageEmitted) { a.forageEmitted = true; this.emit('forage', { a, kind: tgt.kind }); }
          a.timer -= dt;
          if (a.timer <= 0 || a.energy > 0.95) { a.state = 'idle'; a.timer = 2; a.grazing = false; a.forageEmitted = false; }
        } else a.grazing = false;
        break;
      }
      case 'drink': {
        if (!tpos) { a.state = 'idle'; break; }
        tx = tpos.x; tz = tpos.z;
        speed = beh.speed.walk * 0.8;
        if (Math.hypot(a.pos.x - tpos.x, a.pos.z - tpos.z) < 3) {
          speed = 0; a.grazing = true;
          if (!a.drinkEmitted) { a.drinkEmitted = true; this.emit('drink', { a }); }
          a.timer -= dt;
          if (a.timer <= 0) { a.state = 'idle'; a.timer = 2; a.grazing = false; a.drinkEmitted = false; }
        }
        break;
      }
      case 'court': {
        if (!tgt || tgt.dead) { a.state = 'idle'; break; }
        // circling display
        const ang = t * 1.2 + a.seed;
        tx = tpos.x + Math.cos(ang) * (1.5 + a.scale); tz = tpos.z + Math.sin(ang) * (1.5 + a.scale);
        speed = beh.speed.walk;
        a.timer -= dt;
        if (a.timer <= 0) {
          const female = a.sex === 'f' ? a : tgt.sex === 'f' ? tgt : null;
          const male = female === a ? tgt : a;
          if (female && !female.dead && female.repro <= 0 && female.pos.distanceTo(male.pos) < 8 + a.scale * 2) this.birth(female, male);
          // a failed or finished courtship is not repeated straight away
          for (const x of [a, tgt]) if (x.repro <= 0) x.repro = 30 + Math.random() * 40;
          a.state = 'idle'; a.timer = 4;
          if (tgt.state === 'court') { tgt.state = 'idle'; tgt.timer = 4; }
        }
        break;
      }
      case 'chase': {
        if (!tgt || tgt.dead) { a.state = 'idle'; break; }
        tx = tpos.x; tz = tpos.z; speed = beh.speed.run * 0.8;
        a.timer -= dt;
        if (a.timer <= 0) { a.state = 'idle'; a.timer = 3; }
        break;
      }
      case 'follow': case 'flock': case 'symbiosis': {
        if (!tgt || tgt.dead) { a.state = 'idle'; a.timer = 1; break; }
        const d = a.pos.distanceTo(tpos);
        const keep = a.state === 'symbiosis' ? 1.5 + tgt.scale * 0.7 : a.state === 'follow' ? 1.5 + tgt.scale : 3 + a.scale * 2;
        if (d > keep) { tx = tpos.x; tz = tpos.z; ty = tpos.y + (a.state === 'symbiosis' && a.airborne ? tgt.scale * 1.2 : 0); speed = Math.min(beh.speed.run, (tgt.animSpeed || beh.speed.walk) * 1.15 + d * 0.15); }
        if (a.state !== 'follow') { a.timer -= dt; if (a.timer <= 0) { a.state = 'idle'; a.timer = 2; } }
        break;
      }
      case 'wander': {
        if (tpos) { tx = tpos.x; tz = tpos.z; speed = beh.speed.walk * 0.6; if (Math.hypot(a.pos.x - tpos.x, a.pos.z - tpos.z) < 1.5) { a.state = 'idle'; a.timer = 2 + Math.random() * 4; } }
        break;
      }
      case 'stalk': {
        const p = this.game.player.pos;
        const d = a.pos.distanceTo(p);
        const ang = Math.atan2(a.pos.z - p.z, a.pos.x - p.x) + 0.02;
        tx = p.x + Math.cos(ang) * 16; tz = p.z + Math.sin(ang) * 16;
        speed = d > 18 ? beh.speed.run * 0.7 : beh.speed.walk * 0.6;
        a.look = 0;
        break;
      }
      case 'charge': {
        const pl = this.game.player;
        tx = pl.pos.x; tz = pl.pos.z; ty = pl.pos.y;
        speed = beh.speed.run * 1.25;
        a.timer -= dt;
        if (a.pos.distanceTo(pl.pos) < 1.6 + a.scale * 0.4) {
          pl.hurt(16, 'creature');
          const dx = pl.pos.x - a.pos.x, dz = pl.pos.z - a.pos.z; const l = Math.hypot(dx, dz) || 1;
          pl.vel.x += dx / l * 9; pl.vel.z += dz / l * 9; pl.vel.y += 4;
          a.strike = 0.4;
          a.state = 'retreat'; a.timer = 30; this.emit('attack-player', { a });
        }
        if (a.timer <= 0) { a.state = 'retreat'; a.timer = 20; }
        break;
      }
      case 'retreat': {
        const p = this.game.player.pos;
        const dx = a.pos.x - p.x, dz = a.pos.z - p.z; const l = Math.hypot(dx, dz) || 1;
        tx = a.pos.x + dx / l * 10; tz = a.pos.z + dz / l * 10; speed = beh.speed.run * 0.8;
        a.timer -= dt;
        if (a.timer <= 0) { a.state = 'wander'; a.timer = 5; }
        break;
      }
      default: break;
    }
    // steering
    let moveX = 0, moveZ = 0;
    if (tx !== null && speed > 0) {
      const dx = tx - a.pos.x, dz = tz - a.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const desired = Math.atan2(dz, dx);
        const turn = wrapAngle(desired - a.heading);
        const turnRate = 3.5 / Math.max(0.5, Math.sqrt(a.scale));
        a.heading += clamp(turn, -turnRate * dt, turnRate * dt);
        const align = Math.max(0, Math.cos(turn));
        const sp2 = speed * (0.35 + 0.65 * align);
        moveX = Math.cos(a.heading) * sp2; moveZ = Math.sin(a.heading) * sp2;
      }
    }
    // keep within reach of home (stay in the habitat)
    const fromHome = Math.hypot(a.pos.x - a.home.x, a.pos.z - a.home.z);
    if (fromHome > 90 && a.state !== 'flee' && a.state !== 'hunt' && a.state !== 'stalk' && a.state !== 'charge') {
      a.state = 'wander'; a.target = { pos: a.home.clone() }; a.timer = 8;
    }
    const nx = a.pos.x + moveX * dt, nz = a.pos.z + moveZ * dt;
    let moved = Math.hypot(moveX, moveZ);
    // vertical placement by locomotion
    if (a.airborne) {
      const floor = W.floorBelow(nx, a.pos.y, nz);
      let alt = a.state === 'forage' || a.state === 'eat' || a.state === 'goto-carcass' ? 0.6 : a.flyAlt || 8;
      if (a.state === 'idle' || a.state === 'sleep') alt = 0.05; // perched
      const groundY = floor === -Infinity ? a.pos.y - 20 : floor;
      let targetY = ty !== null && (a.state === 'hunt' || a.state === 'symbiosis') ? ty + 0.5 : groundY + alt;
      if (a.band === BANDS.SHAFT) targetY = clamp(a.home.y + Math.sin(t * 0.2 + a.seed) * 15, groundY + 4, a.home.y + 40);
      const ceil = W.ceilingAbove(nx, a.pos.y + 0.5, nz);
      if (targetY > ceil - 2) targetY = ceil - 2;
      const ok = !W.isSolid(nx, a.pos.y, nz);
      if (ok) { a.pos.x = nx; a.pos.z = nz; } else { a.heading += Math.PI * 0.6; moved = 0; }
      a.pos.y += clamp(targetY - a.pos.y, -6 * dt, 4 * dt);
      a.gliding = sp.behavior.locomotion === 'glide' || (moved > 0 && a.pos.y > targetY + 1);
      a.perched = alt < 0.1 && Math.abs(a.pos.y - targetY) < 0.3;
    } else if (a.ceil) {
      const c = W.ceilingAbove(nx, a.pos.y - 1.5, nz);
      if (c < Infinity && Math.abs(c - a.pos.y) < 2.5) { a.pos.x = nx; a.pos.z = nz; a.pos.y = c; } else { a.heading += Math.PI * 0.7; moved = 0; }
    } else {
      const fy = W.floorBelow(nx, a.pos.y + 1.2, nz);
      const dy = fy - a.pos.y;
      const water = W.columnAt(nx, nz).water;
      const wet = !Number.isNaN(water) && water > fy + 0.6 && !sp.behavior.habitat.includes('water');
      if (fy > -Infinity && dy > -2.6 && dy < 1.25 && !wet && W.ceilingAbove(nx, fy + 0.2, nz) - fy > Math.min(2.2, a.scale * 0.8 + 0.4)) {
        a.pos.x = nx; a.pos.z = nz; a.pos.y = lerp(a.pos.y, fy, Math.min(1, dt * 12));
      } else {
        a.heading += Math.PI * (0.5 + Math.random() * 0.5);
        moved = 0;
        if (a.state === 'wander') { a.state = 'idle'; a.timer = 1; }
      }
    }
    a.animSpeed = lerp(a.animSpeed, moved, Math.min(1, dt * 6));
    // separation from others of the group
    // orientation & placement of the visual
    const mesh = a.obj.mesh;
    mesh.position.copy(a.pos);
    if (a.ceil) { mesh.rotation.set(0, -a.heading + Math.PI / 2, Math.PI); }
    else {
      mesh.rotation.set(0, -a.heading + Math.PI / 2, 0);
      if (a.airborne && !a.perched) mesh.rotation.x = -clamp((a.vel.y || 0) * 0.05, -0.3, 0.3);
    }
    a.vel.set(moveX, 0, moveZ);
    // head looks at the target
    if (tpos) { const ang = Math.atan2(tpos.z - a.pos.z, tpos.x - a.pos.x); a.look = clamp(wrapAngle(ang - a.heading), -0.8, 0.8); }
    else a.look *= 0.95;
  }

  // ------------------------------------------------------------------ queries & persistence
  agentsNear(pos, r) { return this.agents.filter((a) => !a.dead && a.pos.distanceTo(pos) < r); }

  serialize() {
    const regions = [];
    for (const r of this.regions.values()) {
      if (!r.init) continue;
      if (r.active) {
        const counts = new Float32Array(this.species.length);
        for (const a of this.agents) if (a.region === r.key && !a.dead) counts[a.sp.id] += a.juvenile ? 0.5 : 1;
        regions.push([r.key, Array.from(counts).map((v) => Math.round(v * 100) / 100)]);
      } else regions.push([r.key, Array.from(r.pops).map((v) => Math.round(v * 100) / 100)]);
    }
    return { regions, stats: this.stats };
  }

  restore(data) {
    if (!data) return;
    for (const [key, pops] of data.regions || []) {
      const [b, i, j] = key.split(':').map(Number);
      const r = this.getRegion(b, i, j);
      this.initRegion(r);
      pops.forEach((v, k) => { if (k < r.pops.length) r.pops[k] = v; });
    }
    if (data.stats) this.stats = { ...this.stats, ...data.stats };
  }
}
