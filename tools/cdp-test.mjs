/**
 * CDP 冒烟测试：真实时间驱动游戏，验证物理 / 相机 / 计时 / 收集逻辑
 * 用法: node tools/cdp-test.mjs [--hold=W,D] [--shots=4]
 * 自带静态服务器，无需手动启动 python -m http.server。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome / Edge，可用 CHROME_PATH 环境变量指定可执行文件。');
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let rel = decodeURIComponent(url.pathname);
        if (rel === '/' || rel === '') rel = '/index.html';
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT)) {
          res.writeHead(403).end();
          return;
        }
        const data = await readFile(file);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function findFreePort(start = 9500) {
  for (let p = start; p < start + 80; p++) {
    const free = await new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error('no free port');
}

async function waitPort(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.handlers.forEach((h) => h(msg));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) {
    this.handlers.push(fn);
  }
}

const keyDef = (key) => {
  const map = {
    KeyW: { code: 'KeyW', key: 'w', keyCode: 87 },
    KeyA: { code: 'KeyA', key: 'a', keyCode: 65 },
    KeyS: { code: 'KeyS', key: 's', keyCode: 83 },
    KeyD: { code: 'KeyD', key: 'd', keyCode: 68 },
    Space: { code: 'Space', key: ' ', keyCode: 32 },
    ShiftLeft: { code: 'ShiftLeft', key: 'Shift', keyCode: 16 },
  };
  return map[key];
};

async function main() {
  mkdirSync(path.join(ROOT, ".shots"), { recursive: true });
  const { server: httpServer, port: httpPort } = await startStaticServer();
  const PORT = await findFreePort();
  const userDataDir = path.join(os.tmpdir(), `cdp-game-test-${process.pid}`);
  const chromeEnv = {
    ...process.env,
    LOCALAPPDATA: path.join(os.tmpdir(), 'cdp-game-test-local'),
    APPDATA: path.join(os.tmpdir(), 'cdp-game-test-roaming'),
  };
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1280,720',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore', env: chromeEnv });

  const finish = async (code) => {
    chrome.kill();
    await new Promise((r) => httpServer.close(r));
    await sleep(300);
    process.exit(code);
  };

  try {
    await waitPort(PORT);
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r);
      ws.addEventListener('error', j);
    });
    const cdp = new CDP(ws);
    const errors = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(d.exception?.description || d.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
      }
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/?auto` });
    await sleep(3000);

    const evaluate = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      return r.result?.value;
    };

    // 标题页状态
    let state = await evaluate(
      `JSON.stringify({mode: window.__game?.mode, hasLevel: !!window.__game?.level, shards: window.__game?.level?.totalShards})`
    );
    console.log('TITLE:', state);

    // 开始游戏
    await evaluate(`window.__game.startGame()`);
    await sleep(800);

    // 按住 W+D 行走
    for (const k of ['KeyW', 'KeyD']) {
      const d = keyDef(k);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...d });
    }
    await sleep(1500);

    const readState = () =>
      evaluate(
        `JSON.stringify({
          mode: window.__game.mode,
          t: document.getElementById('timer').textContent,
          shards: window.__game.level.collected + '/' + window.__game.level.totalShards,
          pos: window.__game.player.position.toArray().map(v=>+v.toFixed(1)),
          health: window.__game.player.health
        })`
      );

    const shot = async (name) => {
      const r = await evaluate(`document.getElementById('scene').toDataURL('image/png')`);
      const p = path.join(ROOT, '.shots', name + '.png');
      writeFileSync(p, Buffer.from(String(r).split(',')[1], 'base64'));
      console.log('SHOT:', name);
    };

    console.log('T+1.5s:', await readState());
    await shot('walk1');

    // 跳跃
    const sp = keyDef('Space');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...sp });
    await sleep(120);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...sp });
    await sleep(600);
    console.log('JUMP:', await readState());
    await shot('jump');

    // 继续走 6 秒（模拟长跑，看是否掉出世界 / 相机是否稳定）
    await sleep(6000);
    console.log('T+8s:', await readState());
    await shot('walk2');

    console.log(
      'DIAG:',
      await evaluate(
        `JSON.stringify({resizes: window.__resizes||[], fps: window.__fps||[], dpr: window.__game.stage.dpr, bloom: window.__game.stage.bloomPass.enabled, qualityDpr: window.devicePixelRatio})`
      )
    );

    // 转向：松开 W，按 S
    for (const k of ['KeyW', 'KeyD']) {
      const d = keyDef(k);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...d });
    }
    const d2 = keyDef('KeyS');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...d2 });
    await sleep(2500);
    console.log('T+11s:', await readState());
    await shot('walk3');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...d2 });

    // 收集测试：直接触发一颗星屑的收集逻辑
    await evaluate(`window.__game.level._collect(window.__game.level.shards.find(s=>!s.taken))`);
    await sleep(600);
    console.log('COLLECT:', await readState());

    // 传送测试：直接调 portal 完成逻辑（验证跃迁流程不崩）
    const warp = await evaluate(`(async () => {
      const g = window.__game;
      g.level.collected = g.level.totalShards;
      g.level.setPortalActive(true);
      return 'portal-forced';
    })()`);
    console.log('WARP:', warp);
    // 模拟走进星门
    await evaluate(`window.__game.player.position.copy(window.__game.level.portal.pos)`);
    await sleep(400);
    await evaluate(`window.__game.level.update(0.016, 1, window.__game.player)`);
    await sleep(3500);
    console.log('AFTER WARP:', await readState());
    await shot('warp');

    // 通关流程测试：跳到第 5 星域并触发星门 → 胜利结算
    await evaluate(`window.__game.buildLevel(4); window.__game.levelIndex = 4;`);
    await sleep(1200);
    console.log('LEVEL5:', await readState());
    await shot('level5');
    await evaluate(`(async () => {
      const g = window.__game;
      g.level.collected = g.level.totalShards;
      g.level.setPortalActive(true);
      g.player.position.copy(g.level.portal.pos);
    })()`);
    await sleep(4500);
    console.log(
      'PORTAL DIAG:',
      await evaluate(
        `JSON.stringify({active: window.__game.level.portal.active, used: window.__game.level.portalUsed, dist: +window.__game.player.position.distanceTo(window.__game.level.portal.pos).toFixed(2), alive: window.__game.player.alive, mode: window.__game.mode})`
      )
    );
    console.log(
      'VICTORY:',
      await evaluate(
        `JSON.stringify({mode: window.__game.mode, winVisible: document.getElementById('win').classList.contains('visible'), time: document.getElementById('winTime').textContent, shards: document.getElementById('winShards').textContent, fadeOpacity: getComputedStyle(document.getElementById('fade')).opacity, flashOpacity: getComputedStyle(document.getElementById('flash')).opacity, cardRect: document.querySelector('#win .card').getBoundingClientRect().toJSON()})`
      )
    );
    await sleep(1800);
    await shot('victory');

    console.log('JS ERRORS:', errors.length ? errors.slice(0, 5) : 'none');
  } finally {
    await finish(0);
  }
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
