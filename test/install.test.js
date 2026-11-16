import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// `motlab update` runs `install.js --update`, which has to find every folder the skills went to: the ones in
// ~/.motlab/install.json and agent folders that already hold the skill from an install before that file existed.
test('install.js --update puts the skills back where they were', () => {
  const home = mkdtempSync(join(tmpdir(), 'motlab-home-'));
  try {
    mkdirSync(join(home, '.agents', 'skills', 'motlab'), { recursive: true });
    writeFileSync(join(home, '.agents', 'skills', 'motlab', 'SKILL.md'), 'old');
    mkdirSync(join(home, '.motlab'));
    writeFileSync(join(home, '.motlab', 'install.json'), JSON.stringify({ skillDirs: [join(home, 'custom')], link: false }));
    const r = spawnSync(process.execPath, ['install.js', '--update', '--dry-run'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`replace ${join(home, '.agents', 'skills', 'motlab')}`), r.stdout);
    assert.ok(r.stdout.includes(`-> ${join(home, 'custom', 'motlab-assets')}`), r.stdout);
    assert.ok(!r.stdout.includes(join(home, '.claude')), 'an agent folder without the skill stays untouched');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// `motlab uninstall` removes only what install.js wrote: launchers that run motlab, skill folders that hold a
// SKILL.md, ~/.motlab and the encoder cache, and asks first. Without a terminal and without --yes it removes nothing.
test('motlab uninstall removes what the installer wrote and nothing else', () => {
  const home = mkdtempSync(join(tmpdir(), 'motlab-home-'));
  const put = (f, text = 'x') => { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text); };
  try {
    put(join(home, 'bin', 'motlab.cmd'), '@node "C:/clone/bin/motlab.js" %*');
    put(join(home, 'bin', 'other.cmd'), 'echo other');
    put(join(home, 'custom', 'motlab', 'SKILL.md'));
    put(join(home, '.claude', 'skills', 'motlab-assets', 'SKILL.md'));
    put(join(home, '.claude', 'skills', 'someone-else', 'SKILL.md'));
    put(join(home, '.motlab', 'install.json'), JSON.stringify({ skillDirs: [join(home, 'custom')], bin: join(home, 'bin') }));
    const cache = process.platform === 'win32' ? join(home, 'local', 'motlab') : join(home, '.cache', 'motlab');   // where probe.js keeps it
    put(join(cache, 'encoder-probe.json'), '{}');
    const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'local'), MOTLAB_KEEP_VIEWER: '1', MOTLAB_CACHE_DIR: '' };
    delete env.MOTLAB_CACHE_DIR;
    const run = (...args) => spawnSync(process.execPath, ['bin/motlab.js', 'uninstall', ...args], { encoding: 'utf8', env, input: '' });
    const gone = [join(home, 'bin', 'motlab.cmd'), join(home, 'custom', 'motlab'), join(home, '.claude', 'skills', 'motlab-assets'), join(home, '.motlab'), cache];
    const asked = run();
    assert.equal(asked.status, 1, asked.stdout);
    for (const f of gone) { assert.ok(asked.stdout.includes(f), `${f} is listed`); assert.ok(existsSync(f), `${f} is kept without --yes`); }
    const r = run('--yes');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const f of gone) assert.ok(!existsSync(f), `${f} is removed`);
    assert.ok(existsSync(join(home, 'bin', 'other.cmd')) && existsSync(join(home, '.claude', 'skills', 'someone-else')), 'other files stay');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
