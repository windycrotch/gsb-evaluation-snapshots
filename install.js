#!/usr/bin/env node
// Installs motlab from this folder: npm packages, a `motlab` command on PATH and the agent skills (motlab, motlab-assets).
//
//   node install.js                       engine, command and the skills for Claude Code
//   node install.js --skill agents        the skills in ~/.agents/skills (Codex, Cursor, OpenCode, Copilot, Gemini CLI, Amp, Windsurf)
//   node install.js --skill claude,antigravity   several agents at once (see SKILL_DIRS; none for no skills)
//   node install.js --skill-dir <dir>     the skills in any other agent's skill folder
//   node install.js --link                link the skills to this folder instead of copying them (for working on a skill)
//   node install.js --bin <dir>           where the `motlab` command goes (default ~/.local/bin)
//   node install.js --dry-run             print what would happen and change nothing
//   node install.js --update              the skills again where they went last time (what `motlab update` runs)
//
// Where the skills, the launcher and --link went is kept in ~/.motlab/install.json for --update. It never installs
// Chrome, ffmpeg or Python; it says how to get them.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url)), WIN = process.platform === 'win32', HOME = homedir();
// Each agent's user skill folder, from its docs (November 2026). ~/.agents/skills is the shared one: Codex reads only that,
// and Cursor, OpenCode, Copilot, Gemini CLI, Amp and Windsurf read it too. Claude Code and Antigravity do not.
const AGENTS = join(HOME, '.agents', 'skills');
const SKILL_DIRS = {
  claude: join(HOME, '.claude', 'skills'),
  agents: AGENTS,
  codex: AGENTS,
  antigravity: join(HOME, '.gemini', 'config', 'skills'),   // the one folder both the Antigravity App and the CLI (agy) read
  opencode: join(HOME, '.config', 'opencode', 'skills'),
  cursor: join(HOME, '.cursor', 'skills'),
  copilot: join(HOME, '.copilot', 'skills'),
};

const { values: o } = parseArgs({ options: {
  skill: { type: 'string' }, 'skill-dir': { type: 'string', multiple: true }, link: { type: 'boolean' }, bin: { type: 'string' },
  update: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
if (o.help) { console.log(`usage: node install.js [--skill ${Object.keys(SKILL_DIRS).join('|')}|none[,...]] [--skill-dir <dir>] [--link] [--bin <dir>] [--update] [--force] [--dry-run]`); process.exit(0); }
// --update puts the skills where they went before: the folders in the record, and any agent folder above that already
// has the motlab skill (an install from before there was a record). --skill and --skill-dir add to them.
const RECORD = join(HOME, '.motlab', 'install.json');
let last = {}; if (o.update) try { last = JSON.parse(readFileSync(RECORD, 'utf8')); } catch {}
const found = o.update ? Object.values(SKILL_DIRS).filter(d => existsSync(join(d, 'motlab', 'SKILL.md'))) : [];
const targets = (o.skill ?? (o.update ? 'none' : 'claude')).split(',').map(t => t.trim()).filter(t => t && t !== 'none');
const bad = targets.filter(t => !SKILL_DIRS[t]);
if (bad.length) { console.error(`unknown --skill ${bad.join(', ')}; use ${Object.keys(SKILL_DIRS).join(', ')}, none, or --skill-dir <dir>`); process.exit(1); }
const skillDirs = [...new Set([...targets.map(t => SKILL_DIRS[t]),   // codex and agents are one folder
  ...(o['skill-dir'] || []).map(d => resolve(d.replace(/^~(?=$|[\\/])/, HOME))), ...(last.skillDirs || []), ...found])];
const link = o.link ?? !!last.link;
const dry = o['dry-run'], say = s => console.log(dry ? `[dry run] ${s}` : s);

if (Number(process.versions.node.split('.')[0]) < 24) { console.error(`motlab needs Node 24 or newer; this is ${process.version}.`); process.exit(1); }

// 1. npm packages
say(`npm ci in ${HERE}`);
if (!dry) {
  const r = spawnSync('npm ci --no-audit --no-fund', { cwd: HERE, stdio: 'inherit', shell: true });   // one string: npm is npm.cmd on Windows
  if (r.status !== 0) { console.error('npm ci failed. Fix the error above and run the installer again.'); process.exit(1); }
}

// 2. the `motlab` command: small launchers that run this folder's bin/motlab.js
const bin = resolve(o.bin || last.bin || join(HOME, '.local', 'bin')), entry = join(HERE, 'bin', 'motlab.js');
const launchers = WIN
  ? [['motlab.cmd', `@node "${entry}" %*\r\n`], ['motlab', `#!/bin/sh\nexec node "${entry.replaceAll('\\', '/')}" "$@"\n`]]   // cmd/PowerShell, Git Bash
  : [['motlab', `#!/bin/sh\nexec node "${entry}" "$@"\n`]];
for (const [name, body] of launchers) {
  say(`write ${join(bin, name)}`);
  if (!dry) { mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, name), body); if (!WIN) chmodSync(join(bin, name), 0o755); }
}
const onPath = (process.env.PATH || '').split(delimiter).some(p => p && resolve(p).toLowerCase() === bin.toLowerCase());
if (!onPath) console.log(`\n${bin} is not on PATH yet. Add it, then open a new terminal:\n  ${WIN
  ? `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${bin}', 'User')   (PowerShell)`
  : `echo 'export PATH="${bin}:$PATH"' >> ~/.profile`}\n`);

// 3. the skills
if (o.update && !skillDirs.length) say('no skill folders from an earlier install; pass --skill to add the skills');
for (const dir of skillDirs) for (const name of ['motlab', 'motlab-assets']) {
  const src = join(HERE, 'skills', name), dest = join(dir, name);
  let stat = null; try { stat = lstatSync(dest); } catch {}
  const isLink = stat?.isSymbolicLink();
  if (isLink && realpathSync(dest) === realpathSync(src)) say(`skill already linked to this folder: ${dest}`);
  else {
    if (stat) {
      // A link is removed as a link (never through it); a directory that is not ours needs --force.
      if (isLink) say(`remove the old link ${dest} -> ${readlinkSync(dest)}`);
      else if (!existsSync(join(dest, 'SKILL.md')) && !o.force) { console.error(`${dest} exists and is not a skill. Move it away or pass --force.`); process.exit(1); }
      else say(`replace ${dest}`);
      if (!dry) rmSync(dest, isLink ? {} : { recursive: true, force: true });
    }
    say(link ? `link ${dest} -> ${src}` : `copy ${src} -> ${dest}`);
    if (!dry) { mkdirSync(dirname(dest), { recursive: true }); link ? symlinkSync(src, dest, WIN ? 'junction' : 'dir') : cpSync(src, dest, { recursive: true }); }
  }
}

if (!dry) { mkdirSync(dirname(RECORD), { recursive: true }); writeFileSync(RECORD, JSON.stringify({ skillDirs, link, bin }, null, 2) + '\n'); }

// 4. what is still missing on this machine
if (!dry) {
  console.log('\nChecking the machine:');
  const { doctor } = await import('./src/doctor.js');
  const code = doctor();
  console.log(code ? '\nInstall what is marked FAIL, then run `motlab doctor` again.' : `\nDone. Try: motlab edit "${join(HERE, 'example')}"`);
}
