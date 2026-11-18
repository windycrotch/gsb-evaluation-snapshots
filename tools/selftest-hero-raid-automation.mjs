import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hero-raid-'));
process.env.CW_DATA_DIR = root;
const { createUsageLedger, defaultSettings } = await import('../src/automation-settings.mjs');
const { loadProtocol } = await import('../src/proto.mjs');
const { loadConfig } = await import('../src/config.mjs');
const { watchHeroRaidPushes, runHeroRaidAutomation, heroRaidDemands } = await import('../src/hero-raid-automation.mjs');
const { watchBasePushes } = await import('../src/base-automation.mjs');
const protocol = loadProtocol(), actual = loadConfig(), table = data => ({ data });
let serial = 0, passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('通过：' + name); };
const wire = (name, value) => protocol[name].decode(protocol[name].encode(value).finish());
function fixture() {
  const id = ++serial, now = Math.floor(Date.now() / 1000), start = now - 86400;
  const f = { id, player: { playerId: String(9007199300000000n + BigInt(id)), worldId: '2002001', guildId: '1001', level: 50 },
    settings: defaultSettings(), file: path.join(root, id + '.json'), calls: [], writes: [], reports: [],
    gameRaid: { raidId: 1001, startTime: start, finishTime: now + 86400, passedStage: 0, order: { orderId: 1, gotOrderId: 0, gotTimes: 0 }, drawTimesInfo: { times: 0, gotIndex: 0 } },
    stock: {}, fail: '', lost: '', readHook: null, replyHook: null, wrongReceipt: false, workerOrder: [], disconnected: false, won: true, wait: async () => {} };
  Object.assign(f.settings.heroRaid, { enabled: true, orders: true, rewards: true });
  const orders = actual.tables.HeroRaidOrderCfg.data.filter(row => row.raidId === 1001);
  f.config = { materialName: id => id, tables: { HeroRaidOrderCfg: table(orders), HeroRaidOrderRewardCfg: actual.tables.HeroRaidOrderRewardCfg,
    HeroRaidLotteryTimesCfg: actual.tables.HeroRaidLotteryTimesCfg, HeroRaidLotteryCfg: actual.tables.HeroRaidLotteryCfg,
    HeroRaidStageCfg: actual.tables.HeroRaidStageCfg, CargoUnlockCfg: table([{ index: 1, playerLevel: 9 }]) } };
  for (const row of orders) for (const [item] of row.orderList) f.stock[item] = 500;
  f.ledger = createUsageLedger('hero-' + id, { file: f.file });
  f.connect = () => {
    const client = new EventEmitter(); client.connected = true; client.serverClockOffsetMs = 0;
    watchHeroRaidPushes(client); f.client = client;
    client.request = async (name, body, response) => {
      wire(name, body); f.calls.push(name); await f.readHook?.(name, body, client);
      let value;
      if (name === 'OnWaterRequest') value = { workerOrder: f.workerOrder };
      else if (name === 'AllItemRequest') value = { items: Object.entries(f.stock).map(([itemId, num]) => ({ itemId, num })) };
      else if (name === 'WeekInfoRequest') value = { activityTime: [] };
      else if (name === 'CargoShipsRequest') value = { ship: [] };
      else {
        f.writes.push({ name, body: wire(name, body) });
        if (f.fail === name) throw Object.assign(Error('明确未发送'), { notSent: true });
        if (f.fail === 'reject:' + name) throw Object.assign(Error('服务端拒绝'), { prompt: { prompt: 1 }, request: name });
        if (f.fail === 'unknown:' + name) throw Error('无已知结果');
        assert.equal(body.raidId, f.gameRaid.raidId);
        if (name === 'HeroRaidFinishOrderRequest') {
          const row = orders.find(row => row.orderId === f.gameRaid.order.orderId);
          for (const [item, num] of row.orderList) { assert(f.stock[item] >= num); f.stock[item] -= num; }
          f.gameRaid.order.gotOrderId = row.orderId; f.gameRaid.order.orderId = Math.min(orders.at(-1).orderId, row.orderId + 1);
          value = { order: structuredClone(f.gameRaid.order), reward: { asset: [{ type: 0, id: '英雄副本抽卡券', num: 1 }] } };
        } else if (name === 'HeroRaidGotOrderRewardRequest') {
          const tiers = actual.tables.HeroRaidOrderRewardCfg.data.filter(row => row.raidId === f.gameRaid.raidId && row.orderCount <= f.gameRaid.order.gotOrderId);
          f.gameRaid.order.gotTimes = Math.max(...tiers.map(row => row.orderCount));
          value = { order: structuredClone(f.gameRaid.order), reward: { asset: [{ type: 0, id: '英雄副本抽卡券', num: 1 }] } };
        } else if (name === 'HeroRaidGotRewardRequest') {
          const tiers = actual.tables.HeroRaidLotteryTimesCfg.data.filter(row => row.raidId === f.gameRaid.raidId && row.reqTimes <= f.gameRaid.drawTimesInfo.times);
          f.gameRaid.drawTimesInfo.gotIndex = Math.max(...tiers.map(row => row.index));
          value = { gotInfo: structuredClone(f.gameRaid.drawTimesInfo), reward: { asset: [{ type: 0, id: '橙卡万能碎片', num: 10 }] } };
        } else if (name === 'HeroRaidChallengeRequest') {
          value = { raidId: body.raidId, stageId: body.stageId, initialData: { leftTeam: {}, rightTeams: [{}] } };
          if (f.won) {
            f.gameRaid.passedStage = body.stageId;
            value.reward = { asset: [{ type: 0, id: '英雄副本抽卡券', num: 1 }] };
          }
        } else if (name === 'HeroRaidPrizeRequest') {
          assert(f.stock.英雄副本抽卡券 >= body.times);
          f.stock.英雄副本抽卡券 -= body.times;
          f.gameRaid.drawTimesInfo.times += body.times;
          value = { prizeIndex: 1, gotInfo: structuredClone(f.gameRaid.drawTimesInfo), reward: { asset: [{ type: 0, id: '红技能书', num: 2 }] } };
        } else throw Error('禁止未知写协议：' + name);
        if (f.lost === name) throw Error('服务端已处理，回执丢失');
        if (f.wrongReceipt) value = {};
      }
      return wire(response, f.replyHook?.(name, value) ?? value);
    };
    return client;
  };
  f.connect();
  f.push = (name = 'SCAllActivity') => f.client.emit('message', { name, body: wire(name, name === 'SCAllActivity' ? { raid: [f.gameRaid] } : { raid: f.gameRaid }) });
  f.run = () => runHeroRaidAutomation(f.client, protocol, f.config, f.player, { getSettings: () => f.settings, ledger: f.ledger, enabled: () => true, report: row => f.reports.push(row), wait: f.wait });
  f.demands = () => heroRaidDemands(f.client, f.config, f.player, f.settings, { ledger: f.ledger });
  return f;
}

try {
  await test('没有免费抽次数字段与接口，自动抽奖默认关闭', async () => {
    assert(protocol.HeroRaidPrizeRequest); assert(!protocol.HeroRaidInfoRequest);
    assert.equal('freeTimes' in new protocol.HeroRaidTimes(), false);
    const f = fixture(); f.push(); await f.run(); assert(f.writes.every(row => row.name !== 'HeroRaidPrizeRequest'));
  });
  await test('总开关和订单子开关独立，未接到推送不得按配置造活动', async () => {
    const f = fixture(); await f.run(); assert.equal(f.writes.length, 0); assert.deepEqual(f.demands(), []);
    f.push(); f.settings.heroRaid.enabled = false; await f.run(); assert.equal(f.writes.length, 0);
    f.settings.heroRaid.enabled = true; f.settings.heroRaid.orders = false; await f.run(); assert.equal(f.writes.length, 0);
  });
  await test('登录全量与单个开放推送同步，重连及断开清空旧活动', async () => {
    const f = fixture(), base = watchBasePushes(f.client); f.push(); assert.equal(base.raids.size, 1);
    f.client.emit('login'); assert.equal(base.raids.size, 0); await f.run(); assert.equal(f.writes.length, 0);
    f.push('SCHeroRaidOpen'); await f.run(); assert.equal(f.writes.length, 1);
    f.client.emit('close'); assert.equal(watchHeroRaidPushes(f.client).raids.size, 0);
  });
  await test('真实配置重复材料合并，订单明确回执才推进，下一轮按新订单', async () => {
    const f = fixture(); f.push(); const demand = f.demands()[0];
    assert.equal(demand.requirements.find(row => row.id === '海藻酒').num, 4);
    await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.stock.海藻酒, 496);
    assert.equal(watchHeroRaidPushes(f.client).raids.get(1001).order.gotOrderId, 1);
    await f.run(); assert.equal(f.writes.length, 2); assert.equal(f.gameRaid.order.gotOrderId, 2);
  });
  await test('当前解锁日与活动边界约束订单，最后一单完成后停止生产需求', async () => {
    const f = fixture(); f.gameRaid.order = { orderId: 5, gotOrderId: 4, gotTimes: 3 }; f.gameRaid.startTime = Math.floor(Date.now() / 1000) - 1;
    f.push(); await f.run(); assert.equal(f.writes.length, 0); assert.deepEqual(f.demands(), []);
    f.gameRaid.finishTime = Math.floor(Date.now() / 1000) - 1; f.gameRaid.startTime -= 86400; f.push(); await f.run(); assert.equal(f.writes.length, 0);
    const g = fixture(); const last = g.config.tables.HeroRaidOrderCfg.data.at(-1).orderId; g.gameRaid.order = { orderId: last, gotOrderId: last, gotTimes: last }; g.push();
    g.settings.heroRaid.rewards = false; await g.run(); assert.equal(g.writes.length, 0); assert.deepEqual(g.demands(), []);
  });
  await test('居民订单预留与当前库存共同约束，不足不挪用且不买材料', async () => {
    const f = fixture(); f.stock.漂流瓶 = 3; f.workerOrder = [{ index: 1, requirements: [{ type: 0, id: '漂流瓶', num: 1 }] }]; f.push();
    await f.run(); assert.equal(f.writes.length, 0); assert.match(f.reports.at(-1).reason, /保留其他订单/);
  });
  await test('订单请求未知跨重启防重，真实进度推送后可核销并继续', async () => {
    const f = fixture(); f.push(); f.lost = 'HeroRaidFinishOrderRequest'; await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 1);
    assert.deepEqual(f.demands(), []); f.ledger = createUsageLedger('hero-' + f.id, { file: f.file }); f.lost = ''; await f.run(); assert.equal(f.writes.length, 1);
    f.connect(); f.push(); await f.run(); assert.equal(f.writes.length, 2); assert.equal(f.gameRaid.order.gotOrderId, 2);
  });
  await test('无证据的未知请求跨日保留；明确未发送及拒绝释放记录', async () => {
    const f = fixture(); f.gameRaid.finishTime += 3 * 86400; f.push(); f.fail = 'unknown:HeroRaidFinishOrderRequest'; await f.run();
    const beforeDay = f.ledger.snapshot().day; f.client.serverClockOffsetMs = 86400000;
    f.ledger = createUsageLedger('hero-' + f.id, { file: f.file, now: () => Date.now() + f.client.serverClockOffsetMs });
    f.fail = ''; await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 1); assert.notEqual(f.ledger.snapshot().day, beforeDay);
    for (const failure of ['HeroRaidFinishOrderRequest', 'reject:HeroRaidFinishOrderRequest']) {
      const g = fixture(); g.push(); g.fail = failure; await g.run(); assert.equal(g.ledger.snapshot().uncertain, 0);
      g.fail = ''; await g.run(); assert.equal(g.writes.length, 2);
    }
  });
  await test('明确回执后库存读取失败仍保持消耗防重，不把读取失败当未发送', async () => {
    const f = fixture(); f.push(); f.readHook = name => { if (name === 'AllItemRequest' && f.writes.length) throw Object.assign(Error('读取连接断开'), { notSent: true }); };
    await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 0);
    await f.run(); assert.equal(f.writes.length, 1); f.readHook = null; await f.run(); assert.equal(f.writes.length, 2);
  });
  await test('无效奖励或不匹配订单回执保留票据，不能重复消费', async () => {
    const f = fixture(); f.push(); f.wrongReceipt = true; await f.run(); assert.equal(f.ledger.snapshot().uncertain, 1);
    f.wrongReceipt = false; await f.run(); assert.equal(f.writes.length, 1);
  });
  await test('读取材料期间关闭配置、切角色、推送更新或活动结束均阻止旧计划', async () => {
    for (const change of [f => f.settings.heroRaid.orders = false, f => f.player.playerId = '999', f => { f.gameRaid.order.gotOrderId = 1; f.gameRaid.order.orderId = 2; f.push(); }, f => { f.gameRaid.finishTime = Math.floor(Date.now() / 1000) - 1; f.push(); }]) {
      const f = fixture(); f.push(); f.readHook = name => { if (name === 'AllItemRequest') change(f); }; await f.run(); assert.equal(f.writes.length, 0);
    }
  });
  await test('达标订单与累计抽取奖励分别核验回执，只领取既有进度', async () => {
    const f = fixture(); f.gameRaid.order = { orderId: 3, gotOrderId: 2, gotTimes: 0 }; f.gameRaid.drawTimesInfo = { times: 10, gotIndex: 0 }; f.push();
    await f.run(); assert.deepEqual(f.writes.map(row => row.name), ['HeroRaidFinishOrderRequest', 'HeroRaidGotOrderRewardRequest', 'HeroRaidGotRewardRequest']);
    f.settings.heroRaid.orders = false; await f.run(); assert.equal(f.writes.length, 3);
    assert.equal(watchHeroRaidPushes(f.client).raids.get(1001).drawTimesInfo.gotIndex, 1);
  });
  await test('达标奖励未知后不重领，收到已领档位推送才解除记录', async () => {
    for (const name of ['HeroRaidGotOrderRewardRequest', 'HeroRaidGotRewardRequest']) {
      const f = fixture(); f.settings.heroRaid.orders = false; f.gameRaid.order = { orderId: 4, gotOrderId: 3, gotTimes: name === 'HeroRaidGotOrderRewardRequest' ? 0 : 3 }; f.gameRaid.drawTimesInfo = { times: 10, gotIndex: name === 'HeroRaidGotRewardRequest' ? 0 : 1 }; f.push();
      f.lost = name; await f.run(); assert.equal(f.writes.length, 1); f.lost = ''; await f.run(); assert.equal(f.writes.length, 1);
      f.connect(); f.push(); await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('重复活动编号或不完整推送封锁旧状态，不能并发提交同一订单', async () => {
    const f = fixture(); f.push(); f.client.emit('message', { name: 'SCAllActivity', body: { raid: [f.gameRaid, f.gameRaid] } }); await f.run(); assert.equal(f.writes.length, 0);
    f.push(); await Promise.all([f.run(), f.run()]); assert.equal(f.writes.length, 1);
  });
  await test('自动挑战按真实关卡推进，明确胜利才更新进度，每轮挑战一次', async () => {
    const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, rewards: false, challenge: true }); f.push();
    await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].name, 'HeroRaidChallengeRequest');
    const stages = actual.tables.HeroRaidStageCfg.data.filter(row => row.raidId === 1001);
    assert.equal(f.writes[0].body.stageId, stages[0].stageId); assert.equal(watchHeroRaidPushes(f.client).raids.get(1001).passedStage, stages[0].stageId);
    await f.run(); assert.equal(f.writes[1].body.stageId, stages[1].stageId);
    f.gameRaid.passedStage = stages.at(-1).stageId; f.push(); await f.run(); assert.equal(f.writes.length, 2);
  });
  await test('重试次数为首次挑战后的额外次数，跨轮与重连保存战败额度', async () => {
    const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, rewards: false, challenge: true, retryTimes: 1 }); f.won = false; f.push();
    await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.gameRaid.passedStage, 0); assert.equal(f.ledger.snapshot().uncertain, 0);
    f.ledger = createUsageLedger('hero-' + f.id, { file: f.file }); f.connect(); f.push();
    await f.run(); assert.equal(f.writes.length, 2); await f.run(); assert.equal(f.writes.length, 2); assert.match(f.reports.at(-1).reason, /重试已用完/);
    f.settings.heroRaid.retryTimes = 2; f.won = true; await f.run(); assert.equal(f.writes.length, 3);
    await f.run(); assert.equal(f.writes.length, 4); assert.notEqual(f.writes[3].body.stageId, f.writes[2].body.stageId);
    const g = fixture(); Object.assign(g.settings.heroRaid, { orders: false, rewards: false, challenge: true, retryTimes: 0 }); g.won = false; g.push();
    await g.run(); await g.run(); assert.equal(g.writes.length, 1);
  });
  await test('挑战未知结果与残缺回包不计战败、不重发，通关推送可恢复', async () => {
    for (const failure of ['lost', 'wrongReceipt']) {
      const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, rewards: false, challenge: true });
      if (failure === 'lost') f.lost = 'HeroRaidChallengeRequest'; else f.wrongReceipt = true;
      f.push(); await f.run(); assert.equal(f.ledger.snapshot().uncertain, 1);
      assert(Object.values(f.ledger.keyRecords()).every(row => row.details?.won === undefined));
      f.lost = ''; f.wrongReceipt = false; await f.run(); assert.equal(f.writes.length, 1);
      f.connect(); f.push(); await f.run(); assert.equal(f.writes.length, 2); assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('挑战明确未发送与服务端拒绝不占重试额度，等待限频后复核状态', async () => {
    for (const failure of ['HeroRaidChallengeRequest', 'reject:HeroRaidChallengeRequest']) {
      const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, rewards: false, challenge: true, retryTimes: 0 }); f.push();
      f.fail = failure; await f.run(); assert.equal(f.ledger.snapshot().uncertain, 0);
      f.fail = ''; await f.run(); assert.equal(f.writes.length, 2);
      f.wait = async () => { f.settings.heroRaid.challenge = false; }; await f.run(); assert.equal(f.writes.length, 2);
    }
  });
  await test('挑战错关、缺失战报、空奖励及陌生已通关编号均阻止推进', async () => {
    for (const mutate of [reply => reply.stageId++, reply => reply.raidId++, reply => delete reply.initialData,
      reply => reply.initialData.rightTeams = [], reply => reply.reward = {}]) {
      const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, rewards: false, challenge: true }); f.push();
      f.replyHook = (name, reply) => { if (name === 'HeroRaidChallengeRequest') mutate(reply); return reply; };
      await f.run(); await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 1);
      assert.equal(watchHeroRaidPushes(f.client).raids.get(1001).passedStage, 0);
    }
    const g = fixture(); Object.assign(g.settings.heroRaid, { orders: false, rewards: false, challenge: true }); g.gameRaid.passedStage = 999; g.push();
    await g.run(); assert.equal(g.writes.length, 0);
  });
  await test('转盘按已有券抽取十次或一次，累计进度与奖励自动衔接', async () => {
    const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, lottery: true }); f.stock.英雄副本抽卡券 = 11; f.push();
    await f.run(); assert.deepEqual(f.writes.map(row => row.name), ['HeroRaidPrizeRequest', 'HeroRaidGotRewardRequest']);
    assert.equal(f.writes[0].body.times, 10); assert.equal(watchHeroRaidPushes(f.client).raids.get(1001).drawTimesInfo.times, 10);
    await f.run(); assert.equal(f.writes.at(-1).body.times, 1); assert.equal(f.stock.英雄副本抽卡券, 0);
    await f.run(); assert.equal(f.writes.length, 3); assert.match(f.reports.at(-1).reason, /抽卡券不足/);
    assert(f.writes.every(row => /^HeroRaid/.test(row.name)));
  });
  await test('关闭总开关或转盘子开关时保留券，读库存期间切换状态取消抽奖', async () => {
    for (const change of [f => f.settings.heroRaid.enabled = false, f => f.settings.heroRaid.lottery = false,
      f => f.player.playerId = '999', f => { f.gameRaid.drawTimesInfo.times++; f.push(); },
      f => { f.gameRaid.finishTime = Math.floor(Date.now() / 1000) - 1; f.push(); }]) {
      const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, rewards: false, lottery: true }); f.stock.英雄副本抽卡券 = 10; f.push();
      f.readHook = name => { if (name === 'AllItemRequest') change(f); }; await f.run(); assert.equal(f.writes.length, 0); assert.equal(f.stock.英雄副本抽卡券, 10);
    }
  });
  await test('抽奖未知结果跨重启防重，真实累计次数核销，错误回执不消费第二次', async () => {
    const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, rewards: false, lottery: true }); f.stock.英雄副本抽卡券 = 20; f.push();
    f.lost = 'HeroRaidPrizeRequest'; await f.run(); assert.equal(f.stock.英雄副本抽卡券, 10); assert.equal(f.ledger.snapshot().uncertain, 1);
    f.lost = ''; f.ledger = createUsageLedger('hero-' + f.id, { file: f.file }); await f.run(); assert.equal(f.writes.length, 1);
    f.connect(); f.push(); await f.run(); assert.equal(f.writes.length, 2); assert.equal(f.stock.英雄副本抽卡券, 0); assert.equal(f.ledger.snapshot().uncertain, 0);
    const g = fixture(); Object.assign(g.settings.heroRaid, { orders: false, rewards: false, lottery: true }); g.stock.英雄副本抽卡券 = 20; g.wrongReceipt = true; g.push();
    await g.run(); await g.run(); assert.equal(g.writes.length, 1); assert.equal(g.ledger.snapshot().uncertain, 1);
  });
  await test('抽奖明确拒绝可重试，回执后读取失败保留材料保护', async () => {
    for (const failure of ['HeroRaidPrizeRequest', 'reject:HeroRaidPrizeRequest']) {
      const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, rewards: false, lottery: true }); f.stock.英雄副本抽卡券 = 10; f.push();
      f.fail = failure; await f.run(); assert.equal(f.ledger.snapshot().uncertain, 0); assert.equal(f.stock.英雄副本抽卡券, 10);
      f.fail = ''; await f.run(); assert.equal(f.writes.length, 2); assert.equal(f.stock.英雄副本抽卡券, 0);
    }
    const g = fixture(); Object.assign(g.settings.heroRaid, { orders: false, rewards: false, lottery: true }); g.stock.英雄副本抽卡券 = 20; g.push();
    g.readHook = name => { if (name === 'AllItemRequest' && g.writes.length) throw Object.assign(Error('读取失败'), { notSent: true }); };
    await g.run(); await g.run(); assert.equal(g.writes.length, 1); assert.equal(g.ledger.snapshot().uncertain, 0);
    g.readHook = null; await g.run(); assert.equal(g.writes.length, 2);
  });
  await test('转盘累计次数、领奖档位或奖励不匹配时保留待确认记录', async () => {
    for (const mutate of [reply => reply.gotInfo.times--, reply => reply.gotInfo.gotIndex++, reply => reply.reward = {}]) {
      const f = fixture(); Object.assign(f.settings.heroRaid, { orders: false, rewards: false, lottery: true }); f.stock.英雄副本抽卡券 = 20; f.push();
      f.replyHook = (name, reply) => { if (name === 'HeroRaidPrizeRequest') mutate(reply); return reply; };
      await f.run(); await f.run(); assert.equal(f.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 1);
      assert.equal(watchHeroRaidPushes(f.client).raids.get(1001).drawTimesInfo.times, 0);
    }
  });
  console.log(`${passed}/${passed} 超凡英雄自动化测试通过`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
