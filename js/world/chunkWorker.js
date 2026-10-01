// Chunk worker: generates (or receives) the world plan and builds chunk meshes
// off the main thread. Messages:
//   {type:'plan', seed}       -> generate the plan here, reply {type:'plan', plan}
//   {type:'init', plan}       -> receive a plan generated elsewhere
//   {type:'chunk', key, L, cq, cr} -> reply {type:'chunk', key, out} with transferables
import { generatePlan } from './plan.js';
import { ColumnGen } from './column.js';
import { ChunkMesher } from './mesher.js';
import { buildFlora } from './flora.js';
import { MeshBuffer } from './geomkit.js';

let mesher = null;

function init(plan) {
  const gen = new ColumnGen(plan);
  const flora = buildFlora(plan.params);
  mesher = new ChunkMesher(gen, flora, plan);
}

function transferList(out) {
  const t = [];
  for (const k of ['terrain', 'water', 'falls', 'foliage']) if (out[k]) t.push(...MeshBuffer.prototype.transferables(out[k]));
  if (out.spans) t.push(out.spans.start.buffer, out.spans.y.buffer, out.spans.mat.buffer, out.spans.water.buffer, out.spans.flags.buffer);
  return t;
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'plan') {
      const plan = generatePlan(msg.seed, (stage, p) => self.postMessage({ type: 'progress', stage, p }));
      init(plan);
      self.postMessage({ type: 'plan', plan });
    } else if (msg.type === 'init') {
      init(msg.plan);
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'chunk') {
      const t0 = performance.now();
      const out = mesher.build(msg.L, msg.cq, msg.cr);
      out.ms = performance.now() - t0;
      self.postMessage({ type: 'chunk', key: msg.key, out }, transferList(out));
    }
  } catch (err) {
    self.postMessage({ type: 'error', key: msg.key, message: String(err && err.stack || err) });
  }
};
