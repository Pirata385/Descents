// First-person explorer: walking, running, jumping, mantling ledges,
// climbing rock faces (stamina), swimming with river currents, fall damage,
// respawning at the last safe position, and camera feel (bob, landing dip, FOV).
import * as THREE from 'three';
import { resolveHorizontal, groundUnder, ceilingOver, spaceFree, resolveColliders } from './collision.js';
import { clamp, lerp } from '../core/mathutil.js';
import { MATERIALS, M } from '../world/materials.js';

const G = 22;
const JUMP_V = 7.6;
const WALK = 4.4, RUN = 7.8, CROUCH = 2.2, SWIM = 3.2;
const STEP = 0.6;
const MANTLE_REACH = 1.75;

export class Player {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.input = game.input;
    this.camera = game.camera;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.radius = 0.32;
    this.height = 1.75;
    this.eyeH = 1.62;
    this.eyeCur = 1.62;
    this.onGround = false;
    this.mode = 'walk';
    this.health = 100;
    this.maxHealth = 100;
    this.stamina = 100;
    this.maxStamina = 100;
    this.crouching = false;
    this.mods = { run: 1, jump: 1, fall: 0, climb: 0, swim: 1, regen: 0, staminaRegen: 1, move: 1 };
    this.safe = [];
    this.safeTimer = 0;
    this.stepDist = 0;
    this.bob = 0;
    this.landDip = 0;
    this.fovKick = 0;
    this.lastHurt = 0;
    this.climb = null;
    this.mantle = null;
    this.inWater = false;
    this.waterLevel = NaN;
    this.airTime = 0;
    this.distanceTravelled = 0;
    this.deepest = 0;
    this.listeners = {};
    this.hres = { hit: false, nx: 0, nz: 0, maxTop: 0, minBottom: 0 };
    this.lookSens = 0.0022;
    this.noclip = false;
  }

  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  emit(ev, ...a) { for (const fn of this.listeners[ev] || []) fn(...a); }

  spawn(x, y, z, yaw = 0) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = -0.05;
    this.mode = 'walk';
    this.climb = null;
    this.mantle = null;
    this.safe.length = 0;
    this.safe.push(this.pos.clone());
  }

  get eyePos() { return new THREE.Vector3(this.pos.x, this.pos.y + this.eyeCur, this.pos.z); }
  get forward() { return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)); }

  look(dt) {
    const inp = this.input;
    const s = this.lookSens * (this.game.settings.sensitivity || 1) * (this.zoomed ? 0.35 : 1);
    this.yaw -= inp.mouseDX * s;
    this.pitch -= inp.mouseDY * s * (this.game.settings.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -1.55, 1.55);
    void dt;
  }

  update(dt) {
    if (this.mode === 'dead') { this.updateDeath(dt); this.updateCamera(dt); return; }
    this.look(dt);
    if (this.noclip) { this.updateNoclip(dt); this.updateCamera(dt); return; }
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h);
    this.updateStatus(dt);
    this.updateCamera(dt);
  }

  updateNoclip(dt) {
    const inp = this.input;
    const f = this.forward, r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const sp = (inp.is('run') ? 60 : 15);
    if (inp.is('forward')) this.pos.addScaledVector(f, sp * dt);
    if (inp.is('back')) this.pos.addScaledVector(f, -sp * dt);
    if (inp.is('left')) this.pos.addScaledVector(r, -sp * dt);
    if (inp.is('right')) this.pos.addScaledVector(r, sp * dt);
    if (inp.is('jump')) this.pos.y += sp * dt;
    if (inp.is('crouch')) this.pos.y -= sp * dt;
    this.vel.set(0, 0, 0);
  }

  wishDir(out) {
    const inp = this.input;
    let fx = 0, fz = 0;
    this.analogMag = null;
    if (inp.axis.active) {
      // touch stick: analog direction and magnitude
      const m = Math.hypot(inp.axis.x, inp.axis.y);
      if (m > 0.12) { fx = inp.axis.x; fz = -inp.axis.y; this.analogMag = Math.min(1, m); }
    } else {
      if (inp.is('forward')) fz -= 1;
      if (inp.is('back')) fz += 1;
      if (inp.is('left')) fx -= 1;
      if (inp.is('right')) fx += 1;
    }
    const l = Math.hypot(fx, fz);
    if (l > 0) { fx /= l; fz /= l; }
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    out.x = fx * c + fz * s;
    out.z = -fx * s + fz * c;
    return l > 0;
  }

  step(dt) {
    const inp = this.input;
    const W = this.world;
    const grapple = this.grapple;
    const wish = { x: 0, z: 0 };
    const moving = this.wishDir(wish);
    // water
    this.waterLevel = W.waterAt(this.pos.x, this.pos.y + 0.5, this.pos.z);
    const submerged = Number.isNaN(this.waterLevel) ? 0 : this.waterLevel - this.pos.y;
    const wasWater = this.inWater;
    this.inWater = submerged > 1.05;
    if (this.inWater && !wasWater && this.vel.y < -4) this.emit('splash', -this.vel.y);

    if (this.mantle) { this.stepMantle(dt); return; }
    if (this.mode === 'climb') { this.stepClimb(dt, wish, moving); return; }

    this.crouching = inp.is('crouch') && !this.inWater && this.onGround;
    // horizontal acceleration
    let speed = this.inWater ? SWIM * this.mods.swim : this.crouching ? CROUCH : (inp.is('run') ? RUN * this.mods.run : WALK);
    speed *= this.mods.move;
    // a half-pushed stick walks slowly
    if (this.analogMag !== null && !inp.is('run')) speed *= clamp(this.analogMag / 0.8, 0.35, 1);
    if (this.zoomed) speed = Math.min(speed, WALK * 0.6);
    const accel = this.onGround ? 40 : this.inWater ? 10 : (grapple && grapple.attached ? 9 : 5.5);
    const tvx = moving ? wish.x * speed : 0, tvz = moving ? wish.z * speed : 0;
    if (this.onGround || this.inWater || moving) {
      const dvx = tvx - this.vel.x, dvz = tvz - this.vel.z;
      const dl = Math.hypot(dvx, dvz);
      const maxDv = accel * dt;
      if (dl > maxDv) { this.vel.x += dvx / dl * maxDv; this.vel.z += dvz / dl * maxDv; } else { this.vel.x = tvx; this.vel.z = tvz; }
    }
    // vertical
    if (this.inWater) {
      const buoy = submerged > 1.45 ? 14 : submerged > 1.2 ? 4 : 0;
      this.vel.y += (buoy - G * 0.55) * dt;
      if (inp.is('jump')) this.vel.y += 22 * dt;
      if (inp.is('crouch')) this.vel.y -= 18 * dt;
      this.vel.y *= Math.pow(0.12, dt);
      this.vel.x *= Math.pow(0.5, dt); this.vel.z *= Math.pow(0.5, dt);
      // river current
      const c = W.columnAt(this.pos.x, this.pos.z);
      if (c.flowX !== undefined && (c.flowX || c.flowZ)) { this.vel.x += c.flowX * 3 * dt; this.vel.z += c.flowZ * 3 * dt; }
      // climbing out onto a bank
      if (moving && inp.is('jump')) this.vel.y = Math.max(this.vel.y, 3.5);
    } else {
      this.vel.y -= G * dt;
      if (this.glide && inp.is('jump') && this.vel.y < -2) this.vel.y = Math.max(this.vel.y, -2.6);
    }
    this.vel.y = Math.max(this.vel.y, -55);
    // jump
    if (inp.is('jump') && this.onGround && !this.inWater && this.jumpReady !== false) {
      this.vel.y = JUMP_V * Math.sqrt(this.mods.jump);
      this.onGround = false;
      this.jumpReady = false;
      this.emit('jump');
    }
    if (!inp.is('jump')) this.jumpReady = true;

    // grapple constraint forces (pull) before integration
    if (grapple) grapple.applyForces(this, dt);

    // integrate horizontal and resolve
    const prevY = this.pos.y;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    const stepH = this.onGround ? STEP : 0.12;
    const headH = this.crouching ? 1.2 : this.height;
    const hr = resolveHorizontal(W, this.pos, this.radius, this.pos.y + stepH, this.pos.y + headH, this.hres);
    resolveColliders(W, this.pos, this.radius, this.pos.y, this.pos.y + headH);
    if (hr.hit) {
      // remove velocity into the wall
      const vn = this.vel.x * hr.nx + this.vel.z * hr.nz;
      if (vn < 0) { this.vel.x -= vn * hr.nx; this.vel.z -= vn * hr.nz; }
      // mantle or start climbing
      const pushing = moving && (wish.x * hr.nx + wish.z * hr.nz) < -0.5;
      if (pushing && !this.inWater) {
        const lift = hr.maxTop - this.pos.y;
        if (lift > STEP - 0.05 && lift <= MANTLE_REACH && (!this.onGround || inp.is('jump')) && spaceFree(W, this.pos.x - hr.nx * 0.6, this.pos.z - hr.nz * 0.6, this.radius * 0.9, hr.maxTop + 0.05, hr.maxTop + this.height)) {
          this.mantle = { y: hr.maxTop + 0.02, nx: hr.nx, nz: hr.nz, t: 0 };
          this.emit('mantle');
          return;
        }
        if (inp.is('jump') && lift > MANTLE_REACH && this.stamina > 8) {
          const mat = W.materialAt(this.pos.x - hr.nx * 0.5, this.pos.y + 1.2, this.pos.z - hr.nz * 0.5);
          const climbable = MATERIALS[mat] ? MATERIALS[mat].climb : 1;
          if (climbable > 0.25 && !(grapple && grapple.attached && grapple.reeling)) {
            this.mode = 'climb';
            this.climb = { nx: hr.nx, nz: hr.nz, grip: climbable, lost: 0 };
            this.vel.set(0, 0, 0);
            this.emit('grab');
            return;
          }
        }
      }
    }
    // vertical integration and ground
    this.pos.y += this.vel.y * dt;
    const ground = groundUnder(W, this.pos.x, this.pos.z, this.radius * 0.85, Math.max(prevY, this.pos.y) + (this.onGround ? STEP : 0.12));
    const ceil = ceilingOver(W, this.pos.x, this.pos.z, this.radius * 0.85, prevY + 0.5);
    if (this.pos.y + headH > ceil && this.vel.y > 0) { this.pos.y = Math.min(this.pos.y, ceil - headH); this.vel.y = 0; }
    const wasGround = this.onGround;
    if (this.pos.y <= ground + 0.001) {
      const impact = -this.vel.y;
      this.pos.y = ground;
      if (!wasGround) this.land(impact);
      this.vel.y = Math.max(0, this.vel.y);
      this.onGround = true;
    } else if (wasGround && this.vel.y <= 0 && this.pos.y - ground < STEP + 0.05 && !this.inWater) {
      // stick to the ground when walking down steps
      this.pos.y = ground;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
    if (grapple) grapple.applyConstraint(this, dt);
    // footsteps
    if (this.onGround) {
      const hs = Math.hypot(this.vel.x, this.vel.z);
      this.stepDist += hs * dt;
      this.distanceTravelled += hs * dt;
      const stride = inp.is('run') ? 2.3 : 1.7;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        const mat = W.floorMaterial(this.pos.x, this.pos.y, this.pos.z);
        this.emit('step', MATERIALS[mat] ? MATERIALS[mat].sound : 'stone', hs, this.inWater || submerged > 0.2);
      }
      this.airTime = 0;
    } else this.airTime += dt;
  }

  land(impact) {
    this.landDip = Math.min(0.35, impact * 0.018);
    const mat = this.world.floorMaterial(this.pos.x, this.pos.y, this.pos.z);
    this.emit('land', impact, MATERIALS[mat] ? MATERIALS[mat].sound : 'stone');
    if (impact > 15 && !this.inWater) {
      const water = this.world.waterAt(this.pos.x, this.pos.y + 0.5, this.pos.z);
      const soft = !Number.isNaN(water) && water - this.pos.y > 1.2;
      if (!soft) {
        const dmg = Math.pow(impact - 15, 1.3) * 2.6 * (1 - this.mods.fall);
        if (dmg > 1) this.hurt(dmg, 'fall');
      }
    }
  }

  stepMantle(dt) {
    const m = this.mantle;
    m.t += dt;
    const W = this.world;
    if (this.pos.y < m.y) {
      this.pos.y = Math.min(m.y, this.pos.y + 6.5 * dt);
      this.vel.set(0, 0, 0);
    } else {
      this.pos.x -= m.nx * 3.0 * dt;
      this.pos.z -= m.nz * 3.0 * dt;
      if (m.t > 0.55 || !this.input.is('forward')) {
        this.mantle = null;
        this.onGround = true;
        this.mode = 'walk';
        const g = groundUnder(W, this.pos.x, this.pos.z, this.radius * 0.85, this.pos.y + STEP);
        if (g > -Infinity && this.pos.y - g < 1) this.pos.y = g;
      }
    }
    if (m.t > 1.5) { this.mantle = null; this.mode = 'walk'; }
  }

  stepClimb(dt, wish, moving) {
    const inp = this.input;
    const W = this.world;
    const c = this.climb;
    const up = inp.is('forward') ? 1 : inp.is('back') ? -1 : 0;
    const side = inp.is('right') ? 1 : inp.is('left') ? -1 : 0;
    // tangent along the wall
    const tx = -c.nz, tz = c.nx;
    // orient so that "right" is relative to the view
    const rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);
    const sgn = tx * rightX + tz * rightZ >= 0 ? 1 : -1;
    const sp = 2.1 * Math.max(0.5, c.grip);
    this.vel.set(tx * side * sgn * sp * 0.75 - c.nx * 0.8, up * sp, tz * side * sgn * sp * 0.75 - c.nz * 0.8);
    const drain = (up !== 0 || side !== 0 ? 9 : 3.5) * (1 - this.mods.climb) / Math.max(0.6, c.grip);
    this.stamina = Math.max(0, this.stamina - drain * dt);
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
    const hr = resolveHorizontal(W, this.pos, this.radius, this.pos.y + 0.1, this.pos.y + this.height, this.hres);
    const ceil = ceilingOver(W, this.pos.x, this.pos.z, this.radius * 0.85, this.pos.y + 0.5);
    if (this.pos.y + this.height > ceil) this.pos.y = ceil - this.height;
    const g = groundUnder(W, this.pos.x, this.pos.z, this.radius * 0.85, this.pos.y + 0.05);
    if (this.pos.y < g) { this.pos.y = g; if (up < 0) { this.mode = 'walk'; this.climb = null; this.onGround = true; return; } }
    if (hr.hit) {
      c.nx = c.nx * 0.7 + hr.nx * 0.3; c.nz = c.nz * 0.7 + hr.nz * 0.3;
      const l = Math.hypot(c.nx, c.nz) || 1; c.nx /= l; c.nz /= l;
      c.lost = 0;
      const lift = hr.maxTop - this.pos.y;
      if (up > 0 && lift <= MANTLE_REACH && spaceFree(W, this.pos.x - c.nx * 0.6, this.pos.z - c.nz * 0.6, this.radius * 0.9, hr.maxTop + 0.05, hr.maxTop + this.height)) {
        this.mantle = { y: hr.maxTop + 0.02, nx: c.nx, nz: c.nz, t: 0 };
        this.mode = 'walk';
        this.climb = null;
        this.emit('mantle');
        return;
      }
    } else {
      c.lost += dt;
      if (c.lost > 0.25) {
        // reached the top edge without a wall: pull up over it
        this.mode = 'walk'; this.climb = null; this.vel.set(-c.nx * 2, 3, -c.nz * 2); return;
      }
    }
    if (inp.was('jump') || this.stamina <= 0 || inp.is('crouch')) {
      const push = inp.was('jump') && this.stamina > 0;
      this.mode = 'walk';
      this.vel.set(c.nx * (push ? 4.5 : 0.5), push ? 5.5 : 0, c.nz * (push ? 4.5 : 0.5));
      this.climb = null;
      this.emit(push ? 'walljump' : 'slip');
    }
    void wish; void moving;
  }

  hurt(amount, cause) {
    if (this.mode === 'dead' || this.game.settings.godMode) return;
    this.health -= amount;
    this.lastHurt = this.game.gameTime;
    this.emit('hurt', amount, cause);
    if (this.health <= 0) this.die(cause);
  }

  die(cause) {
    this.health = 0;
    this.mode = 'dead';
    this.deathTimer = 0;
    this.deathCause = cause;
    if (this.grapple) this.grapple.release(true);
    this.emit('death', cause);
  }

  updateDeath(dt) {
    this.deathTimer += dt;
    if (this.deathTimer > 3.2) this.respawn();
  }

  respawn() {
    // the safe position from a few seconds before the accident
    const p = this.safe.length > 3 ? this.safe[this.safe.length - 4] : this.safe[0];
    this.pos.copy(p || this.pos);
    this.vel.set(0, 0, 0);
    this.health = this.maxHealth * 0.6;
    this.stamina = this.maxStamina;
    this.mode = 'walk';
    this.emit('respawn');
  }

  updateStatus(dt) {
    // stamina regenerates when not climbing
    if (this.mode !== 'climb') {
      const rate = (this.onGround ? 22 : 8) * this.mods.staminaRegen;
      this.stamina = Math.min(this.maxStamina, this.stamina + rate * dt);
    }
    // health regenerates slowly after a while
    if (this.game.gameTime - this.lastHurt > 6) this.health = Math.min(this.maxHealth, this.health + (1.2 + this.mods.regen) * dt);
    // remember safe ground
    this.safeTimer += dt;
    if (this.safeTimer > 1.5) {
      this.safeTimer = 0;
      if (this.onGround && !this.inWater && this.mode === 'walk') {
        const last = this.safe[this.safe.length - 1];
        if (!last || last.distanceTo(this.pos) > 1) {
          this.safe.push(this.pos.clone());
          if (this.safe.length > 12) this.safe.shift();
        }
      }
    }
    this.deepest = Math.max(this.deepest, -this.pos.y);
    // fell out of the world
    if (this.pos.y < -1150) this.die('void');
  }

  updateCamera(dt) {
    const cam = this.camera;
    const targetEye = this.crouching ? 1.15 : this.eyeH;
    this.eyeCur = lerp(this.eyeCur, targetEye, 1 - Math.exp(-dt * 12));
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 0.5) this.bob += dt * hs * 1.9; else this.bob *= 0.92;
    const bobAmt = this.onGround ? clamp(hs / RUN, 0, 1) * 0.055 : 0;
    this.landDip *= Math.exp(-dt * 7);
    const deadDrop = this.mode === 'dead' ? Math.min(1.3, this.deathTimer * 1.2) : 0;
    cam.position.set(this.pos.x, this.pos.y + this.eyeCur + Math.sin(this.bob) * bobAmt - this.landDip - deadDrop, this.pos.z);
    const strafe = this.input.axis.active ? this.input.axis.x : this.input.is('right') - this.input.is('left');
    const roll = this.mode === 'dead' ? Math.min(0.9, this.deathTimer * 0.8) : -strafe * 0.012;
    this.rollCur = lerp(this.rollCur || 0, roll, 1 - Math.exp(-dt * 6));
    cam.rotation.set(this.pitch, this.yaw, this.rollCur, 'YXZ');
    // field of view: running and fast falls widen it, observing narrows it
    const base = this.game.settings.fov || 75;
    let fov = base;
    if (this.zoomed) fov = base * 0.32;
    else {
      if (this.input.is('run') && hs > WALK + 0.5) fov += 5;
      const speed = this.vel.length();
      if (speed > 14) fov += Math.min(12, (speed - 14) * 0.5);
    }
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = lerp(cam.fov, fov, 1 - Math.exp(-dt * (this.zoomed ? 10 : 5)));
      cam.updateProjectionMatrix();
    }
  }

  serialize() {
    return { x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw, pitch: this.pitch, health: this.health, stamina: this.stamina, deepest: this.deepest, travelled: this.distanceTravelled, safe: this.safe.map((p) => [p.x, p.y, p.z]) };
  }

  restore(s) {
    this.pos.set(s.x, s.y, s.z);
    this.yaw = s.yaw; this.pitch = s.pitch;
    this.health = s.health ?? 100; this.stamina = s.stamina ?? 100;
    this.deepest = s.deepest || 0; this.distanceTravelled = s.travelled || 0;
    this.safe = (s.safe || []).map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    if (!this.safe.length) this.safe.push(this.pos.clone());
  }
}

void M;
