// Long exploration on the lowest settings, measuring what each part of a
// frame costs and what keeps growing: JS heap, GPU geometries and textures,
// shader programs, scene objects, chunks, caches and simulation state.
// The game is stepped deterministically (one update + one render per frame)
// while the explorer is carried across every layer.
// usage: node tools/perf-explore.mjs [seed] [stops]   (needs a running server, see BASE_URL)
import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const seed = process.argv[2] || '12345';
const STOPS = Number(process.argv[3] || 24);
const FRAMES = Number(process.env.FRAMES || 150);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[error] ${m.text().slice(0, 200)}`); });
await page.addInitScript(() => {
  try { localStorage.setItem('descents.settings.v1', JSON.stringify({ quality: 'low', renderChunks: 6, viewDistance: 0.55, pixelRatio: 0.5, shadows: false, shadowSize: 1024, particles: 0.35, creatures: 32, autoQuality: false, fpsLimit: 0 })); } catch { /* ignore */ }
});
await page.goto(`${BASE}/index.html`);
await page.waitForSelector('.title-panel');
await page.fill('#seed', seed);
await page.click('[data-act=new]');
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 600000 });
await page.evaluate(() => window.__app.resume());
await page.evaluate(() => {
  const g = window.__descents;
  g.paused = true;
  // time every system and the parts of a frame
  const T = window.__T = {};
  const wrap = (obj, fn, key) => { const f = obj[fn].bind(obj); obj[fn] = (...a) => { const t0 = performance.now(); const r = f(...a); T[key] = (T[key] || 0) + performance.now() - t0; return r; }; };
  for (const s of g.systems) {
    const name = s.constructor && s.constructor.name !== 'Object' ? s.constructor.name : (s.update ? 'glue' : 'late');
    if (s.update) wrap(s, 'update', `${name}.update`);
    if (s.lateUpdate) wrap(s, 'lateUpdate', `${name}.late`);
  }
  wrap(g.chunks, 'pump', 'chunks.pump');
  wrap(g.chunks, 'update', 'chunks.update');
  wrap(g.renderer, 'update', 'renderer.update');
  wrap(g.renderer, 'render', 'renderer.render');
  wrap(g.world, 'info', 'world.info');
  window.__count = () => { let n = 0; g.renderer.scene.traverse(() => n++); return n; };
  window.__stats = () => {
    const ri = g.renderer.renderer.info, eco = g.ecosystem, md = g.mapData, D = g.discovery;
    let vis = 0; g.renderer.scene.traverseVisible(() => vis++);
    return {
      heap: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : -1,
      geo: ri.memory.geometries, tex: ri.memory.textures, prog: ri.programs ? ri.programs.length : -1,
      calls: ri.render.calls, tris: ri.render.triangles,
      objs: window.__count(), visObjs: vis,
      nodes: g.chunks.nodes.size, shown: g.chunks.shown ? g.chunks.shown.size : -1,
      wcache: g.world.cache.size, l0: g.world.l0.size, chasm: g.world.gen.chasm.cache ? g.world.gen.chasm.cache.size : -1,
      regions: eco.regions.size, agents: eco.agents.length, carc: eco.carcasses.length, grid: eco.grid.size,
      mapCells: md.bands.reduce((a, b) => a + b.count, 0), trail: (md.trail || []).length,
      species: D.species.size, landmarks: D.landmarks.size, fx: g.combat ? g.combat.fx.length : 0,
    };
  };
  window.__step = (n, keys, turn) => {
    const g2 = window.__descents, p = g2.player;
    const t0 = performance.now();
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const f0 = performance.now();
      for (const k of keys) { if (!g2.input.down.has(k)) g2.input.pressed.add(k); g2.input.down.add(k); }
      p.yaw += turn;
      g2.update(1 / 30);
      g2.input.endFrame();
      worst = Math.max(worst, performance.now() - f0);
    }
    for (const k of keys) g2.input.down.delete(k);
    return { ms: (performance.now() - t0) / n, worst };
  };
  // places to visit, spread over every layer
  const plan = g.plan, f = g.world.field, P = [];
  const th0 = plan.spiral.th0;
  for (let i = 0; i < 6; i++) { const th = th0 + i * 1.05; const [x, z] = f.fromPolar((f.tab(f.eyeTab, th) + f.tab(f.rimTab, th)) / 2, th); P.push({ x, z, y: 220, name: `L1-${i}` }); }
  for (const w of plan.galleryWindows.slice(0, 2)) { const [x, z] = f.fromPolar(f.tab(f.eyeTab, w.th) + 30, w.th); P.push({ x, z, y: w.y + 5, name: 'gallery' }); }
  for (const sk of plan.fault.sinkholes.slice(0, 2)) P.push({ x: sk.x + 25, z: sk.z, y: plan.params.plainY + 30, name: 'plain' });
  for (const h of plan.fault.halls.filter((_, i) => i % 3 === 0).slice(0, 5)) P.push({ x: h.x, z: h.z, y: h.y + 2, name: 'cave' });
  for (const w of plan.fault.windows.filter((_, i) => i % 6 === 0).slice(0, 3)) P.push({ x: w.x, z: w.z, y: w.y + 2, name: 'window' });
  if (plan.layer4) for (const id of plan.layer4.chain) { const gg = plan.layer4.goblets[id]; P.push({ x: gg.x + gg.Rc * 0.5, z: gg.z, y: gg.yRim + 4, name: 'L4' }); }
  for (let i = 0; i < 4; i++) { const th = th0 + 0.5 + i * 1.5; const [x, z] = f.fromPolar((f.tab(f.eyeTab, th) + f.tab(f.rimTab, th)) / 2, th); P.push({ x, z, y: 220, name: `L1b-${i}` }); }
  window.__places = P;
  window.__go = async (i) => {
    const q = window.__places[i % window.__places.length], p = g.player;
    const y = g.world.floorBelow(q.x, q.y, q.z);
    p.pos.set(q.x, (Number.isFinite(y) ? y : q.y) + 0.1, q.z); p.vel.set(0, 0, 0); p.safe = [p.pos.clone()];
    // let the chunks around arrive (as they would while walking in)
    for (let k = 0; k < 30; k++) { g.chunks.pump(Infinity); g.chunks.update(p.pos); if (g.chunks.nearReady && g.chunks.nearReady(60) > 0.95) break; await new Promise((r) => setTimeout(r, 120)); }
    return q.name;
  };
});
const places = await page.evaluate(() => window.__places.length);
console.log(`seed ${seed} · ${places} places · ${STOPS} stops · ${FRAMES} frames each (low preset)`);
console.log('stop place        ms/frame worst | heap  geo  tex prog  objs  vis calls  tris(k) | nodes wcache l0 chasm | regions agents carc grid | map  trail');
const rows = [];
for (let s = 0; s < STOPS; s++) {
  const name = await page.evaluate((i) => window.__go(i), s);
  await page.evaluate(() => { for (const k in window.__T) window.__T[k] = 0; });
  const r = await page.evaluate(([n]) => window.__step(n, ['KeyW'], 0.01), [FRAMES]);
  await page.evaluate(() => { if (window.gc) window.gc(); });
  const st = await page.evaluate(() => window.__stats());
  const T = await page.evaluate(() => window.__T);
  rows.push({ s, name, r, st, T });
  console.log(`${String(s).padStart(4)} ${name.padEnd(10)} ${r.ms.toFixed(1).padStart(8)} ${r.worst.toFixed(0).padStart(5)} | ${String(st.heap).padStart(5)} ${String(st.geo).padStart(4)} ${String(st.tex).padStart(4)} ${String(st.prog).padStart(4)} ${String(st.objs).padStart(5)} ${String(st.visObjs).padStart(4)} ${String(st.calls).padStart(5)} ${String(Math.round(st.tris / 1000)).padStart(8)} | ${String(st.nodes).padStart(5)} ${String(st.wcache).padStart(6)} ${String(st.l0).padStart(3)} ${String(st.chasm).padStart(5)} | ${String(st.regions).padStart(7)} ${String(st.agents).padStart(6)} ${String(st.carc).padStart(4)} ${String(st.grid).padStart(4)} | ${String(st.mapCells).padStart(5)} ${String(st.trail).padStart(5)}`);
  const top = Object.entries(T).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / FRAMES).toFixed(2)}`).join(' · ');
  console.log(`         per frame (ms): ${top}`);
}
const first = rows[Math.min(2, rows.length - 1)], last = rows[rows.length - 1];
console.log(`\ngrowth from stop ${first.s} to ${last.s}: heap ${first.st.heap} → ${last.st.heap} MB · geometries ${first.st.geo} → ${last.st.geo} · objects ${first.st.objs} → ${last.st.objs} · regions ${first.st.regions} → ${last.st.regions}`);
console.log(errors.length ? errors.slice(0, 10).join('\n') : 'no errors');
await browser.close();
