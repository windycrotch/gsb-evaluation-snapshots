/**
 * 真实浏览器双窗口联机 E2E（Chrome headless + CDP，跑完整游戏客户端与真实 server.js）
 * 运行：node tests/e2e.test.mjs
 *
 * 场景：
 *  A. 双窗口自动配对/自动选人 → 主机开局，两端角色/回合/比分/快照代号一致
 *  B. 客机中途掉线：主机回标题并提示、收发循环停止；主机关闭后客机重连是全新会话
 *  C. 重赛幂等：结算后注入重复/交叉 rematch，两端各只重开一次，比分清零、代号递增
 *  D. 客机不得自行开局：客机单独进入联机面板后保持在选人/等待态
 *  E. 全部页面无未捕获运行时错误
 *  F. 本地双人 / 人机流程回归（选人、计时、结算、本地重赛，均不创建网络会话）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chrome } from './cdp-driver.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TEST_PORT || 3211);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(ROOT, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('服务器启动超时')), 5000);
  server.stdout.on('data', (d) => { if (d.toString().includes('已启动')) { clearTimeout(t); res(); } });
});

const chrome = await Chrome.launch();
await chrome.ready();

// 页面侧探针
const PROBE = `(() => {
  const g = window.__game;
  if (!g) return null;
  return {
    phase: g.phase, mode: g.mode, role: g.netRole, hasNet: !!g.net,
    alive: g.net ? g.net.alive : false, gen: g._matchGen, round: g.round,
    score: g.score, picks: g.picks, tx: g.net ? (g.net.txCount || 0) : 0,
    stateTx: g.net ? (g.net.stateTx || 0) : 0,
    resultShown: !document.getElementById('screen-result').classList.contains('hidden'),
    announce: document.getElementById('announce-text').textContent,
    errors: window.__errors || [],
  };
})`;

async function probe(page) { return page.eval(`(${PROBE})()`); }
async function waitPhase(page, phase, timeout = 15000) {
  return page.waitUntil(`() => { const p = (${PROBE})(); return p && p.phase === '${phase}'; }`,
    { timeout, label: 'phase=' + phase });
}

try {
  // ================= A. 配对 → 开局 → 双端一致 =================
  console.log('\n[A] 双窗口配对与开局一致性');
  const host = await chrome.newPage(`${BASE}/?lan=1&pick=0&rt=8`);
  await sleep(400);
  const guest = await chrome.newPage(`${BASE}/?lan=1&pick=2&auto=1&rt=8`);

  await waitPhase(host, 'fight');
  await waitPhase(guest, 'fight');
  ok(true, '双方都进入对战（客机由主机 start 广播带入）');

  await sleep(1200);   // 等若干个 30Hz 快照
  const hp = await probe(host), gp = await probe(guest);
  ok(hp.role === 'host' && gp.role === 'guest', '角色分配：host/guest 正确');
  ok(hp.gen === gp.gen && hp.gen >= 1, `两端同一对局代号 gen=${hp.gen}`);
  ok(hp.round === gp.round && hp.round === 1, `两端同一回合 round=${hp.round}`);
  ok(JSON.stringify(hp.score) === JSON.stringify(gp.score) && JSON.stringify(hp.score) === '[0,0]',
    `两端同一比分 ${JSON.stringify(hp.score)}`);
  ok(hp.picks.join(',') === gp.picks.join(',') && hp.picks[0] === 0 && hp.picks[1] === 2,
    `两端角色一致 picks=[${hp.picks}]（主机 0 / 客机 2）`);
  ok(hp.stateTx > 5, `主机持续广播快照（stateTx=${hp.stateTx}）`);
  ok(gp.tx > 5, `客机持续上行输入（tx=${gp.tx}）`);
  const gSnap = await guest.eval('window.__game._netLatest');
  ok(!!gSnap && gSnap.gen === gp.gen && Array.isArray(gSnap.f) && gSnap.f.length === 2, '客机收到含双斗士与 gen 的权威快照');

  // ================= B. 断线生命周期 =================
  console.log('\n[B] 断线：回标题、停收发、可全新重连');
  // B1 客机直接关闭标签（模拟掉线）
  await guest.close();
  await host.waitUntil(`() => { const p = (${PROBE})(); return p && p.phase === 'title' && !p.hasNet; }`,
    { timeout: 8000, label: '主机回标题且会话拆除' });
  const hp2 = await probe(host);
  ok(hp2.phase === 'title' && !hp2.hasNet && hp2.mode === 'local', '客机掉线后主机回到标题、联机状态全部复位');
  // 主机的状态循环必须已停：连续采样 tx 不再增长
  const tx1 = hp2.stateTx;
  await sleep(700);
  const hp2b = await probe(host);
  ok(hp2b.stateTx === tx1, `主机下行循环已停止（stateTx 保持 ${tx1} 不再增长，不再打空气）`);
  // 可见提示
  const hostAnnounce = await host.eval(`document.getElementById('announce-text').textContent`);
  ok(hostAnnounce.includes('对手已离开'), `主机可见提示："${hostAnnounce}"`);

  // B2 主机掉线后，客机（新窗口）重连 → 全新房间/全新会话
  const guest2 = await chrome.newPage(`${BASE}/?lan=1&pick=1&auto=1&rt=8`);
  await guest2.waitUntil(`() => { const p = (${PROBE})(); return p && p.role === 'host'; }`,
    { timeout: 10000, label: '新连接成为新房主机' });
  const g2 = await probe(guest2);
  ok(g2.phase === 'title' && g2.role === 'host' && g2.hasNet, '旧房间删除后重新进入联机面板建立了全新会话');

  // ================= D. 客机不得自行开局（单机停留） =================
  console.log('\n[D] 未收到主机开局前客机不得自行进入对战');
  await sleep(1500);
  const g2b = await probe(guest2);
  ok(g2b.phase !== 'fight' && g2b.gen === 0, `客机独处时不自行开局（phase=${g2b.phase}, gen=0）`);

  // 主机也开一个新窗口完成配对（同样自动驾驶，保证对局能打到 KO 结算），供 C 阶段重赛使用
  const host2 = await chrome.newPage(`${BASE}/?lan=1&pick=3&auto=1&rt=8`);
  await waitPhase(host2, 'fight');
  await waitPhase(guest2, 'fight');
  ok(true, '重连后的新会话可正常配对开局');
  await sleep(800);
  const h3 = await probe(host2), g3 = await probe(guest2);
  ok(h3.gen === g3.gen && h3.picks.join(',') === g3.picks.join(','), '新会话两端对局代号与角色一致');

  // ================= C. 重赛幂等 =================
  console.log('\n[C] 重赛幂等：重复/交叉命令只生效一次');
  // 真实主机角色由服务端分配（先开房者为 host），按运行时角色取页面，不依赖变量名
  const roleA = await probe(host2), roleB = await probe(guest2);
  const hPage = roleA.role === 'host' ? host2 : guest2;
  const gPage = hPage === host2 ? guest2 : host2;
  ok(roleA.role && roleB.role && roleA.role !== roleB.role, `第二组角色分配互补：${roleA.role} / ${roleB.role}`);

  // 加速到结算：rt=8，两回合最多 ~20s；等待双方 result
  await hPage.waitUntil(`() => { const p = (${PROBE})(); return p && p.phase === 'result'; }`,
    { timeout: 40000, label: '主机到达结算页' });
  await gPage.waitUntil(`() => { const p = (${PROBE})(); return p && p.phase === 'result'; }`,
    { timeout: 15000, label: '客机到达结算页' });
  const hr = await probe(hPage), gr = await probe(gPage);
  ok(hr.resultShown && gr.resultShown, '两端都显示结算页');
  ok(hr.gen === gr.gen && JSON.stringify(hr.score) === JSON.stringify(gr.score),
    `结算时代号/比分一致 gen=${hr.gen} score=${JSON.stringify(hr.score)}`);
  const genBefore = hr.gen;

  // 取主机即将使用的序列号：所有注入重放都复用同一 seq，模拟双击 + 网络重复投递 + 双方交叉
  const seqNext = await hPage.eval('window.__game._netSeq + 1');
  await hPage.eval(`(() => {
    const g = window.__game;
    g._beginRematch();                                   // 第一次：真正生效
    g._beginRematch();                                   // 双击第二次：phase 已变，直接返回
    g._netHandlers().onStart({ cmd: 'rematch', seq: ${seqNext} });   // 同 seq 重放 ×2：去重丢弃
    g._netHandlers().onStart({ cmd: 'rematch', seq: ${seqNext} });
  })()`);
  await gPage.eval(`(() => {
    const g = window.__game;
    // 同 seq rematch 重放 ×2（与真实网络广播互为重复），再夹一条客机无权处理的 rematch-req
    g._netHandlers().onStart({ cmd: 'rematch', seq: ${seqNext} });
    g._netHandlers().onStart({ cmd: 'rematch', seq: ${seqNext} });
    g._netHandlers().onStart({ cmd: 'rematch-req' });
  })()`);

  await sleep(1500);
  const h4 = await probe(hPage), g4 = await probe(gPage);
  ok(h4.phase === 'fight' && g4.phase === 'fight', '重复/交叉命令后两端都进入新对局');
  ok(h4.gen === g4.gen && h4.gen === genBefore + 1, `两端各只重开一次：gen ${genBefore} → ${h4.gen}`);
  ok(JSON.stringify(h4.score) === '[0,0]' && JSON.stringify(g4.score) === '[0,0]', '重赛后两端比分清零');
  ok(h4.round === 1 && g4.round === 1, '重赛后两端回到第 1 回合');
  ok(h4.picks.join(',') === g4.picks.join(','), '重赛沿用相同角色');

  // 再等快照，确认新对局数据通道恢复且旧快照被 gen 隔离
  await sleep(1000);
  const g5 = await probe(gPage);
  const latest = await gPage.eval('window.__game._netLatest');
  ok(!!latest && latest.gen === g5.gen, '客机只接受新对局快照（旧 gen 迟到快照被丢弃）');

  // ================= F. 本地双人 / 人机回归（联机改动不得影响既有流程） =================
  console.log('\n[F] 本地双人 / 人机回归');
  // F1 本地双人：分别驱动 P1/P2 两套真实键位的 held 差分，验证完整本地选人流程
  const localP = await chrome.newPage(`${BASE}/?select=1&rt=6`);
  await localP.waitUntil(`() => { const p = (${PROBE})(); return p && p.phase === 'select'; }`,
    { timeout: 15000, label: '本地双人选人页' });
  // P1 在光标 0 确认；P2 默认光标 1，确认后 0.8s 自动开局
  await localP.eval(`new Promise(res => {
    const g = window.__game;
    g.input.held.p1.lp = true;
    setTimeout(() => { g.input.held.p1.lp = false; res(); }, 140);
  })`);
  await localP.waitUntil('() => window.__game.selectDone[0] === true', { timeout: 8000, label: 'P1 确认' });
  await localP.eval(`new Promise(res => {
    const g = window.__game;
    g.input.held.p2.lp = true;
    setTimeout(() => { g.input.held.p2.lp = false; res(); }, 140);
  })`);
  await localP.waitUntil(`() => { const p = (${PROBE})(); return p && p.phase === 'fight'; }`,
    { timeout: 20000, label: '本地双人进入对战' });
  const lp = await probe(localP);
  ok(lp.mode === 'local' && !lp.hasNet, '本地双人模式不创建任何网络会话');
  ok(lp.gen === 1 && lp.round === 1 && JSON.stringify(lp.score) === '[0,0]', '本地双人对局正常初始化');

  // F2 人机：直达对战并跑到结算，再走本地“再来一局”路径
  const aiP = await chrome.newPage(`${BASE}/?fight=xiaoniu,jinbao&mode=ai&rt=5`);
  await aiP.waitUntil(`() => { const p = (${PROBE})(); return p && p.phase === 'fight'; }`,
    { timeout: 15000, label: '人机进入对战' });
  const t1 = await aiP.eval('window.__game.timer');
  await sleep(1500);
  const t2 = await aiP.eval('window.__game.timer');
  ok(t2 < t1, `人机对战计时正常推进（${t1} → ${Math.round(t2)}）`);
  ok(!(await probe(aiP)).hasNet, '人机模式不创建任何网络会话');
  // 驱动 P1 真实键位持续逼近+出拳，避免双方消极导致 TIME UP 平局无限循环
  await aiP.eval(`(() => {
    const g = window.__game;
    g.__testDrive = setInterval(() => {
      if (g.phase !== 'fight') return;
      g.input.held.p1.right = true;
      g.input.held.p1.lp = !g.input.held.p1.lp;   // 周期性按下/松开形成出拳沿
    }, 450);
  })()`);
  await aiP.waitUntil(`() => { const p = (${PROBE})(); return p && p.phase === 'result'; }`,
    { timeout: 60000, label: '人机到达结算页' });
  const aiResult = await probe(aiP);
  const aiGen = aiResult.gen;
  await aiP.eval(`document.getElementById('btn-rematch').click()`);
  await aiP.waitUntil(`() => { const p = (${PROBE})(); return p && p.phase === 'fight'; }`,
    { timeout: 10000, label: '本地重赛进入新对局' });
  await aiP.eval(`clearInterval(window.__game.__testDrive)`);
  const ai2 = await probe(aiP);
  ok(ai2.gen === aiGen + 1 && JSON.stringify(ai2.score) === '[0,0]' && ai2.round === 1,
    `本地“再来一局”正常（gen ${aiGen} → ${ai2.gen}，比分清零）`);
  ok(!ai2.hasNet, '本地重赛仍无网络会话（联机序列号逻辑不介入本地路径）');

  // ================= 无页面报错 =================
  console.log('\n[E] 页面运行时错误检查');
  for (const [name, page] of [['主机(第二组)', hPage], ['客机(第二组)', gPage], ['主机(第一组)', host], ['本地双人', localP], ['人机', aiP]]) {
    const errs = await page.eval('window.__errors || []').catch(() => []);
    ok(!errs.length, `${name} 无未捕获错误${errs.length ? '：' + errs.join(' | ') : ''}`);
  }

  await hPage.close(); await gPage.close(); await host.close();
  await localP.close(); await aiP.close();
} catch (e) {
  fail++;
  console.error('  \x1b[31m✗ E2E 异常:\x1b[0m', e);
} finally {
  await chrome.close();
  server.kill();
}

console.log(`\n${fail === 0 ? '\x1b[32m全部通过' : '\x1b[31m存在失败'}：${pass} 通过 / ${fail} 失败\x1b[0m`);
process.exit(fail ? 1 : 0);
