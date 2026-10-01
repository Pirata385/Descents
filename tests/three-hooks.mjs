// Node module resolution hook: map the browser import-map entry "three" to
// the vendored copy so the game modules can be imported by the tests.
const THREE_URL = new URL('../lib/three/three.module.js', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: THREE_URL, shortCircuit: true };
  return next(specifier, context);
}
