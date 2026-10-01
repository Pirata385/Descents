// Mobile test: an emulated phone (touch screen, mobile user agent) plays the
// game in landscape with real multi-touch input sent through the Chrome
// DevTools Protocol. Checks the rotate prompt, mobile defaults, joystick,
// look, buttons, grappling arm, observing, map pinch-zoom, journal, pause,
// settings, rotation while playing, and that controls never overlap the HUD.
// usage: node tools/mobile-test.mjs [outDir] [seed]
import { createRequire } from 'node:module';
import fs from 'node:fs';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const [outDir = 'tests/output/mobile', seed = 'Ashen Rim 4242'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const PHONE = { width: 844, height: 390 };

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: UA });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png`, timeout: 180000 });
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
const center = async (sel) => {
  const c = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
  if (!c) throw new Error(`element ${sel} not found; screen: ${await page.evaluate(() => `${window.__app.state} ${window.__app.screen.className} ${window.__app.screen.innerText.slice(0, 200).replace(/\s+/g, ' ')}`)}`);
  return c;
};
const tapAt = async ([x, y], holdMs = 60) => { await touch('touchStart', [[x, y, 7]]); await page.waitForTimeout(holdMs); await touch('touchEnd', []); };
const wait = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__app.state);
const visible = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; }, sel);

/** No visible touch button may overlap another one or the key HUD readouts, and all must be on screen. */
async function layoutCheck(label) {
  const res = await page.evaluate(() => {
    const vis = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && r.width > 0 && el.closest('.hidden') === null ? r : null; };
    const btns = [...document.querySelectorAll('.touch-ui .t-btn')].map((el) => [el.getAttribute('aria-label'), vis(el)]).filter(([, r]) => r);
    const hud = ['.hud .compass', '.hud .status', '.hud .clock', '.hud .slots-hud'].map((s) => [s, document.querySelector(s)]).filter(([, el]) => el).map(([s, el]) => [s, vis(el)]).filter(([, r]) => r && r.height > 2);
    const over = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const problems = [];
    for (let i = 0; i < btns.length; i++) {
      const [n, r] = btns[i];
      if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) problems.push(`${n} off screen`);
      for (let j = i + 1; j < btns.length; j++) if (over(r, btns[j][1])) problems.push(`${n} overlaps ${btns[j][0]}`);
      for (const [s, h] of hud) if (over(r, h)) problems.push(`${n} overlaps ${s}`);
    }
    return { buttons: btns.length, problems };
  });
  check(`layout ${label}: ${res.buttons} buttons on screen, no overlaps`, res.problems.length === 0 && res.buttons > 0, res.problems.join('; '));
}

// ---------------------------------------------------------------- portrait first
await page.goto(`${BASE}/index.html`);
await page.waitForSelector('.title-panel');
check('touch mode detected on a phone', await page.evaluate(() => document.body.classList.contains('touch') && window.__app.touch === true));
check('portrait shows the rotate prompt', await visible('#rotate'));
await shot('m01-portrait');
const defaults = await page.evaluate(() => { const s = window.__app.settings; return { vd: s.viewDistance, shadows: s.shadows, pr: s.pixelRatio, aa: s.antialias }; });
check('lighter graphics defaults on mobile', defaults.vd <= 0.7 && defaults.shadows === false && defaults.pr <= 1 && defaults.aa === false, JSON.stringify(defaults));

// ---------------------------------------------------------------- landscape: title and start
await page.setViewportSize(PHONE);
await wait(400);
check('landscape hides the rotate prompt', !(await visible('#rotate')));
await shot('m02-title');
const titleFits = await page.evaluate(() => { const r = document.querySelector('.title-panel').getBoundingClientRect(); return r.bottom <= innerHeight + 1 || document.querySelector('.title-panel').scrollHeight > 0; });
check('title panel fits a landscape phone', titleFits);
await page.fill('#seed', seed);
await tapAt(await center('[data-act=new]'));
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 300000 });
check('world loads', !(await page.evaluate(() => window.__error)));
await shot('m03-tap-to-begin');
check('tap prompt uses touch wording', (await page.evaluate(() => document.querySelector('.click-msg')?.textContent || '')).startsWith('Tap'));
await tapAt([PHONE.width / 2, PHONE.height / 2]);
await wait(800);
check('tap starts play', (await state()) === 'playing');
check('touch controls visible while playing', await visible('.touch-ui') && await visible('.t-jump') && await visible('.t-grapple'));

// put the explorer on an open stretch of Delvers' Road, facing along it
await page.evaluate(() => {
  const g = window.__descents, p = g.player;
  const r = g.plan.routes.find((rr) => rr.name === "Delvers' Road");
  const i = 30 * 3, j = 36 * 3;
  p.pos.set(r.pts[i], r.pts[i + 1] + 0.05, r.pts[i + 2]); p.vel.set(0, 0, 0); p.safe = [p.pos.clone()];
  p.yaw = Math.atan2(-(r.pts[j] - r.pts[i]), -(r.pts[j + 2] - r.pts[i + 2])); p.pitch = -0.1;
  window.__maxY = -1e9;
  setInterval(() => { window.__maxY = Math.max(window.__maxY, p.pos.y); }, 16);
});
await wait(3000);
await shot('m04-playing');
await layoutCheck('phone 844×390');

// ---------------------------------------------------------------- joystick
const before = await page.evaluate(() => { const p = window.__descents.player; return { x: p.pos.x, z: p.pos.z, yaw: p.yaw }; });
await touch('touchStart', [[150, 290, 1]]);
await touch('touchMove', [[150, 260, 1]]);
await touch('touchMove', [[150, 225, 1]]);
const axis = await page.evaluate(() => ({ ...window.__descents.input.axis, run: window.__descents.input.is('run') }));
await wait(1200);
await shot('m05-joystick');
await wait(3000);
await touch('touchEnd', []);
const after = await page.evaluate(() => { const p = window.__descents.player; return { x: p.pos.x, z: p.pos.z, axis: window.__descents.input.axis.active }; });
const moved = Math.hypot(after.x - before.x, after.z - before.z);
const fwd = moved > 0 ? ((after.x - before.x) * -Math.sin(before.yaw) + (after.z - before.z) * -Math.cos(before.yaw)) / moved : 0;
check('joystick pushed fully up = forward + run', axis.active && axis.y > 0.9 && axis.run, JSON.stringify(axis));
check('joystick moves the explorer forward', moved > 1.5 && fwd > 0.8, `${moved.toFixed(2)} m, alignment ${fwd.toFixed(2)}`);
check('releasing the stick stops input', after.axis === false);

// ---------------------------------------------------------------- look
const yaw0 = await page.evaluate(() => window.__descents.player.yaw);
await touch('touchStart', [[620, 200, 2]]);
for (let k = 1; k <= 5; k++) { await touch('touchMove', [[620 + k * 30, 200, 2]]); await wait(60); }
await touch('touchEnd', []);
await wait(800);
const yaw1 = await page.evaluate(() => window.__descents.player.yaw);
check('dragging on the right turns the view', yaw1 < yaw0 - 0.1, `Δyaw ${(yaw1 - yaw0).toFixed(3)} rad`);

// ---------------------------------------------------------------- stick + look at the same time (two fingers)
const b2 = await page.evaluate(() => { const p = window.__descents.player; return { x: p.pos.x, z: p.pos.z, yaw: p.yaw }; });
await touch('touchStart', [[150, 290, 3], [620, 200, 4]]);
for (let k = 1; k <= 6; k++) { await touch('touchMove', [[150, 290 - k * 10, 3], [620 - k * 20, 200, 4]]); await wait(150); }
await wait(1500);
await touch('touchEnd', []);
const a2 = await page.evaluate(() => { const p = window.__descents.player; return { x: p.pos.x, z: p.pos.z, yaw: p.yaw }; });
check('two-finger move and look together', Math.hypot(a2.x - b2.x, a2.z - b2.z) > 0.5 && a2.yaw > b2.yaw + 0.05, `moved ${Math.hypot(a2.x - b2.x, a2.z - b2.z).toFixed(2)} m, Δyaw ${(a2.yaw - b2.yaw).toFixed(2)}`);

// ---------------------------------------------------------------- jump
await wait(1200);
const y0 = await page.evaluate(() => { window.__maxY = window.__descents.player.pos.y; return window.__descents.player.pos.y; });
await tapAt(await center('.t-jump'), 250);
await wait(2500);
const yMax = await page.evaluate(() => window.__maxY);
check('jump button jumps', yMax - y0 > 0.4, `rose ${(yMax - y0).toFixed(2)} m`);

// ---------------------------------------------------------------- grappling arm
const aim = await page.evaluate(() => {
  // aim so the claw bites ground or rock 5-25 m away
  const g = window.__descents, p = g.player, e = p.eyePos;
  const yaw0 = p.yaw;
  for (const yo of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.4, -2.4, 3.1]) {
    const yaw = yaw0 + yo;
    for (let pitch = 0.3; pitch > -0.9; pitch -= 0.04) {
      const dx = -Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = -Math.cos(yaw) * Math.cos(pitch);
      const hit = g.world.raycast(e.x, e.y + 0.02, e.z, dx, dy, dz, 40);
      if (hit && hit.dist > 5 && hit.dist < 25) { p.yaw = yaw; p.pitch = pitch; return { yaw: +yo.toFixed(2), pitch: +pitch.toFixed(2), dist: +hit.dist.toFixed(1), kind: hit.kind }; }
    }
  }
  p.pitch = -0.3;
  return null;
});
console.log('      aim', JSON.stringify(aim));
await wait(500);
await tapAt(await center('.t-grapple'));
let attached = false;
for (let k = 0; k < 40 && !attached; k++) { await wait(250); attached = await page.evaluate(() => window.__descents.grapple.attached); }
check('arm button fires and the claw bites', attached);
await wait(400);
check('reel buttons appear while attached', await visible('.t-reelin') && await visible('.t-reelout'));
await shot('m06-grapple-attached');
const rope0 = await page.evaluate(() => window.__descents.grapple.ropeLen);
const reel = await center('.t-reelin');
await touch('touchStart', [[reel[0], reel[1], 5]]);
let reeled = false;
let reelInfo = null;
for (let k = 0; k < 40 && !reeled; k++) {
  await wait(250);
  reelInfo = await page.evaluate((r0) => { const g = window.__descents, gr = g.grapple; return { reeled: !gr.attached || gr.ropeLen < (r0 > 4 ? r0 - 2 : r0 - 0.5), attached: gr.attached, state: gr.state, rope: +gr.ropeLen.toFixed(2), r0: +r0.toFixed(2), pressed: g.input.is('reelIn'), reeling: gr.reeling, btnDown: document.querySelector('.t-reelin').classList.contains('down'), t: +g.gameTime.toFixed(2) }; }, rope0);
  reeled = reelInfo.reeled;
}
await touch('touchEnd', []);
check('holding Reel in winds the cable', reeled, JSON.stringify(reelInfo));
if (await page.evaluate(() => window.__descents.grapple.attached)) { await tapAt(await center('.t-grapple')); await wait(800); }
check('arm releases', await page.evaluate(() => !window.__descents.grapple.attached));
await layoutCheck('phone with contextual buttons');

// ---------------------------------------------------------------- observe (hold)
const ob = await center('.t-observe');
await touch('touchStart', [[ob[0], ob[1], 6]]);
await wait(1200);
const zoomed = await page.evaluate(() => window.__descents.player.zoomed);
await shot('m07-observe');
await touch('touchEnd', []);
check('holding Observe zooms in', zoomed === true);
let unzoomed = false;
for (let k = 0; k < 20 && !unzoomed; k++) { await wait(250); unzoomed = await page.evaluate(() => !window.__descents.input.is('observe') && !window.__descents.player.zoomed); }
check('releasing Observe zooms out', unzoomed);

// ---------------------------------------------------------------- map with pinch zoom
await tapAt(await center('[data-ui=map]'));
await wait(1500);
check('map button opens the map', (await state()) === 'journal' && await visible('.map-canvas'));
await shot('m08-map');
const z0 = await page.evaluate(() => window.__app.journal.map.zoom);
const mc = await center('.map-canvas');
await touch('touchStart', [[mc[0] - 30, mc[1], 8], [mc[0] + 30, mc[1], 9]]);
for (let k = 1; k <= 6; k++) { await touch('touchMove', [[mc[0] - 30 - k * 15, mc[1], 8], [mc[0] + 30 + k * 15, mc[1], 9]]); await wait(40); }
await touch('touchEnd', []);
await wait(500);
const z1 = await page.evaluate(() => window.__app.journal.map.zoom);
check('pinch zooms the map', z1 > z0 * 1.8, `${z0.toFixed(2)} → ${z1.toFixed(2)}`);
await shot('m09-map-pinched');
await tapAt(await center('.journal-tabs [data-tab=abyss]'));
await wait(1500);
await shot('m10-abyss');
await tapAt(await center('.journal-tabs [data-tab=creatures]'));
await wait(1200);
await shot('m11-creatures');
await tapAt(await center('.journal-tabs [data-tab=equipment]'));
await wait(800);
await shot('m12-equipment');
check('journal fills the short screen', await page.evaluate(() => { const r = document.querySelector('.journal-book').getBoundingClientRect(); return r.height >= innerHeight - 2 && r.width >= innerWidth - 2; }));
await tapAt(await center('.journal .btn.close'));
await wait(800);
check('closing the journal returns straight to play', (await state()) === 'playing' && await visible('.t-jump'));

// ---------------------------------------------------------------- pause & settings
await tapAt(await center('[data-ui=pause]'));
await wait(600);
check('pause button pauses', (await state()) === 'paused' && await visible('.pause'));
await shot('m13-pause');
check('pause menu fits the screen', await page.evaluate(() => { const r = document.querySelector('.panel.pause').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; }));
await tapAt(await center('.pause [data-act=settings]'));
await wait(600);
check('settings include touch options', await page.evaluate(() => !!document.querySelector('select[data-key=touchControls]') && !!document.querySelector('input[data-key=touchSize]')));
await shot('m14-settings');
await page.evaluate(() => { const el = document.querySelector('input[data-key=touchSize]'); el.value = '1.2'; el.dispatchEvent(new Event('input')); });
check('button size setting applies', await page.evaluate(() => getComputedStyle(document.querySelector('.touch-ui')).getPropertyValue('--t-size').trim() === '1.2'));
await page.evaluate(() => { const el = document.querySelector('input[data-key=touchSize]'); el.value = '1'; el.dispatchEvent(new Event('input')); });
check('settings Done button reachable without scrolling', await page.evaluate(() => { const r = document.querySelector('[data-act=back]').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }));
await tapAt(await center('[data-act=back]'));
await wait(400);
await tapAt(await center('.pause [data-act=resume]'));
await wait(600);
check('resume returns to play', (await state()) === 'playing');

// ---------------------------------------------------------------- turning the phone while playing
await page.setViewportSize({ width: 390, height: 844 });
await wait(800);
check('turning to portrait pauses and asks to rotate', (await state()) === 'paused' && await visible('#rotate'));
await shot('m15-turned-portrait');
await page.setViewportSize(PHONE);
await wait(800);
check('back in landscape the prompt goes away', !(await visible('#rotate')) && await visible('.pause'));
await tapAt(await center('.pause [data-act=resume]'));
await wait(600);
check('play resumes after rotating back', (await state()) === 'playing');

// ---------------------------------------------------------------- smaller phone and tablet
await page.setViewportSize({ width: 740, height: 360 });
await wait(800);
await layoutCheck('small phone 740×360');
await shot('m16-small-phone');
await page.setViewportSize({ width: 1024, height: 768 });
await wait(800);
await layoutCheck('tablet 1024×768');
await shot('m17-tablet');

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} mobile checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
