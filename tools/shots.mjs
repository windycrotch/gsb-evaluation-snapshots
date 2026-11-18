// Dev helper: render the synth in a set of states to PNG contact sheets so the
// artwork can be reviewed without poking at a live window.
//   node tools/shots.mjs [demo ...]

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.shots');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');

const demos = process.argv.slice(2);
if (!demos.length) demos.push('idle');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const demo of demos) {
  const file = path.join(outDir, `${demo.replace(/[:]/g, '-')}.png`);
  const env = {
    ...process.env,
    DESKSYNTH_SHOT: file,
    DESKSYNTH_DEMO: demo,
    DESKSYNTH_SHOT_DELAY: process.env.DESKSYNTH_SHOT_DELAY ?? '1400',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const res = spawnSync(electron, [root], { env, stdio: 'inherit', timeout: 30000 });
  if (res.status !== 0) console.error(`shot failed: ${demo}`);
  else console.log(`wrote ${path.relative(root, file)}`);
}
