// Minimal test harness: named tests, assertions, timing and a summary.
export const results = [];
let current = null;

export async function test(name, fn) {
  const t0 = performance.now();
  current = { name, notes: [] };
  try {
    await fn();
    results.push({ name, ok: true, ms: performance.now() - t0, notes: current.notes });
    console.log(`  ✔ ${name} (${Math.round(performance.now() - t0)} ms)${current.notes.length ? `\n      ${current.notes.join('\n      ')}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: performance.now() - t0, error: err });
    console.log(`  ✘ ${name}\n      ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

export function note(msg) { if (current) current.notes.push(msg); }

export function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
export function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
export function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: expected ${b} ± ${tol}, got ${a}`); }

/** Small stable hash for comparing generated data. */
export function hashOf(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v).map((x) => Math.round(x * 100) / 100) : v));
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

export function summary() {
  const failed = results.filter((r) => !r.ok);
  const total = results.reduce((a, r) => a + r.ms, 0);
  console.log(`\n${results.length - failed.length}/${results.length} tests passed in ${(total / 1000).toFixed(1)} s`);
  if (failed.length) { console.log('Failed:'); for (const f of failed) console.log(`  - ${f.name}`); }
  return failed.length === 0;
}
