// Test-only ESM resolve hook.
//
// Three browser-oriented dependencies of CommonUtils (xz-decompress, fflate,
// @oneidentity/zstd-js) are CommonJS packages whose named exports Node's
// native ESM loader cannot statically resolve. The PLY/SPLAT loader tests never
// invoke gzip/xz/zstd/zip decompression, so redirect those bare specifiers to
// lightweight ESM stubs instead of pulling the real packages into Node.
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const stubs = {
    'xz-decompress': './stubs/xz-decompress.mjs',
    fflate: './stubs/fflate.mjs',
    '@oneidentity/zstd-js/wasm/decompress': './stubs/zstd.mjs',
};

export async function resolve(specifier, context, nextResolve) {
    const stub = stubs[specifier];
    if (stub) {
        return { url: pathToFileURL(resolvePath(here, stub)).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
