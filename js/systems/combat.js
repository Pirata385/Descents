// Combat. The explorer fights with the artifact in hand, or with the
// delver's pick when nothing is wielded: melee weapons swing at what is in
// front, casters loose bolts or fans of shards, and the gamma lance pours out
// a continuous ray that heats up. Elements ride on the blows (ember burns,
// frost slows, spark arcs to a second creature, venom poisons).
// Artifact abilities add offensive powers (gamma ray, shockwave, thornburst,
// stasis) and defensive ones (aegis, phase step, mend, repel).
// Damage to the explorer passes through absorb() first: phase, the aegis
// shield, armour and thorns.
import * as THREE from 'three';
import { WEAPONS } from '../artifacts/artifactGen.js';
import { buildArtifactModel, glowTexture } from '../artifacts/artifactMesh.js';
import { clamp } from '../core/mathutil.js';

export const BASE_WEAPON = { type: 'pick', power: 1, element: null };
// the pick every delver carries
const PICK_ART = {
  name: "Delver's pick", color: [0.42, 0.4, 0.38], accent: [0.66, 0.62, 0.55], material: 'iron', glow: 0,
  shape: { archetype: 'pick', a: 0.4, b: 0.5, c: 0.5, d: 0.5, segments: 5, twist: 0, symmetry: 4, inlay: false, spikes: false, rings: 2 },
};
export const ELEMENT_COLOR = { ember: 0xff7a2a, frost: 0x9fdcff, spark: 0xe2ecff, venom: 0x9cff5a };
const SWING = 0.32;         // seconds of a swing; the blow lands early in it
const HIT_AT = 0.09;

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);

/** Middle of a creature's body and its rough radius (for hit tests). */
export function bodyCenter(a, out) {
  const h = a.scale * 0.42;
  if (a.mode === 'ceiling' || a.mode === 'hang') return out.set(a.pos.x, a.pos.y - h, a.pos.z);
  if (a.mode === 'wall') return out.set(a.pos.x + a.up.x * h, a.pos.y + a.up.y * h, a.pos.z + a.up.z * h);
  return out.set(a.pos.x, a.pos.y + h, a.pos.z);
}
export const bodyRadius = (a) => Math.max(0.25, a.scale * 0.48);

/** Distance from point c to the segment o + d·t, t in [0, len]; also returns t in res. */
function segDist(c, o, d, len, res) {
  const t = clamp((c.x - o.x) * d.x + (c.y - o.y) * d.y + (c.z - o.z) * d.z, 0, len);
  res.t = t;
  return Math.hypot(c.x - (o.x + d.x * t), c.y - (o.y + d.y * t), c.z - (o.z + d.z * t));
}

export class Combat {
  constructor(game) {
    this.game = game;
    this.cool = 0;
    this.heat = 0;
    this.overheated = false;
    this.swingT = -1;
    this.swingHit = false;
    this.recoil = 0;
    this.drawnT = 0;
    this.show = 0;
    this.shots = [];
    this.hostile = [];
    this.fx = [];
    this.ray = null;          // the gamma ray of an ability: { t, dps, radius, range }
    this.firing = false;      // the beam weapon is pouring
    this.shield = 0; this.shieldMax = 0; this.shieldT = 0;
    this.phaseT = 0;
    this.mendT = 0; this.mendRate = 0;
    this.target = null; this.targetT = 0;
    this.hitT = 0; this.killT = 0;
    this.rayAcc = new Map();
    this.rayFlush = 0;
    this.listeners = [];
    this.res = { t: 0 };
    this.buildVisuals();
  }

  on(fn) { this.listeners.push(fn); }
  emit(t, d) { for (const fn of this.listeners) fn(t, d); }

  get mods() { return (this.game.artifacts && this.game.artifacts.mods) || {}; }
  /** The wielded artifact (null: the delver's pick). */
  get art() { return this.game.artifacts ? this.game.artifacts.wieldedArt() : null; }
  get weapon() { const a = this.art; return (a && a.weapon) || BASE_WEAPON; }
  get W() { return WEAPONS[this.weapon.type] || WEAPONS.pick; }
  get label() { const a = this.art; return a ? a.name : PICK_ART.name; }
  get drawn() { return this.drawnT > 0; }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    const g = this.game, p = g.player, inp = g.input;
    if (!p) return;
    const mods = this.mods;
    const haste = 1 + (mods.haste || 0);
    this.cool = Math.max(0, this.cool - dt * haste);
    this.hitT = Math.max(0, this.hitT - dt);
    this.killT = Math.max(0, this.killT - dt);
    this.targetT = Math.max(0, this.targetT - dt);
    this.recoil = Math.max(0, this.recoil - dt * 6);
    if (this.drawnT > 0) this.drawnT -= dt;
    if (this.phaseT > 0) this.phaseT -= dt;
    if (this.shieldT > 0) {
      this.shieldT -= dt;
      if (this.shieldT <= 0) { this.shield = 0; this.emit('shield-end'); }
    }
    if (this.mendT > 0) { this.mendT -= dt; if (p.mode !== 'dead') p.health = Math.min(p.maxHealth, p.health + this.mendRate * dt); }
    if (p.mode === 'dead') { this.shield = 0; this.shieldT = 0; this.ray = null; this.mendT = 0; }
    const W = this.W, w = this.weapon;
    const can = !g.uiBlocking && p.mode !== 'dead' && p.mode !== 'climb' && !p.zoomed && !p.mantle;
    const press = can && (inp.clicked & 1) !== 0;
    const hold = can && ((inp.buttons & 1) !== 0 || inp.is('attack'));
    if (press) this.drawnT = Math.max(this.drawnT, 8);
    // weapon switch
    if (inp.was('weapon') && !g.uiBlocking && g.artifacts) g.artifacts.cycleWeapon();
    this.firing = false;
    if (W.kind === 'beam') {
      if (this.overheated) {
        this.heat = Math.max(0, this.heat - W.cool * dt);
        if (this.heat < 25) { this.overheated = false; this.emit('cooled'); }
      } else if (hold || press) {
        this.firing = true;
        this.drawnT = Math.max(this.drawnT, 6);
        this.heat += W.heat * dt / haste;
        if (this.heat >= 100) { this.heat = 100; this.overheated = true; this.emit('overheat'); }
        this.pour(W.dps * w.power * (1 + (mods.might || 0)), W.range, 0.35, dt, w.element);
      } else this.heat = Math.max(0, this.heat - W.cool * dt);
    } else if (W.kind === 'shot') {
      if ((press || hold) && this.cool <= 0) this.shoot(W, w, mods);
    } else if ((press || hold) && this.cool <= 0 && this.swingT < 0) {
      this.swingT = 0;
      this.swingHit = false;
      this.cool = W.rate;
      this.drawnT = Math.max(this.drawnT, 8);
      this.emit('swing', { heavy: W.knock > 5 || W.dmg > 20, kind: this.weapon.type });
    }
    if (this.swingT >= 0) {
      this.swingT += dt * haste;
      if (!this.swingHit && this.swingT >= HIT_AT) { this.swingHit = true; this.melee(W, w, mods); }
      if (this.swingT > SWING) this.swingT = -1;
    }
    // the ray of the gamma ability
    if (this.ray) {
      this.ray.t -= dt;
      if (this.ray.t <= 0 || p.mode === 'dead') { this.ray = null; this.emit('ray-end'); }
      else { this.drawnT = Math.max(this.drawnT, 4); this.pour(this.ray.dps, this.ray.range, this.ray.radius, dt, 'ember'); }
    }
    this.flushRay(dt, false);
    this.updateShots(dt);
    this.updateHostile(dt);
    this.updateFx(dt);
    this.updateVisuals(dt);
  }

  // ------------------------------------------------------------------ hitting creatures
  /** Strike one creature: damage, element, knock-back, leech and the HUD's target. */
  strike(a, dmg, o = {}) {
    const eco = this.game.ecosystem;
    if (!eco || !a || a.dead) return false;
    const opts = { from: 'player', knock: o.knock, stun: o.stun };
    const el = o.element;
    if (el === 'ember') opts.burn = 4;
    if (el === 'frost') opts.slow = 4;
    if (el === 'venom') opts.poison = 6;
    const killed = eco.damage(a, dmg, opts);
    const leech = this.mods.leech || 0;
    const p = this.game.player;
    if (leech > 0 && p.mode !== 'dead') p.health = Math.min(p.maxHealth, p.health + dmg * leech);
    this.target = a; this.targetT = 4;
    this.hitT = 0.14;
    if (killed) this.killT = 0.45;
    bodyCenter(a, _v3);
    this.burst(_v3, el ? ELEMENT_COLOR[el] : 0xffe6b0, killed ? 14 : 6);
    this.emit(killed ? 'kill' : 'hit', { a, dmg, pos: _v3.clone(), boss: !!a.boss });
    // spark: the blow arcs to the nearest other creature
    if (el === 'spark' && !o.chained) {
      let best = null, bd = 8;
      for (const b of eco.agents) {
        if (b === a || b.dead) continue;
        const d = b.pos.distanceTo(a.pos);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) {
        const from = _v3.clone(), to = bodyCenter(best, new THREE.Vector3());
        this.arc(from, to);
        this.strike(best, dmg * 0.6, { element: 'spark', chained: true });
      }
    }
    return killed;
  }

  /** Creatures in a cone in front of the eye that the swing reaches. */
  melee(W, w, mods) {
    const g = this.game, eco = g.ecosystem, cam = g.camera;
    if (!eco) return;
    const eye = cam.position;
    const fwd = _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const hits = [];
    for (const a of eco.agents) {
      if (a.dead) continue;
      const c = bodyCenter(a, _v2), r = bodyRadius(a);
      _v3.subVectors(c, eye);
      const d = _v3.length();
      if (d - r > W.range || d < 1e-3) continue;
      const ang = Math.acos(clamp(_v3.dot(fwd) / d, -1, 1));
      if (ang - Math.atan2(r, Math.max(0.3, d)) > W.arc) continue;
      if (d > 1.6 && g.world.raycast(eye.x, eye.y, eye.z, _v3.x, _v3.y, _v3.z, d - r * 0.6, { step: 0.35 })) continue;
      hits.push({ a, s: ang * 2 + d * 0.15 });
    }
    hits.sort((x, y) => x.s - y.s);
    const list = W.sweep ? hits.slice(0, 4) : hits.slice(0, 1);
    const dmg = W.dmg * w.power * (1 + (mods.might || 0));
    const fh = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
    for (const { a } of list) {
      // the chain flail drags creatures in, everything else shoves them away
      const knock = fh.clone().multiplyScalar(W.knock * 2.6);
      this.strike(a, dmg * (0.85 + Math.random() * 0.3), { knock, stun: W.stun, element: w.element });
    }
    if (!list.length) this.emit('whiff');
  }

  shoot(W, w, mods) {
    const g = this.game, cam = g.camera;
    const fwd = _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const tip = this.tip(new THREE.Vector3());
    // aim from the tip at what the crosshair covers
    const hit = g.world.raycast(cam.position.x, cam.position.y, cam.position.z, fwd.x, fwd.y, fwd.z, 120, { step: 0.5 });
    const aim = cam.position.clone().addScaledVector(fwd, hit ? hit.dist : 120);
    const base = aim.sub(tip).normalize();
    const dmg = W.dmg * w.power * (1 + (mods.might || 0));
    for (let i = 0; i < W.count; i++) {
      const d = base.clone();
      if (W.spread) { d.x += (Math.random() - 0.5) * W.spread * 2; d.y += (Math.random() - 0.5) * W.spread * 2; d.z += (Math.random() - 0.5) * W.spread * 2; d.normalize(); }
      this.addShot(this.shots, tip, d.multiplyScalar(W.speed * (0.92 + Math.random() * 0.16)), { dmg, grav: W.grav, life: 3, element: w.element, size: W.count > 1 ? 0.22 : 0.36 });
    }
    this.cool = W.rate;
    this.recoil = 1;
    this.drawnT = Math.max(this.drawnT, 8);
    this.emit('shot', { kind: this.weapon.type });
  }

  addShot(list, pos, vel, o) {
    const col = o.color ?? (o.element ? ELEMENT_COLOR[o.element] : 0xfff0c8);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.scale.setScalar(o.size || 0.3);
    sp.position.copy(pos);
    this.scene.add(sp);
    list.push({ pos: pos.clone(), vel, mesh: sp, ...o });
  }

  removeShot(s) {
    this.scene.remove(s.mesh);
    s.mesh.material.dispose();
    s.dead = true;
  }

  updateShots(dt) {
    if (!this.shots.length) return;
    const g = this.game, eco = g.ecosystem, W = g.world;
    const prev = new THREE.Vector3(), dir = new THREE.Vector3();
    for (const s of this.shots) {
      prev.copy(s.pos);
      s.vel.y -= (s.grav || 0) * dt;
      s.pos.addScaledVector(s.vel, dt);
      s.life -= dt;
      dir.subVectors(s.pos, prev);
      const len = dir.length();
      if (len > 1e-4) dir.divideScalar(len);
      // creatures along the way
      let hitA = null, ht = Infinity;
      if (eco) for (const a of eco.agents) {
        if (a.dead) continue;
        const c = bodyCenter(a, _v2);
        if (Math.abs(c.x - prev.x) > len + 6 || Math.abs(c.z - prev.z) > len + 6) continue;
        if (segDist(c, prev, dir, len, this.res) < bodyRadius(a) + 0.12 && this.res.t < ht) { ht = this.res.t; hitA = a; }
      }
      const rock = W.raycast(prev.x, prev.y, prev.z, dir.x, dir.y, dir.z, Math.min(len, hitA ? ht : len), { step: 0.3 });
      if (rock) {
        _v3.set(rock.x, rock.y, rock.z);
        this.burst(_v3, s.element ? ELEMENT_COLOR[s.element] : 0xffd9a0, 5);
        this.emit('impact', { pos: _v3.clone() });
        this.removeShot(s);
        continue;
      }
      if (hitA) {
        const knock = new THREE.Vector3(dir.x, 0, dir.z).normalize().multiplyScalar(3);
        this.strike(hitA, s.dmg, { knock, element: s.element });
        this.removeShot(s);
        continue;
      }
      if (s.life <= 0) { this.removeShot(s); continue; }
      s.mesh.position.copy(s.pos);
    }
    this.shots = this.shots.filter((s) => !s.dead);
  }

  /**
   * A continuous ray from the eye along the view: it damages every creature it
   * passes through up to the first rock. Damage is gathered per creature and
   * dealt in small doses (each one a blow they react to).
   */
  pour(dps, range, radius, dt, element) {
    const g = this.game, eco = g.ecosystem, cam = g.camera;
    const o = cam.position, d = _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const rock = g.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, range, { step: 0.5 });
    const len = rock ? rock.dist : range;
    this.rayEnd = (this.rayEnd || new THREE.Vector3()).copy(o).addScaledVector(d, len);
    this.rayRock = !!rock;
    this.rayOn = true;
    this.rayWide = radius;
    this.rayEl = element;
    if (!eco) return;
    for (const a of eco.agents) {
      if (a.dead) continue;
      const c = bodyCenter(a, _v2);
      if (segDist(c, o, d, len, this.res) < bodyRadius(a) + radius) this.rayAcc.set(a, (this.rayAcc.get(a) || 0) + dps * dt);
    }
  }

  flushRay(dt, force) {
    this.rayFlush -= dt;
    if (this.rayFlush > 0 && !force) return;
    this.rayFlush = 0.15;
    for (const [a, dmg] of this.rayAcc) if (!a.dead && dmg > 0) this.strike(a, dmg, { element: this.rayEl === 'ember' ? 'ember' : this.rayEl });
    this.rayAcc.clear();
  }

  // ------------------------------------------------------------------ abilities
  /** An offensive or defensive artifact ability. Returns false if it could not be used. */
  ability(art) {
    const A = art.ability, pw = A.power || 1;
    const g = this.game, p = g.player, eco = g.ecosystem, cam = g.camera;
    const might = 1 + (this.mods.might || 0);
    const fwd = _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const fh = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (fh.lengthSq() < 1e-4) fh.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    fh.normalize();
    switch (A.type) {
      case 'gamma':
        this.ray = { t: 3, dps: 58 * pw * might, radius: 0.7, range: 90 };
        break;
      case 'shockwave': {
        const R = 7 + 4 * pw;
        if (eco) for (const a of eco.agents) {
          if (a.dead) continue;
          const c = bodyCenter(a, _v2);
          const d = c.distanceTo(p.pos);
          if (d > R + bodyRadius(a)) continue;
          const k = 1 - clamp(d / R, 0, 1);
          const out = new THREE.Vector3(c.x - p.pos.x, 0, c.z - p.pos.z);
          if (out.lengthSq() < 1e-4) out.copy(fh);
          out.normalize().multiplyScalar(8 + 14 * k);
          this.strike(a, (8 + 14 * k) * pw * might, { knock: out, stun: 1 + pw * 0.6 });
        }
        this.ring(p.pos, R, 0xbfe4ff, 0.55);
        p.landDip += 0.12;
        break;
      }
      case 'thornburst': {
        const pts = [];
        for (let i = 0; i < 12; i++) {
          const x = p.pos.x + fh.x * (3 + i * 1.3), z = p.pos.z + fh.z * (3 + i * 1.3);
          const hit = g.world.raycast(x, p.pos.y + 3, z, 0, -1, 0, 14, { step: 0.4 });
          if (!hit) continue;
          pts.push(new THREE.Vector3(hit.x, hit.y, hit.z));
          // they grow taller away from the bearer, so the view stays clear
          this.spike(hit.x, hit.y, hit.z, i * 0.035, (0.5 + pw * 0.4) * (0.45 + 0.55 * i / 11));
        }
        if (eco) for (const a of eco.agents) {
          if (a.dead) continue;
          const c = bodyCenter(a, _v2);
          if (pts.some((q) => Math.hypot(q.x - c.x, q.z - c.z) < 1.6 + bodyRadius(a) && c.y - q.y < 3.5 + a.scale * 0.5 && c.y - q.y > -1.5)) this.strike(a, 20 * pw * might, { stun: 2.5 });
        }
        if (!pts.length) return false;
        break;
      }
      case 'stasis': {
        let n = 0;
        if (eco) for (const a of eco.agents) {
          if (a.dead) continue;
          const c = bodyCenter(a, _v2);
          _v3.subVectors(c, cam.position);
          const d = _v3.length();
          if (d > 30) continue;
          const ang = Math.acos(clamp(_v3.dot(fwd) / Math.max(d, 1e-3), -1, 1));
          if (ang - Math.atan2(bodyRadius(a), Math.max(0.5, d)) > 0.55) continue;
          const T = (4 + pw * 1.5) * (a.boss ? 0.3 : 1);
          a.stunT = Math.max(a.stunT, T);
          a.frozenT = Math.max(a.frozenT || 0, T);
          this.frost(a, T);
          this.target = a; this.targetT = 4;
          eco.provoke(a);
          n++;
        }
        this.ring(p.pos, 6, 0x9fdcff, 0.4);
        void n;
        break;
      }
      case 'aegis':
        this.shieldMax = this.shield = Math.round(35 + 55 * pw);
        this.shieldT = 10;
        break;
      case 'phase':
        p.vel.x = fh.x * 20; p.vel.z = fh.z * 20; p.vel.y = Math.max(p.vel.y, 3.5);
        p.onGround = false;
        this.phaseT = 0.7;
        break;
      case 'mend':
        this.mendT = 6; this.mendRate = (30 + 40 * pw) / 6;
        break;
      case 'repel':
        if (eco) for (const a of eco.agents) {
          if (a.dead || a.pos.distanceTo(p.pos) > 32) continue;
          if (a.boss) { a.stunT = Math.max(a.stunT, 1); continue; }
          a.needs.fear = 1; a.thinkT = 0;
          a.avoid = a.avoid || new THREE.Vector3(); a.avoid.copy(p.pos); a.avoidT = 25;
          if (a.state === 'retaliate' || a.state === 'stalk' || a.state === 'charge') { a.state = 'flee'; a.timer = 6; a.target = { agent: eco.playerAgent }; }
        }
        this.ring(p.pos, 32, 0x6a3cff, 0.9);
        break;
      default: return false;
    }
    this.drawnT = Math.max(this.drawnT, 3);
    this.emit('ability', { type: A.type, art });
    return true;
  }

  // ------------------------------------------------------------------ the explorer is hurt
  /** Damage after phase, shield and armour; thorns answer creatures that bite. */
  absorb(amount, cause, source) {
    if (cause === 'void' || !(amount > 0)) return amount;
    const fall = cause === 'fall';
    if (this.phaseT > 0 && !fall) return 0;
    const mods = this.mods;
    const raw = amount;
    if (!fall && mods.armor) amount *= 1 - clamp(mods.armor, 0, 0.75);
    if (!fall && this.shield > 0) {
      const s = Math.min(this.shield, amount);
      this.shield -= s; amount -= s;
      this.emit('shield-hit', { s });
      if (this.shield <= 0.01) { this.shield = 0; this.shieldT = 0; this.emit('shield-break'); }
    }
    if (source && source.sp && !source.dead && mods.thorns && this.game.ecosystem) {
      this.game.ecosystem.damage(source, raw * mods.thorns, { from: 'player' });
      bodyCenter(source, _v3);
      this.burst(_v3, 0xc6ff9a, 5);
    }
    return amount;
  }

  // ------------------------------------------------------------------ the warden's orbs
  /** A glowing orb thrown at the explorer by a creature. */
  hurl(from, to, o = {}) {
    const flight = o.flight ?? 1.1;
    const vel = new THREE.Vector3().subVectors(to, from).divideScalar(flight);
    vel.y += 0.5 * (o.grav ?? 9) * flight;
    this.addShot(this.hostile, from, vel, { dmg: o.dmg ?? 12, grav: o.grav ?? 9, life: flight * 2.2, color: o.color ?? 0x5ff2e0, size: o.size ?? 1.1, source: o.source, home: o.home ?? 0.6 });
  }

  updateHostile(dt) {
    if (!this.hostile.length) return;
    const g = this.game, p = g.player, W = g.world;
    const prev = new THREE.Vector3(), dir = new THREE.Vector3();
    const chest = _v2.set(p.pos.x, p.pos.y + 1.0, p.pos.z);
    for (const s of this.hostile) {
      prev.copy(s.pos);
      // a little homing: the orbs bend toward the explorer
      if (s.home && p.mode !== 'dead') {
        _v3.subVectors(chest, s.pos);
        const d = _v3.length();
        if (d > 2) s.vel.addScaledVector(_v3.divideScalar(d), s.home * 6 * dt);
      }
      s.vel.y -= s.grav * dt;
      s.pos.addScaledVector(s.vel, dt);
      s.life -= dt;
      s.mesh.scale.setScalar(s.size * (0.9 + Math.sin(s.life * 30) * 0.1));
      dir.subVectors(s.pos, prev);
      const len = dir.length();
      if (len > 1e-4) dir.divideScalar(len);
      if (p.mode !== 'dead' && segDist(chest, prev, dir, len, this.res) < 0.75) {
        const k = new THREE.Vector3(dir.x, 0, dir.z).normalize().multiplyScalar(6);
        p.vel.add(k); p.vel.y = Math.max(p.vel.y, 2.5); p.onGround = false;
        p.hurt(s.dmg, 'creature', s.source);
        this.burst(chest, s.mesh.material.color.getHex(), 10);
        this.emit('orb-hit', { pos: chest.clone() });
        this.removeShot(s);
        continue;
      }
      const rock = W.raycast(prev.x, prev.y, prev.z, dir.x, dir.y, dir.z, len, { step: 0.4 });
      if (rock || s.life <= 0) {
        _v3.set(rock ? rock.x : s.pos.x, rock ? rock.y : s.pos.y, rock ? rock.z : s.pos.z);
        this.burst(_v3, s.mesh.material.color.getHex(), 8);
        this.emit('orb-burst', { pos: _v3.clone() });
        // a near miss still stings
        if (p.mode !== 'dead' && _v3.distanceTo(chest) < 2.4) p.hurt(Math.round(s.dmg * 0.4), 'creature', s.source);
        this.removeShot(s);
        continue;
      }
      s.mesh.position.copy(s.pos);
    }
    this.hostile = this.hostile.filter((s) => !s.dead);
  }

  // ------------------------------------------------------------------ effects
  burst(pos, color, n) {
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Sprite(this.sparkMat(color));
      sp.position.copy(pos);
      sp.scale.setScalar(0.18 + Math.random() * 0.12);
      this.scene.add(sp);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(3 + Math.random() * 5);
      this.fx.push({ kind: 'spark', mesh: sp, vel: v, t: 0, life: 0.35 + Math.random() * 0.25 });
    }
  }

  sparkMat(color) {
    this.sparkMats = this.sparkMats || new Map();
    let m = this.sparkMats.get(color);
    if (!m) { m = new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }); this.sparkMats.set(color, m); }
    return m;
  }

  ring(pos, radius, color, life) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(pos.x, pos.y + 0.3, pos.z);
    m.scale.setScalar(0.5);
    this.scene.add(m);
    this.fx.push({ kind: 'ring', mesh: m, t: 0, life, radius });
  }

  spike(x, y, z, delay, height) {
    const m = new THREE.Mesh(this.spikeGeo, this.spikeMat);
    m.position.set(x + (Math.random() - 0.5) * 0.6, y - 0.1, z + (Math.random() - 0.5) * 0.6);
    m.rotation.set((Math.random() - 0.5) * 0.5, Math.random() * 6, (Math.random() - 0.5) * 0.5);
    m.scale.set(0.5 + Math.random() * 0.3, 0.001, 0.5 + Math.random() * 0.3);
    m.visible = false;
    this.scene.add(m);
    this.fx.push({ kind: 'spike', mesh: m, t: -delay, life: 2.6, h: height * (1.2 + Math.random() * 0.9) });
  }

  frost(a, T) {
    const sp = new THREE.Sprite(this.sparkMat(0x9fdcff).clone());
    sp.material.opacity = 0.7;
    this.scene.add(sp);
    this.fx.push({ kind: 'frost', mesh: sp, a, t: 0, life: T });
  }

  arc(from, to) {
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const p = from.clone().lerp(to, i / 8);
      if (i > 0 && i < 8) p.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.5));
      pts.push(p);
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xe2ecff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(line);
    this.fx.push({ kind: 'arc', mesh: line, t: 0, life: 0.2 });
  }

  updateFx(dt) {
    if (!this.fx.length) return;
    for (const f of this.fx) {
      f.t += dt;
      const k = f.t / f.life;
      const m = f.mesh;
      if (f.kind === 'spark') {
        f.vel.y -= 9 * dt;
        m.position.addScaledVector(f.vel, dt);
        m.scale.multiplyScalar(Math.max(0.5, 1 - dt * 2.5));
      } else if (f.kind === 'ring') {
        m.scale.setScalar(0.5 + (f.radius - 0.5) * Math.sqrt(Math.min(1, k)));
        m.material.opacity = 0.8 * (1 - k);
      } else if (f.kind === 'spike') {
        if (f.t < 0) continue;
        m.visible = true;
        const up = Math.min(1, f.t / 0.12), down = f.t > f.life - 0.45 ? (f.life - f.t) / 0.45 : 1;
        m.scale.y = Math.max(0.001, f.h * up * down);
      } else if (f.kind === 'frost') {
        if (f.a.dead) f.t = f.life;
        bodyCenter(f.a, m.position);
        m.scale.setScalar(bodyRadius(f.a) * 3.2 * (0.95 + Math.sin(f.t * 3) * 0.05));
        m.material.opacity = 0.6 * Math.min(1, (f.life - f.t) * 2);
      } else if (f.kind === 'arc') m.material.opacity = 1 - k;
      if (f.t >= f.life) {
        this.scene.remove(m);
        if (f.kind === 'ring' || f.kind === 'arc' || f.kind === 'frost') m.material.dispose();
        if (f.kind === 'arc') m.geometry.dispose();
        f.done = true;
      }
    }
    this.fx = this.fx.filter((f) => !f.done);
  }

  // ------------------------------------------------------------------ the weapon in hand
  buildVisuals() {
    const g = this.game;
    this.scene = g.renderer.scene;
    this.ringGeo = new THREE.RingGeometry(0.85, 1, 48);
    this.spikeGeo = new THREE.ConeGeometry(0.28, 1, 5, 1);
    this.spikeGeo.translate(0, 0.5, 0);
    this.spikeMat = new THREE.MeshLambertMaterial({ color: 0x9fe8ff, emissive: 0x2a8fb8, emissiveIntensity: 0.8 });
    this.hand = new THREE.Group();
    this.pivot = new THREE.Group();
    this.hand.add(this.pivot);
    this.tipNode = new THREE.Object3D();
    this.pivot.add(this.tipNode);
    g.camera.add(this.hand);
    this.setTouchLayout(!!g.touch);
    this.modelFor = undefined;
    // the ray: a bright core inside a wide soft glow, a flare where it ends and a light
    // narrow at the weapon, full width at the far end (so it does not look like a wedge up close)
    const core = new THREE.CylinderGeometry(1, 0.25, 1, 10, 1, true);
    core.translate(0, 0.5, 0);
    core.rotateX(Math.PI / 2);
    this.beam = new THREE.Group();
    // the core stays white-hot; the glow is drawn over the scene (not added to it) so it reads in bright mist too
    this.beamCore = new THREE.Mesh(core, new THREE.MeshBasicMaterial({ color: 0xf2feff, transparent: true, opacity: 1, depthWrite: false, fog: false, toneMapped: false }));
    this.beamGlow = new THREE.Mesh(core, new THREE.MeshBasicMaterial({ color: 0x1fc8ff, transparent: true, opacity: 0.5, depthWrite: false, fog: false, toneMapped: false }));
    this.beamCore.renderOrder = 2;
    this.beam.add(this.beamCore, this.beamGlow);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.beamCore.frustumCulled = false; this.beamGlow.frustumCulled = false;
    this.scene.add(this.beam);
    this.flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x8ff0ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.flare.visible = false;
    this.scene.add(this.flare);
    this.light = new THREE.PointLight(0x7fe8ff, 0, 22, 1.6);
    this.scene.add(this.light);
  }

  setTouchLayout(touch) {
    this.handBase = touch ? { x: -0.24, y: -0.34, z: -0.6, s: 0.62 } : { x: -0.3, y: -0.33, z: -0.6, s: 0.8 };
    this.hand.position.set(this.handBase.x, this.handBase.y, this.handBase.z);
    this.hand.scale.setScalar(this.handBase.s);
  }

  /** (Re)build the model in hand when the wielded artifact changes. */
  setModel() {
    const art = this.art;
    const key = art ? art.id : 'pick';
    if (key === this.modelFor) return;
    this.modelFor = key;
    if (this.model) {
      this.pivot.remove(this.model);
      this.model.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    }
    const m = buildArtifactModel(art || PICK_ART);
    const s = art ? 0.5 + Math.min(0.12, art.size * 0.2) : 0.55;
    m.scale.setScalar(s);
    // held low in the left hand, grip at the bottom; drawn over the world like the arm
    m.position.y = -0.18 * s;
    m.traverse((o) => { if (o.isMesh) { o.renderOrder = 999; o.material.depthTest = false; o.material.depthWrite = false; o.material.transparent = false; o.material.opacity = 1; } });
    this.model = m;
    this.pivot.add(m);
    this.tipNode.position.set(0, 0.85 * s, 0);
  }

  tip(out) {
    this.hand.updateWorldMatrix(true, true);
    return out.setFromMatrixPosition(this.tipNode.matrixWorld);
  }

  updateVisuals(dt) {
    const g = this.game, p = g.player;
    this.setModel();
    const want = this.drawn && p.mode !== 'dead' && p.mode !== 'climb' && !p.zoomed && g.settings.showArm !== false ? 1 : 0;
    this.show += (want - this.show) * Math.min(1, dt * 10);
    this.hand.visible = this.show > 0.02;
    const B = this.handBase;
    const hs = Math.hypot(p.vel.x, p.vel.z);
    // at rest the weapon leans forward and in; a swing chops down and across
    // (a melee weapon stands up, head toward the centre; a caster or lance points ahead)
    const ranged = this.W.kind !== 'melee';
    let rx = ranged ? -1.32 : -0.3, rz = ranged ? 0 : -0.5, px = 0, py = ranged ? 0.06 : 0, pz = 0;
    const ry = ranged ? -0.2 : 0;
    if (this.swingT >= 0) {
      const t = this.swingT / SWING;
      const a = Math.sin(Math.min(1, t * 1.25) * Math.PI);
      const wind = t < 0.2 ? Math.sin(t / 0.2 * Math.PI) * 0.4 : 0;
      rx += wind - 1.3 * a; rz -= 0.6 * a; px += 0.2 * a; py += 0.06 * a; pz -= 0.1 * a;
    }
    rx += this.recoil * 0.3; pz += this.recoil * 0.06;
    if (this.firing || this.ray) { px += (Math.random() - 0.5) * 0.006; py += (Math.random() - 0.5) * 0.006; }
    this.pivot.rotation.set(rx, ry, rz, 'YXZ');
    this.hand.position.set(B.x + px, B.y + py - (1 - this.show) * 0.3 + Math.sin(p.bob * 0.5 + 1) * 0.008 * Math.min(1, hs / 4), B.z + pz);
    // the ray
    const on = (this.firing || this.ray) && this.rayOn;
    this.beam.visible = !!on;
    this.flare.visible = !!on;
    if (on) {
      const from = this.show > 0.5 ? this.tip(_v) : _v.copy(g.camera.position).add(_v2.set(0, -0.25, 0));
      const to = this.rayEnd;
      _v2.subVectors(to, from);
      const len = Math.max(0.1, _v2.length());
      this.beam.position.copy(from);
      _q.setFromUnitVectors(_v3.set(0, 0, 1), _v2.divideScalar(len));
      this.beam.quaternion.copy(_q);
      const wide = this.ray ? this.ray.radius : this.rayWide || 0.35;
      const fl = 0.85 + Math.random() * 0.3;
      this.beamCore.scale.set((0.035 + wide * 0.12) * fl, (0.035 + wide * 0.12) * fl, len);
      this.beamGlow.scale.set((0.08 + wide * 0.45) * fl, (0.08 + wide * 0.45) * fl, len);
      this.flare.position.copy(to);
      this.flare.scale.setScalar((this.rayRock ? 2.2 : 1.2) * fl * (1 + wide));
      this.light.position.copy(to).lerp(from, 0.08);
      this.light.intensity = 40 * fl;
    } else this.light.intensity = 0;
    this.rayOn = false;
    void Y;
  }

  // ------------------------------------------------------------------ save
  serialize() { return { shield: this.shield, shieldT: this.shieldT, heat: this.heat }; }
  restore(s) { if (!s) return; this.shield = s.shield || 0; this.shieldT = s.shieldT || 0; this.shieldMax = this.shield; this.heat = s.heat || 0; }
}
