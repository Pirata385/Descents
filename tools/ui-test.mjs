// Drives the real game UI in headless Chromium: title screen, new game,
// HUD, journal tabs (map, abyss, creatures, artifacts, equipment, log),
// pause menu and saving. Writes screenshots to the given directory.
// usage: node tools/ui-test.mjs <outDir> [seed]
import { createRequire } from 'node:module';
import fs from 'node:fs';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const [outDir = 'tests/output', seed = 'Ashen Rim 4242'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const shot = async (name) => { await page.screenshot({ path: `${outDir}/${name}.png`, timeout: 180000 }); console.log('shot', name); };
await page.goto(`${BASE}/index.html`);
await page.waitForSelector('.title-panel', { timeout: 30000 });
await shot('01-title');
await page.fill('#seed', seed);
const t0 = Date.now();
await page.click('[data-act=new]');
await page.waitForTimeout(1500);
await shot('02-loading');
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 300000 });
console.log('world ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForTimeout(1000);
await shot('03-click-to-play');
await page.click('.click-screen');
await page.waitForTimeout(6000);
await shot('04-playing');
const state = await page.evaluate(() => {
  const g = window.__descents, a = window.__app;
  return { state: a.state, pos: g.player.pos.toArray().map((v) => Math.round(v)), agents: g.ecosystem.agents.length, arts: g.artifacts.list.length, species: g.plan.species.length, explored: g.mapData.bands[0].count, layer: g.layerInfo.layer };
});
console.log(JSON.stringify(state));
for (const [key, name] of [['KeyM', '05-map'], ['KeyN', '06-abyss'], ['KeyJ', '07-creatures'], ['KeyI', '08-equipment']]) {
  await page.evaluate(() => { const a = window.__app; if (a.state !== 'playing') a.resume(); });
  await page.keyboard.press(key);
  await page.waitForTimeout(1500);
  await shot(name);
}
await page.click('.journal-tabs [data-tab=log]');
await page.waitForTimeout(800);
await shot('09-log');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.evaluate(() => window.__app.resume());
await page.keyboard.press('KeyP');
await page.waitForTimeout(800);
await shot('10-pause');
await page.click('[data-act=save]');
await page.waitForTimeout(1500);
const saves = await page.evaluate(() => JSON.parse(localStorage.getItem('descents.saves.v1') || '[]'));
console.log('saves', JSON.stringify(saves));
console.log('--- console errors/warnings ---');
for (const l of logs.slice(-30)) console.log(l);
await browser.close();
