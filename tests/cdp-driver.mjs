/**
 * 极简 Chrome DevTools Protocol 驱动（零第三方依赖，复用仓库已安装的 ws）
 * 用本机 Chrome 的 --headless=new + SwiftShader 跑真实页面，无需 puppeteer/playwright。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

export class Chrome {
  static launch(extraArgs = []) {
    const bin = CHROME_CANDIDATES.find(p => fs.existsSync(p));
    if (!bin) throw new Error('未找到 Chrome/Edge，可设置 CHROME_BIN 环境变量');
    const port = 9200 + Math.floor(Math.random() * 500);
    // 注意：Chrome 对正斜杠 user-data-dir 会误判为“默认目录”而拒绝远程调试，必须用原生反斜杠路径
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'niulai-cdp-'));
    const args = [
      '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
      '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      // 多标签时防止后台标签冻结 rAF/定时器（双窗口测试的关键，否则首个标签会被浏览器挂起）
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion,BackForwardCache',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`,
      '--window-size=1280,800', '--disable-extensions', '--mute-audio',
      ...extraArgs,
    ];
    const proc = spawn(bin, args, { stdio: 'ignore', detached: false });
    proc.on('error', () => {});
    return new Chrome(proc, port, userDir);
  }

  constructor(proc, port, userDir) { this.proc = proc; this.port = port; this.userDir = userDir; }

  async _http(pathname, method = 'GET') {
    const res = await fetch(`http://127.0.0.1:${this.port}${pathname}`, { method });
    if (!res.ok) throw new Error(`CDP HTTP ${res.status} ${method} ${pathname}`);
    return res.json();
  }

  async ready(timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try { await this._http('/json/version'); return; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    throw new Error('Chrome 远程调试端口未就绪');
  }

  /** 新建标签页（直接带 URL，避免二次导航的竞态）并返回 Page 客户端 */
  async newPage(url = 'about:blank') {
    let target;
    try {
      target = await this._http(`/json/new?${encodeURIComponent(url)}`, 'PUT');   // 新版 Chrome 要求 PUT
    } catch {
      target = await this._http(`/json/new?${encodeURIComponent(url)}`);          // 旧版回退 GET
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const page = new CDPPage(ws, target.id, this);   // 构造时即挂消息监听，保证任何 send 的响应都有人接
    page.console = [];
    ws.on('message', (raw) => page._onRaw(raw));
    ws.on('close', (code) => { page._closedCode = code; page._failAll(new Error('CDP WebSocket 已关闭 code=' + code)); });
    ws.on('error', (e) => page._failAll(e));
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    // 强制页面保持 active 生命周期与焦点，避免多标签场景下被节流/冻结
    await page.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    if (url !== 'about:blank') await page.waitForLoad();
    return page;
  }

  async close() {
    // Windows 上用 taskkill /T 连整个浏览器进程树一起结束，避免句柄竞态
    try { execFileSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { try { this.proc.kill(); } catch { /* ignore */ } }
    try { fs.rmSync(this.userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

class CDPPage {
  constructor(ws, targetId, chrome) {
    this.ws = ws; this.targetId = targetId; this.chrome = chrome;
    this._pending = new Map(); this._id = 0;
  }

  _onRaw(raw) {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Log.entryAdded') {
      const text = m.params.entry?.text || m.params.args?.map(a => a.value ?? a.description).join(' ');
      if (text) this.console.push(text);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      this.console.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    if (m.id && this._pending.has(m.id)) {
      const { resolve, reject, timer } = this._pending.get(m.id);
      clearTimeout(timer);
      this._pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
    }
  }

  send(method, params = {}) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      // 30s：headless + SwiftShader 下模型/着色器编译会短暂占满主线程，CDP 应答可能被推迟
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP 调用超时: ${method}（target=${this.targetId.slice(0, 6)} close=${this._closedCode ?? 'n/a'}）`));
      }, 30000);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  _failAll(err) {
    for (const { reject, timer } of this._pending.values()) { clearTimeout(timer); reject(err); }
    this._pending.clear();
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.waitForLoad();
  }

  async waitForLoad(timeout = 15000) {
    await this.waitUntil('() => document.readyState === "complete" && !!window.__game', { timeout, label: 'page load' });
    // 导航后重新激活：防止该标签在多窗口测试中被浏览器后台冻结
    await this.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  }

  /** 求值并返回 JS 值；awaitPromise=true 时等待 Promise */
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise, timeout: 25000,
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async waitUntil(fnExpr, { timeout = 15000, interval = 250, label } = {}) {
    const deadline = Date.now() + timeout;
    let lastErr = '';
    while (Date.now() < deadline) {
      const v = await this.eval(`(${fnExpr})()`).catch(e => { lastErr = String(e); return false; });
      if (v) return v;
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`等待超时${label ? '：' + label : ''}${lastErr ? '（' + lastErr + '）' : ''}`);
  }

  async close() {
    try { this.ws.close(); } catch { /* ignore */ }
    const u = `http://127.0.0.1:${this.chrome.port}/json/close/${this.targetId}`;
    await fetch(u, { method: 'PUT' }).catch(() => fetch(u).catch(() => {}));
  }
}
