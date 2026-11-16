// `motlab doctor`: checks what the engine and the skill need on this machine and says how to get what is missing.
// It never installs anything. The installer (install.js) runs the same checks.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findChrome } from './chrome.js';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return r.status === 0 ? (r.stdout || r.stderr).trim() : null;
};
const firstLine = s => s && s.split('\n')[0].trim();

const HINTS = {
  win32: { ffmpeg: 'winget install Gyan.FFmpeg', chrome: 'winget install Google.Chrome', python: 'winget install Python.Python.3.12' },
  darwin: { ffmpeg: 'brew install ffmpeg', chrome: 'brew install --cask google-chrome', python: 'brew install python' },
  linux: { ffmpeg: 'sudo apt install ffmpeg', chrome: 'install Google Chrome or Chromium from your distribution', python: 'sudo apt install python3 python3-pip' },
};

// Each check: { name, ok, detail, fix, optional }. Required checks decide the exit code.
export function checks() {
  const hint = HINTS[process.platform] || HINTS.linux, out = [];
  const major = Number(process.versions.node.split('.')[0]);
  out.push({ name: 'Node.js 24 or newer', ok: major >= 24, detail: process.version, fix: 'install Node 24 from https://nodejs.org or with nvm' });

  let chrome = null; try { chrome = findChrome(); } catch {}
  out.push({ name: 'Google Chrome or Chromium', ok: !!chrome, detail: chrome || 'not found', fix: `${hint.chrome}, or set CHROME=/path/to/chrome` });

  for (const tool of ['ffmpeg', 'ffprobe']) {
    const v = firstLine(run(tool, ['-version']));
    out.push({ name: tool, ok: !!v, detail: v ? v.replace(/ Copyright.*/, '') : 'not on PATH', fix: hint.ffmpeg });
  }
  out.push({ name: 'npm packages (mediabunny)', ok: existsSync(new URL('../node_modules/mediabunny/package.json', import.meta.url)), detail: '', fix: 'run npm ci in the engine folder' });

  // Python is only for the skill's helper scripts (contact sheets, sound effects, mixing, fonts).
  const py = ['python3', 'python'].map(p => ({ p, v: firstLine(run(p, ['--version'])) })).find(x => x.v && /Python 3/.test(x.v));
  out.push({ name: 'Python 3 (skill scripts)', ok: !!py, optional: true, detail: py ? `${py.p}: ${py.v}` : 'not found', fix: hint.python });
  if (py) {
    const missing = ['numpy', 'scipy', 'PIL'].filter(m => run(py.p, ['-c', `import ${m}`]) === null);
    out.push({ name: 'Python packages (numpy, scipy, Pillow)', ok: !missing.length, optional: true, detail: missing.length ? `missing: ${missing.join(', ')}` : '',
      fix: `${py.p} -m pip install -r skills/motlab/requirements.txt` });
  }
  return out;
}

export function doctor(log = console.log) {
  const list = checks();
  for (const c of list) {
    log(`${c.ok ? 'ok  ' : c.optional ? 'warn' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
    if (!c.ok) log(`      fix: ${c.fix}`);
  }
  const failed = list.filter(c => !c.ok && !c.optional);
  log(failed.length ? `\n${failed.length} required check(s) failed.` : '\nReady. The GPU in use is printed at the start of every render.');
  return failed.length ? 1 : 0;
}
