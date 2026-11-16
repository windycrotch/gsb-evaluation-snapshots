// motlab uninstall: removes what install.js put on this machine. It stops the viewer, then deletes the `motlab`
// launchers, the two skill folders in every agent folder from ~/.motlab/install.json (or, without that record, in
// the agent folders install.js knows), ~/.motlab and the encoder cache. It lists everything and asks first. The
// clone is left, because this command runs from it.
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { cacheFile } from './probe.js';
import { stopViewer } from './viewer.js';

const HOME = homedir(), STATE = join(HOME, '.motlab'), ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
// The agent skill folders install.js writes to, for an install from before ~/.motlab/install.json existed.
const KNOWN = ['.claude/skills', '.agents/skills', '.gemini/config/skills', '.config/opencode/skills', '.cursor/skills', '.copilot/skills'].map(d => join(HOME, d));

function targets() {
  let record = {}; try { record = JSON.parse(readFileSync(join(STATE, 'install.json'), 'utf8')); } catch {}
  const out = [];
  const bin = record.bin || join(HOME, '.local', 'bin');
  for (const name of ['motlab', 'motlab.cmd']) {   // only launchers that run this clone
    const f = join(bin, name);
    try { if (readFileSync(f, 'utf8').includes('motlab.js')) out.push({ path: f, what: 'launcher' }); } catch {}
  }
  for (const dir of new Set([...(record.skillDirs || []), ...KNOWN])) for (const name of ['motlab', 'motlab-assets']) {
    const d = join(dir, name);
    let stat = null; try { stat = lstatSync(d); } catch {}
    if (stat?.isSymbolicLink()) out.push({ path: d, what: 'skill link', link: true });   // removed as a link, never through it
    else if (stat && existsSync(join(d, 'SKILL.md'))) out.push({ path: d, what: 'skill' });
  }
  if (existsSync(STATE)) out.push({ path: STATE, what: 'install record, recent projects, viewer log' });
  const cache = cacheFile(), cacheDir = dirname(cache);
  // The default cache folder is motlab's own; a folder from MOTLAB_CACHE_DIR may hold other things, so only the file goes.
  if (!process.env.MOTLAB_CACHE_DIR && existsSync(cacheDir)) out.push({ path: cacheDir, what: 'encoder timings' });
  else if (existsSync(cache)) out.push({ path: cache, what: 'encoder timings' });
  return out;
}

export async function uninstall({ dryRun = false, yes = false } = {}) {
  const list = targets();
  if (!list.length) { console.log('Nothing from motlab is installed here.'); return 0; }
  console.log('motlab uninstall removes:');
  for (const t of list) console.log(`  ${t.path}  (${t.what})`);
  console.log(`It leaves the clone in ${ROOT}; delete that folder yourself afterwards.`);
  if (dryRun) return 0;
  if (!yes) {
    if (!process.stdin.isTTY) { console.log('Run it again with --yes to remove them.'); return 1; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Remove these? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') { console.log('Nothing removed.'); return 1; }
  }
  // The viewer holds ~/.motlab/viewer.log open. MOTLAB_KEEP_VIEWER is for the tests, which must not stop a real one.
  if (!process.env.MOTLAB_KEEP_VIEWER) try { await stopViewer({ say: true }); } catch (e) { console.log(`Could not stop the viewer: ${e.message}`); }
  for (const t of list) {
    try { rmSync(t.path, t.link ? {} : { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); console.log(`removed ${t.path}`); }
    catch (e) { console.log(`could not remove ${t.path}: ${e.message}`); }
  }
  console.log(`\nDone. To remove the rest, delete ${ROOT}.`);
  return 0;
}
