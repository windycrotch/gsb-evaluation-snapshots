import { existsSync } from 'fs';
import path from 'path';

import { string } from 'rollup-plugin-string';
import ts from 'typescript';

// Test-only bundle of the gsaf player, built from the same source the package ships. The unit
// tests inject their own app, entity and decoder, so the engine is stubbed: nothing the player
// imports from playcanvas runs under node, and a real engine would pull in the DOM. Output goes
// to test-build/, which .gitignore excludes and the package never publishes.

// Mirrors the transpile step in rollup.config.mjs: plain transpilation, no type-checking,
// since `npm run type:check` owns the types and the tests need no tsconfig of their own.
const transpileTypescript = () => ({
    name: 'transpile-typescript',
    resolveId(source, importer) {
        if (!importer || !source.startsWith('.')) return null;
        const base = path.resolve(path.dirname(importer), source);
        return [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => existsSync(candidate)) ?? null;
    },
    transform(code, id) {
        if (!id.endsWith('.ts') || id.endsWith('.d.ts')) return null;
        const output = ts.transpileModule(code, {
            compilerOptions: {
                module: ts.ModuleKind.ESNext,
                target: ts.ScriptTarget.ES2022,
                sourceMap: true,
                inlineSources: true
            },
            fileName: id
        });
        return { code: output.outputText, map: JSON.parse(output.sourceMapText) };
    }
});

// The handful of engine bindings the player module imports; their values never run in the tests.
// WORKBUFFER_UPDATE_ONCE matches the engine's own constant so the work-buffer contract is
// asserted against the real number.
const stubPlaycanvas = () => ({
    name: 'stub-playcanvas',
    resolveId(source) {
        return source === 'playcanvas' ? '\0playcanvas-stub' : null;
    },
    load(id) {
        if (id !== '\0playcanvas-stub') return null;
        return `
export class Entity {}
export class GSplatContainer {}
export class Quat {}
export class Vec3 {}
export const GSplatFormat = { createDefaultFormat: () => null };
export const WORKBUFFER_UPDATE_ONCE = 1;
`;
    }
});

export default {
    input: 'src/gsaf/gsaf-player.ts',
    output: { file: 'test-build/gsaf-player.js', format: 'esm' },
    plugins: [stubPlaycanvas(), string({ include: ['lib/gsaf/*.js'] }), transpileTypescript()]
};
