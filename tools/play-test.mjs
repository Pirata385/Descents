// Headless gameplay test: spawn the player, walk, jump, fall, grapple.
import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const seed = process.argv[2] || '12345';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${BASE}/index.html?debug=1&play=1&seed=${seed}&shadows=0&vd=0.6`);
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 240000 });
const st = () => page.evaluate(() => { const p = window.__descents.player; return { x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2), ground: p.onGround, mode: p.mode, hp: +p.health.toFixed(1), vy: +p.vel.y.toFixed(2) }; });
const key = async (code, ms) => { await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c })), code); await page.waitForTimeout(ms); await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c })), code); };
console.log('spawn', await st());
await page.waitForTimeout(1500);
console.log('settled', await st());
await key('KeyW', 2500);
console.log('after walking forward 2.5s', await st());
await key('Space', 100);
await page.waitForTimeout(300);
console.log('mid-jump', await st());
await page.waitForTimeout(1200);
console.log('landed', await st());
// grapple: aim at the ground ahead and fire
await page.evaluate(() => { const p = window.__descents.player; p.pitch = -0.5; });
await page.waitForTimeout(200);
await page.evaluate(() => { const g = window.__descents.grapple; g.fire(); });
await page.waitForTimeout(800);
console.log('grapple state', await page.evaluate(() => { const g = window.__descents.grapple; return { state: g.state, rope: +g.ropeLen.toFixed(2), aim: g.aim }; }));
await page.evaluate(() => { window.__descents.grapple.release(); });
// drop test: noclip up 30m then fall
await page.evaluate(() => { const p = window.__descents.player; p.pos.y += 25; p.vel.set(0, 0, 0); });
await page.waitForTimeout(3500);
console.log('after 25m fall', await st());
for (const l of logs.slice(-10)) console.log(l);
await browser.close();
