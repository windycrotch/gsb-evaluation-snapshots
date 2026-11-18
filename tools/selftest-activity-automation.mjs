import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { activityAutomationFields, activityAutomationControl, activityTaskEnabled, weeklyActivityEnabled } from '../src/activity-automation.mjs';
import { defaultSettings, validateSettings, importAutomationSettings, createUsageLedger, SETTINGS_FORMAT } from '../src/automation-settings.mjs';
import { nativePreferenceEnabled, worldActionAllowed } from '../src/automation-policy.mjs';
import { claimWeekSupply } from '../src/missing-rewards.mjs';
import { runAutomaticWeekOrder } from '../src/activities.mjs';
import { merchantActivity } from '../src/merchant-activity.mjs';
import { runLoop } from '../src/loop.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-activity-automation-'));
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
const set = (settings, key, value) => { const [group, field] = key.split('.'); settings[group][field] = value; };
const ledger = name => createUsageLedger(name, { file: path.join(directory, name + '.json') });

try {
  await test('活动开关按稳定活动类型绑定，历史期次、占位入口和超凡英雄共用既有选择', () => {
    assert.equal(new Set(activityAutomationFields.map(field => field.key)).size, activityAutomationFields.length);
    for (const [row, key] of [
      [{ id: 'merchant' }, 'merchant.enabled'], [{ id: 'rich-merchant' }, 'weekOrder.enabled'],
      [{ id: 'archive:old', sourceId: 'weekly:5:9:100' }, 'weekOrder.enabled'],
      [{ id: 'weekly:6:8:200', weekType: 6 }, 'activityAutomation.weekChip'],
      [{ id: 'hero-raid:1' }, 'heroRaid.enabled'], [{ id: 'hero-raid:2' }, 'heroRaid.enabled'],
      [{ id: 'linkage:123:28' }, 'activityAutomation.compass'],
      [{ id: 'linkage:123:10' }, 'activityAutomation.festivalGifts'],
      [{ id: 'newbie:100' }, 'activityAutomation.newbie'], [{ id: 'beauty' }, 'activityAutomation.beauty'],
      [{ id: 'openrank:3:100' }, 'activityAutomation.openRank'], [{ id: 'pirates' }, 'activityAutomation.pirates'],
    ]) assert.equal(activityAutomationControl(row)?.key, key);
    for (const id of ['spring', 'magicOcean', 'festival:123']) assert.equal(activityAutomationControl({ id }), null);
  });

  await test('所有活动总开关阻断对应旧任务和别名，细项选择保持原值', () => {
    for (const field of activityAutomationFields) {
      const settings = defaultSettings(), selections = structuredClone(settings.schedule);
      set(settings, field.key, false);
      for (const key of field.taskKeys) {
        assert.equal(activityTaskEnabled(settings, key), false, field.key + ' / ' + key);
        assert.equal(nativePreferenceEnabled(settings, key), false, field.key + ' / ' + key);
      }
      assert.deepEqual(settings.schedule, selections);
      set(settings, field.key, true);
      for (const key of field.taskKeys) assert.equal(activityTaskEnabled(settings, key), true, key);
    }
  });

  await test('旧配置缺省活动总开关补为关闭，显式开启及原细项均保留', () => {
    const old = validateSettings(defaultSettings());
    delete old.activityAutomation; delete old.merchant.enabled; delete old.weekOrder.enabled;
    old.schedule.merchantTrade = false; old.schedule.weekOrderSubmit = true; old.heroRaid.enabled = false;
    const snapshot = structuredClone(old);
    for (const restored of [validateSettings(old, { partial: true }), importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings: old })]) {
      assert.equal(restored.merchant.enabled, false); assert.equal(restored.weekOrder.enabled, false);
      assert(Object.values(restored.activityAutomation).every(enabled => enabled === false));
      assert.deepEqual(restored.schedule, old.schedule); assert.equal(restored.heroRaid.enabled, false);
    }
    assert.deepEqual(old, snapshot);
    const explicit = validateSettings(defaultSettings());
    explicit.activityAutomation.river = explicit.weekOrder.enabled = explicit.merchant.enabled = true;
    assert.deepEqual(validateSettings(explicit), explicit);
  });

  await test('关闭活动后的自动订单、走商入口停止读取和写入', async () => {
    const settings = defaultSettings();
    settings.weekOrder.enabled = settings.merchant.enabled = false;
    settings.schedule.weekOrderSubmit = settings.schedule.merchantTrade = true;
    const client = new EventEmitter(); client.connected = true;
    client.request = async name => { throw Error('关闭后不应请求 ' + name); };
    const output = [], options = { getSettings: () => settings, settings: () => settings, enabled: () => true, report: value => output.push(value) };
    await runAutomaticWeekOrder(client, {}, options);
    await merchantActivity(client, {}, { ...options, key: 'merchantTrade' });
    assert(output.every(entry => entry.skipped));
  });

  await test('周补给旧共享开关逐活动执行，关闭其中一期仍可领取其余活动', async () => {
    const settings = defaultSettings();
    settings.activityAutomation.weekChip = true;
    settings.activityAutomation.weekLottery = settings.activityAutomation.weekUnique = false;
    assert.equal(activityTaskEnabled(settings, 'weekSupplyFree'), true);
    assert.equal(weeklyActivityEnabled(settings, 4), false);
    const now = Math.floor(Date.now() / 1000), calls = [];
    let got = false;
    const client = { async request(name) {
      calls.push(name);
      if (name === 'WeekInfoRequest') return { activityTime: [4, 6, 7].map(type => ({ type, period: 1, startTime: now - 30, endTime: now + 300 })) };
      if (name === 'WeekChipInfoRequest') return { gifts: got ? [{ giftId: 1, paidTimes: 1 }] : [] };
      assert.equal(name, 'WeekChipGotFreeRequest'); got = true;
      return { reward: { asset: [{ id: 'RUBY', num: 1 }] } };
    } };
    await claimWeekSupply(client, { tables: { WeekChipPackCfg: { data: [{ packId: 1, price: 0, limitedTimes: 1 }] } } },
      { getSettings: () => settings, enabled: () => true, ledger: ledger('shared'), report() {} });
    assert.deepEqual(calls, ['WeekInfoRequest', 'WeekChipInfoRequest', 'WeekChipGotFreeRequest', 'WeekChipInfoRequest']);
    settings.activityAutomation.weekChip = false;
    assert.equal(activityTaskEnabled(settings, 'weekSupplyFree'), false);
  });

  await test('海商王读取商船状态期间关闭总开关，随后停止买入走商和领取', async () => {
    for (const key of ['merchantTrade', 'merchantRewards']) {
      const settings = defaultSettings(), now = Math.floor(Date.now() / 1000), calls = [], output = [];
      settings.merchant.enabled = true;
      const client = new EventEmitter(); client.connected = true;
      client.tradeWindow = { period: 1, startTime: now - 30, endTime: now + 300 };
      client.request = async name => {
        calls.push(name); assert.equal(name, 'TradeInfoRequest'); settings.merchant.enabled = false;
        return { period: 1 };
      };
      await merchantActivity(client, { tables: { ModuleOpenCfg: { data: [{ moduleId: '海商王', playerLevel: 1 }] } } },
        { key, player: { level: 40, playerId: 99, worldId: 1, guildId: 2 }, settings: () => settings,
          enabled: () => true, report: row => output.push(row) });
      assert.deepEqual(calls, ['TradeInfoRequest']);
      assert(output.some(row => row.skipped && row.reason.includes('状态已变化')));
    }
  });

  await test('周补给读取期间关闭总开关后阻断待发送领奖', async () => {
    const settings = defaultSettings(), now = Math.floor(Date.now() / 1000), calls = [];
    settings.activityAutomation.weekChip = true;
    const client = { async request(name) {
      calls.push(name);
      if (name === 'WeekInfoRequest') return { activityTime: [{ type: 6, period: 1, startTime: now - 30, endTime: now + 300 }] };
      assert.equal(name, 'WeekChipInfoRequest'); settings.activityAutomation.weekChip = false;
      return { gifts: [] };
    } };
    const usage = ledger('changed');
    await claimWeekSupply(client, { tables: { WeekChipPackCfg: { data: [{ packId: 1, price: 0, limitedTimes: 1 }] } } },
      { getSettings: () => settings, enabled: () => true, ledger: usage, report() {} });
    assert.deepEqual(calls, ['WeekInfoRequest', 'WeekChipInfoRequest']);
    assert.deepEqual(usage.keyRecords(), {});
  });

  await test('已排计划的活动备料随总开关暂停，共用的其它需求仍可执行', () => {
    const settings = defaultSettings();
    settings.loop.world = settings.factory.enabled = settings.factory.produce = settings.weekOrder.enabled = true;
    const step = { kind: 'startProduce', request: 'StartFactoryProduceRequest', body: {}, demandSources: ['merchant'] };
    assert.equal(worldActionAllowed(settings, step, {}), true);
    settings.weekOrder.enabled = false;
    assert.equal(worldActionAllowed(settings, step, {}), false);
    assert.equal(worldActionAllowed(settings, { ...step, demandSources: ['merchant', 'resident'] }, {}), true);
    assert.equal(worldActionAllowed(settings, { ...step, demandSources: ['heroRaid'] }, {}), false);
    settings.heroRaid.enabled = true;
    assert.equal(worldActionAllowed(settings, { ...step, demandSources: ['heroRaid'] }, {}), true);
  });

  await test('正常挂机入口遵守全部活动总开关，即使旧细项与共享别名仍开启', async () => {
    const settings = defaultSettings();
    for (const field of activityAutomationFields) set(settings, field.key, false);
    settings.loop.world = settings.loop.dailies = settings.loop.tasks = false;
    const selected = new Set(activityAutomationFields.flatMap(field => field.taskKeys)); selected.add('weekSupplyFree');
    const client = new EventEmitter(); client.connected = true;
    const calls = [];
    client.request = async name => { calls.push(name); throw Error('关闭后不应请求 ' + name); };
    await runLoop(client, {}, { config: { tables: {} }, player: { level: 40, worldId: 1, playerId: 9991 },
      rounds: 1, allowMutate: true, isEnabled: key => selected.has(key), getSettings: () => settings, usageLedger: ledger('loop') });
    assert.deepEqual(calls, []);
  });

  await test('每日礼包总开关统一覆盖旧罗盘礼包路径，罗盘玩法保持独立', async () => {
    const settings = defaultSettings();
    settings.activityAutomation.compass = true;
    settings.activityAutomation.festivalGifts = false;
    settings.loop.world = settings.loop.dailies = settings.loop.tasks = false;
    assert.equal(activityTaskEnabled(settings, 'compassSpin'), true);
    for (const key of ['festivalGifts', 'festivalFreeGift', 'compassDaily', 'compassAdGift']) {
      assert.equal(nativePreferenceEnabled(settings, key), false, key);
    }
    const now = Math.floor(Date.now() / 1000), calls = [], client = new EventEmitter();
    client.connected = true;
    client.festivals = [{ activityId: 123, type: '捞尸人联动活动', startTime: now - 30, endTime: now + 300,
      subActivity: [{ subActivityType: 28 }, { subActivityType: 6, dailyCombGift: { boughtGiftId: [] } },
        { subActivityType: 10, dailySelectGift: { boughtTimes: {} } }] }];
    client.request = client.sendWatch = async name => { calls.push(name); throw Error('关闭后不应请求 ' + name); };
    const config = { tables: { LinkageLSRLimitPackCfg: { data: [{ packId: 1, price: 0, limitCount: 1, fixedRewards: [['RUBY', 1]] }] },
      LinkageLSRDailyDealCfg: { data: [{ packId: 2, price: 0, limitCount: 1, rewards: [['RUBY', 1]] }] } } };
    await runLoop(client, {}, { config, player: { level: 40, worldId: 1, playerId: 9992 }, rounds: 1, allowMutate: true,
      isEnabled: key => ['festivalGifts', 'festivalFreeGift', 'compassDaily', 'compassAdGift'].includes(key),
      getSettings: () => settings, usageLedger: ledger('festival-gifts') });
    assert.deepEqual(calls, []);
  });
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('活动自动挂机总开关测试 ' + passed + '/' + passed + ' 通过');
