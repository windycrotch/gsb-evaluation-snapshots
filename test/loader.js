import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcUrl = pathToFileURL(path.join(root, 'src')).href;

const aliases = {
    '@events': path.join(root, 'src', 'events'),
    '@server': path.join(root, 'src', 'server'),
    '@client': path.join(root, 'src', 'client'),
};

/**
 * Resolve a path to either <path>.js or <path>/index.js.
 */
function resolveFile(basePath) {
    const fileCandidate = `${basePath}.js`;

    if (fs.existsSync(fileCandidate)) {
        return fileCandidate;
    }

    const indexCandidate = path.join(basePath, 'index.js');

    if (fs.existsSync(indexCandidate)) {
        return indexCandidate;
    }

    return `${basePath}.js`;
}

/**
 * Resolve webpack-style path aliases used by the application source.
 */
export async function resolve(specifier, context, nextResolve) {
    for (const [ alias, target ] of Object.entries(aliases)) {
        if (specifier === alias || specifier.startsWith(`${alias}/`)) {
            const relative = specifier.slice(alias.length);
            const basePath = relative ? path.join(target, relative) : target;

            return nextResolve(pathToFileURL(resolveFile(basePath)).href, context);
        }
    }

    return nextResolve(specifier, context);
}

/**
 * The root package.json is CommonJS by default; force ESM parsing for sources.
 */
export async function load(url, context, nextLoad) {
    if (url.startsWith(srcUrl) && url.endsWith('.js')) {
        return nextLoad(url, { ...context, format: 'module' });
    }

    return nextLoad(url, context);
}
