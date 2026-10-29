// Artifact system: places uncollected artifacts in the world near the player,
// handles pickup, the inventory with three equipment slots and the weapon in
// hand, passive effects (applied to the explorer), gradual identification of
// properties while equipped, active abilities (combat ones go through
// systems/combat.js) and the explorer's lamp. The warden's lance only appears
// once the warden of the Throne Cup has fallen.
import * as THREE from 'three';
import { buildArtifactModel, glowTexture } from './artifactMesh.js';
import { EFFECTS, ABILITIES } from './artifactGen.js';
import { shared } from '../render/materials.js';
import { clamp } from '../core/mathutil.js';

export const SLOTS = 3;

export class ArtifactSystem {
  constructor(game) {
    this.game = game;
    this.plan = game.plan;
    this.list = game.plan.artifacts;
    this.byId = new Map(this.list.map((a) => [a.id, a]));
    this.collected = new Set();
    this.equipped = [];
    this.wielded = null;           // the artifact in hand (a weapon), null: the delver's pick
    this.identified = new Map();   // id -> seconds equipped (for identification)
    this.objects = new Map();
    this.group = new THREE.Group();
    game.renderer.scene.add(this.group);
    this.cooldowns = new Map();
    this.activeIndex = 0;
    this.effects = { flare: 0, pulse: 0 };
    this.placeTimer = 0;
    this.listeners = [];
    this.lamp = { on: false, power: 1 };
    game.lamp = this.lamp;
    this.flareLight = new THREE.PointLight(0xfff0d0, 0, 45, 1.4);
    game.renderer.scene.add(this.flareLight);
  }

  on(fn) { this.listeners.push(fn); }
  emit(t, d) { for (const fn of this.listeners) fn(t, d); }

  update(dt) {
    const g = this.game, p = g.player;
    if (!p) return;
    this.placeTimer -= dt;
    if (this.placeTimer <= 0) { this.placeTimer = 0.5; this.placeNearby(p.pos); }
    // animate visible artifacts
    const t = g.gameTime;
    for (const [id, o] of this.objects) {
      o.rotation.y += dt * 0.6;
      o.position.y = o.userData.baseY + Math.sin(t * 1.5 + id) * 0.08;
      o.traverse((m) => { if (m.userData.spin) m.rotation.z += dt * m.userData.spin; if (m.userData.pulse) m.scale.y = 1.3 + Math.sin(t * 2.5) * 0.08; });
    }
    // prompt & pickup
    this.focus = this.findFocus(p);
    if (this.focus && g.input.was('interact') && !g.uiBlocking) this.collect(this.focus.id);
    // identification while equipped
    for (const it of this.activeItems()) {
      const id = it.id;
      const before = this.identified.get(id) || 0;
      const now = before + dt;
      this.identified.set(id, now);
      if (before < 25 && now >= 25) this.emit('identified', this.byId.get(id));
    }
    // ability
    for (const [k, v] of this.cooldowns) this.cooldowns.set(k, Math.max(0, v - dt));
    if (g.input.was('ability') && !g.uiBlocking) this.useAbility();
    if (g.input.was('nextAbility') && !g.uiBlocking) this.nextAbility();
    // lamp
    if (g.input.was('lamp') && !g.uiBlocking) { this.lamp.on = !this.lamp.on; this.emit('lamp', this.lamp.on); }
    this.updateLights(dt);
  }

  updateLights(dt) {
    const p = this.game.player;
    const mods = this.mods || {};
    const lantern = mods.lantern || 0;
    let range = 0, col = 0;
    if (this.lamp.on) { range = 16 + lantern * 0.6; col = 1.1; }
    else if (lantern > 0) { range = lantern; col = 0.55; }
    // darksight: the lamp reaches further, and a faint light is always there
    const dark = mods.darksight || 0;
    if (dark > 0) { range = Math.max(range * (1 + dark), 5 + 10 * dark); col = Math.max(col, 0.3 + 0.25 * dark); }
    if (this.effects.flare > 0) { this.effects.flare -= dt; range = Math.max(range, 38); col = Math.max(col, 2.2); }
    shared.uLampPos.value.set(p.pos.x, p.pos.y + 1.7, p.pos.z);
    shared.uLampColor.value.setRGB(col, col * 0.92, col * 0.78);
    shared.uLampRange.value = Math.max(1, range);
    this.flareLight.position.set(p.pos.x, p.pos.y + 2.5, p.pos.z);
    this.flareLight.intensity = this.effects.flare > 0 ? 120 : 0;
    this.lamp.power = col;
    if (this.effects.pulse > 0) this.effects.pulse -= dt;
  }

  placeNearby(pos) {
    const R = 140;
    for (const a of this.list) {
      if (this.collected.has(a.id)) continue;
      // the warden guards its lance: it rises from the lake once the warden falls
      if (a.site.kind === 'throne' && !this.game.wardenDefeated) continue;
      const d = Math.hypot(a.site.x - pos.x, a.site.z - pos.z, (a.site.y - pos.y) * 0.5);
      const has = this.objects.has(a.id);
      if (d < R && !has) {
        const o = new THREE.Group();
        const model = buildArtifactModel(a);
        model.scale.setScalar(a.size * 1.6 + 0.25);
        o.add(model);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(...a.accent).lerp(new THREE.Color(1, 0.95, 0.8), 0.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 + a.glow * 0.4 }));
        glow.scale.setScalar(1.6 + a.grade * 0.35);
        glow.position.y = 0.45;
        o.add(glow);
        const L4 = this.plan.layer4;
        const y = a.site.kind === 'throne' && L4 && L4.boss ? Math.max(a.site.y, L4.boss.y) + 0.9 : a.site.y + 0.25;
        o.position.set(a.site.x, y, a.site.z);
        o.userData.baseY = y;
        this.group.add(o);
        this.objects.set(a.id, o);
      } else if (d > R + 40 && has) {
        const o = this.objects.get(a.id);
        this.group.remove(o);
        o.traverse((m) => { if (m.geometry) m.geometry.dispose(); });
        this.objects.delete(a.id);
      }
    }
  }

  findFocus(p) {
    const eye = this.game.camera.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.game.camera.quaternion);
    let best = null, bs = 0;
    for (const [id, o] of this.objects) {
      const v = new THREE.Vector3().subVectors(o.position, eye);
      const d = v.length();
      if (d > 3.2) continue;
      const dot = v.normalize().dot(fwd);
      const score = dot - d * 0.05;
      if (dot > 0.75 && score > bs) { bs = score; best = { id, dist: d, art: this.byId.get(id) }; }
    }
    void p;
    return best;
  }

  collect(id) {
    const a = this.byId.get(id);
    if (!a || this.collected.has(id)) return;
    this.collected.add(id);
    const o = this.objects.get(id);
    if (o) { this.group.remove(o); this.objects.delete(id); }
    // a weapon goes to hand when only the pick is there, anything else into a free slot
    if (a.weapon && !this.wielded) this.wielded = id;
    else if (this.equipped.length < SLOTS) this.equipped.push(id);
    this.recompute();
    this.emit('collect', a);
    if (this.wielded === id) this.emit('wield', a);
  }

  /** The artifact in hand, or null for the delver's pick. */
  wieldedArt() { return this.wielded != null ? this.byId.get(this.wielded) || null : null; }

  /** Take a weapon in hand (it leaves its equipment slot); null goes back to the pick. */
  wield(id) {
    if (id != null) {
      const a = this.byId.get(id);
      if (!a || !a.weapon || !this.collected.has(id)) return false;
      this.equipped = this.equipped.filter((e) => e !== id);
    }
    this.wielded = id;
    this.recompute();
    this.emit('wield', id != null ? this.byId.get(id) : null);
    return true;
  }

  /** The weapons carried, the pick first. */
  weapons() { return [null, ...this.list.filter((a) => a.weapon && this.collected.has(a.id)).map((a) => a.id)]; }

  cycleWeapon() {
    const list = this.weapons();
    if (list.length < 2) { this.emit('no-weapon'); return; }
    const i = list.indexOf(this.wielded);
    this.wield(list[(i + 1) % list.length]);
  }

  equip(id) {
    if (!this.collected.has(id) || this.equipped.includes(id)) return false;
    if (this.wielded === id) { this.wielded = null; this.emit('wield', null); }
    if (this.equipped.length >= SLOTS) return false;
    this.equipped.push(id);
    this.recompute();
    this.emit('equip', this.byId.get(id));
    return true;
  }

  unequip(id) {
    this.equipped = this.equipped.filter((e) => e !== id);
    this.recompute();
    this.emit('unequip', this.byId.get(id));
  }

  isIdentified(id) { return (this.identified.get(id) || 0) >= 25 || (this.byId.get(id)?.grade === 0); }

  /** The artifacts at work: the equipped ones and the one in hand. */
  activeItems() {
    const out = this.equipped.map((id) => this.byId.get(id));
    const w = this.wieldedArt();
    if (w && !this.equipped.includes(w.id)) out.push(w);
    return out;
  }

  /** Recompute explorer modifiers from equipped artifacts. */
  recompute() {
    const p = this.game.player, gr = this.game.grapple;
    const mods = {
      run: 1, jump: 1, fall: 0, climb: 0, swim: 1, regen: 0, staminaRegen: 1, move: 1, lantern: 0, sense: 0, dowsing: 0, scholar: 0, cartographer: 0, reach: 0, winch: 0, glide: false, restless: false,
      armor: 0, might: 0, haste: 0, leech: 0, thorns: 0, tough: 0, wind: 0, calm: 0, darksight: 0,
    };
    for (const a of this.activeItems()) {
      for (const e of a.effects) {
        switch (e.type) {
          case 'stride': mods.run += e.magnitude; break;
          case 'spring': mods.jump += e.magnitude; break;
          case 'feather': mods.fall = 1 - (1 - mods.fall) * (1 - e.magnitude); break;
          case 'grip': mods.climb = 1 - (1 - mods.climb) * (1 - e.magnitude); break;
          case 'reach': mods.reach += e.magnitude; break;
          case 'winch': mods.winch += e.magnitude; break;
          case 'lantern': mods.lantern = Math.max(mods.lantern, e.magnitude); break;
          case 'sense': mods.sense = Math.max(mods.sense, e.magnitude); break;
          case 'dowsing': mods.dowsing = Math.max(mods.dowsing, e.magnitude); break;
          case 'scholar': mods.scholar += e.magnitude; break;
          case 'vigor': mods.regen += e.magnitude; break;
          case 'cartographer': mods.cartographer += e.magnitude; break;
          case 'swim': mods.swim += e.magnitude; break;
          case 'armor': mods.armor = 1 - (1 - mods.armor) * (1 - e.magnitude); break;
          case 'might': mods.might += e.magnitude; break;
          case 'haste': mods.haste += e.magnitude; break;
          case 'leech': mods.leech += e.magnitude; break;
          case 'thorns': mods.thorns += e.magnitude; break;
          case 'tough': mods.tough += e.magnitude; break;
          case 'wind': mods.wind += e.magnitude; break;
          case 'calm': mods.calm = Math.max(mods.calm, e.magnitude); break;
          case 'darksight': mods.darksight = Math.max(mods.darksight, e.magnitude); break;
          default: break;
        }
      }
      if (a.ability && a.ability.type === 'glide') mods.glide = true;
      if (a.drawback) {
        if (a.drawback.type === 'heavy') mods.move *= 1 - a.drawback.magnitude;
        if (a.drawback.type === 'dim') mods.staminaRegen *= 1 - a.drawback.magnitude;
        if (a.drawback.type === 'restless') mods.restless = true;
      }
    }
    this.mods = mods;
    if (p) {
      Object.assign(p.mods, { run: mods.run, jump: mods.jump, fall: clamp(mods.fall, 0, 0.95), climb: clamp(mods.climb, 0, 0.9), swim: mods.swim, regen: mods.regen, staminaRegen: mods.staminaRegen, move: mods.move });
      p.glide = mods.glide;
      p.maxHealth = 100 + Math.round(mods.tough);
      p.maxStamina = 100 + Math.round(mods.wind);
      p.health = Math.min(p.health, p.maxHealth);
      p.stamina = Math.min(p.stamina, p.maxStamina);
    }
    if (gr) { gr.rangeBonus = mods.reach; gr.reelMul = 1 + mods.winch; }
  }

  /** Artifacts with an active ability among the equipped ones and the one in hand. */
  abilityItems() { return this.activeItems().filter((a) => a.ability && a.ability.type !== 'glide'); }

  /** Choose the next ability for the ability button. */
  nextAbility() {
    const items = this.abilityItems();
    if (items.length < 2) return;
    this.activeIndex = (this.activeIndex + 1) % items.length;
    this.emit('select', items[this.activeIndex]);
  }

  useAbility() {
    const items = this.abilityItems();
    if (!items.length) return;
    const a = items[this.activeIndex % items.length];
    const cd = this.cooldowns.get(a.id) || 0;
    if (cd > 0) { this.emit('cooldown', { a, cd }); return; }
    const p = this.game.player;
    if (p.mode === 'dead') return;
    switch (a.ability.type) {
      case 'flare': this.effects.flare = 25; break;
      case 'updraft': p.vel.y = Math.max(p.vel.y, 9 + a.ability.power * 6); p.onGround = false; break;
      case 'pulse': this.effects.pulse = 10; break;
      case 'survey': break;
      default:
        // offensive and defensive powers
        if (!this.game.combat || !this.game.combat.ability(a)) return;
        break;
    }
    this.cooldowns.set(a.id, a.ability.cooldown);
    this.identified.set(a.id, Math.max(this.identified.get(a.id) || 0, 25));
    this.emit('ability', a);
  }

  /** Nearest uncollected artifact within dowsing range (for the compass). */
  dowse(pos) {
    const r = this.mods?.dowsing || 0;
    if (!r) return null;
    let best = null, bd = r;
    for (const a of this.list) {
      if (this.collected.has(a.id)) continue;
      const d = Math.hypot(a.site.x - pos.x, a.site.z - pos.z, a.site.y - pos.y);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  serialize() {
    return { collected: [...this.collected], equipped: this.equipped.slice(), wielded: this.wielded, identified: [...this.identified.entries()], cooldowns: [...this.cooldowns.entries()], lamp: this.lamp.on, activeIndex: this.activeIndex };
  }

  restore(s) {
    if (!s) return;
    this.collected = new Set(s.collected || []);
    this.equipped = (s.equipped || []).filter((id) => this.collected.has(id));
    this.wielded = s.wielded != null && this.collected.has(s.wielded) && this.byId.get(s.wielded)?.weapon ? s.wielded : null;
    this.identified = new Map(s.identified || []);
    this.cooldowns = new Map(s.cooldowns || []);
    this.lamp.on = !!s.lamp;
    this.activeIndex = s.activeIndex || 0;
    for (const id of this.collected) { const o = this.objects.get(id); if (o) { this.group.remove(o); this.objects.delete(id); } }
    this.recompute();
  }
}

void EFFECTS; void ABILITIES;
