// The sound must never stay silent: start a game, then poison the mixing
// graph with NaN, cut it off from the output and suspend the audio context,
// and check each time that the audio engine brings the sound back by itself.
// usage: node tools/audio-test.mjs [seed]   (needs a running server, see BASE_URL)
import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const seed = process.argv[2] || '12345';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
let failed = 0;
const check = (ok, what, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); };
await page.goto(`${BASE}/index.html`);
await page.waitForSelector('.title-panel');
await page.fill('#seed', seed);
await page.click('[data-act=new]');
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 300000 });
await page.mouse.click(480, 270);
await page.waitForTimeout(3000);
/** Output level (dB) and NaN samples over 0.6 s, measured after the limiter. */
const level = () => page.evaluate(async () => {
  const A = window.__app.audio;
  const an = A.ctx.createAnalyser(); an.fftSize = 2048; A.limiter.connect(an);
  const d = new Float32Array(2048); let s = 0, n = 0, nan = 0;
  for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 60)); an.getFloatTimeDomainData(d); for (const v of d) { if (!Number.isFinite(v)) nan++; else { s += v * v; n++; } } }
  an.disconnect();
  return { db: +(10 * Math.log10(s / Math.max(1, n) + 1e-12)).toFixed(1), nan, state: A.ctx.state, rebuilds: A.rebuilds.length };
});
const waitFor = async (pred, secs) => { let r; for (let t = 0; t < secs; t += 1.5) { r = await level(); if (pred(r)) return r; await page.waitForTimeout(900); } return r; };
const audible = (r) => r.state === 'running' && r.nan === 0 && r.db > -60;
const r0 = await level();
check(audible(r0), 'sound plays during the game', `${r0.db} dB`);
// 1. NaN in the graph (a wave shaper whose curve is NaN)
await page.evaluate(() => {
  const A = window.__app.audio;
  const o = A.ctx.createOscillator(); const ws = A.ctx.createWaveShaper(); ws.curve = new Float32Array([NaN, NaN, NaN]);
  o.connect(ws).connect(A.master); o.start(); o.stop(A.ctx.currentTime + 0.3);
});
const r1 = await waitFor(audible, 8);
check(audible(r1), 'sound comes back after NaN reached the graph', `${r1.db} dB, ${r1.rebuilds} rebuild(s)`);
// 2. a dead graph: the master bus cut off from the output
await page.evaluate(() => window.__app.audio.master.disconnect());
const r2 = await waitFor(audible, 20);
check(audible(r2), 'sound comes back after the graph went silent', `${r2.db} dB, ${r2.rebuilds} rebuild(s)`);
// 3. the browser suspends the context
await page.evaluate(() => window.__app.audio.ctx.suspend());
const r3 = await waitFor(audible, 8);
check(audible(r3), 'sound comes back after the context was suspended', `${r3.state}, ${r3.db} dB`);
// 4. pausing silences it on purpose, and resuming brings it back
await page.evaluate(() => window.__app.showPause());
await page.waitForTimeout(1500);
const r4 = await page.evaluate(() => window.__app.audio.ctx.state);
check(r4 !== 'running', 'pausing the game pauses the sound', r4);
await page.evaluate(() => window.__app.resume());
const r5 = await waitFor(audible, 8);
check(audible(r5), 'resuming brings the sound back', `${r5.state}, ${r5.db} dB`);
check(!errors.length, 'no page errors', errors.join(' | '));
await browser.close();
console.log(failed ? `${failed} audio check(s) failed` : 'all audio checks passed');
process.exit(failed ? 1 : 0);
