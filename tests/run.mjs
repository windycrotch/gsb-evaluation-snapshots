// Test runner: build the dev bundle (unminified + inline sourcemap, which exposes the __step/__snap/__bot
// hooks the tests drive), run the regression suite, then ALWAYS rebuild the shipping bundle. The committed
// index.html is the minified production build that GitHub Pages serves, so a test run must not leave a dev
// build behind — even when the suite fails.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });

const buildDev = run([path.join(root, 'tools', 'build.mjs'), '--dev']);
if (buildDev.status !== 0) { console.error('[test] dev build failed'); process.exit(buildDev.status ?? 1); }

const test = run([path.join(root, 'tests', 'pause-retry.test.mjs')]);

const buildProd = run([path.join(root, 'tools', 'build.mjs')]);
if (buildProd.status !== 0) { console.error('[test] production rebuild failed'); process.exit(buildProd.status ?? 1); }

process.exit(test.status ?? 1);
