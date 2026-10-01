// Gameplay scenario in headless Chromium with deterministic stepping:
// observe a creature (hold F), take an artifact (E), check the catalogs,
// travel to the deep layers and capture screenshots along the way.
// usage: node tools/scenario-test.mjs <outDir> [seed]
import { createRequire } from 'node:module';
import fs from 'node:fs';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const [outDir = 'tests/output', seed = 'Ashen Rim 4242'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const shot = async (name) => { await page.screenshot({ path: `${outDir}/${name}.png`, timeout: 180000 }); console.log('shot', name); };
await page.goto(`${BASE}/index.html`);
await page.waitForSelector('.title-panel');
await page.fill('#seed', seed);
await page.click('[data-act=new]');
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 300000 });
await page.evaluate(() => window.__app.resume());
// helpers inside the page
await page.evaluate(() => {
  const g = window.__descents;
  g.paused = true;
  const realRender = g.renderer.render.bind(g.renderer);
  window.__step = (n, dt = 1 / 30, keys = []) => {
    g.renderer.render = () => {};
    for (let i = 0; i < n; i++) {
      for (const k of keys) { if (!g.input.down.has(k)) g.input.pressed.add(k); g.input.down.add(k); }
      g.update(dt);
      g.input.endFrame();
    }
    for (const k of keys) g.input.down.delete(k);
    g.renderer.render = realRender;
  };
  window.__look = (x, y, z) => {
    const p = g.player, e = p.eyePos;
    p.yaw = Math.atan2(-(x - e.x), -(z - e.z));
    p.pitch = Math.atan2(y - e.y, Math.hypot(x - e.x, z - e.z));
  };
  window.__settle = async () => { for (let i = 0; i < 40; i++) { g.chunks.update(g.player.pos); if (g.chunks.nearReady(120) > 0.99) break; await new Promise((r) => setTimeout(r, 250)); } };
});
const step = (n, keys) => page.evaluate(([n2, k]) => window.__step(n2, 1 / 30, k), [n, keys || []]);
const render = () => page.evaluate(() => { const g = window.__descents; g.renderer.render(); });

// 1. walk a little and let the ecosystem wake up
await step(60, ['KeyW']);
await step(60);
// 2. observe the nearest creature
const target = await page.evaluate(() => {
  const g = window.__descents, p = g.player;
  const list = g.ecosystem.agents.filter((a) => !a.dead && !a.airborne && !a.ceil).sort((a, b) => a.pos.distanceTo(p.pos) - b.pos.distanceTo(p.pos));
  const a = list[0];
  if (!a) return null;
  // stand 7 m away on the ground
  const ang = Math.random() * 6.28;
  const x = a.pos.x + Math.cos(ang) * (5 + a.scale * 2), z = a.pos.z + Math.sin(ang) * (5 + a.scale * 2);
  const y = g.world.floorBelow(x, a.pos.y + 6, z);
  p.pos.set(x, y, z); p.vel.set(0, 0, 0);
  p.safe = [p.pos.clone()];
  window.__target = a;
  return { name: a.sp.name, family: a.sp.family, dist: Math.round(a.pos.distanceTo(p.pos)), agents: g.ecosystem.agents.length };
});
console.log('target', JSON.stringify(target));
await page.evaluate(() => window.__settle());
for (let k = 0; k < 10; k++) {
  await page.evaluate(() => { const a = window.__target; window.__look(a.pos.x, a.pos.y + a.scale * 0.4, a.pos.z); });
  await step(15, ['KeyF']);
}
await page.evaluate(() => { const a = window.__target; window.__look(a.pos.x, a.pos.y + a.scale * 0.4, a.pos.z); const g = window.__descents; g.input.down.add('KeyF'); window.__step(2); g.player.zoomed = true; g.player.updateCamera(0.5); });
await render();
await shot('s1-observe');
const disc = await page.evaluate(() => { const g = window.__descents; return [...g.discovery.species.values()].map((e) => ({ name: g.plan.species[e.id].name, observe: +e.observe.toFixed(1), facts: [...e.facts], beh: [...e.behaviours], inter: [...e.interactions.keys()] })); });
console.log('discovered', JSON.stringify(disc));
await page.evaluate(() => { window.__descents.input.down.delete('KeyF'); });
// 3. take the nearest artifact
const art = await page.evaluate(() => {
  const g = window.__descents, p = g.player;
  const a = g.artifacts.list.filter((x) => x.site.layer <= 1).sort((u, v) => Math.hypot(u.site.x - p.pos.x, u.site.z - p.pos.z) - Math.hypot(v.site.x - p.pos.x, v.site.z - p.pos.z))[0];
  p.pos.set(a.site.x + 2, a.site.y, a.site.z);
  p.pos.y = g.world.floorBelow(p.pos.x, a.site.y + 3, p.pos.z);
  p.vel.set(0, 0, 0); p.safe = [p.pos.clone()];
  window.__art = a;
  return { name: a.name, grade: a.gradeLabel, place: a.site.place, context: a.site.context };
});
console.log('artifact', JSON.stringify(art));
await page.evaluate(() => window.__settle());
await step(20);
await page.evaluate(() => { const a = window.__art; window.__look(a.site.x, a.site.y + 0.4, a.site.z); });
await step(2);
await render();
await shot('s2-artifact');
await step(1, ['KeyE']);
const took = await page.evaluate(() => ({ collected: [...window.__descents.artifacts.collected], equipped: window.__descents.artifacts.equipped }));
console.log('took', JSON.stringify(took));
// 4. catalogs
await page.evaluate(() => { const a = window.__app; a.openJournal('creatures'); });
await page.waitForTimeout(2500);
await shot('s3-catalog-creature');
await page.evaluate(() => { window.__app.journal.show('artifacts'); });
await page.waitForTimeout(2500);
await shot('s4-catalog-artifact');
await page.evaluate(() => { window.__app.closeJournal(true); window.__descents.paused = true; });
// 5. deep places
for (const [name, where] of [['s5-gallery', 'gallery'], ['s6-plain', 'plain'], ['s7-fault', 'fault']]) {
  const info = await page.evaluate((w) => {
    const g = window.__descents, plan = g.plan, f = g.world.field, p = g.player;
    let x, z, y, tx, ty, tz;
    if (w === 'gallery') { const gw = plan.galleryWindows[0]; const Re = f.tab(f.eyeTab, gw.th); [x, z] = f.fromPolar(Re + 30, gw.th); y = g.world.floorBelow(x, gw.y + 5, z); [tx, tz] = f.fromPolar(Re + 80, gw.th + 0.2); ty = y + 6; }
    else if (w === 'plain') { const t = plan.threshold; x = t.x * 2; z = t.z * 2; y = g.world.floorBelow(x, plan.params.plainY + 30, z); tx = t.x; tz = t.z; ty = y - 5; }
    else { const t = plan.threshold; x = t.x; z = t.z; y = t.y; tx = plan.params.fault.x; tz = plan.params.fault.z; ty = y - 30; }
    p.pos.set(x, y, z); p.vel.set(0, 0, 0); p.safe = [p.pos.clone()];
    window.__lookAt = [tx, ty, tz];
    return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
  }, where);
  await page.evaluate(() => window.__settle());
  await step(45);
  await page.evaluate(() => { const [a, b, c] = window.__lookAt; window.__look(a, b, c); });
  await step(3);
  const st = await page.evaluate(() => { const g = window.__descents; return { layer: g.layerInfo.layer, agents: g.ecosystem.agents.length, near: g.ecosystem.agentsNear(g.player.pos, 100).length, layersKnown: [...g.discovery.layers] }; });
  console.log(name, JSON.stringify(info), JSON.stringify(st));
  await render();
  await shot(name);
}
// 6. vertical map from the deep
await page.evaluate(() => window.__app.openJournal('abyss'));
await page.waitForTimeout(2500);
await shot('s8-abyss-deep');
// 7. save & restore round trip
const roundTrip = await page.evaluate(async () => {
  const { captureSave } = await import('./js/systems/save.js');
  const g = window.__descents;
  const s = captureSave(g);
  const json = JSON.stringify(s);
  return { bytes: json.length, species: s.discovery.species.length, collected: s.artifacts.collected.length, bands: s.map.bands.map((b) => b.runs.length) };
});
console.log('save', JSON.stringify(roundTrip));
console.log('--- console errors/warnings ---');
for (const l of logs.slice(-30)) console.log(l);
await browser.close();
