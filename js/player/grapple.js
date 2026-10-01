// The Mechanical Grappling Arm. The claw is fired along the view direction
// (up to 60 m plus artifact bonuses), flies to its target and bites into rock
// or wood. While attached the explorer stays physically connected: an
// inextensible cable constrains the distance (pendulum swings), the winch
// reels in (pull) or pays out (rappel), and reaching a ledge pulls you over it.
import * as THREE from 'three';
import { clamp } from '../core/mathutil.js';
import { spaceFree } from './collision.js';

const BASE_RANGE = 60;
const HOOK_SPEED = 150;

export class Grapple {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this.world = game.world;
    this.state = 'idle';     // idle | flying | attached | retracting
    this.anchor = new THREE.Vector3();
    this.anchorNormal = new THREE.Vector3(0, 1, 0);
    this.hook = new THREE.Vector3();
    this.hookTarget = new THREE.Vector3();
    this.hookDir = new THREE.Vector3();
    this.ropeLen = 0;
    this.reeling = false;
    this.paying = false;
    this.rangeBonus = 0;
    this.reelMul = 1;
    this.cooldown = 0;
    this.listeners = {};
    this.aim = null;         // current aim result for the HUD
    this.buildVisuals();
  }

  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  emit(ev, ...a) { for (const fn of this.listeners[ev] || []) fn(...a); }

  get range() { return BASE_RANGE + this.rangeBonus; }
  get attached() { return this.state === 'attached'; }

  handPos(out = new THREE.Vector3()) {
    const p = this.player;
    return out.set(p.pos.x, p.pos.y + 1.25, p.pos.z);
  }

  /** Aim probe for the crosshair: is there a valid target in range? */
  updateAim() {
    const cam = this.game.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const hit = this.world.raycast(cam.position.x, cam.position.y, cam.position.z, dir.x, dir.y, dir.z, this.range + 25);
    this.aim = hit ? { dist: hit.dist, valid: hit.dist <= this.range, kind: hit.kind } : null;
    return { dir, hit };
  }

  fire() {
    if (this.cooldown > 0) return;
    const { dir, hit } = this.updateAim();
    const start = this.armTip();
    this.hook.copy(start);
    this.hookDir.copy(dir);
    if (hit && hit.dist <= this.range) {
      this.hookTarget.set(hit.x, hit.y, hit.z);
      this.anchorNormal.set(hit.nx, hit.ny, hit.nz);
      this.targetValid = true;
    } else {
      this.hookTarget.copy(this.game.camera.position).addScaledVector(dir, this.range);
      this.targetValid = false;
    }
    this.state = 'flying';
    this.recoil = 1;
    this.emit('fire');
  }

  release(silent = false) {
    if (this.state === 'idle') return;
    if (this.state === 'attached' && !silent) this.emit('release');
    this.state = 'retracting';
    this.reeling = false;
    this.paying = false;
  }

  /** Called from the player step before integration: winch pull. */
  applyForces(p, dt) {
    if (this.state !== 'attached') return;
    const hand = this.handPos(this._h || (this._h = new THREE.Vector3()));
    const d = this._d || (this._d = new THREE.Vector3());
    d.subVectors(this.anchor, hand);
    const dist = d.length();
    if (dist < 1e-3) return;
    d.divideScalar(dist);
    if (this.reeling) {
      const reel = 13 * this.reelMul;
      this.ropeLen = Math.max(1.0, Math.min(this.ropeLen, dist) - reel * dt);
      // the winch drags the body toward the claw
      const along = p.vel.dot(d);
      if (along < reel) p.vel.addScaledVector(d, Math.min(reel - along, 55 * dt));
      // fight gravity while being hauled
      p.vel.y += 22 * dt * Math.max(0, d.y) * 0.85;
      p.onGround = false;
    } else if (this.paying) {
      this.ropeLen = Math.min(this.range, this.ropeLen + 7 * dt);
    }
  }

  /** Called after integration: keep the body within the cable length. */
  applyConstraint(p, dt) {
    if (this.state !== 'attached') return;
    const hand = this.handPos(this._h);
    const d = this._d;
    d.subVectors(hand, this.anchor);
    const dist = d.length();
    if (dist > this.ropeLen && dist > 1e-3) {
      d.divideScalar(dist);
      const excess = dist - this.ropeLen;
      // pull back along the rope, but never into terrain
      const nx = p.pos.x - d.x * excess, ny = p.pos.y - d.y * excess, nz = p.pos.z - d.z * excess;
      if (spaceFree(this.world, nx, nz, p.radius * 0.9, ny + 0.1, ny + p.height)) p.pos.set(nx, ny, nz);
      else if (spaceFree(this.world, p.pos.x, p.pos.z, p.radius * 0.9, ny + 0.1, ny + p.height)) p.pos.y = ny;
      const vr = p.vel.dot(d);
      if (vr > 0) p.vel.addScaledVector(d, -vr);
      if (d.y < -0.2) p.onGround = false;
    }
    // reached the claw while reeling: climb over the ledge if there is room
    if (this.reeling && dist < 1.8) {
      const top = this.anchor.y + (this.anchorNormal.y > 0.5 ? 0.02 : 0.5);
      if (spaceFree(this.world, this.anchor.x, this.anchor.z, p.radius * 0.9, top + 0.1, top + p.height)) {
        p.mantle = { y: top, nx: -(this.anchor.x - p.pos.x), nz: -(this.anchor.z - p.pos.z), t: 0 };
        const l = Math.hypot(p.mantle.nx, p.mantle.nz) || 1;
        p.mantle.nx /= l; p.mantle.nz /= l;
        this.release();
        this.emit('pullup');
      }
    }
    void dt;
  }

  update(dt) {
    const inp = this.game.input;
    const p = this.player;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (p.mode === 'dead') { if (this.state !== 'idle') this.release(true); }
    // controls
    const fireClick = inp.clicked & 1;
    if (fireClick && !this.game.uiBlocking) {
      if (this.state === 'idle') this.fire();
      else if (this.state === 'attached' || this.state === 'flying') this.release();
    }
    if (inp.was('release')) this.release();
    if (this.state === 'attached') {
      this.reeling = !!(inp.buttons & 4) || inp.is('reelIn') || inp.wheel < 0;
      this.paying = inp.is('reelOut') || inp.wheel > 0;
      if (inp.wheel > 0) this.ropeLen = Math.min(this.range, this.ropeLen + 1.5);
      if (inp.wheel < 0) this.ropeLen = Math.max(1, this.ropeLen - 1.5);
      if (inp.was('jump') && !p.onGround) {
        // grapple jump: let go with a hop
        this.release();
        p.vel.y = Math.max(p.vel.y, 0) + 5.5;
      }
      // cable cannot pass through solid rock: release if the line is blocked
      this.blockTimer = (this.blockTimer || 0) + dt;
      if (this.blockTimer > 0.25) {
        this.blockTimer = 0;
        const hand = this.handPos();
        const d = new THREE.Vector3().subVectors(this.anchor, hand);
        const len = d.length();
        if (len > 3) {
          const hit = this.world.raycast(hand.x, hand.y, hand.z, d.x, d.y, d.z, len - 1.5, { step: 0.5 });
          if (hit && hit.kind === 'terrain') {
            // wrap: move the anchor to the obstruction point (rope snags on the edge)
            this.anchor.set(hit.x, hit.y, hit.z);
            this.ropeLen = Math.min(this.ropeLen, hit.dist);
          }
        }
      }
    } else { this.reeling = false; this.paying = false; }
    // hook flight
    if (this.state === 'flying') {
      const to = new THREE.Vector3().subVectors(this.hookTarget, this.hook);
      const dl = to.length();
      const stepLen = HOOK_SPEED * dt;
      if (dl <= stepLen) {
        this.hook.copy(this.hookTarget);
        if (this.targetValid) {
          this.state = 'attached';
          this.anchor.copy(this.hookTarget);
          this.ropeLen = this.handPos().distanceTo(this.anchor) + 0.2;
          this.blockTimer = 0;
          this.emit('attach', this.anchorNormal);
        } else {
          this.state = 'retracting';
          this.emit('miss');
        }
      } else this.hook.addScaledVector(to, stepLen / dl);
    } else if (this.state === 'retracting') {
      const tip = this.armTip();
      const to = new THREE.Vector3().subVectors(tip, this.hook);
      const dl = to.length();
      const stepLen = HOOK_SPEED * 0.8 * dt;
      if (dl <= stepLen + 0.05) { this.state = 'idle'; this.cooldown = 0.15; this.emit('stowed'); }
      else this.hook.addScaledVector(to, stepLen / dl);
    } else if (this.state === 'attached') {
      this.hook.copy(this.anchor);
    }
    this.updateVisuals(dt);
  }

  // ------------------------------------------------------------------ visuals
  buildVisuals() {
    const cam = this.game.camera;
    const metal = new THREE.MeshLambertMaterial({ color: 0x8a8f96 });
    const brass = new THREE.MeshLambertMaterial({ color: 0xb08a4a });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2c2e33 });
    const leather = new THREE.MeshLambertMaterial({ color: 0x5a3c26 });
    for (const m of [metal, brass, dark, leather]) { m.depthTest = true; }
    const arm = new THREE.Group();
    // forearm housing
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.42, 10), leather);
    fore.rotation.x = Math.PI / 2;
    fore.position.set(0, 0, 0.12);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.1, 0.24), metal);
    housing.position.set(0, 0.045, -0.04);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.1, 12), brass);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0, 0.1, 0.02);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.22, 10), dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.04, -0.22);
    const piston1 = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6), brass);
    piston1.rotation.x = Math.PI / 2;
    piston1.position.set(0.06, -0.01, -0.02);
    const piston2 = piston1.clone();
    piston2.position.x = -0.06;
    arm.add(fore, housing, drum, barrel, piston1, piston2);
    // claw docked at the barrel tip
    this.claw = this.makeClaw(metal, dark);
    this.clawDock = new THREE.Object3D();
    this.clawDock.position.set(0, 0.04, -0.34);
    arm.add(this.clawDock);
    arm.rotation.set(0.08, 0.06, 0);
    this.arm = arm;
    this.drum = drum;
    this.setTouchLayout(!!this.game.touch);
    cam.add(arm);
    // the arm is drawn over the world so it never clips into nearby rock
    arm.traverse((o) => { if (o.isMesh) { o.renderOrder = 999; o.material = o.material.clone(); o.material.depthTest = false; o.material.depthWrite = false; } });
    this.game.renderer.scene.add(this.claw);
    // cable: a camera-facing ribbon with sag
    const N = 24;
    this.cableN = N;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.cable = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x3a342c, side: THREE.DoubleSide }));
    this.cable.frustumCulled = false;
    this.cable.visible = false;
    this.game.renderer.scene.add(this.cable);
  }

  /** Smaller and lower on touch screens so it stays clear of the thumbs' buttons. */
  setTouchLayout(touch) {
    this.armBase = touch ? { x: 0.17, y: -0.31, z: -0.5, s: 0.55 } : { x: 0.26, y: -0.27, z: -0.46, s: 0.78 };
    this.arm.position.set(this.armBase.x, this.armBase.y, this.armBase.z);
    this.arm.scale.setScalar(this.armBase.s);
  }

  makeClaw(metal, dark) {
    const claw = new THREE.Group();
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.04, 0.12, 8), dark);
    hub.rotation.x = Math.PI / 2;
    claw.add(hub);
    for (let k = 0; k < 3; k++) {
      const prong = new THREE.Group();
      const a = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.14), metal);
      a.position.set(0, 0.05, -0.08);
      a.rotation.x = -0.5;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.08), metal);
      b.position.set(0, 0.06, -0.17);
      b.rotation.x = 0.7;
      prong.add(a, b);
      prong.rotation.z = (k / 3) * Math.PI * 2;
      claw.add(prong);
    }
    claw.scale.setScalar(1.3);
    return claw;
  }

  armTip(out = new THREE.Vector3()) {
    this.clawDock.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.clawDock.matrixWorld);
  }

  updateVisuals(dt) {
    this.recoil = Math.max(0, (this.recoil || 0) - dt * 5);
    this.arm.position.z = this.armBase.z + this.recoil * 0.06;
    this.arm.rotation.x = 0.08 + this.recoil * 0.15;
    if (this.reeling) this.drum.rotation.x += dt * 25; else if (this.paying) this.drum.rotation.x -= dt * 12;
    const p = this.player;
    const hs = Math.hypot(p.vel.x, p.vel.z);
    this.arm.position.y = this.armBase.y + Math.sin(p.bob * 0.5) * 0.008 * Math.min(1, hs / 4);
    this.arm.visible = p.mode !== 'dead' && !p.zoomed && this.game.settings.showArm !== false;
    const tip = this.armTip(this._tip || (this._tip = new THREE.Vector3()));
    if (this.state === 'idle') {
      this.claw.position.copy(tip);
      this.clawDock.updateWorldMatrix(true, false);
      this.claw.quaternion.setFromRotationMatrix(this.clawDock.matrixWorld);
      this.claw.visible = this.arm.visible;
      this.cable.visible = false;
      return;
    }
    this.claw.visible = true;
    this.claw.position.copy(this.hook);
    const dir = new THREE.Vector3().subVectors(this.hook, tip);
    if (dir.lengthSq() > 1e-4) this.claw.lookAt(this.hook.clone().add(dir));
    // cable with sag when slack
    const cam = this.game.camera.position;
    const pos = this.cable.geometry.attributes.position.array;
    const N = this.cableN;
    const len = dir.length();
    const slack = this.state === 'attached' ? Math.max(0, this.ropeLen - this.handPos().distanceTo(this.anchor)) : 0;
    const sag = Math.min(4, slack * 0.5 + (this.state !== 'attached' ? 0 : 0.05 * len * 0.1));
    const pt = new THREE.Vector3(), side = new THREE.Vector3(), toCam = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pt.lerpVectors(tip, this.hook, t);
      pt.y -= Math.sin(Math.PI * t) * sag;
      toCam.subVectors(cam, pt).normalize();
      side.crossVectors(dir, toCam).normalize().multiplyScalar(0.012 + t * 0.012);
      pos[i * 6] = pt.x - side.x; pos[i * 6 + 1] = pt.y - side.y; pos[i * 6 + 2] = pt.z - side.z;
      pos[i * 6 + 3] = pt.x + side.x; pos[i * 6 + 4] = pt.y + side.y; pos[i * 6 + 5] = pt.z + side.z;
    }
    this.cable.geometry.attributes.position.needsUpdate = true;
    this.cable.visible = true;
    void clamp;
  }

  serialize() { return { rangeBonus: this.rangeBonus }; }
}
