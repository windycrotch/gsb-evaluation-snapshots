import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { resolve, promise };
}
function bounded(promise, message) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 4000); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Runs inside selftest-automation's temporary two-account console. Only the
// inbound API is real; the "game server" deliberately keeps returning old rows.
export async function testResidentHttp(app) {
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api/';
  const request = async (route, body) => {
    const res = await fetch(base + route + '?account=b', {
      method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    return { status: res.status, data: await res.json() };
  };
  const submit = row => request('world/order/submit', { confirm: true, index: row.index, orderKey: row.orderKey });
  await request('loop');
  const session = app.sessions.get('b');
  assert.equal(session.loop.tasks.finishOrder, false);
  const game = new EventEmitter();
  game.connected = true;
  game.stop = () => { game.connected = false; };
  session.player = { playerId: '9101000000000001', worldId: 1001001, level: 1, scenarioId: 1.5 }; // no real map fetch for this fixture
  session.client = game;
  const orders = [1, 2].map(index => ({ index, workerId: index, textId: index, requirements: [{ id: '烤鱼', num: 3 }] }));
  const now = Math.floor(Date.now() / 1000);
  let autoProduceForever = false, autoProduceEndTime = now - 1;
  let buildings = [
    { buildingId: '1食品厂', level: 2, factory: { factoryQ: [
      { idx: 5, productId: '烤鱼', finishTime: now + 120 },
      { idx: 6, productId: '烤鱼' },
      { idx: 7, productId: '烤鱼', finishTime: 0 },
    ], finishedProducts: [], autoProductId: '烤鱼' } },
    { buildingId: '1活动工厂', level: 1, factory: { factoryQ: [], finishedProducts: [] } },
    { buildingId: '2食品厂', level: 1, factory: {} },
    { buildingId: '1农田', level: 1, farm: { productId: '烤鱼', ripeTime: now + 150 } },
    { buildingId: '2农田', level: 1, farm: { productId: '烤鱼', ripeTime: now - 1 } },
    { buildingId: '3农田', level: 1, farm: {} },
    { buildingId: '4农田', level: 1 },
    { buildingId: '5农田', level: 1, farm: { productId: '烤鱼' } },
    { buildingId: '6农田', level: 0, buildFinishTime: now + 60 },
    { buildingId: '7农田', level: 0 },
    { buildingId: '8农田', level: 0, buildFinishTime: now - 1 },
  ];
  const writes = [];
  let onNextRead;
  game.request = async (name, body, responseType) => {
    switch (name) {
      case 'OnWaterRequest': {
        const block = onNextRead;
        onNextRead = null;
        if (block) { block.enter.resolve(); await bounded(block.release.promise, '测试中的阻塞读取未能解除'); }
        return { workerOrder: orders, building: buildings, autoProduceForever, autoProduceEndTime };
      }
      case 'AllItemRequest': return { items: [{ itemId: '烤鱼', num: 3 }] };
      case 'AllResourceRequest': return { list: [] };
      case 'MyResFieldsRequest': return {};
      case 'MyFleetsRequest': return { fleets: [] };
      case 'WeekInfoRequest': return { activityTime: [] };
      case 'FinishWorkerOrderRequest':
        assert.equal(responseType, 'FinishWorkerOrderResponse');
        writes.push(body.index);
        // The server hasn't pushed a new order/stock yet. A duplicate submission
        // would still look affordable; the console must invalidate the first key.
        return { reward: { asset: [{ id: 'GOLD', num: 23 }] } };
      default: throw Error('意外的游戏请求 ' + name);
    }
  };
  const firstView = await request('world');
  assert.equal(firstView.status, 200);
  assert.equal(firstView.data.autoDeliverOrders, false);
  const [factory, workshop, unknownFactory] = firstView.data.factories;
  assert.equal(factory.capacity, 6);
  assert.equal(factory.queue, 3);
  assert.equal(factory.queueKnown, true);
  assert.equal(factory.auto, '烤鱼');
  assert.equal(factory.autoEnabled, false, '设置目标但自动生产权限过期时显示关闭');
  assert.deepEqual(factory.jobs, [
    { index: 5, productId: '烤鱼', name: '烤鱼', finishTime: now + 120 },
    { index: 6, productId: '烤鱼', name: '烤鱼', finishTime: null },
    { index: 7, productId: '烤鱼', name: '烤鱼', finishTime: null },
  ], '服务端提供所有排队产物，缺少结束时间的排队项保留未知时间');
  assert.equal(workshop.typeName, '活动工坊');
  assert.equal(workshop.queueKnown, true);
  assert.deepEqual(workshop.jobs, []);
  assert.equal(unknownFactory.queueKnown, false, '队列未返回时不能当作已确认的空队列');
  assert.deepEqual(firstView.data.farms.map(farm => farm.state), ['growing', 'ready', 'idle', 'unknown', 'unknown', 'building', 'unbuilt', 'building']);
  assert.equal(firstView.data.farms[0].productName, '烤鱼');
  assert.equal(firstView.data.farms[0].ripeTime, now + 150);
  assert.equal(firstView.data.farms[4].ripeTime, null);
  assert.equal(firstView.data.farms[5].finishTime, now + 60);
  assert.equal(firstView.data.farms[7].status, '待竣工');
  autoProduceForever = true;
  const permanentView = await request('world');
  assert.equal(permanentView.status, 200);
  assert.equal(permanentView.data.factories[0].autoEnabled, true, '永久自动生产权限与已设置目标共同开启自动生产');
  assert.equal(permanentView.data.factories[1].autoEnabled, false, '没有设置目标的工厂即使有永久权限也未开启');
  autoProduceForever = false;
  autoProduceEndTime = now + 300;
  const timedView = await request('world');
  assert.equal(timedView.status, 200);
  assert.equal(timedView.data.factories[0].autoEnabled, true, '有效期内自动生产权限与已设置目标共同开启自动生产');
  assert.equal(timedView.data.factories[1].autoEnabled, false);
  buildings = [];
  const [first, second] = firstView.data.orders;
  assert(first.orderKey && second.orderKey && first.orderKey !== second.orderKey);
  assert.equal(second.manualDecision.status, 'ready', '只能交一单时第二个槽也可手动选择');
  const startRead = () => {
    const block = { enter: gate(), release: gate() };
    onNextRead = block;
    return { ...block, read: request('world') };
  };
  // Wait until the server has consumed every POST body before letting the
  // unrelated queued read finish; otherwise the second click can arrive later.
  const waitForSubmissions = count => new Promise(resolve => {
    function observe(req) {
      if (!req.url.startsWith('/api/world/order/submit?')) return;
      req.on('end', () => {
        if (--count) return;
        app.server.off('request', observe);
        setImmediate(resolve);
      });
    }
    app.server.on('request', observe);
  });

  const blocked = startRead();
  await bounded(blocked.enter.promise, '测试海面查询未进入账号队列');
  const received = waitForSubmissions(2);
  const duplicatePair = Promise.all([submit(second), submit(second)]);
  try {
    await bounded(received, '服务端未收到两次手动交单请求');
    assert.deepEqual(writes, [], '手动交单要等本账号在途查询结束');
  } finally { blocked.release.resolve(); }
  await blocked.read;
  const delivered = await duplicatePair;
  assert(delivered.every(r => r.status === 200 && r.data.ok && r.data.index === 2));
  assert.deepEqual(writes, [2], '两次点击只交一次指定的第二单');
  assert.equal((await submit(second)).status, 400, '已提交的同一把 key 即使状态推送未到也不能重放');

  orders[0] = { ...orders[0], textId: 99 };
  assert.equal((await submit(first)).status, 400, '同槽已换一份需求相同的订单，不可使用旧 key');
  const refreshed = await request('world');
  const current = refreshed.data.orders[0];
  assert.notEqual(current.orderKey, first.orderKey);
  const waiting = startRead();
  await bounded(waiting.enter.promise, '测试的第二次海面查询未进入账号队列');
  const pendingReceived = waitForSubmissions(1);
  const pending = submit(current);
  try {
    await bounded(pendingReceived, '待取消的交单请求未到达服务端');
    assert.equal((await request('accounts/pause', { paused: true })).data.paused, true);
  } finally { waiting.release.resolve(); }
  await waiting.read;
  assert.equal((await pending).status, 400);
  assert.equal((await submit(current)).status, 400);
  assert.deepEqual(writes, [2], '队列中与暂停后的请求都不再写游戏');

  const stream = await fetch(base + 'events?account=b', { signal: AbortSignal.timeout(3000) });
  const reader = stream.body.getReader();
  const decode = new TextDecoder();
  let messages = '', confirmed;
  try {
    while (!confirmed) {
      const { value, done } = await reader.read();
      if (done) break;
      messages += decode.decode(value, { stream: true });
      for (const block of messages.split('\n\n').slice(0, -1)) {
        const line = block.split('\n').find(line => line.startsWith('data: '));
        if (!line) continue;
        const entry = JSON.parse(line.slice(6));
        if (entry.account === 'b' && entry.extra?.worldUpdated && /获得.*金币 ×23/.test(entry.message)) confirmed = entry;
      }
    }
    assert.equal(confirmed?.level, 'info', '按账号订阅主运行日志能看到服务端回包中的实际奖励');
    assert.match(confirmed.message, /#2/);
  } finally { await reader.cancel(); }
}
