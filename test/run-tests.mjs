/**
 * Bundles the TypeScript tests with esbuild (GLSL imports included) and runs
 * them through the Node.js built-in test runner. No WebGL/DOM is required.
 *
 * Usage: node test/run-tests.mjs
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { glsl } from 'esbuild-plugin-glsl';
import esbuild from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '.test-build');
const outFile = join(outDir, 'godraysPass.test.mjs');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(scriptDir, 'godraysPass.test.ts')],
  bundle: true,
  outfile: outFile,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: ['three', 'postprocessing'],
  plugins: [glsl()],
  logLevel: 'info',
});

const result = spawnSync(process.execPath, ['--test', outFile], {
  stdio: 'inherit',
  cwd: join(scriptDir, '..'),
});

rmSync(outDir, { recursive: true, force: true });

process.exit(result.status ?? 1);
