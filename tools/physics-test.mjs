// Deterministic physics test: steps the player at 60 Hz inside the page with scripted input.
import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const seed = process.argv[2] || '12345';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${BASE}/index.html?debug=1&play=1&seed=${seed}&shadows=0&vd=0.5`);
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 240000 });
const res = await page.evaluate(() => {
  const g = window.__descents;
  g.paused = true; // stop the render loop from stepping
  const p = g.player, inp = g.input;
  const out = [];
  const snap = (label) => out.push(label + ' ' + JSON.stringify({ x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2), g: p.onGround, m: p.mode, hp: +p.health.toFixed(1), st: +p.stamina.toFixed(0), vy: +p.vel.y.toFixed(2) }));
  const run = (secs, keys = [], each) => { for (let i = 0; i < secs * 60; i++) { inp.down = new Set(keys); if (each) each(i); p.update(1 / 60); g.grapple.update(1 / 60); inp.endFrame(); } };
  snap('start');
  run(1); snap('settle');
  run(3, ['KeyW']); snap('walk 3s');
  run(3, ['KeyW', 'ShiftLeft']); snap('run 3s');
  run(0.05, ['Space']); run(0.3); snap('jump apex-ish');
  run(1.5); snap('landed');
  // fall from 12 m
  p.pos.y += 12; p.vel.set(0, 0, 0); run(3); snap('fell 12m');
  // fall from 30 m (should be lethal)
  p.health = 100; p.pos.y += 30; p.vel.set(0, 0, 0); run(2); snap('fell 30m'); run(4); snap('respawned');
  // grapple: look down-forward at the ground and fire
  p.pitch = -0.6; p.update(1/60); g.grapple.fire(); out.push('aim ' + JSON.stringify(g.grapple.aim) + ' target ' + JSON.stringify(g.grapple.hookTarget) + ' valid ' + g.grapple.targetValid + ' cam ' + JSON.stringify(g.camera.position));
  run(0.5); out.push('grapple ' + g.grapple.state + ' rope ' + g.grapple.ropeLen.toFixed(2));
  run(1.5, ['KeyQ']); snap('reeled'); out.push('grapple after reel ' + g.grapple.state);
  g.grapple.release(); run(1);
  // walk off toward the abyss for a while (rim cliff)
  p.yaw = Math.atan2(p.pos.x, p.pos.z); // face the centre
  run(6, ['KeyW', 'ShiftLeft']); snap('ran toward the abyss 6s');
  return out;
});
for (const l of res) console.log(l);
for (const l of logs) console.log(l);
await browser.close();
