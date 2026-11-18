// 世界 Boss 多舰队首战：使用虚构舰队及临时账本，不连接游戏或读取账号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createUsageLedger, defaultSettings } from '../src/automation-settings.mjs';
import { readWorldBoss, runWorldBoss } from '../src/world-boss.mjs';
import { dispatchReservationReason, fleetRecordReason, reconcileBossFleets } from '../src/fleet-availability.mjs';
import { settleFleetSnapshot } from '../src/fleet-settlement.mjs';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-world-boss-fleets-'));
const player = { playerId: '9007199254740993', worldId: '1001001', level: 37 };
const now = () => Math.floor(Date.now() / 1000);
const today = () => Math.floor((now() + 28800) / 86400);
const batchKey = () => 'world-boss:' + player.worldId + ':' + today();
let sequence = 0, passed = 0;
const ids = ['1远征船', '2远征船', '3远征船'];
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };

function fixture({ selected = ids, fuel = 2000, mode = 'ok' } = {}) {
  const accountId = 'boss-batch-' + ++sequence;
  const file = path.join(directory, accountId + '.json');
  const settings = defaultSettings();
  Object.assign(settings.worldBoss, { enabled: true, fleetIds: [...selected] });
  const state = { fuel, count: 0, fleetReads: 0, onFleetRead: null, mode,
    fleets: ids.map(buildingId => ({ buildingId, state: 1, curGridIdx: 0, targetGridIdx: 0,
      treasureLootUid: 0, durability: 100, maxDura: 100 })) };
  const config = { tables: {
    ModuleOpenCfg: { data: [{ moduleId: '世界', playerLevel: 16 }] },
    WorldParamCfg: { data: [{ paramName: '进攻首领消耗汽油', paramValue: 300 }] },
  } };
  const ledger = createUsageLedger(accountId, { file });
  const reports = [], client = new EventEmitter();
  client.connected = true; client.serverClockOffsetMs = 0; client.writes = []; client.reads = [];
  client.request = async (name, body = {}, response) => {
    if (name === 'ChallengeWorldBossRequest') {
      assert.equal(response, 'OkResponse');
      assert.equal(body.bossId, 2);
      assert(body.fleetBuildingIds.length > 0);
      assert.equal(new Set(body.fleetBuildingIds).size, body.fleetBuildingIds.length);
      assert.equal(ledger.pendingCounters().worldBossPetrol, 300 * body.fleetBuildingIds.length,
        '批次发送前按每队费用占用总汽油');
      for (const id of body.fleetBuildingIds) assert(fleetRecordReason(ledger.keyRecords(), id, player.worldId), id + ' 发送前已有在途记录');
      client.writes.push({ name, body: structuredClone(body) });
      if (state.mode === 'unknown') throw new Error('虚构网络超时');
      if (state.mode === 'rejected') throw Object.assign(new Error('虚构服务端拒绝'), { prompt: true, request: name });
      state.count = 1;
      state.fuel -= 300 * body.fleetBuildingIds.length;
      const observed = state.mode === 'partially-observed' ? body.fleetBuildingIds.slice(0, 1) : body.fleetBuildingIds;
      for (const id of observed) Object.assign(state.fleets.find(fleet => fleet.buildingId === id), { state: 2, targetGridIdx: 100 });
      return {};
    }
    client.reads.push(name);
    assert.equal(response, name.replace('Request', 'Response'));
    if (name === 'WorldBossInfoRequest') return { info: { bossId: 2, gridIdx: 100, bestDamage: 0, gotRewardLevel: 0 } };
    if (name === 'CounterInfoRequest') return { counters: [{ type: 'DAILY_WORLD_BOSS_TIMES', num: state.count, updateTime: now() }] };
    if (name === 'MyFleetsRequest') {
      state.onFleetRead?.(++state.fleetReads);
      return { fleets: structuredClone(state.fleets) };
    }
    if (name === 'OnWaterRequest') return { building: ids.map((buildingId, index) => ({ buildingId, level: 1,
      fleet: { formation: { presetId: 1, heroPositions: [{ heroId: '虚构英雄' + index, pos: { x: 1, y: 1 } }] } } })) };
    if (name === 'AllItemRequest') return { items: [{ itemId: '汽油', num: state.fuel }] };
    assert.fail('未选择临时阵容时不应有额外读取：' + name);
  };
  const options = { getSettings: () => settings, ledger, enabled: () => true, report: entry => reports.push(entry) };
  return { accountId, file, settings, state, config, ledger, reports, client, options,
    run: (selectedLedger = ledger) => runWorldBoss(client, config, player, { ...options, ledger: selectedLedger }),
    children: () => Object.entries(ledger.keyRecords()).filter(([, record]) => record.details?.kind === 'worldBoss'),
  };
}

try {
  await test('勾选三队一次出战，按三队记账且每队有独立在途保护', async () => {
    const f = fixture();
    const preview = await readWorldBoss(f.client, f.config, player, f.settings, f.ledger);
    assert.deepEqual(preview.selectedFleetIds, ids);
    assert.equal(preview.cost, 300);
    assert.equal(preview.totalCost, 900);
    assert.deepEqual(f.ledger.keyRecords(), {});
    await f.run();
    assert.deepEqual(f.client.writes.map(row => row.body.fleetBuildingIds), [ids]);
    assert.equal(f.ledger.confirmedCounters().worldBossPetrol, 900);
    assert.equal(f.ledger.pendingCounters().worldBossPetrol ?? 0, 0);
    assert.equal(f.ledger.keyRecords()[batchKey()].details.kind, 'worldBossBatch');
    assert.equal(f.children().length, 3);
    for (let index = 0; index < ids.length; index++) {
      const key = batchKey() + ':fleet:' + (index + 1);
      assert.equal(f.ledger.keyRecords()[key].details.buildingId, ids[index]);
      assert(fleetRecordReason(f.ledger.keyRecords(), ids[index], player.worldId));
    }
    assert(f.reports.some(entry => entry.ok));
    await f.run();
    assert.equal(f.client.writes.length, 1, '每日首战已提交后不再次出征');
  });

  await test('明确选择只使用所选舰队，忙碌队跳过后按实际出战队数收费', async () => {
    const partial = fixture({ selected: [ids[0], ids[2]] });
    await partial.run();
    assert.deepEqual(partial.client.writes[0].body.fleetBuildingIds, [ids[0], ids[2]]);
    assert.equal(fleetRecordReason(partial.ledger.keyRecords(), ids[1], player.worldId), '');
    assert.equal(partial.ledger.confirmedCounters().worldBossPetrol, 600);
    const busy = fixture();
    Object.assign(busy.state.fleets[1], { state: 2, targetGridIdx: 999 });
    await busy.run();
    assert.deepEqual(busy.client.writes[0].body.fleetBuildingIds, [ids[0], ids[2]]);
    assert.equal(busy.ledger.confirmedCounters().worldBossPetrol, 600);
  });

  await test('汽油须满足所有本次出战舰队，并扣除其他待确认消耗', async () => {
    for (const pending of [false, true]) {
      const f = fixture({ fuel: pending ? 1000 : 899 });
      if (pending) f.ledger.reserve({ radarPetrol: 101 }, {}, {}, { uniqueKey: 'fake-radar-pending' });
      const records = structuredClone(f.ledger.keyRecords());
      const preview = await readWorldBoss(f.client, f.config, player, f.settings, f.ledger);
      assert.match(preview.reason, /汽油/);
      assert.deepEqual(f.ledger.keyRecords(), records, '预览不写账本');
      await f.run();
      assert.deepEqual(f.client.writes, []);
      assert(!f.ledger.hasKey(batchKey()));
      assert.equal(f.ledger.pendingCounters().worldBossPetrol ?? 0, 0);
    }
  });

  await test('未明确勾选时保留旧账号行为，只派一支可用舰队', async () => {
    const f = fixture({ selected: [], fuel: 300 });
    Object.assign(f.state.fleets[0], { state: 3, curGridIdx: 999 });
    await f.run();
    assert.deepEqual(f.client.writes[0].body.fleetBuildingIds, [ids[1]]);
    assert.equal(f.ledger.confirmedCounters().worldBossPetrol, 300);
    assert.equal(f.children().length, 1);
  });

  await test('发送前其中一队状态变化时取消整个已计划批次', async () => {
    const f = fixture();
    f.state.onFleetRead = count => {
      if (count === 2) Object.assign(f.state.fleets[1], { state: 2, targetGridIdx: 999 });
    };
    await f.run();
    assert.deepEqual(f.client.writes, []);
    assert.equal(f.ledger.pendingCounters().worldBossPetrol ?? 0, 0);
    assert.equal(f.children().length, 0);
    for (const id of ids) assert.equal(dispatchReservationReason(f.client, f.settings, 'radar', id), '');
  });

  await test('明确拒绝撤销整批费用和每队占用，之后可重新尝试', async () => {
    const f = fixture({ mode: 'rejected' });
    await f.run();
    assert.equal(f.client.writes.length, 1);
    assert.equal(f.ledger.pendingCounters().worldBossPetrol ?? 0, 0);
    assert.equal(f.ledger.confirmedCounters().worldBossPetrol ?? 0, 0);
    assert(!f.ledger.hasKey(batchKey()));
    assert(f.reports.some(entry => entry.status === 'rejected'));
    for (const id of ids) {
      assert.equal(fleetRecordReason(f.ledger.keyRecords(), id, player.worldId), '');
      assert.equal(dispatchReservationReason(f.client, f.settings, 'radar', id), '');
    }
    f.state.mode = 'ok';
    await f.run();
    assert.equal(f.client.writes.length, 2);
    assert.equal(f.ledger.confirmedCounters().worldBossPetrol, 900);
  });

  await test('结果未知保留整批汽油与每队记录，重建账本后也不重复发送', async () => {
    const f = fixture({ mode: 'unknown' });
    await f.run();
    assert.equal(f.ledger.pendingCounters().worldBossPetrol, 900);
    assert.equal(f.children().length, 3);
    assert(!f.reports.some(entry => entry.ok));
    for (const id of ids) assert(fleetRecordReason(f.ledger.keyRecords(), id, player.worldId));
    const restarted = createUsageLedger(f.accountId, { file: f.file });
    await f.run(restarted);
    assert.equal(f.client.writes.length, 1);
    assert.equal(restarted.pendingCounters().worldBossPetrol, 900);
  });

  await test('每队独立确认返航，只释放已观察到回城的舰队', async () => {
    const f = fixture();
    await f.run();
    for (const [, record] of f.children()) assert.equal(record.details.observed, true);
    Object.assign(f.state.fleets[0], { state: 1, curGridIdx: 0, targetGridIdx: 0 });
    reconcileBossFleets(f.ledger, f.state.fleets, player.worldId);
    assert.equal(fleetRecordReason(f.ledger.keyRecords(), ids[0], player.worldId), '');
    for (const id of ids.slice(1)) assert(fleetRecordReason(f.ledger.keyRecords(), id, player.worldId));
    for (const fleet of f.state.fleets) Object.assign(fleet, { state: 1, curGridIdx: 0, targetGridIdx: 0 });
    reconcileBossFleets(f.ledger, f.state.fleets, player.worldId);
    for (const id of ids) assert.equal(fleetRecordReason(f.ledger.keyRecords(), id, player.worldId), '');
    await f.run();
    assert.equal(f.client.writes.length, 1, '返航不能清除每日防重标记');
  });

  await test('每日计数只能确认批次，不能把未观察到出发的其他舰队直接释放', async () => {
    const f = fixture({ mode: 'partially-observed' });
    await f.run();
    assert.equal(f.ledger.confirmedCounters().worldBossPetrol, 900);
    assert.equal(f.ledger.keyRecords()[batchKey()].confirmed, true);
    const children = f.children().map(([, record]) => record);
    assert.equal(children.find(record => record.details.buildingId === ids[0]).confirmed, true);
    for (const id of ids.slice(1)) {
      const record = children.find(record => record.details.buildingId === id);
      assert.equal(record.confirmed, false);
      assert.notEqual(record.details.active, false);
    }
    reconcileBossFleets(f.ledger, f.state.fleets, player.worldId);
    for (const id of ids.slice(1)) assert(fleetRecordReason(f.ledger.keyRecords(), id, player.worldId), '仅看到主城空闲不能判定已经返航');
    await f.run();
    assert.equal(f.client.writes.length, 1);
  });

  await test('未知派遣等待15分钟且确在主城才释放舰队，仍保留汽油和每日防重', async () => {
    const f = fixture({ mode: 'unknown' }); await f.run();
    const sentAt = f.children()[0][1].details.sentAt;
    const settleAt = elapsed => settleFleetSnapshot(f.ledger, { worldId: player.worldId, fleets: f.state.fleets, now: sentAt + elapsed });
    settleAt(899);
    for (const id of ids) assert(fleetRecordReason(f.ledger.keyRecords(), id, player.worldId));
    Object.assign(f.state.fleets[2], { state: 2, targetGridIdx: 200 });
    settleAt(900);
    for (const id of ids.slice(0, 2)) assert.equal(fleetRecordReason(f.ledger.keyRecords(), id, player.worldId), '');
    assert(fleetRecordReason(f.ledger.keyRecords(), ids[2], player.worldId), '仍在航行时不能恢复');
    assert.equal(f.ledger.keyRecords()[batchKey()].confirmed, false);
    assert.equal(f.ledger.pendingCounters().worldBossPetrol, 900);
    await f.run(); assert.equal(f.client.writes.length, 1, '释放占用不允许同日重发');
    const nextDay = (today() + 1) * 86400 - 28800;
    for (const [key, record] of f.children()) {
      f.ledger.updateKeyDetails(key, { ...record.details, active: true, sentAt: nextDay - 1, day: today() });
    }
    settleFleetSnapshot(f.ledger, { worldId: player.worldId, fleets: f.state.fleets, now: nextDay });
    for (const id of ids) assert(fleetRecordReason(f.ledger.keyRecords(), id, player.worldId), '跨日一秒不足以释放未知派遣');
  });

  await test('历史单舰队每日标记继续阻止同日批量重发', async () => {
    const f = fixture();
    const ticket = f.ledger.reserve({ worldBossPetrol: 300 }, {}, {}, { uniqueKey: batchKey(),
      details: { kind: 'worldBoss', buildingId: ids[0], bossId: 2, grid: 100, day: today(), sentAt: now(), active: true } });
    f.ledger.confirm(ticket);
    await f.run();
    assert.deepEqual(f.client.writes, []);
    assert.equal(f.ledger.confirmedCounters().worldBossPetrol, 300);
  });
  console.log('世界Boss多舰队专项 ' + passed + '/' + passed + ' 通过');
} finally {
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert(path.basename(resolved).startsWith('cw-world-boss-fleets-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
