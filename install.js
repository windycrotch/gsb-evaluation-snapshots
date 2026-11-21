#!/usr/bin/env node
// Installs motlab from this folder: npm packages, a `motlab` command on PATH and the agent skills (motlab, motlab-assets).
//
//   node install.js                       engine, command and the skills for Claude Code
//   node install.js --skill agents        the skills in ~/.agents/skills (Codex, Cursor, OpenCode, Copilot, Gemini CLI, Amp,
//                                         Windsurf, Muse Code)
//   node install.js --skill hermes        the skills in Hermes Agent's own folder
//   node install.js --skill claude,antigravity   several agents at once (see SKILL_DIRS; none for no skills)
//   node install.js --skill-dir <dir>     the skills in any other agent's skill folder
//   node install.js --link                link the skills to this folder instead of copying them (for working on a skill)
//   node install.js --bin <dir>           where the `motlab` command goes (default ~/.local/bin)
//   node install.js --dry-run             print what would happen and change nothing
//   node install.js --update              the skills again where they went last time (what `motlab update` runs)
//   node install.js --skills-only         the skills, no npm ci (what `motlab setup` runs after `npm install -g
//                                         @motlab/cli`); a launcher only when npm's command folder is not on PATH
//
// Where the skills, the launcher and --link went is kept in ~/.motlab/install.json for --update. It never installs
// Chrome, ffmpeg or Python; it says how to get them.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { onUserPath } from './src/userpath.js';

const HERE = dirname(fileURLToPath(import.meta.url)), WIN = process.platform === 'win32', HOME = homedir();
// Each agent's user skill folder, from its docs (November 2026). ~/.agents/skills is the shared one: Codex reads only that,
// and Cursor, OpenCode, Copilot, Gemini CLI, Amp, Windsurf and Muse Code read it too. Claude Code, Antigravity and
// Hermes do not. Hermes reads the skills folder in its home: HERMES_HOME, else ~/.hermes, or %LOCALAPPDATA%\hermes on Windows.
const AGENTS = join(HOME, '.agents', 'skills');
const HERMES = process.env.HERMES_HOME ? resolve(process.env.HERMES_HOME.replace(/^~(?=$|[\\/])/, HOME))
  : WIN ? join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'), 'hermes') : join(HOME, '.hermes');
const SKILL_DIRS = {
  claude: join(HOME, '.claude', 'skills'),
  agents: AGENTS,
  codex: AGENTS,
  muse: AGENTS,
  hermes: join(HERMES, 'skills'),
  antigravity: join(HOME, '.gemini', 'config', 'skills'),   // the one folder both the Antigravity App and the CLI (agy) read
  opencode: join(HOME, '.config', 'opencode', 'skills'),
  cursor: join(HOME, '.cursor', 'skills'),
  copilot: join(HOME, '.copilot', 'skills'),
};

const { values: o } = parseArgs({ options: {
  skill: { type: 'string' }, 'skill-dir': { type: 'string', multiple: true }, link: { type: 'boolean' }, bin: { type: 'string' },
  update: { type: 'boolean' }, 'skills-only': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
if (o.help) { console.log(`usage: node install.js [--skill ${Object.keys(SKILL_DIRS).join('|')}|none[,...]] [--skill-dir <dir>] [--link] [--bin <dir>] [--update] [--skills-only] [--force] [--dry-run]`); process.exit(0); }
// --update puts the skills where they went before: the folders in the record, and any agent folder above that already
// has the motlab skill (an install from before there was a record). --skill and --skill-dir add to them.
const RECORD = join(HOME, '.motlab', 'install.json');
let prev = {}; try { prev = JSON.parse(readFileSync(RECORD, 'utf8')); } catch {}
const last = o.update ? prev : {}, only = o['skills-only'];
const found = o.update ? Object.values(SKILL_DIRS).filter(d => existsSync(join(d, 'motlab', 'SKILL.md'))) : [];
const targets = (o.skill ?? (o.update ? 'none' : 'claude')).split(',').map(t => t.trim()).filter(t => t && t !== 'none');
const bad = targets.filter(t => !SKILL_DIRS[t]);
if (bad.length) { console.error(`unknown --skill ${bad.join(', ')}; use ${Object.keys(SKILL_DIRS).join(', ')}, none, or --skill-dir <dir>`); process.exit(1); }
const skillDirs = [...new Set([...targets.map(t => SKILL_DIRS[t]),   // codex, muse and agents are one folder
  ...(o['skill-dir'] || []).map(d => resolve(d.replace(/^~(?=$|[\\/])/, HOME))), ...(last.skillDirs || []), ...found])];
const link = o.link ?? !!last.link;
const dry = o['dry-run'], say = s => console.log(dry ? `[dry run] ${s}` : s);

if (Number(process.versions.node.split('.')[0]) < 24) { console.error(`motlab needs Node 24 or newer; this is ${process.version}.`); process.exit(1); }

// 1. npm packages (an npm install already has them)
if (!only) say(`npm ci in ${HERE}`);
if (!only && !dry) {
  const r = spawnSync('npm ci --no-audit --no-fund', { cwd: HERE, stdio: 'inherit', shell: true });   // one string: npm is npm.cmd on Windows
  if (r.status !== 0) { console.error('npm ci failed. Fix the error above and run the installer again.'); process.exit(1); }
}

// 2. the `motlab` command: small launchers that run this folder's bin/motlab.js
// With --skills-only from an npm install, npm made the command in its global folder: <prefix> on Windows, <prefix>/bin
// elsewhere. nvm for Windows 2.0 keeps that folder off PATH (its .shim folder only has the shims nvm ships with), so
// then the launchers are written as for a clone. From npx's cache there is no install to point a launcher at.
const onPathDir = dir => onUserPath(dir);   // the terminal's PATH, without what npx and nvm put in front (src/userpath.js)
const nm = HERE.lastIndexOf(`node_modules`), fromNpm = only && nm > 0;
if (fromNpm && /[\\/]_npx[\\/]/.test(HERE)) { console.error('motlab is not installed. Install it first, then run setup again:\n  npm install -g @motlab/cli'); process.exit(1); }
const npmBin = fromNpm ? (WIN ? HERE.slice(0, nm) : join(HERE.slice(0, nm), '..', 'bin')) : null;
const needLaunchers = !only || (fromNpm && !onPathDir(npmBin));
if (only && needLaunchers) console.log(`npm put the motlab command in ${resolve(npmBin)}, which is not on PATH, so motlab writes its own.`);
const bin = needLaunchers ? resolve(o.bin || last.bin || prev.bin || join(HOME, '.local', 'bin')) : prev.bin, entry = join(HERE, 'bin', 'motlab.js');
const launchers = WIN
  ? [['motlab.cmd', `@node "${entry}" %*\r\n`], ['motlab', `#!/bin/sh\nexec node "${entry.replaceAll('\\', '/')}" "$@"\n`]]   // cmd/PowerShell, Git Bash
  : [['motlab', `#!/bin/sh\nexec node "${entry}" "$@"\n`]];
if (needLaunchers) for (const [name, body] of launchers) {
  let old = ''; try { old = readFileSync(join(bin, name), 'utf8'); } catch {}
  say(old && old !== body ? `replace ${join(bin, name)} (it ran ${(/"([^"]+motlab\.js)"/.exec(old) || [, 'something else'])[1]})` : `write ${join(bin, name)}`);
  if (!dry) { mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, name), body); if (!WIN) chmodSync(join(bin, name), 0o755); }
}
const onPath = !needLaunchers || onPathDir(bin);
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
