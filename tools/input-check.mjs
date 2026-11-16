// Headless check runner for the input-layer regression suite.
//
//   node tools/input-check.mjs
//
// Builds a throwaway dev bundle in the OS temp dir (so the shipped index.html is untouched),
// launches Chrome (or Edge) on it in __manual mode, waits for boot, then evaluates
// window.__inputTest() over the DevTools protocol and prints the per-check results.
// Exit code 1 if any check fails. Set CHROME=/path/to/chrome to pick a specific browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const exe = CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!exe) { console.error('No Chrome/Edge found; set CHROME=/path/to/chrome'); process.exit(1); }

const work = path.join(os.tmpdir(), `nova-input-${process.pid}`);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const page = path.join(work, 'nova-input-check.html');

// Build first, in this process, so a compile error surfaces here instead of inside the browser.
const build = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(root, 'tools', 'build.mjs'), '--dev', '--out', page], { cwd: root, stdio: 'inherit' });
  p.on('exit', (code) => resolve(code ?? 1));
});
if (build !== 0 || !fs.existsSync(page)) { console.error('dev build failed'); process.exit(1); }

const profile = path.join(work, 'profile');
const port = 9400 + (process.pid % 200);
const url = pathToFileURL(page).href + '?manual';
const args = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720',
  '--user-data-dir=' + profile, `--remote-debugging-port=${port}`, url,
];
const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 40000) stderr = stderr.slice(-20000); });

const deadline = Date.now() + 120000;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function pickTarget() {
  for (;;) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the DevTools endpoint\n' + stderr.slice(-2000));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await wait(250);
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
      onEvent(fn) { events = fn; },
      get pending() { return pending; },
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      } else if (events) events(msg);
    };
    ws.onerror = (e) => reject(new Error('websocket error: ' + (e.message || 'unknown')));
  });
  var events = null;
}

async function evaluate(cdp, expression, timeoutMs = 120000) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

let cdp;
let exitCode = 0;
try {
  cdp = await connect(await pickTarget());
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  const logs = [];
  cdp.onEvent((m) => {
    if (m.method === 'Log.entryAdded') logs.push(`[page:${m.params.entry.level}] ${m.params.entry.text}`);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ');
      logs.push(text);
      if (text.startsWith('[input-test]')) console.log(text);
    }
    if (m.method === 'Runtime.exceptionThrown') logs.push('[page:exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });

  const bootDeadline = Date.now() + 90000;
  for (;;) {
    if (Date.now() > bootDeadline) throw new Error('game did not finish booting\n' + logs.slice(-25).join('\n'));
    const ready = await evaluate(cdp, `typeof window.__inputTest === 'function' && typeof window.__step === 'function'`);
    if (ready) break;
    const err = await evaluate(cdp, `document.getElementById('loadmsg')?.textContent || ''`);
    if (/^ERROR/.test(err)) throw new Error('boot error: ' + err);
    await wait(400);
  }

  const out = await evaluate(cdp, `window.__inputTest()`, 180000);
  const failed = out.failed || [];
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed:`);
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? '  (' + f.detail + ')' : ''}`);
    exitCode = 1;
  } else {
    console.log(`\nAll ${out.results.length} input checks passed.`);
  }
} catch (e) {
  console.error(String(e && e.message || e));
  exitCode = 1;
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  await wait(300);
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(exitCode);
