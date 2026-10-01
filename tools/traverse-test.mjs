// Physical traversal test: an autopilot walks the explorer (real player
// physics: running, step-up, mantling, jumping when blocked) along every
// guaranteed route from the city down to the Threshold of Layer 3.
// usage: node tools/traverse-test.mjs [seed]
import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const seed = process.argv[2] || 'Ashen Rim 4242';
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/index.html`);
await page.waitForSelector('.title-panel');
await page.fill('#seed', seed);
await page.click('[data-act=new]');
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 300000 });
await page.evaluate(() => {
  const g = window.__descents;
  window.__app.resume();
  g.paused = true;
  g.renderer.render = () => {};
  g.settings.godMode = false;
  let deaths = 0;
  g.player.on('death', () => { deaths++; });
  window.__deaths = () => deaths;
  /** Walk a route with the real controller. Returns progress statistics. */
  window.__walk = (name, maxSeconds = 240) => {
    const r = g.plan.routes.find((rr) => rr.name === name);
    if (!r) return { name, missing: true };
    const p = g.player, pts = r.pts, n = pts.length / 3;
    p.pos.set(pts[0], pts[1] + 0.05, pts[2]); p.vel.set(0, 0, 0);
    p.safe = [p.pos.clone()]; p.mode = 'walk'; p.health = 100; p.stamina = 100;
    if (g.grapple.state !== 'idle') g.grapple.release(true);
    const d0 = deaths;
    let idx = 0, t = 0, stuckT = 0, maxIdx = 0, jumps = 0, progIdx = 0, progT = 0;
    const dt = 1 / 30;
    let routeLen = 0;
    for (let k = 1; k < n; k++) routeLen += Math.hypot(pts[k * 3] - pts[k * 3 - 3], pts[k * 3 + 2] - pts[k * 3 - 1]);
    maxSeconds = Math.max(maxSeconds, routeLen / 3 + 60);
    let last = p.pos.clone();
    while (t < maxSeconds) {
      // closest route point ahead of the explorer
      let best = idx, bd = Infinity;
      for (let k = Math.max(0, idx - 5); k < Math.min(n, idx + 60); k++) {
        const d = Math.hypot(pts[k * 3] - p.pos.x, pts[k * 3 + 2] - p.pos.z) + Math.abs(pts[k * 3 + 1] - p.pos.y) * 0.7;
        if (d < bd) { bd = d; best = k; }
      }
      idx = best; maxIdx = Math.max(maxIdx, idx);
      if (idx >= n - 2) { maxIdx = n - 1; break; }
      // aim at a point a little further along the route (closer when off the line)
      let tg = idx, acc = 0;
      const look = bd > 1.2 ? 1.2 : 2.2;
      while (tg < n - 1 && acc < look) { acc += Math.hypot(pts[tg * 3 + 3] - pts[tg * 3], pts[tg * 3 + 5] - pts[tg * 3 + 2]); tg++; }
      const tx = pts[tg * 3], tz = pts[tg * 3 + 2];
      p.yaw = Math.atan2(-(tx - p.pos.x), -(tz - p.pos.z));
      p.pitch = 0;
      const keys = ['KeyW'];
      const moved = Math.hypot(p.pos.x - last.x, p.pos.z - last.z);
      last.copy(p.pos);
      stuckT = moved < 0.05 ? stuckT + dt : 0;
      if (idx > progIdx) { progIdx = idx; progT = t; }
      // fell into water off a bridge: swim back toward the route further ahead, as a person would
      if (p.inWater && t - progT > 2) {
        const k2 = Math.min(n - 1, idx + 12);
        p.yaw = Math.atan2(-(pts[k2 * 3] - p.pos.x), -(pts[k2 * 3 + 2] - p.pos.z));
      }
      if (t - progT > 12) { stuckT = 99; }
      if (stuckT > 3 && !window.__stuck) {
        const c = g.world.columnAt(p.pos.x, p.pos.z);
        const spans = [];
        for (let s2 = 0; s2 < c.n; s2++) spans.push(`${c.y[(c.off + s2) * 2]}..${c.y[(c.off + s2) * 2 + 1]}`);
        const ahead = g.world.columnAt(p.pos.x - Math.sin(p.yaw) * 0.8, p.pos.z - Math.cos(p.yaw) * 0.8);
        const sa = [];
        for (let s2 = 0; s2 < ahead.n; s2++) sa.push(`${ahead.y[(ahead.off + s2) * 2]}..${ahead.y[(ahead.off + s2) * 2 + 1]}`);
        const cols = g.world.collidersNear(p.pos.x, p.pos.z, 3).filter((cc) => cc.t === 'cyl' ? Math.hypot(cc.x - p.pos.x, cc.z - p.pos.z) < cc.r + 1.5 : true).length;
        window.__stuck = { route: name, idx, pos: p.pos.toArray().map((v) => +v.toFixed(2)), routeY: +pts[idx * 3 + 1].toFixed(2), mode: p.mode, onGround: p.onGround, spans: spans.slice(-3), ahead: sa.slice(-3), colliders: cols, inWater: p.inWater, bd: +bd.toFixed(2) };
      }
      if (stuckT > 0.4) { keys.push('Space'); jumps++; }
      if (bd < 0.8) keys.push('ShiftLeft');
      if (t - progT > 30) break;
      for (const k of keys) { if (!g.input.down.has(k)) g.input.pressed.add(k); g.input.down.add(k); }
      g.update(dt);
      g.input.endFrame();
      for (const k of keys) g.input.down.delete(k);
      t += dt;
      if (p.mode === 'dead') { for (let i = 0; i < 120 && p.mode === 'dead'; i++) { g.update(dt); g.input.endFrame(); } }
      if (t > 20 && t % 10 < dt) g.chunks.update(p.pos);
    }
    let len = 0;
    for (let k = 1; k < n; k++) len += Math.hypot(pts[k * 3] - pts[k * 3 - 3], pts[k * 3 + 2] - pts[k * 3 - 1]);
    return { name, length: Math.round(len), progress: +(maxIdx / (n - 1)).toFixed(3), seconds: Math.round(t), deaths: deaths - d0, jumps, endY: Math.round(p.pos.y), health: Math.round(p.health) };
  };
});
const routes = await page.evaluate(() => {
  const plan = window.__descents.plan;
  const names = plan.validation.routes.map((r) => r.name);
  const pick = (re) => names.filter((n) => re.test(n));
  return [...pick(/Stairway$/).slice(0, 2), "Delvers' Road", 'River Trail', 'Cavern Way', 'Ridge Trail', 'Lip Approach', 'Throat Trail', 'The Great Spiral', ...pick(/Trail I+$/).slice(0, 2), 'The Long Stair', 'Plain Trail', 'Threshold Descent'].filter((n) => names.includes(n));
});
const only = process.env.ROUTES ? process.env.ROUTES.split(',').map((x) => x.trim()) : null;
let ok = true;
for (const name of routes) {
  if (only && !only.includes(name)) continue;
  const res = await page.evaluate(([n]) => window.__walk(n, 420), [name]);
  const pass = res.progress > 0.97 && res.deaths === 0;
  const st = await page.evaluate(() => { const s2 = window.__stuck; window.__stuck = null; return s2; });
  if (!pass && st) console.log('     stuck:', JSON.stringify(st));
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${JSON.stringify(res)}`);
}
if (errors.length) { ok = false; console.log('page errors:', errors.slice(0, 5)); }
console.log(ok ? 'All routes walked.' : 'Some routes could not be walked.');
await browser.close();
process.exit(ok ? 0 : 1);
