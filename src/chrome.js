// Launches headless Chrome on the real GPU and talks to it over the DevTools protocol (no dependency: Node's WebSocket).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

export function findChrome(explicit) {
  const path = explicit || process.env.CHROME || CANDIDATES.find(p => existsSync(p));
  if (!path || !existsSync(path)) throw new Error('Chrome not found. Pass --chrome <path> or set CHROME=/path/to/chrome');
  return path;
}

// --force_high_performance_gpu matters on dual-GPU laptops: without it headless Chrome draws on the integrated GPU.
// --enable-unsafe-swiftshader lets WebGL fall back to software on a machine without a usable GPU (a Linux CI runner
// has no WebGL2 otherwise); with a GPU it changes nothing. It is "unsafe" for browsing untrusted sites, and motlab
// only opens the user's own pages.
export const GPU_FLAGS = ['--enable-gpu', '--force_high_performance_gpu', '--enable-unsafe-swiftshader', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];

const live = new Set();
process.on('exit', () => { for (const c of live) c.killSync(); });

export async function launchChrome({ chromePath, extraArgs = [] }) {
  const profile = mkdtempSync(join(tmpdir(), 'motlab-chrome-'));
  const proc = spawn(chromePath, [
    '--headless=new', ...GPU_FLAGS,
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

  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'page error');
    return r.result.value;
  };
  return { send, evaluate, errors, onEmit: fn => emitHandlers.push(fn), navigate: url => send('Page.navigate', { url }) };
}
