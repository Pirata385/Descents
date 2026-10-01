import { generatePlan } from '../js/world/plan.js';
const seed = process.argv[2] || '12345';
const t0 = performance.now();
const plan = generatePlan(seed, (msg, p) => {});
console.log('plan ms', Math.round(performance.now() - t0));
console.log(JSON.stringify(plan.stats));
for (const r of plan.validation.routes) console.log('route', r.name, r.ok ? 'OK' : 'FAIL', r.samples, r.failures, r.length + 'm', r.ok ? '' : JSON.stringify(r.first));
for (const c of plan.validation.caves) console.log('cave', c.name, c.kind, c.ok ? 'OK' : 'FAIL', c.samples, c.failures, c.ok ? '' : JSON.stringify(c.first));
console.log('spawn', plan.spawn);
