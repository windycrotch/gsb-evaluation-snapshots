/**
 * Bundles the TypeScript tests with esbuild into a scratch directory and runs
 * them under Node's built-in test runner. No extra test framework needed.
 *
 * Usage: node tests/run-tests.mjs
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'node_modules', '.tmp-tests');

const entryPoints = [
  join(root, 'tests', 'processor.test.ts'),
  join(root, 'tests', 'engineSync.test.ts'),
];

await build({
  entryPoints,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outdir: outDir,
  outExtension: { '.js': '.cjs' },
  logLevel: 'warning',
});

const files = ['processor.test.cjs', 'engineSync.test.cjs'].map((f) => join(outDir, f));

const child = spawn(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: root,
});

child.on('exit', (code) => {
  rmSync(outDir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
