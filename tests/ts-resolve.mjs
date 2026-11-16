/**
 * Test-only module resolution.
 *
 * The app is bundled by Vite, so its source uses extensionless relative
 * imports ("../types"). Node's ESM loader needs the extension, so when normal
 * resolution fails we retry as `.ts`, `.tsx`, or `/index.ts`. This lets the
 * suite import the real source files without a bundler or extra dependencies.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
      for (const extension of ['.ts', '.tsx', '/index.ts']) {
        try {
          return await nextResolve(specifier + extension, context)
        } catch {
          // Try the next candidate.
        }
      }
    }
    throw error
  }
}
