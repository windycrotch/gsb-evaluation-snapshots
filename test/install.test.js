import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

// After `npm install -g`, npm has made the command, so `motlab setup` (install.js --skills-only) copies the skills
// and writes no launcher and runs no npm ci. It keeps the launcher folder of an earlier clone install in the record.
test('motlab setup copies the skills and nothing else', () => {
  const home = mkdtempSync(join(tmpdir(), 'motlab-home-'));
  try {
    mkdirSync(join(home, '.motlab'));
    writeFileSync(join(home, '.motlab', 'install.json'), JSON.stringify({ skillDirs: [], bin: join(home, 'bin') }));
    const r = spawnSync(process.execPath, ['bin/motlab.js', 'setup', '--skill-dir', join(home, 'agent'), '--skill', 'none', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`-> ${join(home, 'agent', 'motlab')}`) && r.stdout.includes(`-> ${join(home, 'agent', 'motlab-assets')}`), r.stdout);
    assert.ok(!/npm ci|write .*motlab/.test(r.stdout), r.stdout);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Muse Code reads ~/.agents/skills. Hermes reads only the skills folder in its home: HERMES_HOME when it is set, else
// ~/.hermes, or %LOCALAPPDATA%\hermes on Windows.
test('setup --skill muse,hermes puts the skills where Muse Code and Hermes read them', () => {
  const home = mkdtempSync(join(tmpdir(), 'motlab-home-'));
  try {
    const run = extra => spawnSync(process.execPath, ['bin/motlab.js', 'setup', '--skill', 'muse,hermes', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'local'), HERMES_HOME: '', ...extra } });
    const hermes = process.platform === 'win32' ? join(home, 'local', 'hermes') : join(home, '.hermes');
    for (const [extra, dir] of [[{}, hermes], [{ HERMES_HOME: join(home, 'profile') }, join(home, 'profile')]]) {
      const r = run(extra);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      for (const want of [join(home, '.agents', 'skills', 'motlab'), join(dir, 'skills', 'motlab'), join(dir, 'skills', 'motlab-assets')])
        assert.ok(r.stdout.includes(`-> ${want}`), `${want} missing from:\n${r.stdout}`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// After `npm install -g`, setup writes its own launcher only when npm's command folder is not on PATH (nvm for
// Windows 2.0 keeps it off). The package is laid out as npm lays out a global install: <prefix>\node_modules\@motlab\cli
// on Windows, <prefix>/lib/node_modules/@motlab/cli with the command in <prefix>/bin elsewhere.
test('setup from an npm install adds the command only when npm put it off PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'motlab-npm-'));
  try {
    const win = process.platform === 'win32';
    const pkg = win ? join(root, 'prefix', 'node_modules', '@motlab', 'cli') : join(root, 'prefix', 'lib', 'node_modules', '@motlab', 'cli');
    const npmBin = win ? join(root, 'prefix') : join(root, 'prefix', 'bin');
    mkdirSync(pkg, { recursive: true });
    cpSync('install.js', join(pkg, 'install.js')); mkdirSync(join(pkg, 'src')); cpSync('src/userpath.js', join(pkg, 'src', 'userpath.js'));
    const run = path => spawnSync(process.execPath, [join(pkg, 'install.js'), '--skills-only', '--skill', 'none', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root, PATH: path } });
    const off = run(process.env.PATH);
    assert.equal(off.status, 0, off.stderr);
    assert.ok(off.stdout.includes('which is not on PATH') && off.stdout.includes(`write ${join(root, '.local', 'bin', 'motlab')}`), off.stdout);
    const on = run([process.env.PATH, npmBin].join(delimiter));
    assert.equal(on.status, 0, on.stderr);
    assert.ok(!/write|not on PATH/.test(on.stdout), on.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Seen from inside setup, PATH starts with what npx and nvm put in front of the terminal's. Linux and macOS cases are
// checked here on any machine; nvm for Windows 2.0 was also tried for real (CHANGELOG 0.2.1).
test('the PATH check sees the terminal, not what npx and nvm put in front', async () => {
  const { onUserPath } = await import('../src/userpath.js');
  const bins = ['/home/u/ex/node_modules/.bin', '/node_modules/.bin', '/x/node-gyp-bin'], binsW = ['C:/ex/node_modules/.bin', 'C:/x/node-gyp-bin'];
  const nvm = '/home/u/.nvm/versions/node/v24/bin', nvmW = 'C:/nvm/installs/v24', nodeW = 'C:/Program Files/nodejs';
  const on = (dir, PATH, execDir, { win = false, npx = false } = {}) =>
    onUserPath(dir, { win, env: { PATH: PATH.join(win ? ';' : ':'), ...(npx ? { npm_command: 'exec' } : {}) }, execPath: `${execDir}/node` });
  assert.equal(on(nvm, [nvm, '/usr/bin'], nvm), true, 'Linux nvm, setup run directly');
  assert.equal(on(nvm, [...bins, nvm, nvm, '/usr/bin'], nvm, { npx: true }), true, 'Linux nvm, through npx');
  assert.equal(on('/usr/local/bin', [...bins, '/usr/local/bin', '/usr/bin', '/usr/local/bin'], '/usr/local/bin', { npx: true }), true, 'Linux system Node, through npx');
  assert.equal(on('/opt/node/bin', [...bins, '/opt/node/bin', '/usr/bin'], '/opt/node/bin', { npx: true }), false, 'Linux, npm folder off PATH');
  assert.equal(on(nvmW, [nvmW, ...binsW, nvmW, 'C:/Users/u/bin'], nvmW, { win: true, npx: true }), false, 'nvm for Windows, through npx');
  assert.equal(on(nvmW, [nvmW, 'C:/Users/u/bin'], nvmW, { win: true }), false, 'nvm for Windows, run directly');
  assert.equal(on(nodeW, [...binsW, nodeW, 'C:/Windows', nodeW], nodeW, { win: true, npx: true }), true, 'Node from nodejs.org on Windows, through npx');
});
