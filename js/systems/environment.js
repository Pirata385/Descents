// Samples the surroundings of the explorer a few times per second: nearby
// still and running water, waterfalls, the city, and the drop beneath the
// feet. Feeds the ambience mix.
import { clamp } from '../core/mathutil.js';
import { Z_CITY, Z_COUNTRY } from '../world/field.js';

export class EnvironmentProbe {
  constructor(game) {
    this.game = game;
    this.timer = 0;
    this.state = { water: 0, river: 0, fall: 0, city: 0, altitude: 0 };
    this.target = { ...this.state };
    this.falls = (game.plan.waterfalls || []).map((w) => ({ x: w.x, z: w.z, y0: w.bottomY, y1: w.topY, w: w.width || 3 }));
  }

  update(dt) {
    const g = this.game, p = g.player;
    if (!p) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.4;
      this.sample(p.pos);
    }
    const k = Math.min(1, dt * 2);
    for (const key of Object.keys(this.state)) this.state[key] += (this.target[key] - this.state[key]) * k;
  }

  sample(pos) {
    const W = this.game.world;
    let best = Infinity, flow = 0;
    for (const r of [0, 4, 10, 18, 30]) {
      const n = r === 0 ? 1 : 8;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r;
        const c = W.columnAt(pos.x + Math.cos(a) * r, pos.z + Math.sin(a) * r);
        if (Number.isNaN(c.water) || Math.abs(c.water - pos.y) > 22) continue;
        if (r < best) best = r;
        flow = Math.max(flow, Math.hypot(c.flowX || 0, c.flowZ || 0) * clamp(1 - r / 34, 0, 1));
      }
      if (best < Infinity && r > best + 10) break;
    }
    const T = this.target;
    T.water = best < Infinity ? clamp(1 - best / 34, 0, 1) : 0;
    T.river = clamp(flow * 1.6, 0, 1);
    // waterfalls: distance to the falling column of water
    let fall = 0;
    for (const f of this.falls) {
      const dh = Math.hypot(f.x - pos.x, f.z - pos.z);
      if (dh > 400) continue;
      const dy = pos.y > f.y1 ? pos.y - f.y1 : pos.y < f.y0 ? f.y0 - pos.y : 0;
      const d = Math.hypot(dh, dy);
      fall = Math.max(fall, clamp(1 - d / 260, 0, 1) ** 2 * clamp(f.w / 3, 0.5, 1.5));
    }
    T.fall = clamp(fall, 0, 1);
    const info = this.game.layerInfo;
    T.city = info && pos.y > -30 ? (info.zone === Z_CITY ? 1 : info.zone === Z_COUNTRY ? 0.3 : 0) : 0;
    const fl = W.floorBelow(pos.x, pos.y + 0.5, pos.z);
    T.altitude = fl === -Infinity ? 200 : clamp(pos.y - fl, 0, 200);
  }
}
