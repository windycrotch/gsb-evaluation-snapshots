import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-activity-catalog-'));
const originalData = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = directory;
const { activityEntries, activityView, runActivity } = await import('../src/activities.mjs');
const { watchHeroRaidPushes } = await import('../src/hero-raid-automation.mjs');
const { activityLifecycle, activityCatalogPushNames, catalogEntry, readActivityCatalog, rememberActivityCatalog, rememberActivityPush, pushedActivityEntries } = await import('../src/activity-catalog.mjs');
const now = Date.UTC(2026, 10, 17, 4) / 1000;
let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const client = () => ({ serverClockOffsetMs: now * 1000 - Date.now(), festivals: [] });
const window = (start = now - 60, end = now + 60) => ({ startTime: start, endTime: end });
const entry = (id, start, end) => catalogEntry({ id, name: id, kind: 'limited', taskKeys: ['edict'], ...window(start, end) }, now);
const writeLegacyCatalog = (account, activities) => {
  const folder = path.join(directory, 'activity-catalog');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, createHash('sha256').update(account).digest('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, activities }));
};

function activityReadFixture() {
  const game = client(), calls = [];
  const config = { tables: {
    WeekOrderRwdCfg: { data: [{ periodId: 1, rwdId: 1 }] },
    WeekLotteryTimesCfg: { data: [{ periodId: 1, rwdId: 1, reqTimes: 10 }] },
  } };
  const state = { fail: null, coins: 2, wood: 3, gotRwdId: [], isGotFinal: false, inFlight: 0 };
  game.request = async (name, body = {}) => {
    calls.push([name, body]);
    assert.equal(++state.inFlight, 1, '活动快照内的游戏请求不能并发');
    try {
      await Promise.resolve();
      if (state.fail === name || state.fail === name + ':' + body.type) throw Error('模拟读取失败：' + name);
      if (name === 'WeekInfoRequest') return { activityTime: [4, 5].map(type => ({ type, period: 1, ...window() })) };
      if (name === 'AllItemRequest') return { items: [{ itemId: '周转盘币', num: state.coins }, { itemId: '木板', num: state.wood }] };
      if (name === 'WeekOrderInfoRequest') return { order: [{ id: '木板', num: 3 }], gotRwdId: state.gotRwdId, isGotFinal: state.isGotFinal };
      if (name === 'CampaignReportsRequest') return { reports: [] };
      if (name === 'OpenRankInfoRequest') return { endTime: now + 60, progress: body.type * 10 };
      if (name === 'WeekLotteryInfoRequest') return { gotInfo: { times: 4 } };
      throw Error('未预期请求：' + name);
    } finally { state.inFlight--; }
  };
  return { game, calls, state, read: () => activityView(game, [], config, {}),
    count: (name, type) => calls.filter(([called, body]) => called === name && (type === undefined || body.type === type)).length };
}

try {
  await test('活动模块导入不会提前固定账号文件目录，测试环境可在导入后隔离', async () => {
    const changed = path.join(directory, 'late-account-directory');
    process.env.CW_DATA_DIR = changed;
    const { DATA_DIR } = await import('../src/accounts.mjs');
    assert.equal(DATA_DIR, changed);
    rememberActivityCatalog('isolated-account', [entry('isolated', now - 100, now - 10)], now);
    assert(fs.existsSync(path.join(changed, 'activity-catalog')));
    process.env.CW_DATA_DIR = directory;
    assert.deepEqual(readActivityCatalog('isolated-account', now), []);
  });

  await test('周目录展示已下发的未来与历史，默认执行目录仅含开放期次', () => {
    const game = client(), weeks = [
      { type: 5, period: 1, ...window() }, { type: 5, period: 2, ...window(now + 100, now + 200) },
      { type: 4, period: 3, ...window(now - 200, now - 100) },
    ];
    const all = activityEntries(game, weeks, [], { includeInactive: true });
    assert.deepEqual(all.map(row => row.lifecycle), ['active', 'upcoming', 'ended']);
    assert(all.every(row => row.startTime > 0 && row.endTime > row.startTime && row.observed));
    assert.equal(activityEntries(game, weeks).length, 1);
    assert.deepEqual(activityEntries(game, [], [], { includeInactive: true }), []);
  });

  await test('节日主副玩法时间取交集，奖励截止单独保留', () => {
    const game = client();
    game.festivals = [{ activityId: 5, type: '捞尸人联动活动', ...window(now - 200, now + 500),
      openTime: now - 100, closeTime: now + 200, subActivity: [{ subActivityType: 29, openTime: now + 50, closeTime: now + 300 }] }];
    const [row] = activityEntries(game, [], game.festivals, { includeInactive: true });
    assert.equal(row.startTime, now + 50);
    assert.equal(row.endTime, now + 200);
    assert.equal(row.rewardEndTime, now + 500);
    assert.equal(row.lifecycle, 'upcoming');
    assert(!activityEntries(game).some(item => item.taskKeys.length));
  });

  await test('免费礼包不同窗口分别归档，结束的旧礼包不能遮住当前礼包', () => {
    const game = client();
    game.festivals = [{ activityId: 6, type: '捞尸人联动活动', ...window(now - 200, now + 500), subActivity: [
      { subActivityType: 6, openTime: now - 200, closeTime: now - 100 },
      { subActivityType: 10, openTime: now - 50, closeTime: now + 300 },
    ] }];
    const all = activityEntries(game, [], game.festivals, { includeInactive: true });
    assert.equal(all.length, 2);
    assert.equal(all.find(row => row.id === 'linkage:6:10').lifecycle, 'active');
  });

  await test('无有效起止时间显示待确认，不能把倒置时间当已结束', () => {
    assert.equal(activityLifecycle({ startTime: now + 200, endTime: now - 1 }, now), 'unknown');
    assert.equal(activityLifecycle({ endTime: now + 100 }, now), 'unknown');
    assert.equal(activityLifecycle({ endTime: now - 100 }, now), 'ended');
    assert.equal(activityLifecycle({ startTime: now - 100, endTime: now }, now), 'ended');
    assert.equal(activityLifecycle({ startTime: now, endTime: now + 100 }, now), 'active');
  });

  await test('完整推送展示真实活动，独立购买礼包及阶梯礼包不进入目录', () => {
    const game = client();
    game.tradeWindow = { period: 1, ...window() };
    game.beautyWindow = { period: 1, ...window(), showEndTime: now + 100 };
    rememberActivityPush(game, 'SCAllActivity', { raid: [{ raidId: 1, startTime: now + 100, finishTime: now + 200 }],
      skinActive: { activeId: 1, ...window() }, goldFish: { period: 1, ...window() },
      limitTimePack: [{ id: 42, finishTime: now + 100 }], backLTPack: [{ id: 43, finishTime: now + 100 }],
      chainPack: [{ chainId: 44, finishTime: now + 100 }], tierActivity: { period: 1, ...window() },
      magicOcean: { openTime: now - 50, closeTime: now + 50 } });
    const all = pushedActivityEntries(game, now);
    for (const id of ['merchant', 'beauty', 'hero-raid:1', 'skinActive', 'goldFish', 'magicOcean']) assert(all.some(row => row.id === id));
    assert(!all.some(row => /^(limitTimePack:|backLTPack:|chainPack:|tierActivity$)/.test(row.id)));
    for (const key of ['limitTimePack', 'backLTPack', 'chainPack', 'tierActivity']) assert.equal(game.activityCatalogWindows[key], undefined);
    assert.equal(all.find(row => row.id === 'hero-raid:1').lifecycle, 'upcoming');
    assert.equal(all.find(row => row.id === 'hero-raid:1').kind, 'weekly');
    assert.equal(all.find(row => row.id === 'beauty').rewardEndTime, now + 100);
  });

  await test('空海商王协议对象不生成活动，有效期次仍显示实际起止时间', () => {
    const game = client();
    for (const trade of [{}, { period: 0, startTime: 0, endTime: 0 }, Object.create({ period: 0, startTime: 0, endTime: 0 })]) {
      game.tradeWindow = trade;
      assert(!pushedActivityEntries(game, now).some(row => row.id === 'merchant'));
    }
    game.tradeWindow = { period: 2, ...window(now + 100, now + 200) };
    const [trade] = pushedActivityEntries(game, now);
    assert.equal(trade.kind, 'weekly');
    assert.equal(trade.lifecycle, 'upcoming');
    assert.equal(trade.startTime, now + 100);
    assert.equal(trade.endTime, now + 200);
  });

  await test('兼容先前写入的空海商王记录，同时保留有时间的历史期次', () => {
    writeLegacyCatalog('legacy-merchant', [entry('merchant', null, null), entry('merchant', now - 200, now - 100)]);
    const saved = readActivityCatalog('legacy-merchant', now);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].kind, 'weekly');
    assert.equal(saved[0].lifecycle, 'ended');
  });

  await test('海商王当前、历史和复开期次统一归入周期活动并保留各期时间', () => {
    const old = entry('merchant', now - 200, now - 100);
    writeLegacyCatalog('merchant-periods', [old]);
    const game = client();
    game.tradeWindow = { period: 2, ...window() };
    const current = pushedActivityEntries(game, now);
    const merged = rememberActivityCatalog('merchant-periods', current, now);
    assert.equal(merged.length, 2);
    assert(merged.every(row => row.kind === 'weekly'));
    assert.equal(merged.find(row => row.observed).lifecycle, 'active');
    assert.equal(merged.find(row => !row.observed).startTime, old.startTime);
    assert.equal(merged.find(row => !row.observed).endTime, old.endTime);
    const saved = readActivityCatalog('merchant-periods', now);
    assert(saved.every(row => row.kind === 'weekly' && row.observed === false));
    assert.equal(saved.find(row => row.startTime === current[0].startTime).lifecycle, 'unknown');
  });

  await test('超凡英雄全量、增量和旧历史统一显示周期活动，时间与期次身份沿用', () => {
    const old = entry('hero-raid:1001', now - 200, now - 100);
    writeLegacyCatalog('hero-periods', [old]);
    const game = client();
    rememberActivityPush(game, 'SCAllActivity', { raid: [
      { raidId: 1001, startTime: now + 100, finishTime: now + 200 },
    ] });
    let current = pushedActivityEntries(game, now);
    assert.equal(current[0].kind, 'weekly');
    assert.equal(current[0].lifecycle, 'upcoming');
    rememberActivityPush(game, 'SCHeroRaidOpen', { raid: {
      raidId: 1001, startTime: now - 50, finishTime: now + 50,
    } });
    current = pushedActivityEntries(game, now);
    const merged = rememberActivityCatalog('hero-periods', current, now);
    assert.equal(merged.length, 2);
    assert(merged.every(row => row.kind === 'weekly'));
    assert.equal(merged.find(row => row.observed).lifecycle, 'active');
    const history = merged.find(row => !row.observed);
    assert.equal(history.instanceId, old.instanceId);
    assert.equal(history.startTime, old.startTime);
    assert.equal(history.endTime, old.endTime);
    assert.equal(history.lifecycle, 'ended');
    const saved = readActivityCatalog('hero-periods', now);
    assert(saved.every(row => row.kind === 'weekly' && row.observed === false));
    assert.equal(saved.find(row => row.startTime === current[0].startTime).lifecycle, 'unknown');
  });

  await test('旧购买礼包历史按来源剔除，保留节日免费礼包和真实活动历史', () => {
    const packs = ['limitTimePack:9950702', 'limitTimePack:9921101', 'backLTPack:3', 'chainPack:4', 'tierActivity']
      .map(id => entry(id, now - 200, now - 100));
    const real = [entry('linkage:6:6', now - 200, now - 100), entry('merchant', now - 200, now - 100)];
    writeLegacyCatalog('legacy-packs', [...packs, ...real]);
    const saved = readActivityCatalog('legacy-packs', now);
    assert.deepEqual(saved.map(row => row.sourceId), real.map(row => row.id));
    assert(saved.every(row => row.lifecycle === 'ended'));
    const merged = rememberActivityCatalog('legacy-packs', packs, now);
    assert.deepEqual(merged.map(row => row.sourceId), real.map(row => row.id));
  });

  await test('购买礼包推送不再记录活动缓存，当前节日免费礼包仍保留入口', () => {
    const game = client();
    for (const name of ['SCLimitTimePack', 'SCBackLimitTimePack', 'SCNewChainPack']) {
      assert(!activityCatalogPushNames.has(name));
      rememberActivityPush(game, name, { pack: [{ id: 9950702, finishTime: now + 100 }] });
    }
    assert.equal(game.activityCatalogWindows, undefined);
    game.festivals = [{ activityId: 6, type: '捞尸人联动活动', ...window(), subActivity: [{ subActivityType: 6 }] }];
    const [row] = activityEntries(game, [], game.festivals, { includeInactive: true });
    assert.equal(row.id, 'linkage:6:6');
    assert.deepEqual(row.taskKeys, ['festivalGifts']);
    assert.equal(row.lifecycle, 'active');
  });

  await test('增量推送更新截止时间，完整活动推送保留独立商船窗口', () => {
    const game = client();
    rememberActivityPush(game, 'SCGuildShipActivity', { period: { period: 1, ...window() } });
    rememberActivityPush(game, 'SCAllActivity', {});
    rememberActivityPush(game, 'SCHeroRaidOpen', { raid: { raidId: 1, startTime: now - 100, finishTime: now + 300 } });
    rememberActivityPush(game, 'SCHeroRaidOpen', { raid: { raidId: 1, startTime: now - 100, finishTime: now + 400 } });
    rememberActivityPush(game, 'SCMagicOceanActivity', { activity: { openTime: now + 20, closeTime: now + 80 } });
    const all = pushedActivityEntries(game, now);
    assert(all.some(row => row.id === 'guildShip'));
    assert.equal(all.filter(row => row.id === 'hero-raid:1').length, 1);
    assert.equal(all.find(row => row.id === 'hero-raid:1').endTime, now + 400);
    assert.equal(all.find(row => row.id === 'magicOcean').lifecycle, 'upcoming');
  });

  await test('按账号保存已观察目录，复开同编号保留旧期次', () => {
    const old = entry('same', now - 200, now - 100), current = entry('same', now - 50, now + 50);
    rememberActivityCatalog('account-a', [old], now);
    const merged = rememberActivityCatalog('account-a', [current], now);
    assert.equal(merged.length, 2);
    assert.equal(merged.find(row => !row.observed).lifecycle, 'ended');
    assert.equal(new Set(merged.map(row => row.id)).size, 2);
    assert.deepEqual(readActivityCatalog('account-b', now), []);
    assert.equal(readActivityCatalog('account-a', now).length, 2);
  });

  await test('超凡英雄活动展示当前连接确认的挑战、订单与抽奖进度', async () => {
    const game = Object.assign(new EventEmitter(), client()), calls = [];
    game.request = async name => {
      calls.push(name);
      if (name === 'WeekInfoRequest') return { activityTime: [] };
      throw Error('没有其他玩法进度');
    };
    const state = watchHeroRaidPushes(game);
    const raid = { raidId: 1001, startTime: now - 100, finishTime: now + 100, passedStage: 3,
      order: { orderId: 4, gotOrderId: 3, gotTimes: 0 }, drawTimesInfo: { times: 20, gotIndex: 1 } };
    rememberActivityPush(game, 'SCAllActivity', { raid: [raid] });
    game.emit('message', { name: 'SCAllActivity', body: { raid: [raid] } });
    const view = await activityView(game, [], { tables: {} }, { level: 1 });
    assert.deepEqual(view.status['hero-raid:1001'].lines, [
      '已通过关卡 3', '当前订单 4 · 已完成订单 3', '累计转盘抽奖 20 次 · 已领取累计抽奖奖励 1 档',
    ]);
    state.raids.get(1001).passedStage = 4;
    const updated = await activityView(game, [], { tables: {} }, { level: 1 });
    assert.equal(updated.status['hero-raid:1001'].lines[0], '已通过关卡 4');
    game.emit('close');
    const disconnected = await activityView(game, [], { tables: {} }, { level: 1 });
    assert.deepEqual(disconnected.status['hero-raid:1001'].lines, ['活动进度待同步']);
    assert(!calls.some(name => name.startsWith('HeroRaid')));
  });

  await test('历史目录不提供实时执行证明，未来与已结束日期可持续查看', () => {
    rememberActivityCatalog('account-c', [entry('active', now - 10, now + 10), entry('future', now + 20, now + 30)], now);
    const cached = readActivityCatalog('account-c', now);
    assert(cached.every(row => row.observed === false));
    assert.equal(cached.find(row => row.sourceId === 'active').lifecycle, 'unknown');
    assert.equal(cached.find(row => row.sourceId === 'future').lifecycle, 'upcoming');
    const later = readActivityCatalog('account-c', now + 30);
    assert(later.every(row => row.lifecycle === 'ended'));
  });

  await test('未来和结束活动只读目录，不调用订单与抽奖进度', async () => {
    const game = client(), calls = [];
    game.request = async name => {
      calls.push(name);
      if (name === 'WeekInfoRequest') return { activityTime: [
        { type: 5, period: 1, ...window(now + 10, now + 100) }, { type: 4, period: 2, ...window(now - 100, now - 1) },
      ] };
      throw Error('没有当前玩法状态');
    };
    const view = await activityView(game, [], { tables: {} }, { level: 1 });
    assert.equal(view.activities.length, 2);
    assert.equal(game.weekActivities.length, 2);
    assert(!calls.includes('WeekOrderInfoRequest'));
    assert(!calls.includes('WeekLotteryInfoRequest'));
    assert.equal(view.order, null);
  });

  await test('单次活动快照复用订单、库存及剿匪冲榜，下一次刷新重新读取', async () => {
    const fixture = activityReadFixture();
    const view = await fixture.read();
    assert.equal(fixture.calls.length, 9, '转盘及商人快照从 13 次减少到 9 次游戏请求');
    assert.equal(fixture.count('WeekOrderInfoRequest'), 1);
    assert.equal(fixture.count('AllItemRequest'), 1);
    assert.equal(fixture.count('OpenRankInfoRequest', 3), 1);
    assert.equal(view.order.ready, true);
    assert.equal(view.order.materials[0].owned, 3);
    assert.match(view.status.pirates.lines[1], /剿匪冲榜 30 分/);
    assert(view.status.openrank.lines.some(line => /剿匪冲榜 30 分/.test(line)));
    fixture.state.coins = 0;
    fixture.state.wood = 1;
    const refreshed = await fixture.read();
    assert.equal(fixture.calls.length, 18);
    assert.equal(fixture.count('WeekOrderInfoRequest'), 2);
    assert.equal(fixture.count('AllItemRequest'), 2);
    assert.equal(fixture.count('OpenRankInfoRequest', 3), 2);
    assert.equal(refreshed.order.ready, false);
    assert.equal(refreshed.order.materials[0].missing, 2);
    assert.equal(refreshed.status['weekly:4:1:' + (now - 60)].ready, false);
  });

  await test('复用读取失败局限于相关活动，失败也不在同轮重试且下次刷新可恢复', async () => {
    for (const failure of ['WeekOrderInfoRequest', 'AllItemRequest', 'OpenRankInfoRequest:3']) {
      const fixture = activityReadFixture();
      fixture.state.fail = failure;
      const view = await fixture.read();
      assert.equal(view.lottery.times, 4, '无关活动仍正常加载');
      const [name, type] = failure.split(':');
      assert.equal(fixture.count(name, type === undefined ? undefined : Number(type)), 1);
      if (name === 'OpenRankInfoRequest') {
        assert.match(view.status.pirates.lines[0], /模拟读取失败/);
        assert.match(view.status.openrank.lines[0], /模拟读取失败/);
        assert.equal(view.order.ready, true);
      } else {
        assert.equal(view.order, null);
        assert.match(view.orderError, /模拟读取失败/);
        assert(view.status.openrank.lines.length > 0);
      }
      fixture.state.fail = null;
      const refreshed = await fixture.read();
      assert.equal(fixture.count(name, type === undefined ? undefined : Number(type)), 2);
      assert.equal(refreshed.order.ready, true);
      assert.equal(refreshed.orderError, undefined);
      assert.match(refreshed.status.pirates.lines[1], /剿匪冲榜 30 分/);
    }
  });

  await test('订单摘要与详情共用最终奖励状态，保持可领和已领的区分', async () => {
    const fixture = activityReadFixture();
    fixture.state.gotRwdId = [1];
    const key = 'weekly:5:1:' + (now - 60);
    const ready = await fixture.read();
    assert.equal(ready.status[key].ready, true);
    assert.deepEqual(ready.status[key].lines, ['最终奖励可领取']);
    assert.equal(ready.order.finalReady, true);
    fixture.state.isGotFinal = true;
    const claimed = await fixture.read();
    assert.equal(claimed.status[key].ready, false);
    assert.deepEqual(claimed.status[key].lines, ['最终奖励已领取']);
    assert.equal(claimed.order.finished, true);
    assert.equal(claimed.order.finalReady, undefined);
    assert.equal(fixture.count('WeekOrderInfoRequest'), 2);
  });

  await test('主活动玩法截止后手动入口拒绝执行，即使领奖展示期仍在', async () => {
    const game = client(), calls = [];
    game.festivals = [{ activityId: 9, ...window(now - 100, now + 100), openTime: now - 100, closeTime: now,
      subActivity: [{ subActivityType: 30, openTime: now - 100, closeTime: now + 100 }] }];
    game.request = async name => { calls.push(name); throw Error(name); };
    await assert.rejects(runActivity(game, { tables: {} }, { activityId: 'linkage:9:30', taskKey: 'evilExpel' }), /活动已结束或尚未开放/);
    assert.equal(calls.length, 0);
  });

  await test('父活动已结束而展示期仍在时，目录不再查询子玩法进度', async () => {
    const game = client(), calls = [];
    game.festivals = [{ activityId: 12, type: '捞尸人联动活动', ...window(now - 100, now + 100),
      openTime: now - 100, closeTime: now, subActivity: [{ subActivityType: 27 }, { subActivityType: 28 }] }];
    game.request = async name => {
      calls.push(name);
      if (name === 'WeekInfoRequest') return { activityTime: [] };
      throw Error('无当前玩法进度');
    };
    const view = await activityView(game, game.festivals, { tables: {} }, { level: 1 });
    assert(view.activities.every(row => row.lifecycle === 'ended'));
    assert(!calls.includes('SnowballDetailRequest'));
    assert(!calls.includes('CompassWheelInfoRequest'));
  });

  await test('读取后同类型活动换期，旧活动不能继续发送动作', async () => {
    const game = client(), calls = [];
    game.festivals = [{ activityId: 9, ...window(), subActivity: [{ subActivityType: 30 }] }];
    game.request = async name => {
      calls.push(name);
      assert.equal(name, 'EvilExpelInfoRequest');
      game.festivals = [{ activityId: 10, ...window(), subActivity: [{ subActivityType: 30 }] }];
      return { alive: 1, killTotal: 0, claimed: 0 };
    };
    await runActivity(game, { tables: {} }, { activityId: 'linkage:9:30', taskKey: 'evilExpel' });
    assert.deepEqual(calls, ['EvilExpelInfoRequest']);
  });
} finally {
  if (originalData === undefined) delete process.env.CW_DATA_DIR; else process.env.CW_DATA_DIR = originalData;
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(`活动目录测试 ${passed}/${passed} 通过`);
