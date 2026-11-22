// test/loader.mjs: maps the bare 'three' specifier to the local stub, so the game modules load under Node.
export async function resolve(specifier, context, next) {
  if (specifier === 'three') return { url: new URL('./three.stub.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
