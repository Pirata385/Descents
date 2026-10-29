// PS4 controller test in headless Chromium: a scripted DualShock 4 (standard
// mapping) drives the title menu, settings, starting a world, movement, look,
// jumping, the grappling arm, the pause menu and the journal.
// usage: node tools/gamepad-test.mjs <outDir> [seed]
import { createRequire } from 'node:module';
import fs from 'node:fs';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const [outDir = 'tests/output', seed = 'Pad Test 77'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.addInitScript(() => {
  const btn = () => ({ pressed: false, touched: false, value: 0 });
  window.__rumbles = [];
  window.__pad = {
    id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', index: 0, connected: true, mapping: 'standard', timestamp: 1,
    buttons: Array.from({ length: 18 }, btn), axes: [0, 0, 0, 0],
    vibrationActuator: { type: 'dual-rumble', playEffect: (t, p) => { window.__rumbles.push(p); return Promise.resolve('complete'); } },
  };
  navigator.getGamepads = () => [window.__pad, null, null, null];
  window.__btn = (i, on) => { const b = window.__pad.buttons[i]; b.pressed = on; b.value = on ? 1 : 0; window.__pad.timestamp++; };
  window.__axes = (a) => { window.__pad.axes = a; window.__pad.timestamp++; };
  window.__frames = (n) => new Promise((r) => { let k = n; const f = () => (--k <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  // light settings so software rendering keeps up
  try { localStorage.setItem('descents.settings.v1', JSON.stringify({ viewDistance: 0.5, shadows: false, pixelRatio: 0.5, particles: 0.25, autoQuality: false })); } catch { /* ignore */ }
});
const B = { CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3, L1: 4, R1: 5, L2: 6, R2: 7, SHARE: 8, OPTIONS: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const frames = (n) => page.evaluate((n) => window.__frames(n), n);
const tap = async (i, hold = 3) => { await page.evaluate((i) => window.__btn(i, true), i); await frames(hold); await page.evaluate((i) => window.__btn(i, false), i); await frames(3); };
const axes = (a) => page.evaluate((a) => window.__axes(a), a);
const focus = () => page.evaluate(() => { const e = document.querySelector('.gp-focus'); return e ? (e.dataset.key || e.dataset.act || e.dataset.tab || e.textContent.trim().slice(0, 30)) : null; });
const shot = async (name) => { await page.screenshot({ path: `${outDir}/${name}.png`, timeout: 180000 }); console.log('shot', name); };
let fails = 0;
const check = (ok, what, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };

await page.goto(`${BASE}/index.html`);
await page.waitForSelector('.title-panel');
await page.evaluate(() => { const e = new Event('gamepadconnected'); e.gamepad = window.__pad; window.dispatchEvent(e); });
await page.waitForTimeout(200);
check(await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /PlayStation controller/.test(t.textContent))), 'connection toast names the PlayStation controller');
// --- title menu
await tap(B.DOWN);
check(await page.evaluate(() => document.body.classList.contains('gamepad')), 'controller becomes the active device');
let f = await focus();
check(!!f, 'menu focus appears', f);
// walk down to Settings
for (let i = 0; i < 8 && (await focus()) !== 'settings'; i++) await tap(B.DOWN);
check((await focus()) === 'settings', 'reach Settings with the d-pad');
await tap(B.CROSS);
check(await page.evaluate(() => !!document.querySelector('.panel.settings')), 'settings open with ✕');
for (let i = 0; i < 20 && (await focus()) !== 'padLook'; i++) await tap(B.DOWN);
check((await focus()) === 'padLook', 'reach the stick look slider');
const before = await page.evaluate(() => window.__app.settings.padLook);
await tap(B.RIGHT); await tap(B.RIGHT);
const after = await page.evaluate(() => window.__app.settings.padLook);
check(after > before, 'd-pad right raises the slider', `${before} → ${after}`);
await tap(B.LEFT); await tap(B.LEFT);
await shot('pad1-settings');
await tap(B.CIRCLE);
check(await page.evaluate(() => !!document.querySelector('.title-panel')), '○ goes back to the title');
// start a world
await page.fill('#seed', seed);
await page.evaluate(() => document.activeElement && document.activeElement.blur());
for (let i = 0; i < 8 && (await focus()) !== 'new'; i++) await tap(B.UP);
check((await focus()) === 'new', 'reach "Begin a new descent"');
await tap(B.CROSS);
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 300000 });
check(await page.evaluate(() => /Press ✕/.test(document.querySelector('.click-msg')?.textContent || '')), 'the start screen asks for ✕');
await tap(B.CROSS);
await frames(2);
check(await page.evaluate(() => window.__app.state) === 'playing', '✕ starts play');
await frames(20);
// --- play: move, look, jump, grapple
const p0 = await page.evaluate(() => { const p = window.__descents.player; return { x: p.pos.x, z: p.pos.z, yaw: p.yaw, pitch: p.pitch }; });
await axes([0, -1, 0, 0]);
await frames(30);
await axes([0, 0, 0, 0]);
const p1 = await page.evaluate(() => { const p = window.__descents.player; return { x: p.pos.x, z: p.pos.z }; });
const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
check(moved > 1.5, 'left stick walks', `${moved.toFixed(2)} m`);
await axes([0, 0, 0.8, 0]);
await frames(12);
await axes([0, 0, 0, -0.6]);
await frames(8);
await axes([0, 0, 0, 0]);
const p2 = await page.evaluate(() => { const p = window.__descents.player; return { yaw: p.yaw, pitch: p.pitch }; });
check(p2.yaw < p0.yaw - 0.3, 'right stick turns right', `${(p0.yaw - p2.yaw).toFixed(2)} rad`);
check(p2.pitch > p0.pitch + 0.1, 'right stick up looks up', `${(p2.pitch - p0.pitch).toFixed(2)} rad`);
await page.evaluate(() => { window.__jumped = false; window.__descents.player.on('jump', () => { window.__jumped = true; }); });
await tap(B.CROSS, 4);
await frames(4);
check(await page.evaluate(() => window.__jumped), '✕ jumps');
await page.evaluate(() => { const p = window.__descents.player; p.pitch = -0.6; });
await tap(B.R1, 3);
await frames(2);
const gs = await page.evaluate(() => window.__descents.grapple.state);
check(gs !== 'idle', 'R1 fires the grappling arm', gs);
await frames(20);
await tap(B.R1);
await frames(5);
await page.evaluate(() => { window.__swung = 0; window.__descents.combat.on((t) => { if (t === 'swing' || t === 'shot') window.__swung++; }); });
await tap(B.R2, 3);
await frames(4);
check(await page.evaluate(() => window.__swung > 0), 'R2 attacks', `${await page.evaluate(() => window.__swung)} blows`);
check(await page.evaluate(() => window.__rumbles.length > 0), 'the controller rumbles', `${await page.evaluate(() => window.__rumbles.length)} effects`);
// run toggle
await tap(B.L3);
await axes([0, -1, 0, 0]);
await frames(4);
check(await page.evaluate(() => window.__descents.input.is('run')), 'L3 toggles running');
await axes([0, 0, 0, 0]);
await frames(20);
check(!(await page.evaluate(() => window.__descents.input.is('run'))), 'stopping ends the run');
await shot('pad2-play');
// --- pause menu
await tap(B.OPTIONS);
check(await page.evaluate(() => window.__app.state) === 'paused', 'Options pauses');
check((await focus()) === 'resume', 'pause menu focuses Resume', await focus());
await shot('pad3-pause');
await tap(B.DOWN); await tap(B.DOWN); await tap(B.DOWN); await tap(B.DOWN);
check((await focus()) === 'settings', 'pause menu navigation', await focus());
await tap(B.CROSS);
check(await page.evaluate(() => !!document.querySelector('.panel.settings')), 'settings from pause');
await tap(B.CIRCLE);
check(await page.evaluate(() => !!document.querySelector('.panel.pause')), '○ back to the pause menu');
await tap(B.CIRCLE);
check(await page.evaluate(() => window.__app.state) === 'playing', '○ resumes');
// --- journal
await tap(B.LEFT);
check(await page.evaluate(() => window.__app.state === 'journal' && window.__app.journal.tab === 'map'), 'd-pad left opens the map');
const z0 = await page.evaluate(() => window.__app.journal.map.zoom);
await page.evaluate(() => window.__btn(7, true)); await frames(15); await page.evaluate(() => window.__btn(7, false));
const z1 = await page.evaluate(() => window.__app.journal.map.zoom);
check(z1 > z0 * 1.3, 'R2 zooms the map', `${z0.toFixed(2)} → ${z1.toFixed(2)}`);
await axes([0, 0, 1, 0]); await frames(8); await axes([0, 0, 0, 0]);
check(await page.evaluate(() => window.__app.journal.map.follow === false), 'right stick pans the map');
await tap(B.R1);
check(await page.evaluate(() => window.__app.journal.tab) === 'abyss', 'R1 next tab');
await tap(B.R1);
check(await page.evaluate(() => window.__app.journal.tab) === 'creatures', 'R1 creatures tab');
await shot('pad4-journal');
await tap(B.CIRCLE);
await frames(2);
check(await page.evaluate(() => window.__app.state) === 'playing', '○ closes the journal back to play');
// a held button across the change must not leak into play (✕ resumed, no jump)
await tap(B.OPTIONS);
await page.evaluate(() => { window.__jumped = false; });
await page.evaluate(() => window.__btn(0, true));
await frames(8);
check(await page.evaluate(() => window.__app.state) === 'playing', '✕ on Resume');
check(!(await page.evaluate(() => window.__jumped)), 'the resuming ✕ does not also jump');
await page.evaluate(() => window.__btn(0, false));
// keyboard takes over again
await page.keyboard.press('KeyW');
check(!(await page.evaluate(() => document.body.classList.contains('gamepad'))), 'keyboard use switches prompts back');
console.log('--- console errors/warnings ---');
for (const l of logs) console.log(l);
console.log(fails ? `${fails} FAILED` : 'all passed');
await browser.close();
process.exit(fails ? 1 : 0);
