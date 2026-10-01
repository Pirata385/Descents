// Grappling-arm scenario: from the foot of the rim cliff in Layer 1, fire the
// claw at the cliff top, reel in and get pulled over the edge — no stairs.
// usage: node tools/grapple-test.mjs [seed]
import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const seed = process.argv[2] || 'Ashen Rim 4242';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/index.html`);
await page.waitForSelector('.title-panel');
await page.fill('#seed', seed);
await page.click('[data-act=new]');
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 300000 });
const res = await page.evaluate(() => {
  const g = window.__descents, p = g.player, f = g.world.field, W = g.world;
  window.__app.resume();
  g.paused = true;
  g.renderer.render = () => {};
  const out = [];
  const step = (n, keys = []) => { for (let i = 0; i < n; i++) { for (const k of keys) { if (!g.input.down.has(k)) g.input.pressed.add(k); g.input.down.add(k); } g.update(1 / 30); g.input.endFrame(); for (const k of keys) g.input.down.delete(k); } };
  const fire = () => { g.input.clicked |= 1; g.update(1 / 30); g.input.endFrame(); };
  // try several angles until a clean cliff is found
  for (let k = 0; k < 24; k++) {
    const th = -Math.PI + (k / 24) * Math.PI * 2 + 0.07;
    const Rr = f.tab(f.rimTab, th);
    const [bx, bz] = f.fromPolar(Rr - 14, th);
    const by = W.floorBelow(bx, 100, bz);
    const [tx, tz] = f.fromPolar(Rr + 4, th);
    const ty = W.floorBelow(tx, 200, tz);
    if (!(ty - by > 25 && ty - by < 55)) continue;
    if (!Number.isNaN(W.columnAt(bx, bz).water)) continue;
    p.pos.set(bx, by, bz); p.vel.set(0, 0, 0); p.safe = [p.pos.clone()]; p.mode = 'walk'; p.health = 100;
    if (g.grapple.state !== 'idle') { g.grapple.state = 'idle'; }
    step(10);
    // aim at the lip of the cliff top
    const eye = p.eyePos;
    const [ax, az] = f.fromPolar(Rr + 1.0, th);
    p.yaw = Math.atan2(-(ax - eye.x), -(az - eye.z));
    p.pitch = Math.atan2(ty + 0.3 - eye.y, Math.hypot(ax - eye.x, az - eye.z));
    step(1);
    const y0 = p.pos.y;
    fire();
    step(20);
    const attached = g.grapple.state === 'attached';
    if (!attached) { out.push({ th: +th.toFixed(2), cliff: Math.round(ty - by), attached, aim: g.grapple.aim }); continue; }
    let pulled = false;
    for (let i = 0; i < 30 * 12 && !pulled; i++) {
      step(1, ['KeyQ', 'KeyW']);
      if (g.grapple.state !== 'attached' && p.pos.y > ty - 1) pulled = true;
    }
    step(30, ['KeyW']);
    out.push({ th: +th.toFixed(2), cliff: Math.round(ty - by), fromY: Math.round(y0), topY: Math.round(ty), endY: Math.round(p.pos.y), pulled, onTop: p.pos.y > ty - 1.5, health: Math.round(p.health), mode: p.mode });
    if (pulled) break;
  }
  return out;
});
for (const r of res) console.log(JSON.stringify(r));
const ok = res.some((r) => r.pulled && r.onTop);
if (errors.length) console.log('page errors:', errors.slice(0, 5));
console.log(ok ? 'Climbed the rim cliff with the grappling arm.' : 'Grapple climb failed.');
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
