// Worker pool creation with an in-thread fallback for environments where
// module workers are unavailable. The fallback runs the same worker code on
// the main thread asynchronously (slower, but functional).

export function createWorkerPool(count) {
  const pool = [];
  for (let i = 0; i < count; i++) {
    let w = null;
    try {
      w = new Worker(new URL('../world/chunkWorker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      w = null;
    }
    if (!w) return createInlinePool(1);
    pool.push({ worker: w, busy: false });
  }
  return pool;
}

/** Minimal Worker-like object running the chunk worker logic on the main thread. */
class InlineWorker extends EventTarget {
  constructor() {
    super();
    this.ready = import('../world/inlineWorker.js').then((m) => { this.impl = m.createInline((data, transfer) => this.emit(data)); });
  }
  emit(data) { setTimeout(() => this.dispatchEvent(Object.assign(new Event('message'), { data })), 0); }
  postMessage(msg) { this.ready.then(() => setTimeout(() => this.impl.handle(msg), 0)); }
  terminate() {}
}

export function createInlinePool(n) {
  const pool = [];
  for (let i = 0; i < n; i++) pool.push({ worker: new InlineWorker(), busy: false, inline: true });
  return pool;
}
