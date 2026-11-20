// Separate rollup build for the local acceptance harness. It bundles the REAL
// application source (reproject-panel + texture-manager + ...) together with a
// test driver, without the scss import that belongs to the production entry.
import resolve from '@rollup/plugin-node-resolve';
import json from '@rollup/plugin-json';
import typescript from '@rollup/plugin-typescript';

export default {
    input: 'acceptance/harness-main.ts',
    output: {
        file: 'acceptance/build/harness-main.js',
        format: 'es',
        sourcemap: false
    },
    plugins: [
        resolve(),
        json(),
        typescript({
            tsconfig: './acceptance/tsconfig.harness.json',
            filterRoot: '../'
        })
    ]
};
