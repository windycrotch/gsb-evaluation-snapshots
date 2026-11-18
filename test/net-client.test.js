/**
 * 客户端联机会话（NetSession）自动化测试
 * 运行：npm test
 *
 * 覆盖：
 * 1. 收到 peer-left 后立即停止状态快照/输入循环，不再向已断开的对手发送
 * 2. 对手离开后本地 send 返回 false（界面据此避免进入“等待对手”状态）
 * 3. 自身断线（closed）与对手离开（peer-left）的关闭原因可区分
 * 4. 主动 destroy 时不再触发 onClose，避免覆盖“对手已离开”的提示
 *
 * 这里用假的 WebSocket 驱动 NetSession，不需要浏览器环境。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NetSession } from '../src/net.js';

/** 假 WebSocket：记录发送/关闭 */
function fakeSocket() {
  const sent = [];
  let closed = false;
  return {
    readyState: 1,
    sent,
    send(data) { sent.push(JSON.parse(data)); },
    close() { closed = true; this.readyState = 3; },
    get closed() { return closed; },
  };
}

function makeSession() {
  const events = [];
  const session = new NetSession({
    onClose: (reason) => events.push(['close', reason]),
    onRole: (role) => events.push(['role', role]),
    onStart: (msg) => events.push(['cmd', msg]),
  });
  session.ws = fakeSocket();
  session.role = 'host';
  return { session, events };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('对手离开后立即停止快照循环，不再发送 state', async () => {
  const { session, events } = makeSession();
  session.startStateLoop(() => ({ mid: 1, round: 1 }));
  await sleep(90);
  const before = session.ws.sent.filter((m) => m.type === 'state').length;
  assert.ok(before > 0, '离开前应持续发送快照');

  session._route({ type: 'peer-left', room: 'R1' });
  assert.deepEqual(events, [['close', 'peer-left']]);

  // 再等一段，确认循环确实停了
  const afterLeave = session.ws.sent.length;
  await sleep(120);
  assert.equal(session.ws.sent.length, afterLeave, 'peer-left 后不应再有任何发送');
  assert.equal(session._stateTimer, null);
});

test('对手离开后 send 返回 false，不会把界面带进等待状态', () => {
  const { session } = makeSession();
  assert.equal(session.isOpen(), true);
  assert.equal(session.send({ type: 'cmd', cmd: 'rematch' }), true);

  session._route({ type: 'peer-left', room: 'R1' });

  assert.equal(session.peerLeft, true);
  assert.equal(session.isOpen(), false);
  assert.equal(session.send({ type: 'cmd', cmd: 'rematch' }), false);
  assert.equal(session.send({ type: 'cmd', cmd: 'menu' }), false);
  // 连接仍然开着，但业务层已判定不可用
  assert.equal(session.ws.readyState, 1);
});

test('自身断线回调原因为 closed；主动 destroy 不再回调', () => {
  const a = makeSession();
  a.session._onSocketClose();
  assert.deepEqual(a.events, [['close', 'closed']]);
  assert.equal(a.session.closed, true);
  assert.equal(a.session.isOpen(), false);

  const b = makeSession();
  b.session.destroy();
  b.session._onSocketClose();   // destroy 之后底层 close 不应再回调
  assert.deepEqual(b.events, []);
  assert.equal(b.session._stateTimer, null);
  assert.equal(b.session._inputTimer, null);
  assert.equal(b.session.ws, null);
});

test('cmd 回声原样交给上层（含服务端附加的 mid / from）', () => {
  const { session, events } = makeSession();
  session._route({ type: 'cmd', cmd: 'rematch', mid: 7, from: 'guest', c1: 1, c2: 3, stage: 'night' });
  assert.deepEqual(events, [['cmd', { type: 'cmd', cmd: 'rematch', mid: 7, from: 'guest', c1: 1, c2: 3, stage: 'night' }]]);
});
