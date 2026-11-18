import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';
import { createActionGuard } from '../src/automation-policy.mjs';
import { defaultSettings, createUsageLedger } from '../src/automation-settings.mjs';
import { upgradeFishingOnce } from '../src/fishing-upgrade.mjs';
import { serviceBoats } from '../src/boats.mjs';
import { runDailies, surveyDailies } from '../src/dailies.mjs';
import { dailySingleState, addDailyOptions, runDailySingle } from '../src/daily-single.mjs';
import { runBaseAutomation } from '../src/base-automation.mjs';
import { beginOrderMaterialSpend, pendingOrderMaterialSpends, refreshOrderMaterialSpends,
  settleOrderMaterialState, settleFarmMaterialSpend, settleMuseumMaterialSpend } from '../src/order-reservations.mjs';
import { reserveGold, pendingGoldSpend, refreshGoldSpend, readGoldSpendState, settleGoldSpendState } from '../src/gold-reservations.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-guard-lifecycle-'));
const protocol = createDeclaredProtocol([
  'OnWaterRequest', 'AllResourceRequest', 'AllItemRequest', 'DailyTaskInfoRequest',
  'FishingLevelUpRequest', 'DivingLevelUpRequest', 'ClickGoldRequest', 'ClickGoldResponse',
  'DrawDailyTaskRewardRequest', 'DrawDailyTaskRewardResponse',
  'AllPetRequest', 'AllPetResponse', 'PetUpgradeFeedRequest', 'UpgradeBuildingRequest',
]);
const config = { tables: {
  ModuleOpenCfg: { data: [{ moduleId: '小玩法升级', playerLevel: 7 }] },
  BuildingCfg: { data: [{ buildingType: '潜水船' }] },
  FishLevelCfg: { data: [1, 2].map(level => ({ level, enhance: 10, cost: ['GOLD', 50], condition: ['钓鱼椅', 1] })) },
  DiveLevelCfg: { data: [1, 2].map(level => ({ level, enhance: 10, cost: ['GOLD', 50], condition: ['潜水船', 1] })) },
} };
let passed = 0, serial = 0;

function fixture(route, mode) {
  const client = new EventEmitter(), events = [];
  client.connected = true;
  client.on('diagnostic', event => { if (event.event === 'operation') events.push(event); });
  const settings = defaultSettings();
  settings.loop.world = settings.gather.enabled = true;
  settings.dailies.enabled = settings.dailies.claimTasks = true;
  settings.gather.upgradeFishing = settings.gather.upgradeDiving = true;
  settings.resources.allowDiamonds = true;
  const ledger = createUsageLedger('fixture', { file: path.join(directory, ++serial + '.json') });
  const guard = createActionGuard(client, () => settings, ledger);
  const callbacks = {
    beforeAction: step => guard.before({ ...step, counters: { ...step.counters, fixtureCalls: 1 } }),
    afterAction: (...args) => {
      if (mode === 'after-unsent') throw Object.assign(new Error('后续记账读取未发送'), { notSent: true, request: 'AllResourceRequest' });
      return guard.after(...args);
    },
    cancelAction: guard.cancel,
  };
  let attempts = 0, sent = 0, claimed = false;
  const task = () => ({ id: 1001, progress: 1, targetProgress: 1, rewardClaimed: claimed });
  client.request = async (name, body = {}) => {
    assert(protocol[name], '显式夹具未声明请求 ' + name);
    if (name === 'OnWaterRequest') return { building: [{ buildingId: '1钓鱼椅', level: 1 }, { buildingId: '1潜水船', level: 1 }],
      fishingLevel: { level: 1, enhance: 0 }, divingLevel: { level: 1, enhance: 0 } };
    if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: 100000 }, { res: 4, amount: 1000 }] };
    if (name === 'AllItemRequest') return { items: [] };
    if (name === 'DailyTaskInfoRequest') {
      if (mode === 'read-unsent' && sent) throw Object.assign(new Error('领取后的回读未发送'), { notSent: true, request: name });
      return { dailyTask: [task()], dailyResetTime: 2000000000 };
    }
    attempts++;
    if (mode === 'write-unsent') throw Object.assign(new Error('主写未发送'), { notSent: true, request: name });
    sent++;
    client.emit('sent', { dir: 'out', name, seq: sent });
    if (mode === 'timeout') throw new Error('等待主写回包超时');
    if (mode === 'rejected') throw Object.assign(new Error('主写被拒绝'), { prompt: {}, request: name });
    if (name === 'DrawDailyTaskRewardRequest') claimed = mode !== 'invalid-reply';
    return { levelInfo: { level: 1, enhance: mode === 'invalid-reply' ? 0 : 1 } };
  };
  const run = async () => {
    if (route === 'fishing') return upgradeFishingOnce(client, config, {
      playerLevel: 10, reserveGold: 0, enabled: () => true, ...callbacks,
    });
    if (route === 'boats') return serviceBoats(client, config, key => key === 'diveEnhance', () => {}, callbacks);
    if (route === 'daily') return runDailies(client, protocol, {
      tasks: [{ task: { id: 1006, title: '点金' }, status: 'paid', actions: [{
        request: 'ClickGoldRequest', response: 'ClickGoldResponse', body: { free: false, times: 1 },
        costs: [{ id: 'RUBY', num: 5 }], note: '测试点金',
      }] }],
    }, { allowMutate: true, allowPaid: true, claimRewards: false, ...callbacks });
    const state = dailySingleState();
    const view = addDailyOptions(await surveyDailies(client, protocol, { config, probeGift: false }), state);
    return runDailySingle(client, protocol, { config, state, token: view.tasks[0].manual.token, wait: async () => {},
      guard: { before: callbacks.beforeAction, after: callbacks.afterAction, cancel: callbacks.cancelAction } });
  };
  return { run, client, events, ledger, attempts: () => attempts, sent: () => sent };
}

function delayedFixture() {
  const player = { playerId: 99010000 + ++serial, worldId: 9999901, level: 40 };
  const settings = defaultSettings(); settings.pet.enabled = settings.pet.advance = true;
  settings.loop.world = settings.gather.enabled = true;
  settings.building.enabled = settings.building.upgrade = true;
  settings.gather.upgradeFishing = true;
  const events = [], client = new EventEmitter(); client.connected = true;
  client.on('diagnostic', event => { if (event.event === 'operation') events.push(event); });
  const state = { stock: 100, fed: 0, gold: 100000, enhance: 0, buildingLevel: 1, writes: 0, invalidStock: false };
  client.request = async function (name) {
    assert(protocol[name], '显式夹具未声明请求 ' + name);
    if (name === 'AllItemRequest') return state.invalidStock ? {} : { items: [{ itemId: 'fish', num: state.stock }] };
    if (name === 'AllPetRequest') return { pets: [{ uid: '101', petId: 'pet1', grade: 1,
      profFeed: [{ attrFeed: [{ times: state.fed }] }] }] };
    if (name === 'AllResourceRequest') return { list: [{ res: 3, amount: state.gold }] };
    if (name === 'OnWaterRequest') return { building: [{ buildingId: '1钓鱼椅', level: state.buildingLevel }],
      fishingLevel: { level: 1, enhance: state.enhance } };
    assert(['PetUpgradeFeedRequest', 'FishingLevelUpRequest', 'UpgradeBuildingRequest'].includes(name));
    this.emit('sent', { dir: 'out', name, seq: ++state.writes });
    state.fed++; state.stock -= 10; state.gold -= 50; state.enhance++; state.buildingLevel++;
    throw new Error('模拟成功后丢回包');
  };
  client.sendWatch = client.request;
  const next = new EventEmitter(); next.connected = true; next.request = client.request; next.sendWatch = client.sendWatch;
  const feed = { kind: 'petAdvanceFeed', setting: 'pet.advance', scope: 'base', request: 'PetUpgradeFeedRequest',
    response: null, body: { buildingId: '1民居' }, costs: [{ id: 'fish', num: 10 }],
    verify: { petUid: '101', grade: 1, fed: 0 }, label: '进阶投喂' };
  const assertConfirmedOnce = () => {
    assert.deepEqual(events.map(event => event.phase), ['reserved', 'sent', 'unknown', 'confirmed']);
    assert.equal(new Set(events.map(event => event.operationId)).size, 1);
    assert.equal(state.writes, 1);
    for (const event of ['sent', 'close', 'state']) assert.equal(client.listenerCount(event), 0);
  };
  return { player, settings, events, client, next, state, feed, assertConfirmedOnce };
}

try {
  for (const route of ['fishing', 'boats', 'daily', 'manual-daily']) {
    const modes = ['success', 'write-unsent', 'timeout', 'rejected', 'after-unsent'];
    if (route !== 'daily') modes.push('invalid-reply');
    if (route === 'manual-daily') modes.push('read-unsent');
    for (const mode of modes) {
      const f = fixture(route, mode);
      await f.run().catch(error => assert.match(error.message, /未发送|超时|拒绝|未确认/));
      assert.equal(f.attempts(), 1, route + ' 必须实际到达主写');
      const cancelled = mode === 'write-unsent' || mode === 'rejected';
      const phase = mode === 'success' ? 'confirmed' : cancelled ? 'cancelled' : 'unknown';
      assert.equal(f.events.at(-1)?.phase, phase, route + ' ' + mode);
      assert.equal(f.ledger.snapshot().counters.fixtureCalls, cancelled ? 0 : 1);
      assert.equal(f.ledger.snapshot().uncertain, mode === 'success' || cancelled ? 0 : 1);
      assert.equal(f.events.filter(event => event.phase === 'sent').length, mode === 'write-unsent' ? 0 : 1);
      for (const event of ['sent', 'close', 'state']) assert.equal(f.client.listenerCount(event), 0, route + ' 遗留 ' + event + ' 监听');
      passed++;
      console.log('通过：' + route + ' ' + mode);
    }
  }
  const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };
  for (const budgeted of [false, true]) await test('投喂丢回包后跨连接核销补确认日志，次数预算 ' + budgeted, async () => {
    const f = delayedFixture();
    const ledger = createUsageLedger('fixture', { file: path.join(directory, ++serial + '.json') });
    if (budgeted) f.feed.counters = { fixtureCalls: 1 };
    const result = await runBaseAutomation(f.client, protocol, { tables: {} }, { actions: [f.feed] },
      { player: f.player, getSettings: () => f.settings, ledger });
    assert.equal(result[0].ok, false);
    const handle = pendingOrderMaterialSpends(f.player)[0];
    assert.equal(typeof handle.operation.onConfirmed, budgeted ? 'function' : 'undefined');
    assert.equal(typeof handle.onReconciled, 'function');
    if (!budgeted) {
      f.state.invalidStock = true;
      await refreshOrderMaterialSpends(f.next, f.player);
      assert.equal(pendingOrderMaterialSpends(f.player).length, 1);
      assert.equal(f.events.at(-1).phase, 'unknown');
      f.state.invalidStock = false;
    }
    await refreshOrderMaterialSpends(f.next, f.player);
    await refreshOrderMaterialSpends(f.next, f.player);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    assert.equal(ledger.snapshot().counters.fixtureCalls ?? 0, budgeted ? 1 : 0);
    assert.equal(ledger.snapshot().uncertain, 0);
    f.assertConfirmedOnce();
  });
  await test('金币强化丢回包后跨连接核销补同一操作确认', async () => {
    const f = delayedFixture();
    const guard = createActionGuard(f.client, () => f.settings, null, { player: f.player });
    await assert.rejects(upgradeFishingOnce(f.client, config, { playerLevel: 40, reserveGold: 0, enabled: () => true,
      beforeAction: guard.before, afterAction: guard.after, cancelAction: guard.cancel }), /丢回包/);
    assert(pendingGoldSpend(f.player));
    await refreshGoldSpend(f.next, f.player);
    await refreshGoldSpend(f.next, f.player);
    assert.equal(pendingGoldSpend(f.player), null);
    f.assertConfirmedOnce();
  });
  await test('同一操作材料与金币分别核销只输出一次确认', async () => {
    const f = delayedFixture();
    const guard = createActionGuard(f.client, () => f.settings, null, { player: f.player });
    const step = { request: 'UpgradeBuildingRequest', body: { buildingId: '1钓鱼椅' },
      costs: [{ id: 'fish', num: 10 }, { id: 'GOLD', num: 50 }] };
    const ticket = await guard.before(step);
    try { await f.client.sendWatch(step.request); }
    catch (error) { await guard.cancel(step, ticket, { error }); }
    await refreshOrderMaterialSpends(f.next, f.player);
    await refreshGoldSpend(f.next, f.player);
    await guard.cancel(step, ticket, { error: new Error('重复旧结果') });
    f.assertConfirmedOnce();
  });
  await test('材料与金币日志观察者抛错不会中断实际核销', async () => {
    const f = delayedFixture();
    const handle = beginOrderMaterialSpend(f.player, [{ id: 'fish', have: 100, need: 10 }], '测试',
      { operation: { confirmed: true } });
    handle.onReconciled = () => { throw new Error('材料日志失败'); };
    assert.equal(settleOrderMaterialState(f.player, { account: handle.account, handles: [handle] }, new Map([['fish', 90]])), true);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    const gold = reserveGold(f.player, 100, 10, 'TestRequest', { operation: { confirmed: true } });
    gold.onReconciled = () => { throw new Error('金币日志失败'); };
    const snapshot = await readGoldSpendState(f.next, f.player);
    assert.equal(settleGoldSpendState(f.player, snapshot, 90), true);
    assert.equal(pendingGoldSpend(f.player), null);
  });
  for (const kind of ['farm', 'museum']) await test(kind + '真实核销观察者只调用一次', async () => {
    const f = delayedFixture();
    const details = kind === 'farm' ? { farm: { args: [{ buildingId: '1农田', productId: '小麦' }] } }
      : { museum: { stageId: 1, factor: 1, progress: 0, startTime: 0, endTime: 0, heroIds: ['hero1'] } };
    const handle = beginOrderMaterialSpend(f.player, [{ id: 'fish', have: 100, need: 10 }], '测试', details);
    let calls = 0; handle.onReconciled = () => { calls++; };
    const settle = kind === 'farm' ? settleFarmMaterialSpend : settleMuseumMaterialSpend;
    assert.equal(settle(f.player, handle), true);
    assert.equal(settle(f.player, handle), false);
    assert.equal(calls, 1);
  });
  console.log('操作保护生命周期离线专项 ' + passed + '/' + passed + ' 通过');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
