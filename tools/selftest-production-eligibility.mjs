import assert from 'node:assert/strict';
import { createProductionEligibility } from '../src/production-eligibility.mjs';

const table = data => ({ data });
let passed = 0;
function test(name, run) { run(); passed++; console.log('通过：' + name); }

function fixture() {
  const config = { tables: {
    BuildingProduceCfg: table([
      { itemId: '面包', buildType: '食品厂', unlockLevel: 1, costItem: [['小麦', 1]] },
      { itemId: '颜料', buildType: '化工厂', unlockLevel: 3, costItem: [['木材', 1]] },
      { itemId: '躺椅', buildType: '家具厂', unlockLevel: 1, costItem: [['颜料', 1], ['木材', 1]] },
      { itemId: '种子', buildType: '种子厂', unlockLevel: 2, costItem: [['木材', 1]] },
    ]),
    FarmlandPlantCfg: table([{ id: '小麦', produceNum: 5, material: ['种子', 1] }]),
  } };
  const buildings = [
    { buildingId: '1食品厂', type: '食品厂', level: 1 },
    { buildingId: '1化工厂', type: '化工厂', level: 2 },
    { buildingId: '1家具厂', type: '家具厂', level: 1 },
    { buildingId: '1种子厂', type: '种子厂', level: 1 },
  ];
  const settings = { factory: { enabled: true, disabledTypes: [] } };
  const stock = new Map([['木材', 20], ['小麦', 10]]);
  const incoming = new Map();
  const check = () => createProductionEligibility(config, { buildings, settings, stock, incoming });
  return { config, buildings, settings, stock, incoming, check };
}
const need = (id, num = 1) => ({ id, num });

test('等级不足和未建成的工厂使整单跳过', () => {
  const f = fixture();
  assert.deepEqual(f.check()([need('面包', 4), need('颜料')]).map(item => item.itemId), ['颜料']);
  f.buildings.splice(1, 1);
  assert.match(f.check()([need('颜料')])[0].reason, /未建成/);
});

test('工厂总开关、类型、单座和快照禁用均生效', () => {
  for (const disable of [
    f => { f.settings.factory.enabled = false; },
    f => { f.settings.factory.disabledTypes = ['食品厂']; },
    f => { f.settings.factory.disabledTypes = ['1食品厂']; },
    f => { f.buildings[0].enabled = false; },
  ]) {
    const f = fixture(); disable(f);
    assert.match(f.check()([need('面包')])[0].reason, /禁用/);
  }
});

test('同类工厂有足够等级的可用生产设施即可继续', () => {
  const f = fixture();
  f.settings.factory.disabledTypes = ['1化工厂'];
  f.buildings.push({ id: '2化工厂', type: '化工厂', level: 3, buildFinishTime: 2000 });
  assert.deepEqual(f.check()([need('颜料')]), []);
});

test('原始建筑按配方类型后缀识别工厂', () => {
  const f = fixture();
  for (const building of f.buildings) delete building.type;
  f.buildings.push({ buildingId: '1民居', level: 5 });
  assert.deepEqual(f.check()([need('面包')]), []);
  assert.equal(f.check()([need('颜料')]).length, 1);
  f.settings.factory.disabledTypes = ['食品厂'];
  assert.match(f.check()([need('面包')])[0].reason, /禁用/);
});

test('上游工厂受限也会阻止下游需求', () => {
  const f = fixture();
  assert.deepEqual(f.check()([need('躺椅')]).map(item => item.itemId), ['颜料']);
  f.stock.set('小麦', 0);
  assert.deepEqual(f.check()([need('面包')]).map(item => item.itemId), ['种子']);
});

test('扩展建筑标识优先使用解锁配置中的工厂类型', () => {
  const f = fixture();
  f.buildings[0] = { buildingId: '1食品厂扩展', level: 1 };
  f.config.tables.BuildingUnlockCfg = table([{ buildingId: '1食品厂扩展', buildingType: '食品厂' }]);
  assert.deepEqual(f.check()([need('面包')]), []);
  f.settings.factory.disabledTypes = ['1食品厂扩展'];
  assert.match(f.check()([need('面包')])[0].reason, /禁用/);
});

test('库存、在产和待收覆盖缺口时保留订单', () => {
  const f = fixture();
  f.settings.factory.enabled = false;
  f.stock.set('颜料', 1);
  f.incoming.set('颜料', 2);
  assert.deepEqual(f.check()([need('颜料', 3)]), []);
  assert.equal(f.check()([need('颜料', 4)]).length, 1);
  assert.equal(f.stock.get('颜料'), 1);
  assert.equal(f.incoming.get('颜料'), 2);
});

test('已有成品覆盖后不继续展开上游材料', () => {
  const f = fixture();
  f.stock.set('躺椅', 1);
  f.stock.set('颜料', 1);
  assert.deepEqual(f.check()([need('躺椅', 2)]), []);
});

test('同单重复材料和直接与上游需求共享库存', () => {
  const f = fixture();
  f.stock.set('颜料', 1);
  assert.equal(f.check()([need('颜料'), need('颜料')]).length, 1);
  assert.equal(f.check()([need('躺椅'), need('颜料')]).length, 1);
});

test('批量产物的剩余产量抵扣同单及后续需求', () => {
  const f = fixture();
  f.stock.set('小麦', 0);
  f.stock.set('种子', 1);
  const check = f.check();
  assert.deepEqual(check([need('面包', 2), need('小麦', 1)], { reserve: true }), []);
  assert.deepEqual(check([need('小麦', 2)], { reserve: true }), []);
  assert.equal(check([need('小麦')]).length, 1);
});

test('整单失败回滚其余材料分配，普通检查不占用材料', () => {
  const f = fixture();
  f.stock.set('颜料', 1);
  const check = f.check();
  assert.equal(check([need('面包', 10), need('颜料', 2)], { reserve: true }).length, 1);
  assert.deepEqual(check([need('面包', 10), need('颜料')]), []);
  assert.deepEqual(check([need('面包', 10), need('颜料')], { reserve: true }), []);
  assert.equal(check([need('颜料')]).length, 1);
});

test('后续重新读取升级或启用状态恢复需求', () => {
  const f = fixture();
  assert.equal(f.check()([need('颜料')]).length, 1);
  f.buildings[1].level = 3;
  assert.deepEqual(f.check()([need('颜料')]), []);
  f.settings.factory.disabledTypes = ['化工厂'];
  assert.equal(f.check()([need('颜料')]).length, 1);
  f.settings.factory.disabledTypes = [];
  assert.deepEqual(f.check()([need('颜料')]), []);
});

test('外部原料缺少与未知配方保持原有处理', () => {
  const f = fixture();
  f.stock.clear();
  f.buildings[1].level = 3;
  assert.deepEqual(f.check()([need('颜料'), need('未知品')]), []);
});

test('无数据、非法数量和配方循环保守保留需求', () => {
  const f = fixture();
  assert.deepEqual(f.check()([need('颜料', -1)]), []);
  assert.deepEqual(f.check()([need('颜料'), need('面包', NaN)]), []);
  assert.deepEqual(createProductionEligibility(f.config, { stock: f.stock })([need('颜料')]), []);
  f.buildings[1].level = null;
  assert.deepEqual(f.check()([need('颜料')]), []);
  f.config.tables.BuildingProduceCfg.data[0].costItem = [['面包', 1]];
  assert.deepEqual(f.check()([need('面包')]), []);
  f.stock.set('木材', -1);
  assert.deepEqual(f.check()([need('颜料')]), []);
  f.stock.set('木材', 1n);
  assert.deepEqual(f.check()([need('颜料')]), []);
});

console.log('生产可用性专项 ' + passed + '/' + passed + ' 通过');
