import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { defaultSettings } from '../src/automation-settings.mjs';
import { buildProductionSnapshot, readProductionSnapshot } from '../src/production-snapshot.mjs';
import { watchHeroRaidPushes } from '../src/hero-raid-automation.mjs';
import { watchGuildShipPushes } from '../src/guild-ships.mjs';

const table = data => ({ data });
const config = { tables: {
  BuildingCfg: table([{ buildingType: '食品厂' }, { buildingType: '农田' }, { buildingType: '民居' }]),
  BuildingProduceCfg: table([{ itemId: '面包', buildType: '食品厂', unlockLevel: 1, produceTime: 60, costItem: [['小麦', 5]] }]),
  FarmlandPlantCfg: table([{ id: '小麦', time: 30, produceNum: 5, material: ['小麦种子', 1] }]),
  BuildingProduceParamCfg: table([{ paramName: '制造位上限', paramValue: 6 }]),
  GameParamCfg: table([{ paramName: '初始人口', paramValue: 3 }, { paramName: '初始人口上限', paramValue: 100 },
    { paramName: '产品存量初始上限', paramValue: 50 }]),
  BuildingUpgradeCfg: table([{ buildingType: '民居', level: 1, effect: [['人口增加', 10]] }]),
  CargoUnlockCfg: table([{ playerLevel: 9 }]),
  ModuleOpenCfg: table([{ moduleId: '联盟情报', playerLevel: 18 }, { moduleId: '联盟商船', playerLevel: 18 }]),
  HeroRaidOrderCfg: table([{ raidId: 1, orderId: 2, unlockDay: 1, orderList: [['面包', 3]] }]),
} };

function fixture() {
  const settings = defaultSettings();
  settings.loop.world = settings.weekOrder.enabled = true;
  Object.assign(settings.factory, { enabled: true, produce: true, demandFirst: true });
  Object.assign(settings.building, { enabled: true, build: true, upgrade: true });
  settings.factory.keepStock = 0;
  settings.factory.demandPriority = ['merchant', 'cargo', 'resident'];
  settings.heroRaid.enabled = true;
  const raw = {
    capturedAt: '2026-11-16T00:00:00.000Z', serverNow: 1000,
    player: { playerId: '9007199254740993', worldId: 1000001, guildId: 0, level: 25 }, reads: [],
    water: { workerOrder: [{ index: 1, requirements: [{ id: '面包', num: 2 }] },
      { index: 2, requirements: [{ id: '面包', num: 1 }] }], building: [
      { buildingId: '1食品厂', level: 1, factory: { factoryQ: [{ idx: 0, productId: '面包', finishTime: 1050 }], finishedProducts: [{ id: '面包', num: 1 }] } },
      { buildingId: '1农田', level: 1, farm: { productId: '小麦', plantTime: 990, ripeTime: 1020 } },
      { buildingId: '1民居', level: 1 },
    ] },
    items: { items: [{ itemId: '小麦', num: 7 }, { itemId: '小麦种子', num: 2 }] },
    resources: { list: [{ res: 3, amount: { low: 100, high: 0, unsigned: false } }] },
    effects: { effects: [{ id: 1, value: 10 }] }, monthCards: { cardItem: [] }, heroes: { heroes: [] },
    heroRaids: { observed: true, invalid: false, raids: [] },
    weekOrder: { needed: new Map([['面包', 4]]), finished: false, orderKey: 'week-current', evidence: { endTime: 2000 } },
    cargo: { ship: [{ index: 1, status: 0, orderItem: [{ asset: { id: '面包', num: 2 } },
      { filled: true, asset: { id: '小麦', num: 99 } }] }, { index: 2, status: 1, orderItem: [{ asset: { id: '小麦', num: 30 } }] }] },
    festivals: [],
  };
  return { raw, settings };
}

let passed = 0;
async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}

await test('完整库存、逐订单与固定在产保留，六格表示队列容量', () => {
  const { raw, settings } = fixture();
  const before = JSON.stringify(raw);
  const snapshot = buildProductionSnapshot(raw, config, settings);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.player.id, '9007199254740993');
  assert.equal(snapshot.inventory.find(row => row.id === 'GOLD').num, 100);
  assert.equal(snapshot.orders.length, 4);
  assert.equal(snapshot.orders.filter(row => row.source === 'resident').length, 2);
  assert.deepEqual(snapshot.orders.find(row => row.source === 'cargo').requirements, [{ id: '面包', num: 2 }]);
  assert.equal(snapshot.orders.find(row => row.source === 'merchant').deadline, 2000);
  assert.equal(snapshot.factories[0].capacity, 6);
  assert.equal(snapshot.factories[0].queue[0].finishTime, 1050);
  assert.equal(snapshot.factories[0].queue[0].timingSource, 'server');
  assert.equal(snapshot.farms[0].num, 5);
  assert.equal(snapshot.farms[0].ripeTime, 1020);
  assert.equal(snapshot.population.current, 13);
  assert.equal(snapshot.recipes[0].timingSource, 'estimated');
  assert.equal(snapshot.raw, raw);
  assert.equal(JSON.stringify(snapshot).includes('"raw"'), false);
  assert.equal(JSON.stringify(raw), before);
});

await test('缺库存和无效数量显式不完整，未知完工时刻保持未知', () => {
  const { raw, settings } = fixture();
  raw.items.items[0].num = -1;
  delete raw.resources;
  delete raw.effects.effects;
  delete raw.water.building[0].factory.factoryQ[0].finishTime;
  const snapshot = buildProductionSnapshot(raw, config, settings);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.inventoryKnown, false);
  assert.equal(snapshot.factories[0].queue[0].finishTime, null);
  assert.equal(snapshot.factories[0].queue[0].timingSource, 'unknown');
  for (const request of ['AllItemRequest', 'AllResourceRequest', 'GameEffectRequest']) {
    assert(snapshot.missingReads.some(row => row.request === request));
  }
});

await test('后续合法队列缺完工时刻保留估算空间，其他建筑空工厂消息不混入', () => {
  const { raw, settings } = fixture();
  raw.water.building[0].factory.factoryQ.push({ idx: 1, productId: '面包' });
  raw.water.building[2].factory = {};
  const snapshot = buildProductionSnapshot(raw, config, settings);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.factories.length, 1);
  assert.equal(snapshot.factories[0].queue[1].finishTime, null);
  raw.water.building[0].factory.factoryQ[1].idx = 0;
  assert.equal(buildProductionSnapshot(raw, config, settings).complete, false);
});

await test('联盟、红船及超凡英雄保留当前订单身份和期限', () => {
  const { raw, settings } = fixture();
  settings.guildShip.enabled = true;
  settings.guildShip.produceMissing = true;
  settings.heroRaid.enabled = true;
  settings.heroRaid.orders = true;
  raw.guildOrder = { order: { nextRefreshTime: 1500, requirements: [{ id: '面包', num: 1 }] } };
  raw.guildShipView = { period: 2, candidates: [{ kind: 'crew', type: 3, shipId: 9, crewId: 1,
    preparedEndTime: 1400, costs: [{ id: '面包', need: 2, reserved: 3 }] }] };
  raw.heroRaids = { observed: true, invalid: false, raids: [{ raidId: 1, startTime: 900, finishTime: 1800,
    order: { orderId: 2, gotOrderId: 1, gotTimes: 0 } }] };
  const snapshot = buildProductionSnapshot(raw, config, settings);
  assert.equal(snapshot.orders.find(row => row.source === 'guildRecruit').deadline, null);
  assert.equal(snapshot.orders.find(row => row.source === 'guildRecruit').metadata.refreshAt, 1500);
  assert.deepEqual(snapshot.orders.find(row => row.source === 'guildShip').requirements, [{ id: '面包', num: 2 }]);
  assert.equal(snapshot.orders.find(row => row.source === 'guildShip').id, 'guildShip:2:9:1');
  assert.equal(snapshot.orders.find(row => row.source === 'guildShip').kind, 'consumption');
  assert.equal(snapshot.orders.find(row => row.source === 'heroRaid').deadline, 1800);
  assert.equal(snapshot.orders.find(row => row.source === 'heroRaid').id, 'heroRaid:1:900:2');
  raw.heroRaids.observed = false;
  assert(buildProductionSnapshot(raw, config, settings).missingReads.some(row => row.request === 'SCAllActivity'));
});

await test('已提交英雄当前单的过渡状态等待同步，避免重复投料', () => {
  const { raw, settings } = fixture();
  raw.heroRaids.raids = [{ raidId: 1, startTime: 900, finishTime: 1800,
    order: { orderId: 1, gotOrderId: 1, gotTimes: 0 } }];
  const snapshot = buildProductionSnapshot(raw, config, settings);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.orders.some(order => order.source === 'heroRaid'), false);
  assert(snapshot.missingReads.some(read => read.reason.includes('后续订单尚待同步')));
});

await test('常规备货与消费目标单独标记且未开启模块不制造缺失', () => {
  const { raw, settings } = fixture();
  settings.factory.keepStock = 3;
  settings.factory.demandPriority.push('factory');
  raw.reads.push({ request: 'MonthCardRequest', status: 'missing', required: false, reason: '无协议' });
  const snapshot = buildProductionSnapshot(raw, config, settings);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.orders.find(row => row.source === 'factory').kind, 'stockTarget');
  assert(!snapshot.missingReads.some(row => row.request === 'SCAllActivity'));
});

await test('海兽消费备料遵守世界循环、模块、动作和来源开关', () => {
  const petConfig = { tables: { ...config.tables,
    BuildingCfg: table([...config.tables.BuildingCfg.data, { buildingType: '宠物培育室' }]),
  } };
  for (const [name, change, expected] of [
    ['全部开启', () => {}, ['petAdvance', 'petFeed']],
    ['世界循环关闭', settings => { settings.loop.world = false; }, []],
    ['海兽模块关闭', settings => { settings.pet.enabled = false; }, []],
    ['进阶关闭', settings => { settings.pet.advance = false; }, ['petFeed']],
    ['投喂关闭', settings => { settings.pet.feed = false; }, ['petAdvance']],
    ['进阶来源取消', settings => { settings.factory.demandPriority = ['petFeed']; }, ['petFeed']],
    ['投喂来源取消', settings => { settings.factory.demandPriority = ['petAdvance']; }, ['petAdvance']],
  ]) {
    const { raw, settings } = fixture();
    settings.factory.demandPriority = ['petAdvance', 'petFeed'];
    Object.assign(settings.pet, { enabled: true, advance: true, feed: true });
    raw.water.building[2].petServe = { petUid: '123', upgradeRequirements: [{ id: '面包', num: 3 }] };
    raw.water.building.push({ buildingId: '1宠物培育室', level: 1,
      petBreed: { maxQLength: 1, maturePets: [], breedQ: [{ idx: 0, finishTime: 1100,
        feedRequirements: [{ id: '小麦', num: 2 }] }] } });
    change(settings);
    const targets = buildProductionSnapshot(raw, petConfig, settings).orders.filter(order => order.source.startsWith('pet'));
    assert.deepEqual(targets.map(order => order.source).sort(), expected, name);
    assert(targets.every(order => order.kind === 'consumption'), name);
  }
});

await test('博物馆消费备料遵守世界循环、运行、探宝、升级和来源开关', () => {
  const museumConfig = { tables: { ...config.tables,
    MuseumExpeditionStageCfg: table([{ stageId: 1, areaLevelReq: [] }]),
    MuseumExploreTimeFactorCfg: table([{ playerLevel: 1, factor: 1 }]),
    MuseumAreaCfg: table([{ areaId: 1, level: 2, playerLevelReq: 1, costArr: [['小麦', 3]] }]),
  } };
  for (const [name, change, expected] of [
    ['全部开启', () => {}, ['小麦', '面包']],
    ['世界循环关闭', settings => { settings.loop.world = false; }, []],
    ['运行关闭', settings => { settings.museum.runEnabled = false; }, []],
    ['探宝关闭', settings => { settings.museum.enabled = false; }, ['小麦']],
    ['升级关闭', settings => { settings.museum.upgrade = false; }, ['面包']],
    ['动作全部关闭', settings => { settings.museum.enabled = false; settings.museum.upgrade = false; }, []],
    ['地图未选择', settings => { settings.museum.maps = ['2']; }, ['小麦']],
    ['来源取消', settings => { settings.factory.demandPriority = ['resident']; }, []],
  ]) {
    const { raw, settings } = fixture();
    settings.factory.demandPriority = ['museum'];
    Object.assign(settings.museum, { runEnabled: true, enabled: true, upgrade: true, factor: 1, materialFactor: false, maps: [] });
    raw.museum = { exploreStages: [{ stageId: 1, expedition: { endTime: 0,
      cost: { asset: [{ id: '面包', num: 2 }] } } }], exhibitions: [{ exhibitionId: 1, level: 1 }] };
    change(settings);
    const targets = buildProductionSnapshot(raw, museumConfig, settings).orders.filter(order => order.source === 'museum');
    assert.deepEqual(targets.flatMap(order => order.requirements.map(item => item.id)).sort(), expected, name);
    assert(targets.every(order => order.kind === 'consumption'), name);
  }
});

function buildingFixture() {
  const { raw, settings } = fixture();
  settings.factory.demandPriority = ['building', 'resident'];
  settings.building.supply = true;
  raw.water.building.push({ buildingId: '2民居', level: 0 });
  const buildingConfig = { tables: { ...config.tables,
    BuildingUnlockCfg: table([{ buildingId: '2民居', buildingType: '民居', playerLevel: 20, curPeople: 10,
      condition: [['1民居', 1]], consume: [['面包', 1]] }]),
    BuildingUpgradeCfg: table([...config.tables.BuildingUpgradeCfg.data,
      { buildingType: '民居', level: 2, playerLevel: 20, curPeople: 10,
        condition: [['食品厂', 1]], consume: [['面包', 2]] }]),
  } };
  const targets = () => buildProductionSnapshot(raw, buildingConfig, settings).orders.filter(order => order.source === 'building');
  return { raw, settings, buildingConfig, targets };
}

await test('建筑备料遵守来源、补料、主开关和普通生产开关', () => {
  for (const disable of [
    settings => { settings.factory.demandPriority = ['resident']; },
    settings => { settings.building.supply = false; },
    settings => { settings.building.enabled = false; },
    settings => { settings.loop.world = false; },
    settings => { settings.factory.enabled = false; },
    settings => { settings.factory.produce = false; },
  ]) {
    const { settings, targets } = buildingFixture();
    assert.equal(targets().length, 2);
    disable(settings);
    assert.deepEqual(targets(), []);
  }
});

await test('首建与升级分别读取真实前置条件和当前执行开关', () => {
  const { raw, settings, buildingConfig, targets } = buildingFixture();
  assert.deepEqual(targets().map(order => order.metadata), [
    { buildingId: '1民居', level: 2, action: 'upgrade', ready: false },
    { buildingId: '2民居', level: 1, action: 'build', ready: false },
  ]);
  settings.building.build = false;
  assert.deepEqual(targets().map(order => order.id), ['building:1民居:2']);
  settings.building.build = true;
  settings.building.upgrade = false;
  assert.deepEqual(targets().map(order => order.id), ['building:2民居:1']);
  settings.building.upgrade = true;
  buildingConfig.tables.BuildingUnlockCfg.data[0].condition = [['1民居', 2]];
  buildingConfig.tables.BuildingUpgradeCfg.data[1].condition = [['食品厂', 2]];
  assert.deepEqual(targets(), []);
  raw.water.building.find(building => building.buildingId === '1食品厂').level = 2;
  assert.deepEqual(targets().map(order => order.id), ['building:1民居:2']);
});

await test('建筑等级、人口、禁用和进行中工程限制当前备料目标', () => {
  for (const change of [
    ({ raw }) => { raw.player.level = 19; },
    ({ buildingConfig }) => { buildingConfig.tables.BuildingUnlockCfg.data[0].curPeople = 100; buildingConfig.tables.BuildingUpgradeCfg.data[1].curPeople = 100; },
    ({ settings }) => { settings.building.disabledTypes = ['民居']; },
    ({ raw }) => { for (const building of raw.water.building.filter(row => row.buildingId.endsWith('民居'))) building.buildFinishTime = 999; },
  ]) {
    const value = buildingFixture();
    change(value);
    assert.deepEqual(value.targets(), []);
  }
  const { settings, targets } = buildingFixture();
  settings.building.disabledTypes = ['1民居'];
  assert.deepEqual(targets().map(order => order.id), ['building:2民居:1']);
  const unknown = buildingFixture();
  delete unknown.raw.player.level;
  const snapshot = buildProductionSnapshot(unknown.raw, unknown.buildingConfig, unknown.settings);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.orders.some(order => order.source === 'building'), false);
  assert(snapshot.missingReads.some(read => read.request === 'building'));
});

await test('联合排产建筑备料遵守人口上限并计入已有施工', () => {
  const { raw, settings, buildingConfig, targets } = buildingFixture();
  buildingConfig.tables.GameParamCfg = table(config.tables.GameParamCfg.data.map(row => ({ ...row })));
  const populationLimit = buildingConfig.tables.GameParamCfg.data.find(row => row.paramName === '初始人口上限');
  buildingConfig.tables.BuildingUpgradeCfg.data[1].effect = [['人口增加', 20]];
  populationLimit.paramValue = 22;
  assert.deepEqual(targets(), [], '当前人口13，加10后不能超过上限22');
  populationLimit.paramValue = 23;
  assert.equal(targets().length, 2, '刚好达到人口上限的首建和升级可备料');
  raw.water.building.push({ buildingId: '3民居', level: 0, buildStartTime: 900, buildFinishTime: 1200 });
  assert.deepEqual(targets(), [], '已有施工占用未来人口，停止其他增人口工程备料');
  buildingConfig.tables.BuildingUpgradeCfg.data[1].effect = [['人口增加', 10]];
  assert.deepEqual(targets().map(order => order.id), ['building:1民居:2']);
  buildingConfig.tables.GameParamCfg.data = buildingConfig.tables.GameParamCfg.data.filter(row => row !== populationLimit);
  const unknown = buildProductionSnapshot(raw, buildingConfig, settings);
  assert.equal(unknown.complete, false);
  assert(!unknown.orders.some(order => order.source === 'building'));
  assert(unknown.missingReads.some(read => read.request === 'building' && read.reason.includes('人口上限')));
});

await test('已齐建筑材料仍作为完整独占目标，未齐且无生产路径的建材不造虚假任务', () => {
  const { raw, settings, buildingConfig, targets } = buildingFixture();
  raw.items.items.push({ itemId: '面包', num: 3 });
  const supplied = targets();
  assert.equal(supplied.length, 2);
  assert(supplied.every(order => order.metadata.ready && order.kind === 'consumption'));
  assert.deepEqual(supplied.map(order => order.requirements), [[{ id: '面包', num: 2 }], [{ id: '面包', num: 1 }]]);
  buildingConfig.tables.BuildingUnlockCfg.data[0].consume.push(['GOLD', 500]);
  assert.deepEqual(targets().map(order => order.id), ['building:1民居:2']);
  settings.building.maxBuilds = 0;
  settings.building.maxUpgrades = 0;
  assert.deepEqual(targets().map(order => order.id), ['building:1民居:2']);
});

function fakeClient(raw) {
  const responses = {
    OnWaterRequest: raw.water, AllItemRequest: raw.items, AllResourceRequest: raw.resources,
    GameEffectRequest: raw.effects, MonthCardRequest: raw.monthCards, AllHeroRequest: raw.heroes,
    WeekInfoRequest: { activityTime: [{ type: 5, startTime: 900, endTime: 2000, period: 1 }] },
    WeekOrderInfoRequest: { order: [{ id: '面包', num: 4 }], gotRwdId: [] }, CargoShipsRequest: raw.cargo,
    GuildOrderRequest: raw.guildOrder ?? { order: { requirements: [], nextRefreshTime: 2000 } },
    GuildShipRequest: raw.guildShips ?? { period: 0, ship: [], ownRun: [] },
    RadarInfoRequest: raw.radar ?? { radarInfo: { events: [] } },
  };
  const protocol = Object.fromEntries(Object.keys(responses).flatMap(name => [[name, {}], [name.replace(/Request$/, 'Response'), {}]]));
  const client = Object.assign(new EventEmitter(), { connected: true, socket: {}, connectionEpoch: 1, serverClockOffsetMs: 0,
    calls: [], festivals: [], request: async function(name) {
      this.calls.push(name);
      if (!(name in responses)) throw Error('意外请求 ' + name);
      return responses[name];
    }, send() { assert.fail('禁止发送'); }, sendWatch() { assert.fail('禁止发送'); } });
  watchHeroRaidPushes(client);
  if (raw.heroRaids?.observed) client.emit('message', { name: 'SCAllActivity', body: { raid: raw.heroRaids.raids } });
  return { client, protocol, responses };
}

await test('只读采集使用完整协议对象，周订单独立于贸易港读取', async () => {
  const { raw, settings } = fixture();
  const { client, protocol } = fakeClient(raw);
  const snapshot = await readProductionSnapshot(client, protocol, config, raw.player, settings, { now: () => 1000_000 });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.orders.length, 4);
  assert(client.calls.includes('GameEffectRequest'));
  assert(client.calls.includes('MonthCardRequest'));
  assert(client.calls.includes('AllHeroRequest'));
  assert.equal(snapshot.timing.effects.effects.length, 1);
  assert(snapshot.reads.some(row => row.request === 'GuildOrderRequest' && row.status === 'notApplicable'));
  assert(client.calls.every(name => Object.hasOwn(protocol, name)));
});

await test('关闭活动来源后未知英雄推送和失败周订单不阻断其它快照需求', async () => {
  const { raw, settings } = fixture();
  settings.heroRaid.enabled = settings.weekOrder.enabled = false;
  raw.heroRaids = { observed: false, invalid: true, raids: [] };
  raw.weekOrder = { requirements: null };
  raw.reads = [{ request: 'WeekOrderInfoRequest', status: 'failed', reason: '关闭来源的旧失败' }];
  const { client, protocol } = fakeClient(raw);
  const original = client.request;
  client.request = async function(name) {
    assert(!['WeekInfoRequest', 'WeekOrderInfoRequest'].includes(name), '关闭活动无需读取周订单');
    return original.call(this, name);
  };
  for (const snapshot of [buildProductionSnapshot(raw, config, settings),
    await readProductionSnapshot(client, protocol, config, raw.player, settings, { now: () => 1000_000 })]) {
    assert.equal(snapshot.complete, true, JSON.stringify(snapshot.missingReads));
    assert.deepEqual([...new Set(snapshot.orders.map(row => row.source))].sort(), ['cargo', 'resident']);
    assert.equal(snapshot.orders.length, 3);
    assert.deepEqual(snapshot.missingReads, []);
  }
});

await test('未提供设置的既有调用仍读取并展示当前周订单和英雄订单', async () => {
  const { raw } = fixture();
  raw.heroRaids.raids = [{ raidId: 1, startTime: 900, finishTime: 1800,
    order: { orderId: 2, gotOrderId: 1, gotTimes: 0 } }];
  const { client, protocol } = fakeClient(raw);
  for (const snapshot of [buildProductionSnapshot(raw, config),
    await readProductionSnapshot(client, protocol, config, raw.player, undefined, { now: () => 1000_000 })]) {
    assert.equal(snapshot.complete, true, JSON.stringify(snapshot.missingReads));
    assert(snapshot.orders.some(row => row.source === 'merchant'));
    assert(snapshot.orders.some(row => row.source === 'heroRaid'));
  }
  assert(client.calls.includes('WeekInfoRequest'));
  assert(client.calls.includes('WeekOrderInfoRequest'));
});

await test('单项读取失败保留其他真实订单并标明缺失', async () => {
  const { raw, settings } = fixture();
  const { client, protocol } = fakeClient(raw);
  delete protocol.WeekOrderInfoResponse;
  const snapshot = await readProductionSnapshot(client, protocol, config, raw.player, settings, { now: () => 1000_000 });
  assert.equal(snapshot.complete, false);
  assert(snapshot.orders.some(row => row.source === 'cargo'));
  assert(snapshot.orders.some(row => row.source === 'resident'));
  assert(snapshot.missingReads.some(row => row.request === 'WeekOrderInfoRequest'));
});

await test('当前订单读取独立于生产优先级和自动提交开关', async () => {
  const { raw, settings } = fixture();
  settings.factory.demandPriority = [];
  settings.resident.enabled = false;
  settings.cargo.enabled = false;
  settings.alliance.enabled = false;
  settings.schedule.guildOrders = true;
  settings.heroRaid.enabled = true;
  settings.heroRaid.orders = false;
  raw.player.guildId = '9007199254740995';
  raw.guildOrder = { order: { requirements: [{ id: '小麦', num: 2 }], nextRefreshTime: 1500 } };
  raw.heroRaids.raids = [{ raidId: 1, startTime: 900, finishTime: 1800, order: { orderId: 2, gotOrderId: 1, gotTimes: 0 } }];
  raw.radar = { radarInfo: { events: [{ uid: { low: 1, high: 2097152 }, eventId: 40001, state: 1, refugee: { requirements: [{ id: '面包', num: 1 }] } },
    { uid: 2, eventId: 40001, state: 2, refugee: { requirements: [{ id: '面包', num: 99 }] } }] } };
  const { client, protocol } = fakeClient(raw);
  const snapshot = await readProductionSnapshot(client, protocol, config, raw.player, settings, { now: () => 1000_000 });
  assert.equal(snapshot.complete, true, JSON.stringify(snapshot.missingReads));
  assert.deepEqual([...new Set(snapshot.orders.map(row => row.source))].sort(), ['cargo', 'guildRecruit', 'heroRaid', 'merchant', 'refugee', 'resident']);
  assert(snapshot.orders.every(row => row.kind === 'order'));
  assert.equal(snapshot.orders.find(row => row.source === 'guildRecruit').metadata.enabled, false, '残留联盟订单开关不能授权新版募兵');
  assert.equal(snapshot.orders.find(row => row.source === 'heroRaid').metadata.enabled, false);
  assert.equal(snapshot.orders.find(row => row.source === 'refugee').id, 'refugee:9007199254740993');
  assert.deepEqual(snapshot.orders.find(row => row.source === 'refugee').requirements, [{ id: '面包', num: 1 }]);
  assert(client.calls.includes('RadarInfoRequest'));
});

await test('居民刷新、已装货、在途到港货船与已提交本人船舱不重复排产', () => {
  const { raw, settings } = fixture();
  settings.guildShip.enabled = true;
  raw.water.workerOrder[0].refreshTime = 1200;
  raw.cargo.ship.push({ index: 3, status: 2, orderItem: [{ asset: { id: '面包', num: 99 } }] });
  raw.cargo.ship[0].orderItem[0].filled = true;
  raw.guildShips = { period: 1, ship: [{ shipId: 1, state: 1, cabin: [{ crewId: 1,
    player: { playerId: raw.player.playerId }, order: [{ id: '面包', num: 99 }] }] }], ownRun: [] };
  const snapshot = buildProductionSnapshot(raw, config, settings);
  assert.equal(snapshot.complete, true, JSON.stringify(snapshot.missingReads));
  assert.equal(snapshot.orders.filter(row => row.source === 'resident').length, 1);
  assert(!snapshot.orders.some(row => ['cargo', 'guildShip'].includes(row.source)));
});

await test('未解锁、未开放的活动不发送无效读取也不阻断其他当前订单', async () => {
  for (const level of [8, 17, 25]) {
    const { raw, settings } = fixture();
    raw.player.level = level;
    raw.player.guildId = '999';
    settings.guildShip.enabled = true;
    settings.guildShip.produceMissing = true;
    const { client, protocol } = fakeClient(raw);
    const snapshot = await readProductionSnapshot(client, protocol, config, raw.player, settings, { now: () => 1000_000 });
    assert.equal(snapshot.complete, true, JSON.stringify(snapshot.missingReads));
    assert.equal(client.calls.includes('CargoShipsRequest'), level >= 9);
    assert.equal(client.calls.includes('GuildShipRequest'), level >= 18);
    assert.equal(client.calls.includes('RadarInfoRequest'), level >= 18);
    assert(!client.calls.includes('GuildInfoRequest'));
    assert(snapshot.reads.some(row => row.request === 'GuildShipRequest' && row.status === 'notApplicable'));
  }
});

await test('商船读取后的其他采集跨过结算截止，最终快照丢弃过期红船备料', () => {
  const { raw, settings } = fixture();
  Object.assign(settings.guildShip, { enabled: true, produceMissing: true });
  raw.guildShipView = { period: 1, activityEndTime: 1601, candidates: [{ kind: 'crew', type: 3,
    shipId: 1, crewId: 1, preparedEndTime: 1800, costs: [{ id: '面包', need: 2 }] }] };
  let snapshot = buildProductionSnapshot(raw, config, settings);
  assert.equal(snapshot.orders.find(row => row.source === 'guildShip').deadline, 1001,
    '提前结算比船舱准备结束更早时，排产必须使用提前结算截止');
  raw.serverNow = 1001;
  snapshot = buildProductionSnapshot(raw, config, settings);
  assert(!snapshot.orders.some(row => row.source === 'guildShip'), '商船快照仍有候选也不能在截止后备料');
  assert(snapshot.orders.some(row => row.source === 'resident'), '其他当前订单仍正常排产');
});

await test('生产只读代理沿用原连接的商船结算截止，停止红船备料', async () => {
  for (const remaining of [1200, 600]) {
    const { raw, settings } = fixture(), now = Math.floor(Date.now() / 1000);
    raw.player.guildId = '999';
    settings.weekOrder.enabled = false;
    Object.assign(settings.guildShip, { enabled: true, crew: true, produceMissing: true });
    raw.guildShips = { period: 1, ownRun: [], ship: [{ shipId: 1, type: 3, state: 1,
      leader: { playerId: '888' }, leaderCond: [], preparedEndTime: now + 1800, mvEndTime: 0,
      reward: { asset: [{ type: 0, id: '水姆币', num: 80 }] },
      cabin: Array.from({ length: 6 }, (_, i) => ({ crewId: i + 1, player: null,
        order: [{ type: 0, id: '面包', num: 2 }] })) }] };
    const shipConfig = { tables: { ...config.tables,
      GuildShipCfg: table([{ shipId: 3, num: 6, time: 540 }]),
      GuildShipParamCfg: table([{ season: 1, shipNum: 2, duration: 30, time: [8, 11, 14, 17, 20, 23] }]),
    } };
    const { client, protocol, responses } = fakeClient(raw);
    responses.GuildInfoRequest = { guild: { guildId: raw.player.guildId } };
    protocol.GuildInfoRequest = protocol.GuildInfoResponse = {};
    watchGuildShipPushes(client);
    client.emit('message', { name: 'SCGuildShipActivity', body: { period: {
      period: 1, startTime: now - 86400, endTime: now + remaining,
    } } });
    const snapshot = await readProductionSnapshot(client, protocol, shipConfig, raw.player, settings);
    assert.equal(snapshot.complete, true, JSON.stringify(snapshot.missingReads));
    assert.equal(snapshot.orders.some(row => row.source === 'guildShip'), remaining > 600);
    if (remaining === 600) assert(snapshot.reads.some(row => row.request === 'guildShipView'
      && row.status === 'notApplicable' && /结算期/.test(row.reason)));
  }
});

await test('可选红船候选缺失不影响当前订单，英雄全量状态未知需明示', async () => {
  const { raw, settings } = fixture();
  raw.player.guildId = '999';
  settings.guildShip.enabled = true;
  settings.guildShip.produceMissing = true;
  const { client, protocol } = fakeClient(raw);
  delete protocol.GuildShipResponse;
  let snapshot = await readProductionSnapshot(client, protocol, config, raw.player, settings, { now: () => 1000_000 });
  assert.equal(snapshot.complete, true);
  assert(snapshot.reads.some(row => row.request === 'GuildShipRequest' && row.status === 'missing' && row.required === false));
  raw.heroRaids.observed = false;
  const fresh = fakeClient(raw);
  snapshot = await readProductionSnapshot(fresh.client, fresh.protocol, config, raw.player, settings, { now: () => 1000_000 });
  assert.equal(snapshot.complete, false);
  assert(snapshot.missingReads.some(row => row.request === 'SCAllActivity'));
});

await test('缺少列表、非法当前订单和重复身份无法作为完整快照', () => {
  for (const corrupt of [
    raw => { delete raw.cargo.ship; },
    raw => { raw.cargo.ship[0].orderItem.push({}); },
    raw => { raw.cargo.ship[0].status = 99; },
    raw => { raw.water.workerOrder.push(raw.water.workerOrder[0]); },
    raw => { raw.radar = { radarInfo: { events: [{ uid: 1, eventId: 1, refugee: { requirements: [] } }] } }; },
  ]) {
    const { raw, settings } = fixture();
    corrupt(raw);
    assert.equal(buildProductionSnapshot(raw, config, settings).complete, false);
  }
});

await test('读取期间切号与连接代次变化均拒绝整份快照', async () => {
  for (const change of ['actor', 'connection']) {
    const { raw, settings } = fixture();
    const { client, protocol } = fakeClient(raw);
    const original = client.request;
    client.request = async function(name) {
      const result = await original.call(this, name);
      if (name === 'AllItemRequest') {
        if (change === 'actor') raw.player.playerId = '9007199254740995';
        else client.connectionEpoch++;
      }
      return result;
    };
    await assert.rejects(readProductionSnapshot(client, protocol, config, raw.player, settings, { now: () => 1000_000 }),
      error => error.code === 'PRODUCTION_SNAPSHOT_CHANGED');
    assert(!client.calls.includes('AllResourceRequest'));
  }
});

await test('跨请求期间发生游戏写入或相关推送时拒绝混合快照并移除监听', async () => {
  for (const event of [
    ['frame', { dir: 'out', name: 'GainFactoryProductsRequest' }],
    ['frame', { dir: 'out', name: 'FillCargoShipRequest' }],
    ...['SCUpdateItem', 'SCUpdateResource', 'SCUpdateWaterBuilding', 'SCWorkerOrder', 'SCGuildOrder', 'SCAllActivity', 'SCHeroRaidOpen']
      .map(name => ['message', { name, body: {} }]),
  ]) {
    const { raw, settings } = fixture();
    const { client, protocol } = fakeClient(raw);
    const before = { frame: client.listenerCount('frame'), message: client.listenerCount('message') };
    const original = client.request;
    client.request = async function(name) {
      const result = await original.call(this, name);
      if (name === 'AllItemRequest') this.emit(...event);
      return result;
    };
    await assert.rejects(readProductionSnapshot(client, protocol, config, raw.player, settings, { now: () => 1000_000 }),
      error => error.code === 'PRODUCTION_SNAPSHOT_CHANGED');
    assert(!client.calls.includes('AllResourceRequest'));
    assert.equal(client.listenerCount('frame'), before.frame);
    assert.equal(client.listenerCount('message'), before.message);
  }
});

await test('心跳、ACK和只读响应允许完成快照且成功后移除监听', async () => {
  const { raw, settings } = fixture();
  const { client, protocol } = fakeClient(raw);
  const before = { frame: client.listenerCount('frame'), message: client.listenerCount('message') };
  const original = client.request;
  client.request = async function(name) {
    for (const request of [name, 'PingRequest', 'Ack', 'Nack']) this.emit('frame', { dir: 'out', name: request });
    const result = await original.call(this, name);
    this.emit('message', { name: name.replace(/Request$/, 'Response'), body: result });
    return result;
  };
  assert.equal((await readProductionSnapshot(client, protocol, config, raw.player, settings, { now: () => 1000_000 })).complete, true);
  assert.equal(client.listenerCount('frame'), before.frame);
  assert.equal(client.listenerCount('message'), before.message);
});

console.log('生产快照测试通过 ' + passed + ' 项');
