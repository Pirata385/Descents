// Main-thread implementation of the chunk worker protocol (fallback path).
import { generatePlan } from './plan.js';
import { ColumnGen } from './column.js';
import { ChunkMesher } from './mesher.js';
import { buildFlora } from './flora.js';

export function createInline(post) {
  let mesher = null;
  const init = (plan) => { mesher = new ChunkMesher(new ColumnGen(plan), buildFlora(plan.params), plan); };
  return {
    handle(msg) {
      try {
        if (msg.type === 'plan') {
          const plan = generatePlan(msg.seed, (stage, p) => post({ type: 'progress', stage, p }));
          init(plan);
          post({ type: 'plan', plan });
        } else if (msg.type === 'init') {
          init(msg.plan);
          post({ type: 'ready' });
        } else if (msg.type === 'chunk') {
          const out = mesher.build(msg.L, msg.cq, msg.cr);
          post({ type: 'chunk', key: msg.key, out });
        }
      } catch (err) {
        post({ type: 'error', key: msg.key, message: String(err && err.stack || err) });
      }
    },
  };
}
