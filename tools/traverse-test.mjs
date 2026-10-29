// Physical traversal test: an autopilot walks the explorer (real player
// physics: running, step-up, mantling, jumping when blocked) along every
// guaranteed route from the city down to the Stone Plain, then through the
// cave network of the Great Fault, passage by passage, from the sinkhole in
// the plain to the Fourth Gate at the entrance of Layer 4.
// usage: node tools/traverse-test.mjs [seed]      (CAVES=0 skips the caves, CAVES=only walks only them, ROUTES=a,b walks only those routes)
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
  window.__walk = (name, maxSeconds = 240, ptsIn = null, keepPos = false) => {
    const r = ptsIn ? { pts: ptsIn } : g.plan.routes.find((rr) => rr.name === name);
    if (!r) return { name, missing: true };
    const p = g.player, pts = r.pts, n = pts.length / 3;
    if (!keepPos || p.pos.distanceTo({ x: pts[0], y: pts[1], z: pts[2] }) > 6) { p.pos.set(pts[0], pts[1] + 0.05, pts[2]); p.vel.set(0, 0, 0); }
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
      if (t > 20 && t % 10 < dt) { g.chunks.pump(Infinity); g.chunks.update(p.pos); }
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
// the Great Fault: the shortest chain of walkable passages from the plain to Layer 4
await page.evaluate(() => {
  const g = window.__descents, plan = g.plan, W = g.world;
  const caves = plan.caves.filter((c) => c.layer === 3 && c.walkable && c.to !== 'chasm' && c.from && c.to);
  const adj = new Map();
  const link = (a, b, c, rev) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, c, rev }); };
  for (const c of caves) { link(c.from, c.to, c, false); link(c.to, c.from, c, true); }
  const len = (c) => { let L = 0; for (let i = 1; i < c.nodes.length; i++) L += Math.hypot(c.nodes[i].x - c.nodes[i - 1].x, c.nodes[i].y - c.nodes[i - 1].y, c.nodes[i].z - c.nodes[i - 1].z); return L; };
  // Dijkstra by passage length
  const dist = new Map([['plain', 0]]), prev = new Map(), open = ['plain'];
  while (open.length) {
    open.sort((a, b) => dist.get(a) - dist.get(b));
    const u = open.shift();
    if (u === 'layer4') break;
    for (const e of adj.get(u) || []) {
      const d = dist.get(u) + len(e.c);
      if (d < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, d); prev.set(e.to, { from: u, e }); if (!open.includes(e.to)) open.push(e.to); }
    }
  }
  const chain = [];
  for (let v = 'layer4'; prev.has(v); v = prev.get(v).from) chain.unshift(prev.get(v).e);
  // each passage becomes a dense line of floor points; the next one starts where it ends
  window.__caveLegs = chain.map((e, i) => {
    const nodes = e.rev ? [...e.c.nodes].reverse() : e.c.nodes;
    const pts = [];
    const push = (x, y, z) => { const f = W.floorBelow(x, y + 0.6, z); pts.push(x, Number.isFinite(f) && y - f < 12 ? f : y, z); };
    // cross the hall (or the Basin) from the end of the previous passage, picking a
    // line over the uneven floor as a person would: A* on a 1 m grid, steps up to 1.4 m
    if (i > 0) {
      const pn = chain[i - 1].rev ? chain[i - 1].c.nodes[0] : chain[i - 1].c.nodes[chain[i - 1].c.nodes.length - 1];
      const q = nodes[0];
      const M = 14, x0 = Math.min(pn.x, q.x) - M, z0 = Math.min(pn.z, q.z) - M;
      const NX = Math.ceil(Math.abs(pn.x - q.x) + 2 * M), NZ = Math.ceil(Math.abs(pn.z - q.z) + 2 * M);
      const yRef = (u, v) => pn.y + (q.y - pn.y) * Math.min(1, Math.max(0, ((x0 + u - pn.x) * (q.x - pn.x) + (z0 + v - pn.z) * (q.z - pn.z)) / Math.max(1, (q.x - pn.x) ** 2 + (q.z - pn.z) ** 2)));
      const H = new Float32Array(NX * NZ);
      for (let v = 0; v < NZ; v++) for (let u = 0; u < NX; u++) {
        const f = W.floorBelow(x0 + u, yRef(u, v) + 3, z0 + v);
        const c = W.ceilingAbove(x0 + u, f + 0.1, z0 + v);
        H[v * NX + u] = Number.isFinite(f) && c - f > 2 ? f : NaN;
      }
      const id = (u, v) => v * NX + u;
      const s0 = id(Math.round(pn.x - x0), Math.round(pn.z - z0)), g0 = id(Math.round(q.x - x0), Math.round(q.z - z0));
      const cost = new Float32Array(NX * NZ).fill(Infinity), from = new Int32Array(NX * NZ).fill(-1), done = new Uint8Array(NX * NZ);
      cost[s0] = 0;
      const open = [s0];
      while (open.length) {
        let bi = 0;
        for (let k = 1; k < open.length; k++) if (cost[open[k]] + Math.hypot(open[k] % NX - g0 % NX, ((open[k] / NX) | 0) - ((g0 / NX) | 0)) < cost[open[bi]] + Math.hypot(open[bi] % NX - g0 % NX, ((open[bi] / NX) | 0) - ((g0 / NX) | 0))) bi = k;
        const cur = open.splice(bi, 1)[0];
        if (cur === g0) break;
        if (done[cur]) continue;
        done[cur] = 1;
        const cu = cur % NX, cv = (cur / NX) | 0;
        for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const nu = cu + du, nv = cv + dv;
          if (nu < 0 || nv < 0 || nu >= NX || nv >= NZ) continue;
          const nb = id(nu, nv);
          if (done[nb] || Number.isNaN(H[nb]) || Number.isNaN(H[cur])) continue;
          const dh = H[nb] - H[cur];
          if (dh > 1.4 || dh < -4) continue;
          const c2 = cost[cur] + Math.hypot(du, dv) + Math.max(0, dh) * 0.5;
          if (c2 < cost[nb]) { cost[nb] = c2; from[nb] = cur; open.push(nb); }
        }
      }
      const cells = [];
      if (from[g0] >= 0) for (let k = g0; k >= 0; k = from[k]) cells.unshift(k);
      if (cells.length) for (const k of cells) push(x0 + (k % NX), H[k] + 0.5, z0 + ((k / NX) | 0));
      else {
        const st = Math.max(1, Math.ceil(Math.hypot(q.x - pn.x, q.z - pn.z) / 0.8));
        for (let k = 0; k < st; k++) { const t = k / st; push(pn.x + (q.x - pn.x) * t, pn.y + (q.y - pn.y) * t, pn.z + (q.z - pn.z) * t); }
      }
    }
    for (let k = 1; k < nodes.length; k++) {
      const a = nodes[k - 1], b = nodes[k];
      const st = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.8));
      for (let j = 0; j < st; j++) { const t = j / st; push(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t - b.r * 0.2, a.z + (b.z - a.z) * t); }
    }
    const z = nodes[nodes.length - 1];
    push(z.x, z.y, z.z);
    return { name: `${e.c.name || e.c.kind} (${e.rev ? e.c.to : e.c.from} → ${e.rev ? e.c.from : e.c.to})`, pts };
  });
});
const only = process.env.ROUTES ? process.env.ROUTES.split(',').map((x) => x.trim()) : null;
let ok = true;
for (const name of routes) {
  if ((only && !only.includes(name)) || process.env.CAVES === 'only') continue;
  const res = await page.evaluate(([n]) => window.__walk(n, 420), [name]);
  const pass = res.progress > 0.97 && res.deaths === 0;
  const st = await page.evaluate(() => { const s2 = window.__stuck; window.__stuck = null; return s2; });
  if (!pass && st) console.log('     stuck:', JSON.stringify(st));
  if (!pass) ok = false;
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${JSON.stringify(res)}`);
}
if (process.env.CAVES !== '0' && !only && process.env.L4 !== 'only') {
  const legs = await page.evaluate(() => window.__caveLegs.map((l) => l.name));
  console.log(`The Great Fault: ${legs.length} passages from the plain to the Fourth Gate`);
  let keep = false;
  const drop = await page.evaluate(() => Math.round(window.__caveLegs[0].pts[1]));
  for (let i = 0; i < legs.length; i++) {
    const res = await page.evaluate(([i, keep]) => { const L = window.__caveLegs[i]; return window.__walk(L.name, 300, L.pts, keep); }, [i, keep]);
    const pass = res.progress > 0.97 && res.deaths === 0;
    const st = await page.evaluate(() => { const s2 = window.__stuck; window.__stuck = null; return s2; });
    if (!pass && st) console.log('     stuck:', JSON.stringify(st));
    if (!pass) ok = false;
    // a passage that fails is reported; the walk resumes at the start of the next one
    keep = pass;
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${JSON.stringify(res)}`);
  }
  const end = await page.evaluate(() => { const p = window.__descents.player.pos; return { y: Math.round(p.y), layer: window.__descents.layerInfo.layer }; });
  console.log(`reached depth ${-end.y} m (layer ${end.layer}) after starting the caves at ${-drop} m`);
}
// Layer 4: around the rims and across the root bridges, from the Gate Stair down to the mere
if (process.env.CAVES !== '0' && !only && process.env.L4 !== '0') {
  const legs = await page.evaluate(() => {
    const g = window.__descents, d = g.plan.layer4, W = g.world;
    if (!d) return [];
    const G = d.goblets;
    const out = [];
    const floorAt = (x, y, z) => { const f = W.floorBelow(x, y + 1.2, z); return Number.isFinite(f) && y - f < 6 ? f : y; };
    // the arc along a rim between two angles, the way that avoids the notch
    const arc = (gb, a1, a2, pts) => {
      const r = gb.Rc - gb.rimW * 0.5;
      let da = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
      const notchIn = (from, span) => { const n = Math.ceil(Math.abs(span) / 0.05); for (let k = 0; k <= n; k++) { const a = from + (span * k) / n; if (Math.abs(Math.atan2(Math.sin(a - gb.notch.ang), Math.cos(a - gb.notch.ang))) < gb.notch.hw + 0.12) return true; } return false; };
      if (gb.notch && notchIn(a1, da)) da = da > 0 ? da - Math.PI * 2 : da + Math.PI * 2;
      const n = Math.max(2, Math.ceil(Math.abs(da) * r / 1.2));
      for (let k = 0; k <= n; k++) { const a = a1 + (da * k) / n; const x = gb.x + Math.cos(a) * r, z = gb.z + Math.sin(a) * r; pts.push(x, floorAt(x, gb.yRim, z), z); }
    };
    const ang = (gb, x, z) => Math.atan2(z - gb.z, x - gb.x);
    let cur = G[d.chain[0]];
    let curA = ang(cur, d.exit.x, d.exit.z);
    // step off the stair onto the first rim
    const first = [];
    for (let k = 0; k <= 6; k++) { const x = d.exit.x - d.exit.ux * (6 - k) * 0.8, z = d.exit.z - d.exit.uz * (6 - k) * 0.8; first.push(x, floorAt(x, d.exit.y, z), z); }
    let pts = first;
    for (const b of d.bridges.filter((bb) => bb.kind !== 'branch')) {
      if (b.from !== cur.id) continue;
      arc(cur, curA, ang(cur, b.ax, b.az), pts);
      const L = Math.hypot(b.bx - b.ax, b.bz - b.az), n = Math.ceil(L / 0.8);
      for (let k = 0; k <= n; k++) { const t = k / n; const x = b.ax + (b.bx - b.ax) * t, z = b.az + (b.bz - b.az) * t; pts.push(x, floorAt(x, b.ay + (b.by - b.ay) * t, z), z); }
      out.push({ name: `${cur.name} → ${b.to >= 0 ? G[b.to].name : 'the floor'}`, pts });
      pts = [];
      if (b.to < 0) break;
      cur = G[b.to]; curA = ang(cur, b.bx, b.bz);
    }
    return out;
  });
  console.log(`Layer 4: ${legs.length} legs from the Gate Stair to the floor of the deep`);
  await page.evaluate((legs) => { window.__l4Legs = legs; }, legs);
  let keep4 = process.env.L4 !== 'only';
  for (let i = 0; i < legs.length; i++) {
    const res = await page.evaluate(([i, keep]) => { const L = window.__l4Legs[i]; return window.__walk(L.name, 300, L.pts, keep); }, [i, keep4]);
    const pass = res.progress > 0.97 && res.deaths === 0;
    const st = await page.evaluate(() => { const s2 = window.__stuck; window.__stuck = null; return s2; });
    if (!pass && st) console.log('     stuck:', JSON.stringify(st));
    if (!pass) ok = false;
    keep4 = pass;
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${JSON.stringify(res)}`);
  }
  if (legs.length) {
    const end = await page.evaluate(() => { const p = window.__descents.player.pos; return { y: Math.round(p.y), layer: window.__descents.layerInfo.layer }; });
    console.log(`reached depth ${-end.y} m (layer ${end.layer}) on the floor of the deep`);
  } else { ok = false; console.log('FAIL Layer 4 has no walkable chain'); }
}
if (errors.length) { ok = false; console.log('page errors:', errors.slice(0, 5)); }
console.log(ok ? 'All routes walked.' : 'Some routes could not be walked.');
await browser.close();
process.exit(ok ? 0 : 1);
