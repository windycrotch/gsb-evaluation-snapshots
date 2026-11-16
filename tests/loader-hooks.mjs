import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const esprimaShim = pathToFileURL(path.join(here, 'esprima-shim.mjs')).href

// Resolve hooks letting the app modules (written for Meteor) load under plain node:
//  - 'esprima' is redirected to the offline test shim
//  - extensionless relative imports ('./prepareCode') get '.js' appended
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'esprima') {
    return { url: esprimaShim, shortCircuit: true }
  }

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      return await nextResolve(specifier, context)
    } catch (err) {
      if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(specifier + '.js', context)
      }
      throw err
    }
  }

  return nextResolve(specifier, context)
}
