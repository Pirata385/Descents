// Bakes sounds off the main thread: receives jobs ({ id, name } or
// { id, call, seed }) and answers each with its samples as soon as it is done.
import { bake } from './recipes.js';
import { SR } from './dsp.js';

self.onmessage = (e) => {
  for (const job of e.data.jobs || []) {
    try {
      const r = bake(job);
      const chans = Array.isArray(r.data) ? r.data : [r.data];
      self.postMessage({ id: job.id, sr: SR, loop: !!r.loop, chans }, chans.map((c) => c.buffer));
    } catch (err) {
      self.postMessage({ id: job.id, error: String(err && err.message || err) });
    }
  }
};
