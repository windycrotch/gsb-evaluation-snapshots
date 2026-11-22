/**
 * 房间生命周期与中继协议测试（Node + ws，直连真实 server.js，无需浏览器）
 * 运行：node tests/protocol.test.mjs
 *
 * 覆盖：
 *  1. 配对角色与双向中继
 *  2. 同一连接重复 join 幂等（不会新建第二个房间）
 *  3. 双方几乎同时操作（交叉 cmd）两端都恰好收到一次
 *  4. 任一方断开 → 存活方收到 peer-left，房间删除
 *  5. 房间删除后的迟到消息（input/state/cmd/pick）被拒绝（room-closed），不再转发
 *  6. 主动 leave 与 close 等价且幂等
 *  7. 第三个连接不会顶替已配对房间，而是另建新房
 *  8. 断线后重新 join 可建立全新会话
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TEST_PORT || 3199);
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws._inbox = [];
  ws._waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    ws._inbox.push(msg);
    ws._waiters.forEach(w => w(msg));
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function send(ws, obj) { ws.send(JSON.stringify(obj)); }
function waitFor(ws, pred, timeout = 2000) {
  const hit = ws._inbox.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('waitFor 超时: ' + timeout + 'ms')), timeout);
    const w = (msg) => {
      if (pred(msg)) { clearTimeout(t); ws._waiters = ws._waiters.filter(x => x !== w); resolve(msg); }
    };
    ws._waiters.push(w);
  });
}
const close = (ws) => new Promise((res) => { ws.on('close', res); ws.close(); });

const server = spawn(process.execPath, [path.join(ROOT, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('服务器启动超时')), 5000);
  server.stdout.on('data', (d) => { if (d.toString().includes('已启动')) { clearTimeout(t); res(); } });
});

try {
  // ---------- 1. 配对 + 中继 ----------
  {
    const host = await connect();
    send(host, { type: 'join' });
    const role = await waitFor(host, m => m.type === 'role');
    ok(role.role === 'host' && !!role.room, '主机创建房间并收到 role=host');

    const guest = await connect();
    send(guest, { type: 'join' });
    const gRole = await waitFor(guest, m => m.type === 'role');
    ok(gRole.role === 'guest' && gRole.room === role.room, '客机加入同一房间 role=guest');
    await Promise.all([
      waitFor(host, m => m.type === 'matched'),
      waitFor(guest, m => m.type === 'matched'),
    ]);
    ok(true, '双方都收到 matched');

    send(guest, { type: 'input', keys: { lp: true } });
    const inMsg = await waitFor(host, m => m.type === 'input');
    ok(inMsg.keys.lp === true, '客机 input 中继到主机');

    send(host, { type: 'state', data: { t: 12, f: [] } });
    const stMsg = await waitFor(guest, m => m.type === 'state');
    ok(stMsg.t === 12, '主机 state 快照中继到客机（兼容 data 包裹形态）');

    // 客户端实际使用的扁平形态 {type:'state', ...快照}
    send(host, { type: 'state', t: 33, round: 2, score: [1, 0], f: [{ x: 1 }], gen: 7 });
    const stFlat = await waitFor(guest, m => m.type === 'state' && m.t === 33);
    ok(stFlat.round === 2 && stFlat.gen === 7 && stFlat.f[0].x === 1,
      '扁平 state 形态正确中继（含 gen/round/score/f 全字段，旧客户端不会收到空快照）');

    send(host, { type: 'cmd', cmd: 'start', seq: 1, c1: 0, c2: 1 });
    const cmd = await waitFor(guest, m => m.type === 'cmd' && m.cmd === 'start');
    ok(cmd.seq === 1 && cmd.c1 === 0 && cmd.c2 === 1, 'cmd 透传全部字段（含 seq）');

    // ---------- 2. 重复 join 幂等 ----------
    const hostMatchedBefore = host._inbox.filter(m => m.type === 'matched').length;
    const guestMatchedBefore = guest._inbox.filter(m => m.type === 'matched').length;
    send(host, { type: 'join' });
    const again = await waitFor(host, m => m.type === 'role' && m !== role);
    ok(again.role === 'host' && again.room === role.room, '同一连接重复 join 返回原角色/原房间');
    await sleep(50);
    ok(host._inbox.filter(m => m.type === 'role').length === 2, '重复 join 不新建房间（仍只有原房间的 role 应答）');
    ok(guest._inbox.filter(m => m.type === 'matched').length === guestMatchedBefore, '重复 join 不打扰对手（客机无额外 matched）');
    ok(hostMatchedBefore === 1, '主机此前仅收到过一次 matched');

    // ---------- 3. 交叉 cmd：两条几乎同时到达，两端各收一次 ----------
    send(host, { type: 'cmd', cmd: 'rematch', seq: 2 });
    send(guest, { type: 'cmd', cmd: 'rematch-req' });
    await waitFor(host, m => m.type === 'cmd' && m.cmd === 'rematch-req');
    await waitFor(guest, m => m.type === 'cmd' && m.cmd === 'rematch' && m.seq === 2);
    await sleep(50);
    ok(guest._inbox.filter(m => m.type === 'cmd' && m.cmd === 'rematch').length === 1, '交叉命令：客机只收到一条 rematch');
    ok(host._inbox.filter(m => m.type === 'cmd' && m.cmd === 'rematch-req').length === 1, '交叉命令：主机只收到一条 rematch-req');

    // ---------- 5（前置）：第三个连接不顶替，另建新房 ----------
    const third = await connect();
    send(third, { type: 'join' });
    const tRole = await waitFor(third, m => m.type === 'role');
    ok(tRole.role === 'host' && tRole.room !== role.room, '第三个连接创建新房间而非顶替客机');
    await close(third);

    // ---------- 4. 客机断开 → 主机收到 peer-left ----------
    send(guest, { type: 'pick', char: 3 });   // 断开前最后一条有效消息
    await waitFor(host, m => m.type === 'pick');
    await close(guest);
    await waitFor(host, m => m.type === 'peer-left');
    ok(true, '客机断开后主机收到 peer-left');

    // ---------- 5. 迟到消息全部拒绝，不转发给任何人 ----------
    host._inbox.length = 0;
    send(host, { type: 'input', keys: { lp: true } });     // 主机发 input 本就无效
    send(host, { type: 'state', data: { t: 99 } });
    send(host, { type: 'cmd', cmd: 'rematch', seq: 3 });
    send(host, { type: 'pick', char: 1 });
    send(host, { type: 'ready', char: 1 });
    const err = await waitFor(host, m => m.type === 'error');
    ok(err.reason === 'room-closed', '房间删除后的迟到消息被拒绝（room-closed）');
    await sleep(80);
    ok(!host._inbox.some(m => ['input', 'state', 'cmd', 'pick', 'ready'].includes(m.type)),
      '失效房间不再产生任何对局转发消息');
    await close(host);

    // ---------- 6. 主动 leave：对端收到 peer-left，且重复 leave 幂等 ----------
    const a = await connect(), b = await connect();
    send(a, { type: 'join' }); await waitFor(a, m => m.type === 'role');
    send(b, { type: 'join' });
    await waitFor(a, m => m.type === 'matched');
    await waitFor(b, m => m.type === 'matched');
    send(a, { type: 'leave' });
    send(a, { type: 'leave' });   // 重复 leave 不应抛错
    await waitFor(b, m => m.type === 'peer-left');
    ok(true, '主动 leave 后对手收到 peer-left；重复 leave 幂等');
    // leave 后该连接的迟到 cmd 同样被拒
    send(a, { type: 'cmd', cmd: 'menu' });
    const err2 = await waitFor(a, m => m.type === 'error');
    ok(err2.reason === 'room-closed', 'leave 后的迟到 cmd 被拒绝');
    await close(a); await close(b);

    // ---------- 7. 主机断开 → 客机收到 peer-left，客机后续消息被拒 ----------
    const h = await connect(), g = await connect();
    send(h, { type: 'join' }); await waitFor(h, m => m.type === 'role');
    send(g, { type: 'join' });
    await Promise.all([waitFor(h, m => m.type === 'matched'), waitFor(g, m => m.type === 'matched')]);
    await close(h);
    await waitFor(g, m => m.type === 'peer-left');
    ok(true, '主机断开后客机收到 peer-left');
    send(g, { type: 'input', keys: { hp: true } });
    const err3 = await waitFor(g, m => m.type === 'error');
    ok(err3.reason === 'room-closed', '对手已离开后的上行 input 被拒绝（不再打空气）');
    await close(g);

    // ---------- 8. 断线后重新 join 是全新会话 ----------
    const x = await connect(), y = await connect();
    send(x, { type: 'join' });
    const rx = await waitFor(x, m => m.type === 'role');
    send(y, { type: 'join' });
    await Promise.all([waitFor(x, m => m.type === 'matched'), waitFor(y, m => m.type === 'matched')]);
    await close(y);
    await waitFor(x, m => m.type === 'peer-left');
    await close(x);
    const x2 = await connect(), y2 = await connect();
    send(x2, { type: 'join' });
    const rx2 = await waitFor(x2, m => m.type === 'role');
    send(y2, { type: 'join' });
    await Promise.all([waitFor(x2, m => m.type === 'matched'), waitFor(y2, m => m.type === 'matched')]);
    ok(rx2.room !== rx.room, '断线重连后分配的是全新房间');
    send(x2, { type: 'cmd', cmd: 'start', seq: 9, c1: 2, c2: 3 });
    const fresh = await waitFor(y2, m => m.type === 'cmd' && m.cmd === 'start');
    ok(fresh.seq === 9, '新会话命令正常中继（旧房间状态无残留）');
    await close(x2); await close(y2);
  }
} catch (e) {
  fail++;
  console.error('  \x1b[31m✗ 测试异常:\x1b[0m', e);
} finally {
  server.kill();
}

console.log(`\n${fail === 0 ? '\x1b[32m全部通过' : '\x1b[31m存在失败'}：${pass} 通过 / ${fail} 失败\x1b[0m`);
process.exit(fail ? 1 : 0);
