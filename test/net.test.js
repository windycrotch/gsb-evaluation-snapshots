/**
 * 局域网房间与对局命令的自动化测试
 * 运行：npm test   （等价于 node --test test/）
 *
 * 覆盖：
 * 1. 正常配对（role / matched / 中继）
 * 2. 一方离开：留下的一方收到 peer-left，房间被清理，后续 join 可重新配对
 * 3. 重复 join：同一连接不会产生第二个房间
 * 4. 重赛/返回菜单：命令回声给双方且携带同一 mid，两端据此得到一致结果
 * 5. NetMatchState：两端命令解释一致，过期快照被丢弃
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGameServer } from '../server.js';
import { NetMatchState } from '../src/net-state.js';

const OPEN = 1;

/** 启动一个监听随机端口的服务器 */
async function startServer() {
  const app = createGameServer();
  const port = await app.listen(0);
  return { app, port };
}

/** 测试用 WebSocket 客户端：消息队列 + 按条件等待 */
function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const queue = [];
  const waiters = [];
  let closed = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    // 先满足等待者（消息不入队，避免同一条消息被消费两次）
    for (const w of [...waiters]) {
      if (w.predicate(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
        return;
      }
    }
    queue.push(msg);
  });

  const client = {
    ws,
    get closed() { return closed; },
    /** 等待一条满足条件的消息（会先消费已到达的队列） */
    next(predicate, { timeout = 2000, label = 'message' } = {}) {
      const fn = typeof predicate === 'function' ? predicate : (m) => m.type === predicate;
      for (let i = 0; i < queue.length; i++) {
        if (fn(queue[i])) return Promise.resolve(queue.splice(i, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const waiter = { predicate: fn, resolve, reject };
        waiter.timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`等待 ${label} 超时；已收到: ${JSON.stringify(queue)}`));
        }, timeout);
        waiters.push(waiter);
      });
    },
    /** 断言在 given ms 内没有收到满足条件的消息 */
    async expectNone(predicate, ms = 200, label = 'message') {
      const fn = typeof predicate === 'function' ? predicate : (m) => m.type === predicate;
      const before = queue.length;
      await new Promise((r) => setTimeout(r, ms));
      const hit = queue.slice(0, before).find(fn) || queue.find(fn);
      assert.equal(hit, undefined, `不应收到 ${label}，却收到 ${JSON.stringify(hit)}`);
    },
    send(obj) {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== OPEN) {
          reject(new Error('socket 未打开'));
          return;
        }
        ws.send(JSON.stringify(obj), (err) => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise((resolve) => {
        closed = true;
        if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
        ws.once('close', () => resolve());
        ws.close();
      });
    },
  };

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

/** 建立一对已配对的主机 / 客机 */
async function paired(port) {
  const host = await connect(port);
  await host.send({ type: 'join' });
  const hostRole = await host.next('role');
  assert.equal(hostRole.role, 'host');

  const guest = await connect(port);
  await guest.send({ type: 'join' });
  const guestRole = await guest.next('role');
  assert.equal(guestRole.role, 'guest');
  await host.next('matched');
  await guest.next('matched');
  return { host, guest, roomId: hostRole.room };
}

test('正常配对：先到为主机，后到为客机，双方收到 matched', async (t) => {
  const { app, port } = await startServer();
  t.after(() => app.close());

  const host = await connect(port);
  t.after(() => host.close());
  await host.send({ type: 'join' });
  const hostRole = await host.next('role');
  assert.equal(hostRole.role, 'host');
  assert.match(hostRole.room, /^R\d+$/);
  assert.equal(app.roomCount, 1);

  const guest = await connect(port);
  t.after(() => guest.close());
  await guest.send({ type: 'join' });
  const guestRole = await guest.next('role');
  assert.equal(guestRole.role, 'guest');
  assert.equal(guestRole.room, hostRole.room);

  const [hm, gm] = await Promise.all([host.next('matched'), guest.next('matched')]);
  assert.equal(hm.room, hostRole.room);
  assert.equal(gm.room, hostRole.room);
  assert.equal(app.roomCount, 1);

  // 中继：客机输入 → 主机
  await guest.send({ type: 'input', keys: { right: true } });
  const input = await host.next('input');
  assert.deepEqual(input.keys, { right: true });

  // 中继：主机快照 → 客机
  await host.send({ type: 'state', data: { mid: 1, round: 1 } });
  const state = await guest.next('state');
  assert.equal(state.mid, 1);
  assert.equal(state.round, 1);
});

test('对手离开：留下的一方收到 peer-left，房间清理后可以重新配对', async (t) => {
  const { app, port } = await startServer();
  t.after(() => app.close());

  const { host, guest, roomId } = await paired(port);

  // 客机关闭页面（socket 关闭）
  await guest.close();

  const left = await host.next('peer-left', { label: 'peer-left' });
  assert.equal(left.room, roomId);
  // 房间已被清理：不会残留等待中的房间
  assert.equal(app.roomCount, 0);

  // 留下的一方再次 join 会创建新房间；新的对手可以正常配对
  await host.send({ type: 'join' });
  const again = await host.next('role');
  assert.equal(again.role, 'host');
  assert.notEqual(again.room, roomId);
  assert.equal(app.roomCount, 1);

  const newcomer = await connect(port);
  t.after(() => newcomer.close());
  await newcomer.send({ type: 'join' });
  const nr = await newcomer.next('role');
  assert.equal(nr.role, 'guest');
  await Promise.all([host.next('matched'), newcomer.next('matched')]);
  await host.close();
});

test('主机离开：客机同样收到 peer-left 且房间可复用', async (t) => {
  const { app, port } = await startServer();
  t.after(() => app.close());

  const { host, guest } = await paired(port);
  await host.close();
  await guest.next('peer-left', { label: 'guest peer-left' });
  assert.equal(app.roomCount, 0);

  const a = await connect(port);
  t.after(() => a.close());
  await a.send({ type: 'join' });
  assert.equal((await a.next('role')).role, 'host');
  const b = await connect(port);
  t.after(() => b.close());
  await b.send({ type: 'join' });
  assert.equal((await b.next('role')).role, 'guest');
  await Promise.all([a.next('matched'), b.next('matched')]);
  await guest.close();
});

test('对手连接已断但 close 未处理时发 cmd：立刻收到 peer-left 且房间被清理', async (t) => {
  const { app, port } = await startServer();
  t.after(() => app.close());

  const { host, guest, roomId } = await paired(port);
  t.after(() => host.close());

  // 直接销毁客机底层连接（不发正常关闭帧），制造“close 事件尚未落到服务端”的窗口
  guest.ws.terminate();
  await new Promise((r) => setTimeout(r, 50));

  await host.send({ type: 'cmd', cmd: 'rematch', c1: 0, c2: 1 });
  const left = await host.next('peer-left', { label: 'cmd 后 peer-left' });
  assert.equal(left.room, roomId);
  assert.equal(app.roomCount, 0, '房间应被清理，避免发起方停在等待状态');
  // 不应收到命令回声（对手已不在，无法达成一致）
  await host.expectNone('cmd', 200, '发给已离开对手的 cmd 回声');
});

test('重复 join：同一连接不会产生第二个房间，也不会被重复配对', async (t) => {
  const { app, port } = await startServer();
  t.after(() => app.close());

  const host = await connect(port);
  t.after(() => host.close());
  await host.send({ type: 'join' });
  const first = await host.next('role');
  assert.equal(first.role, 'host');

  // 等待中的主机重复 join：只回发角色，不新建房间
  await host.send({ type: 'join' });
  const again = await host.next('role');
  assert.equal(again.role, 'host');
  assert.equal(again.room, first.room);
  assert.equal(app.roomCount, 1);

  const guest = await connect(port);
  t.after(() => guest.close());
  await guest.send({ type: 'join' });
  assert.equal((await guest.next('role')).role, 'guest');
  await Promise.all([host.next('matched'), guest.next('matched')]);
  assert.equal(app.roomCount, 1);

  // 已配对后再次 join：仍然只有一个房间，并且角色不变
  await host.send({ type: 'join' });
  await guest.send({ type: 'join' });
  const [hr, gr] = await Promise.all([host.next('role'), guest.next('role')]);
  assert.equal(hr.role, 'host');
  assert.equal(gr.role, 'guest');
  assert.equal(hr.room, gr.room);
  assert.equal(app.roomCount, 1);
  // 不应再次触发 matched
  await host.expectNone('matched', 200, '重复 matched');
  await guest.expectNone('matched', 200, '重复 matched');
});

test('重赛一致：命令回声给双方并携带同一 mid，菜单命令解散房间', async (t) => {
  const { app, port } = await startServer();
  t.after(() => app.close());

  const { host, guest, roomId } = await paired(port);
  t.after(() => Promise.all([host.close(), guest.close()]));

  const hState = new NetMatchState();
  const gState = new NetMatchState();

  // 客机发起开局：双方收到同一条 cmd（同一 mid / 同一角色）
  await guest.send({ type: 'cmd', cmd: 'start', c1: 2, c2: 5, stage: 'night' });
  const [hs1, gs1] = await Promise.all([host.next('cmd'), guest.next('cmd')]);
  assert.equal(hs1.mid, gs1.mid);
  assert.equal(hs1.from, 'guest');
  const hEvt1 = hState.onCmd(hs1);
  const gEvt1 = gState.onCmd(gs1);
  assert.deepEqual(hEvt1, gEvt1);
  assert.deepEqual(hEvt1, { action: 'start', mid: 1, c1: 2, c2: 5, stage: 'night' });

  // 客机快照：双方对局代号一致
  assert.equal(hState.mid, gState.mid);
  assert.equal(hState.acceptSnapshot({ mid: 1 }), true);
  assert.equal(gState.acceptSnapshot({ mid: 1 }), true);

  // 主机发起重赛：两位玩家都收到同一条命令，都重置为同一局
  await host.send({ type: 'cmd', cmd: 'rematch', c1: 2, c2: 5, stage: 'night' });
  const [hs2, gs2] = await Promise.all([host.next('cmd'), guest.next('cmd')]);
  assert.equal(hs2.mid, 2);
  assert.equal(gs2.mid, 2);
  assert.equal(hs2.from, 'host');
  const hEvt2 = hState.onCmd(hs2);
  const gEvt2 = gState.onCmd(gs2);
  assert.deepEqual(hEvt2, gEvt2);
  assert.equal(hEvt2.action, 'start');
  assert.equal(hEvt2.mid, 2);
  assert.equal(hState.mid, gState.mid);

  // 重赛前的旧快照必须被两端一致地丢弃（不会把客机带回上一局）
  assert.equal(hState.acceptSnapshot({ mid: 1 }), false);
  assert.equal(gState.acceptSnapshot({ mid: 1 }), false);
  assert.equal(gState.acceptSnapshot({ mid: 2 }), true);

  // 如果客机错过了重赛命令，但收到了新对局的快照：跟随主机的 mid，不会永久停摆
  const lagging = new NetMatchState();
  lagging.onCmd({ type: 'cmd', cmd: 'start', mid: 1, c1: 0, c2: 1 });
  assert.equal(lagging.acceptSnapshot({ mid: 2 }), true);
  assert.equal(lagging.mid, 2);
  assert.equal(lagging.acceptSnapshot({ mid: 1 }), false);

  // 重复到达的旧命令不会再次开局
  assert.equal(hState.onCmd(hs2), null);
  assert.equal(gState.onCmd(gs2), null);

  // 返回菜单：双方收到同一命令，房间解散
  await guest.send({ type: 'cmd', cmd: 'menu' });
  const [hm, gm] = await Promise.all([host.next('cmd'), guest.next('cmd')]);
  assert.equal(hm.cmd, 'menu');
  assert.equal(gm.cmd, 'menu');
  assert.deepEqual(hState.onCmd(hm), gState.onCmd(gm));
  assert.equal(hState.started, false);
  assert.equal(gState.started, false);
  assert.equal(app.roomCount, 0);
});

test('NetMatchState：先到的旧 mid 命令 / 未带 mid 的命令都能正确处理', () => {
  const a = new NetMatchState();
  const b = new NetMatchState();

  const start = { type: 'cmd', cmd: 'start', mid: 3, c1: 0, c2: 1 };
  assert.deepEqual(a.onCmd(start), b.onCmd(start));
  assert.equal(a.mid, 3);

  // 旧命令（mid 更小）被忽略
  assert.equal(a.onCmd({ type: 'cmd', cmd: 'rematch', mid: 2 }), null);
  // 同一 mid 重复到达被忽略
  assert.equal(a.onCmd(start), null);
  assert.equal(a.mid, 3);

  // 新 mid 的重赛被接受
  const rematch = { type: 'cmd', cmd: 'rematch', mid: 4, c1: 0, c2: 1 };
  assert.equal(a.onCmd(rematch).action, 'start');
  assert.equal(a.mid, 4);

  // 未携带 mid 的旧服务器命令以本地序号递增，仍然只开局一次
  const c = new NetMatchState();
  assert.equal(c.onCmd({ type: 'cmd', cmd: 'start' }).mid, 1);
  assert.equal(c.onCmd({ type: 'cmd', cmd: 'start' }).mid, 2);
  assert.equal(c.onCmd({ type: 'cmd', cmd: 'rematch' }).mid, 3);

  // menu 重置状态
  a.onCmd({ type: 'cmd', cmd: 'menu' });
  assert.equal(a.started, false);
  assert.equal(a.mid, 4);
});
