// Game orchestration: world plan generation in a worker, streaming, systems
// update loop and rendering. Systems are attached as they are created.
import * as THREE from 'three';
import { createWorkerPool, createInlinePool } from './core/workers.js';
import { normalizeSeed } from './core/rng.js';
import { World } from './world/world.js';
import { ChunkManager } from './render/chunkManager.js';
import { GameRenderer } from './render/renderer.js';
import { Input } from './core/input.js';
import { clamp } from './core/mathutil.js';
import { CF } from './world/column.js';

export class Game {
  constructor(canvas, settings, hooks = {}) {
    this.canvas = canvas;
    this.settings = settings;
    this.hooks = hooks;
    this.input = new Input(canvas);
    this.running = false;
    this.paused = false;
    this.systems = [];
    this.timeOfDay = 9;
    this.gameTime = 0;
    // frame pacing (see schedule): a message channel runs frames back to back
    // without waiting for the display, timers hold a chosen cap
    this.chan = new MessageChannel();
    this.chan.port1.onmessage = () => this.tick();
    this.nextAt = 0;
    this.lastVsync = 0;
    this.refreshHz = 60;
    this.measureRefresh();
  }

  /** The display's refresh rate, from a few animation frames. */
  measureRefresh() {
    const ts = [];
    const f = (t) => {
      ts.push(t);
      if (ts.length < 24) { requestAnimationFrame(f); return; }
      const d = ts.slice(1).map((v, i) => v - ts[i]).sort((a, b) => a - b);
      const med = d[d.length >> 1];
      if (med > 2) this.refreshHz = Math.round(1000 / med);
    };
    requestAnimationFrame(f);
  }

  /**
   * Queue the next frame. settings.fpsLimit: 0 = unlimited, -1 = the display's
   * refresh rate (V-Sync), N = at most N frames a second. Every display refresh
   * gets a frame; when more are wanted (unlimited, or a cap above the refresh
   * rate) extra frames run back to back through a message channel in the first
   * part of each refresh interval, leaving the rest to the browser so it can
   * present the picture and handle input. Menus and hidden tabs follow the display.
   */
  schedule() {
    if (this.queued) return;
    this.queued = true;
    const lim = this.settings.fpsLimit ?? 0;
    const extra = !(lim === -1 || this.paused || document.hidden || (lim > 0 && lim <= this.refreshHz * 0.92));
    if (extra) {
      const now = performance.now();
      const until = this.lastVsync + (1000 / this.refreshHz) * 0.7;
      const wait = lim > 0 ? Math.max(0, this.nextAt - now) : 0;
      if (now + wait < until) {
        if (wait > 3) setTimeout(() => this.chan.port2.postMessage(0), wait - 2);
        else this.chan.port2.postMessage(0);
        return;
      }
    }
    requestAnimationFrame((t) => { this.queued = false; this.lastVsync = performance.now(); this.frame(t); });
  }

  tick() {
    this.queued = false;
    const lim = this.settings.fpsLimit ?? 0;
    const now = performance.now();
    if (lim > 0 && now < this.nextAt - 0.25) { this.schedule(); return; }
    this.frame(now);
  }

  progress(stage, p) { if (this.hooks.onProgress) this.hooks.onProgress(stage, p); }

  async generatePlan(seed) {
    const hw = navigator.hardwareConcurrency || 4;
    const n = clamp(hw - 1, 2, 6);
    let pool = createWorkerPool(n);
    const tryPlan = (pool) => new Promise((resolve, reject) => {
      const w = pool[0].worker;
      const onMsg = (e) => {
        const m = e.data;
        if (m.type === 'progress') this.progress(m.stage, m.p * 0.7);
        else if (m.type === 'plan') { w.removeEventListener('message', onMsg); resolve(m.plan); }
        else if (m.type === 'error') { w.removeEventListener('message', onMsg); reject(new Error(m.message)); }
      };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', (ev) => reject(ev.error || new Error('worker failed to start')));
      w.postMessage({ type: 'plan', seed });
    });
    let plan;
    try {
      plan = await tryPlan(pool);
    } catch (err) {
      console.warn('Module workers unavailable, falling back to main-thread generation.', err);
      for (const p of pool) p.worker.terminate();
      pool = createInlinePool(1);
      plan = await tryPlan(pool);
    }
    // the other workers receive the finished plan
    await Promise.all(pool.slice(1).map((p) => new Promise((resolve) => {
      const onMsg = (e) => { if (e.data.type === 'ready') { p.worker.removeEventListener('message', onMsg); resolve(); } };
      p.worker.addEventListener('message', onMsg);
      p.worker.postMessage({ type: 'init', plan });
    })));
    this.pool = pool;
    return plan;
  }

  async start({ seed, save = null }) {
    const s = save ? save.seed : normalizeSeed(seed);
    this.seedLabel = save ? save.seedLabel : String(seed);
    this.progress('Preparing the expedition', 0.01);
    const plan = await this.generatePlan(s);
    this.plan = plan;
    this.world = new World(plan);
    this.renderer = new GameRenderer(this.canvas, plan, this.settings);
    this.camera = this.renderer.camera;
    this.chunks = new ChunkManager({ world: this.world, scene: this.renderer.scene, workers: this.pool, quality: this.settings.viewDistance || 1.0, renderChunks: this.settings.renderChunks || 12 });
    if (this.hooks.onWorldReady) await this.hooks.onWorldReady(this, save);
    // initial streaming around the start position
    const focus = this.focusPoint();
    this.chunks.update(focus);
    await new Promise((resolve) => {
      const tick = () => {
        this.chunks.update(this.focusPoint());
        const near = this.chunks.nearReady(160);
        this.progress('Charting the surroundings', 0.7 + near * 0.3);
        if (near >= 0.999 && this.chunks.coverage > 0.6) resolve();
        else setTimeout(tick, 60);
      };
      tick();
    });
    this.running = true;
    this.last = performance.now();
    this.chunkTimer = 0;
    this.schedule();
  }

  focusPoint() {
    if (this.player) return this.player.pos;
    return this.camera.position;
  }

  frame(t) {
    if (!this.running) return;
    // a cap below the refresh rate: skip display frames that come too early
    const lim = this.settings.fpsLimit ?? 0;
    if (lim > 0 && t < this.nextAt - 1.5) { this.schedule(); return; }
    if (lim > 0) this.nextAt = Math.max(this.nextAt + 1000 / lim, t);
    this.schedule();
    // one clock for every pacing mode (animation-frame timestamps can lag performance.now())
    const now = performance.now();
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = Math.min(Math.max(dt, 0.0002), 0.1);
    if (!this.paused) this.update(dt);
    else if (this.hooks.onPausedFrame) this.hooks.onPausedFrame(dt);
    this.input.endFrame();
  }

  update(dt) {
    this.gameTime += dt;
    this.timeOfDay = (this.timeOfDay + dt / 60) % 24; // one game hour per real minute
    for (const s of this.systems) if (s.update) s.update(dt);
    this.chunkTimer -= dt;
    if (this.chunkTimer <= 0) {
      this.chunkTimer = 0.25;
      this.chunks.update(this.focusPoint());
    }
    const p = this.focusPoint();
    const info = this.world.info(p.x, p.y, p.z);
    const flags = this.world.flagsAt(p.x, p.z);
    const enclosed = (flags & (CF.CAVE | CF.GALLERY0 | CF.GALLERY1 | CF.GALLERY2)) && this.world.ceilingAbove(p.x, p.y + 1.6, p.z) < Infinity ? 1 : 0;
    this.envEnclosed = (this.envEnclosed ?? 0) + (enclosed - (this.envEnclosed ?? 0)) * Math.min(1, dt * 2);
    this.layerInfo = info;
    this.renderer.update(dt, p, { layer: info.layer, zone: info.zone, y: p.y, enclosed: this.envEnclosed, timeOfDay: this.timeOfDay });
    for (const s of this.systems) if (s.lateUpdate) s.lateUpdate(dt);
    this.renderer.render();
  }
}

/** Draw the world without advancing the simulation (waiting screens, after a resize). */
Game.prototype.renderOnly = function renderOnly(dt) {
  this.chunkTimer -= dt;
  if (this.chunkTimer <= 0) { this.chunkTimer = 0.25; this.chunks.update(this.focusPoint()); }
  const p = this.focusPoint();
  const info = this.world.info(p.x, p.y, p.z);
  this.renderer.update(dt, p, { layer: info.layer, zone: info.zone, y: p.y, enclosed: this.envEnclosed ?? 0, timeOfDay: this.timeOfDay });
  this.renderer.render();
};

/** Free-flying debug camera used by the test harness (?debug=1). */
export class DebugCamera {
  constructor(game, pose) {
    this.game = game;
    this.cam = game.camera;
    this.pos = new THREE.Vector3(pose.x, pose.y, pose.z);
    this.yaw = pose.yaw || 0;
    this.pitch = pose.pitch || 0;
    this.speed = 20;
    this.cam.position.copy(this.pos);
  }
  update(dt) {
    const inp = this.game.input;
    this.yaw -= inp.mouseDX * 0.002;
    this.pitch = clamp(this.pitch - inp.mouseDY * 0.002, -1.5, 1.5);
    const f = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const sp = this.speed * (inp.is('run') ? 5 : 1);
    if (inp.is('forward')) this.pos.addScaledVector(f, sp * dt);
    if (inp.is('back')) this.pos.addScaledVector(f, -sp * dt);
    if (inp.is('left')) this.pos.addScaledVector(r, -sp * dt);
    if (inp.is('right')) this.pos.addScaledVector(r, sp * dt);
    this.cam.position.copy(this.pos);
    this.cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
