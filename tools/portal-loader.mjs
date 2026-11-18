// Test-only ESM resolve hook: the engine modules use the site's import-map
// specifiers ("three", "@config", "@engine/..."). The tests run in plain
// Node, so map those specifiers to local shim modules. Protocol modules with
// no browser-only imports are loaded from their real engine/ files.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolvePath(here, '..');
const shims = name => pathToFileURL(resolvePath(here, 'portal', `_${name}.js`)).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'three') return nextResolve(shims('three'), context);
  if (specifier === '@config') return nextResolve(shims('config'), context);
  if (specifier.startsWith('@engine/')) {
    return nextResolve(pathToFileURL(resolvePath(root, 'engine', specifier.slice('@engine/'.length))).href, context);
  }
  if (specifier.startsWith('@world/')) {
    return nextResolve(pathToFileURL(resolvePath(root, 'world', specifier.slice('@world/'.length))).href, context);
  }
  return nextResolve(specifier, context);
}
