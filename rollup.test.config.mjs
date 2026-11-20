import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

// bundles the browser test page. the tests import the real source modules so
// they exercise the same export chain the application uses.
export default {
    input: 'test/browser-tests.js',
    output: {
        file: 'test-dist/browser-tests.js',
        format: 'es',
        sourcemap: true
    },
    plugins: [
        resolve({ browser: true, extensions: ['.ts', '.js', '.mjs'] }),
        typescript({
            tsconfig: './tsconfig.json',
            include: ['src/**/*.ts'],
            compilerOptions: {
                inlineSources: false
            }
        }),
        json()
    ]
};
