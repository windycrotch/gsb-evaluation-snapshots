import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// motlab update: the engine folder is a git clone. It fetches its branch from origin, fast-forwards to it, and runs the
// new install.js with --update, which runs npm ci and copies the skills again to every folder they were installed in.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error) throw new Error('git was not found. Install git, or update by hand as in docs/install.md#updating');
  return { ok: r.status === 0, out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trim() };
};

export function update({ dryRun = false } = {}) {
  if (!existsSync(join(ROOT, '.git'))) throw new Error(`${ROOT} is not a git clone, so it cannot update itself. Clone motlab again (docs/install.md) and run node install.js there`);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out;
  if (branch === 'HEAD') throw new Error(`${ROOT} is not on a branch. Check out main, then run motlab update again`);
  const changed = git('status', '--porcelain', '--untracked-files=no').out;
  if (changed) throw new Error(`${ROOT} has local changes:\n${changed}\nCommit or stash them, then run motlab update again`);

  console.log(`Checking ${branch} on origin...`);
  const f = git('fetch', 'origin', branch);
  if (!f.ok) throw new Error(`git fetch failed: ${f.err}`);
  const from = git('rev-parse', '--short', 'HEAD').out, count = range => Number(git('rev-list', '--count', range).out);
  const behind = count(`HEAD..origin/${branch}`), ahead = count(`origin/${branch}..HEAD`);
  if (!behind) { console.log(`motlab is up to date (${from}).`); return 0; }
  console.log(`${behind} new commit${behind > 1 ? 's' : ''}:\n${git('log', '--oneline', `HEAD..origin/${branch}`).out}\n`);
  if (ahead) throw new Error(`this clone also has ${ahead} commit${ahead > 1 ? 's' : ''} that origin does not, so it cannot fast-forward. Push or rebase them, then run motlab update again`);

  if (dryRun) console.log(`[dry run] git merge --ff-only origin/${branch}`);
  else {
    const m = git('merge', '--ff-only', `origin/${branch}`);
    if (!m.ok) throw new Error(`git merge failed: ${m.err}`);
    console.log(`Updated ${from} to ${git('rev-parse', '--short', 'HEAD').out}.\n`);
  }
  // the installer that just arrived, so a change to it applies to this update
  const r = spawnSync(process.execPath, ['install.js', '--update', ...(dryRun ? ['--dry-run'] : [])], { cwd: ROOT, stdio: 'inherit' });
  if (r.status) return r.status;
  if (!dryRun) console.log('\nA viewer that is already running keeps the old code: run motlab restart. Start a new agent session to load the new skills.');
  return 0;
}
