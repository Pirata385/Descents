// Headless screenshots of the game for visual checks.
// usage: node tools/shot.mjs <out.png> "<query string>" [waitMs]
import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const [out, query, wait] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:8099/index.html?${query}`);
const t0 = Date.now();
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 240000 });
const err = await page.evaluate(() => window.__error);
if (err) console.log('ERROR', err);
await page.waitForTimeout(Number(wait || 3000));
await page.screenshot({ path: out, timeout: 180000 });
const dbg = await page.evaluate(() => document.getElementById('dbg')?.textContent);
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's |', dbg);
for (const l of logs.slice(-15)) console.log(l);
await browser.close();
