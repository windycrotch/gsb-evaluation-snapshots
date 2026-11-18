// Issue #32: production switches, shortest jobs, and bounded material planning.
import assert from 'node:assert/strict';
import { defaultSettings } from '../src/automation-settings.mjs';
import { planWorld } from '../src/world.mjs';

let passed = 0;
const test = (name, work) => { work(); passed++; console.log('通过：' + name); };
const table = data => ({ data });
function fixture() {
  const config = { materialName: id => id, tables: {
    BuildingCfg: table([{ buildingType: '食品厂', name: '食品厂' }, { buildingType: '民居', name: '民居' }]),
    BuildingProduceCfg: table([
      { itemId: '短时品', buildType: '食品厂', unlockLevel: 1, costItem: [['木材', 1]], produceTime: 1 },
      { itemId: '长时品', buildType: '食品厂', unlockLevel: 1, costItem: [['木材', 1]], produceTime: 60 },
    ]),
  } };
  const settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.factory, { enabled: true, produce: true });
  Object.assign(settings.building, { enabled: true, build: true, upgrade: true });
  settings.weekOrder.enabled = true;
  settings.factory.keepStock = 6; settings.factory.demandFirst = false;
  settings.factory.speedUp = settings.building.speedUp = false;
  const stock = new Map([['木材', 100], ['短时品', 2]]);
  const factory = { buildingId: '1食品厂', type: '食品厂', level: 1, product: [],
    factory: { factoryQ: [], finishedProducts: [] } };
  const survey = { now: 100, serverNow: 100, player: { level: 40 }, stock, have: id => stock.get(id) ?? 0,
    buildings: [factory], factories: [factory], orders: [], notes: [], weekOrder: new Map(), cargoOrder: new Map(),
    stockCap: 50, factorySlots: 6, population: 10, futurePopulation: 10, maxPopulation: 100,
    orderOfTheDay: { orderNum: 0, rewardedNum: 0 } };
  const plan = () => planWorld(survey, { config, settings, enabled: kind => ['startProduce', 'buildSupply'].includes(kind) });
  return { config, settings, stock, factory, survey, plan };
}
const products = plan => plan.actions.filter(step => step.request === 'StartFactoryProduceRequest').map(step => step.body.productId);

test('备货先排短时品，达到水位后再排长时品，一轮填满六个空槽', () => {
  const f = fixture();
  assert.deepEqual(products(f.plan()), ['短时品', '短时品', '短时品', '短时品', '长时品', '长时品']);
});
test('关闭原生协同不关闭普通按需生产，两个开关分别生效', () => {
  const f = fixture(); f.survey.cargoOrder.set('长时品', 2);
  f.settings.factory.demandFirst = true; f.settings.factory.demandPriority = ['cargo'];
  assert.equal(f.settings.factory.cooperateNative, false);
  assert.deepEqual(products(f.plan()).slice(0, 2), ['长时品', '长时品']);
  f.settings.factory.demandFirst = false;
  assert.equal(products(f.plan())[0], '短时品');
  f.settings.factory.produce = false;
  assert.equal(products(f.plan()).length, 0);
});
test('备货选中有订单需求的产品时，关闭按需优先后仍准确标记补库存', () => {
  const f = fixture(); f.survey.cargoOrder.set('短时品', 10);
  for (const step of f.plan().actions) { assert.match(step.label, /补库存/); assert.doesNotMatch(step.label, /贸易港缺/); }
});
test('同等需求来源先排短时，较大缺口不会抢先；来源优先级仍有效', () => {
  const f = fixture(); f.stock.set('短时品', 0); f.settings.factory.demandFirst = true;
  f.settings.factory.demandPriority = ['cargo', 'merchant'];
  f.survey.cargoOrder = new Map([['短时品', 1], ['长时品', 5]]);
  assert.deepEqual(products(f.plan()), ['短时品', '长时品', '长时品', '长时品', '长时品', '长时品']);
  f.survey.cargoOrder = new Map([['长时品', 1]]); f.survey.weekOrder.set('短时品', 5);
  assert.equal(products(f.plan())[0], '长时品');
});
test('库存、待收、在产共同计入水位，不重复补货或超过实际空位', () => {
  const f = fixture();
  f.factory.factory.factoryQ = [{ idx: 1, productId: '短时品' }, { idx: 2, productId: '短时品' }];
  f.factory.factory.finishedProducts = [{ id: '短时品', num: 2 }];
  assert.deepEqual(products(f.plan()), ['长时品', '长时品', '长时品', '长时品']);
  f.survey.factorySlots = 3;
  assert.deepEqual(products(f.plan()), ['长时品']);
  f.survey.factorySlots = 2;
  assert.deepEqual(products(f.plan()), []);
});
test('仓容与原料共同限制整批数量，保留周订单用料', () => {
  const f = fixture(); f.survey.stockCap = 3; f.stock.set('长时品', 3);
  assert.deepEqual(products(f.plan()), ['短时品']);
  f.survey.stockCap = 50; f.stock.set('木材', 5); f.survey.weekOrder.set('木材', 3);
  assert.deepEqual(products(f.plan()), ['短时品', '短时品']);
  f.stock.set('木材', 3);
  assert.deepEqual(products(f.plan()), []);
});
test('建筑升级按缺口安排多件，已有库存、在产与待收不重复生产', () => {
  const f = fixture(); f.settings.building.supply = true;
  f.settings.factory.keepStock = 0; f.settings.factory.demandFirst = true; f.settings.factory.demandPriority = ['building'];
  f.config.tables.BuildingUpgradeCfg = table([{ buildingType: '民居', level: 2, playerLevel: 1, curPeople: 1, consume: [['长时品', 5]] }]);
  f.survey.buildings.push({ buildingId: '1民居', type: '民居', level: 1, product: [] });
  f.stock.set('长时品', 1);
  f.factory.factory.factoryQ = [{ idx: 1, productId: '长时品' }];
  f.factory.factory.finishedProducts = [{ id: '长时品', num: 1 }];
  assert.deepEqual(products(f.plan()), ['长时品', '长时品']);
  f.settings.building.supply = false;
  assert.deepEqual(products(f.plan()), []);
});
test('原生自动生产保持原目标，仅明确开启协同才允许切换', () => {
  const f = fixture(); f.factory.factory.autoProductId = '短时品'; f.survey.autoProduceForever = true;
  f.settings.factory.demandFirst = true; f.settings.factory.demandPriority = ['cargo']; f.survey.cargoOrder.set('长时品', 6);
  assert.equal(f.plan().actions.length, 0);
  f.settings.factory.cooperateNative = true;
  assert.deepEqual(f.plan().actions.map(step => step.request), ['SetFactoryAutoProduceRequest']);
  f.settings.factory.produce = false;
  assert.deepEqual(f.plan().actions.map(step => step.request), ['SetFactoryAutoProduceRequest']);
});

test('商人整单缺少未解锁材料时释放库存，其他需求继续排产', () => {
  const f = fixture();
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.settings.factory.demandPriority = ['merchant', 'cargo'];
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.stock.set('短时品', 0);
  f.stock.set('木材', 4);
  f.survey.weekOrder = new Map([['木材', 4], ['短时品', 2], ['长时品', 1]]);
  f.survey.cargoOrder = new Map([['短时品', 1]]);
  const result = f.plan();
  assert.deepEqual(products(result), ['短时品']);
  assert(!result.demands.some(need => need.sources.includes('merchant')));
  assert.equal(new Map(result.reserved).get('木材'), 1);
  assert.match(result.notes.join(' '), /不差钱商人.*已跳过排产.*长时品/);
  f.factory.level = 2;
  f.stock.set('木材', 100);
  assert(f.plan().demands.some(need => need.sources.includes('merchant')));
});

test('禁用需求工厂时整单停止备料，重新启用后恢复', () => {
  const f = fixture();
  f.config.tables.BuildingProduceCfg.data.push({ itemId: '颜料', buildType: '化工厂', unlockLevel: 1, costItem: [['短时品', 1]], produceTime: 60 });
  const chemical = { buildingId: '1化工厂', type: '化工厂', level: 1, product: [], factory: { factoryQ: [], finishedProducts: [] } };
  f.survey.buildings.push(chemical);
  f.survey.factories.push(chemical);
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.settings.factory.disabledTypes = ['1化工厂'];
  f.survey.weekOrder = new Map([['短时品', 2], ['颜料', 1]]);
  const skipped = f.plan();
  assert.equal(skipped.demands.length, 0);
  assert.equal(new Map(skipped.reserved).get('短时品'), undefined);
  assert.deepEqual(products(skipped), []);
  f.settings.factory.disabledTypes = [];
  assert(f.plan().demands.some(need => need.id === '颜料'));
  f.settings.factory.disabledTypes = ['化工厂'];
  chemical.factory.factoryQ.push({ productId: '颜料' });
  assert.equal(new Map(f.plan().reserved).get('短时品'), 2, '已在产覆盖缺料时继续保留整单');
});

test('不可生产商人单的现货可供居民直接交单', () => {
  const f = fixture();
  f.settings.resident.enabled = true;
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.survey.weekOrder = new Map([['短时品', 2], ['长时品', 1]]);
  f.survey.orders = [{ index: 1, requirements: [{ id: '短时品', num: 2 }], rewardExp: 1000, rewardGold: 1000 }];
  const result = planWorld(f.survey, { config: f.config, settings: f.settings, enabled: kind => kind === 'finishOrder' });
  assert.equal(result.orderDecisions[0].status, 'ready');
  assert.equal(result.actions.filter(step => step.kind === 'finishOrder').length, 1);
  assert.deepEqual(result.actions[0].weeklyBorrowed, []);
});

test('多个贸易港货单仅跳过缺少未解锁材料的整单', () => {
  const f = fixture();
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.stock.set('短时品', 0);
  f.survey.cargoOrders = [
    { requirements: [{ id: '长时品', num: 1 }, { id: '短时品', num: 5 }] },
    { requirements: [{ id: '短时品', num: 1 }] },
  ];
  f.survey.cargoOrder = new Map([['长时品', 1], ['短时品', 6]]);
  assert.deepEqual(products(f.plan()), ['短时品']);
});

test('多个货单共享不可再生产现货时只保留一单，跳过单释放其余材料', () => {
  const f = fixture();
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.settings.factory.demandPriority = ['cargo'];
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.stock.set('长时品', 1);
  f.survey.cargoOrders = [
    { requirements: [{ id: '长时品', num: 1 }] },
    { requirements: [{ id: '长时品', num: 1 }, { id: '短时品', num: 2 }] },
  ];
  f.survey.cargoOrder = new Map([['长时品', 2], ['短时品', 2]]);
  const result = f.plan();
  assert.deepEqual(result.reserved, [['长时品', 1]]);
  assert.deepEqual(result.demands.map(need => [need.id, need.required]), [['长时品', 1]]);
  assert.deepEqual(products(result), []);
  assert.match(result.notes.join(' '), /贸易港.*已跳过排产.*长时品/);
});

test('商人与贸易港按配置优先级分配唯一现货，后续备料复用选单结果', () => {
  for (const priority of [['merchant', 'cargo'], ['cargo', 'merchant']]) {
    const f = fixture();
    f.settings.factory.keepStock = 0;
    f.settings.factory.demandFirst = true;
    f.settings.factory.demandPriority = priority;
    f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
    f.stock.set('长时品', 1);
    f.survey.weekOrder = new Map([['长时品', 1], ['短时品', 2]]);
    f.survey.cargoOrders = [{ requirements: [{ id: '长时品', num: 1 }, { id: '木材', num: 3 }] }];
    f.survey.cargoOrder = new Map([['长时品', 1], ['木材', 3]]);
    const result = f.plan();
    const expected = priority[0] === 'merchant' ? [['长时品', 1], ['短时品', 2]] : [['长时品', 1], ['木材', 3]];
    assert.deepEqual(result.reserved, expected);
    assert.deepEqual(result.demands.map(need => [need.id, need.required]), expected);
    assert.deepEqual(products(result), []);
  }
});

test('旧无设置入口和空优先级仍释放重复占用现货的货单材料', () => {
  const f = fixture();
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.stock.set('长时品', 1);
  f.survey.weekOrder = new Map([['长时品', 1]]);
  f.survey.cargoOrder = new Map([['长时品', 1], ['短时品', 2]]);
  f.settings.factory.demandPriority = [];
  for (const settings of [null, f.settings]) {
    const result = planWorld(f.survey, { config: f.config, settings, enabled: () => false });
    assert.deepEqual(result.reserved, [['长时品', 1]]);
    assert.deepEqual(result.demands, []);
  }
});

test('居民和额外需求的上游工厂未解锁时跳过整条备料', () => {
  const f = fixture();
  f.settings.resident.enabled = true;
  f.settings.factory.keepStock = 0;
  f.settings.factory.demandFirst = true;
  f.config.tables.BuildingProduceCfg.data[1].unlockLevel = 2;
  f.config.tables.BuildingProduceCfg.data[0].costItem = [['长时品', 1]];
  f.stock.set('短时品', 0);
  f.survey.orders = [{ index: 1, requirements: [{ id: '短时品', num: 1 }], rewardExp: 1000, rewardGold: 1000 }];
  const result = planWorld(f.survey, { config: f.config, settings: f.settings,
    enabled: kind => kind === 'startProduce', extraDemand: [{ source: 'museum', requirements: [{ id: '短时品', num: 1 }] }] });
  assert.equal(result.orderDecisions[0].status, 'productionSkipped');
  assert.equal(result.demands.length, 0);
  assert.deepEqual(products(result), []);
});
test('建筑备料遵守新增人口上限，已有施工占用人口空间', () => {
  for (const level of [0, 1]) {
    const f = fixture();
    f.settings.factory.keepStock = 0;
    f.settings.factory.demandFirst = true;
    f.settings.factory.demandPriority = ['building'];
    f.settings.building.supply = true;
    f.config.tables.BuildingUnlockCfg = table([{ buildingId: '1民居', buildingType: '民居',
      playerLevel: 1, curPeople: 1, consume: [['长时品', 2]] }]);
    f.config.tables.BuildingUpgradeCfg = table([
      { buildingType: '民居', level: 1, effect: [['人口增加', 10]] },
      { buildingType: '民居', level: 2, playerLevel: 1, curPeople: 1,
        consume: [['长时品', 2]], effect: [['人口增加', 20]] },
    ]);
    f.survey.buildings.push({ buildingId: '1民居', type: '民居', level, population: level * 10, product: [] });
    f.survey.maxPopulation = 19;
    const plan = () => planWorld(f.survey, { config: f.config, settings: f.settings });
    assert.deepEqual(products(plan()), [], '没有足够人口空间时不为首建或升级备料');
    if (level === 0) {
      const legacy = planWorld(f.survey, { config: f.config });
      assert(legacy.notes.some(note => note.includes('先建指标建筑')));
      assert(!legacy.actions.some(step => step.label?.includes('民居建造缺')));
    }
    f.survey.maxPopulation = 20;
    assert.deepEqual(products(plan()), ['长时品', '长时品'], '刚好容纳新增人口时正常备料');
    f.survey.futurePopulation = 20;
    assert.deepEqual(products(plan()), [], '已施工民居的新增人口先占用上限');
    f.config.tables.BuildingUpgradeCfg.data[level].effect = [['人口增加', level * 10]];
    assert.deepEqual(products(plan()), ['长时品', '长时品'], '不增加人口的工程仍可备料');
  }
});
console.log('工厂排产计划专项 ' + passed + '/' + passed + ' 通过');
