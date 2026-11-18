// Module resolution hook for the test runner.
//
// The source tree uses extensionless relative imports (`./view-state`) because the Rollup build
// resolves them. Node's ESM resolver requires an explicit extension, so this hook appends `.ts` to
// a relative specifier when the extensionless target does not exist but the `.ts` file does. Only
// the tests use it; the application build is unaffected.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const hasExtension = (specifier) => /\.[cm]?[jt]sx?$/.test(specifier) || /\.[a-z0-9]+$/i.test(specifier);

export async function resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !hasExtension(specifier)) {
        const parent = context.parentURL ? fileURLToPath(context.parentURL) : fileURLToPath(import.meta.url);
        const candidate = new URL(`${specifier}.ts`, `file://${parent.replace(/\\/g, '/')}`);
        if (!specifier.endsWith('.ts') && existsSync(fileURLToPath(candidate))) {
            return nextResolve(`${specifier}.ts`, context);
        }
    }
    return nextResolve(specifier, context);
}
