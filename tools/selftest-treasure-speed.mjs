// 巨轮加速专项使用虚构状态和真实协议，不连接游戏或读取账号凭据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageLedger, defaultSettings } from '../src/automation-settings.mjs';
import { readTreasureLoot, planTreasureLoot, runTreasureLoot, treasureDispatchKey } from '../src/treasure-loot.mjs';
import { checkFleetSettlement, recordsInWorld } from '../src/fleet-settlement.mjs';
import { fleetRecordReason } from '../src/fleet-availability.mjs';
import { treasureCycleFixture, treasureCycleSettings } from './fixtures/treasure-cycle.mjs';

const parent = path.join(os.tmpdir(), 'cw-treasure-speed-tests');
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'run-'));
const results = [];
let sequence = 0;
const ledger = (options = {}) => createUsageLedger('虚构巨轮加速账号', {
  file: path.join(directory, `ledger-${++sequence}.json`), ...options,
});
const fleetOf = f => f.state.fleets.find(fleet => fleet.buildingId === '1远征船');
const speedKey = f => `treasureSpeed:${f.player.worldId}:${fleetOf(f).treasureLootUid}:1:${fleetOf(f).moveStartTs}`;
const speeds = f => f.client.writes.filter(write => write.name === 'SpeedUpFleetRequest');
const dispatches = f => f.client.writes.filter(write => write.name === 'TreasureLootSendFleetsRequest');
const nowOf = f => Math.floor((Date.now() + (f.client.serverClockOffsetMs || 0)) / 1000);

function fixture() {
  const f = treasureCycleFixture(), s = treasureCycleSettings();
  Object.assign(s.treasure, { marchSpeedUp: true, marchTargetSeconds: 60, dailyDiamondLimit: 300 });
  Object.assign(s.resources, { allowDiamonds: true, diamondDailyLimit: 300, diamondThreshold: 0 });
  f.config.tables.WorldParamCfg.data.push({ paramName: '行军加速消耗', paramValue: 30 });
  f.state.ruby = 1000;
  f.speedMode = 'confirmed';
  const request = f.client.request, send = f.client.sendWatch;
  f.client.request = async (name, body, responseName) => {
    const result = await request(name, body, responseName);
    if (name !== 'AllResourceRequest') return result;
    return f.protocol.AllResourceResponse.decode(f.protocol.AllResourceResponse.encode({
      list: [{ res: 3, amount: f.state.gold }, { res: 4, amount: f.state.ruby }],
    }).finish());
  };
  f.client.sendWatch = async (name, body, options) => {
    if (name !== 'SpeedUpFleetRequest') {
      const result = await send(name, body, options);
      if (name === 'TreasureLootSendFleetsRequest' && !f.unknown && !f.reject) {
        for (const buildingId of body.fleetBuildingIds) {
          Object.assign(f.state.fleets.find(fleet => fleet.buildingId === buildingId), {
            moveStartTs: nowOf(f), moveEndTs: nowOf(f) + 480,
            targetGridIdx: f.state.targets.find(target => target.uid === body.uid).gridIdx,
          });
        }
      }
      return result;
    }
    const decoded = f.protocol.SpeedUpFleetRequest.decode(f.protocol.SpeedUpFleetRequest.encode(body).finish());
    assert.equal(decoded.buildingId, body.buildingId);
    assert.deepEqual(Object.keys(body), ['buildingId']);
    f.client.writes.push({ name, body: structuredClone(body) });
    await f.beforeSend?.(name, body);
    if (f.speedMode === 'rejected') throw Object.assign(new Error('模拟加速被拒绝'), { prompt: { prompt: 1 }, request: name });
    if (f.speedMode === 'notSent') throw Object.assign(new Error('模拟加速确定未发送'), { notSent: true, request: name });
    if (f.speedMode === 'unknown') throw new Error('模拟加速请求超时');
    if (f.speedMode === 'stale') return;
    const fleet = f.state.fleets.find(row => row.buildingId === body.buildingId);
    f.state.ruby -= 30;
    fleet.moveEndTs = nowOf(f) + Math.ceil((fleet.moveEndTs - nowOf(f)) / 2);
  };
  return { f, s };
}

const run = (f, s, usage, options = {}) => runTreasureLoot(f.client, f.protocol, f.config, f.player,
  { getSettings: () => s, ledger: usage, ...options });
const preview = async (f, s, usage, options = {}) => planTreasureLoot(
  await readTreasureLoot(f.client, f.protocol, f.config, f.player, { preferences: s.treasure }), f.config, s,
  { usage: usage.snapshot(), keys: usage.keyRecords(), pendingDiamonds: usage.pendingCounters().diamonds ?? 0, ...options });
async function depart(f, s, usage) {
  const setting = s.treasure.marchSpeedUp;
  s.treasure.marchSpeedUp = false;
  const result = await run(f, s, usage);
  s.treasure.marchSpeedUp = setting;
  assert.equal(dispatches(f).length, 1);
  assert.equal(result.results[0]?.status, 'confirmed');
  assert.equal(speeds(f).length, 0);
}
const check = async (name, work) => {
  try { await work(); results.push({ name, passed: true }); console.log('通过：' + name); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('失败：' + name + '\n' + error.stack); }
};

try {
  await check('默认关闭加速与预算，普通出征保持可用', async () => {
    const defaults = defaultSettings();
    assert.equal(defaults.treasure.marchSpeedUp, false);
    assert.equal(defaults.treasure.marchTargetSeconds, 60);
    assert.equal(defaults.treasure.dailyDiamondLimit, 0);
    const { f, s } = fixture(), usage = ledger();
    s.treasure.marchSpeedUp = false;
    await run(f, s, usage);
    assert.equal(dispatches(f).length, 1);
    assert.equal(speeds(f).length, 0);
    assert.equal(usage.snapshot().counters.diamonds ?? 0, 0);
  });

  await check('出征确认保存航程并在同轮加速，使用真实协议且计入两级钻石预算', async () => {
    const { f, s } = fixture(), usage = ledger();
    const result = await run(f, s, usage);
    assert.equal(dispatches(f).length, 1);
    assert.equal(speeds(f).length, 1);
    assert.equal(result.results.find(row => row.step.kind === 'treasureSpeed')?.status, 'confirmed');
    const record = usage.keyRecords()[treasureDispatchKey(f.player.worldId, 72, '1远征船')];
    assert.equal(record.details.moveStartTs, fleetOf(f).moveStartTs);
    assert.equal(record.details.targetGridIdx, 500);
    assert.equal(usage.snapshot().counters.diamonds, 30);
    assert.equal(usage.snapshot().counters.treasureDiamonds, 30);
    assert.equal(usage.snapshot().counters.treasurePetrol, 500);
    assert.equal(usage.snapshot().uncertain, 0);
    assert.equal(usage.hasKey(speedKey(f)), false);
  });

  await check('只读预览展示在途加速并保持账本和游戏状态', async () => {
    const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
    const records = usage.keyRecords(), writes = f.client.writes.length;
    const plan = await preview(f, s, usage);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].kind, 'treasureSpeed');
    assert.equal(plan.actions[0].request, 'SpeedUpFleetRequest');
    assert.equal(plan.actions[0].costs[0].num, 30);
    assert.deepEqual(usage.keyRecords(), records);
    assert.equal(f.client.writes.length, writes);
    assert.equal(f.state.ruby, 1000);
  });

  await check('每轮最多加速一次，确认后可继续加速至剩余目标', async () => {
    const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
    for (let count = 1; count <= 3; count++) {
      await run(f, s, usage);
      assert.equal(speeds(f).length, count);
      assert.equal(usage.snapshot().counters.treasureDiamonds, 30 * count);
    }
    await run(f, s, usage);
    assert.equal(speeds(f).length, 3);
    assert.equal(dispatches(f).length, 1);
  });

  await check('模块预算、全局预算、钻石开关和保留量分别拦截加速', async () => {
    const changes = [
      s => { s.treasure.dailyDiamondLimit = 0; },
      s => { s.treasure.dailyDiamondLimit = 29; },
      s => { s.resources.allowDiamonds = false; },
      s => { s.resources.diamondDailyLimit = 29; },
      s => { s.resources.diamondDailyLimit = 0; },
      s => { s.resources.diamondThreshold = 971; },
    ];
    for (const change of changes) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage); change(s);
      assert.equal((await preview(f, s, usage)).actions.filter(action => action.kind === 'treasureSpeed').length, 0);
      await run(f, s, usage);
      assert.equal(speeds(f).length, 0);
    }
  });

  await check('保留量边界允许消费，其他玩法待确认钻石占用继续保留', async () => {
    for (const pending of [0, 1]) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
      s.resources.diamondThreshold = 970;
      if (pending) usage.reserve({ diamonds: pending }, {}, {}, { uniqueKey: 'other-speed:1' });
      await run(f, s, usage);
      assert.equal(speeds(f).length, pending ? 0 : 1);
    }
  });

  await check('已用钻石日预算累计到上限后停止下一次加速', async () => {
    const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
    s.treasure.dailyDiamondLimit = 30;
    await run(f, s, usage); await run(f, s, usage);
    assert.equal(speeds(f).length, 1);
    assert.equal(usage.snapshot().counters.treasureDiamonds, 30);
  });

  await check('缺失价格、余额读取失败和超出精度的余额保留普通派遣', async () => {
    for (const kind of ['price', 'read', 'precision']) {
      const { f, s } = fixture(), usage = ledger();
      if (kind === 'price') f.config.tables.WorldParamCfg.data = f.config.tables.WorldParamCfg.data.filter(row => row.paramName !== '行军加速消耗');
      if (kind === 'read') f.beforeRead = name => { if (name === 'AllResourceRequest') throw new Error('模拟钻石读取失败'); };
      if (kind === 'precision') f.state.ruby = '9007199254740993';
      await run(f, s, usage);
      assert.equal(dispatches(f).length, 1);
      assert.equal(speeds(f).length, 0);
    }
  });

  await check('缺少记录或旧记录缺少航程不加速，未知派遣须先由当前航程确认', async () => {
    for (const kind of ['missing', 'legacy', 'unknown']) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
      const key = treasureDispatchKey(f.player.worldId, 72, '1远征船'), details = usage.keyRecords()[key].details;
      usage.releaseCompletedKey(key);
      if (kind !== 'missing') {
        const old = { ...details }; delete old.moveStartTs; delete old.targetGridIdx;
        const ticket = usage.reserve({}, {}, {}, { uniqueKey: key, details: kind === 'legacy' ? old : details });
        if (kind === 'legacy') usage.confirm(ticket);
      }
      assert.equal((await preview(f, s, usage)).actions.filter(action => action.kind === 'treasureSpeed').length, 0);
      await run(f, s, usage);
      assert.equal(speeds(f).length, kind === 'unknown' ? 1 : 0);
      if (kind === 'unknown') assert.equal(usage.keyRecords()[key].confirmed, true);
    }
  });

  await check('多支舰队共用加速预算与可用余额，每支舰队一轮最多一次', async () => {
    const cases = [
      { limit: 30, ruby: 1000, count: 1 },
      { limit: 60, ruby: 1000, count: 2 },
      { limit: 300, ruby: 60, count: 2 },
      { limit: 300, ruby: 59, count: 1 },
    ];
    for (const { limit, ruby, count } of cases) {
      const { f, s } = fixture(), usage = ledger();
      s.treasure.fleetIds = ['1远征船', '2远征船'];
      s.treasure.dailyDiamondLimit = limit;
      f.state.ruby = ruby;
      const result = await run(f, s, usage);
      assert.equal(dispatches(f).length, 2);
      assert.equal(speeds(f).length, count);
      assert.equal(new Set(speeds(f).map(write => write.body.buildingId)).size, count);
      assert.equal(result.results.filter(row => row.step.kind === 'treasureSpeed' && row.status === 'confirmed').length, count);
      assert.equal(usage.snapshot().counters.treasureDiamonds, count * 30);
    }
  });

  await check('只在符合当前货轮参与规则时加速，进度与避战变化即时生效', async () => {
    const changes = [
      f => { f.state.targets[0].progress = 100; },
      f => { f.state.ranks[72] = [{ playerId: f.player.playerId, nickname: f.player.nickname, guildIdx: 7, progress: 20 }]; },
      f => {
        Object.assign(f.state.targets[0], { ownerGuildIdx: 8, ownerFleetNum: 1 });
        f.state.defenders[72] = [{ name: '外盟守军', guildIdx: 8, isNpc: false }];
      },
    ];
    for (const change of changes) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage); change(f);
      await run(f, s, usage);
      assert.equal(speeds(f).length, 0);
    }
  });

  await check('到达、返航、其他货轮、目标格或起始时间变化均不复用旧航程', async () => {
    const changes = [
      fleet => { fleet.state = 3; fleet.curGridIdx = 500; },
      fleet => { fleet.state = 2; fleet.targetGridIdx = 0; },
      fleet => { fleet.treasureLootUid = 71; },
      fleet => { fleet.targetGridIdx = 400; },
      fleet => { fleet.moveStartTs++; },
      fleet => { fleet.moveEndTs = 1; },
    ];
    for (const change of changes) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage); change(fleetOf(f));
      await run(f, s, usage);
      assert.equal(speeds(f).length, 0);
    }
  });

  await check('取消舰队选择或关闭巨轮自动化立即停止在途加速', async () => {
    for (const change of [s => { s.treasure.fleetIds = []; }, s => { s.treasure.enabled = false; }]) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage); change(s);
      await run(f, s, usage);
      assert.equal(speeds(f).length, 0);
    }
  });

  await check('读取期间关闭加速或钻石开关不会发送或占用费用', async () => {
    for (const change of [s => { s.treasure.marchSpeedUp = false; }, s => { s.resources.allowDiamonds = false; }]) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
      f.beforeRead = name => { if (name === 'AllResourceRequest') change(s); };
      await run(f, s, usage);
      assert.equal(speeds(f).length, 0);
      assert.equal(usage.snapshot().counters.diamonds ?? 0, 0);
    }
  });

  await check('发送前航程或账号变化会取消加速', async () => {
    for (const kind of ['journey', 'account']) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
      let resourcesRead = false;
      f.beforeRead = name => {
        if (name === 'AllResourceRequest') resourcesRead = true;
        if (name === 'MyFleetsRequest' && resourcesRead) {
          if (kind === 'journey') fleetOf(f).moveStartTs++;
          else f.player.playerId = '9007199254999999';
        }
      };
      await run(f, s, usage);
      assert.equal(speeds(f).length, 0);
      assert.equal(usage.snapshot().counters.diamonds ?? 0, 0);
    }
  });

  await check('最终读取守军与排名期间换航程，发送前再次核对舰队并取消加速', async () => {
    const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
    let rankingsRead = 0;
    f.beforeRead = name => {
      if (name === 'TreasureLootRankRequest' && ++rankingsRead === 2) fleetOf(f).moveStartTs++;
    };
    await run(f, s, usage);
    assert.ok(rankingsRead >= 2, '需要在初始规划后的复查阶段改变航程');
    assert.equal(speeds(f).length, 0);
    assert.equal(usage.snapshot().counters.diamonds ?? 0, 0);
  });

  await check('请求超时与无提前状态均保留预算和防重，连续检查不会重发', async () => {
    for (const mode of ['unknown', 'stale']) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage); f.speedMode = mode;
      const result = await run(f, s, usage);
      assert.equal(result.results.find(row => row.step.kind === 'treasureSpeed')?.status, 'unknown');
      assert.equal(usage.snapshot().counters.diamonds, 30);
      assert.equal(usage.snapshot().uncertain, 1);
      assert.equal(usage.keyRecords()[speedKey(f)].confirmed, false);
      await run(f, s, usage); await run(f, s, usage);
      assert.equal(speeds(f).length, 1);
    }
  });

  await check('未知请求延迟看到同航程提前结束后确认，预算保持单次消费', async () => {
    const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage); f.speedMode = 'unknown';
    await run(f, s, usage);
    fleetOf(f).moveEndTs = nowOf(f) + 30;
    await run(f, s, usage);
    assert.equal(speeds(f).length, 1);
    assert.equal(usage.snapshot().uncertain, 0);
    assert.equal(usage.confirmedCounters().diamonds, 30);
  });

  await check('未知请求后自然到达与另一航程不会误记加速成功', async () => {
    for (const kind of ['arrival', 'differentJourney']) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage); f.speedMode = 'unknown';
      await run(f, s, usage);
      if (kind === 'arrival') {
        f.client.serverClockOffsetMs = 600000;
        Object.assign(fleetOf(f), { state: 3, curGridIdx: 500, moveEndTs: 0 });
      } else {
        Object.assign(fleetOf(f), { moveStartTs: fleetOf(f).moveStartTs + 1, moveEndTs: nowOf(f) + 30 });
      }
      await run(f, s, usage);
      assert.equal(speeds(f).length, 1);
      assert.equal(usage.snapshot().uncertain, 1);
      assert.equal(usage.confirmedCounters().diamonds ?? 0, 0);
    }
  });

  await check('加速发送后账号变化保留未知费用，不使用另一账号回读确认', async () => {
    const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
    f.beforeSend = name => { if (name === 'SpeedUpFleetRequest') f.player.playerId = '9007199254999999'; };
    const result = await run(f, s, usage);
    assert.equal(speeds(f).length, 1);
    assert.equal(result.results.find(row => row.step.kind === 'treasureSpeed')?.status, 'unknown');
    assert.equal(usage.snapshot().uncertain, 1);
    assert.equal(usage.confirmedCounters().diamonds ?? 0, 0);
  });

  await check('未知加速后确认回港可再出征，新航程独立加速且保留旧钻石预算', async () => {
    const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
    const originalKey = speedKey(f);
    f.speedMode = 'unknown'; await run(f, s, usage);
    f.client.serverClockOffsetMs = 600000;
    f.returnFromTreasure('1远征船');
    f.speedMode = 'confirmed';
    await run(f, s, usage);
    assert.equal(dispatches(f).length, 2);
    assert.equal(speeds(f).length, 2);
    assert.notEqual(speedKey(f), originalKey);
    assert.equal(usage.keyRecords()[originalKey].expired, true);
    assert.equal(usage.keyRecords()[originalKey].confirmed, false);
    assert.equal(usage.snapshot().uncertain, 1);
    assert.equal(usage.pendingCounters().diamonds, 30);
    assert.equal(usage.confirmedCounters().diamonds, 30);
    assert.equal(usage.snapshot().counters.diamonds, 60);
  });

  await check('关闭巨轮总开关后全局结算释放已回港舰队，未知钻石费用继续保留', async () => {
    const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
    const originalKey = speedKey(f);
    f.speedMode = 'unknown'; await run(f, s, usage);
    s.treasure.enabled = false;
    f.returnFromTreasure('1远征船');
    await run(f, s, usage);
    assert.match(fleetRecordReason(usage.keyRecords(), '1远征船', f.player.worldId), /待确认/);
    await checkFleetSettlement(f.client, f.player, usage);
    assert.equal(usage.keyRecords()[originalKey].expired, true);
    assert.equal(usage.keyRecords()[originalKey].confirmed, false);
    assert.equal(fleetRecordReason(usage.keyRecords(), '1远征船', f.player.worldId), '');
    assert.equal(usage.pendingCounters().diamonds, 30);
    assert.equal(usage.snapshot().uncertain, 1);
    assert.equal(usage.confirmedCounters().diamonds ?? 0, 0);
    assert.equal(speeds(f).length, 1);
    assert.equal(dispatches(f).length, 1);
  });

  await check('关闭巨轮总开关后全局结算仍可凭同航程提前状态确认加速', async () => {
    const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage);
    const originalKey = speedKey(f);
    f.speedMode = 'unknown'; await run(f, s, usage);
    s.treasure.enabled = false;
    fleetOf(f).moveEndTs = nowOf(f) + 30;
    await run(f, s, usage);
    assert.equal(usage.keyRecords()[originalKey].confirmed, false);
    await checkFleetSettlement(f.client, f.player, usage);
    assert.equal(usage.hasKey(originalKey), false);
    assert.equal(usage.snapshot().uncertain, 0);
    assert.equal(usage.pendingCounters().diamonds ?? 0, 0);
    assert.equal(usage.confirmedCounters().diamonds, 30);
    assert.equal(usage.confirmedCounters().treasureDiamonds, 30);
    assert.equal(speeds(f).length, 1);
    assert.equal(dispatches(f).length, 1);
  });

  await check('明确拒绝和确定未发送释放预算，后续可以重新尝试', async () => {
    for (const mode of ['rejected', 'notSent']) {
      const { f, s } = fixture(), usage = ledger(); await depart(f, s, usage); f.speedMode = mode;
      await run(f, s, usage);
      assert.equal(speeds(f).length, 1);
      assert.equal(usage.snapshot().counters.diamonds ?? 0, 0);
      assert.equal(usage.snapshot().uncertain, 0);
      assert.equal(usage.hasKey(speedKey(f)), false);
      f.speedMode = 'confirmed'; await run(f, s, usage);
      assert.equal(speeds(f).length, 2);
      assert.equal(usage.confirmedCounters().diamonds, 30);
    }
  });

  await check('重启和换日保留未知加速与钻石预留，区服隔离生效', async () => {
    const { f, s } = fixture(), file = path.join(directory, 'restart.json');
    let today = Date.parse('2026-11-17T12:00:00Z');
    let usage = ledger({ file, now: () => today });
    await depart(f, s, usage); f.speedMode = 'unknown'; await run(f, s, usage);
    today += 86400000;
    usage = ledger({ file, now: () => today });
    await run(f, s, usage);
    assert.equal(speeds(f).length, 1);
    assert.equal(usage.pendingCounters().diamonds, 30);
    assert.equal(recordsInWorld(usage.keyRecords(), 2001001)[speedKey(f)], undefined);
  });
} finally {
  const passed = results.filter(result => result.passed).length;
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(parent) || !path.basename(resolved).startsWith('run-')) throw new Error('临时测试目录越界，未清理');
  fs.rmSync(resolved, { recursive: true });
  console.log(`巨轮加速专项：${passed}/${results.length} 组通过`);
  if (passed !== results.length) process.exitCode = 1;
}
