/**
 * Test runner: bundle the TS test suite with esbuild (already present via vite,
 * no extra dev dependency) into a temp ESM file and run it on node's built-in
 * test runner as a child process. Usage: npm test
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Outside node_modules (Node treats entry files there differently) and inside
// the project so module resolution from node_modules works on every platform.
// Git-ignored; removed in the finally below.
const tmpDir = join(process.cwd(), '.tmp-tests');
const outfile = join(tmpDir, 'viz-tests.mjs');

try {
  await mkdir(tmpDir, { recursive: true });
  await build({
    entryPoints: ['test/index.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'warning',
    // h3-js (and friends) are CJS packages that rely on __dirname; bundling
    // them into an ESM output breaks that, so let Node resolve them natively.
    packages: 'external',
  });

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', outfile], { stdio: 'inherit' });
    child.on('close', resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
