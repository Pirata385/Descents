// Discovery: everything the explorer has personally seen or learned.
// - Creatures are recorded when sighted; facts about them are unlocked by
//   observing them (hold F) and by witnessing their interactions.
// - Landmarks, layers, routes and artifact sites are discovered by proximity.
// Only discovered information ever reaches the catalog and the maps.
import * as THREE from 'three';
import { LAYERS } from '../world/layers.js';
import { CF } from '../world/column.js';
import { Z_CITY, Z_COUNTRY } from '../world/field.js';
import { FAMILY_LABEL } from '../creatures/genetics.js';
import { clamp } from '../core/mathutil.js';

/** Observation seconds needed to learn each group of facts. */
export const FACT_TIMES = { family: 0, appearance: 0, locomotion: 2, size: 3, activity: 6, social: 6, diet: 10, traits: 16, reproduction: 24 };
const FULL_OBSERVATION = 24;

const LANDMARK_RADIUS = {
  eye: 420, waterfall: 160, lake: 120, gate: 70, guild: 90, market: 60, temple: 90, observatory: 90, hamlet: 90, platform: 40,
  ruin: 60, arch: 80, spire: 90, station: 70, gallery: 140, plain: 220, stair: 60, fault: 260, threshold: 60, cave: 26, crystal: 45,
};
const LANDMARK_DY = { eye: 900, waterfall: 220, gallery: 120, plain: 160, fault: 400, stair: 300, lake: 60, spire: 120, arch: 90 };

const INTERACTION_TEXT = {
  hunt: (a, b) => [a, `Hunts the ${b}`, b, `Hunted by the ${a}`],
  kill: (a, b) => [a, `Kills and eats the ${b}`, b, `Falls prey to the ${a}`],
  flee: (a, b) => [a, b ? `Flees from the ${b}` : 'Flees when threatened'],
  territorial: (a, b) => [a, `Drives off ${b === a ? 'rivals of its own kind' : `the ${b}`} to defend its territory`],
  symbiosis: (a, b) => [a, `Lives alongside the ${b}, picking parasites from its hide`, b, `Tolerates the ${a}, which cleans it`],
  court: (a) => [a, 'Performs a circling courtship display'],
  birth: (a) => [a, 'Raises young that stay close to the parent'],
  scavenge: (a) => [a, 'Feeds on carcasses left by predators'],
  drink: (a) => [a, 'Drinks at streams and pools'],
  migrate: (a) => [a, 'Moves its home range with the group'],
  sleep: (a) => [a, 'Rests when inactive, hidden and still'],
  'stalk-player': (a) => [a, 'Stalks explorers from the dark'],
  'charge-player': (a) => [a, 'Charges explorers without warning'],
  'attack-player': (a) => [a, 'Attacks explorers'],
};

const FORAGE_TEXT = {
  grass: 'Grazes on grass', moss: 'Grazes on moss and leaf litter', minerals: 'Grinds minerals from bare rock', crystal: 'Gnaws on crystal growths',
  insects: 'Picks small insects', flowers: 'Feeds on flowers', fish: 'Catches fish',
};

export class Discovery {
  constructor(game) {
    this.game = game;
    this.plan = game.plan;
    this.species = new Map();      // id -> entry
    this.landmarks = new Set();
    this.layers = new Set();
    this.routes = new Set();
    this.spotted = new Set();      // artifact ids seen but not taken
    this.found = new Map();        // artifact id -> {x, y, z, t, layer}
    this.log = [];
    this.listeners = [];
    this.timer = 0;
    this.lmTimer = 0;
    this.focus = null;             // creature under the crosshair
    this.stats = { interactions: 0, observations: 0 };
    this.buildRouteIndex();
    this._v = new THREE.Vector3();
    this._f = new THREE.Vector3();
  }

  on(fn) { this.listeners.push(fn); }
  emit(t, d) { for (const fn of this.listeners) fn(t, d); }

  note(text, kind = 'info') {
    this.log.push({ t: this.game.gameTime, text, kind });
    if (this.log.length > 300) this.log.shift();
  }

  /** Spatial hash of the named journey routes so walking one marks it as known. */
  buildRouteIndex() {
    this.routeCells = new Map();
    const named = new Set(this.plan.journeys || []);
    for (const r of this.plan.routes) {
      if (!r.name || !named.has(r.id)) continue;
      const p = r.pts;
      for (let i = 0; i < p.length; i += 3) {
        const k = `${Math.floor(p[i] / 16)}:${Math.floor(p[i + 2] / 16)}`;
        let list = this.routeCells.get(k);
        if (!list) this.routeCells.set(k, (list = []));
        list.push(r.id, p[i], p[i + 1], p[i + 2]);
      }
    }
    this.routeById = new Map(this.plan.routes.map((r) => [r.id, r]));
  }

  attachEcosystem(eco) {
    eco.on((type, d) => this.onEcoEvent(type, d));
  }

  attachArtifacts(arts) {
    arts.on((type, a) => {
      if (type === 'collect') {
        const p = this.game.player.pos;
        this.found.set(a.id, { x: a.site.x, y: a.site.y, z: a.site.z, t: this.game.gameTime, layer: a.site.layer, depth: Math.max(0, -p.y) });
        this.spotted.delete(a.id);
        this.note(`Recovered the ${a.name} (${a.gradeLabel}) — ${a.site.place}.`, 'artifact');
      } else if (type === 'identified') {
        this.note(`Identified the properties of the ${a.name}.`, 'artifact');
      }
    });
  }

  // ------------------------------------------------------------------ creatures
  entry(sp) {
    let e = this.species.get(sp.id);
    if (!e) {
      const p = this.game.player.pos;
      e = {
        id: sp.id, first: this.game.gameTime, sightings: 0, observe: 0, facts: new Set(['family', 'appearance']),
        interactions: new Map(), habitats: new Set(), behaviours: new Set(), firstDepth: Math.max(0, -p.y),
        firstLayer: this.game.layerInfo ? this.game.layerInfo.layer : 0, call: false, maxSize: 0, minSize: 99, juveniles: false,
      };
      this.species.set(sp.id, e);
      this.emit('species', sp);
      this.note(`New species recorded: ${sp.name} (${FAMILY_LABEL[sp.family]}).`, 'creature');
    }
    return e;
  }

  known(spId) { return this.species.has(spId); }

  habitatText(a) {
    const W = this.game.world;
    const info = W.info(a.pos.x, a.pos.y, a.pos.z);
    const flags = W.flagsAt(a.pos.x, a.pos.z);
    const enclosed = W.ceilingAbove(a.pos.x, a.pos.y + 1, a.pos.z) < a.pos.y + 30;
    if (a.ceil) return 'the ceilings of the Inverted Forest';
    switch (a.band) {
      case 0:
        if (info.zone === Z_CITY) return (flags & CF.BUILDING) ? 'rooftops and walls of the city' : 'the streets and gardens of the city';
        if (info.zone === Z_COUNTRY) return (flags & CF.FIELD) ? 'farmland around the city' : 'the countryside around the city';
        if (flags & CF.CAVE) return 'caves of Layer 1';
        if (!Number.isNaN(W.columnAt(a.pos.x, a.pos.z).water)) return 'rivers and lakes of Layer 1';
        if (a.airborne) return 'the skies over Layer 1';
        return info.r < info.Re + 90 ? 'the steep slopes near the Eye' : 'the terraces and meadows of Layer 1';
      case 1: case 2: case 3:
        if (a.airborne) return 'the canopy air of the Inverted Forest';
        return enclosed ? 'the floor of the Inverted Forest' : 'gallery ledges open to the Abyss';
      case 4: return 'the Stone Plain';
      case 5: return 'the depths of the Great Fault';
      case 6: return 'the open air of the Abyss shaft';
      default: return 'the Abyss';
    }
  }

  sight(a, observing, dt) {
    const sp = a.sp;
    const e = this.entry(sp);
    e.sightings++;
    e.habitats.add(this.habitatText(a));
    e.maxSize = Math.max(e.maxSize, a.scale);
    e.minSize = Math.min(e.minSize, a.scale);
    if (a.juvenile) e.juveniles = true;
    if (observing) {
      const mul = 1 + (this.game.artifacts?.mods?.scholar || 0);
      const before = e.observe;
      e.observe = Math.min(FULL_OBSERVATION * 1.5, e.observe + dt * mul);
      for (const [k, t] of Object.entries(FACT_TIMES)) {
        if (before < t && e.observe >= t && !e.facts.has(k)) { e.facts.add(k); this.emit('fact', { sp, fact: k }); }
      }
      if (before < FULL_OBSERVATION && e.observe >= FULL_OBSERVATION) {
        this.stats.observations++;
        this.note(`Completed observations of the ${sp.name}.`, 'creature');
        this.emit('observed', sp);
      }
      const b = this.behaviourText(a);
      if (b && !e.behaviours.has(b)) { e.behaviours.add(b); this.emit('fact', { sp, fact: 'behaviour', text: b }); }
    }
  }

  behaviourText(a) {
    switch (a.state) {
      case 'forage': return a.target && FORAGE_TEXT[a.target.kind] ? FORAGE_TEXT[a.target.kind] : 'Forages';
      case 'flock': return a.sp.behavior.social === 'herd' ? 'Keeps close to its herd' : 'Travels with its group';
      case 'sleep': return 'Sleeps through its inactive hours';
      case 'follow': return 'Young follow their parent closely';
      case 'eat': return 'Feeds on its kill';
      case 'drink': return 'Drinks at streams and pools';
      case 'hunt': return 'Stalks and chases prey';
      case 'symbiosis': return 'Stays beside a larger host animal';
      default: return null;
    }
  }

  witness(spA, textA, spB, textB) {
    const add = (sp, text) => {
      if (!sp || !text) return false;
      const e = this.entry(sp);
      const it = e.interactions.get(text);
      if (it) { it.count++; return false; }
      e.interactions.set(text, { count: 1, t: this.game.gameTime });
      return true;
    };
    const n1 = add(spA, textA), n2 = add(spB, textB);
    if (n1 || n2) {
      this.stats.interactions++;
      const msg = `${spA.name}: ${textA.charAt(0).toLowerCase() + textA.slice(1)}`;
      this.note(`Observed — ${msg}.`, 'interaction');
      this.emit('interaction', { text: msg });
    }
  }

  canWitness(pos, maxD = 70) {
    const cam = this.game.camera.position;
    const d = cam.distanceTo(pos);
    if (d > maxD) return false;
    if (d < 18) return true;
    this._f.set(0, 0, -1).applyQuaternion(this.game.camera.quaternion);
    this._v.subVectors(pos, cam).normalize();
    if (this._v.dot(this._f) < 0.45) return false;
    return this.lineOfSight(cam, pos, d);
  }

  lineOfSight(from, to, d) {
    const W = this.game.world;
    const hit = W.raycast(from.x, from.y, from.z, to.x - from.x, to.y + 0.5 - from.y, to.z - from.z, d - 1, { step: 1.0 });
    return !hit || hit.kind === 'tree';
  }

  onEcoEvent(type, d) {
    if (!this.game.player || type === 'call') {
      if (type === 'call' && this.game.player) {
        const a = d.a;
        if (this.known(a.sp.id) && a.pos.distanceTo(this.game.player.pos) < 60) {
          const e = this.species.get(a.sp.id);
          if (!e.call) { e.call = true; this.emit('fact', { sp: a.sp, fact: 'call' }); }
        }
      }
      return;
    }
    const a = d.a;
    if (!a || !this.canWitness(a.pos, type === 'kill' || type === 'hunt' ? 90 : 60)) return;
    const name = (x) => (x && x.sp && x.sp.id >= 0 ? x.sp.name : null);
    // every creature taking part was seen where it lives
    for (const x of [a, d.prey, d.b, d.host, d.from]) {
      if (x && x.sp && x.sp.id >= 0 && x.pos && x.band !== undefined && (type !== 'call')) this.entry(x.sp).habitats.add(this.habitatText(x));
    }
    switch (type) {
      case 'hunt': case 'kill': {
        const [, ta, , tb] = INTERACTION_TEXT[type](a.sp.name, d.prey.sp.name);
        this.witness(a.sp, ta, d.prey.sp, tb);
        this.entry(a.sp).facts.add('diet');
        break;
      }
      case 'flee': {
        const from = name(d.from);
        if (d.from && d.from.sp && d.from.sp.id === -1) { this.witness(a.sp, 'Retreats from bright light'); break; }
        this.witness(a.sp, INTERACTION_TEXT.flee(a.sp.name, from)[1], d.from && d.from.sp && d.from.sp.id >= 0 ? d.from.sp : null, from ? `Feared by the ${a.sp.name}` : null);
        break;
      }
      case 'territorial': {
        const b = d.b;
        this.witness(a.sp, INTERACTION_TEXT.territorial(a.sp.name, b.sp === a.sp ? a.sp.name : b.sp.name)[1], b.sp !== a.sp ? b.sp : null, b.sp !== a.sp ? `Competes with the ${a.sp.name} for territory` : null);
        break;
      }
      case 'symbiosis': {
        const [, ta, , tb] = INTERACTION_TEXT.symbiosis(a.sp.name, d.host.sp.name);
        this.witness(a.sp, ta, d.host.sp, tb);
        break;
      }
      case 'forage': this.witness(a.sp, FORAGE_TEXT[d.kind] || 'Forages'); this.entry(a.sp).facts.add('diet'); break;
      case 'birth': {
        this.witness(a.sp, `Gives birth to ${a.sp.behavior.reproduction.litter > 1 ? 'litters of young' : 'a single offspring'}`);
        this.entry(a.sp).facts.add('reproduction');
        this.entry(a.sp).juveniles = true;
        break;
      }
      case 'court': case 'scavenge': case 'drink': case 'migrate': case 'sleep':
      case 'stalk-player': case 'charge-player': case 'attack-player':
        this.witness(a.sp, INTERACTION_TEXT[type](a.sp.name)[1]);
        break;
      default: break;
    }
  }

  /** Echo Pulse: every creature within r metres is sighted. */
  pulse(r) {
    const eco = this.game.ecosystem;
    if (!eco) return 0;
    const list = eco.agentsNear(this.game.player.pos, r);
    const seen = new Set();
    for (const a of list) { this.sight(a, false, 0); seen.add(a.sp.id); }
    return seen.size;
  }

  // ------------------------------------------------------------------ update
  update(dt) {
    const g = this.game, p = g.player;
    if (!p) return;
    this.timer -= dt;
    // the creature in the centre of view (for observing and the HUD)
    this.updateFocus(dt);
    if (this.timer <= 0) {
      this.timer = 0.3;
      this.scanCreatures(0.3);
    }
    this.lmTimer -= dt;
    if (this.lmTimer <= 0) {
      this.lmTimer = 0.5;
      this.scanLandmarks(p.pos);
      this.scanRoutes(p.pos);
      this.scanArtifacts(p.pos);
      this.scanLayer(p.pos);
    }
  }

  updateFocus(dt) {
    const eco = this.game.ecosystem, p = this.game.player;
    this.focus = null;
    if (!eco || p.mode === 'dead') return;
    const cam = this.game.camera.position;
    const f = this._f.set(0, 0, -1).applyQuaternion(this.game.camera.quaternion);
    const maxD = p.zoomed ? 160 : 50;
    let best = null, bs = Infinity;
    for (const a of eco.agents) {
      if (a.dead || !a.obj.mesh.visible) continue;
      const cx = a.pos.x - cam.x, cy = a.pos.y + a.scale * 0.4 - cam.y, cz = a.pos.z - cam.z;
      const d = Math.hypot(cx, cy, cz);
      if (d > maxD || d < 0.5) continue;
      const dot = (cx * f.x + cy * f.y + cz * f.z) / d;
      const ang = Math.acos(clamp(dot, -1, 1));
      const allowed = Math.atan2(Math.max(0.6, a.scale * 0.8), d) + (p.zoomed ? 0.02 : 0.05);
      if (ang > allowed) continue;
      const score = ang / allowed + d * 0.002;
      if (score < bs) { bs = score; best = a; }
    }
    if (best && !this.lineOfSight(cam, best.pos, cam.distanceTo(best.pos))) best = null;
    this.focus = best;
    if (best && p.zoomed) this.sight(best, true, dt);
  }

  scanCreatures(dt) {
    const eco = this.game.ecosystem;
    if (!eco) return;
    const cam = this.game.camera.position;
    const f = this._f.set(0, 0, -1).applyQuaternion(this.game.camera.quaternion);
    const cosHalf = Math.cos((this.game.camera.fov * Math.PI / 180) * 0.6);
    let checks = 0;
    for (const a of eco.agents) {
      if (a.dead || !a.obj.mesh.visible) continue;
      const dx = a.pos.x - cam.x, dy = a.pos.y - cam.y, dz = a.pos.z - cam.z;
      const d = Math.hypot(dx, dy, dz);
      const range = 35 + a.scale * 18;
      if (d > range) continue;
      if ((dx * f.x + dy * f.y + dz * f.z) / d < cosHalf) continue;
      const known = this.species.has(a.sp.id);
      if (known && a !== this.focus) { if (Math.random() < 0.3) this.sight(a, false, dt); continue; }
      if (checks++ > 6) break;
      if (this.lineOfSight(cam, a.pos, d)) this.sight(a, false, dt);
    }
  }

  scanLandmarks(pos) {
    for (const lm of this.plan.landmarks) {
      if (this.landmarks.has(lm.id)) continue;
      const R = LANDMARK_RADIUS[lm.type] || 60;
      const dy = Math.abs(lm.y - pos.y);
      if (dy > (LANDMARK_DY[lm.type] || 50)) continue;
      if (Math.hypot(lm.x - pos.x, lm.z - pos.z) > R) continue;
      this.landmarks.add(lm.id);
      this.note(`Discovered ${lm.name}.`, 'landmark');
      this.emit('landmark', lm);
    }
  }

  scanRoutes(pos) {
    const k = `${Math.floor(pos.x / 16)}:${Math.floor(pos.z / 16)}`;
    const list = this.routeCells.get(k);
    if (!list) return;
    for (let i = 0; i < list.length; i += 4) {
      const id = list[i];
      if (this.routes.has(id)) continue;
      if (Math.hypot(list[i + 1] - pos.x, list[i + 3] - pos.z) < 6 && Math.abs(list[i + 2] - pos.y) < 4) {
        this.routes.add(id);
        const r = this.routeById.get(id);
        this.note(`Found the ${r.name}.`, 'route');
        this.emit('route', r);
      }
    }
  }

  scanArtifacts(pos) {
    const arts = this.game.artifacts;
    if (!arts) return;
    for (const a of arts.list) {
      if (arts.collected.has(a.id) || this.spotted.has(a.id)) continue;
      const d = Math.hypot(a.site.x - pos.x, a.site.y - pos.y, a.site.z - pos.z);
      if (d > 28) continue;
      const cam = this.game.camera.position;
      const to = new THREE.Vector3(a.site.x, a.site.y + 0.6, a.site.z);
      if (d < 8 || this.lineOfSight(cam, to, cam.distanceTo(to))) {
        this.spotted.add(a.id);
        this.emit('spotted', a);
      }
    }
  }

  scanLayer(pos) {
    const info = this.game.layerInfo;
    if (!info) return;
    const li = info.layer;
    if (!this.layers.has(li)) {
      this.layers.add(li);
      const L = LAYERS[li];
      if (li > 0) this.note(`Entered the ${L.name} — ${L.title} — at a depth of ${Math.round(Math.max(0, -pos.y))} m.`, 'layer');
      this.emit('layer', { index: li, layer: L, first: true });
    }
    if (this.currentLayer !== li) {
      const prev = this.currentLayer;
      this.currentLayer = li;
      if (prev !== undefined) this.emit('layer-change', { index: li, prev, layer: LAYERS[li] });
    }
  }

  // ------------------------------------------------------------------ persistence
  serialize() {
    return {
      species: [...this.species.values()].map((e) => ({ ...e, facts: [...e.facts], interactions: [...e.interactions.entries()], habitats: [...e.habitats], behaviours: [...e.behaviours] })),
      landmarks: [...this.landmarks], layers: [...this.layers], routes: [...this.routes], spotted: [...this.spotted],
      found: [...this.found.entries()], log: this.log.slice(-120), stats: this.stats,
    };
  }

  restore(s) {
    if (!s) return;
    this.species = new Map((s.species || []).map((e) => [e.id, { ...e, facts: new Set(e.facts), interactions: new Map(e.interactions), habitats: new Set(e.habitats), behaviours: new Set(e.behaviours) }]));
    this.landmarks = new Set(s.landmarks || []);
    this.layers = new Set(s.layers || []);
    this.routes = new Set(s.routes || []);
    this.spotted = new Set(s.spotted || []);
    this.found = new Map(s.found || []);
    this.log = s.log || [];
    this.stats = { ...this.stats, ...(s.stats || {}) };
    this.currentLayer = undefined;
  }
}

export { FULL_OBSERVATION };
