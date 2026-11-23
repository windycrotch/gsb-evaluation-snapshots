// Launches headless Chrome on the real GPU and talks to it over the DevTools protocol (no dependency: Node's WebSocket).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

// Playwright downloads Chrome for Testing into chromium-<revision> folders in its own cache (or PLAYWRIGHT_BROWSERS_PATH),
// so a machine set up for Playwright has a Chrome without a system install. Folder and file names are the ones in
// Playwright's registry (packages/playwright-core/src/server/registry/index.ts). Its chromium_headless_shell folders are
// left out: that is the old headless mode, and motlab runs --headless=new.
const PLAYWRIGHT_EXE = {
  'linux-x64': ['chrome-linux64', 'chrome'],
  'linux-arm64': ['chrome-linux-arm64', 'chrome'],
  'darwin-x64': ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  'darwin-arm64': ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  'win32-x64': ['chrome-win64', 'chrome.exe'],
};

function playwrightDir() {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (env === '0') return null;   // the browsers sit inside one project's node_modules
  if (env) return env;
  const home = homedir();
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  return join(process.env.XDG_CACHE_HOME || join(home, '.cache'), 'ms-playwright');
}

// The newest Playwright Chromium in dir that has its executable, or null.
export function playwrightChrome(dir = playwrightDir(), platform = `${process.platform}-${process.arch}`) {
  const exe = PLAYWRIGHT_EXE[platform];
  if (!dir || !exe) return null;
  let names; try { names = readdirSync(dir); } catch { return null; }
  return names.map(n => /^chromium-(\d+)$/.exec(n)).filter(Boolean).sort((a, b) => b[1] - a[1])
    .map(m => join(dir, m[0], ...exe)).find(p => existsSync(p)) ?? null;
}

export function findChrome(explicit) {
  const path = explicit || process.env.CHROME || CANDIDATES.find(p => existsSync(p)) || playwrightChrome();
  if (!path || !existsSync(path)) throw new Error("Chrome not found (also looked for Playwright's Chromium). Pass --chrome <path> or set CHROME=/path/to/chrome");
  return path;
}

// --force_high_performance_gpu matters on dual-GPU laptops: without it headless Chrome draws on the integrated GPU.
// --enable-unsafe-swiftshader lets WebGL fall back to software on a machine without a usable GPU (a Linux CI runner
// has no WebGL2 otherwise); with a GPU it changes nothing. It is "unsafe" for browsing untrusted sites, and motlab
// only opens the user's own pages.
export const GPU_FLAGS = ['--enable-gpu', '--force_high_performance_gpu', '--enable-unsafe-swiftshader', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];

// Chrome refuses to start as root without --no-sandbox ("Running as root without
// --no-sandbox is not supported"), which is how it runs in a container or on a
// VPS logged in as root. motlab only opens the user's own pages, so the sandbox
// buys nothing here; add the flag when root, and only then.
export const SANDBOX_FLAGS = typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];

const live = new Set();
process.on('exit', () => { for (const c of live) c.killSync(); });

export async function launchChrome({ chromePath, extraArgs = [] }) {
  const profile = mkdtempSync(join(tmpdir(), 'motlab-chrome-'));
  const proc = spawn(chromePath, [
    '--headless=new', ...GPU_FLAGS, ...SANDBOX_FLAGS,
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1920,1080', ...extraArgs, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((ok, no) => {
    let err = '';
    const timer = setTimeout(() => no(new Error('Chrome did not open a DevTools port within 30 s')), 30000);
    proc.stderr.on('data', d => {   // keep draining stderr for the whole run so the pipe never fills
      if (err.length < 20000) err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    proc.once('exit', code => { clearTimeout(timer); no(new Error(`Chrome exited early (code ${code}): ${err.slice(0, 400)}`)); });
    proc.once('error', e => { clearTimeout(timer); no(e); });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('could not connect to Chrome DevTools')); });

  let nextId = 0, closed = false;
  const pending = new Map(), listeners = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) {
      const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
      if (m.error) p.no(new Error(`${p.method}: ${m.error.message}`)); else p.ok(m.result);
    } else for (const fn of listeners.get(m.method) || []) fn(m.params, m.sessionId);
  };
  ws.onclose = () => { closed = true; for (const p of pending.values()) p.no(new Error('Chrome connection closed')); pending.clear(); };

  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    if (closed) return no(new Error('Chrome connection closed'));
    const id = ++nextId; pending.set(id, { ok, no, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const on = (event, fn) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); };

  const chrome = {
    send, on,
    killSync() { try { proc.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} },
    async close() {
      live.delete(chrome);
      if (proc.exitCode !== null || proc.signalCode !== null) return chrome.killSync();
      const gone = new Promise(r => proc.once('exit', r));
      try { await Promise.race([send('Browser.close'), new Promise(r => setTimeout(r, 2000))]); } catch {}
      await Promise.race([gone, new Promise(r => setTimeout(r, 3000))]);
      chrome.killSync();
    },
  };
  live.add(chrome);
  chrome.version = (await send('Browser.getVersion')).product;
  return chrome;
}

// One page (tab) in a Chrome process: evaluate code in it and receive the messages the in-page runtime emits.
export async function attachPage(chrome) {
  const { targetInfos } = await chrome.send('Target.getTargets');
  const target = targetInfos.find(t => t.type === 'page');
  if (!target) throw new Error('Chrome has no page target');
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const send = (method, params) => chrome.send(method, params, sessionId);

  const errors = [], emitHandlers = [];
  // Every request the page (and its iframes) made, for the dependency list of a cached part (deps.js): a response's
  // status, or the error it failed with. A request still in flight at the end has neither.
  const requests = new Map();
  chrome.on('Network.requestWillBeSent', (p, sid) => {
    if (sid !== sessionId) return;
    requests.set(p.requestId, { url: p.request.url, method: p.request.method, status: 0 });
  });
  chrome.on('Network.responseReceived', (p, sid) => {
    if (sid !== sessionId) return;
    const r = requests.get(p.requestId) || { url: p.response.url, method: 'GET' };
    r.status = p.response.status; requests.set(p.requestId, r);
  });
  // A seek cancels a paused video's range requests on purpose, so a cancelled request is not an error by itself.
  chrome.on('Network.loadingFailed', (p, sid) => {
    if (sid !== sessionId) return;
    const r = requests.get(p.requestId); if (!r) return;
    r.error = p.errorText; r.canceled = p.canceled;
  });
  // A SyntaxError's description names no file, so the file and line are added from the exception details.
  const where = d => d.url ? ` (${decodeURIComponent(new URL(d.url).pathname)}:${d.lineNumber + 1}:${d.columnNumber + 1})` : '';
  chrome.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid !== sessionId) return;
    const d = p.exceptionDetails, text = d.exception?.description || d.text, place = where(d);
    errors.push(place && !text.includes(place.slice(2, -1)) ? text + place : text);
  });
  chrome.on('Runtime.bindingCalled', (p, sid) => {
    if (sid !== sessionId || p.name !== '__motlabEmit') return;
    let msg; try { msg = JSON.parse(p.payload); } catch { return; }
    for (const fn of emitHandlers) fn(msg);
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Runtime.addBinding', { name: '__motlabEmit' });
  // Only for the dependency list (deps.js). If it cannot be turned on the page still renders, but a part whose
  // dependencies cannot be seen must not be cached as if they were unchanged (render.js says so).
  const network = await send('Network.enable').then(() => true, () => false);

  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page error');
    return r.result.value;
  };
  return { send, evaluate, errors, requests: () => [...requests.values()], network, onEmit: fn => emitHandlers.push(fn), navigate: url => send('Page.navigate', { url }) };
}
