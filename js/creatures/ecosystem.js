// Ecosystem simulation.
// - Abstract populations per species live in 64 m regions per band (the
//   surface, each Layer 2 tier, the plain, the shaft air, the Layer 3 caves,
//   the chasm by depth). They grow, compete, prey and recover whether or not
//   the explorer is near, and keep a small gene pool that drifts as
//   individuals breed.
// - Near the explorer, populations become individuals: each with its own
//   genes (drawn from the regional pool and its subspecies), anatomy, mesh,
//   animation, needs and temperament.
// - Individuals move in their habitat (ground, cave network, chasm walls,
//   open air, ceilings, roosts and nests) and act on decisions from brain.js:
//   flee, hunt and kill, forage, scavenge, sleep at home, court and mate, lay
//   eggs or give birth, raise young, flock, mob predators, defend territory,
//   follow hosts, investigate the explorer.
// - Interactions are emitted as events for discovery, audio and the HUD.
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { clamp, lerp } from '../core/mathutil.js';
import { G, individualGenes, inheritGenes, subspeciesAt } from './genome.js';
import { phenotype, juvenilize } from './anatomy.js';
import { buildCreature } from './bodyMesh.js';
import { Animator } from './motion.js';
import { decide, ACTION_LABEL } from './brain.js';
import { Habitats, BAND } from './habitat.js';
import { Z_CITY } from '../world/field.js';

const RS = 64;              // region size (m)
const ACTIVE_R = 120;       // radius of the creatures' area (it follows the render distance, see areaRadius)
const VIS_R = 150;          // default drawing distance for creatures
const POOL = 6;             // genomes kept per species and region

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _lv = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();

export class Ecosystem {
  constructor(game, opts = {}) {
    this.game = game;
    this.world = game.world;
    this.plan = game.plan;
    this.species = game.plan.species;
    this.scene = game.renderer ? game.renderer.scene : null;
    this.hab = new Habitats(game);
    this.maxAgents = opts.maxAgents ?? (game.settings && game.settings.creatures) ?? 60;
    this.regions = new Map();
    this.agents = [];
    this.carcasses = [];
    this.listeners = [];
    this.nextId = 1;
    this.tickTimer = 0;
    this.activationTimer = 0;
    this.buildQueue = [];
    this.group = new THREE.Group();
    if (this.scene) this.scene.add(this.group);
    this.stats = { births: 0, deaths: 0, kills: 0, spawned: 0, despawned: 0 };
    this.sp = this.species.map((s) => this.prepare(s));
    this.grid = new Map();
    this.groups = new Map();
    this.playerAgent = { id: -1, sp: { id: -1, name: 'explorer', behavior: { diet: 'omnivore' } }, pos: new THREE.Vector3(), dead: false, ph: { scale: 1.8 } };
    this.attractors = [];
    this.hour = 9;
    this.dark = false;
    this.lampOn = false;
  }

  on(fn) { this.listeners.push(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  prepare(s) {
    const size = s.size, B = s.behavior;
    // carrying capacity per region at full suitability
    let cap = 3.2 / Math.max(0.35, size);
    if (B.diet === 'carnivore') cap *= size > 2 ? 0.12 : 0.35;
    if (['herd', 'flock', 'swarm', 'colony'].includes(B.social)) cap *= 2.2;
    if (B.playerAware) cap = 0.5;
    if (s.layer === 'layer3') cap *= B.habitat === 'cave' ? 1.4 : 1.6;
    return { s, cap: clamp(cap, 0.3, 16), bands: this.hab.bandsFor(s), rng: RNG.derive(this.plan.seed, 'eco', s.id) };
  }

  // ------------------------------------------------------------------ regions
  regionKey(band, x, y, z) {
    const i = Math.floor(x / RS), j = Math.floor(z / RS);
    const slice = band === BAND.CAVE3 || band === BAND.CHASM ? Math.floor((this.plan.params.plainY - y) / 160) : 0;
    return `${band}:${i}:${j}:${slice}`;
  }

  /**
   * The region for a key, created on first use. Surveying its habitat (for the
   * background population model) is skipped when `deadline` has passed and done
   * on a later call.
   */
  region(key, x, y, z, band, deadline = Infinity) {
    let r = this.regions.get(key);
    if (r && r.init) return r;
    if (!r) {
      r = { key, band, x: (Math.floor(x / RS) + 0.5) * RS, y, z: (Math.floor(z / RS) + 0.5) * RS, pops: new Float32Array(this.species.length), K: new Float32Array(this.species.length), pools: [], init: false, active: false };
      this.regions.set(key, r);
    }
    if (performance.now() <= deadline) this.initRegion(r);
    return r;
  }

  initRegion(r) {
    r.init = true;
    const rng = RNG.derive(this.plan.seed, 'region', r.key);
    for (let si = 0; si < this.sp.length; si++) {
      const S = this.sp[si];
      if (!S.bands.includes(r.band)) continue;
      let ok = 0;
      const n = 5;
      for (let k = 0; k < n; k++) if (this.hab.sample(S.s, rng, r.x, r.y, r.z, RS * 0.7)) ok++;
      r.K[si] = (ok / n) * S.cap;
      r.pops[si] = r.K[si] * rng.range(0.5, 1.0);
    }
  }

  /** Abstract population dynamics for regions away from the explorer. */
  abstractTick(dt) {
    const sps = this.species;
    for (const r of this.regions.values()) {
      if (!r.init || r.active) continue;
      for (let si = 0; si < sps.length; si++) {
        const K = r.K[si];
        if (K <= 0) continue;
        let p = r.pops[si];
        const rate = 0.004 / Math.max(0.35, sps[si].size);
        p += rate * p * (1 - p / K) * dt + (p < 0.05 ? 0.002 * dt * K : 0);
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

  // ------------------------------------------------------------------ queries
  rebuildGrid() {
    this.grid.clear();
    for (const a of this.agents) {
      if (a.dead) continue;
      const k = `${Math.floor(a.pos.x / 16)}:${Math.floor(a.pos.z / 16)}`;
      let l = this.grid.get(k); if (!l) this.grid.set(k, (l = [])); l.push(a);
    }
  }

  agentsNear(pos, r) {
    const out = [];
    const i0 = Math.floor((pos.x - r) / 16), i1 = Math.floor((pos.x + r) / 16), j0 = Math.floor((pos.z - r) / 16), j1 = Math.floor((pos.z + r) / 16);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const l = this.grid.get(`${i}:${j}`);
      if (l) for (const a of l) if (!a.dead && a.pos.distanceToSquared(pos) < r * r) out.push(a);
    }
    return out;
  }

  neighbours(a, r) { return this.agentsNear(a.pos, r).filter((o) => o !== a); }

  carcassNear(pos, r) {
    let best = null, bd = r * r;
    for (const c of this.carcasses) { const d = c.pos.distanceToSquared(pos); if (d < bd && c.meat > 0) { bd = d; best = c; } }
    return best;
  }

  /** Draw curious, non-predatory creatures toward a point for a while (artifact effect). */
  attract(pos, duration = 6) { this.attractors.push({ pos: pos.clone(), t: duration }); }

  // ------------------------------------------------------------------ individuals
  /** Genes for a new individual from a region's pool (inherited) or its subspecies. */
  genesFor(S, r, pos, rng) {
    const sp = S.s;
    const info = { tier: r.band >= BAND.G0 && r.band <= BAND.G2 ? r.band - BAND.G0 : r.band === BAND.PLAIN ? 2 : 0, city: false };
    if (sp.layer === 'surface') { const P = this.world.field.polar(pos.x, pos.z, {}); info.city = P.zone === Z_CITY; }
    const sub = subspeciesAt(sp, pos.x, pos.y, pos.z, info);
    const pool = r.pools[S.s.id] || (r.pools[S.s.id] = []);
    if (pool.length >= 2 && rng.chance(0.7)) {
      const A = rng.pick(pool), B = rng.pick(pool);
      return inheritGenes(sp, A, B, rng);
    }
    // hybrids where two forms meet: occasionally blend with a neighbouring subspecies
    const n = sp.subspecies.length;
    const g = rng.chance(0.12) && n > 1 ? individualGenes(sp, rng, sub, (sub + 1) % n, rng.range(0.2, 0.6)) : individualGenes(sp, rng, sub);
    pool.push(g);
    if (pool.length > POOL) pool.splice(rng.int(0, pool.length - 1), 1);
    return g;
  }

  spawn(S, pos, genes, opts = {}) {
    const sp = S.s;
    const rng = S.rng;
    let ph = phenotype(sp, genes);
    const maturity = sp.behavior.reproduction.maturity;
    const age = opts.age ?? (rng.chance(0.15) ? rng.range(0, maturity * 0.8) : rng.range(maturity, maturity * 4));
    if (age < maturity) ph = juvenilize(ph, Math.max(0.35, age / maturity));
    const ageScale = age < maturity ? 0.45 + 0.55 * (age / maturity) : 1;
    const a = {
      id: this.nextId++, sp, S, genes, ph, sex: genes.sex, sub: genes.sub,
      age, maturity, scale: ph.scale * ageScale, ageScale,
      pos: new THREE.Vector3(pos.x, pos.y, pos.z), vel: new THREE.Vector3(), yaw: rng.range(-Math.PI, Math.PI), pitch: 0, roll: 0,
      up: new THREE.Vector3(0, 1, 0), mode: pos.mode || 'ground', node: pos.node ?? -1, next: -1, lane: rng.range(-0.35, 0.35), phi: pos.phi ?? 0,
      state: 'idle', target: null, timer: rng.range(0, 1.5), thinkT: rng.range(0, 0.8),
      needs: { hunger: rng.range(0.1, 0.6), energy: rng.range(0.5, 1), fear: 0, mate: rng.range(0, 0.5) },
      home: null, group: null, leader: null, parent: opts.parent || null, mate: null, nestEggs: 0, eggT: 0,
      calling: 0, callT: rng.range(2, 15), strike: 0, region: opts.region || null, speed: 0, turn: 0, bank: 0,
      wanderDir: new THREE.Vector3(Math.cos(rng.range(0, 6.28)), 0, Math.sin(rng.range(0, 6.28))),
      obj: null, dead: false, visible: false, anim: null, built: false, flapping: true, lastFloorY: pos.y,
    };
    Object.defineProperty(a, 'juvenile', { get() { return this.age < this.maturity; } });
    Object.defineProperty(a, 'airborne', { get() { return this.mode === 'air'; } });
    Object.defineProperty(a, 'ceil', { get() { return this.mode === 'ceiling' || this.mode === 'hang'; } });
    a.band = this.hab.bandAt(a.pos.x, a.pos.y + 0.5, a.pos.z);
    // home site: nests, roosts and dens for Layer 3 fauna
    const sites = this.hab.homeSites(sp);
    if (sites && sites.length) {
      let best = null, bd = Infinity;
      for (const s of sites) { const d = (s.x - a.pos.x) ** 2 + ((s.y - a.pos.y) * 1.5) ** 2 + (s.z - a.pos.z) ** 2; if (d < bd) { bd = d; best = s; } }
      if (best && bd < 160 * 160) a.home = { pos: new THREE.Vector3(best.x, best.y, best.z), kind: best.kind, nx: best.nx || 0, nz: best.nz || 0 };
    } else if (a.mode === 'air') {
      // fliers outside the fault come down to the ground to rest
      const f = this.hab.floorNear(a.pos.x, a.pos.y, a.pos.z, 200, 1.5);
      a.home = f ? { pos: new THREE.Vector3(a.pos.x, f.y, a.pos.z), kind: 'ground' } : { pos: a.pos.clone(), kind: 'range' };
    } else a.home = { pos: a.pos.clone(), kind: 'range' };
    this.agents.push(a);
    this.buildQueue.push(a);
    this.stats.spawned++;
    return a;
  }

  build(a) {
    if (a.built || a.dead) return;
    const cr = buildCreature(a.ph, a.id);
    const root = new THREE.Group();
    root.add(cr.mesh);
    root.scale.setScalar(a.ageScale);
    root.matrixAutoUpdate = true;
    a.obj = { root, mesh: cr.mesh, creature: cr };
    a.anim = new Animator(cr, a.ph, a.sp, a.id);
    a.built = true;
    this.group.add(root);
  }

  dispose(a) {
    if (a.obj) {
      this.group.remove(a.obj.root);
      a.obj.mesh.geometry.dispose();
      a.obj.mesh.skeleton.dispose();
    }
    a.obj = null; a.anim = null;
  }

  /** Fold an individual back into its region's population (and its genes into the pool). */
  despawn(a) {
    const r = a.region;
    if (r && !a.dead) {
      if (r.init) r.pops[a.sp.id] = Math.min(r.K[a.sp.id] * 1.5 + 1, r.pops[a.sp.id] + 1);
      const pool = r.pools[a.sp.id] || (r.pools[a.sp.id] = []);
      pool.push(a.genes);
      if (pool.length > POOL) pool.shift();
    }
    a.dead = true;
    a.gone = true;
    this.stats.despawned++;
  }

  kill(a, killer) {
    if (a.dead) return;
    a.dead = true;
    this.stats.deaths++;
    if (killer) this.stats.kills++;
    this.carcasses.push({ pos: a.pos.clone(), meat: a.ph.scale * 2, time: 240, sp: a.sp });
  }

  // ------------------------------------------------------------------ spawning
  /**
   * The area around the explorer where creatures live: it follows the render
   * distance (nothing is spawned in the fog), within sensible bounds.
   */
  areaRadius() {
    const edge = this.game.renderer && this.game.renderer.fogEdge;
    return clamp(edge ? edge * 0.85 : ACTIVE_R, 60, ACTIVE_R + 50);
  }

  /**
   * Like the mobs of a block game, creatures keep appearing wherever there is
   * room for them. Twice a second: individuals that left the explorer's area
   * are folded back into their region's population (their genomes stay in its
   * pool), then free places are filled, up to the creature limit, by picking
   * random spots around the explorer, a species that can live in that kind of
   * place (weighted by how common it is there and by how many are already
   * around), and a point of real habitat for it. Spawns stay out of sight.
   */
  updateActivation(ppos) {
    const areaR = this.areaRadius();
    this.visR = areaR + 25;
    const dropR = areaR + 35;
    // fold back the ones that left the area
    for (const a of this.agents) {
      if (a.dead) continue;
      const d = a.pos.distanceTo(ppos);
      if (d > (a.mode === 'air' ? dropR + 40 : dropR) || Math.abs(a.pos.y - ppos.y) > 220) this.despawn(a);
    }
    // and clear away the departed and the long dead
    this.agents = this.agents.filter((a) => {
      if (a.dead && (a.gone || a.deadT > 3)) { this.dispose(a); return false; }
      return true;
    });
    // regions in the area are "active": their numbers are the creatures present
    for (const r of this.regions.values()) r.active = Math.hypot(r.x - ppos.x, r.z - ppos.z) < areaR + RS * 0.5 && Math.abs(r.y - ppos.y) < 240;
    let count = 0;
    const perSp = new Map();
    for (const a of this.agents) if (!a.dead) { count++; perSp.set(a.S, (perSp.get(a.S) || 0) + 1); }
    if (count >= this.maxAgents) return;
    const camFwd = _v3.set(0, 0, -1);
    if (this.game.camera) camFwd.applyQuaternion(this.game.camera.quaternion);
    const rng = this.spawnRng || (this.spawnRng = RNG.derive(this.plan.seed, 'spawn'));
    const t0 = performance.now();
    const deadline = t0 + 3;
    for (let attempt = 0; attempt < 16 && count < this.maxAgents && performance.now() - t0 < 5; attempt++) {
      // a random spot in the area (uniform over its surface), not right beside the explorer
      const ang = rng.range(0, Math.PI * 2), dist = 22 + Math.sqrt(rng.next()) * (areaR - 22);
      const x = ppos.x + Math.cos(ang) * dist, z = ppos.z + Math.sin(ang) * dist;
      const dy = rng.pick([0, 0, 0, -40, 40, -100, 100]);
      const y = ppos.y + dy;
      const band = this.hab.bandAt(x, y, z);
      // which species can live there, and how likely each is
      let tot = 0;
      const cand = [];
      for (const S of this.sp) {
        if (!S.bands.includes(band)) continue;
        const key = this.regionKey(band, x, y, z);
        const r = this.regions.get(key);
        const si = S.s.id;
        const abundance = r && r.init && r.K[si] > 0 ? clamp(r.pops[si] / r.K[si], 0.25, 1.5) : r && r.init ? 0.15 : 1;
        const crowd = (perSp.get(S) || 0) / (S.s.behavior.groupSize[1] + 2);
        // the open tube is where the eye goes: its fliers and climbers are favoured
        // over the small cave fauna, which fills the caves when the explorer is in them
        const open = S.s.layer === 'layer3' ? (S.s.behavior.habitat === 'cave' ? 0.55 : 1.8) : 1;
        const w = S.cap * abundance * open / (1 + crowd * crowd * 2);
        if (w <= 0) continue;
        cand.push([S, w]); tot += w;
      }
      if (!tot) continue;
      let pick = rng.next() * tot, S = cand[0][0];
      for (const [c, w] of cand) { pick -= w; if (pick <= 0) { S = c; break; } }
      const center = this.hab.sample(S.s, S.rng, x, y, z, 24);
      if (!center) continue;
      // out of sight: never right beside the explorer, nor close in front of it
      const dx = center.x - ppos.x, dz = center.z - ppos.z, d = Math.hypot(dx, dz);
      if (d < 20 || d > areaR + 10 || (d < 60 && (dx * camFwd.x + dz * camFwd.z) / d > 0.5)) continue;
      const cband = this.hab.bandAt(center.x, center.y + 0.5, center.z);
      const key = this.regionKey(cband, center.x, center.y, center.z);
      const r = this.region(key, center.x, center.y, center.z, cband, deadline);
      const si = S.s.id;
      const G2 = S.s.behavior.groupSize;
      const n = Math.max(1, Math.min(rng.int(G2[0], G2[1]), this.maxAgents - count));
      const groupId = n > 1 ? this.nextId * 31 : null;
      let leader = null;
      for (let k = 0; k < n; k++) {
        const p = k === 0 ? center : this.hab.sample(S.s, S.rng, center.x, center.y, center.z, 6 + S.s.size * 4) || center;
        const g = this.genesFor(S, r, p, S.rng);
        const a = this.spawn(S, p, g, { region: r });
        if (r.init) r.pops[si] = Math.max(0, r.pops[si] - 1);
        a.group = groupId;
        if (!leader) leader = a;
        a.leader = leader;
        if (a.juvenile && leader !== a) a.parent = leader;
        count++;
        perSp.set(S, (perSp.get(S) || 0) + 1);
      }
    }
  }

  // ------------------------------------------------------------------ main update
  update(dt) {
    dt = Math.min(dt, 0.1);
    const g = this.game;
    const player = g.player;
    if (!player) return;
    this.player = player;
    this.playerAgent.pos.copy(player.pos);
    this.hour = g.timeOfDay ?? 12;
    this.dark = player.pos.y < -880 || (this.hour < 5.5 || this.hour > 20.5);
    this.lampOn = !!(g.lampOn ?? (player.pos.y < -880));
    this.playerSafe = player.mode === 'dead';
    this.playerCalm = !player.vel || player.vel.length() < 1.8;
    this.tickTimer -= dt;
    if (this.tickTimer <= 0) { this.tickTimer = 5; this.abstractTick(5); }
    this.activationTimer -= dt;
    if (this.activationTimer <= 0) { this.activationTimer = 0.5; this.updateActivation(player.pos); }
    // build bodies within a small time budget per frame (at least one)
    const bt = performance.now();
    while (this.buildQueue.length) {
      this.build(this.buildQueue.shift());
      if (performance.now() - bt > 2.5) break;
    }
    this.rebuildGrid();
    for (const at of this.attractors) at.t -= dt;
    this.attractors = this.attractors.filter((at) => at.t > 0);
    const cam = g.camera ? g.camera.position : player.pos;
    this.frame = (this.frame || 0) + 1;
    for (const a of this.agents) {
      if (a.dead) { a.deadT = (a.deadT || 0) + dt; if (a.obj) a.obj.root.visible = false; continue; }
      // distant individuals think and move at a lower rate (simulation level of detail)
      let d2 = a.pos.distanceToSquared(cam);
      const every = d2 < 70 * 70 ? 1 : d2 < 130 * 130 ? 2 : 3;
      a.liveDt = (a.liveDt || 0) + dt;
      if (every === 1 || (this.frame + a.id) % every === 0) {
        this.live(a, Math.min(0.25, a.liveDt));
        a.liveDt = 0;
        d2 = a.pos.distanceToSquared(cam);
      }
      if (!a.obj) continue;
      const vr = this.visR || VIS_R;
      a.visible = d2 < vr * vr;
      a.obj.root.visible = a.visible;
      if (!a.visible) continue;
      this.place(a);
      // animate near creatures every frame, far ones less often
      const anim = d2 < 40 * 40 ? 1 : d2 < 90 * 90 ? 2 : 4;
      a.animDt = (a.animDt || 0) + dt;
      if ((this.frame + a.id) % anim === 0) { this.animate(a, a.animDt); a.animDt = 0; }
    }
    for (const c of this.carcasses) c.time -= dt;
    this.carcasses = this.carcasses.filter((c) => c.time > 0 && c.meat > 0);
  }

  /** Needs, decisions, action, movement and life events of one individual. */
  live(a, dt) {
    const N = a.needs, sp = a.sp;
    a.age += dt;
    const sleeping = a.state === 'sleep';
    N.hunger = Math.min(1, N.hunger + dt / (220 + a.ph.scale * 120));
    N.energy = clamp(N.energy + (sleeping ? dt / 90 : -dt / (500 + a.ph.scale * 100)), 0, 1);
    if (!a.juvenile) N.mate = Math.min(1, N.mate + dt / (260 + sp.behavior.reproduction.cooldown));
    N.fear = Math.max(0, N.fear - dt * 0.1);
    // habituation to the explorer: grows while it stays near and calm, fades when it rushes about
    const pd = a.pos.distanceTo(this.playerAgent.pos);
    if (pd < 40) a.habit = clamp((a.habit || 0) + dt * (this.playerCalm ? 1 / 25 : -1 / 6), 0, 1);
    else a.habit = Math.max(0, (a.habit || 0) - dt / 60);
    // grow up
    if (a.juvenile && a.built && Math.random() < dt * 0.02) {
      const s = 0.45 + 0.55 * Math.min(1, a.age / a.maturity);
      a.ageScale = s; a.scale = a.ph.scale * s;
      if (a.obj) a.obj.root.scale.setScalar(s);
    }
    a.timer -= dt;
    a.thinkT -= dt;
    if (a.avoidT > 0) a.avoidT -= dt;
    if (a.fleeEvT > 0) a.fleeEvT -= dt;
    if (a.broodT > 0) a.broodT -= dt;
    if (a.thinkT <= 0) {
      a.thinkT = 0.45 + Math.random() * 0.5;
      const prev = a.state;
      decide(a, this);
      this.onActionStart(a, prev);
    }
    this.act(a, dt);
    this.move(a, dt);
    // calls: idle chatter, alarms and threats
    a.calling = Math.max(0, a.calling - dt);
    a.callT -= dt;
    if (a.callT <= 0) {
      a.callT = sp.call.interval * (0.6 + Math.random() * 0.8) * (a.state === 'sleep' ? 4 : 1);
      if (a.state !== 'sleep') this.call(a, a.state === 'court' ? 'court' : 'idle');
    }
    a.band = this.hab.bandAt(a.pos.x, a.pos.y + 0.5, a.pos.z);
  }

  call(a, kind) {
    a.calling = Math.max(a.calling, a.sp.call.length + 0.2);
    this.emit('call', { a, kind });
  }

  /** First frame of a new action: events and calls. */
  onActionStart(a, prev) {
    if (a.state === prev) return;
    const t = a.target;
    switch (a.state) {
      case 'flee': {
        if (!(a.fleeEvT > 0)) { this.emit('flee', { a, from: t && t.agent }); a.fleeEvT = 8; }
        if (Math.random() < 0.6) this.call(a, 'alarm');
        // alarm spreads through the group
        for (const o of this.neighbours(a, 25)) if (o.sp === a.sp && o.state !== 'flee') { o.needs.fear = Math.max(o.needs.fear, 0.7); o.thinkT = Math.random() * 0.3; }
        break;
      }
      case 'hunt': this.emit('hunt', { a, prey: t.agent }); this.call(a, 'hunt'); break;
      case 'stalk': this.emit('stalk-player', { a }); this.call(a, 'threat'); break;
      case 'court': this.emit('court', { a, b: t.agent }); this.call(a, 'court'); break;
      case 'defend': this.emit('territorial', { a, b: t.agent }); this.call(a, 'threat'); break;
      case 'mob': this.emit('mob', { a, b: t.agent }); this.call(a, 'alarm'); break;
      case 'guard': this.emit('guard', { a }); this.call(a, 'threat'); break;
      case 'symbiosis': this.emit('symbiosis', { a, host: t.agent }); break;
      case 'investigate': this.emit('investigate', { a }); break;
      case 'sleep': case 'roost': if (a.home && a.home.kind !== 'range' && !a.roostSeen && a.pos.distanceTo(a.home.pos) < 3) { a.roostSeen = true; this.emit('roost', { a, kind: a.home.kind }); } break;
      case 'scavenge': this.emit('scavenge', { a }); break;
      default: break;
    }
  }

  /** Carry out the current action: desired speed, target point and interactions. */
  act(a, dt) {
    const t = a.target, st = a.ph.stats;
    const run = st.run, walk = st.walk, fly = st.fly || walk * 3;
    const air = a.mode === 'air';
    a.goal = a.goal || new THREE.Vector3();
    a.action = 'idle';
    let speed = 0, hasGoal = false;
    const tgtPos = t && t.agent ? t.agent.pos : t && t.pos ? t.pos : null;
    switch (a.state) {
      case 'flee': {
        if (!tgtPos) break;
        // away from the threat (and toward home if there is one close by)
        _v.subVectors(a.pos, tgtPos); _v.y = air ? 0.3 * _v.length() : 0;
        if (_v.lengthSq() < 1e-4) _v.set(1, 0, 0);
        _v.normalize();
        a.goal.copy(a.pos).addScaledVector(_v, 20);
        if (a.home && a.home.kind !== 'range' && a.pos.distanceTo(a.home.pos) < 60) a.goal.lerp(a.home.pos, 0.6);
        speed = air ? fly * 1.3 : run; hasGoal = true; a.action = 'alert';
        a.avoid = a.avoid || new THREE.Vector3();
        a.avoid.copy(tgtPos); a.avoidT = 20;
        break;
      }
      case 'hunt': {
        const prey = t.agent;
        if (!prey || prey.dead) { a.timer = 0; break; }
        const d = prey.pos.distanceTo(a.pos);
        a.goal.copy(prey.pos); hasGoal = true;
        speed = d > 12 ? (air ? fly * 1.4 : run * 0.9) : (air ? fly * 1.6 : run);
        if (d < Math.max(0.8, a.scale * 0.6 + prey.scale * 0.3)) {
          a.action = 'attack';
          a.strike += dt;
          if (a.strike > 0.4) {
            a.strike = 0;
            // the strike lands more often against slow, small or young prey
            const p = clamp(0.45 + (a.genes.c[G.agility] - prey.genes.c[G.agility]) * 0.4 + (prey.juvenile ? 0.2 : 0) - prey.needs.fear * 0.15, 0.1, 0.9);
            if (Math.random() < p) {
              this.kill(prey, a);
              this.emit('kill', { a, prey });
              this.call(a, 'hunt');
              a.state = 'eat'; a.target = { pos: prey.pos.clone(), kind: 'kill' }; a.timer = 10;
              a.needs.hunger = Math.max(0, a.needs.hunger - 0.7);
            } else prey.needs.fear = 1;
          }
        }
        break;
      }
      case 'eat': a.action = 'eat'; break;
      case 'scavenge': {
        if (!t || !t.carcass || t.carcass.meat <= 0) { a.timer = 0; break; }
        const d = t.carcass.pos.distanceTo(a.pos);
        if (d > 1.5) { a.goal.copy(t.carcass.pos); hasGoal = true; speed = air ? fly : walk * 1.4; } else {
          a.action = 'eat';
          t.carcass.meat -= dt * 0.05 * a.ph.scale;
          a.needs.hunger = Math.max(0, a.needs.hunger - dt * 0.05);
        }
        break;
      }
      case 'forage': {
        // graze, peck, browse lichen or hawk for insects in the air
        if (!a.foragePt || a.timer < 0.5 || a.foragePt.distanceTo(a.pos) > 30) {
          a.foragePt = a.foragePt || new THREE.Vector3();
          const r = air ? 18 : 6 + a.scale * 3;
          a.foragePt.set(a.pos.x + (Math.random() - 0.5) * 2 * r, a.pos.y + (air ? (Math.random() - 0.5) * 8 : 0), a.pos.z + (Math.random() - 0.5) * 2 * r);
        }
        const d = a.foragePt.distanceTo(a.pos);
        if (air) { a.goal.copy(a.foragePt); hasGoal = true; speed = fly * 0.9; a.flapping = true; }
        else if (d > 1.2) { a.goal.copy(a.foragePt); hasGoal = true; speed = walk * 0.6; } else {
          a.action = 'eat';
          a.needs.hunger = Math.max(0, a.needs.hunger - dt * 0.03);
          if (Math.random() < dt * 0.05) this.emit('forage', { a, kind: this.forageKind(a) });
        }
        break;
      }
      case 'sleep': case 'rest': case 'idle': {
        a.action = a.state === 'idle' && Math.random() < 0.003 ? 'groom' : 'idle';
        if (a.state === 'idle' && Math.random() < dt * 0.15) a.lookAround = (Math.random() - 0.5) * 2;
        break;
      }
      case 'roost': case 'nest': {
        if (!a.home) { a.timer = 0; break; }
        const d = a.home.pos.distanceTo(a.pos);
        if (d > 1.2) { a.goal.copy(a.home.pos); hasGoal = true; speed = air ? fly : walk * 1.1; }
        else {
          this.settle(a);
          if (a.state === 'nest') this.tendNest(a, dt);
          if (a.state === 'roost') { a.state = 'sleep'; a.timer = 30; }
        }
        break;
      }
      case 'court': {
        const m = t.agent;
        if (!m || m.dead) { a.timer = 0; break; }
        const d = m.pos.distanceTo(a.pos);
        a.action = 'display';
        if (d > 2 + a.scale) { a.goal.copy(m.pos); hasGoal = true; speed = air ? fly * 0.8 : walk * 0.8; }
        else if (m.state === 'court' && m.target && m.target.agent === a && a.sex === 'f') this.mate(a, m);
        break;
      }
      case 'follow': case 'flock': case 'symbiosis': {
        const o = t && t.agent;
        if (!o || o.dead) { a.timer = 0; break; }
        const d = o.pos.distanceTo(a.pos);
        const keep = a.state === 'follow' ? 1.5 + a.scale : a.state === 'symbiosis' ? 1 + o.scale * 0.6 : 3 + a.scale * 2;
        if (d > keep) { a.goal.copy(o.pos); hasGoal = true; speed = Math.min(o.speed > 0.2 ? o.speed * 1.15 : walk, air ? fly : run); if (d > keep * 3) speed = air ? fly : run * 0.8; }
        if (a.state === 'symbiosis' && d < keep * 1.5) a.action = 'eat';
        break;
      }
      case 'mob': {
        const o = t.agent;
        if (!o || o.dead) { a.timer = 0; break; }
        // circle above the predator, diving and calling
        const ang = (performance.now() / 1000) * 1.3 + a.id;
        a.goal.set(o.pos.x + Math.cos(ang) * 4, o.pos.y + 2.5, o.pos.z + Math.sin(ang) * 4);
        hasGoal = true; speed = air ? fly : run; a.action = 'call';
        if (Math.random() < dt * 0.6) this.call(a, 'alarm');
        if (Math.random() < dt * 0.3) o.needs.fear = Math.min(1, o.needs.fear + 0.2);
        break;
      }
      case 'defend': {
        const o = t.agent;
        if (!o || o.dead) { a.timer = 0; break; }
        a.goal.copy(o.pos); hasGoal = true; speed = air ? fly : run * 0.8; a.action = 'display';
        if (o.pos.distanceTo(a.pos) < 2 + a.scale) { o.needs.fear = 0.9; o.thinkT = 0; a.action = 'attack'; }
        break;
      }
      case 'guard': {
        // threat display, then dive passes (fliers) or lunges (climbers) until the explorer backs off
        const p = this.playerAgent.pos;
        const d = p.distanceTo(a.pos);
        if (t.pos && p.distanceTo(t.pos) > t.r + 5) { a.timer = 0; break; }
        a.lookAt = p;
        a.guardT = (a.guardT || 0) - dt;
        a.strikeCd = Math.max(0, (a.strikeCd || 0) - dt);
        if (air || a.ph.stats.fly > 0) {
          if (!air && d < 14) { a.mode = 'air'; a.vel.copy(a.up).multiplyScalar(3); }
          // swoop in, then climb away and turn for another pass
          if (a.guardT <= 0) { a.guardT = 2.6; a.swoop = !a.swoop; }
          if (a.swoop) a.goal.set(p.x, p.y + 1.4, p.z);
          else a.goal.set(p.x + Math.cos(a.id) * 9, p.y + 7, p.z + Math.sin(a.id) * 9);
          hasGoal = true; speed = fly * (a.swoop ? 1.25 : 0.9); a.action = a.swoop ? 'attack' : 'call';
        } else {
          a.goal.copy(p); hasGoal = d > 1.6; speed = run * 0.85; a.action = d < 4 ? 'attack' : 'display';
        }
        if (d < 1.5 + a.scale * 0.5 && a.strikeCd <= 0 && this.player && this.player.mode !== 'dead') {
          a.strikeCd = 2.5;
          if (air) a.swoop = false;
          // small birds only harass; raptors and the larger climbers draw blood
          const dmg = Math.round(a.ph.scale * 4.5);
          if (dmg > 0) this.player.hurt(dmg, 'creature');
          this.emit('guard-strike', { a });
          this.call(a, 'threat');
        } else if (Math.random() < dt * 0.5) this.call(a, 'alarm');
        break;
      }
      case 'investigate': {
        const p = this.playerAgent.pos;
        const d = p.distanceTo(a.pos);
        const keep = 5 + a.scale * 3;
        if (d > keep) { a.goal.copy(p); hasGoal = true; speed = walk * 0.7; }
        a.action = 'alert';
        a.lookAt = p;
        break;
      }
      case 'stalk': case 'charge': {
        const p = this.playerAgent.pos;
        const d = p.distanceTo(a.pos);
        a.goal.copy(p); hasGoal = true;
        if (a.state === 'stalk') {
          speed = walk * 0.7; a.action = 'alert';
          a.stalkT = (a.stalkT || 0) + dt;
          if (d < 9 || a.stalkT > 22) { a.state = 'charge'; a.timer = 6; this.call(a, 'hunt'); this.emit('charge-player', { a }); }
        } else {
          speed = run; a.action = 'attack';
          if (d < 1.6 + a.scale * 0.4 && this.player && this.player.hurt) {
            a.strike += dt;
            if (a.strike > 0.8) { a.strike = 0; this.player.hurt(16, 'creature'); this.emit('attack-player', { a }); a.state = 'wander'; a.timer = 8; a.stalkT = 0; }
          }
        }
        break;
      }
      default: {
        // wander: a slowly drifting heading inside the home range
        if (!a.wanderPt || a.wanderPt.distanceTo(a.pos) < 1.5 || Math.random() < dt * 0.1) {
          a.wanderPt = a.wanderPt || new THREE.Vector3();
          const r = air ? 40 : 10 + a.scale * 6;
          let base = a.home && a.home.kind !== 'range' && a.pos.distanceTo(a.home.pos) > 50 ? a.home.pos : a.pos;
          // the local population stays local: strays turn back toward the explorer's
          // surroundings instead of drifting off and being folded back into the pool
          const P = this.playerAgent.pos;
          if (a.pos.distanceTo(P) > this.areaRadius() * 0.85) base = _lv.lerpVectors(a.pos, P, 0.45);
          a.wanderPt.set(base.x + (Math.random() - 0.5) * 2 * r, base.y + (air ? (Math.random() - 0.5) * 20 : 0), base.z + (Math.random() - 0.5) * 2 * r);
          for (const at of this.attractors) if (at.pos.distanceTo(a.pos) < 35 && a.sp.behavior.diet !== 'carnivore') a.wanderPt.copy(at.pos);
          // keep away from where something frightened it
          if (a.avoidT > 0 && a.wanderPt.distanceTo(a.avoid) < 25) { _v.subVectors(a.wanderPt, a.avoid).setY(0); if (_v.lengthSq() < 1e-3) _v.set(1, 0, 0); a.wanderPt.copy(a.avoid).addScaledVector(_v.normalize(), 28); }
        }
        a.goal.copy(a.wanderPt); hasGoal = true; speed = air ? fly * 0.7 : walk * 0.55;
      }
    }
    a.hasGoal = hasGoal;
    a.wantSpeed = speed;
  }

  forageKind(a) {
    const d = a.sp.behavior.diet;
    if (d === 'grazer') return 'grass';
    if (d === 'browser') return 'moss';
    if (d === 'lithophage') return 'minerals';
    if (d === 'lichen') return 'lichen';
    if (d === 'nectar') return 'flowers';
    if (d === 'piscivore') return 'fish';
    return 'insects';
  }

  /** Arrive at home: perch, roost upside down, cling to the wall or rest in the den. */
  settle(a) {
    const h = a.home;
    if (!h) return;
    a.vel.set(0, 0, 0);
    if (h.kind === 'roost') { a.mode = 'hang'; a.pos.copy(h.pos); a.pos.y -= a.scale * 0.3; }
    else if (h.kind === 'wall') { a.mode = 'wall'; a.phi = Math.atan2(-h.nz, -h.nx); a.pos.copy(h.pos); }
    else if (h.kind === 'ledge') { a.mode = a.sp.behavior.habitat === 'wall' ? 'ground' : 'perch'; a.pos.copy(h.pos); }
    else if (h.kind === 'den') { a.pos.copy(h.pos); }
    else if (h.kind === 'ground') { a.mode = 'perch'; a.pos.copy(h.pos); }
  }

  /** Eggs and young at the nest. */
  tendNest(a, dt) {
    a.action = 'idle';
    a.eggT -= dt;
    if (a.nestEggs > 0 && a.eggT <= 0) {
      const n = a.nestEggs;
      a.nestEggs = 0;
      a.broodT = 90;
      if (a.mate && !a.mate.dead) a.mate.broodT = 90;
      const mate = a.mate && !a.mate.dead ? a.mate : a;
      for (let k = 0; k < n && this.agents.length < this.maxAgents + 6; k++) this.birth(a, mate, a.home.pos);
    }
  }

  mate(f, m) {
    const R = f.sp.behavior.reproduction;
    f.needs.mate = 0; m.needs.mate = 0;
    f.mate = m; m.mate = f;
    f.state = 'idle'; m.state = 'idle'; f.timer = 3; m.timer = 3;
    this.emit('court', { a: m, b: f });
    if (this.agents.length >= this.maxAgents + 6) return;
    if (R.eggs && f.home && f.home.kind !== 'range') {
      // eggs at the nest; the parents tend them until they hatch
      f.nestEggs = R.clutch; f.eggT = 40 + Math.random() * 30;
      f.state = 'nest'; f.target = { pos: f.home.pos, kind: 'nest' }; f.timer = 60;
      this.emit('nest', { a: f });
    } else {
      for (let k = 0; k < R.clutch; k++) this.birth(f, m, f.pos);
    }
  }

  birth(f, m, at) {
    const rng = f.S.rng;
    const genes = inheritGenes(f.sp, f.genes, m.genes, rng);
    const pos = { x: at.x + (Math.random() - 0.5), y: at.y, z: at.z + (Math.random() - 0.5), mode: f.mode === 'hang' ? 'hang' : f.mode === 'air' ? 'perch' : f.mode, node: f.node, phi: f.phi };
    const y = this.spawn(f.S, pos, genes, { age: 1, parent: f, region: f.region });
    y.group = f.group; y.leader = f.leader || f; y.home = f.home;
    y.needs.hunger = 0.2;
    this.stats.births++;
    // the newborn's genes join the regional pool: the population drifts as it breeds
    if (f.region) { const pool = f.region.pools[f.sp.id] || (f.region.pools[f.sp.id] = []); pool.push(genes); if (pool.length > POOL) pool.shift(); }
    this.emit('birth', { a: f, young: y });
  }

  // ------------------------------------------------------------------ movement
  move(a, dt) {
    switch (a.mode) {
      case 'cave': this.moveCave(a, dt); break;
      case 'wall': this.moveWall(a, dt); break;
      case 'air': this.moveAir(a, dt); break;
      case 'hang': case 'perch': this.moveRest(a, dt); break;
      default: this.moveGround(a, dt); break;
    }
  }

  steerYaw(a, dx, dz, dt, rate = 3) {
    if (dx * dx + dz * dz < 1e-6) { a.turn = 0; return; }
    const want = Math.atan2(dx, dz);
    let d = want - a.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = Math.max(-rate * dt, Math.min(rate * dt, d));
    a.yaw += step;
    a.turn = step / Math.max(1e-3, dt);
  }

  moveGround(a, dt) {
    const H = this.hab;
    if (!a.hasGoal) { a.speed = Math.max(0, a.speed - dt * 3); return; }
    _v.subVectors(a.goal, a.pos); _v.y = 0;
    const dist = _v.length();
    let sp = a.wantSpeed * Math.min(1, dist / 1.5);
    a.speed += (sp - a.speed) * Math.min(1, dt * 4);
    this.steerYaw(a, _v.x, _v.z, dt, 2.5 + a.genes.c[G.agility] * 3);
    const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    const step = a.speed * dt;
    if (step < 1e-4) return;
    const nx = a.pos.x + fx * step, nz = a.pos.z + fz * step;
    const maxStep = Math.max(0.5, a.scale * 0.45 + 0.3);
    const ceilMode = a.mode === 'ceiling';
    const f = H.floorNear(nx, a.pos.y, nz, maxStep + 0.6, ceilMode ? 3 : Math.max(0.8, a.scale * 0.6));
    let ok = !!f;
    if (ok && !ceilMode) {
      if (f.y - a.pos.y > maxStep || a.pos.y - f.y > maxStep * 2.5) ok = false;
      if (!Number.isNaN(f.water) && f.water > f.y + 0.4 && a.sp.behavior.habitat !== 'shore') ok = false;
      if (ok && !this.sp[a.sp.id].bands.includes(H.bandAt(nx, f.y + 0.5, nz))) ok = false;
    }
    if (ceilMode && ok) { if (!(f.ceil < Infinity) || Math.abs(f.ceil - a.pos.y) > maxStep) ok = false; }
    if (!ok) {
      // blocked: turn away and pick a new goal
      a.yaw += (Math.random() < 0.5 ? 1 : -1) * (0.8 + Math.random());
      a.speed *= 0.3;
      a.wanderPt = null; a.foragePt = null;
      return;
    }
    const ny = ceilMode ? f.ceil : f.y;
    a.pitch = Math.atan2(a.lastFloorY - ny, Math.max(0.05, step)) * 0.5;
    a.pos.set(nx, a.pos.y + (ny - a.pos.y) * Math.min(1, dt * 12), nz);
    a.lastFloorY = ny;
  }

  /** The cave network: walk from node to node along the passages. */
  moveCave(a, dt) {
    const C = this.hab.caves;
    if (a.node < 0 || a.node >= C.nodes.length) { a.node = C.nearest(a.pos.x, a.pos.y, a.pos.z, 40); if (a.node < 0) { a.mode = 'ground'; return; } }
    if (!a.hasGoal) { a.speed = Math.max(0, a.speed - dt * 3); }
    else a.speed += (a.wantSpeed - a.speed) * Math.min(1, dt * 4);
    const cur = C.nodes[a.node];
    if (a.next < 0 || a.next >= C.nodes.length) {
      // choose the neighbour that best serves the goal (or wander), avoiding going straight back
      let best = -1, bs = -Infinity;
      for (const n of cur.adj) {
        const nd = C.nodes[n];
        let s = Math.random() * 0.5 - (n === a.prev ? 1.5 : 0);
        if (a.hasGoal) s -= Math.hypot(nd.x - a.goal.x, (nd.y - a.goal.y) * 1.5, nd.z - a.goal.z) * 0.05;
        if (a.state === 'flee' && a.target && a.target.agent) s += Math.hypot(nd.x - a.target.agent.pos.x, nd.z - a.target.agent.pos.z) * 0.1;
        if (s > bs) { bs = s; best = n; }
      }
      a.next = best;
      if (best < 0) return;
    }
    const nx = C.nodes[a.next];
    // lane offset keeps individuals from walking a single file line
    const dx = nx.x - a.pos.x, dz = nx.z - a.pos.z;
    const L = Math.hypot(dx, dz);
    const lane = a.lane * Math.min(nx.r, cur.r) * 0.8;
    const tx = nx.x + (-dz / (L || 1)) * lane, tz = nx.z + (dx / (L || 1)) * lane;
    this.steerYaw(a, tx - a.pos.x, tz - a.pos.z, dt, 4);
    const step = a.speed * dt;
    if (L < Math.max(0.8, step * 1.5)) { a.prev = a.node; a.node = a.next; a.next = -1; return; }
    const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    const px = a.pos.x + fx * step, pz = a.pos.z + fz * step;
    const yRef = cur.y + (nx.y - cur.y) * clamp(1 - L / Math.max(1, Math.hypot(nx.x - cur.x, nx.z - cur.z)), 0, 1);
    const f = this.hab.floorNear(px, yRef + 0.5, pz, 2.5, 0.6);
    if (!f) { a.yaw += 0.6; return; }
    a.pitch = Math.atan2(a.pos.y - f.y, Math.max(0.05, step)) * 0.5;
    a.pos.set(px, a.pos.y + (f.y - a.pos.y) * Math.min(1, dt * 12), pz);
    if (a.hasGoal && a.goal.distanceTo(a.pos) < 1.5) a.next = -1;
  }

  /** The chasm walls: (angle, height) on the rock face. */
  moveWall(a, dt) {
    const p = this.plan.params.chasm;
    if (!a.hasGoal) { a.speed = Math.max(0, a.speed - dt * 3); }
    else a.speed += (a.wantSpeed * 0.8 - a.speed) * Math.min(1, dt * 4);
    let R = this.hab.chasm.wallDist(a.phi, a.pos.y);
    if (R <= 0) { a.mode = 'air'; return; }
    let vt = 0, vy = 0;
    if (a.hasGoal) {
      const [cx, cz] = this.hab.chasm.centreAt(a.pos.y);
      const gphi = Math.atan2(a.goal.z - cz, a.goal.x - cx);
      let dphi = gphi - a.phi;
      while (dphi > Math.PI) dphi -= Math.PI * 2;
      while (dphi < -Math.PI) dphi += Math.PI * 2;
      const dt_ = dphi * R, dy = a.goal.y - a.pos.y;
      const l = Math.hypot(dt_, dy) || 1;
      vt = (dt_ / l) * a.speed; vy = (dy / l) * a.speed;
      a.wallDir = Math.atan2(vt, vy);
    }
    a.phi += (vt * dt) / Math.max(20, R);
    let y = clamp(a.pos.y + vy * dt, p.floorY + 22, p.yWide - 4);
    this.hab.wallPoint(a.phi, y, a.pos, a.up);
    a.turn = 0;
    // gliders launch from the wall to cross to a lower ledge
    if (a.sp.plan === 'glider' && a.state === 'wander' && Math.random() < dt * 0.02) { a.mode = 'air'; a.vel.copy(a.up).multiplyScalar(3); a.gliding = true; this.emit('glide', { a }); }
    void R;
  }

  /** Open air: steering with avoidance of walls, floors and ceilings. */
  moveAir(a, dt) {
    const st = a.ph.stats;
    const flySpeed = st.fly || st.walk * 3;
    let want = a.hasGoal ? a.wantSpeed : flySpeed * 0.6;
    // desired velocity toward the goal
    if (a.hasGoal) _v.subVectors(a.goal, a.pos);
    else _v.copy(a.vel);
    if (_v.lengthSq() < 1e-4) _v.set(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    _v.normalize().multiplyScalar(want);
    // gliders and soarers sink slowly
    if (a.gliding || a.sp.behavior.locomotion === 'glide') _v.y = Math.min(_v.y, -0.6);
    // avoidance
    const ch = this.hab.chasm, p = this.plan.params;
    if (a.sp.layer === 'layer3') {
      _v2.copy(a.pos).addScaledVector(a.vel, 1.2);
      const c = ch.clearance(_v2.x, _v2.y, _v2.z);
      if (c > -9) {
        const [cx, cz] = ch.centreAt(a.pos.y);
        _v3.set(cx - a.pos.x, 0, cz - a.pos.z).normalize();
        _v.addScaledVector(_v3, (c + 9) * 0.9);
        // a glider reaching the wall clings to it
        if (a.sp.behavior.habitat === 'wall' && c > -2) { a.mode = 'wall'; a.phi = Math.atan2(a.pos.z - cz, a.pos.x - cx); a.gliding = false; return; }
      }
      if (a.pos.y < p.chasm.floorY + 12) _v.y += 3;
      if (a.pos.y > p.chasm.yThroat - 12) _v.y -= 3;
    } else {
      const f = this.hab.floorNear(a.pos.x, a.pos.y, a.pos.z, 400, 2);
      if (f) {
        if (a.pos.y - f.y < 3) _v.y += 3;
        if (f.ceil < Infinity && f.ceil - a.pos.y < 3) _v.y -= 3;
      }
      if (this.world.isSolid(a.pos.x + a.vel.x * 0.6, a.pos.y + a.vel.y * 0.6, a.pos.z + a.vel.z * 0.6)) { _v.y += 4; _v.x -= a.vel.x * 1.5; _v.z -= a.vel.z * 1.5; }
    }
    const turnRate = 1.6 + a.genes.c[G.agility] * 2.5;
    a.vel.lerp(_v, Math.min(1, dt * turnRate));
    const sp = a.vel.length();
    if (sp > flySpeed * 1.8) a.vel.multiplyScalar((flySpeed * 1.8) / sp);
    a.pos.addScaledVector(a.vel, dt);
    const oldYaw = a.yaw;
    if (a.vel.x * a.vel.x + a.vel.z * a.vel.z > 0.01) this.steerYaw(a, a.vel.x, a.vel.z, dt, 6);
    a.bank += ((-(a.yaw - oldYaw) / Math.max(1e-3, dt)) * 0.35 - a.bank) * Math.min(1, dt * 4);
    a.pitch = Math.atan2(-a.vel.y, Math.hypot(a.vel.x, a.vel.z)) * 0.7;
    a.speed = sp;
    a.flapping = a.vel.y > -0.3 || sp < flySpeed * 0.6 || a.sp.behavior.locomotion === 'hover' || a.sp.behavior.locomotion === 'flutter';
    if (a.sp.behavior.locomotion === 'soar' && a.vel.y < 0.4 && sp > flySpeed * 0.5) a.flapping = Math.sin(performance.now() / 1300 + a.id) > 0.7;
  }

  /** Perched, roosting or hanging at home; leave when the action needs to move. */
  moveRest(a, dt) {
    a.speed = 0;
    if (a.hasGoal && a.state !== 'roost' && a.state !== 'nest') {
      const flier = a.ph.wings.type === 'feather' || a.ph.wings.type === 'membrane';
      if (flier) { a.vel.set(0, a.mode === 'hang' ? -1 : 1.5, 0); a.mode = 'air'; }
      else if (a.sp.behavior.habitat === 'wall') a.mode = 'wall';
      else if (a.sp.behavior.habitat === 'cave') a.mode = 'cave';
      else a.mode = 'ground';
    }
    void dt;
  }

  // ------------------------------------------------------------------ rendering
  /** Orientation of the body from its mode: upright, on the wall, upside down. */
  place(a) {
    const root = a.obj.root;
    root.position.copy(a.pos);
    if (a.mode === 'wall') {
      // body lies on the rock: up = wall normal, forward along the climb direction
      const n = a.up;
      const tx = -n.z, tz = n.x; // horizontal tangent
      const ang = a.wallDir ?? 0;
      _v.set(tx * Math.sin(ang), Math.cos(ang), tz * Math.sin(ang)).normalize();
      _v2.crossVectors(n, _v).normalize();
      _m.makeBasis(_v2, n, _v);
      root.quaternion.setFromRotationMatrix(_m);
      return;
    }
    _q.setFromAxisAngle(UP, a.yaw);
    root.quaternion.copy(_q);
    _v.set(1, 0, 0).applyQuaternion(_q);
    root.quaternion.premultiply(_q.setFromAxisAngle(_v, a.pitch));
    if (a.mode === 'air') { _v.set(0, 0, 1).applyAxisAngle(UP, a.yaw); root.quaternion.premultiply(_q.setFromAxisAngle(_v, a.bank)); }
    if (a.mode === 'ceiling' || a.mode === 'hang') { _v.set(0, 0, 1).applyAxisAngle(UP, a.yaw); root.quaternion.premultiply(_q.setFromAxisAngle(_v, Math.PI)); }
  }

  animate(a, dt) {
    const air = a.mode === 'air';
    let mode = 'ground';
    if (air) mode = a.flapping ? (a.sp.behavior.locomotion === 'hover' ? 'hover' : 'fly') : 'glide';
    else if (a.state === 'sleep') mode = 'sleep';
    else if (a.state === 'rest' || (a.state === 'idle' && a.speed < 0.05 && a.needs.energy < 0.4)) mode = 'rest';
    let lookYaw = 0, lookPitch = 0;
    const lt = a.lookAt || (a.target && a.target.agent ? a.target.agent.pos : null);
    if (lt && a.mode !== 'wall') {
      _v.subVectors(lt, a.pos);
      let d = Math.atan2(_v.x, _v.z) - a.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      lookYaw = d;
      lookPitch = Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
    } else if (a.lookAround) lookYaw = a.lookAround;
    a.lookAt = null;
    a.anim.update(dt, {
      speed: air ? a.speed : a.speed / Math.max(0.3, a.ageScale), mode,
      action: a.calling > 0 && a.action === 'idle' ? 'call' : a.action,
      lookYaw, lookPitch, turn: a.turn, bank: a.bank, flap: a.flapping ? 1 : 0, hop: a.sp.behavior.locomotion === 'hop',
    });
  }

  // ------------------------------------------------------------------ text helpers for the HUD
  stateLabel(a) { return ACTION_LABEL[a.state] || a.state; }

  // ------------------------------------------------------------------ save / load
  serialize() {
    const regions = [];
    for (const r of this.regions.values()) {
      if (!r.init) continue;
      regions.push([r.key, r.x, r.y, r.z, r.band, Array.from(r.pops, (v) => Math.round(v * 100) / 100)]);
    }
    return { v: 2, regions, stats: this.stats };
  }

  restore(s) {
    if (!s || s.v !== 2) return;
    for (const [key, x, y, z, band, pops] of s.regions || []) {
      const r = this.region(key, x, y, z, band);
      for (let i = 0; i < pops.length && i < r.pops.length; i++) r.pops[i] = pops[i];
    }
    if (s.stats) Object.assign(this.stats, s.stats);
  }
}

export { lerp };
