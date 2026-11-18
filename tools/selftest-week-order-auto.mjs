import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cw-week-order-auto-'));
process.env.CW_DATA_DIR = directory;
const { runAutomaticWeekOrder, runWeekOrder, readWeekOrder } = await import('../src/activities.mjs');
const { defaultSettings, createUsageLedger } = await import('../src/automation-settings.mjs');
const { runLoop } = await import('../src/loop.mjs');

const protocol = createDeclaredProtocol([
  'WeekInfoRequest', 'WeekInfoResponse', 'WeekOrderInfoRequest', 'WeekOrderInfoResponse',
  'AllItemRequest', 'AllItemResponse', 'AllResourceRequest', 'AllResourceResponse',
  'CommonBuyGoodsRequest', 'CommonBuyGoodsResponse', 'FinishWeekOrderRequest', 'FinishWeekOrderResponse',
]);
let serial = 0;

function fixture({ ready = false, single = false } = {}) {
  serial++;
  let settings = defaultSettings();
  for (const key of Object.keys(settings.schedule)) settings.schedule[key] = false;
  Object.assign(settings.loop, { tasks: false, dailies: false, world: false, heroes: false });
  settings.schedule.weekOrderSubmit = true;
  settings.weekOrder = { allowDiamonds: true };
  settings.resources.allowDiamonds = true;
  settings.resources.diamondDailyLimit = 2000;
  const player = { playerId: String(9700000 + serial), worldId: '1', guildId: '1', level: 40, vip: { vipLevel: 0 } };
  const config = { materialName: id => id, tables: {
    WeekOrderRwdCfg: { data: [1, 2, 3].map(rwdId => ({ periodId: 2001, rwdId })) },
    ItemPriceCfg: { data: [{ itemId: '木板', rubyPrice: 10 }, { itemId: '布匹', rubyPrice: 20 }] },
  } };
  const now = Math.floor(Date.now() / 1000);
  const state = {
    window: { type: 5, period: 2001, startTime: now - 3600, endTime: now + 3600 },
    order: { gotRwdId: [], order: [{ id: '木板', num: 2 }, ...(single ? [] : [{ id: '布匹', num: 3 }])], isGotFinal: false },
    stock: new Map([['木板', ready ? 2 : 0], ['布匹', ready ? 3 : 1]]),
    ruby: 1000, active: true, dayOffset: 0, reads: [], writes: [], protocolErrors: [], failures: new Map(),
    beforeRead: null, afterWrite: null,
  };
  const file = path.join(directory, serial + '.json');
  const account = 'merchant-' + serial;
  let ledger = createUsageLedger(account, { file, now: () => Date.now() + state.dayOffset });
  const client = new EventEmitter();
  client.setMaxListeners(50);
  Object.assign(client, { connected: true, festivals: [], serverClockOffsetMs: 0 });
  const codec = (name, value) => {
    if (!protocol[name]) state.protocolErrors.push(name);
    assert(protocol[name], '测试必须声明协议 ' + name);
    return protocol[name].decode(protocol[name].encode(value).finish());
  };
  client.request = async (name, body = {}, response = name.replace(/Request$/, 'Response')) => {
    const request = codec(name, body);
    const write = ['CommonBuyGoodsRequest', 'FinishWeekOrderRequest'].includes(name);
    if (!write) {
      state.reads.push(name);
      await state.beforeRead?.(name);
      if (name === 'WeekInfoRequest') return codec(response, { activityTime: [state.window] });
      if (name === 'WeekOrderInfoRequest') return codec(response, state.order);
      if (name === 'AllItemRequest') return codec(response, { items: [...state.stock].map(([itemId, num]) => ({ itemId, num })) });
      if (name === 'AllResourceRequest') return codec(response, { list: [{ res: 4, amount: state.ruby }] });
      throw Error('测试未声明读取 ' + name);
    }
    state.writes.push({ name, body: request });
    const failure = state.failures.get(state.writes.length);
    if (failure === 'rejected') throw Object.assign(Error('服务端明确拒绝'), { prompt: { prompt: 5 }, request: name });
    if (failure === 'notSent') throw Object.assign(Error('写请求未发送'), { notSent: true, request: name });
    if (failure === 'unknown') throw Error('请求结果未知');
    let result;
    if (name === 'CommonBuyGoodsRequest') {
      assert.equal(request.goods.length, 1);
      const assets = request.goods.map(({ itemId, num }) => {
        const price = config.tables.ItemPriceCfg.data.find(row => row.itemId === itemId)?.rubyPrice;
        assert(Number.isSafeInteger(price) && price > 0);
        assert(Number.isSafeInteger(num) && num > 0);
        state.ruby -= price * num;
        state.stock.set(itemId, (state.stock.get(itemId) ?? 0) + num);
        return { id: itemId, num };
      });
      result = { reward: { asset: assets } };
    } else {
      assert.deepEqual(request, {});
      for (const row of state.order.order) {
        assert((state.stock.get(row.id) ?? 0) >= row.num, '提交前库存必须够用');
        state.stock.set(row.id, state.stock.get(row.id) - row.num);
      }
      const rewardId = state.order.gotRwdId.length + 1;
      state.order.gotRwdId.push(rewardId);
      state.order.order = [{ id: '木板', num: 1 }];
      result = { randomRwdId: rewardId, newOrder: state.order.order };
    }
    await state.afterWrite?.(name);
    if (failure === 'lost') throw Error('服务端已执行但回包丢失');
    return codec(response, result);
  };
  client.sendWatch = async name => { state.protocolErrors.push(name); throw Error('测试禁止未声明写协议 ' + name); };
  const reports = [];
  const run = async () => {
    try {
      await runAutomaticWeekOrder(client, config, {
        player, getSettings: () => settings, ledger, enabled: () => state.active,
        report: entry => reports.push(entry),
      });
    } catch (error) { reports.push({ error: error.message }); }
    assert.deepEqual(state.protocolErrors, [], '不得吞掉未声明协议错误');
  };
  const quote = async (itemId = '木板') => {
    const view = await readWeekOrder(client, undefined, config);
    const quantity = view.needed.get(itemId) - (state.stock.get(itemId) ?? 0);
    const price = config.tables.ItemPriceCfg.data.find(row => row.itemId === itemId)?.rubyPrice;
    return { orderKey: view.orderKey, itemId, quantity, cost: quantity * price };
  };
  return {
    client, config, player, state, reports, run, quote,
    get settings() { return settings; },
    setSettings(value) { settings = value; },
    get ledger() { return ledger; },
    reload() { ledger = createUsageLedger(account, { file, now: () => Date.now() + state.dayOffset }); },
  };
}

const names = f => f.state.writes.map(row => row.name);
const successful = f => f.reports.some(row => row.ok && row.key === 'weekOrderSubmit');
let passed = 0;
async function check(name, work) {
  await work();
  passed++;
  console.log('通过 ' + name);
}

try {
  await check('默认关闭自动提交和钻石补料，旧配置也不会自行花钻石', async () => {
    const defaults = defaultSettings();
    assert.equal(defaults.schedule.weekOrderSubmit, false);
    assert.equal(defaults.weekOrder.allowDiamonds, false);
    for (const change of [f => { f.settings.schedule.weekOrderSubmit = false; }, f => { delete f.settings.weekOrder; }]) {
      const f = fixture(); change(f); await f.run();
      assert.deepEqual(names(f), []);
    }
  });

  await check('库存齐全时每轮提交一单，钻石开关关闭仍可免费提交', async () => {
    const f = fixture({ ready: true });
    f.settings.weekOrder.allowDiamonds = false;
    f.settings.resources.allowDiamonds = false;
    await f.run();
    assert.deepEqual(names(f), ['FinishWeekOrderRequest']);
    assert.deepEqual(f.state.order.gotRwdId, [1]);
    assert.equal(f.state.ruby, 1000);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert(successful(f));
  });

  await check('缺料补齐需要两个钻石开关和预算、库存保留量同时满足', async () => {
    for (const change of [
      f => { f.settings.weekOrder.allowDiamonds = false; },
      f => { f.settings.resources.allowDiamonds = false; },
      f => { f.settings.resources.diamondDailyLimit = 0; },
      f => { f.settings.resources.diamondDailyLimit = 19; },
      f => { f.settings.resources.diamondDailyLimit = 59; },
      f => { f.settings.resources.diamondThreshold = 981; },
      f => { f.settings.resources.diamondThreshold = 941; },
      f => { f.state.ruby = 19; },
    ]) {
      const f = fixture(); change(f); await f.run();
      assert.deepEqual(names(f), []);
      assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });

  await check('按多个材料的实际缺口购买后提交，记录实际钻石消耗', async () => {
    const f = fixture(); await f.run();
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest', 'CommonBuyGoodsRequest', 'FinishWeekOrderRequest']);
    assert.deepEqual(f.state.writes.slice(0, 2).map(row => row.body.goods), [
      [{ itemId: '木板', num: 2 }], [{ itemId: '布匹', num: 2 }],
    ]);
    assert.equal(f.state.ruby, 940);
    assert.equal(f.ledger.snapshot().counters.diamonds, 60);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert.deepEqual(f.state.order.gotRwdId, [1]);
    assert(successful(f));
  });

  await check('整单报价同时计入其他模块已经占用的全局日预算', async () => {
    const f = fixture();
    f.ledger.reserve({ diamonds: 1950 }, { diamonds: 2000 }, {}, { uniqueKey: 'other-module-pending' });
    await f.run();
    assert.deepEqual(names(f), []);
    assert.equal(f.ledger.pendingCounters().diamonds, 1950);
  });

  await check('缺料没有有效售价时等待，不发送无法报价的购买', async () => {
    const f = fixture({ single: true });
    f.config.tables.ItemPriceCfg.data = [];
    await f.run();
    assert.deepEqual(names(f), []);
  });

  await check('部分购买明确失败后停止，本轮不提交，下一轮仅购买剩余缺口', async () => {
    const f = fixture(); f.state.failures.set(2, 'rejected'); await f.run();
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest', 'CommonBuyGoodsRequest']);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert.equal(f.ledger.snapshot().counters.diamonds, 20);
    await f.run();
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest', 'CommonBuyGoodsRequest', 'CommonBuyGoodsRequest', 'FinishWeekOrderRequest']);
    assert.equal(f.state.writes[2].body.goods[0].itemId, '布匹');
    assert.equal(f.ledger.snapshot().counters.diamonds, 60);
  });

  await check('购买结果未知跨重启和跨日保留预算，手动与自动均不能重复购买', async () => {
    const f = fixture(); const quote = await f.quote();
    f.state.failures.set(1, 'unknown'); await f.run();
    assert.equal(f.ledger.snapshot().uncertain, 1);
    f.state.dayOffset = 86400000; f.reload(); await f.run();
    await assert.rejects(runWeekOrder(f.client, f.config, f.settings, f.ledger, () => true, 'buy', quote, { player: f.player }));
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest']);
    assert.equal(f.ledger.pendingCounters().diamonds, 20);
  });

  await check('收到材料但购买回包丢失时，自动流程保留未知记录并停止提交', async () => {
    const f = fixture({ single: true });
    f.state.failures.set(1, 'lost'); await f.run(); await f.run();
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest']);
    assert.equal(f.ledger.snapshot().uncertain, 1);
    assert.deepEqual(f.state.order.gotRwdId, []);
  });

  await check('购买回执已确认但回读失败时恢复账本，再继续缺口而不重复购买', async () => {
    const f = fixture(); let broken = true;
    f.state.beforeRead = name => {
      if (broken && f.state.writes.length === 1 && name === 'AllItemRequest') throw Error('购买后库存暂时不可读');
    };
    await f.run();
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest']);
    assert.equal(f.ledger.snapshot().uncertain, 1);
    broken = false; f.reload(); await f.run();
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest', 'CommonBuyGoodsRequest', 'FinishWeekOrderRequest']);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert.equal(f.ledger.snapshot().counters.diamonds, 60);
  });

  await check('自动提交结果未知时，下一轮和手动提交共享防重记录', async () => {
    const f = fixture({ ready: true }); const quote = await f.quote();
    f.state.failures.set(1, 'unknown'); await f.run(); f.reload(); await f.run();
    await assert.rejects(runWeekOrder(f.client, f.config, f.settings, f.ledger, () => true, 'submit', quote, { player: f.player }));
    assert.deepEqual(names(f), ['FinishWeekOrderRequest']);
    assert.equal(f.ledger.snapshot().uncertain, 1);
  });

  await check('提交回包丢失但奖励已更新时，自动恢复旧记录并继续新订单', async () => {
    const f = fixture({ ready: true });
    f.state.failures.set(1, 'lost');
    await f.run();
    assert.deepEqual(names(f), ['FinishWeekOrderRequest']);
    assert.deepEqual(f.state.order.gotRwdId, [1]);
    assert.equal(f.ledger.snapshot().uncertain, 1);
    const originalKey = Object.keys(f.ledger.keyRecords())[0];
    f.reload();
    await f.run();
    assert.equal(f.ledger.keyRecords()[originalKey].confirmed, true);
    assert.deepEqual(names(f), ['FinishWeekOrderRequest', 'CommonBuyGoodsRequest', 'FinishWeekOrderRequest']);
    assert.deepEqual(f.state.writes[1].body.goods, [{ itemId: '木板', num: 1 }]);
    assert.deepEqual(f.state.order.gotRwdId, [1, 2]);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert.equal(f.ledger.snapshot().counters.diamonds, 10);
  });

  await check('读取期间关闭开关或暂停时，不再发送购买请求', async () => {
    for (const disable of [
      f => { f.settings.weekOrder.allowDiamonds = false; },
      f => { f.settings.resources.allowDiamonds = false; },
      f => { f.settings.schedule.weekOrderSubmit = false; },
      f => { f.state.active = false; },
    ]) {
      const f = fixture();
      f.state.beforeRead = name => { if (name === 'AllResourceRequest') disable(f); };
      await f.run();
      assert.deepEqual(names(f), []);
      assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });

  await check('读取钻石期间整体替换配置并收紧预算或保留量，发送前采用最新配置', async () => {
    const changes = [
      settings => { settings.resources.diamondDailyLimit = 19; },
      settings => { settings.resources.diamondThreshold = 981; },
      settings => { settings.resources.allowDiamonds = false; },
      settings => { settings.weekOrder.allowDiamonds = false; },
    ];
    for (const resourceRead of [1, 2]) {
      for (const change of changes) {
        const f = fixture();
        let reads = 0;
        f.state.beforeRead = name => {
          if (name !== 'AllResourceRequest' || ++reads !== resourceRead) return;
          const next = structuredClone(f.settings);
          change(next);
          f.setSettings(next);
        };
        await f.run();
        assert.equal(reads, resourceRead, '必须在指定资源读取阶段实际替换配置');
        assert.deepEqual(names(f), []);
        assert.equal(f.ledger.snapshot().uncertain, 0);
      }
    }
  });

  await check('整单报价或实际买入前读取资源时活动到期，不写入也不占用预算', async () => {
    for (const resourceRead of [1, 2]) {
      const f = fixture();
      let reads = 0;
      f.state.beforeRead = name => {
        if (name !== 'AllResourceRequest' || ++reads !== resourceRead) return;
        f.client.serverClockOffsetMs = (f.state.window.endTime + 1) * 1000 - Date.now();
      };
      await f.run();
      assert.equal(reads, resourceRead);
      assert.deepEqual(names(f), []);
      assert.deepEqual(f.ledger.keyRecords(), {});
      assert.equal(f.ledger.snapshot().uncertain, 0);
      assert.equal(f.ledger.snapshot().counters.diamonds ?? 0, 0);
    }
  });

  await check('首种材料购买后订单需求变化，停止原单剩余购买和提交', async () => {
    const f = fixture();
    const before = await readWeekOrder(f.client, undefined, f.config);
    f.state.afterWrite = () => {
      f.state.order.order = [{ id: '木板', num: 3 }, { id: '布匹', num: 3 }];
    };
    await f.run();
    const after = await readWeekOrder(f.client, undefined, f.config);
    assert.notEqual(after.orderKey, before.orderKey);
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest']);
    assert.deepEqual(f.state.order.gotRwdId, []);
    assert.equal(f.ledger.snapshot().uncertain, 0);
    assert.equal(f.ledger.snapshot().counters.diamonds, 20);
  });

  await check('首种材料购买后关闭自动完成时，不继续购买或提交', async () => {
    const f = fixture();
    f.state.afterWrite = () => { f.settings.schedule.weekOrderSubmit = false; };
    await f.run();
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest']);
    assert.deepEqual(f.state.order.gotRwdId, []);
  });

  await check('活动结束、尚未开放、档位已全部完成时跳过订单', async () => {
    for (const change of [
      f => { f.state.window.endTime = f.state.window.startTime + 1; },
      f => { f.state.window.startTime = f.state.window.endTime - 1; },
      f => { f.state.order.gotRwdId = [1, 2, 3]; },
      f => { f.state.order.isGotFinal = true; },
    ]) {
      const f = fixture(); change(f); await f.run(); assert.deepEqual(names(f), []);
    }
  });

  await check('正常挂机入口执行自动补齐和提交，报告归属现有周订单任务', async () => {
    const f = fixture(); const reports = [];
    await runLoop(f.client, protocol, {
      config: f.config, player: f.player, allowMutate: true, rounds: 1, everyMs: 0,
      getSettings: () => f.settings, isEnabled: key => key === 'weekOrderSubmit',
      usageLedger: f.ledger, onStep: entry => reports.push(entry),
    });
    assert.deepEqual(names(f), ['CommonBuyGoodsRequest', 'CommonBuyGoodsRequest', 'FinishWeekOrderRequest']);
    assert(reports.some(row => row.taskKey === 'weekOrderSubmit' && row.ok));
    assert.deepEqual(reports.filter(row => row.ok === false && !row.skipped), []);
    assert.deepEqual(f.state.protocolErrors, [], '整轮入口必须仅调用声明协议');
  });

  console.log('不差钱商人自动订单专项 ' + passed + ' 组通过');
} finally {
  assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
