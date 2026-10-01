// Runs every automated check against several world seeds:
//   npm test                 (default seeds)
//   SEEDS="a,b,c" npm test   (custom seeds)
// Browser-side checks (rendering, UI, play) live in tools/ui-test.mjs and
// tools/scenario-test.mjs and need a running server and Playwright.
import { register } from 'node:module';

register('./three-hooks.mjs', import.meta.url);

const { generatePlan } = await import('../js/world/plan.js');
const { summary } = await import('./lib.js');
const { worldTests } = await import('./world.test.js');
const { creatureTests } = await import('./creatures.test.js');
const { artifactTests } = await import('./artifacts.test.js');
const { saveTests } = await import('./save.test.js');
const { perfTests } = await import('./perf.test.js');

const seeds = (process.env.SEEDS || 'Ashen Rim 4242,12345,Verdant Gate 77,Pale Hollow 9031').split(',').map((s) => s.trim()).filter(Boolean);
const plans = new Map();
const planTimes = [];
console.log(`Generating ${seeds.length} worlds…`);
for (const s of seeds) {
  const t0 = performance.now();
  plans.set(s, generatePlan(s, () => {}));
  planTimes.push(performance.now() - t0);
  console.log(`  ${s}: ${Math.round(performance.now() - t0)} ms`);
}

const only = process.argv[2];
const suites = [['World', worldTests], ['Creatures', creatureTests], ['Artifacts', artifactTests], ['Saves', saveTests], ['Performance', perfTests]];
for (const [name, fn] of suites) {
  if (only && !name.toLowerCase().startsWith(only.toLowerCase())) continue;
  console.log(`\n${name}`);
  await fn(seeds, plans, planTimes);
}
process.exit(summary() ? 0 : 1);
