// Minimal Chrome DevTools Protocol client for headless regression tests.
// Uses only Node's built-in fetch + WebSocket — no puppeteer/playwright dependency.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  throw new Error('No Chrome/Edge binary found; set CHROME_BIN to the executable path.');
}

// Chrome 157+ refuses --remote-debugging-port when the profile lives under a workspace/temp root
// that it considers non-default, so default to a per-process directory under the real user profile.
function profileRoot() {
  return process.env.CHROME_PROFILE_ROOT || os.tmpdir() || 'C:/Users/Public';
}

export class Browser {
  constructor(headless = true) { this.headless = headless; this.pages = []; }
  async launch(extraArgs = []) {
    const chrome = findChrome();
    this.profile = fs.mkdtempSync(path.join(profileRoot(), 'nova-test-'));
    this.port = await freePort();
    const args = [
      this.headless ? '--headless=new' : '--headless',
      '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      `--user-data-dir=${this.profile}`,
      `--remote-debugging-port=${this.port}`,
      '--window-size=1280,800',
      ...extraArgs, 'about:blank',
    ];
    this.proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', () => {});   // keep the pipe drained
    this.proc.on('exit', () => { this.closed = true; });
    let ver = null;
    for (let i = 0; i < 200; i++) {
      try { ver = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json(); if (ver?.webSocketDebuggerUrl) break; }
      catch { /* not ready */ }
      ver = null;
      await sleep(100);
    }
    if (!ver) throw new Error('Chrome did not open a debugging port.');
    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = (this.nextId = (this.nextId || 0) + 1);
    if (!this.pending) this.pending = new Map();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
    const target = list.find((t) => t.id === targetId);
    if (!target?.webSocketDebuggerUrl) throw new Error('No debugger URL for new page target.');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const page = new Page(ws);
    this.pages.push(page);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && page.pending.has(msg.id)) {
        const { resolve, reject } = page.pending.get(msg.id);
        page.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown') {
        this.onConsole?.(msg);
      }
    };
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    if (url && url !== 'about:blank') await page.navigate(url);
    return page;
  }
  async close() {
    for (const p of this.pages) { try { p.ws.close(); } catch { /* gone */ } }
    try { this.ws?.close(); } catch { /* gone */ }
    try { this.proc.kill(); } catch { /* gone */ }
    if (this.profile) for (let i = 0; i < 6; i++) { try { fs.rmSync(this.profile, { recursive: true, force: true }); break; } catch { await sleep(150); } }
  }
}

export class Page {
  constructor(ws) { this.ws = ws; this.pending = new Map(); this.nextId = 1; }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
      throw new Error('Page exception: ' + e);
    }
    return r.result?.value;
  }
  async waitFor(expr, { timeout = 20000, label = expr } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await this.eval(`(async () => { try { return !!( ${expr} ); } catch (e) { return false; } })()`);
      if (v) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  }
  navigate(url) { return this.send('Page.navigate', { url }); }
}

async function freePort() {
  const srv = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => res(s)); });
  const p = srv.address().port;
  await new Promise((r) => srv.close(r));
  return p;
}
