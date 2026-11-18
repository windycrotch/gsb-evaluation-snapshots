/* 一起看（src/watch.js）本地自造样例测试。
 *
 * 运行：node tests/watch.test.js
 *
 * 不依赖任何第三方包：用 Node 内置 vm 把 src/watch.js 加载进沙箱，
 * MQTT broker、localStorage、DOM、播放器全部用自造假件替代，
 * 覆盖：正常收发、按用户去重、5 分钟超时剔除、关闭侧栏不断连、
 * 重连重订阅不清状态、msgId 去重、200 条上限、线路缺失跟随降级、
 * 超长发送与未开房间发送的负向路径。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- 沙箱工厂：每个用例一套干净的假件 ---------- */
function makeWorld() {
  const store = {};            // localStorage 内容
  const toasts = [];           // toast 文案
  const published = [];        // { topic, msg }
  const subscribed = [];       // 订阅过的 topic
  const unsubscribed = [];     // 退订过的 topic
  const played = [];           // playEpisode 调用 { auto, startAt }
  let linesRendered = 0;
  let client = null;

  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };

  const mqtt = {
    connect(url, opts) {
      client = {
        url, opts, connected: false, ended: false,
        handlers: {},
        on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
        emit(ev, ...args) { (this.handlers[ev] || []).slice().forEach(f => f(...args)); },
        publish(topic, payload) { published.push({ topic, msg: JSON.parse(payload) }); },
        subscribe(t) { subscribed.push(t); },
        unsubscribe(t) { unsubscribed.push(t); },
        end() { this.ended = true; this.connected = false; }
      };
      return client;
    }
  };

  const S = {
    root: { querySelector: () => null, querySelectorAll: () => [] },
    player: { item: null, groups: {}, order: [], from: '', ep: 0 }
  };

  const sandbox = {
    localStorage,
    G: { TVBoxCenter: { mqtt } },
    WebSocket: function () {},
    toast: m => toasts.push(String(m)),
    S,
    esc: s => String(s == null ? '' : s),
    fmtTime: s => 'T' + Math.round(s || 0),
    renderLines: () => { linesRendered++; },
    playEpisode: (auto, startAt) => played.push({ auto, startAt }),
    setInterval: () => 1,
    clearInterval: () => {},
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'watch.js'), 'utf8'), sandbox);

  return {
    sb: sandbox, store, toasts, published, subscribed, unsubscribed, played, S,
    get linesRendered() { return linesRendered; },
    get client() { return client; }
  };
}

const ITEM = { _sourceKey: 'srcA', vod_id: '42', vod_name: '样例剧' };

/* 进入房间并完成首次握手 */
function enterRoom(w, item) {
  w.sb.wtEnter(item || ITEM);
  const c = w.client;
  c.connected = true;
  c.emit('connect'); // 触发 connect 回调：订阅 + hello
  return c;
}

function chatsOf(w) { return w.published.filter(p => p.msg.type === 'chat'); }
function hellosOf(w) { return w.published.filter(p => p.msg.type === 'hello'); }

/* ---------- 微型断言器 ---------- */
let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function suite(title, fn) { console.log('\n[' + title + ']'); fn(); }

/* ================= 用例 ================= */

suite('正常路径：进房、收发、持久化', () => {
  const w = makeWorld();
  enterRoom(w);
  const WT = w.sb.WT;

  ok(w.subscribed.includes(WT.topic), '连接成功后订阅房间主题');
  ok(hellosOf(w).length >= 1, '进房后发出 hello');
  ok(WT.users[WT.uid], '自己计入在线名单');

  w.sb.wtSend('你好，一起看');
  ok(chatsOf(w).length === 1, '发送产生一条 chat 消息');
  ok(WT.msgs.length === 1 && WT.msgs[0].text === '你好，一起看', '本地回显一条');
  ok(WT.msgs[0].msgId && WT.msgs[0].msgId === chatsOf(w)[0].msg.msgId, '回显与发出的 msgId 一致（供去重）');

  const saved = JSON.parse(w.store['tvbox-center:chat:' + WT.hash]);
  ok(saved.messages.length === 1, '聊天记录已写入 localStorage');

  w.sb.wtRecv({ type: 'chat', uid: 'u1', nick: '路人甲', text: '来了', msgId: 'm1', ts: 1 });
  ok(WT.msgs.length === 2, '收到他人消息入列');
  ok(WT.unread === 0, '侧栏打开时不累计未读');
  ok(Object.keys(WT.users).length === 2, '在线人数 = 自己 + 路人甲');
});

suite('去重：同人多标签只算一人，同 msgId 只显示一次', () => {
  const w = makeWorld();
  enterRoom(w);
  const WT = w.sb.WT;

  w.sb.wtRecv({ type: 'hello', uid: 'u1', nick: '标签页A' });
  w.sb.wtRecv({ type: 'hello', uid: 'u1', nick: '标签页B' }); // 同一用户第二个标签页
  w.sb.wtRecv({ type: 'chat', uid: 'u1', nick: '标签页A', text: 'hi', msgId: 'dup-1' });
  ok(Object.keys(WT.users).filter(k => k === 'u1').length === 1, '同一 uid 多个标签页只算一人');
  ok(Object.keys(WT.users).length === 2, '在线总数 = 自己 + u1');

  w.sb.wtRecv({ type: 'chat', uid: 'u1', nick: '标签页A', text: 'hi', msgId: 'dup-1' }); // 重复到达
  ok(WT.msgs.filter(m => m.msgId === 'dup-1').length === 1, '同一 msgId 只显示一次');
});

suite('超时剔除：5 分钟无消息移除，自己永不被剔除', () => {
  const w = makeWorld();
  enterRoom(w);
  const WT = w.sb.WT;
  const old = Date.now() - 6 * 60 * 1000;

  w.sb.wtRecv({ type: 'hello', uid: 'u1', nick: '旧人' });
  WT.users['u1'].at = old;
  WT.users[WT.uid].at = old; // 自己也“很久没说话”
  w.sb.wtPruneUsers();
  ok(!WT.users['u1'], '超过 5 分钟的用户被剔除');
  ok(!!WT.users[WT.uid], '自己始终计入，不被剔除');
});

suite('关闭侧栏：连接与订阅保持，未读继续累加；退出才断开', () => {
  const w = makeWorld();
  const c = enterRoom(w);
  const WT = w.sb.WT;

  w.sb.wtClose();
  ok(WT.open === false, '侧栏收起');
  ok(!c.ended && w.unsubscribed.length === 0, 'MQTT 连接与订阅保持');

  w.sb.wtRecv({ type: 'chat', uid: 'u1', nick: '甲', text: '1', msgId: 'c1' });
  w.sb.wtRecv({ type: 'chat', uid: 'u1', nick: '甲', text: '2', msgId: 'c2' });
  ok(WT.unread === 2, '收起时未读角标继续累加', WT.unread);

  w.sb.wtEnter(ITEM); // 同一房间重新展开
  ok(WT.open === true && WT.unread === 0, '重新展开清零未读');
  ok(WT.msgs.length === 2, '重新展开不清聊天记录');
  ok(hellosOf(w).length === 1, '重新展开不重复进房发 hello', hellosOf(w).length);

  w.sb.wtLeave();
  ok(w.published.some(p => p.msg.type === 'bye'), '主动退出广播 bye');
  ok(w.unsubscribed.includes('tvbox-center/v1/chat/' + w.sb.wtRoomOf(ITEM)) || w.unsubscribed.length === 1, '退出时退订主题');
  ok(c.ended, '退出时断开 MQTT 连接');
  ok(WT.topic === '' && Object.keys(WT.users).length === 0, '退出后房间状态清空');
});

suite('重连：重新订阅并补发 hello，不清聊天记录与在线名单', () => {
  const w = makeWorld();
  const c = enterRoom(w);
  const WT = w.sb.WT;

  w.sb.wtRecv({ type: 'chat', uid: 'u1', nick: '甲', text: '重连前的消息', msgId: 'pre-1' });
  const msgsBefore = WT.msgs.length;
  const usersBefore = Object.keys(WT.users).length;
  const subBefore = w.subscribed.length;
  const helloBefore = hellosOf(w).length;

  c.emit('connect'); // 模拟断线重连成功
  ok(w.subscribed.length === subBefore + 1, '重连后重新订阅主题');
  ok(hellosOf(w).length === helloBefore + 1, '重连后补发一次 hello');
  ok(WT.msgs.length === msgsBefore, '重连不清聊天记录');
  ok(Object.keys(WT.users).length === usersBefore, '重连不清在线名单');
});

suite('聊天记录每房间最多保留 200 条', () => {
  const w = makeWorld();
  enterRoom(w);
  const WT = w.sb.WT;

  for (let i = 0; i < 250; i++) {
    w.sb.wtRecv({ type: 'chat', uid: 'u' + (i % 3), nick: 'n', text: 'm' + i, msgId: 'msg-' + i });
  }
  ok(WT.msgs.length === 200, '内存中只保留 200 条', WT.msgs.length);
  ok(WT.msgs[0].msgId === 'msg-50', '最旧的消息被丢弃，保留最新 200 条');
  const saved = JSON.parse(w.store['tvbox-center:chat:' + WT.hash]);
  ok(saved.messages.length === 200, 'localStorage 中也是 200 条', saved.messages.length);
});

suite('进度同步：跟随切线路/集/秒，线路缺失时降级并提示', () => {
  const w = makeWorld();
  enterRoom(w);
  const WT = w.sb.WT;
  w.S.player.item = ITEM;
  w.S.player.groups = { 主线: [{ name: '1' }, { name: '2' }, { name: '3' }] };
  w.S.player.order = ['主线'];
  w.S.player.from = '主线';

  WT.lastSync = { type: 'sync', uid: 'u9', nick: '对方', from: '主线', ep: 2, time: 95 };
  w.sb.wtFollow();
  ok(w.S.player.from === '主线' && w.S.player.ep === 2, '线路存在：切到对应线路与集数');
  ok(w.played.length === 1 && w.played[0].startAt === 95, '跳到对应秒数', w.played);
  ok(w.toasts.some(t => t.includes('已跟随')), '给出跟随成功提示');

  WT.lastSync = { type: 'sync', uid: 'u9', nick: '对方', from: '不存在的线路', ep: 1, time: 30 };
  w.sb.wtFollow();
  ok(w.S.player.from === '主线', '线路缺失：保持当前线路');
  ok(w.S.player.ep === 1 && w.played[1].startAt === 30, '线路缺失：仍切到对应集与秒');
  ok(w.toasts.some(t => t.includes('不存在')), '线路缺失：给出提示而非静默失败', w.toasts);
});

suite('发送约束：超长不发出并提示，未开房间提示先打开作品', () => {
  const w = makeWorld();
  ok(w.sb.wtSend('还没进房') === undefined && w.published.length === 0, '未开房间不发出任何消息');
  ok(w.toasts.some(t => t.includes('先打开一个作品')), '未开房间提示先打开作品', w.toasts);

  enterRoom(w);
  const WT = w.sb.WT;
  const before = chatsOf(w).length;
  w.sb.wtSend('超'.repeat(501));
  ok(chatsOf(w).length === before, '超过 500 字不发出');
  ok(WT.msgs.length === 0, '超过 500 字不入本地记录');
  ok(w.toasts.some(t => t.includes('500')), '超过 500 字给出提示', w.toasts);

  w.sb.wtSend('正常长度');
  ok(chatsOf(w).length === before + 1 && WT.msgs.length === 1, '正常长度照常发送');
});

/* ================= 汇总 ================= */
console.log('\n' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
