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

/** Bounding sphere of a mesh (centre of its box, farthest vertex), so the main thread need not compute it. */
function bounds(m) {
  const p = m.pos;
  if (!p || !p.length) return;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  let r2 = 0;
  for (let i = 0; i < p.length; i += 3) { const dx = p[i] - cx, dy = p[i + 1] - cy, dz = p[i + 2] - cz; const d = dx * dx + dy * dy + dz * dz; if (d > r2) r2 = d; }
  m.bs = [cx, cy, cz, Math.sqrt(r2)];
}

function transferList(out) {
  const t = [];
  for (const k of ['terrain', 'water', 'falls', 'foliage', 'terrainDeep', 'waterDeep', 'fallsDeep', 'foliageDeep']) if (out[k]) t.push(...MeshBuffer.prototype.transferables(out[k]));
  if (out.spans) t.push(out.spans.start.buffer, out.spans.y.buffer, out.spans.mat.buffer, out.spans.water.buffer, out.spans.flow.buffer, out.spans.flags.buffer);
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
      const out = mesher.build(msg.L, msg.cq, msg.cr, { coarse: msg.coarse, foliage: msg.foliage });
      for (const k of ['terrain', 'water', 'falls', 'foliage', 'terrainDeep', 'waterDeep', 'fallsDeep', 'foliageDeep']) if (out[k]) for (const m of [].concat(out[k])) bounds(m);
      out.ms = performance.now() - t0;
      self.postMessage({ type: 'chunk', key: msg.key, out }, transferList(out));
    }
  } catch (err) {
    self.postMessage({ type: 'error', key: msg.key, message: String(err && err.stack || err) });
  }
};
