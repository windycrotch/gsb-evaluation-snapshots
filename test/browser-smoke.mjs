/**
 * 双浏览器联机冒烟测试（可选，需要本机安装 Chrome）
 * 运行：node test/browser-smoke.mjs [chrome路径]
 *
 * 通过 CDP over pipe 打开两个页面（?lan=1&pick=N 自动配对+自动选人），验证：
 * - 两端都能进入对战，且对局代号（mid）/舞台一致
 * - 一方关闭页面后，另一方回到标题并显示「对手已离开」
 * - 主机不再保留连接，也没有未捕获 JS 错误
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGameServer } from '../server.js';

const CANDIDATES = [
  process.argv[2],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) {
  console.log('未找到 Chrome/Edge，跳过浏览器冒烟测试');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('✖', m); process.exitCode = 1; };
const ok = (m) => console.log('✔', m);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'niulai-e2e-'));
const app = createGameServer();
const port = await app.listen(0);

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-pipe',
  '--user-data-dir', profile,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio',
  // 两个标签页同时运行时，后台页会被浏览器节流（定时器/rAF 降频），
  // 导致自动选人计时器迟迟不触发。真实的双窗口/双机器场景不存在这个问题。
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--window-size=1280,800',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

// CDP over pipe：写入 fd3，读取 fd4，消息以 NUL 分隔
const toBrowser = chrome.stdio[3];
const fromBrowser = chrome.stdio[4];
let buf = '';
let nextId = 0;
const pending = new Map();
fromBrowser.setEncoding('utf8');
fromBrowser.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});

function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    toBrowser.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} 超时`));
    }, 15000);
  });
}

/** 打开一个页面并 attach 到它的 session */
async function openPage(url) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Page.enable', {}, sessionId);
  await cdp('Page.navigate', { url }, sessionId);
  return { targetId, sessionId };
}

async function evalJS(page, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
}

async function waitFor(page, expr, label, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evalJS(page, expr)) return; } catch { /* 页面尚未就绪 */ }
    await sleep(200);
  }
  const diag = await evalJS(page, `JSON.stringify({
    phase: window.__game && __game.phase, mode: window.__game && __game.mode,
    role: window.__game && __game.netRole, joined: window.__game && __game._netJoined,
    sel: window.__game && window.__game.selectDone, done: window.__game && window.__game.net && __game.net.isOpen(),
    status: (document.getElementById('net-status') || {}).textContent,
    errs: window.__errors,
  })`).catch((e) => '诊断失败: ' + e.message);
  throw new Error(`等待 ${label} 超时；页面状态 ${diag}`);
}

const base = `http://127.0.0.1:${port}`;
const guests = [];

try {
  await sleep(1500);
  const host = await openPage(`${base}/?lan=1&pick=0`);
  await sleep(400);
  const guest = await openPage(`${base}/?lan=1&pick=3`);
  guests.push(host, guest);

  await waitFor(host, `!!window.__game && __game.phase === 'fight'`, '主机进入对战');
  await waitFor(guest, `!!window.__game && __game.phase === 'fight'`, '客机进入对战');
  ok('两窗口完成自动配对并进入对战');

  const snap = (p) => evalJS(p, `({ round: __game.round, score: __game.score, mid: __game.netMatch.mid, stage: __game._stageId, phase: __game.phase })`);
  const hs = await snap(host);
  const gs = await snap(guest);
  if (hs.mid !== gs.mid || hs.stage !== gs.stage) fail(`两端对局不一致: host=${JSON.stringify(hs)} guest=${JSON.stringify(gs)}`);
  else ok(`两端对局代号/舞台一致: mid=${hs.mid} stage=${hs.stage}`);

  // 重赛一致性：客机发起 rematch，两端都应重置比分/回合并重开同一局（mid 递增）
  await evalJS(guest, `__game.net.send({ type: 'cmd', cmd: 'rematch', c1: 0, c2: 3, stage: __game._stageId }), true`);
  await waitFor(host, `__game.netMatch.mid === ${hs.mid + 1} && __game.phase === 'fight' && __game.round === 1 && __game.score[0] === 0`, '主机重赛生效');
  await waitFor(guest, `__game.netMatch.mid === ${hs.mid + 1} && __game.phase === 'fight' && __game.round === 1 && __game.score[0] === 0`, '客机重赛生效');
  const hr = await snap(host);
  const gr = await snap(guest);
  if (hr.mid !== gr.mid || hr.round !== gr.round || hr.stage !== gr.stage) fail(`重赛后两端不一致: host=${JSON.stringify(hr)} guest=${JSON.stringify(gr)}`);
  else ok(`重赛两端一致: mid=${hr.mid} round=${hr.round} score=${JSON.stringify(hr.score)}`);

  // 客机被关闭（模拟关掉页面）
  await cdp('Target.closeTarget', { targetId: guest.targetId }).catch(() => {});
  await waitFor(host, `__game.phase === 'title'`, '主机回到标题', 10000);
  ok('对手离开后主机回到标题');

  const announce = await evalJS(host, `document.getElementById('announce-text').textContent`);
  if (!announce.includes('对手已离开')) fail(`提示文本不正确: "${announce}"`);
  else ok('主机显示「对手已离开」');

  const state = await evalJS(host, `({ net: __game.net, isNet: __game._isNet, timer: __game.net ? null : 'freed' })`);
  if (state.net !== null || state.isNet !== false) fail(`主机未释放联机状态: ${JSON.stringify(state)}`);
  else ok('主机已停止快照循环并释放连接');

  const errors = await evalJS(host, `window.__errors || []`);
  if (errors.length) fail(`主机有未捕获错误: ${errors.join(' | ')}`);
  else ok('无未捕获 JS 错误');
} catch (e) {
  fail(e.message);
} finally {
  try { chrome.kill(); } catch { /* ignore */ }
  await app.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
