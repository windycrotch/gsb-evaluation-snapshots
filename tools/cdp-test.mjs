/**
 * CDP 冒烟测试：真实时间驱动游戏，验证物理 / 相机 / 计时 / 收集逻辑
 * 用法: node tools/cdp-test.mjs [--hold=W,D] [--shots=4]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const URL_TO_OPEN = 'http://127.0.0.1:8123/?auto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return true;
    } catch {}
    await sleep(300);
  }
  throw new Error('chrome devtools port not ready');
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
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1280,720',
    '--user-data-dir=' + path.join(process.env.TEMP || '/tmp', 'cdp-game-test'),
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitPort();
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
    await cdp.send('Page.navigate', { url: URL_TO_OPEN });
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
    chrome.kill();
    await sleep(300);
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
