// Node ESM loader: redirect the bare "three" specifier used by the game
// modules to the local offline stub so the tests never touch the CDN, a
// real GPU, or any network. Relative imports keep their normal resolution.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const stubUrl = pathToFileURL(path.join(here, "three.js")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "three" || specifier.startsWith("three/")) {
    return { url: stubUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
