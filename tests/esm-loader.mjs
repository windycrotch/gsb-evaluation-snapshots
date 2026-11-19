// Node treats .js files as CommonJS because the nearest package.json has no
// "type": "module", while the debugger source is authored as ES modules.
// This loader:
//   1. forces ESM interpretation for the project's own source files;
//   2. resolves the extensionless relative imports used throughout the
//      source (webpack/babel resolve them at build time, native ESM does not).
// Everything under node_modules keeps its declared module type.
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const sourceRoot = pathToFileURL(
    process.cwd().replace(/\\/g, "/") + "/src/"
).href;

export async function resolve(specifier, context, nextResolve) {
    if (
        urlIsInsideSource(context.parentURL) &&
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        !/\.[a-zA-Z0-9]+$/.test(specifier)
    ) {
        const candidates = [
            new URL(specifier + ".js", context.parentURL),
            new URL(specifier + "/index.js", context.parentURL),
        ];
        for (const candidate of candidates) {
            if (existsSync(candidate)) {
                return nextResolve(candidate.href, context);
            }
        }
    }
    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith(".js")) {
        return nextLoad(url, { ...context, format: "module" });
    }
    return nextLoad(url, context);
}

function urlIsInsideSource(parentURL) {
    return typeof parentURL === "string" && parentURL.startsWith(sourceRoot);
}
