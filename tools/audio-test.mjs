// The sound engine in a real browser: sound starts with the first click, the
// baked sounds arrive, the ambience and footsteps are heard, creature calls
// play, pausing silences it and resuming brings it back, and a context the
// browser suspended comes back with the next click.
// usage: node tools/audio-test.mjs [seed]   (needs a running server, see BASE_URL)
import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright')); }
const BASE = process.env.BASE_URL || 'http://localhost:8099';
const seed = process.argv[2] || '12345';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[error] ${m.text().slice(0, 200)}`); });
let failed = 0;
const check = (ok, what, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); };
await page.goto(`${BASE}/index.html`);
await page.waitForSelector('.title-panel');
check(await page.evaluate(() => !window.__app.audio.ctx), 'no audio context before the player asks for one');
await page.fill('#seed', seed);
await page.click('[data-act=new]');   // a real click: the gesture that starts sound
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 600000 });
await page.mouse.click(480, 270);
await page.waitForTimeout(1500);
// a meter on the master bus
await page.evaluate(() => {
  const A = window.__app.audio;
  const an = A.ctx.createAnalyser(); an.fftSize = 2048; A.master.connect(an);
  window.__meter = async (ms = 600) => {
    const d = new Float32Array(2048); let s = 0, n = 0, nan = 0;
    for (let t = 0; t < ms; t += 60) { await new Promise((r) => setTimeout(r, 60)); an.getFloatTimeDomainData(d); for (const v of d) { if (!Number.isFinite(v)) nan++; else { s += v * v; n++; } } }
    return { db: +(10 * Math.log10(s / Math.max(1, n) + 1e-12)).toFixed(1), nan, state: A.ctx.state, sounds: A.bank.size, voices: A.voices.length, beds: [...A.beds.keys()].join(' ') };
  };
});
const meter = (ms) => page.evaluate((m) => window.__meter(m), ms);
const st0 = await page.evaluate(() => ({ state: window.__app.audio.ctx.state, rate: window.__app.audio.ctx.sampleRate }));
check(st0.state === 'running', 'the audio context runs after the click', `${st0.state} at ${st0.rate} Hz`);
await page.waitForFunction(() => window.__app.audio.bank.size > 100, null, { timeout: 30000 }).catch(() => {});
const nb = await page.evaluate(() => ({ n: window.__app.audio.bank.size, calls: [...window.__app.audio.bank.keys()].filter((k) => k.startsWith('call-')).length, species: window.__descents.plan.species.length }));
check(nb.n > 100, 'the sounds are baked', `${nb.n} sounds, ${nb.calls} of ${nb.species} species calls`);
const m1 = await meter(1200);
check(m1.state === 'running' && m1.nan === 0 && m1.db > -60, 'ambience is heard while standing still', `${m1.db} dB · beds: ${m1.beds}`);
await page.keyboard.down('KeyW');
const m2 = await meter(1500);
await page.keyboard.up('KeyW');
check(m2.db > -60 && m2.voices > 0, 'footsteps while walking', `${m2.db} dB, ${m2.voices} voices`);
await page.evaluate(() => { const g = window.__descents, A = window.__app.audio; const sp = g.plan.species[0]; const p = g.player.pos.clone(); p.x += 6; for (let i = 0; i < 3; i++) A.call(sp, p, 'alarm', 1); A.fx('pickup'); A.fx('boss-roar', p); });
const m3 = await meter(800);
check(m3.voices >= 3, 'creature calls and effects play', `${m3.voices} voices, ${m3.db} dB`);
// a flood of calls stays within the voice budget
await page.evaluate(() => { const g = window.__descents, A = window.__app.audio; const p = g.player.pos.clone(); for (let i = 0; i < 120; i++) A.call(g.plan.species[i % g.plan.species.length], p, 'idle', 1); });
const nv = await page.evaluate(() => window.__app.audio.voices.length);
check(nv <= 24, 'a swarm of calls stays within the voice budget', `${nv} voices`);
// pause and resume
await page.evaluate(() => window.__app.showPause());
await page.waitForTimeout(800);
check(await page.evaluate(() => window.__app.audio.ctx.state) === 'suspended', 'pausing the game pauses the sound');
await page.evaluate(() => window.__app.resume());
await page.waitForTimeout(800);
const m4 = await meter(800);
check(m4.state === 'running' && m4.db > -60, 'resuming brings the sound back', `${m4.state}, ${m4.db} dB`);
// the browser suspends sound (another tab, a call): the next click wakes it
await page.evaluate(() => window.__app.audio.ctx.suspend());
await page.waitForTimeout(300);
await page.mouse.click(480, 270);
await page.waitForTimeout(800);
const m5 = await meter(600);
check(m5.state === 'running' && m5.db > -60, 'a suspended context wakes with the next click', `${m5.state}, ${m5.db} dB`);
check(!errors.filter((e) => !/KHR_parallel/.test(e)).length, 'no page errors', errors.join(' | '));
await browser.close();
console.log(failed ? `${failed} audio check(s) failed` : 'all audio checks passed');
process.exit(failed ? 1 : 0);
