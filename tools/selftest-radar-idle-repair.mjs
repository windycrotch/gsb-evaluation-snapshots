import assert from 'node:assert/strict';
import { runAllianceRadar } from '../src/alliance-radar.mjs';
import { loadProtocol } from '../src/proto.mjs';

const protocol = loadProtocol();
const config = { tables: { ModuleOpenCfg: { data: [{ moduleId: '联盟情报', playerLevel: 18 }] },
  WorldParamCfg: { data: [{ paramName: '情报事件消耗汽油', paramValue: 500 }] } } };
const player = { playerId: 123, guildId: 456, worldId: 2000000, level: 20 };

function fixture(options = {}) {
  const settings = { radar: { runEnabled: true, enabled: false, repairIdle: true,
    fleetIds: ['1远征船'], types: ['pirate'], minDurabilityPercent: 80 },
    schedule: { radarRepair: false, radarAuto: false } };
  const fleet = { buildingId: '1远征船', state: 1, durability: options.durability ?? 500, maxDura: 1000 };
  const calls = [], writes = [], reports = [];
  const client = { connected: true,
    async request(name) {
      calls.push(name);
      options.beforeRead?.(name, settings);
      if (name === 'GuildInfoRequest') return { guild: { guildId: player.guildId } };
      if (name === 'MyFleetsRequest') return { fleets: [structuredClone(fleet)] };
      if (name === 'AllItemRequest') return { items: [{ itemId: '汽油', num: 10000 }] };
      if (name === 'FleetRepairParamRequest') return { unitRepairCost: 6, unitRepairTime: 0.15 };
      if (options.allowRadar) {
        if (name === 'RadarInfoRequest') return { radarInfo: { events: [] } };
        if (name === 'OnWaterRequest') return { building: [] };
        if (name === 'UniteWorldsPlanRequest') return { worldIds: [] };
      }
      assert.fail('维修不应请求情报接口：' + name);
    },
    async sendWatch(name, body) {
      assert.equal(name, 'RepairFleetRequest');
      assert.equal(body.buildingId, fleet.buildingId);
      writes.push({ name, body });
      if (!options.unknown) {
        fleet.state = 4;
        fleet.repairing = { endDura: fleet.maxDura, endTs: Math.floor(Date.now() / 1000) + 1000 };
      }
    },
  };
  const args = { getSettings: () => settings, protocol, enabled: () => true,
    report: entry => reports.push(entry), canUseFleet: options.canUseFleet ?? (() => true),
    ledger: { pendingCounters: () => options.pending ?? {}, keyRecords: () => ({}) } };
  return { settings, fleet, calls, writes, reports, run: () => runAllianceRadar(client, config, player, args) };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('通过：' + name); }

await test('独立维修无需开启领奖派遣，不读取情报，也不依赖旧开关', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.writes.length, 1);
  assert(f.reports.some(entry => entry.ok && entry.key === 'radar.repairIdle'));
  assert(!f.calls.some(name => name.startsWith('Radar')));
  await f.run();
  assert.equal(f.writes.length, 1);
});

await test('总开关关闭和维修关闭时，残留旧配置不能触发操作', async () => {
  for (const field of ['runEnabled', 'repairIdle']) {
    const f = fixture(); f.settings.radar[field] = false;
    f.settings.schedule.radarRepair = true; f.settings.schedule.radarAuto = true;
    await f.run();
    assert.equal(f.calls.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

await test('保留低于 80% 才维修的范围，并尊重舰队占用', async () => {
  for (const options of [{ durability: 800 }, { canUseFleet: () => false }]) {
    const f = fixture(options); await f.run(); assert.equal(f.writes.length, 0);
  }
});

await test('读取维修报价时关闭操作，写入前停止', async () => {
  const f = fixture({ beforeRead: (name, settings) => {
    if (name === 'FleetRepairParamRequest') settings.radar.repairIdle = false;
  } });
  await f.run(); assert.equal(f.writes.length, 0);
});

await test('其他汽油支出待确认时不再次占用汽油', async () => {
  const f = fixture({ pending: { cityWarPetrol: 100 } });
  await f.run(); assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
  assert(f.reports.some(entry => entry.reason.includes('汽油支出待确认')));
});

await test('维修结果未知时不重复维修，也不继续情报派遣', async () => {
  const f = fixture({ unknown: true }); f.settings.radar.enabled = true;
  await f.run(); await f.run();
  assert.equal(f.writes.length, 1);
  assert(!f.calls.some(name => name.startsWith('Radar')));
  assert(f.reports.some(entry => entry.reason?.includes('维修支出待确认')));
});

await test('关闭新维修后仍可复查原未知结果，确认后恢复情报处理', async () => {
  const f = fixture({ unknown: true, allowRadar: true });
  await f.run();
  f.settings.radar.repairIdle = false; f.settings.radar.enabled = true;
  f.fleet.durability = f.fleet.maxDura;
  await f.run();
  assert.equal(f.writes.length, 1);
  assert(f.calls.includes('RadarInfoRequest'), '已确认的维修不应永久阻断情报处理');
});

console.log(`联盟情报独立维修专项 ${passed}/${passed} 通过`);
