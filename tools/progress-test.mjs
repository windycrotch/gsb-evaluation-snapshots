/**
 * 收集进度生命周期回归测试（真实浏览器，CDP 驱动）
 *
 * 覆盖四种情形：
 *   1. 正常收集一颗星屑：HUD、星球能量网格亮度、星门状态同步更新
 *   2. 未集齐时走进星门：不换关
 *   3. 重试本关：进度 / HUD / 亮度 / 星门全部归零，关卡对象不叠加
 *   4. 跃迁到下一关：新关从零开始，上一关亮度不残留
 * 额外覆盖：掉入虚空重生只扣能量、不清空进度。
 *
 * 用法: node tools/progress-test.mjs [--headed] [--keep-shots]
 * 需要本机安装 Chrome（可用 CHROME_PATH 指定路径）。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.argv.includes('--headed');
const KEEP_SHOTS = process.argv.includes('--keep-shots');

const log = (line = '') => {
  try {
    writeSync(1, line + '\n');
  } catch {
    console.log(line);
  }
};
const logErr = (line = '') => {
  try {
    writeSync(2, line + '\n');
  } catch {
    console.error(line);
  }
};

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
  logErr('找不到 Chrome / Edge，可用 CHROME_PATH 环境变量指定可执行文件。');
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

/** 某些 Windows 环境下 Chrome 无法在含盘符的默认目录上启用 DevTools，
 *  因此统一把 LOCALAPPDATA / APPDATA 指向固化的临时目录 */
function launchChrome(port, tag = 'a') {
  const baseArgs = [
    '--headless=new',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu-sandbox',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1280,720',
    `--remote-debugging-port=${port}`,
  ];
  const userDataDir = path.join(os.tmpdir(), `stardust-progress-${process.pid}-${tag}`);
  const args = [...baseArgs, `--user-data-dir=${userDataDir}`, 'about:blank'];
  if (HEADED) args.splice(args.indexOf('--headless=new'), 1);

  const env = {
    ...process.env,
    LOCALAPPDATA: path.join(os.tmpdir(), 'stardust-progress-local'),
    APPDATA: path.join(os.tmpdir(), 'stardust-progress-roaming'),
  };

  let proc = spawn(CHROME, args, { stdio: 'ignore', env });
  return {
    proc,
    restart(tag2 = 'b') {
      try { proc.kill(); } catch {}
      proc = spawn(CHROME, [...baseArgs, `--user-data-dir=${path.join(os.tmpdir(), `stardust-progress-${process.pid}-${tag2}`)}`, 'about:blank'], { stdio: 'ignore', env });
      return proc;
    },
    kill() {
      try { proc.kill(); } catch {}
    },
  };
}

async function waitPort(port, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function findFreePort(start = 9400) {
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

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ' — ' + detail}`);
}

async function main() {
  const { server, port: httpPort } = await startStaticServer();
  const debugPort = await findFreePort();
  const browser = launchChrome(debugPort);

  let cdp;
  let ws;
  const errors = [];
  let shots = 0;
  const shotDir = path.join(ROOT, '.shots');

  const cleanup = async () => {
    try { ws?.close(); } catch {}
    browser.kill();
    await new Promise((r) => server.close(r));
  };

  try {
    let ready = await waitPort(debugPort, 120);
    if (!ready) {
      // 某些环境下首个 profile 目录不可用，换一个全新目录重试一次
      browser.kill();
      browser.restart('fallback');
      ready = await waitPort(debugPort, 120);
    }
    if (!ready) throw new Error('Chrome DevTools 端口未就绪');

    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可用的页面目标');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    cdp = new CDP(ws);
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

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result?.value;
    };
    const shot = async (name) => {
      if (!KEEP_SHOTS) return;
      await mkdir(shotDir, { recursive: true });
      const data = await evaluate(`document.getElementById('scene').toDataURL('image/png')`);
      await writeFile(path.join(shotDir, `${name}.png`), Buffer.from(String(data).split(',')[1], 'base64'));
      shots++;
    };

    // 等待 ?auto 启动完成
    for (let i = 0; i < 100; i++) {
      const mode = await evaluate(`window.__game && window.__game.mode`).catch(() => null);
      if (mode === 'playing') break;
      await sleep(150);
    }

    const state = async () =>
      JSON.parse(
        await evaluate(`(() => {
          const g = window.__game;
          const lv = g.level;
          const bar = document.getElementById('shardBar');
          return JSON.stringify({
            mode: g.mode,
            index: g.levelIndex,
            collected: lv.collected,
            total: lv.totalShards,
            hudNow: +document.getElementById('shardNow').textContent,
            hudTotal: +document.getElementById('shardTotal').textContent,
            barWidth: bar.style.width,
            barFull: bar.parentElement.classList.contains('full'),
            portalActive: lv.portal.active,
            portalUsed: lv.portalUsed,
            gridMin: Math.min(...lv.gridMats.map((x) => x.mat.opacity)),
            gridMax: Math.max(...lv.gridMats.map((x) => x.mat.opacity)),
            gridBase: lv.gridMats[0].base,
            gridCount: lv.gridMats.length,
            sceneGroups: g.stage.scene.children.filter((o) => o.type === 'Group').length,
            sceneChildren: g.stage.scene.children.length,
            health: g.player.health,
            levelDisposed: !!lv.disposed,
          });
        })()`)
      );

    const waitFor = async (predicate, timeout = 4000, poll = 80) => {
      const start = Date.now();
      let last;
      while (Date.now() - start < timeout) {
        last = await state();
        if (predicate(last)) return last;
        await sleep(poll);
      }
      return last;
    };

    const teleportToPortal = async (ms = 1400) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        await evaluate(`(() => {
          const g = window.__game;
          if (g.level && g.level.portal) g.player.position.copy(g.level.portal.pos);
        })()`);
        await sleep(60);
      }
    };

    const collectAll = async () => {
      await evaluate(`(() => {
        const lv = window.__game.level;
        for (const s of lv.shards) if (!s.taken) lv._collect(s);
        if (typeof lv.syncProgress === 'function') lv.syncProgress();
      })()`);
      await sleep(250);
    };

    // ---------------------------------------------------------------- 0. 初始
    // 记录本局第一关对象，后面验证跃迁后它确实被释放
    await evaluate(`(() => { window.__tags = [window.__game.level]; })()`);
    let s = await state();
    check('初始：HUD 与关卡收集数一致', s.hudNow === s.collected && s.hudTotal === s.total, JSON.stringify(s));
    check('初始：能量网格为基准亮度', Math.abs(s.gridMax - s.gridBase) < 1e-6, `${s.gridMax} vs ${s.gridBase}`);
    check('初始：星门未激活', !s.portalActive && !s.portalUsed);
    const baselineSceneGroups = s.sceneGroups;
    const baselineSceneChildren = s.sceneChildren;

    // ---------------------------------------------------------------- 1. 正常收集
    // 用真实吸附判定收集第一颗（把玩家放到星屑旁，让主循环自己检测）
    await evaluate(`(() => {
      const g = window.__game;
      const shard = g.level.shards.find((x) => !x.taken);
      window.__firstShard = shard;
      g.player.position.copy(shard.pos);
    })()`);
    s = await waitFor((x) => x.collected === 1, 3000);
    check('收集一颗：collected 增加', s.collected === 1, `collected=${s.collected}`);
    check('收集一颗：HUD 计数与进度条同步', s.hudNow === 1 && s.hudTotal === s.total, JSON.stringify(s));
    check(
      '收集一颗：进度条百分比正确',
      s.barWidth === ((100 / s.total).toFixed(2) === '100.00' ? '100%' : (100 / s.total).toFixed(2) + '%'),
      `${s.barWidth} (total=${s.total})`
    );
    check('收集一颗：能量网格变亮', s.gridMax > s.gridBase + 1e-4, `${s.gridMax} > ${s.gridBase}`);
    check('收集一颗：星门仍未激活', !s.portalActive);
    await shot('collect-one');

    // ---------------------------------------------------------------- 2. 未集齐进星门
    const beforePortal = await state();
    await teleportToPortal(1500);
    s = await state();
    check('未集齐进星门：不切换关卡', s.index === beforePortal.index && s.mode === 'playing', `index ${beforePortal.index}->${s.index}, mode=${s.mode}`);
    check('未集齐进星门：收集进度保留', s.collected === beforePortal.collected, `${beforePortal.collected}->${s.collected}`);
    check('未集齐进星门：星门保持未激活', !s.portalActive);
    await shot('portal-blocked');

    // ---------------------------------------------------------------- 3. 掉入虚空不清空进度
    const beforeFall = await state();
    await evaluate(`(() => {
      const g = window.__game;
      g.player.position.set(0, 120, 0);
      g.player.velocity.set(0, 0, 0);
      g.player.grounded = false;
      g.player.vRadial = 0;
    })()`);
    s = await waitFor((x) => x.health < beforeFall.health, 4000);
    check('掉入虚空：只扣能量', s.health === beforeFall.health - 1, `${beforeFall.health}->${s.health}`);
    check('掉入虚空：已收集进度不清空', s.collected === beforeFall.collected && s.hudNow === beforeFall.hudNow, JSON.stringify(s));
    check('掉入虚空：能量网格亮度保留', s.gridMax > s.gridBase + 1e-4, String(s.gridMax));
    check('掉入虚空：星门状态未变', s.portalActive === beforeFall.portalActive);

    // ---------------------------------------------------------------- 4. 重试本关
    await evaluate(`window.__game.level._collect(window.__game.level.shards.find((x) => !x.taken))`);
    await sleep(200);
    const beforeRetry = await state();
    check('重试前：确实有进度', beforeRetry.collected >= 2, String(beforeRetry.collected));
    const retryIndex = beforeRetry.index;
    await evaluate(`document.getElementById('retryBtn').click()`);
    s = await waitFor((x) => x.collected === 0 && x.mode === 'playing', 4000);
    check('重试：收集数归零', s.collected === 0, String(s.collected));
    check('重试：HUD 归零', s.hudNow === 0 && s.barWidth === '0%' && !s.barFull, JSON.stringify(s));
    check('重试：关卡总数保持', s.hudTotal === s.total, `${s.hudTotal}/${s.total}`);
    check('重试：能量网格回到基准亮度', Math.abs(s.gridMax - s.gridBase) < 1e-6, `${s.gridMax} vs ${s.gridBase}`);
    check('重试：星门未激活且未消耗', !s.portalActive && !s.portalUsed);
    check('重试：仍是同一关', s.index === retryIndex, `${retryIndex}->${s.index}`);
    check('重试：场景未叠加旧关卡', s.sceneGroups === baselineSceneGroups && s.sceneChildren === baselineSceneChildren, `groups ${baselineSceneGroups}->${s.sceneGroups}, children ${baselineSceneChildren}->${s.sceneChildren}`);
    await shot('retry');

    // ---------------------------------------------------------------- 5. 跃迁到下一关
    const warpTarget = s.index;
    await collectAll();
    s = await state();
    check('集齐：collected 达到 total', s.collected === s.total, `${s.collected}/${s.total}`);
    check('集齐：星门激活', s.portalActive);
    check('集齐：HUD 满进度', s.hudNow === s.total && s.barWidth === '100%' && s.barFull, JSON.stringify(s));
    check('集齐：能量网格最亮', s.gridMax > s.gridBase * 2, `${s.gridMax} vs ${s.gridBase}`);
    await shot('portal-open');

    await teleportToPortal(2600);
    s = await waitFor((x) => x.index === warpTarget + 1 && x.mode === 'playing', 8000);
    check('跃迁：进入下一关', s.index === warpTarget + 1, `${warpTarget} -> ${s.index}`);
    check('跃迁：新关收集数从零开始', s.collected === 0, String(s.collected));
    check('跃迁：HUD 显示新关 0/total', s.hudNow === 0 && s.hudTotal === s.total && s.barWidth === '0%', JSON.stringify(s));
    check('跃迁：新关网格为基准亮度（旧关亮度不残留）', Math.abs(s.gridMax - s.gridBase) < 1e-6, `${s.gridMax} vs ${s.gridBase}`);
    check('跃迁：新关星门未激活', !s.portalActive && !s.portalUsed);
    check('跃迁：场景未叠加旧关卡', s.sceneGroups === baselineSceneGroups && s.sceneChildren === baselineSceneChildren, `groups ${baselineSceneGroups}->${s.sceneGroups}, children ${baselineSceneChildren}->${s.sceneChildren}`);

    // 旧关卡对象不应再被更新或影响画面
    const stale = await evaluate(`(() => {
      const old = window.__tags && window.__tags[0];
      return JSON.stringify({
        hasOld: !!old,
        disposed: old ? !!old.disposed : null,
        shards: old ? old.shards.length : null,
        hasPortal: old ? !!old.portal : null,
        inScene: old ? window.__game.stage.scene.children.includes(old.root) : null,
      });
    })()`);
    const staleInfo = JSON.parse(stale);
    check(
      '跃迁：旧关卡已释放（网格/星屑/星门不再影响画面）',
      staleInfo.disposed === true && staleInfo.shards === 0 && staleInfo.hasPortal === false && staleInfo.inScene === false,
      stale
    );

    // 多次重建不累积
    await evaluate(`for (let i = 0; i < 10; i++) window.__game.buildLevel(window.__game.levelIndex)`);
    await sleep(500);
    s = await state();
    check('连续重建：场景对象数不增长', s.sceneGroups === baselineSceneGroups && s.sceneChildren === baselineSceneChildren, `groups=${s.sceneGroups}, children=${s.sceneChildren}`);
    check('连续重建：进度与星门复位', s.collected === 0 && !s.portalActive && s.hudNow === 0);

    // ---------------------------------------------------------------- 6. 单一真源
    // 直接改写 collected 后，一帧之内亮度、星门、HUD 都必须跟随，而不是各存一份
    await evaluate(`(() => { window.__game.level.collected = 3; })()`);
    await sleep(300); // 等主循环跑过至少一帧
    s = await state();
    check('单一真源：网格亮度跟随 collected', s.gridMax > s.gridBase + 1e-4, `${s.gridMax} vs ${s.gridBase}`);
    check('单一真源：HUD 跟随 collected', s.hudNow === 3, String(s.hudNow));
    check('单一真源：未收满时星门不激活', !s.portalActive);
    await evaluate(`(() => { window.__game.level.collected = window.__game.level.totalShards; })()`);
    await sleep(300);
    s = await state();
    check('单一真源：收满后星门自动激活', s.portalActive, `collected=${s.collected}/${s.total}`);
    check('单一真源：HUD 同步满进度', s.hudNow === s.total && s.barWidth === '100%' && s.barFull, JSON.stringify(s));
    // 回退 collected 应同步回退亮度与星门（不残留旧状态）
    await evaluate(`(() => { window.__game.level.collected = 1; })()`);
    await sleep(300);
    s = await state();
    check('单一真源：回退后星门重新关闭', !s.portalActive, `active=${s.portalActive}`);
    check('单一真源：回退后亮度随之下降', s.gridMax < s.gridBase * 1.6, `${s.gridMax} vs base ${s.gridBase}`);

    check('全程无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));

    const failed = results.filter((r) => !r.ok);
    log(`\n${results.length - failed.length}/${results.length} 项通过${shots ? `，截图 ${shots} 张` : ''}`);
    if (failed.length) {
      log('失败项：\n' + failed.map((f) => ` - ${f.name}${f.detail ? ' — ' + f.detail : ''}`).join('\n'));
      process.exitCode = 1;
    } else {
      log('收集进度生命周期验证全部通过。');
    }
  } catch (e) {
    logErr('测试执行出错：' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  } finally {
    await cleanup();
    await sleep(200);
    log('DONE');
  }
}

main()
  .catch((e) => {
    logErr('测试失败：' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  })
  .finally(() => {
    // 等 stdout 落盘后再退出，避免 Windows 管道截断输出
    process.exit(process.exitCode ?? 0);
  });
