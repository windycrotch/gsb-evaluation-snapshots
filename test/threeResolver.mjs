// test/threeResolver.mjs: a Node import resolver hook that maps the bare specifier 'three' to test/stub/three.mjs,
// so the end-to-end test can import the real js/versus.js without installing three.js.
//
// Used by test/e2e.test.mjs via module.register(). It only rewrites 'three'; everything else resolves normally.

const STUB = new URL('./stub/three.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return { url: STUB, shortCircuit: true };
  return nextResolve(specifier, context);
}
