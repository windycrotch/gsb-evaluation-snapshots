// `motlab doctor`: checks what the engine and the skill need on this machine and says how to get what is missing.
// It never installs anything. The installer (install.js) runs the same checks.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.js';

// Found the way the server finds it: npm may put it inside the engine folder (a clone, a global install) or next to it.
export const hasMediabunny = () => { try { createRequire(import.meta.url).resolve('mediabunny'); return true; } catch { return false; } };

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false });
  return r.status === 0 ? (r.stdout || r.stderr).trim() : null;
};
const firstLine = s => s && s.split('\n')[0].trim();

const HINTS = {
  win32: { ffmpeg: 'winget install Gyan.FFmpeg', chrome: 'winget install Google.Chrome', python: 'winget install Python.Python.3.12' },
  darwin: { ffmpeg: 'brew install ffmpeg', chrome: 'brew install --cask google-chrome', python: 'brew install python' },
  // Google's x64 .deb puts google-chrome in /usr/bin. Ubuntu's apt chromium is a snap, which can fail headless.
  linux: { ffmpeg: 'sudo apt install ffmpeg', python: 'sudo apt install python3 python3-pip',
    chrome: process.arch === 'x64'
      ? 'on Debian or Ubuntu, Google Chrome (the Chromium snap can fail headless):\n        wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y ./google-chrome-stable_current_amd64.deb'
      : 'install Chromium from your distribution, not the snap (the Google Chrome .deb is for x64)' },
};

// Each check: { name, ok, detail, fix, optional }. Required checks decide the exit code.
export function checks() {
  const hint = HINTS[process.platform] || HINTS.linux, out = [];
  const major = Number(process.versions.node.split('.')[0]);
  out.push({ name: 'Node.js 24 or newer', ok: major >= 24, detail: process.version, fix: 'install Node 24 from https://nodejs.org or with nvm' });

  let chrome = null; try { chrome = findChrome(); } catch {}
  out.push({ name: 'Google Chrome or Chromium', ok: !!chrome, detail: chrome || 'not found', fix: `${hint.chrome}\n        or set CHROME=/path/to/chrome` });

  for (const tool of ['ffmpeg', 'ffprobe']) {
    const v = firstLine(run(tool, ['-version']));
    out.push({ name: tool, ok: !!v, detail: v ? v.replace(/ Copyright.*/, '') : 'not on PATH', fix: hint.ffmpeg });
  }
  out.push({ name: 'npm packages (mediabunny)', ok: hasMediabunny(), detail: '', fix: 'run npm ci in the engine folder' });

  // Python is only for the skill's helper scripts (contact sheets, sound effects, mixing, fonts).
  const py = ['python3', 'python'].map(p => ({ p, v: firstLine(run(p, ['--version'])) })).find(x => x.v && /Python 3/.test(x.v));
  out.push({ name: 'Python 3 (skill scripts)', ok: !!py, optional: true, detail: py ? `${py.p}: ${py.v}` : 'not found', fix: hint.python });
  if (py) {
    const missing = ['numpy', 'scipy', 'PIL'].filter(m => run(py.p, ['-c', `import ${m}`]) === null);
    out.push({ name: 'Python packages (numpy, scipy, Pillow)', ok: !missing.length, optional: true, detail: missing.length ? `missing: ${missing.join(', ')}` : '',
      fix: `${py.p} -m pip install -r "${fileURLToPath(new URL('../skills/motlab/requirements.txt', import.meta.url))}"` });   // the full path: an npm install is not the current folder
  }
  out.push(earshotCheck());
  return out;
}

// earshot (github.com/Leonxlnx/earshot, MIT) lets the agent listen: the skill uses it to pick sounds and check a mix
// when it is there. Optional and never installed here: it needs Python with torch and about 1.1 GB of models.
// `earshot doctor` answers in about a second without loading the models and says whether they are downloaded.
export function earshotCheck(runCmd = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', shell: false, timeout: 30000 })) {
  const name = 'earshot (optional: lets the agent listen to sound)';
  const r = runCmd('earshot', ['doctor']);
  if (r.error || r.status !== 0) return { name, ok: false, optional: true, detail: 'not installed', fix: 'install it from https://github.com/Leonxlnx/earshot if you want the agent to listen (Python, about 1.1 GB of models)' };
  let cached = null;
  try { cached = Object.values(JSON.parse(/^models_cached:\s*(\{.*\})\s*$/m.exec(r.stdout)[1])); } catch {}
  if (cached?.length && cached.every(Boolean)) return { name, ok: true, optional: true, detail: 'models downloaded' };
  return { name, ok: false, optional: true, detail: cached ? 'installed, models not downloaded' : 'installed, its doctor output was not understood',
    fix: 'earshot doctor --fetch (downloads about 1.1 GB of models)' };
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
