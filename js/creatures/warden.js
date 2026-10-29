// The warden of the Throne Cup: the optional mini boss of Layer 4.
// An ancient, enormous goblet stalker sleeps in the shallow lake of the
// widest side cup. It wakes when the explorer wades into its lake or strikes
// it, and fights with a stomp that sends a wave through the water, volleys of
// glowing orbs and lunging charges; below half health it is enraged (faster,
// more orbs). It never leaves its cup: an explorer who climbs out is let go,
// and the warden returns to its throne and slowly heals. Nothing below needs
// it gone, but when it falls its lance rises from the lake.
import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { clamp } from '../core/mathutil.js';
import { G, individualGenes } from './genome.js';
import { glowTexture } from '../artifacts/artifactMesh.js';

export const WARDEN_HP = 850;
const SIZE = 3.4;             // how much larger than the largest of its kind

const _v = new THREE.Vector3();

export class Warden {
  constructor(eco) {
    this.eco = eco;
    this.game = eco.game;
    const L4 = eco.plan.layer4;
    this.info = L4 && L4.boss ? L4.boss : null;
    this.agent = null;
    this.hp = WARDEN_HP;
    this.state = 'dormant';
    this.stateT = 0;
    this.cool = 2;
    this.outT = 0;
    this.stunImmune = 0;
    this.enraged = false;
    this.rng = RNG.derive(eco.plan.seed, 'warden');
    if (this.info) {
      const gob = L4.goblets[this.info.goblet];
      const who = (gob.name || '').replace(/^The Throne of /, '') || 'the Throne';
      this.name = `${who}, Warden of the Throne`;
      this.center = new THREE.Vector3(this.info.x, this.info.y, this.info.z);
    }
    eco.on((t, d) => { if (t === 'slain' && this.agent && d.a === this.agent) this.fall(); });
  }

  get defeated() { return !!this.game.wardenDefeated; }
  /** Fighting (for the health bar and the music). */
  get engaged() { return !!this.agent && !this.agent.dead && this.state !== 'dormant' && this.state !== 'return'; }

  /** Appear when the explorer comes near the Throne Cup, go when it leaves. */
  update() {
    if (!this.info || this.defeated) return;
    const p = this.game.player;
    if (!p) return;
    const d = Math.hypot(p.pos.x - this.info.x, p.pos.z - this.info.z), dy = Math.abs(p.pos.y - this.info.y);
    if (!this.agent) {
      if (d < 175 && dy < 130) this.spawn();
      return;
    }
    if (this.agent.dead) return;
    if (d > 270 || dy > 210) {
      this.hp = Math.min(WARDEN_HP, this.agent.hp + WARDEN_HP * 0.25);
      this.eco.despawn(this.agent);
      this.agent = null;
      this.state = 'dormant';
    }
  }

  spawn() {
    const eco = this.eco;
    // the stalker of the goblets, else any hunter of the layer, else anything of it
    const L4sp = eco.sp.filter((S) => S.s.layer === 'layer4');
    const S = L4sp.find((S2) => S2.s.niche === 'goblet_stalker') || L4sp.find((S2) => S2.s.behavior.diet === 'carnivore' && S2.s.behavior.habitat === 'ground') || L4sp[0] || eco.sp[0];
    if (!S) return;
    // it stands tall: a sprawling kind rises onto six legs
    const sp = S.s.plan === 'sprawler' || S.s.plan === 'hopper' || S.s.plan === 'strider' ? Object.assign(Object.create(Object.getPrototypeOf(S.s)), S.s, { plan: 'hexapod', legPairs: 3 }) : S.s;
    const genes = individualGenes(S.s, this.rng, 0);
    const c = genes.c;
    // an old one: the largest, fiercest and brightest of its kind
    // and no longer a pretty one: dark, heavy-jawed, small-eyed and spined
    for (const [k, v] of [['size', 1], ['aggression', 1], ['boldness', 1], ['glow', 0.95], ['hornLen', 0.95], ['crestSize', 0.9], ['spikeLen', 0.9], ['spikeCount', 0.9], ['jaw', 1], ['snout', 0.8], ['headSize', 0.7], ['headLong', 0.85], ['mouthW', 0.95], ['eyeSize', 0.2], ['cute', 0], ['chestMass', 1], ['limbChunk', 0.9], ['legThick', 0.85], ['legLen', 0.65], ['tailThick', 0.8], ['plates', 0.9], ['light', 0.22], ['sat', 0.45], ['light2', 0.35], ['patternContrast', 1], ['patternScale', 0.6]]) if (G[k] !== undefined) c[G[k]] = v;
    const fam = S.s.family;
    if (fam !== 'bird' && S.s.plan !== 'bat') genes.a.horns = fam === 'mammal' ? 'curved' : 'crown';
    genes.a.crest = fam === 'bird' ? 'casque' : 'spikes';
    genes.a.spikeRows = 2;
    genes.a.tailTip = fam === 'bird' ? genes.a.tailTip : 'club';
    genes.a.pattern = 'ocelli';
    const f = eco.hab.floorNear(this.info.x, this.info.y, this.info.z, 6, 1);
    const pos = { x: this.info.x, y: f ? f.y : this.info.y - 0.7, z: this.info.z, mode: 'ground' };
    const a = eco.spawn(sp === S.s ? S : { ...S, s: sp }, pos, genes, { age: S.s.behavior.reproduction.maturity * 6 });
    a.boss = true;
    a.keep = true;
    a.ageScale = SIZE;
    a.scale = a.ph.scale * SIZE;
    a.maxHp = WARDEN_HP;
    a.hp = this.hp;
    a.state = 'sleep';
    a.yaw = this.rng.range(-Math.PI, Math.PI);
    a.home = { pos: this.center.clone(), kind: 'throne' };
    a.wardenName = this.name;
    this.agent = a;
    this.state = 'dormant';
    this.stateT = 0;
    this.enraged = a.hp < WARDEN_HP * 0.5;
  }

  /**
   * The warden is no ordinary stalker: a crown of glowing crystal grows from
   * its head and twin rows of shards from its back (they move with its bones).
   */
  adorn(a, cr) {
    const rig = cr.rig, bone = (n) => (rig.named[n] !== undefined ? rig.bones[rig.named[n]] : null);
    const ph = a.ph, S = ph.scale, B = ph.body;
    const T = ((B.girth + B.height) / 2) * S * 0.62;
    const hs = Math.max(T * 0.6, (ph.head ? ph.head.size : 0.3) * S * 0.5);
    const mat = this.adornMat || (this.adornMat = new THREE.MeshLambertMaterial({ color: 0x48e6f2, emissive: 0x18b4c8, emissiveIntensity: 1.5 }));
    const geo = this.adornGeo || (this.adornGeo = new THREE.ConeGeometry(1, 1, 5).translate(0, 0.5, 0));
    const add = (b, x, y, z, h, r, rx, rz) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(r, h, r); m.rotation.set(rx, 0, rz); b.add(m); return m; };
    const head = bone('head');
    if (head) {
      for (let i = 0; i < 5; i++) { const t = (i - 2) / 2; add(head, t * hs * 0.7, hs * 0.95, -hs * 0.2, hs * (2.3 - Math.abs(t) * 0.8), hs * 0.14, -0.55, -t * 0.6); }
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x5ff2e0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85 }));
      halo.position.set(0, hs * 2, -hs * 0.5);
      halo.scale.setScalar(hs * 4.5);
      head.add(halo);
    }
    let k = 0;
    for (const nm of ['chest', 'spine2', 'spine1', 'hips', 'tail1']) {
      const b = bone(nm);
      if (!b) continue;
      const h = T * (2.1 - k * 0.3);
      for (const sd of [-1, 1]) add(b, sd * T * 0.4, T * 0.95, 0, h, T * 0.17, -0.45, -sd * 0.35);
      k++;
    }
  }

  fall() {
    this.game.wardenDefeated = true;
    this.state = 'dead';
    this.eco.emit('boss-slain', { a: this.agent, name: this.name });
  }

  set(st) { this.state = st; this.stateT = 0; this.did = false; }

  /** Thinking and moving of the warden, every frame it lives (instead of the common brain). */
  live(a, dt) {
    const eco = this.eco, p = this.game.player, pp = p.pos, info = this.info;
    const combat = this.game.combat;
    this.stateT += dt;
    this.cool -= dt;
    this.stunImmune = Math.max(0, this.stunImmune - dt);
    if (a.frozenT > 0) a.frozenT -= dt;
    // stuns are brief, and it shakes the next one off
    if (a.stunT > 0) {
      if (this.stunImmune > 0 && !(a.frozenT > 0)) a.stunT = 0;
      else {
        if (!this.stunned) { this.stunned = true; this.stunImmune = 7; a.stunT = Math.min(a.stunT, a.frozenT > 0 ? 2 : 1.2); }
        a.stunT -= dt; a.speed = 0; a.action = 'idle';
        return;
      }
    }
    this.stunned = false;
    const dx = pp.x - a.pos.x, dz = pp.z - a.pos.z, dP = Math.hypot(dx, dz);
    const inCup = Math.hypot(pp.x - info.x, pp.z - info.z) < info.r + 4 && Math.abs(pp.y - info.y) < 14;
    const alive = p.mode !== 'dead';
    const awake = this.state !== 'dormant' && this.state !== 'return';
    if (awake && !this.enraged && a.hp < a.maxHp * 0.5) { this.enraged = true; eco.emit('boss-enrage', { a, name: this.name }); eco.call(a, 'threat'); }
    const fury = this.enraged ? 1.35 : 1;
    const st = a.ph.stats;
    const walk = clamp(st.walk * 1.6, 3.4, 5.2), run = clamp(st.run * 2.4, 12, 18);
    let goal = null, speed = 0;
    a.action = 'idle';
    switch (this.state) {
      case 'dormant':
        a.state = 'sleep';
        a.hp = Math.min(a.maxHp, a.hp + a.maxHp * 0.01 * dt);
        if (alive && ((inCup && dP < info.r * 0.8) || a.hurtT > 0)) { this.set('wake'); eco.emit('boss-wake', { a, name: this.name }); eco.call(a, 'threat'); }
        break;
      case 'wake':
        a.state = 'warden';
        a.action = this.stateT < 1.6 ? 'call' : 'display';
        a.lookAt = pp;
        this.face(a, dx, dz, dt, 2);
        if (this.stateT > 2.4) { this.set('fight'); this.cool = 0.8; }
        break;
      case 'fight': {
        a.state = 'warden';
        a.lookAt = pp;
        if (!alive) { this.set('return'); break; }
        this.outT = inCup ? 0 : this.outT + dt;
        if (this.outT > 7) { this.set('return'); eco.emit('boss-leave', { a, name: this.name }); break; }
        if (this.cool <= 0 && inCup) {
          if (dP < 8 + a.scale * 0.2) { this.set('slam'); break; }
          if (dP > 11 && dP < 36 && this.rng.chance(0.45)) { this.set('charge'); this.dir = new THREE.Vector3(dx / dP, 0, dz / dP); break; }
          if (dP < 60) { this.set('volley'); break; }
        }
        if (dP > 6 + a.scale * 0.25) { goal = _v.set(pp.x, a.pos.y, pp.z); speed = walk * fury; }
        else this.face(a, dx, dz, dt, 3);
        a.action = dP < 14 ? 'display' : 'idle';
        break;
      }
      case 'slam': {
        a.state = 'warden';
        const wind = this.enraged ? 0.6 : 0.85;
        a.action = this.stateT < wind ? 'display' : 'attack';
        this.face(a, dx, dz, dt, 4);
        if (this.stateT >= wind && !this.did) {
          this.did = true;
          const R = 9 + a.scale * 0.4;
          if (combat) { combat.ring(a.pos, R, 0x5ff2e0, 0.6); combat.ring(a.pos, R * 0.6, 0xbffcff, 0.4); }
          eco.emit('boss-slam', { a, pos: a.pos.clone() });
          if (alive && dP < R && pp.y - a.pos.y < 3.2) {
            const k = 1 - dP / R;
            p.vel.x += (dx / Math.max(dP, 0.1)) * (6 + 8 * k); p.vel.z += (dz / Math.max(dP, 0.1)) * (6 + 8 * k);
            p.vel.y = Math.max(p.vel.y, 5); p.onGround = false;
            p.hurt(Math.round((14 + 12 * k) * (this.enraged ? 1.2 : 1)), 'creature', a);
          }
          p.landDip += 0.18;
        }
        if (this.stateT > wind + 0.7) { this.set('fight'); this.cool = this.enraged ? 1.3 : 2.1; }
        break;
      }
      case 'volley': {
        a.state = 'warden';
        a.action = 'call';
        a.lookAt = pp;
        this.face(a, dx, dz, dt, 3);
        const wind = this.enraged ? 0.45 : 0.65;
        if (this.stateT >= wind && !this.did && combat) {
          this.did = true;
          const n = this.enraged ? 5 : 3;
          const from = new THREE.Vector3(a.pos.x + Math.sin(a.yaw) * a.scale * 0.35, a.pos.y + a.scale * 0.75, a.pos.z + Math.cos(a.yaw) * a.scale * 0.35);
          for (let i = 0; i < n; i++) {
            const flight = 0.95 + i * 0.14;
            const to = new THREE.Vector3(pp.x + p.vel.x * flight * 0.7 + this.rng.range(-1.8, 1.8), pp.y + 0.8, pp.z + p.vel.z * flight * 0.7 + this.rng.range(-1.8, 1.8));
            combat.hurl(from, to, { dmg: 11, flight, source: a, size: 1.0 + this.rng.range(0, 0.3) });
          }
          eco.emit('boss-volley', { a, pos: from });
        }
        if (this.stateT > wind + 0.6) { this.set('fight'); this.cool = this.enraged ? 2.0 : 3.2; }
        break;
      }
      case 'charge': {
        a.state = 'charge';
        const wind = 0.55;
        if (this.stateT < wind) {
          a.action = 'display';
          this.dir.set(dx, 0, dz).normalize();
          this.face(a, dx, dz, dt, 5);
        } else {
          a.action = 'attack';
          goal = _v.copy(a.pos).addScaledVector(this.dir, 10);
          speed = run * fury;
          if (!this.did && alive && dP < 2 + a.scale * 0.45 && Math.abs(pp.y - a.pos.y) < 3.5) {
            this.did = true;
            p.vel.x += this.dir.x * 14; p.vel.z += this.dir.z * 14; p.vel.y = Math.max(p.vel.y, 5); p.onGround = false;
            p.hurt(Math.round(20 * (this.enraged ? 1.2 : 1)), 'creature', a);
            eco.emit('boss-charge-hit', { a });
          }
          if (this.stateT > wind + 1.4 || this.atEdge) { this.set('fight'); this.cool = this.enraged ? 1.6 : 2.6; }
        }
        break;
      }
      case 'return':
        a.state = 'roost';
        a.hp = Math.min(a.maxHp, a.hp + a.maxHp * 0.01 * dt);
        if (Math.hypot(a.pos.x - info.x, a.pos.z - info.z) > 3) { goal = _v.set(info.x, a.pos.y, info.z); speed = walk; }
        else { this.set('dormant'); this.enraged = a.hp < a.maxHp * 0.5; }
        if (alive && inCup && dP < info.r * 0.5 && this.stateT > 3) this.set('fight');
        break;
      default: break;
    }
    this.move(a, goal, speed, dt);
    // growls between blows
    a.calling = Math.max(0, a.calling - dt);
    a.callT -= dt;
    if (a.callT <= 0) { a.callT = 5 + this.rng.range(0, 6); if (awake) eco.call(a, 'threat'); }
  }

  face(a, dx, dz, dt, rate) {
    let d = Math.atan2(dx, dz) - a.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = clamp(d, -rate * dt, rate * dt);
    a.yaw += step;
    a.turn = step / Math.max(dt, 1e-3);
  }

  /** Walk on the lake bed toward the goal, never out of the cup. */
  move(a, goal, speed, dt) {
    const info = this.info;
    this.atEdge = false;
    if (!goal || speed <= 0) { a.speed *= Math.max(0, 1 - dt * 6); return; }
    const dx = goal.x - a.pos.x, dz = goal.z - a.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.2) { a.speed = 0; return; }
    this.face(a, dx, dz, dt, this.state === 'charge' ? 1.2 : 2.6);
    const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
    const v = Math.min(speed, d / Math.max(dt, 1e-3));
    let nx = a.pos.x + fx * v * dt, nz = a.pos.z + fz * v * dt;
    const ox = nx - info.x, oz = nz - info.z, od = Math.hypot(ox, oz), lim = info.r - 1 - a.scale * 0.3;
    if (od > lim) { nx = info.x + ox / od * lim; nz = info.z + oz / od * lim; this.atEdge = true; }
    const f = this.eco.hab.floorNear(nx, a.pos.y + 0.5, nz, 3, 1);
    if (f) { a.pos.set(nx, f.y, nz); a.speed = v; }
    else { a.speed = 0; this.atEdge = true; }
  }

  serialize() { return { hp: this.agent && !this.agent.dead ? Math.round(this.agent.hp) : Math.round(this.hp) }; }
  restore(s) { if (s && Number.isFinite(s.hp)) this.hp = clamp(s.hp, 1, WARDEN_HP); }
}
